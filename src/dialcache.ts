import { performance } from "node:perf_hooks";

import {
  CacheLayer,
  DialCacheKeyConfig,
  deterministicRampSampler,
  type Awaitable,
  type CacheConfigProvider,
  type CacheRampSampler,
  type DialCacheConfig,
  type Logger,
} from "./config.js";
import { DialCacheContext, getOrCreateRequestLocalCache, type RequestLocalCache } from "./context.js";
import { FallbackTimeoutError, UseCaseIsAlreadyRegisteredError, UseCaseNameIsReservedError } from "./errors.js";
import { DialCacheKey, assertValidNamespace, normalizeArgs } from "./key.js";
import {
  NO_CACHE_LAYER,
  REQUEST_LOCAL_CACHE_LAYER,
  labelsFor,
  type CacheMetricLabels,
  type DialCacheMetricsAdapter,
  type DisabledReason,
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

interface CacheOperationOptionsBase {
  readonly keyType: string;
  readonly useCase: string;
  readonly defaultConfig?: DialCacheKeyConfig | null;
  readonly trackForInvalidation?: boolean;
  /**
   * Monotonic deadline applied once an initially enabled invocation starts its
   * fallback, in milliseconds. Must be at most 2,147,483,647. Defaults to 60
   * seconds. Set to `null` to disable the deadline. Like every JavaScript
   * timer, delivery requires event-loop progress and cannot preempt synchronous
   * work.
   *
   * Concurrent same-key callers share the leader's remaining budget. Timing
   * out rejects those callers and prevents the eventual result from being
   * published by DialCache, but does not cancel the underlying operation.
   */
  readonly fallbackTimeoutMs?: number | null;
}

interface CachedOptionsBase<Fn extends AnyFn> extends CacheOperationOptionsBase {
  /**
   * Select every input dimension that can affect the returned value. Concurrent
   * enabled calls with the same cache key may share one in-flight execution.
   */
  readonly cacheKey: CacheKeySelector<Fn>;
}

type SerializerOption<Value> = IsJsonCompatible<Value> extends true
  ? { readonly serializer?: Serializer<Value> | null }
  : { readonly serializer: Serializer<Value> };
type CacheOperationOptions<Value> = CacheOperationOptionsBase & {
  readonly serializer?: Serializer<Value> | null;
};

/**
 * Options for a cached function. A serializer is required when the function's
 * resolved return type is not statically compatible with the default JSON
 * serializer. Supplying one is a trusted assertion; DialCache does not perform
 * runtime round-trip validation.
 */
export type CachedOptions<Fn extends AnyFn> = CachedOptionsBase<Fn> & SerializerOption<CachedValue<Fn>>;

interface GetOrLoadOptionsBase extends CacheOperationOptionsBase {
  /**
   * Include every captured value that can affect the loaded result. Concurrent
   * enabled calls with the same cache key may share one in-flight loader.
   */
  readonly key: CacheKeySpec;
}

/**
 * Options for one inline cache operation. A serializer is required when the
 * loaded value is not statically compatible with the default JSON serializer.
 * Supplying one is a trusted assertion; DialCache does not perform runtime
 * round-trip validation.
 */
export type GetOrLoadOptions<Value> = GetOrLoadOptionsBase & SerializerOption<Value>;

/**
 * A cached function returns references owned by the cache. Treat returned
 * values as immutable; callers that need to mutate must copy them explicitly.
 */
export type CachedFn<Fn extends AnyFn> = (...args: Parameters<Fn>) => Promise<CachedValue<Fn>>;

/** Exact process-scoped single-flight state for one DialCache instance. */
export interface ProcessCoalescingState {
  readonly activeLeaders: number;
  readonly activeFollowers: number;
  readonly oldestLeaderAgeMs: number | null;
}

/** A point-in-time snapshot of DialCache-owned coalescing state. */
export interface CoalescingState {
  readonly process: ProcessCoalescingState;
}

interface ProcessFlight {
  promise: Promise<unknown> | null;
  readonly startedAtMs: number;
  followers: number;
}

const DEFAULT_LOCAL_MAX_SIZE = 10_000;
const DEFAULT_FALLBACK_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const defaultConfigProvider: CacheConfigProvider = () => null;
const defaultLogger: Logger = console;

export class DialCache {
  private readonly context = new DialCacheContext();
  private readonly localCache: LocalCache;
  private readonly useCases = new Set<string>();
  private readonly configProvider: CacheConfigProvider;
  private readonly namespace: string;
  private readonly logger: Logger;
  private readonly rampSampler: CacheRampSampler;
  private readonly redisCache: RedisCache | null;
  private readonly metrics: DialCacheMetricsAdapter | null;
  private readonly processFlights = new Map<string, ProcessFlight>();
  private activeProcessFollowers = 0;

  constructor(config: DialCacheConfig = {}) {
    if (Object.hasOwn(config, "urnPrefix")) {
      throw new TypeError('DialCacheConfig.urnPrefix was renamed to "namespace"');
    }

    const namespace = config.namespace ?? "urn";
    assertValidNamespace(namespace);

    const localMaxSize = config.localMaxSize ?? DEFAULT_LOCAL_MAX_SIZE;
    if (!Number.isSafeInteger(localMaxSize) || localMaxSize < 0) {
      throw new RangeError("DialCache localMaxSize must be a nonnegative safe integer");
    }

    this.configProvider = config.cacheConfigProvider ?? defaultConfigProvider;
    this.namespace = namespace;
    this.logger = safeLogger(config.logger ?? defaultLogger);
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

  /** Returns exact process-scoped single-flight state for this instance. */
  getCoalescingState(): CoalescingState {
    const oldestFlight = this.processFlights.values().next().value as ProcessFlight | undefined;
    return {
      process: {
        activeLeaders: this.processFlights.size,
        activeFollowers: this.activeProcessFollowers,
        oldestLeaderAgeMs:
          oldestFlight === undefined ? null : Math.max(performance.now() - oldestFlight.startedAtMs, 0),
      },
    };
  }

  /**
   * Wraps a function with the configured cache chain. Returned in-memory
   * values are shared by reference and must be treated as immutable.
   */
  cached<Fn extends AnyFn>(fn: Fn, options: CachedOptions<Fn>): CachedFn<Fn> {
    const defaultConfig = snapshotDefaultConfig(options.defaultConfig);
    const fallbackTimeoutMs = resolveFallbackTimeoutMs(options.fallbackTimeoutMs);
    this.registerUseCase(options.useCase);

    return (...args: Parameters<Fn>): Promise<CachedValue<Fn>> =>
      this.executeCacheOperation(
        // `Fn` preserves the public parameter and return types, but its
        // `AnyFn` constraint erases the invocation result to `unknown`.
        () => fn(...args) as Awaitable<CachedValue<Fn>>,
        () => options.cacheKey(...args),
        options,
        defaultConfig,
        fallbackTimeoutMs,
      );
  }

  /**
   * Executes one inline loader through the configured cache chain. Unlike
   * `cached()`, this method does not register the use case, so a stable use case
   * can be declared repeatedly at the call site. Returned in-memory values are
   * shared by reference and must be treated as immutable.
   */
  getOrLoad<Value>(load: () => Awaitable<Value>, options: GetOrLoadOptions<Value>): Promise<Value> {
    const defaultConfig = snapshotDefaultConfig(options.defaultConfig);
    const fallbackTimeoutMs = resolveFallbackTimeoutMs(options.fallbackTimeoutMs);
    this.assertUseCaseIsNotReserved(options.useCase);

    return this.executeCacheOperation(load, () => options.key, options, defaultConfig, fallbackTimeoutMs);
  }

  private async executeCacheOperation<Value>(
    load: () => Awaitable<Value>,
    selectKey: () => CacheKeySpec,
    options: CacheOperationOptions<Value>,
    defaultConfig: DialCacheKeyConfig | null,
    fallbackTimeoutMs: number | null,
  ): Promise<Value> {
    const rawFallback = async (): Promise<Value> => await load();
    const noLayerLabels = {
      cacheNamespace: this.namespace,
      useCase: options.useCase,
      keyType: options.keyType,
      layer: NO_CACHE_LAYER,
    } as const;

    if (!this.isEnabled()) {
      this.metrics?.disabled({ ...noLayerLabels, reason: "context" });
      return await rawFallback();
    }

    const fallback = (): Promise<Value> => withFallbackTimeout(rawFallback, options.useCase, fallbackTimeoutMs);

    let key: DialCacheKey;
    try {
      key = this.buildKey(options, selectKey(), defaultConfig);
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
      this.recordError(key, NO_CACHE_LAYER, "config_resolution");
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
  }

  /**
   * Writes a remote invalidation watermark for Redis-tracked entries.
   *
   * This does not synchronously evict local cache hits or untracked Redis values.
   * Call it only after the source mutation commits.
   *
   * `futureBufferMs` is an application-owned safety window. When using the
   * bundled timestamp protocol, every Redis node eligible for primary promotion
   * must have a synchronized system clock. Size the window to cover the maximum
   * expected negative clock skew plus source visibility lag and the full
   * remaining lifetime of fallback work that may already have observed stale
   * data, including serializer dump, Redis client queue and network latency,
   * script execution, the write itself, and a safety margin. DialCache does not
   * detect or compensate for cross-node clock skew. Violating this assumption
   * can suppress tracked cache fills or leave a pre-invalidation value readable
   * until it expires or a later invalidation advances the watermark past its
   * timestamp.
   * There is no universally safe library value. A zero buffer provides no
   * stale-publication protection once Redis time advances; an undersized buffer
   * may allow stale data to repopulate Redis. An oversized buffer temporarily
   * converts more tracked Redis reads into misses and rejects their tracked
   * writes, but does not delay or suppress returning fallback values.
   *
   * The watermark fences only invocations that reach the tracked Redis write.
   * A rejected write also suppresses the corresponding process-local population.
   * Request-local memoization remains unconditional, and invocations whose
   * remote layer is disabled or ramped out are not fenced by the watermark.
   *
   * @param futureBufferMs Nonnegative safe integer; defaults to zero for backward compatibility.
   */
  async invalidateRemote(keyType: string, id: Id, futureBufferMs = 0): Promise<void> {
    assertValidFutureBufferMs(futureBufferMs);

    if (this.redisCache === null) {
      return;
    }

    this.metrics?.invalidation({ cacheNamespace: this.namespace, keyType, layer: CacheLayer.REMOTE });
    try {
      await this.redisCache.invalidate(keyType, String(id), futureBufferMs, this.namespace);
    } catch (error) {
      this.logger.warn("Error writing DialCache invalidation watermark", error);
      this.metrics?.error({
        cacheNamespace: this.namespace,
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
    return await this.singleFlightRequestLocal(requestLocalCache.inFlight, key, async () => {
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
      return await this.singleFlightProcess(key, async () =>
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

    return await this.singleFlightProcess(key, async () => {
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
        this.recordInvalidLeaf(key, CacheLayer.LOCAL, result.reason);
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
        this.recordInvalidLeaf(key, CacheLayer.REMOTE, result.reason);
      }
      return result;
    } catch (error) {
      this.logger.warn("Error resolving Redis cache config", error);
      this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.REMOTE), reason: "config_error" });
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

  private recordError(key: DialCacheKey, layer: MetricLayer, kind: MetricErrorKind): void {
    this.metrics?.error({ ...labelsFor(key, layer), error: kind, inFallback: false });
  }

  /**
   * Invalid runtime TTL/ramp leaves can only come from provider results, since
   * static defaults are validated before the operation executes. Count them as
   * config_resolution errors as well as disabled skips so garbage config is
   * alertable separately from intentional ramp-downs and disabled policy.
   */
  private recordInvalidLeaf(key: DialCacheKey, layer: MetricLayer, reason: DisabledReason): void {
    if (reason === "invalid_ttl" || reason === "invalid_ramp") {
      this.recordError(key, layer, "config_resolution");
    }
  }

  private registerUseCase(useCase: string): void {
    this.assertUseCaseIsNotReserved(useCase);
    if (this.useCases.has(useCase)) {
      throw new UseCaseIsAlreadyRegisteredError(useCase);
    }
    this.useCases.add(useCase);
  }

  private assertUseCaseIsNotReserved(useCase: string): void {
    if (useCase === "watermark") {
      throw new UseCaseNameIsReservedError(useCase);
    }
  }

  private buildKey<Value>(
    options: CacheOperationOptions<Value>,
    cacheKey: CacheKeySpec,
    defaultConfig: DialCacheKeyConfig | null,
  ): DialCacheKey {
    const spec = typeof cacheKey === "object" ? cacheKey : { id: cacheKey };
    return new DialCacheKey({
      keyType: options.keyType,
      id: String(spec.id),
      useCase: options.useCase,
      args: normalizeArgs(spec.args ?? {}),
      namespace: this.namespace,
      defaultConfig,
      serializer: (options.serializer as Serializer<unknown> | null | undefined) ?? null,
      trackForInvalidation: options.trackForInvalidation ?? false,
    });
  }

  private singleFlightRequestLocal<T>(
    inFlight: Map<string, Promise<unknown>>,
    key: DialCacheKey,
    run: () => Promise<T>,
  ): Promise<T> {
    const existing = inFlight.get(key.urn);
    if (existing !== undefined) {
      this.metrics?.coalesced?.({
        cacheNamespace: key.namespace,
        useCase: key.useCase,
        keyType: key.keyType,
        scope: "request_local",
      });
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

  private singleFlightProcess<T>(key: DialCacheKey, run: () => Promise<T>): Promise<T> {
    const existing = this.processFlights.get(key.urn);
    if (existing !== undefined) {
      if (existing.promise === null) {
        throw new Error("DialCache process flight was joined before initialization");
      }
      existing.followers += 1;
      this.activeProcessFollowers += 1;
      this.metrics?.coalesced?.({
        cacheNamespace: key.namespace,
        useCase: key.useCase,
        keyType: key.keyType,
        scope: "process",
      });
      return existing.promise as Promise<T>;
    }

    const flight: ProcessFlight = {
      promise: null,
      startedAtMs: performance.now(),
      followers: 0,
    };
    this.processFlights.set(key.urn, flight);
    let promise: Promise<T>;
    try {
      promise = run();
    } catch (error) {
      if (this.processFlights.get(key.urn) === flight) {
        this.processFlights.delete(key.urn);
      }
      throw error;
    }
    flight.promise = promise;
    const clear = (): void => {
      if (this.processFlights.get(key.urn) === flight) {
        this.activeProcessFollowers -= flight.followers;
        this.processFlights.delete(key.urn);
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

function snapshotDefaultConfig(config: DialCacheKeyConfig | null | undefined): DialCacheKeyConfig | null {
  if (config === null || config === undefined) {
    return null;
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("DialCache defaultConfig must be an object");
  }
  const ttlSecConfig = config.ttlSec;
  const rampConfig = config.ramp;
  const requestLocal = config.requestLocal;
  if (requestLocal !== undefined && typeof requestLocal !== "boolean") {
    throw new TypeError("DialCache defaultConfig requestLocal must be a boolean");
  }

  assertDefaultLayerMap(ttlSecConfig, "ttlSec");
  assertDefaultLayerMap(rampConfig, "ramp");

  const snapshot = new DialCacheKeyConfig({
    ttlSec: ttlSecConfig,
    ramp: rampConfig,
    ...(requestLocal === undefined ? {} : { requestLocal }),
  });

  for (const layer of [CacheLayer.LOCAL, CacheLayer.REMOTE]) {
    const ttlSec = snapshot.ttlSec[layer];
    if (ttlSec !== undefined) {
      if (typeof ttlSec !== "number") {
        throw new TypeError(`DialCache defaultConfig ttlSec.${layer} must be a number`);
      }
      if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) {
        throw new RangeError(`DialCache defaultConfig ttlSec.${layer} must be a positive safe integer`);
      }
    }

    const ramp = snapshot.ramp[layer];
    if (ramp !== undefined) {
      if (typeof ramp !== "number") {
        throw new TypeError(`DialCache defaultConfig ramp.${layer} must be a number`);
      }
      if (!Number.isFinite(ramp) || ramp < 0 || ramp > 100) {
        throw new RangeError(`DialCache defaultConfig ramp.${layer} must be between 0 and 100`);
      }
    }
  }

  Object.freeze(snapshot.ttlSec);
  Object.freeze(snapshot.ramp);
  return Object.freeze(snapshot);
}

function assertDefaultLayerMap(config: unknown, name: "ttlSec" | "ramp"): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(`DialCache defaultConfig ${name} must be a layer map`);
  }
}

function resolveFallbackTimeoutMs(value: number | null | undefined): number | null {
  if (value === null) {
    return null;
  }

  const timeoutMs = value ?? DEFAULT_FALLBACK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `DialCache fallbackTimeoutMs must be null or a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return timeoutMs;
}

function withFallbackTimeout<T>(
  fallback: () => Promise<T>,
  useCase: string,
  timeoutMs: number | null,
): Promise<T> {
  if (timeoutMs === null) {
    return fallback();
  }

  const startedAtMs = performance.now();
  const operation = fallback();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const elapsedMs = (): number => Math.max(performance.now() - startedAtMs, 0);
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const rejectTimeout = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      reject(new FallbackTimeoutError(useCase, timeoutMs));
    };
    const onTimer = (): void => {
      timer = null;
      if (settled) {
        return;
      }

      const remainingMs = timeoutMs - elapsedMs();
      if (remainingMs > 0) {
        timer = setTimeout(onTimer, Math.ceil(remainingMs));
        return;
      }
      rejectTimeout();
    };
    const settleBeforeDeadline = (settle: () => void): void => {
      if (settled) {
        return;
      }
      if (elapsedMs() >= timeoutMs) {
        rejectTimeout();
        return;
      }
      settled = true;
      clearTimer();
      settle();
    };

    const remainingMs = timeoutMs - elapsedMs();
    if (remainingMs <= 0) {
      rejectTimeout();
    } else {
      timer = setTimeout(onTimer, Math.ceil(remainingMs));
    }

    void operation.then(
      (value) => {
        settleBeforeDeadline(() => resolve(value));
      },
      (error: unknown) => {
        settleBeforeDeadline(() => reject(error));
      },
    );
  });
}

function safeLogger(logger: Logger): Logger {
  return {
    debug: (...args: Parameters<Logger["debug"]>) => callLogger(() => logger.debug(...args)),
    error: (...args: Parameters<Logger["error"]>) => callLogger(() => logger.error(...args)),
    warn: (...args: Parameters<Logger["warn"]>) => callLogger(() => logger.warn(...args)),
  };
}

function callLogger(log: () => void): void {
  try {
    log();
  } catch {
    // Injected loggers must not affect cache correctness or application fallbacks.
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
