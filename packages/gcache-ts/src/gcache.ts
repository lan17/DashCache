import { performance } from "node:perf_hooks";

import {
  CacheLayer,
  GCacheKeyConfig,
  deterministicRampSampler,
  type Awaitable,
  type CacheConfigProvider,
  type CacheRampSampler,
  type GCacheConfig,
  type Logger,
} from "./config.js";
import { GCacheContext } from "./context.js";
import { UseCaseIsAlreadyRegisteredError, UseCaseNameIsReservedError } from "./errors.js";
import { GCacheKey, normalizeArgs } from "./key.js";
import { createPrometheusGCacheMetrics, errorName, labelsFor, type CacheMetricLabels, type GCacheMetricsAdapter } from "./metrics.js";
import type { Serializer } from "./serializer.js";
import { LocalCache } from "./internal/local-cache.js";
import { RedisCache } from "./internal/redis-cache.js";
import { fetchKeyConfig } from "./internal/runtime-config.js";

type CacheArgs = Record<string, string | number | boolean | bigint | null | undefined>;
type Id = string | number | bigint;

/** A cache-key spec: a bare id, or an id plus extra (secondary) key dimensions. */
export type CacheKeySpec = Id | { readonly id: Id; readonly args?: CacheArgs };

// "Any function" without using `any`, so Parameters/ReturnType still apply.
type AnyFn = (...args: never[]) => unknown;
/** The cached value type, derived from the wrapped function's return. */
export type CachedValue<Fn extends AnyFn> = Awaited<ReturnType<Fn>>;
type KeySelector<Fn extends AnyFn> = (...args: Parameters<Fn>) => CacheKeySpec;

export interface CachedOptions<Fn extends AnyFn> {
  readonly keyType: string;
  readonly useCase: string;
  readonly defaultConfig?: import("./config.js").GCacheKeyConfig | null;
  readonly serializer?: Serializer<CachedValue<Fn>> | null;
  readonly trackForInvalidation?: boolean;
  // Coalesce concurrent misses for this use case into one in-flight fallback.
  // Defaults to the instance's coalesceByDefault (true); runtime config wins.
  readonly coalesce?: boolean;
  readonly cacheKey: KeySelector<Fn>;
}

export interface CachedFn<Fn extends AnyFn> {
  (...args: Parameters<Fn>): Promise<CachedValue<Fn>>;
}

const DEFAULT_LOCAL_MAX_SIZE = 10_000;
const defaultConfigProvider: CacheConfigProvider = () => null;
const defaultLogger: Logger = console;

export class GCache {
  private readonly context = new GCacheContext();
  private readonly localCache: LocalCache;
  private readonly useCases = new Set<string>();
  private readonly configProvider: CacheConfigProvider;
  private readonly urnPrefix: string;
  private readonly logger: Logger;
  private readonly rampSampler: CacheRampSampler;
  private readonly redisCache: RedisCache | null;
  private readonly metrics: GCacheMetricsAdapter | null;
  private readonly coalesceByDefault: boolean;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(config: GCacheConfig = {}) {
    this.configProvider = config.cacheConfigProvider ?? defaultConfigProvider;
    this.urnPrefix = config.urnPrefix ?? "urn";
    this.logger = config.logger ?? defaultLogger;
    this.rampSampler = config.rampSampler ?? deterministicRampSampler;
    this.coalesceByDefault = config.coalesceByDefault ?? true;
    const metrics =
      config.metrics === false
        ? null
        : config.metrics ??
          createPrometheusGCacheMetrics({
            prefix: config.metricsPrefix ?? "",
            ...(config.metricsRegistry === undefined ? {} : { registry: config.metricsRegistry }),
          });
    this.metrics = safeMetrics(metrics);
    this.localCache = new LocalCache(this.configProvider, this.rampSampler, config.localMaxSize ?? DEFAULT_LOCAL_MAX_SIZE);
    this.redisCache =
      config.redis === undefined
        ? null
        : new RedisCache({
            configProvider: this.configProvider,
            rampSampler: this.rampSampler,
            redis: config.redis,
            metrics: this.metrics,
          });
  }

