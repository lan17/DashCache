import { performance } from "node:perf_hooks";

import { CacheLayer, DEFAULT_WATERMARK_TTL_SEC, type CacheConfigProvider, type CacheRampSampler, type GCacheKeyConfig } from "../config.js";
import { invalidationPrefix, redisClusterHashTag, type GCacheKey } from "../key.js";
import type { GCacheMetricsAdapter } from "../metrics.js";
import { errorName, labelsFor } from "../metrics.js";
import type { GCacheRedisClient, RedisCachePayload, RedisClientFactory } from "../redis-client.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { CacheGetResult } from "./cache-result.js";
import { fetchKeyConfig, resolveLayerConfigResult, type ResolvedLayerConfig } from "./runtime-config.js";

export interface RedisConfig {
  readonly client?: GCacheRedisClient;
  readonly createClient?: RedisClientFactory;
  readonly keyPrefix?: string;
  readonly serializer?: Serializer<unknown>;
  readonly watermarkTtlSec?: number;
}

interface RedisCacheOptions {
  readonly configProvider: CacheConfigProvider;
  readonly rampSampler: CacheRampSampler;
  readonly redis: RedisConfig;
  readonly metrics: GCacheMetricsAdapter | null;
}

const defaultSerializer = new JsonSerializer<unknown>();
const REDIS_FRAME_KEY_SUFFIX = ":gcache-frame-v1";

export class RedisCache {
  private readonly configProvider: CacheConfigProvider;
  private readonly rampSampler: CacheRampSampler;
  private readonly keyPrefix: string;
  private readonly defaultSerializer: Serializer<unknown>;
  private readonly watermarkTtlMs: number;
  private readonly createClient: RedisClientFactory | null;
  private readonly metrics: GCacheMetricsAdapter | null;
  private clientPromise: Promise<GCacheRedisClient> | null;

  constructor(options: RedisCacheOptions) {
    this.configProvider = options.configProvider;
    this.rampSampler = options.rampSampler;
    this.keyPrefix = options.redis.keyPrefix ?? "";
    this.defaultSerializer = options.redis.serializer ?? defaultSerializer;
    const watermarkTtlSec = options.redis.watermarkTtlSec ?? DEFAULT_WATERMARK_TTL_SEC;
    if (!Number.isSafeInteger(watermarkTtlSec) || watermarkTtlSec <= 0) {
      throw new RangeError("Redis watermarkTtlSec must be a positive safe integer");
    }
    this.watermarkTtlMs = watermarkTtlSec * 1000;
    if (!Number.isSafeInteger(this.watermarkTtlMs)) {
      throw new RangeError("Redis watermarkTtlSec is too large");
    }
    this.metrics = options.metrics;

    if (options.redis.client === undefined && options.redis.createClient === undefined) {
      throw new Error("Redis config requires either client or createClient");
    }

    this.createClient = options.redis.createClient ?? null;
    this.clientPromise = options.redis.client === undefined ? null : Promise.resolve(options.redis.client);
  }

  async get<T>(key: GCacheKey): Promise<T | undefined> {
    const result = await this.getResult<T>(key);
    return result.status === "hit" ? result.value : undefined;
  }

  async getResult<T>(key: GCacheKey, keyConfig?: GCacheKeyConfig | null): Promise<CacheGetResult<T>> {
    const layerConfig = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    return await this.getWithResolvedConfig(key, layerConfig.config);
  }

