import { describe, expect, it, vi } from "vitest";

import { CacheLayer, GCache, GCacheKeyConfig, type GCacheMetricsAdapter } from "../src/index.js";
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
  const metrics: GCacheMetricsAdapter = {
    request: vi.fn(),
    miss: vi.fn(),
    disabled: vi.fn(),
    error: vi.fn(),
    invalidation: vi.fn(),
    coalesced,
    observeGet: vi.fn(),
    observeFallback: vi.fn(),
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
  return { metrics, coalesced };
}

describe("GCache request coalescing", () => {
  it("coalesces concurrent local misses when the local layer is active", async () => {
    const gate = deferred<void>();
    const { metrics, coalesced } = spyMetrics();
    const gcache = new GCache({ metrics });
    let calls = 0;
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceLocalMiss",
        cacheKey: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const inflight = gcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
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
    expect(coalesced).toHaveBeenCalledWith({ useCase: "CoalesceLocalMiss", keyType: "user_id" });
  });

  it("coalesces concurrent Redis misses when the remote layer is active", async () => {
    const redisGate = deferred<void>();
    const fallbackGate = deferred<void>();
    const redis = new FakeRedis();
    redis.getGate = redisGate.promise;
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await fallbackGate.promise;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceRemoteMiss",
        cacheKey: (id) => id,
        defaultConfig: new GCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
        }),
      },
    );

    const inflight = gcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
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
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "CoalesceRemoteHit",
        cacheKey: (id) => id,
        defaultConfig: new GCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
        }),
      },
    );

    await gcache.enable(async () => await getUser("1"));
    calls = 0;
    redis.getCalls = 0;
    redis.getGate = redisGate.promise;

    const inflight = gcache.enable(async () => await Promise.all([getUser("1"), getUser("1"), getUser("1")]));
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
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached(
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
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const inflight = gcache.enable(async () => await Promise.all([getUser("1"), getUser("2")]));
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
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached(
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
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const rejected = await gcache.enable(async () => {
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
    const retry = gcache.enable(async () => {
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
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached(
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
        defaultConfig: GCacheKeyConfig.enabled(60),
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
    const gcache = new GCache({ redis: { client: redis }, metrics });
    let calls = 0;
    const getUser = gcache.cached(
      async (id: string) => {
        const call = ++calls;
        await gate.promise;
        return { id, calls: call };
      },
      {
        keyType: "user_id",
        useCase: "NoCoalesceRampedOut",
        cacheKey: (id) => id,
        defaultConfig: new GCacheKeyConfig({
          ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 0 },
        }),
      },
    );

    const inflight = gcache.enable(async () => await Promise.all([getUser("1"), getUser("1")]));
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
    const gcache = new GCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = gcache.cached(
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
        defaultConfig: new GCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
        }),
      },
    );

    const inflight = gcache.enable(async () => await Promise.all([getUser("1"), getUser("1")]));
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
