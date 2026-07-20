import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheError,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  type CachedOptions,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const localConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.LOCAL]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100 },
});

const remoteConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

function metricsWithError(
  error: DialCacheMetricsAdapter["error"],
  observeFallback: DialCacheMetricsAdapter["observeFallback"] = vi.fn(),
): DialCacheMetricsAdapter {
  return {
    request: vi.fn(),
    miss: vi.fn(),
    disabled: vi.fn(),
    error,
    invalidation: vi.fn(),
    observeGet: vi.fn(),
    observeFallback,
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
}

function useFakeTimersWithMonotonicClock(): void {
  vi.useFakeTimers();
  const clockOriginMs = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - clockOriginMs);
}

describe("DialCache fallback liveness", () => {
  beforeEach(() => {
    useFakeTimersWithMonotonicClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defaults to 60 seconds and shares the leader deadline with process followers", async () => {
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const gate = deferred<{ readonly id: string }>();
    const started = deferred<void>();
    const error = vi.fn<DialCacheMetricsAdapter["error"]>();
    const observeFallback = vi.fn<DialCacheMetricsAdapter["observeFallback"]>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache({ metrics: metricsWithError(error, observeFallback) });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      calls += 1;
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "user_id",
      useCase: "DefaultFallbackDeadline",
      cacheKey: (id) => id,
      defaultConfig: localConfig,
    });

    const result = dialcache.enable(async () =>
      await Promise.allSettled([getUser("123"), getUser("123"), getUser("123")]),
    );
    await started.promise;

    expect(calls).toBe(1);
    expect(dialcache.getCoalescingState().process).toMatchObject({
      activeLeaders: 1,
      activeFollowers: 2,
    });
    expect(dialcache.getCoalescingState().process.oldestLeaderAgeMs).toBeGreaterThanOrEqual(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    nowMs = 59_999;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(1);
    const settled = await result;
    expect(settled).toHaveLength(3);
    const reasons = settled.map((entry) => entry.status === "rejected" ? entry.reason : undefined);
    expect(reasons[0]).toBeInstanceOf(FallbackTimeoutError);
    expect(reasons[1]).toBe(reasons[0]);
    expect(reasons[2]).toBe(reasons[0]);
    expect(reasons[0]).toMatchObject({
      useCase: "DefaultFallbackDeadline",
      timeoutMs: 60_000,
    });
    expect(reasons[0]).toBeInstanceOf(DialCacheError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "DefaultFallbackDeadline",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
      error: "fallback",
      inFallback: true,
    });
    expect(observeFallback).toHaveBeenCalledTimes(1);
    expect(observeFallback).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "DefaultFallbackDeadline",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
    }, 60);
    expect(dialcache.getCoalescingState().process).toEqual({
      activeLeaders: 0,
      activeFollowers: 0,
      oldestLeaderAgeMs: null,
    });

    gate.resolve({ id: "late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(observeFallback).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending fallback deadline referenced", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "ReferencedFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10_000,
      defaultConfig: localConfig,
    });

    const result = dialcache.enable(async () => await load());
    await started.promise;

    const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout | undefined;
    expect(timer?.hasRef()).toBe(true);

    gate.resolve("value");
    await expect(result).resolves.toBe("value");
  });

  it("uses a caller-selected timeout on enabled pass-through calls", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "PassThroughFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 25,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    await vi.advanceTimersByTimeAsync(24);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const [settled] = await result;
    expect(settled).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
    expect(settled?.status === "rejected" ? settled.reason.timeoutMs : undefined).toBe(25);
  });

  it("gives a late follower only the leader's remaining budget", async () => {
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const started = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => {
      calls += 1;
      started.resolve();
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "FollowerInheritsDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 1_000,
      defaultConfig: localConfig,
    });

    const leader = dialcache.enable(async () => await load());
    await started.promise;
    nowMs = 900;
    await vi.advanceTimersByTimeAsync(900);
    const follower = dialcache.enable(async () => await load());
    await vi.advanceTimersByTimeAsync(0);
    const result = Promise.allSettled([leader, follower]);

    expect(calls).toBe(1);
    expect(dialcache.getCoalescingState().process.activeFollowers).toBe(1);
    nowMs = 999;
    await vi.advanceTimersByTimeAsync(99);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    nowMs = 1_000;
    await vi.advanceTimersByTimeAsync(1);
    const settled = await result;
    expect(
      settled.every((entry) => entry.status === "rejected" && entry.reason instanceof FallbackTimeoutError),
    ).toBe(true);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("shares one deadline across request-local followers and permits a same-scope retry", async () => {
    const firstStarted = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return await new Promise<string>(() => undefined);
      }
      return "retry";
    }, {
      keyType: "id",
      useCase: "RequestLocalFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const result = dialcache.enable(async () => {
      const settled = await Promise.allSettled([load(), load(), load()]);
      const retry = await load();
      return { settled, retry };
    });
    await firstStarted.promise;
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);

    await vi.advanceTimersByTimeAsync(10);
    const { settled, retry } = await result;
    const reasons = settled.map((entry) => entry.status === "rejected" ? entry.reason : undefined);
    expect(calls).toBe(2);
    expect(reasons[0]).toBeInstanceOf(FallbackTimeoutError);
    expect(reasons[1]).toBe(reasons[0]);
    expect(reasons[2]).toBe(reasons[0]);
    expect(retry).toBe("retry");
  });

  it("counts synchronous pre-await fallback work against the deadline", async () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      nowMs += 11;
      return "late";
    }, {
      keyType: "id",
      useCase: "SynchronousFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: localConfig,
    });

    await expect(dialcache.enable(async () => await load())).rejects.toMatchObject({
      useCase: "SynchronousFallbackDeadline",
      timeoutMs: 10,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks the monotonic deadline when a timer fires early", async () => {
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const fakeSetTimeout = globalThis.setTimeout;
    let scheduledTimers = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      scheduledTimers += 1;
      const adjustedDelay = scheduledTimers === 1 ? Math.max((delay ?? 0) - 1, 0) : delay;
      return fakeSetTimeout(callback, adjustedDelay, ...args);
    }) as typeof setTimeout);
    const started = deferred<void>();
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "EarlyFallbackTimer",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: localConfig,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    nowMs = 9;
    await vi.advanceTimersByTimeAsync(9);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    nowMs = 10;
    await vi.advanceTimersByTimeAsync(1);
    expect((await result)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
  });

  it("rejects an async result that settles after its monotonic deadline before the timer callback", async () => {
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const gate = deferred<string>();
    const started = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        return await gate.promise;
      }
      return "fresh";
    }, {
      keyType: "id",
      useCase: "DelayedFallbackTimer",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: localConfig,
    });

    const first = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    nowMs = 10;
    gate.resolve("overdue");
    await vi.advanceTimersByTimeAsync(0);

    expect((await first)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
    expect(vi.getTimerCount()).toBe(0);
    await expect(dialcache.enable(async () => await load())).resolves.toBe("fresh");
    expect(calls).toBe(2);
  });

  it("times out fallback after cache-key construction fails", async () => {
    const started = deferred<void>();
    const dialcache = new DialCache({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } });
    const load = dialcache.cached(async () => {
      started.resolve();
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "KeyFailureFallbackDeadline",
      cacheKey: () => {
        throw new Error("invalid key");
      },
      fallbackTimeoutMs: 5,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    await vi.advanceTimersByTimeAsync(5);
    expect((await result)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
  });

  it("times out fallback after runtime config resolution fails", async () => {
    const started = deferred<void>();
    const dialcache = new DialCache({
      cacheConfigProvider: async () => {
        throw new Error("config unavailable");
      },
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });
    const load = dialcache.cached(async () => {
      started.resolve();
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "ConfigFailureFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    await vi.advanceTimersByTimeAsync(5);
    expect((await result)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
  });

  it("times out detached fallback after config resolves outside its closed enabled scope", async () => {
    const configGate = deferred<DialCacheKeyConfig>();
    const started = deferred<void>();
    const dialcache = new DialCache({ cacheConfigProvider: async () => await configGate.promise });
    const load = dialcache.cached(async () => {
      started.resolve();
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "DetachedFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
    });
    let detached!: Promise<string>;

    await dialcache.enable(() => {
      detached = load();
    });
    configGate.resolve(localConfig);
    await started.promise;
    const result = Promise.allSettled([detached]);
    await vi.advanceTimersByTimeAsync(5);

    expect((await result)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
  });

  it("does not start the fallback deadline while the config provider is pending", async () => {
    const configGate = deferred<DialCacheKeyConfig>();
    const configStarted = deferred<void>();
    const fallback = vi.fn(async () => "value");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache({
      cacheConfigProvider: async () => {
        configStarted.resolve();
        return await configGate.promise;
      },
    });
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "PendingConfigHasCallerOwnedDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
    });

    const result = dialcache.enable(async () => await load());
    await configStarted.promise;
    await vi.advanceTimersByTimeAsync(100);

    expect(fallback).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);

    configGate.resolve(localConfig);
    await expect(result).resolves.toBe("value");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does not start the fallback deadline while the ramp sampler is pending", async () => {
    const rampGate = deferred<number>();
    const rampStarted = deferred<void>();
    const fallback = vi.fn(async () => "value");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache({
      rampSampler: async () => {
        rampStarted.resolve();
        return await rampGate.promise;
      },
    });
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "PendingRampHasCallerOwnedDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 50 },
      }),
    });

    const result = dialcache.enable(async () => await load());
    await rampStarted.promise;
    await vi.advanceTimersByTimeAsync(100);

    expect(fallback).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);

    rampGate.resolve(0);
    await expect(result).resolves.toBe("value");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does not apply the fallback deadline to a pending Redis read", async () => {
    const readGate = deferred<null>();
    const readStarted = deferred<void>();
    const fallback = vi.fn(async () => "value");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const redis: DialCacheRedisClient = {
      read: async () => {
        readStarted.resolve();
        return await readGate.promise;
      },
      write: async () => true,
      invalidate: async () => undefined,
    };
    const dialcache = new DialCache({ redis: { client: redis } });
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "PendingRedisReadHasCallerOwnedDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
      defaultConfig: remoteConfig,
    });

    const result = dialcache.enable(async () => await load());
    await readStarted.promise;
    await vi.advanceTimersByTimeAsync(100);

    expect(fallback).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    readGate.resolve(null);
    await expect(result).resolves.toBe("value");
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("does not apply the fallback deadline to a pending serializer load", async () => {
    const loadGate = deferred<string>();
    const loadStarted = deferred<void>();
    const fallback = vi.fn(async () => "fallback");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const serializer: Serializer<string> = {
      dump: (value) => value,
      load: async () => {
        loadStarted.resolve();
        return await loadGate.promise;
      },
    };
    const redis: DialCacheRedisClient = {
      read: async () => "stored",
      write: async () => true,
      invalidate: async () => undefined,
    };
    const dialcache = new DialCache({ redis: { client: redis } });
    const load = dialcache.cached(async () => await fallback(), {
      keyType: "id",
      useCase: "PendingSerializerLoadHasCallerOwnedDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
      defaultConfig: remoteConfig,
      serializer,
    });

    const result = dialcache.enable(async () => await load());
    await loadStarted.promise;
    await vi.advanceTimersByTimeAsync(100);

    expect(fallback).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    loadGate.resolve("cached");
    await expect(result).resolves.toBe("cached");
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("does not apply a completed fallback's deadline to serializer dump or Redis write", async () => {
    const dumpGate = deferred<string>();
    const dumpStarted = deferred<void>();
    const writeGate = deferred<boolean>();
    const writeStarted = deferred<void>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const serializer: Serializer<string> = {
      dump: async () => {
        dumpStarted.resolve();
        return await dumpGate.promise;
      },
      load: (value) => value.toString(),
    };
    const redis: DialCacheRedisClient = {
      read: async () => null,
      write: async () => {
        writeStarted.resolve();
        return await writeGate.promise;
      },
      invalidate: async () => undefined,
    };
    const dialcache = new DialCache({ redis: { client: redis } });
    const load = dialcache.cached(async () => "value", {
      keyType: "id",
      useCase: "PendingPublicationHasCallerOwnedDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 5,
      defaultConfig: remoteConfig,
      serializer,
    });

    let settled = false;
    const result = dialcache.enable(async () => await load());
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await dumpStarted.promise;
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    dumpGate.resolve("value");
    await writeStarted.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    writeGate.resolve(true);
    await expect(result).resolves.toBe("value");
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("keeps initially disabled calls as true pass-through", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "DisabledContextHasNoDeadline",
      cacheKey: () => {
        throw new Error("cacheKey must not run");
      },
      fallbackTimeoutMs: 1,
      defaultConfig: localConfig,
    });

    const result = load();
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    gate.resolve("value");
    await expect(result).resolves.toBe("value");
  });

  it("allows the fallback deadline to be explicitly disabled", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "DisabledFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: null,
      defaultConfig: localConfig,
    });

    const result = dialcache.enable(async () => await load());
    await started.promise;
    await vi.advanceTimersByTimeAsync(60_001);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);
    gate.resolve("value");
    await expect(result).resolves.toBe("value");
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("clears a successful fallback timer and creates no timer on a cache hit", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => ++calls, {
      keyType: "id",
      useCase: "FallbackTimerCleanup",
      cacheKey: () => "123",
      fallbackTimeoutMs: 1_000,
      defaultConfig: localConfig,
    });

    await expect(dialcache.enable(async () => await load())).resolves.toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await expect(dialcache.enable(async () => await load())).resolves.toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("does not publish a fallback result that resolves after its deadline", async () => {
    const firstGate = deferred<{ readonly id: string; readonly version: number }>();
    const firstStarted = deferred<void>();
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return await firstGate.promise;
      }
      return { id, version: 2 };
    }, {
      keyType: "user_id",
      useCase: "IgnoreLateFallbackResult",
      cacheKey: (id) => id,
      fallbackTimeoutMs: 10,
      defaultConfig: remoteConfig,
    });

    const first = Promise.allSettled([dialcache.enable(async () => await getUser("123"))]);
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect((await first)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
    expect(redis.setCalls).toBe(0);

    await expect(dialcache.enable(async () => await getUser("123"))).resolves.toEqual({ id: "123", version: 2 });
    expect(redis.setCalls).toBe(1);

    firstGate.resolve({ id: "123", version: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.setCalls).toBe(1);
    await expect(dialcache.enable(async () => await getUser("123"))).resolves.toEqual({ id: "123", version: 2 });
    expect(calls).toBe(2);
  });

  it("consumes a late fallback rejection without recording a second error", async () => {
    const gate = deferred<string>();
    const started = deferred<void>();
    const error = vi.fn<DialCacheMetricsAdapter["error"]>();
    const dialcache = new DialCache({ metrics: metricsWithError(error) });
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "IgnoreLateFallbackError",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: localConfig,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(error).toHaveBeenCalledTimes(1);

    gate.reject(new Error("late source failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid fallbackTimeoutMs value %s without reserving the use case",
    (fallbackTimeoutMs) => {
      const dialcache = new DialCache();
      const options: CachedOptions<() => Promise<string>> = {
        keyType: "id",
        useCase: "InvalidFallbackDeadline",
        cacheKey: () => "123",
        fallbackTimeoutMs,
      };

      expect(() => dialcache.cached(async () => "value", options)).toThrow(
        new RangeError(
          "DialCache fallbackTimeoutMs must be null or a positive safe integer no greater than 2147483647",
        ),
      );
      expect(() => dialcache.cached(async () => "value", { ...options, fallbackTimeoutMs: 1 })).not.toThrow();
    },
  );

  it("rejects nonnumeric fallbackTimeoutMs from untyped callers", () => {
    const dialcache = new DialCache();
    const options = {
      keyType: "id",
      useCase: "UntypedFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: "1000",
    } as unknown as CachedOptions<() => Promise<string>>;

    expect(() => dialcache.cached(async () => "value", options)).toThrow(RangeError);
  });
});

describe("DialCache coalescing state", () => {
  beforeEach(() => {
    useFakeTimersWithMonotonicClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers a process leader before its synchronous fallback prefix runs", async () => {
    const dialcache = new DialCache();
    let observedState = dialcache.getCoalescingState().process;
    const load = dialcache.cached(async () => {
      observedState = dialcache.getCoalescingState().process;
      return "value";
    }, {
      keyType: "id",
      useCase: "ObserveSynchronousLeaderPrefix",
      cacheKey: () => "123",
      defaultConfig: localConfig,
    });

    await expect(dialcache.enable(async () => await load())).resolves.toBe("value");
    expect(observedState).toMatchObject({ activeLeaders: 1, activeFollowers: 0 });
    expect(observedState.oldestLeaderAgeMs).toBeGreaterThanOrEqual(0);
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });
  });

  it("reports leaders, followers, oldest age, and settlement cleanup", async () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const dialcache = new DialCache();
    const load = dialcache.cached(async (id: string) => {
      if (id === "first") {
        nowMs += 25;
        firstStarted.resolve();
        return await firstGate.promise;
      }
      secondStarted.resolve();
      return await secondGate.promise;
    }, {
      keyType: "id",
      useCase: "InspectProcessFlights",
      cacheKey: (id) => id,
      defaultConfig: localConfig,
    });

    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });

    const firstLeader = dialcache.enable(async () => await load("first"));
    const firstFollower = dialcache.enable(async () => await load("first"));
    const additionalFirstFollower = dialcache.enable(async () => await load("first"));
    await firstStarted.promise;
    nowMs = 1_040;
    const secondLeader = dialcache.enable(async () => await load("second"));
    const secondFollower = dialcache.enable(async () => await load("second"));
    await secondStarted.promise;
    nowMs = 1_100;

    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 2, activeFollowers: 3, oldestLeaderAgeMs: 100 },
    });

    firstGate.resolve("first-value");
    await expect(Promise.all([firstLeader, firstFollower, additionalFirstFollower])).resolves.toEqual([
      "first-value",
      "first-value",
      "first-value",
    ]);
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 1, activeFollowers: 1, oldestLeaderAgeMs: 60 },
    });

    secondGate.reject(new Error("second failed"));
    const secondResults = await Promise.allSettled([secondLeader, secondFollower]);
    expect(secondResults).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "second failed" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "second failed" }) },
    ]);
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });
  });

  it("keeps process state isolated by instance and excludes request-local-only work", async () => {
    const processGate = deferred<string>();
    const processStarted = deferred<void>();
    const requestGate = deferred<string>();
    const requestStarted = deferred<void>();
    const first = new DialCache();
    const second = new DialCache();
    const processLoad = first.cached(async () => {
      processStarted.resolve();
      return await processGate.promise;
    }, {
      keyType: "id",
      useCase: "InstanceProcessState",
      cacheKey: () => "123",
      defaultConfig: localConfig,
    });
    const requestLoad = second.cached(async () => {
      requestStarted.resolve();
      return await requestGate.promise;
    }, {
      keyType: "id",
      useCase: "RequestLocalStateExcluded",
      cacheKey: () => "123",
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const processResult = first.enable(async () => await processLoad());
    const requestResult = second.enable(async () => await Promise.all([requestLoad(), requestLoad()]));
    await Promise.all([processStarted.promise, requestStarted.promise]);

    expect(first.getCoalescingState().process.activeLeaders).toBe(1);
    expect(second.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });

    processGate.resolve("process");
    requestGate.resolve("request");
    await expect(processResult).resolves.toBe("process");
    await expect(requestResult).resolves.toEqual(["request", "request"]);
  });

  it("releases a burst of unique-key flights at their fallback deadlines", async () => {
    const dialcache = new DialCache();
    let started = 0;
    const allStarted = deferred<void>();
    const load = dialcache.cached(async (id: string) => {
      started += 1;
      if (started === 32) {
        allStarted.resolve();
      }
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "ReleaseUniqueKeyBurst",
      cacheKey: (id) => id,
      fallbackTimeoutMs: 5,
      defaultConfig: localConfig,
    });

    const result = Promise.allSettled(
      Array.from({ length: 32 }, (_, index) => dialcache.enable(async () => await load(String(index)))),
    );
    await allStarted.promise;
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(32);

    await vi.advanceTimersByTimeAsync(5);
    const settled = await result;
    expect(
      settled.every((entry) => entry.status === "rejected" && entry.reason instanceof FallbackTimeoutError),
    ).toBe(true);
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });
  });
});
