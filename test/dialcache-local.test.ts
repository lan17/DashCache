import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  JsonSerializer,
  UseCaseIsAlreadyRegisteredError,
  UseCaseNameIsReservedError,
} from "../src/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("DialCache local-only MVP", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps caching disabled by default", async () => {
    // Given a cached function with a valid default local configuration.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "GetUserDefaultDisabled",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the function is called outside an enabled context.
    const first = await getUser("123");
    const second = await getUser("123");

    // Then the fallback executes every time.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("does not evaluate explicit cacheKey selectors when caching is disabled", async () => {
    // Given a cached function with a cacheKey selector that would fail if caching tried to build a key.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "DisabledContextSkipsCacheKeySelector",
      cacheKey: () => {
        throw new Error("cacheKey selector should not run outside an enabled context");
      },
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the function is called outside an enabled context.
    const value = await getUser("123");

    // Then the fallback executes without consulting cache key construction.
    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
  });

  it("supports metrics-disabled local caching and no-op invalidation without Redis", async () => {
    // Given metrics may be explicitly disabled and Redis may be absent.
    const dialcache = new DialCache({ metrics: false });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "MetricsDisabledNoRedis",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When local caching is used and targeted invalidation is requested without a Redis layer.
    const first = await dialcache.enable(async () => await getUser("123"));
    await dialcache.invalidateRemote("user_id", "123");
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then no metrics adapter or Redis layer is required for the local path to work.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
  });

  it("caches values inside an enabled context", async () => {
    // Given a cached function called with the same cache key.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "GetUserEnabled",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the function is called twice inside dialcache.enable().
    const [first, second] = await dialcache.enable(async () => [await getUser("123"), await getUser("123")]);

    // Then the fallback only executes once and the second call returns the cached value.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
  });

  it("shares process-local value references across request scopes without cloning", async () => {
    const dialcache = new DialCache();
    const getUser = dialcache.cached(async (userId: string) => ({ userId, roles: ["reader"] }), {
      keyType: "user_id",
      useCase: "ProcessLocalReferenceIdentity",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    first.roles.push("mutated-by-caller");
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(second).toBe(first);
    expect(second.roles).toEqual(["reader", "mutated-by-caller"]);
  });

  it("restores the previous enabled value after nested disable scopes", async () => {
    // Given caching is enabled in an outer scope.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "GetUserNestedDisable",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When a nested disabled scope calls the cached function.
    const result = await dialcache.enable(async () => {
      const first = await getUser("123");
      const disabled = await dialcache.disable(async () => await getUser("123"));
      const after = await getUser("123");
      return { first, disabled, after };
    });

    // Then the disabled scope bypasses cache and the outer scope resumes using the cached value.
    expect(result.first).toEqual({ userId: "123", calls: 1 });
    expect(result.disabled).toEqual({ userId: "123", calls: 2 });
    expect(result.after).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(2);
  });

  it("does not leak enabled context across parallel async flows", async () => {
    // Given one flow enables caching while another flow does not.
    const dialcache = new DialCache();
    let calls = 0;
    const getValue = dialcache.cached(async (tenantId: string) => ({ tenantId, calls: ++calls }), {
      keyType: "tenant_id",
      useCase: "ParallelContextIsolation",
      cacheKey: (tenantId) => tenantId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When both flows run concurrently.
    const [enabledFlow, disabledFlow] = await Promise.all([
      dialcache.enable(async () => [await getValue("enabled"), await getValue("enabled")] as const),
      (async () => [await getValue("disabled"), await getValue("disabled")] as const)(),
    ]);

    // Then enabled state is isolated to the enabled async flow.
    expect(enabledFlow[0]).toEqual(enabledFlow[1]);
    expect(enabledFlow[0]?.tenantId).toBe("enabled");
    expect(disabledFlow[0]?.tenantId).toBe("disabled");
    expect(disabledFlow[1]?.tenantId).toBe("disabled");
    expect(disabledFlow[0]?.calls).not.toBe(disabledFlow[1]?.calls);
    expect(calls).toBe(3);
  });

  it("preserves enabled context through Promise.all within a scope", async () => {
    // Given an enabled context with concurrent cache lookups for the same key.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "PromiseAllContext",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When one call populates cache before Promise.all repeats the same lookup.
    const first = await dialcache.enable(async () => await getUser("123"));
    const parallel = await dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));

    // Then all calls in the enabled async scopes can read the cached value.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(parallel).toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 1 },
    ]);
    expect(calls).toBe(1);
  });

  it("coalesces concurrent fallbacks when a cache layer is active", async () => {
    // Given two concurrent requests miss the same local cache key.
    const gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(
      async (userId: string) => {
        calls += 1;
        const call = calls;
        await gate.promise;
        return { userId, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "ConcurrentMissesCoalesce",
        cacheKey: (userId) => userId,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      },
    );

    // When both requests run before either fallback can populate the cache.
    const inflight = dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    // Then the active cache miss single-flights so only one fallback populates the cache.
    expect(results).toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 1 },
    ]);
    expect(calls).toBe(1);
  });

  it("runs every concurrent fallback when all cache layers are disabled", async () => {
    // Given caching is enabled at the context level but the local layer is ramped out.
    const gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(
      async (userId: string) => {
        calls += 1;
        const call = calls;
        await gate.promise;
        return { userId, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "ConcurrentDisabledLayersPassThrough",
        cacheKey: (userId) => userId,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.LOCAL]: 60 },
          ramp: { [CacheLayer.LOCAL]: 0 },
        }),
      },
    );

    // When both requests run before either fallback completes.
    const inflight = dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    // Then disabled cache layers are true pass-through and do not single-flight.
    expect(results).toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 2 },
    ]);
    expect(calls).toBe(2);
  });

  it("keeps delimiter-containing ids and args in distinct local cache keys", async () => {
    // Given two calls would collide if key components were concatenated without escaping.
    const dialcache = new DialCache();
    let calls = 0;
    const search = dialcache.cached(
      async (userId: string, filter?: string) => ({
        userId,
        ...(filter === undefined ? {} : { filter }),
        calls: ++calls,
      }),
      {
        keyType: "user_id",
        useCase: "DelimiterSafeLocalKeys",
        cacheKey: (userId, filter) => ({ id: userId, args: { filter } }),
        defaultConfig: DialCacheKeyConfig.enabled(60),
      },
    );

    // When an id containing a query delimiter is followed by a structurally different key.
    const [first, second, firstAgain, secondAgain] = await dialcache.enable(async () => [
      await search("123?filter=active", undefined),
      await search("123", "active"),
      await search("123?filter=active", undefined),
      await search("123", "active"),
    ]);

    // Then each logical key gets its own cached value instead of sharing a colliding URN.
    expect(first).toEqual({ userId: "123?filter=active", calls: 1 });
    expect(second).toEqual({ userId: "123", filter: "active", calls: 2 });
    expect(firstAgain).toEqual(first);
    expect(secondAgain).toEqual(second);
    expect(calls).toBe(2);
  });

  it("uses sorted explicit args as part of the cache key", async () => {
    // Given a cached function with explicit key args in non-sorted declaration order.
    const dialcache = new DialCache();
    let calls = 0;
    const search = dialcache.cached(async (userId: string, page: number, filter: string) => ({ userId, page, filter, calls: ++calls }), {
      keyType: "user_id",
      useCase: "SearchPosts",
      cacheKey: (userId, page, filter) => ({ id: userId, args: { page, filter } }),
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When calls vary by explicit args.
    const results = await dialcache.enable(async () => [
      await search("123", 1, "active"),
      await search("123", 1, "active"),
      await search("123", 2, "active"),
      await search("123", 1, "archived"),
    ]);

    // Then only identical explicit args share the same cached value.
    expect(results).toEqual([
      { userId: "123", page: 1, filter: "active", calls: 1 },
      { userId: "123", page: 1, filter: "active", calls: 1 },
      { userId: "123", page: 2, filter: "active", calls: 2 },
      { userId: "123", page: 1, filter: "archived", calls: 3 },
    ]);
    expect(calls).toBe(3);
  });

  it("expires local cache entries after their ttl", async () => {
    // Given a cached function with a one second local TTL.
    let nowMs = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalTtlExpiration",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 1 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    // When the same key is called before and after TTL expiration.
    const first = await dialcache.enable(async () => await getUser("123"));
    nowMs += 999;
    const beforeTtl = await dialcache.enable(async () => await getUser("123"));
    nowMs += 1;
    const afterTtl = await dialcache.enable(async () => await getUser("123"));

    // Then the cached value is reused before TTL and refreshed after TTL.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(beforeTtl).toEqual({ userId: "123", calls: 1 });
    expect(afterTtl).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("checks local ttl from an epoch-zero monotonic clock before the timers phase", async () => {
    // Given a cached value whose monotonic TTL clock starts at zero and has
    // been read without yielding to timers.
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalTtlSameTurnExpiration",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 1 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    // When monotonic time reaches the TTL boundary without running scheduled timers.
    const first = await dialcache.enable(async () => await getUser("123"));
    nowMs = 1_000;
    const afterTtl = await dialcache.enable(async () => await getUser("123"));

    // Then the current clock is authoritative and the stale entry is not returned.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(afterTtl).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("fails open when key construction fails", async () => {
    // Given a cached function whose key builder throws.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ logger });
    let calls = 0;
    const getUser = dialcache.cached(async () => ({ calls: ++calls }), {
      keyType: "user_id",
      useCase: "KeyConstructionFailure",
      cacheKey: () => ({
        id: {
          toString() {
            throw new Error("bad id");
          },
        } as unknown as string,
      }),
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the cached function is called in an enabled scope.
    const first = await dialcache.enable(async () => await getUser());
    const second = await dialcache.enable(async () => await getUser());

    // Then the fallback still succeeds and no value is cached.
    expect(first).toEqual({ calls: 1 });
    expect(second).toEqual({ calls: 2 });
    expect(logger.error).toHaveBeenCalledWith("Could not construct DialCache key", expect.any(Error));
  });

  it("fails open when an explicit cacheKey selector throws", async () => {
    // Given a cached function whose cacheKey selector throws before a cache key can be built.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "CacheKeySelectorFailure",
      cacheKey: () => {
        throw new Error("bad selector");
      },
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the cached function is called in an enabled scope.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the fallback still succeeds and no value is cached.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.error).toHaveBeenCalledWith("Could not construct DialCache key", expect.any(Error));
  });

  it("restores async context after scope failures", async () => {
    // Given nested cache scopes can throw application errors.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ScopeFailureRestore",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When an enabled scope and an inner disabled scope fail.
    await expect(
      dialcache.enable(async () => {
        expect(dialcache.isEnabled()).toBe(true);
        await expect(
          dialcache.disable(async () => {
            expect(dialcache.isEnabled()).toBe(false);
            throw new Error("inner failed");
          }),
        ).rejects.toThrow("inner failed");
        expect(dialcache.isEnabled()).toBe(true);
        throw new Error("outer failed");
      }),
    ).rejects.toThrow("outer failed");

    // Then the context is restored outside the failed scopes and default-disabled behavior remains intact.
    expect(dialcache.isEnabled()).toBe(false);
    const first = await getUser("123");
    const second = await getUser("123");
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
  });

  it("fails open when local cache writes fail", async () => {
    // Given the local cache write path throws unexpectedly after fallback succeeds.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ logger });
    const localCache = (dialcache as unknown as {
      readonly localCache: {
        put: (key: DialCacheKey, value: unknown, config?: { readonly ttlSec: number }) => Promise<void>;
      };
    }).localCache;
    vi.spyOn(localCache, "put").mockRejectedValueOnce(new Error("local write failed"));
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalWriteFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the first local write fails and later calls retry normal cache behavior.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));
    const third = await dialcache.enable(async () => await getUser("123"));

    // Then the write failure does not escape, and subsequent calls can still populate/read local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(third).toEqual({ userId: "123", calls: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in local cache", expect.any(Error));
  });

  it("fails open when an active local cache read throws", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ logger });
    const localCache = (dialcache as unknown as {
      readonly localCache: {
        getWithResolvedConfig: (key: DialCacheKey, config: { readonly ttlSec: number; readonly ramp: number }) => unknown;
      };
    }).localCache;
    vi.spyOn(localCache, "getWithResolvedConfig").mockImplementationOnce(() => {
      throw new Error("local read failed");
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalReadFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));
    const third = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(third).toBe(second);
    expect(logger.error).toHaveBeenCalledWith("Error getting value from local cache", expect.any(Error));
  });

  it("falls through when local cache config is missing", async () => {
    // Given a cached function without any key config.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "MissingConfigFailure",
      cacheKey: (userId) => userId,
    });

    // When the cached function is called in an enabled scope.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the local layer is disabled and fallback still succeeds without treating missing config as an error.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rejects duplicate and reserved use cases", () => {
    // Given a DialCache instance with one registered use case.
    const dialcache = new DialCache();
    dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "UniqueUseCase",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When another function registers the same use case or the reserved watermark use case.
    const duplicate = () =>
      dialcache.cached(async (userId: string) => userId, {
        keyType: "user_id",
        useCase: "UniqueUseCase",
        cacheKey: (userId) => userId,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      });
    const reserved = () =>
      dialcache.cached(async (userId: string) => userId, {
        keyType: "user_id",
        useCase: "watermark",
        cacheKey: (userId) => userId,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      });

    // Then DialCache rejects both registrations.
    expect(duplicate).toThrow(UseCaseIsAlreadyRegisteredError);
    expect(reserved).toThrow(UseCaseNameIsReservedError);
  });

  it("supports withEnabled and withDisabled aliases", async () => {
    // Given a cached function and the readability aliases.
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "AliasScopes",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When withEnabled and withDisabled are nested.
    const result = await dialcache.withEnabled(async () => {
      const first = await getUser("123");
      const disabled = await dialcache.withDisabled(async () => await getUser("123"));
      const after = await getUser("123");
      return { first, disabled, after };
    });

    // Then they behave like enable and disable.
    expect(result).toEqual({
      first: { userId: "123", calls: 1 },
      disabled: { userId: "123", calls: 2 },
      after: { userId: "123", calls: 1 },
    });
  });

  it("treats non-positive local ttl as disabled local config", async () => {
    // Given a cached function with an invalid local TTL.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "InvalidLocalTtl",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    // When the function is called in an enabled scope.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the local cache is bypassed and the fallback still succeeds.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("evicts the least recently used local entry when max size is exceeded", async () => {
    // Given a local cache with room for two entries.
    const dialcache = new DialCache({ localMaxSize: 2 });
    const calls = new Map<string, number>();
    const getUser = dialcache.cached(async (userId: string) => {
      const call = (calls.get(userId) ?? 0) + 1;
      calls.set(userId, call);
      return { userId, call };
    }, {
      keyType: "user_id",
      useCase: "LocalMaxSizeEviction",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When a hit refreshes one entry's recency before a third key is inserted.
    await dialcache.enable(async () => {
      await getUser("123");
      await getUser("456");
      await getUser("123");
      await getUser("789");
      await getUser("456");
    });

    // Then the recently read key survives while the least recently used key refreshes.
    expect(calls.get("123")).toBe(1);
    expect(calls.get("456")).toBe(2);
    expect(calls.get("789")).toBe(1);
  });

  it("applies localMaxSize across all use cases", async () => {
    // Given two use cases sharing one DialCache instance with a one-entry local limit.
    const dialcache = new DialCache({ localMaxSize: 1 });
    let userCalls = 0;
    let postCalls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++userCalls }), {
      keyType: "user_id",
      useCase: "GlobalLimitUser",
      cacheKey: (id) => id,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });
    const getPost = dialcache.cached(async (id: string) => ({ id, call: ++postCalls }), {
      keyType: "post_id",
      useCase: "GlobalLimitPost",
      cacheKey: (id) => id,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the second use case fills the single global slot and the first key is requested again.
    await dialcache.enable(async () => {
      await getUser("123");
      await getPost("456");
      await getUser("123");
    });

    // Then the limit is global rather than independently applied to each use case.
    expect(userCalls).toBe(2);
    expect(postCalls).toBe(1);
  });

  it("caches undefined local values", async () => {
    // Given a valid cached function whose result is undefined.
    const dialcache = new DialCache();
    let calls = 0;
    const getOptional = dialcache.cached(async (id: string) => {
      calls += 1;
      return undefined;
    }, {
      keyType: "optional_id",
      useCase: "UndefinedLocalValue",
      cacheKey: (id) => id,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the same key is read twice inside an enabled scope.
    await dialcache.enable(async () => {
      await getOptional("123");
      await getOptional("123");
    });

    // Then the entry wrapper distinguishes the cached undefined from a miss.
    expect(calls).toBe(1);
  });

  it("allows localMaxSize zero to disable local storage", async () => {
    // Given an explicit zero-entry local cache limit.
    const dialcache = new DialCache({ localMaxSize: 0 });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "DisabledLocalStorage",
      cacheKey: (id) => id,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the same key is read repeatedly.
    await dialcache.enable(async () => {
      await getUser("123");
      await getUser("123");
    });

    // Then local storage stays disabled, matching the prior zero-size behavior.
    expect(calls).toBe(2);
  });

  it("constructs large local entry caps without eager allocation", () => {
    expect(() => new DialCache({ localMaxSize: 2 ** 32 })).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid localMaxSize value %s",
    (localMaxSize) => {
      expect(() => new DialCache({ localMaxSize })).toThrow(
        new RangeError("DialCache localMaxSize must be a nonnegative safe integer"),
      );
    },
  );

  it("round-trips values through the JSON serializer", async () => {
    // Given the default JSON serializer.
    const serializer = new JsonSerializer<{ id: string; enabled: boolean }>();

    // When a value is dumped and loaded from both string and Buffer payloads.
    const dumped = await serializer.dump({ id: "123", enabled: true });
    const loadedFromString = await serializer.load(dumped);
    const loadedFromBuffer = await serializer.load(Buffer.from(dumped));

    // Then the serializer preserves the JSON-safe value.
    expect(loadedFromString).toEqual({ id: "123", enabled: true });
    expect(loadedFromBuffer).toEqual({ id: "123", enabled: true });
  });

  it("round-trips undefined through the JSON serializer", async () => {
    // Given the default JSON serializer receives a fallback result that JSON.stringify would normally drop.
    const serializer = new JsonSerializer<undefined>();

    // When undefined is dumped and loaded from both string and Buffer payloads.
    const dumped = await serializer.dump(undefined);
    const loadedFromString = await serializer.load(dumped);
    const loadedFromBuffer = await serializer.load(Buffer.from(dumped));

    // Then undefined is a supported cached value instead of an invalid JSON payload.
    expect(loadedFromString).toBeUndefined();
    expect(loadedFromBuffer).toBeUndefined();
  });

  it("keeps native lossy JSON semantics without an extra validation pass", async () => {
    const serializer = new JsonSerializer<unknown>();
    const value = {
      updatedAt: new Date("2026-07-17T12:00:00.000Z"),
      missing: undefined,
      nonFinite: Number.POSITIVE_INFINITY,
    };

    const dumped = await serializer.dump(value);
    const loaded = await serializer.load(dumped);

    expect(loaded).toEqual({
      updatedAt: "2026-07-17T12:00:00.000Z",
      nonFinite: null,
    });
  });

  it("rejects unsupported top-level values in the JSON serializer", async () => {
    // Given values where JSON.stringify returns undefined instead of a payload.
    const serializer = new JsonSerializer<unknown>();

    // When dumping them, then the serializer rejects instead of storing an unusable Redis payload.
    await expect(serializer.dump(Symbol("unsupported"))).rejects.toThrow("DialCache JSON serializer cannot serialize this value");
    await expect(serializer.dump(() => undefined)).rejects.toThrow("DialCache JSON serializer cannot serialize this value");
  });

  it("builds stable human-readable URNs for simple components", () => {
    // Given cache args that are not already sorted.
    const key = new DialCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "GetPosts",
      args: [
        ["filter", "active"],
        ["page", "2"],
      ],
    });

    // When the key is rendered.
    const rendered = key.toString();

    // Then it keeps the structured key format used for debugging and grouping.
    expect(rendered).toBe("urn:user_id:123?filter=active&page=2#GetPosts");
  });

  it("keeps delimiter-containing URN components and args distinct", () => {
    // Given keys whose raw components would collide without escaping delimiter characters.
    const prefixWithDelimiter = new DialCacheKey({ keyType: "user_id", id: "123", useCase: "GetPosts", urnPrefix: "urn:dialcache" });
    const argValueWithDelimiter = new DialCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "GetPosts",
      args: [["filter", "active&page=2"]],
    });
    const splitArgs = new DialCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "GetPosts",
      args: [
        ["filter", "active"],
        ["page", "2"],
      ],
    });
    const argValueWithFragment = new DialCacheKey({ keyType: "user_id", id: "123", useCase: "GetPosts", args: [["filter", "active#Other"]] });
    const useCaseWithFragment = new DialCacheKey({ keyType: "user_id", id: "123", useCase: "Other", args: [["filter", "active"]] });

    // When the keys are rendered.
    // Then delimiter-bearing components are encoded, while simple components remain readable.
    expect(prefixWithDelimiter.toString()).toBe("urn%3Adialcache:user_id:123#GetPosts");
    expect(argValueWithDelimiter.toString()).not.toBe(splitArgs.toString());
    expect(argValueWithDelimiter.toString()).toContain("filter=active%26page%3D2");
    expect(argValueWithFragment.toString()).not.toBe(useCaseWithFragment.toString());
    expect(argValueWithFragment.toString()).toContain("filter=active%23Other#GetPosts");
  });
});
