import { describe, expect, it, vi } from "vitest";

import { CacheLayer, GCache, GCacheKeyConfig, type GCacheMetricsAdapter, type RedisCommandClient, type RedisStoredValue } from "../src/index.js";

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

// Crossing a macrotask boundary drains every pending microtask, so all concurrent
// callers reach the single-flight map and the leader is parked in its fallback.
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
  const observeFallback = vi.fn();
  const metrics: GCacheMetricsAdapter = {
    request: vi.fn(),
    miss: vi.fn(),
    disabled: vi.fn(),
    error: vi.fn(),
    invalidation: vi.fn(),
    coalesced,
    observeGet: vi.fn(),
    observeFallback,
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
  return { metrics, coalesced, observeFallback };
}

const remoteOnly = new GCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 60 }, ramp: { [CacheLayer.REMOTE]: 100 } });
const disabledLayers = new GCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 }, ramp: { [CacheLayer.LOCAL]: 0 } });

describe("GCache single-flight coalescing", () => {
  it("runs the fallback once for concurrent misses and shares the result (local-only)", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const gcache = new GCache();
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return { id, calls };
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_ConcurrentMisses",
        key: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const settled = await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("1"), getUser("1")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(1);
    expect(settled).toEqual([
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
      { id: "1", calls: 1 },
    ]);
  });

  it("coalesces through the local -> redis -> fallback chain and writes redis once", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return { id };
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_RedisChain",
        key: (id) => id,
        defaultConfig: remoteOnly,
      },
    );

    const settled = await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("1"), getUser("1")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(1);
    expect(redis.setCalls).toBe(1);
    expect(settled).toEqual([{ id: "1" }, { id: "1" }, { id: "1" }]);
  });

  it("propagates a leader rejection to all followers, then clears the entry for retries", async () => {
    let attempt = 0;
    const gate = deferred<void>();
    const gcache = new GCache();
    const getUser = gcache.cached(
      async (id: string) => {
        attempt += 1;
        if (attempt === 1) {
          await gate.promise;
          throw new Error("boom");
        }
        return { id, attempt };
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_LeaderRejects",
        key: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const outcomes = await gcache.enable(async () => {
      const inflight = Promise.all(
        [getUser("1"), getUser("1")].map((p) => p.then(() => "ok", (error) => (error as Error).message)),
      );
      await tick();
      gate.resolve();
      return await inflight;
    });

    // Both followers observe the same single failure.
    expect(outcomes).toEqual(["boom", "boom"]);
    expect(attempt).toBe(1);

    // Entry was cleared on rejection, so a later call re-invokes the fallback.
    const retry = await gcache.enable(() => getUser("1"));
    expect(retry).toEqual({ id: "1", attempt: 2 });
  });

  it("does not coalesce across distinct keys", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const gcache = new GCache();
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return id;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_DistinctKeys",
        key: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const settled = await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("2")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(2);
    expect(settled).toEqual(["1", "2"]);
  });

  it("clears the in-flight entry after settle so a later batch starts fresh", async () => {
    let calls = 0;
    let gate = deferred<void>();
    const gcache = new GCache();
    // Layers disabled (ramp 0): nothing is cached, so coalescing is the only dedup.
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return `${id}:${calls}`;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_FreshAfterSettle",
        key: (id) => id,
        defaultConfig: disabledLayers,
      },
    );

    const runBatch = () =>
      gcache.enable(async () => {
        const inflight = Promise.all([getUser("1"), getUser("1")]);
        await tick();
        gate.resolve();
        return await inflight;
      });

    const first = await runBatch();
    gate = deferred<void>();
    const second = await runBatch();

    expect(calls).toBe(2);
    expect(first).toEqual(["1:1", "1:1"]);
    expect(second).toEqual(["1:2", "1:2"]);
  });

  it("runs every fallback when coalesce is disabled for the use case", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const gcache = new GCache();
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return id;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_DisabledStatic",
        key: (id) => id,
        coalesce: false,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const settled = await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("1"), getUser("1")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(3);
    expect(settled).toEqual(["1", "1", "1"]);
  });

  it("lets the runtime config provider disable coalescing (kill switch overrides the static option)", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const gcache = new GCache({
      cacheConfigProvider: async () =>
        new GCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 }, ramp: { [CacheLayer.LOCAL]: 100 }, coalesce: false }),
    });
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return id;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_RuntimeKillSwitch",
        key: (id) => id,
        coalesce: true,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("1")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(2);
  });

  it("records a coalesced metric per follower and runs the fallback once", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const { metrics, coalesced, observeFallback } = spyMetrics();
    const gcache = new GCache({ metrics });
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return id;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_Metrics",
        key: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("1"), getUser("1")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(1);
    expect(coalesced).toHaveBeenCalledTimes(2);
    expect(coalesced).toHaveBeenCalledWith({ useCase: "Coalesce_Metrics", keyType: "user_id" });
    expect(observeFallback).toHaveBeenCalledTimes(1);
  });

  it("fails open on a redis write error and still shares the value", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const redis: RedisCommandClient = {
      get: async () => null,
      setEx: async () => {
        throw new Error("redis down");
      },
      del: async () => 0,
    };
    const gcache = new GCache({ redis: { client: redis } });
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return id;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_RedisWriteError",
        key: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const settled = await gcache.enable(async () => {
      const inflight = Promise.all([getUser("1"), getUser("1")]);
      await tick();
      gate.resolve();
      return await inflight;
    });

    expect(calls).toBe(1);
    expect(settled).toEqual(["1", "1"]);
  });

  it("does not coalesce when caching is disabled (outside enable)", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const gcache = new GCache();
    const getUser = gcache.cached(
      async (id: string) => {
        calls += 1;
        await gate.promise;
        return id;
      },
      {
        keyType: "user_id",
        useCase: "Coalesce_DisabledContext",
        key: (id) => id,
        defaultConfig: GCacheKeyConfig.enabled(60),
      },
    );

    const inflight = Promise.all([getUser("1"), getUser("1")]);
    await tick();
    gate.resolve();
    const settled = await inflight;

    expect(calls).toBe(2);
    expect(settled).toEqual(["1", "1"]);
  });
});