  enable<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.context.enable(fn);
  }

  disable<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.context.disable(fn);
  }

  withEnabled<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.enable(fn);
  }

  withDisabled<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.disable(fn);
  }

  isEnabled(): boolean {
    return this.context.isEnabled();
  }

  cached<Fn extends AnyFn>(fn: Fn, options: CachedOptions<Fn>): CachedFn<Fn> {
    this.registerUseCase(options.useCase);

    const run = async (...args: Parameters<Fn>): Promise<CachedValue<Fn>> => {
      // `fn`'s awaited result is the cached value by construction; the generic `Fn` erases it to `unknown`.
      const fallback = async (): Promise<CachedValue<Fn>> => (await fn(...args)) as CachedValue<Fn>;

      if (!this.isEnabled()) {
        this.metrics?.disabled({
          useCase: options.useCase,
          keyType: options.keyType,
          layer: "noop",
          reason: "context",
        });
        return await fallback();
      }

      let key: GCacheKey;
      try {
        key = this.buildKey(options, options.cacheKey(...args));
      } catch (error) {
        this.logger.error("Could not construct GCache key", error);
        this.metrics?.error({
          useCase: options.useCase,
          keyType: options.keyType,
          layer: "noop",
          error: errorName(error),
          inFallback: false,
        });
        return await this.callFallback({ useCase: options.useCase, keyType: options.keyType, layer: "noop" }, fallback);
      }

      let keyConfig: GCacheKeyConfig | null;
      try {
        keyConfig = await fetchKeyConfig(this.configProvider, key);
      } catch (error) {
        // Provider failure: fail open and run uncached, mirroring the per-layer config_error path.
        this.logger.warn("Could not resolve GCache key config", error);
        this.metrics?.disabled({
          useCase: options.useCase,
          keyType: options.keyType,
          layer: "noop",
          reason: "config_error",
        });
        return await this.callFallback({ useCase: options.useCase, keyType: options.keyType, layer: "noop" }, fallback);
      }

      const runThroughCache = (): Promise<CachedValue<Fn>> =>
        this.redisCache === null
          ? this.getThroughLocalOnly(key, keyConfig, fallback)
          : this.getThroughRedisChain(key, keyConfig, fallback);

      if (keyConfig?.coalesce ?? options.coalesce ?? this.coalesceByDefault) {
        return await this.singleFlight(key, runThroughCache);
      }

      return await runThroughCache();
    };

    return run;
  }

  async invalidate(keyType: string, id: Id, futureBufferMs = 0): Promise<void> {
    assertValidFutureBufferMs(futureBufferMs);

    if (this.redisCache === null) {
      return;
    }

    this.metrics?.invalidation({ keyType, layer: CacheLayer.REMOTE });
    try {
      await this.redisCache.invalidate(keyType, String(id), futureBufferMs, this.urnPrefix);
    } catch (error) {
      this.logger.warn("Error writing GCache invalidation watermark", error);
      this.metrics?.error({
        useCase: "watermark",
        keyType,
        layer: CacheLayer.REMOTE,
        error: errorName(error),
        inFallback: false,
      });
      throw error;
    }
  }

  async flushAll(): Promise<void> {
    await this.localCache.flushAll();
    if (this.redisCache === null) {
      return;
    }

    try {
      await this.redisCache.flushAll();
    } catch (error) {
      this.logger.warn("Error flushing Redis cache", error);
      this.metrics?.error({
        useCase: "flushAll",
        keyType: "all",
        layer: CacheLayer.REMOTE,
        error: errorName(error),
        inFallback: false,
      });
      throw error;
    }
  }

  private async getThroughLocalOnly<T>(key: GCacheKey, keyConfig: GCacheKeyConfig | null, fallback: () => Promise<T>): Promise<T> {
    const local = await this.readLocal<T>(key, keyConfig);
    if (local.status === "hit") {
      return local.value;
    }

    const value = await this.callFallback(labelsFor(key, CacheLayer.LOCAL), fallback);
    if (local.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private async getThroughRedisChain<T>(key: GCacheKey, keyConfig: GCacheKeyConfig | null, fallback: () => Promise<T>): Promise<T> {
    const local = await this.readLocal<T>(key, keyConfig);
    if (local.status === "hit") {
      return local.value;
    }

    const remote = await this.readRemote<T>(key, keyConfig);
    if (remote.status === "hit") {
      if (local.status === "miss") {
        await this.putLocalFailOpen(key, remote.value, local.config);
      }
      return remote.value;
    }

    const remoteErrored = remote.status === "disabled" && remote.reason === "config_error";
    const fallbackLayer = remote.status === "miss" || remoteErrored ? CacheLayer.REMOTE : CacheLayer.LOCAL;
    const value = await this.callFallback(labelsFor(key, fallbackLayer), fallback);
    const skipCacheWrite = (remote.status === "miss" || remote.status === "disabled") && remote.skipCacheWrite === true;
    let suppressCacheWrite = skipCacheWrite;
    if (!suppressCacheWrite && (remote.status === "miss" || remoteErrored)) {
      try {
        const wroteRemote = await this.redisCache?.put(key, value, remote.status === "miss" ? remote.config : undefined);
        suppressCacheWrite = wroteRemote === false;
      } catch (error) {
        this.logger.warn("Error putting value in Redis cache", error);
        this.recordError(key, CacheLayer.REMOTE, error, false);
        suppressCacheWrite = key.trackForInvalidation;
      }
    }
    if (!suppressCacheWrite && local.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private async readLocal<T>(key: GCacheKey, keyConfig: GCacheKeyConfig | null) {
    const start = performance.now();
    try {
      const result = await this.localCache.getIfPresentResult<T>(key, keyConfig);
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: result.reason });
        return result;
      }

      this.metrics?.request(labelsFor(key, CacheLayer.LOCAL));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.LOCAL), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.LOCAL));
      }
      return result;
    } catch (error) {
      this.logger.error("Error getting value from local cache", error);
      this.recordError(key, CacheLayer.LOCAL, error, false);
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: "config_error" });
      return { status: "disabled", reason: "config_error" } as const;
    }
  }

  private async readRemote<T>(key: GCacheKey, keyConfig: GCacheKeyConfig | null) {
    const start = performance.now();
    try {
      const result = await this.redisCache?.getResult<T>(key, keyConfig);
      if (result === undefined) {
        return { status: "disabled", reason: "missing_config" } as const;
      }
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.REMOTE), reason: result.reason });
        return result;
      }

      this.metrics?.request(labelsFor(key, CacheLayer.REMOTE));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.REMOTE), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.REMOTE));
      }
      return result;
    } catch (error) {
      this.logger.warn("Error getting value from Redis cache", error);
      this.recordError(key, CacheLayer.REMOTE, error, false);
      return { status: "disabled", reason: "config_error", ...(key.trackForInvalidation ? { skipCacheWrite: true } : {}) } as const;
    }
  }

  private async putLocalFailOpen<T>(key: GCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<void> {
    try {
      await this.localCache.put(key, value, config);
    } catch (error) {
      this.logger.warn("Error putting value in local cache", error);
      this.recordError(key, CacheLayer.LOCAL, error, false);
    }
  }

  private async callFallback<T>(labels: CacheMetricLabels, fallback: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fallback();
    } catch (error) {
      this.metrics?.error({ ...labels, error: errorName(error), inFallback: true });
      throw error;
    } finally {
      this.metrics?.observeFallback(labels, elapsedSeconds(start));
    }
  }

  private recordError(key: GCacheKey, layer: CacheLayer, error: unknown, inFallback: boolean): void {
    this.metrics?.error({ ...labelsFor(key, layer), error: errorName(error), inFallback });
  }

  private registerUseCase(useCase: string): void {
    if (useCase === "watermark") {
      throw new UseCaseNameIsReservedError(useCase);
    }
    if (this.useCases.has(useCase)) {
      throw new UseCaseIsAlreadyRegisteredError(useCase);
    }
    this.useCases.add(useCase);
  }

  private buildKey<Fn extends AnyFn>(options: CachedOptions<Fn>, cacheKey: CacheKeySpec): GCacheKey {
    const spec = typeof cacheKey === "object" ? cacheKey : { id: cacheKey };
    return new GCacheKey({
      keyType: options.keyType,
      id: String(spec.id),
      useCase: options.useCase,
      args: normalizeArgs(spec.args ?? {}),
      urnPrefix: this.urnPrefix,
      defaultConfig: options.defaultConfig ?? null,
      serializer: (options.serializer as Serializer<unknown> | null | undefined) ?? null,
      trackForInvalidation: options.trackForInvalidation ?? false,
    });
  }

  // In-process single-flight: the first caller for a urn runs the chain; concurrent
  // callers share its in-flight promise. The entry is cleared on settle (success or
  // reject) so a failed leader never poisons later callers.
  private singleFlight<T>(key: GCacheKey, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key.urn);
    if (existing !== undefined) {
      this.metrics?.coalesced?.({ useCase: key.useCase, keyType: key.keyType });
      // Same urn implies the same logical value type as the leader.
      return existing as Promise<T>;
    }

    const promise = run();
    this.inFlight.set(key.urn, promise);
    const clear = (): void => {
      this.inFlight.delete(key.urn);
    };
    void promise.then(clear, clear);
    return promise;
  }
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

