import { performance } from "node:perf_hooks";

import {
  CacheLayer,
  deterministicRampSampler,
  type Awaitable,
  type CacheConfigProvider,
  type CacheRampSampler,
  type DialCacheConfig,
  type DialCacheKeyConfig,
  type Logger,
} from "./config.js";
import { DialCacheContext, getOrCreateRequestLocalCache, type RequestLocalCache } from "./context.js";
import { UseCaseIsAlreadyRegisteredError, UseCaseNameIsReservedError } from "./errors.js";
import { DialCacheKey, normalizeArgs } from "./key.js";
import {
  NO_CACHE_LAYER,
  REQUEST_LOCAL_CACHE_LAYER,
  labelsFor,
  type CacheMetricLabels,
  type CoalescingScope,
  type DialCacheMetricsAdapter,
  type MetricErrorKind,
  type MetricLayer,
} from "./metrics.js";
import type { Serializer } from "./serializer.js";
import type { CacheGetResult } from "./internal/cache-result.js";
import { LocalCache } from "./internal/local-cache.js";
import { RedisCache } from "./internal/redis-cache.js";
import {
  fetchKeyConfig,
  resolveLayerConfigResult,
  type LayerConfigResolution,
  type ResolvedLayerConfig,
} from "./internal/runtime-config.js";

type CacheKeyArgs = Record<string, string | number | boolean | bigint | null | undefined>;
type Id = string | number | bigint;

/** A cache-key spec: a bare id, or an id plus extra (secondary) key dimensions. */
export type CacheKeySpec = Id | { readonly id: Id; readonly args?: CacheKeyArgs };

// "Any function" without using `any`, so Parameters/ReturnType still apply.
type AnyFn = (...args: never[]) => unknown;
/** The cached value type, derived from the wrapped function's return. */
export type CachedValue<Fn extends AnyFn> = Awaited<ReturnType<Fn>>;
type CacheKeySelector<Fn extends AnyFn> = (...args: Parameters<Fn>) => CacheKeySpec;

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = IsAny<T> extends true
  ? false
  : unknown extends T
    ? [keyof T] extends [never]
      ? true
      : false
    : false;
type AllTrue<T> = Exclude<T, true> extends never ? true : false;

/**
 * A bounded, structural approximation of values whose decoded JSON remains
 * assignable to the declared type. It exists only in declarations and adds no
 * runtime validation or serialization work.
 */
type IsJsonCompatible<
  T,
  TopLevel extends boolean = true,
  Depth extends readonly unknown[] = [],
> = IsAny<T> extends true
  ? false
  : IsUnknown<T> extends true
    ? false
    : [T] extends [never]
      ? true
      : Depth["length"] extends 8
        ? false
        : AllTrue<T extends unknown ? IsJsonMember<T, TopLevel, Depth> : never>;

type IsJsonMember<T, TopLevel extends boolean, Depth extends readonly unknown[]> = [T] extends [
  string | number | boolean | null,
]
  ? true
  : [T] extends [void]
    ? TopLevel
    : T extends (...args: infer _Args) => infer _Result
      ? false
      : T extends readonly (infer Item)[]
        ? IsJsonCompatible<Item, false, [...Depth, unknown]>
        : T extends object
          ? IsJsonObject<T, Depth>
          : false;

type IsJsonObject<T extends object, Depth extends readonly unknown[]> = [keyof T] extends [never]
  ? true
  : AllTrue<{
      [Key in keyof T]-?: Key extends string | number
        // Omitting an optional undefined property remains type-compatible.
        ? {} extends Pick<T, Key>
          ? IsJsonCompatible<Exclude<T[Key], undefined>, false, [...Depth, unknown]>
          : IsJsonCompatible<T[Key], false, [...Depth, unknown]>
        : false;
    }[keyof T]>;

interface CachedOptionsBase<Fn extends AnyFn> {
  readonly keyType: string;
  readonly useCase: string;
  readonly defaultConfig?: DialCacheKeyConfig | null;
  readonly trackForInvalidation?: boolean;
  /**
   * Select every input dimension that can affect the returned value. Concurrent
   * enabled calls with the same cache key may share one in-flight execution.
   */
  readonly cacheKey: CacheKeySelector<Fn>;
}

type SerializerOption<Value> = IsJsonCompatible<Value> extends true
  ? { readonly serializer?: Serializer<Value> | null }
  : { readonly serializer: Serializer<Value> };

/**
 * Options for a cached function. A serializer is required when the function's
 * resolved return type is not statically compatible with the default JSON
 * serializer. Supplying one is a trusted assertion; DialCache does not perform
 * runtime round-trip validation.
 */
export type CachedOptions<Fn extends AnyFn> = CachedOptionsBase<Fn> & SerializerOption<CachedValue<Fn>>;

