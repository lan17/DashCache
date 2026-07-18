import { describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig, type DialCacheMetricsAdapter } from "../src/index.js";
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FailingReadRedis extends FakeRedis {
  constructor() {
    super();
    this.failGet = true;
  }
}

function spyMetrics() {
  const coalesced = vi.fn();
  const request = vi.fn();
  const miss = vi.fn();
  const metrics: DialCacheMetricsAdapter = {
    request,
    miss,
    disabled: vi.fn(),
    error: vi.fn(),
    invalidation: vi.fn(),
    coalesced,
    observeGet: vi.fn(),
    observeFallback: vi.fn(),
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
  return { metrics, coalesced, request, miss };
}

describe("DialCache request coalescing", () => {
  it("coalesces concurrent local misses when the local layer is active", async () => {
    const gate = deferred<void>();
    const { metrics, coalesced } = spyMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceLocalMiss",
        cacheKey: (id) => id,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      },
    );

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(1);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
    ]);
    expect(coalesced).toHaveBeenCalledTimes(2);
    expect(coalesced).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "CoalesceLocalMiss",
      keyType: "user_id",
      scope: "process",
    });
  });

  it("coalesces request-local-only work within one request and shares the resolved reference", async () => {
    const gate = deferred<void>();
    const { metrics, coalesced } = spyMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      calls += 1;
      await gate.promise;
      return { id };
    }, {
      keyType: "user_id",
      useCase: "CoalesceRequestLocal",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(coalesced).toHaveBeenCalledTimes(2);
    expect(coalesced).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "CoalesceRequestLocal",
      keyType: "user_id",
      scope: "request_local",
    });
  });

  it("does not coalesce request-local-only work across outer request scopes", async () => {
    const gate = deferred<void>();
    const { metrics, coalesced } = spyMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      const call = ++calls;
      await gate.promise;
      return { id, call };
    }, {
      keyType: "user_id",
      useCase: "IsolateRequestLocalFlights",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const inflight = Promise.all([
      dialcache.enable(async () => await getUser("1")),
      dialcache.enable(async () => await getUser("1")),
    ]);
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(2);
    expect(results).toEqual([
      { id: "1", call: 1 },
      { id: "1", call: 2 },
    ]);
    expect(coalesced).not.toHaveBeenCalled();
  });

  it("does not coalesce shared-layer work across DialCache instances", async () => {
    const gate = deferred<void>();
    const { metrics, coalesced } = spyMetrics();
    const firstCache = new DialCache({ metrics });
    const secondCache = new DialCache({ metrics });
    let firstCalls = 0;
    let secondCalls = 0;
    const firstGetUser = firstCache.cached(async (id: string) => {
      firstCalls += 1;
      await gate.promise;
      return { id, source: "first" };
    }, {
      keyType: "user_id",
      useCase: "IsolateProcessFlightsByInstance",
      cacheKey: (id) => id,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });
    const secondGetUser = secondCache.cached(async (id: string) => {
      secondCalls += 1;
      await gate.promise;
      return { id, source: "second" };
    }, {
      keyType: "user_id",
      useCase: "IsolateProcessFlightsByInstance",
      cacheKey: (id) => id,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    const inflight = Promise.all([
      firstCache.enable(async () => await firstGetUser("1")),
      secondCache.enable(async () => await secondGetUser("1")),
    ]);
    await tick();

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);

    gate.resolve();
    const results = await inflight;

    expect(results).toEqual([
      { id: "1", source: "first" },
      { id: "1", source: "second" },
    ]);
    expect(coalesced).not.toHaveBeenCalled();
  });

  it("coalesces shared-layer work across requests only after each request-local miss", async () => {
    const gate = deferred<void>();
    const { metrics, coalesced, request, miss } = spyMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      calls += 1;
      await gate.promise;
      return { id };
    }, {
      keyType: "user_id",
      useCase: "RequestThenProcessCoalescing",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        requestLocal: true,
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    const inflight = Promise.all([
      dialcache.enable(async () => await getUser("1")),
      dialcache.enable(async () => await getUser("1")),
    ]);
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(1);
    expect(results[1]).toBe(results[0]);
    expect(coalesced).toHaveBeenCalledTimes(1);
    expect(coalesced).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "RequestThenProcessCoalescing",
      keyType: "user_id",
      scope: "process",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "RequestThenProcessCoalescing",
      keyType: "user_id",
      layer: "request_local",
    });
    expect(request.mock.calls.filter(([labels]) => labels.layer === "request_local")).toHaveLength(2);
    expect(miss).toHaveBeenCalledTimes(3);
    expect(miss).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "RequestThenProcessCoalescing",
      keyType: "user_id",
      layer: "request_local",
    });
    expect(miss.mock.calls.filter(([labels]) => labels.layer === "request_local")).toHaveLength(2);
  });

  it("coalesces concurrent Redis misses when the remote layer is active", async () => {
    const redisGate = deferred<void>();
    const fallbackGate = deferred<void>();
    const redis = new FakeRedis();
    redis.getGate = redisGate.promise;
    const dialcache = new DialCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        await fallbackGate.promise;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceRemoteMiss",
        cacheKey: (id) => id,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
        }),
      },
    );

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
    await tick();
    expect(redis.getCalls).toBe(1);
    redisGate.resolve();
    await tick();
    fallbackGate.resolve();
    const results = await inflight;

    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(1);
    expect(redis.setCalls).toBe(1);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
    ]);
  });

  it("coalesces concurrent Redis hits when the remote layer is active", async () => {
    const redisGate = deferred<void>();
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceRemoteHit",
        cacheKey: (id) => id,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
        }),
      },
    );

    await dialcache.enable(async () => await getUser("1"));
    calls = 0;
    redis.getCalls = 0;
    redis.getGate = redisGate.promise;

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
    await tick();
    expect(redis.getCalls).toBe(1);
    redisGate.resolve();
    const results = await inflight;

    expect(calls).toBe(0);
    expect(redis.getCalls).toBe(1);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
    ]);
  });

  it("keeps different keys isolated while coalescing concurrent misses", async () => {
    const gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        const call = calls;
        await gate.promise;
        return { id, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceDistinctKeys",
        cacheKey: (id) => id,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      },
    );

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("2")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(2);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "2", calls: 2 },
    ]);
  });

  it("clears in-flight state after a coalesced fallback rejects", async () => {
    let gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        const call = calls;
        await gate.promise;
        return { id, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceRejectCleanup",
        cacheKey: (id) => id,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      },
    );

    const rejected = await dialcache.enable(async () => {
      const first = getUser("1");
      const second = getUser("1");
      await tick();
      gate.reject(new Error("database failed"));
      return await Promise.allSettled([first, second]);
    });

    expect(calls).toBe(1);
    expect(rejected).toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
    for (const result of rejected) {
      expect(result.status === "rejected" ? result.reason.message : undefined).toBe("database failed");
    }

    gate = deferred();
    const retry = dialcache.enable(async () => {
      const value = getUser("1");
      await tick();
      gate.resolve();
      return await value;
    });

    await expect(retry).resolves.toEqual({ id: "1", calls: 2 });
    expect(calls).toBe(2);
  });

  it("does not coalesce outside an enabled context", async () => {
    const gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        const call = calls;
        await gate.promise;
        return { id, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "NoCoalesceDisabledContext",
        cacheKey: (id) => id,
        defaultConfig: DialCacheKeyConfig.enabled(60),
      },
    );

    const inflight = Promise.all([getUser("1"), getUser("1")]);
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(2);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 2 },
    ]);
  });

  it("does not coalesce or touch Redis when configured layers are ramped out", async () => {
    const gate = deferred<void>();
    const redis = new FakeRedis();
    const { metrics, coalesced } = spyMetrics();
    const dialcache = new DialCache({ redis: { client: redis }, metrics });
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        const call = ++calls;
        await gate.promise;
        return { id, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "NoCoalesceRampedOut",
        cacheKey: (id) => id,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 0 },
        }),
      },
    );

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("1")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(2);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 2 },
    ]);
    expect(coalesced).not.toHaveBeenCalled();
    expect(redis.getCalls).toBe(0);
    expect(redis.mGetCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it("coalesces Redis read failures after the remote layer is active", async () => {
    const gate = deferred<void>();
    const redis = new FailingReadRedis();
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = dialcache.cached(
      async (id: string) => {
        calls += 1;
        const call = calls;
        await gate.promise;
        return { id, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceRemoteFailOpen",
        cacheKey: (id) => id,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
        }),
      },
    );

    const inflight = dialcache.enable(async () => await Promise.all([getUser("1"), getUser("1")]));
    await tick();
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(1);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
    ]);
  });
});