  async getWithResolvedConfig<T>(key: GCacheKey, layerConfig: ResolvedLayerConfig): Promise<CacheGetResult<T>> {
    const client = await this.resolveClient();
    const redisKey = this.redisKey(key);
    const payload = await client.read({
      valueKey: redisKey,
      ...(key.trackForInvalidation ? { watermarkKey: this.redisWatermarkKeyFromKey(key) } : {}),
    });
    if (payload === null) {
      return { status: "miss", config: layerConfig };
    }

    const start = performance.now();
    try {
      const value = (await this.serializerFor(key).load(decodePayload(payload))) as T;
      return { status: "hit", value };
    } catch (error) {
      this.recordMetric((metrics) => metrics.error({ ...labelsFor(key, CacheLayer.REMOTE), error: errorName(error), inFallback: false }));
      return { status: "miss", config: layerConfig };
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "load" }, elapsedSeconds(start)));
    }
  }

  async put<T>(key: GCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<boolean> {
    const ttlSec = config?.ttlSec ?? await this.resolveRemoteTtlSec(key);
    if (ttlSec === null) {
      return true;
    }

    const start = performance.now();
    let serialized: string | Buffer;
    try {
      serialized = await this.serializerFor(key).dump(value);
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "dump" }, elapsedSeconds(start)));
    }
    this.recordMetric((metrics) => metrics.observeSize(labelsFor(key, CacheLayer.REMOTE), payloadSize(serialized)));

    const client = await this.resolveClient();
    const cacheTtlMs = ttlSec * 1000;
    if (!Number.isSafeInteger(cacheTtlMs)) {
      throw new RangeError("Redis cache TTL is too large");
    }
    const request = {
      valueKey: this.redisKey(key),
      cacheTtlMs,
      encoding: Buffer.isBuffer(serialized) ? "base64" : "utf8",
      value: Buffer.isBuffer(serialized) ? serialized.toString("base64") : serialized,
    } as const;
    return key.trackForInvalidation
      ? await client.write({
          ...request,
          watermarkKey: this.redisWatermarkKeyFromKey(key),
          watermarkTtlFloorMs: this.watermarkTtlMs,
        })
      : await client.write(request);
  }

  async invalidate(keyType: string, id: string, futureBufferMs = 0, urnPrefix = "urn"): Promise<void> {
    const client = await this.resolveClient();
    await client.invalidate({
      watermarkKey: this.redisWatermarkKey(urnPrefix, keyType, id),
      futureBufferMs,
      watermarkTtlFloorMs: this.watermarkTtlMs,
    });
  }

  async flushAll(): Promise<void> {
    const client = await this.resolveClient();
    await client.flushAll();
  }

  redisKey(key: GCacheKey): string {
    return `${this.keyPrefix}${key.urn}${REDIS_FRAME_KEY_SUFFIX}`;
  }

  redisWatermarkKey(urnPrefix: string, keyType: string, id: string): string {
    return `${this.keyPrefix}${redisClusterHashTag(invalidationPrefix(urnPrefix, keyType, id))}#watermark`;
  }

  private redisWatermarkKeyFromKey(key: GCacheKey): string {
    return this.redisWatermarkKey(key.urnPrefix, key.keyType, key.id);
  }

  private async resolveClient(): Promise<GCacheRedisClient> {
    if (this.clientPromise === null) {
      if (this.createClient === null) {
        throw new Error("Redis client has not been configured");
      }
      this.clientPromise = Promise.resolve(this.createClient());
    }
    try {
      return await this.clientPromise;
    } catch (error) {
      if (this.createClient !== null) {
        this.clientPromise = null;
      }
      throw error;
    }
  }

  private serializerFor(key: GCacheKey): Serializer<unknown> {
    return key.serializer ?? this.defaultSerializer;
  }

  private async resolveRemoteLayerConfig(key: GCacheKey, keyConfig?: GCacheKeyConfig | null) {
    const config = keyConfig === undefined ? await fetchKeyConfig(this.configProvider, key) : keyConfig;
    return await resolveLayerConfigResult({
      config,
      key,
      layer: CacheLayer.REMOTE,
      rampSampler: this.rampSampler,
    });
  }

  private async resolveRemoteTtlSec(key: GCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveRemoteLayerConfig(key);
    return layerConfig.status === "enabled" ? layerConfig.config.ttlSec : null;
  }

  private recordMetric(record: (metrics: GCacheMetricsAdapter) => void): void {
    if (this.metrics === null) {
      return;
    }
    try {
      record(this.metrics);
    } catch {
      // Metrics adapters must not affect cache correctness or application fallbacks.
    }
  }
}

function decodePayload(payload: RedisCachePayload): string | Buffer {
  return payload.encoding === "base64" ? Buffer.from(payload.value, "base64") : payload.value;
}

function payloadSize(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}