/**
 * A cached function returns references owned by the cache. Treat returned
 * values as immutable; callers that need to mutate must copy them explicitly.
 */
export type CachedFn<Fn extends AnyFn> = (...args: Parameters<Fn>) => Promise<CachedValue<Fn>>;

const DEFAULT_LOCAL_MAX_SIZE = 10_000;
const defaultConfigProvider: CacheConfigProvider = () => null;
const defaultLogger: Logger = console;

export class DialCache {
  private readonly context = new DialCacheContext();
  private readonly localCache: LocalCache;
  private readonly useCases = new Set<string>();
  private readonly configProvider: CacheConfigProvider;
  private readonly urnPrefix: string;
  private readonly logger: Logger;
  private readonly rampSampler: CacheRampSampler;
  private readonly redisCache: RedisCache | null;
  private readonly metrics: DialCacheMetricsAdapter | null;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(config: DialCacheConfig = {}) {
    const localMaxSize = config.localMaxSize ?? DEFAULT_LOCAL_MAX_SIZE;
    if (!Number.isSafeInteger(localMaxSize) || localMaxSize < 0) {
      throw new RangeError("DialCache localMaxSize must be a nonnegative safe integer");
    }

    this.configProvider = config.cacheConfigProvider ?? defaultConfigProvider;
    this.urnPrefix = config.urnPrefix ?? "urn";
    this.logger = config.logger ?? defaultLogger;
    this.rampSampler = config.rampSampler ?? deterministicRampSampler;
    this.metrics = safeMetrics(config.metrics ?? null);
    this.localCache = new LocalCache(this.configProvider, this.rampSampler, localMaxSize);
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

  /**
   * Wraps a function with the configured cache chain. Returned in-memory
   * values are shared by reference and must be treated as immutable.
   */
  cached<Fn extends AnyFn>(fn: Fn, options: CachedOptions<Fn>): CachedFn<Fn> {
    this.registerUseCase(options.useCase);

    const run = async (...args: Parameters<Fn>): Promise<CachedValue<Fn>> => {
      // `fn`'s awaited result is the cached value by construction; the generic `Fn` erases it to `unknown`.
      const fallback = async (): Promise<CachedValue<Fn>> => (await fn(...args)) as CachedValue<Fn>;
      const noLayerLabels = { useCase: options.useCase, keyType: options.keyType, layer: NO_CACHE_LAYER } as const;

      if (!this.isEnabled()) {
        this.metrics?.disabled({ ...noLayerLabels, reason: "context" });
        return await fallback();
      }

      let key: DialCacheKey;
      try {
        key = this.buildKey(options, options.cacheKey(...args));
      } catch (error) {
        this.logger.error("Could not construct DialCache key", error);
        this.metrics?.error({
          ...noLayerLabels,
          error: "key_construction",
          inFallback: false,
        });
        return await this.callFallback(noLayerLabels, fallback);
      }

      let keyConfig: DialCacheKeyConfig | null;
      try {
        keyConfig = await fetchKeyConfig(this.configProvider, key);
      } catch (error) {
        // Provider failure: fail open and run uncached, mirroring the per-layer config_error path.
        this.logger.warn("Could not resolve DialCache key config", error);
        this.metrics?.disabled({ ...noLayerLabels, reason: "config_error" });
        return await this.callFallback(noLayerLabels, fallback);
      }

      // An unawaited child can inherit the async store after its outer enable()
      // callback settles. The closed holder turns that detached work back into
      // pass-through instead of allowing it to repopulate request state.
      if (!this.isEnabled()) {
        this.metrics?.disabled({ ...noLayerLabels, reason: "context" });
        return await this.callFallback(noLayerLabels, fallback);
      }

      if (keyConfig?.requestLocal === true) {
        const requestLocalCache = getOrCreateRequestLocalCache(this.context);
        if (requestLocalCache !== null) {
          return await this.getThroughRequestLocal(requestLocalCache, key, keyConfig, fallback);
        }
      }

      return await this.getThroughSharedLayers(key, keyConfig, fallback, CacheLayer.LOCAL);
    };

    return run;
  }

  /**
   * Writes a remote invalidation watermark for Redis-tracked entries.
   *
   * This does not synchronously evict local cache hits or untracked Redis values.
   *
   * @param futureBufferMs Nonnegative safe integer covering source lag and stale fallback work through the Redis write.
   */
  async invalidateRemote(keyType: string, id: Id, futureBufferMs = 0): Promise<void> {
    assertValidFutureBufferMs(futureBufferMs);

    if (this.redisCache === null) {
      return;
    }

    this.metrics?.invalidation({ keyType, layer: CacheLayer.REMOTE });
    try {
      await this.redisCache.invalidate(keyType, String(id), futureBufferMs, this.urnPrefix);
    } catch (error) {
      this.logger.warn("Error writing DialCache invalidation watermark", error);
      this.metrics?.error({
        useCase: "watermark",
        keyType,
        layer: CacheLayer.REMOTE,
        error: "invalidation",
        inFallback: false,
      });
      throw error;
    }
  }

  private async getThroughRequestLocal<T>(
    requestLocalCache: RequestLocalCache,
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig,
    fallback: () => Promise<T>,
  ): Promise<T> {
    return await this.singleFlight(requestLocalCache.inFlight, key, "request_local", async () => {
      const start = performance.now();
      const result = requestLocalCache.read<T>(key.urn);
      this.metrics?.request(labelsFor(key, REQUEST_LOCAL_CACHE_LAYER));
      this.metrics?.observeGet(labelsFor(key, REQUEST_LOCAL_CACHE_LAYER), elapsedSeconds(start));
      if (result.status === "hit") {
        return result.value;
      }

      this.metrics?.miss(labelsFor(key, REQUEST_LOCAL_CACHE_LAYER));
      const value = await this.getThroughSharedLayers(key, keyConfig, fallback, REQUEST_LOCAL_CACHE_LAYER);
      requestLocalCache.set(key.urn, value);
      return value;
    });
  }

  private async getThroughSharedLayers<T>(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    fallback: () => Promise<T>,
    fallbackMetricLayer: MetricLayer,
  ): Promise<T> {
    const localLayer = await this.resolveLocalLayerConfig(key, keyConfig);
    if (localLayer.status === "enabled") {
      return await this.singleFlight(this.inFlight, key, "process", async () =>
        await this.getThroughActiveLocal(key, keyConfig, localLayer.config, fallback),
      );
    }

    const redisCache = this.redisCache;
    if (redisCache === null) {
      return await this.callFallback(labelsFor(key, fallbackMetricLayer), fallback);
    }

    const remoteLayer = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (remoteLayer.status === "disabled") {
      const fallbackLayer = remoteLayer.reason === "config_error" ? CacheLayer.REMOTE : fallbackMetricLayer;
      return await this.callFallback(labelsFor(key, fallbackLayer), fallback);
    }

    return await this.singleFlight(this.inFlight, key, "process", async () => {
      const remote = await this.readRemoteWithResolvedConfig<T>(redisCache, key, remoteLayer.config);
      return await this.finishRedisChain(redisCache, key, localLayer, remote, fallback, remoteLayer.config);
    });
  }

  private async getThroughActiveLocal<T>(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    localConfig: ResolvedLayerConfig,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const local = this.readLocalWithResolvedConfig<T>(key, localConfig);
    if (local.status === "hit") {
      return local.value;
    }

    const redisCache = this.redisCache;
    if (redisCache === null) {
      return await this.finishLocalOnly(key, local, fallback);
    }

    const remoteLayer = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (remoteLayer.status === "disabled") {
      return await this.finishRedisChain(redisCache, key, local, remoteLayer, fallback);
    }

    const remote = await this.readRemoteWithResolvedConfig<T>(redisCache, key, remoteLayer.config);
    return await this.finishRedisChain(redisCache, key, local, remote, fallback, remoteLayer.config);
  }

  private async finishLocalOnly<T>(key: DialCacheKey, local: CacheGetResult<T>, fallback: () => Promise<T>): Promise<T> {
    const value = await this.callFallback(labelsFor(key, CacheLayer.LOCAL), fallback);
    if (local.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private async finishRedisChain<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    local: CacheGetResult<T>,
    remote: CacheGetResult<T>,
    fallback: () => Promise<T>,
    resolvedRemoteConfig?: ResolvedLayerConfig,
  ): Promise<T> {
    if (remote.status === "hit") {
      if (local.status === "miss") {
        await this.putLocalFailOpen(key, remote.value, local.config);
      }
      return remote.value;
    }

    const remoteErrored = remote.status === "disabled" && remote.reason === "config_error";
    const remoteWriteConfig = remote.status === "miss" ? remote.config : remoteErrored ? resolvedRemoteConfig : undefined;
    const fallbackLayer = remote.status === "miss" || remoteErrored ? CacheLayer.REMOTE : CacheLayer.LOCAL;
    const value = await this.callFallback(labelsFor(key, fallbackLayer), fallback);
    const skipCacheWrite = (remote.status === "miss" || remote.status === "disabled") && remote.skipCacheWrite === true;
    let suppressCacheWrite = skipCacheWrite;
    if (!suppressCacheWrite && remoteWriteConfig !== undefined) {
      try {
        const wroteRemote = await redisCache.put(key, value, remoteWriteConfig);
        suppressCacheWrite = wroteRemote === false;
      } catch (error) {
        this.logger.warn("Error putting value in Redis cache", error);
        suppressCacheWrite = key.trackForInvalidation;
      }
    }
    if (!suppressCacheWrite && local.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private async resolveLocalLayerConfig(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
  ): Promise<LayerConfigResolution> {
    try {
      const result = await this.localCache.resolveLayerConfig(key, keyConfig);
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: result.reason });
      }
      return result;
    } catch (error) {
      this.logger.error("Error resolving local cache config", error);
      this.recordError(key, CacheLayer.LOCAL, "config_resolution");
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: "config_error" });
      return { status: "disabled", reason: "config_error" };
    }
  }

  private readLocalWithResolvedConfig<T>(key: DialCacheKey, layerConfig: ResolvedLayerConfig): CacheGetResult<T> {
    const start = performance.now();
    try {
      const result = this.localCache.getWithResolvedConfig<T>(key, layerConfig);
      this.metrics?.request(labelsFor(key, CacheLayer.LOCAL));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.LOCAL), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.LOCAL));
      }
      return result;
    } catch (error) {
      this.logger.error("Error getting value from local cache", error);
      this.recordError(key, CacheLayer.LOCAL, "cache_read");
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: "config_error" });
      return { status: "disabled", reason: "config_error" } as const;
    }
  }

  private async resolveRemoteLayerConfig(key: DialCacheKey, keyConfig: DialCacheKeyConfig | null) {
    try {
      const result = await resolveLayerConfigResult({
        config: keyConfig,
        key,
        layer: CacheLayer.REMOTE,
        rampSampler: this.rampSampler,
      });
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.REMOTE), reason: result.reason });
      }
      return result;
    } catch (error) {
      this.logger.warn("Error resolving Redis cache config", error);
      this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      return { status: "disabled", reason: "config_error", ...(key.trackForInvalidation ? { skipCacheWrite: true } : {}) } as const;
    }
  }

  private async readRemoteWithResolvedConfig<T>(redisCache: RedisCache, key: DialCacheKey, layerConfig: ResolvedLayerConfig) {
    const start = performance.now();
    try {
      const result = await redisCache.getWithResolvedConfig<T>(key, layerConfig);
      this.metrics?.request(labelsFor(key, CacheLayer.REMOTE));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.REMOTE), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.REMOTE));
      }
      return result;
    } catch (error) {
      this.logger.warn("Error getting value from Redis cache", error);
      return {
        status: "disabled",
        reason: "config_error",
        ...(key.trackForInvalidation ? { skipCacheWrite: true } : {}),
      } as const;
    }
  }

  private async putLocalFailOpen<T>(key: DialCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<void> {
    try {
      await this.localCache.put(key, value, config);
    } catch (error) {
      this.logger.warn("Error putting value in local cache", error);
      this.recordError(key, CacheLayer.LOCAL, "cache_write");
    }
  }

  private async callFallback<T>(labels: CacheMetricLabels, fallback: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fallback();
    } catch (error) {
      this.metrics?.error({ ...labels, error: "fallback", inFallback: true });
      throw error;
    } finally {
      this.metrics?.observeFallback(labels, elapsedSeconds(start));
    }
  }

  private recordError(key: DialCacheKey, layer: CacheLayer, kind: MetricErrorKind): void {
    this.metrics?.error({ ...labelsFor(key, layer), error: kind, inFallback: false });
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

  private buildKey<Fn extends AnyFn>(options: CachedOptions<Fn>, cacheKey: CacheKeySpec): DialCacheKey {
    const spec = typeof cacheKey === "object" ? cacheKey : { id: cacheKey };
    return new DialCacheKey({
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

  private singleFlight<T>(
    inFlight: Map<string, Promise<unknown>>,
    key: DialCacheKey,
    scope: CoalescingScope,
    run: () => Promise<T>,
  ): Promise<T> {
    const existing = inFlight.get(key.urn);
    if (existing !== undefined) {
      this.metrics?.coalesced?.({ useCase: key.useCase, keyType: key.keyType, scope });
      return existing as Promise<T>;
    }

    const promise = run();
    inFlight.set(key.urn, promise);
    const clear = (): void => {
      if (inFlight.get(key.urn) === promise) {
        inFlight.delete(key.urn);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

function assertValidFutureBufferMs(futureBufferMs: number): void {
  if (!Number.isSafeInteger(futureBufferMs) || futureBufferMs < 0) {
    throw new RangeError("DialCache invalidation futureBufferMs must be a nonnegative safe integer");
  }
}

function safeMetrics(metrics: DialCacheMetricsAdapter | null): DialCacheMetricsAdapter | null {
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