function assertValidFutureBufferMs(futureBufferMs: number): void {
  if (!Number.isFinite(futureBufferMs) || futureBufferMs < 0) {
    throw new RangeError("GCache invalidation futureBufferMs must be a finite nonnegative number");
  }
}

function safeMetrics(metrics: GCacheMetricsAdapter | null): GCacheMetricsAdapter | null {
  if (metrics === null) {
    return null;
  }

  return {
    request: (labels) => callMetric(() => metrics.request(labels)),
    miss: (labels) => callMetric(() => metrics.miss(labels)),
    disabled: (labels) => callMetric(() => metrics.disabled(labels)),
    error: (labels) => callMetric(() => metrics.error(labels)),
    invalidation: (labels) => callMetric(() => metrics.invalidation(labels)),
    coalesced: (labels) => callMetric(() => metrics.coalesced?.(labels)),
    observeGet: (labels, seconds) => callMetric(() => metrics.observeGet(labels, seconds)),
    observeFallback: (labels, seconds) => callMetric(() => metrics.observeFallback(labels, seconds)),
    observeSerialization: (labels, seconds) => callMetric(() => metrics.observeSerialization(labels, seconds)),
    observeSize: (labels, bytes) => callMetric(() => metrics.observeSize(labels, bytes)),
  };
}

function callMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Metrics adapters must not affect cache correctness or application fallbacks.
  }
}
