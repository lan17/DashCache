import { describe, expect, it, vi } from "vitest";

import { CacheLayer, GCache, GCacheKeyConfig, type GCacheMetricsAdapter, type RedisCommandClient, type RedisStoredValue } from "../src/index.js";

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

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, RedisStoredValue>();
  setCalls = 0;

  async get(key: string): Promise<RedisStoredValue | null> {
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _ttlSec: number, value: RedisStoredValue): Promise<void> {
    this.setCalls += 1;
    this.values.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
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
    const gate = deferred<void>();
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
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
    gate.resolve();
    const results = await inflight;

    expect(calls).toBe(1);
    expect(redis.setCalls).toBe(1);
    expect(results).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
    ]);
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
});
