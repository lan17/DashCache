import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  GCache,
  GCacheKey,
  GCacheKeyConfig,
  invalidationPrefix,
  redisClusterHashTag,
  type CacheMetricLabels,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type GCacheMetricsAdapter,
  type InvalidationMetricLabels,
  type SerializationMetricLabels,
  type Serializer,
} from "../src/index.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

class RecordingMetrics implements GCacheMetricsAdapter {
  readonly events: Array<{ readonly name: string; readonly labels: Record<string, unknown> }> = [];

  request(labels: CacheMetricLabels): void {
    this.record("request", labels);
  }

  miss(labels: CacheMetricLabels): void {
    this.record("miss", labels);
  }

  disabled(labels: DisabledMetricLabels): void {
    this.record("disabled", labels);
  }

  error(labels: ErrorMetricLabels): void {
    this.record("error", labels);
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.record("invalidation", labels);
  }

  observeGet(labels: CacheMetricLabels): void {
    this.record("get", labels);
  }

  observeFallback(labels: CacheMetricLabels): void {
    this.record("fallback", labels);
  }

  observeSerialization(labels: SerializationMetricLabels): void {
    this.record("serialization", labels);
  }

  observeSize(labels: CacheMetricLabels): void {
    this.record("size", labels);
  }

  private record(name: string, labels: object): void {
    this.events.push({ name, labels: { ...labels } });
  }
}

const remoteOnly = (ttlSec = 60) =>
  new GCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: ttlSec },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const localAndRemote = (ttlSec = 60) => GCacheKeyConfig.enabled(ttlSec);
const valueKey = (useCase: string, args = ""): string => `{urn:user_id:123}${args}#${useCase}:gcache-frame-v1`;
const watermarkKey = "{urn:user_id:123}#watermark";

describe("GCache targeted invalidation watermarks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:00:00.000Z"));
  });

  it("invalidates all tracked use cases sharing a key type and id", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let profileVersion = 1;
    let permissionsVersion = 1;
    const getProfile = gcache.cached(async (userId: string) => ({ userId, profileVersion }), {
      keyType: "user_id",
      useCase: "InvalidateProfile",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });
    const getPermissions = gcache.cached(async (userId: string) => ({ userId, permissionsVersion }), {
      keyType: "user_id",
      useCase: "InvalidatePermissions",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await gcache.enable(async () => {
      await getProfile("123");
      await getPermissions("123");
    });
    profileVersion = 2;
    permissionsVersion = 2;
    await gcache.invalidateRemote("user_id", "123");
    vi.advanceTimersByTime(1);

    const values = await gcache.enable(async () => [await getProfile("123"), await getPermissions("123")]);

    expect(values).toEqual([
      { userId: "123", profileVersion: 2 },
      { userId: "123", permissionsVersion: 2 },
    ]);
    expect(redis.readWatermarkValue(watermarkKey)).toBe(Date.parse("2026-05-12T18:00:00.000Z"));
  });

  it("does not write remote or local cache during a future invalidation window", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "FutureBufferUser",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    });

    await gcache.invalidateRemote("user_id", "123", 1_000);
    vi.advanceTimersByTime(500);
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("rejects a write when invalidation arrives during fallback", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(
      async (userId: string) => {
        calls += 1;
        await gcache.invalidateRemote("user_id", userId, 1_000);
        return { userId, calls };
      },
      {
        keyType: "user_id",
        useCase: "FutureBufferFallbackRace",
        cacheKey: (userId) => userId,
        trackForInvalidation: true,
        defaultConfig: localAndRemote(),
      },
    );

    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("rejects a write when invalidation remains active after slow serialization", async () => {
    const redis = new FakeRedis();
    let signalDumpStarted = (): void => undefined;
    const dumpStarted = new Promise<void>((resolve) => {
      signalDumpStarted = resolve;
    });
    let releaseDump = (): void => undefined;
    const dumpGate = new Promise<void>((resolve) => {
      releaseDump = resolve;
    });
    const serializer: Serializer<{ userId: string; calls: number }> = {
      dump: async (value) => {
        signalDumpStarted();
        await dumpGate;
        return JSON.stringify(value);
      },
      load: async (value) => {
        const payload = Buffer.isBuffer(value) ? value.toString("utf8") : value;
        return JSON.parse(payload) as { userId: string; calls: number };
      },
    };
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "FutureBufferSerializationRace",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
      serializer,
    });

    const pending = gcache.enable(async () => await getUser("123"));
    await dumpStarted;
    await gcache.invalidateRemote("user_id", "123", 1_000);
    vi.advanceTimersByTime(500);
    releaseDump();
    const first = await pending;
    const second = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("blocks a same-millisecond write for a zero-length future buffer", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ZeroBufferBoundary",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await gcache.invalidateRemote("user_id", "123", 0);
    const blocked = await gcache.enable(async () => await getUser("123"));
    vi.advanceTimersByTime(1);
    const written = await gcache.enable(async () => await getUser("123"));
    const cached = await gcache.enable(async () => await getUser("123"));

    expect(blocked).toEqual({ userId: "123", calls: 1 });
    expect(written).toEqual({ userId: "123", calls: 2 });
    expect(cached).toEqual(written);
    expect(calls).toBe(2);
  });

  it("resumes tracked writes after the future buffer", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "FutureBufferExpires",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await gcache.invalidateRemote("user_id", "123", 1_000);
    vi.advanceTimersByTime(1_001);
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(redis.values.has(valueKey("FutureBufferExpires"))).toBe(true);
  });

  it("treats a tracked value with a missing watermark marker as a miss", async () => {
    const redis = new FakeRedis();
    redis.setRaw(valueKey("MissingWatermark"), encodeFrame({ source: "stale" }));
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached(async (userId: string) => ({ userId, source: `fallback-${++calls}` }), {
      keyType: "user_id",
      useCase: "MissingWatermark",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", source: "fallback-1" });
    expect(second).toEqual({ userId: "123", source: "fallback-1" });
    expect(redis.readWatermarkValue(watermarkKey)).toBe(0);
  });

  it("preserves the furthest watermark across repeated invalidations", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });

    await gcache.invalidateRemote("user_id", "123", 5_000);
    const first = redis.readWatermarkValue(watermarkKey);
    vi.advanceTimersByTime(100);
    await gcache.invalidateRemote("user_id", "123", 1_000);

    expect(redis.readWatermarkValue(watermarkKey)).toBe(first);
  });

  it("extends watermark lifetime on writes but not reads", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis, watermarkTtlSec: 60 } });
    const getUser = gcache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "WatermarkLifetime",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(2 * 60 * 60),
    });

    await gcache.enable(async () => await getUser("123"));
    const afterWrite = redis.ttlMs(watermarkKey);
    vi.advanceTimersByTime(1_000);
    await gcache.enable(async () => await getUser("123"));
    const afterRead = redis.ttlMs(watermarkKey);

    expect(afterWrite).toBe(2 * 60 * 60 * 1_000 + 60_000);
    expect(afterRead).toBe(afterWrite - 1_000);
  });

  it("fails open without caching when tracked watermark reads fail", async () => {
    const redis = new FakeRedis();
    redis.failWatermarkGet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const gcache = new GCache({ redis: { client: redis }, logger, metrics });
    let calls = 0;
    const getUser = gcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "WatermarkReadFailOpen",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    });

    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(redis.values.size).toBe(0);
    expect(metrics.events).toContainEqual({
      name: "error",
      labels: { useCase: "WatermarkReadFailOpen", keyType: "user_id", layer: CacheLayer.REMOTE, error: "Error", inFallback: false },
    });
  });

  it("propagates invalidation write failures", async () => {
    const redis = new FakeRedis();
    redis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const gcache = new GCache({ redis: { client: redis }, logger, metrics });

    await expect(gcache.invalidateRemote("user_id", "123")).rejects.toThrow("redis set failed");

    expect(logger.warn).toHaveBeenCalledWith("Error writing GCache invalidation watermark", expect.any(Error));
    expect(metrics.events).toContainEqual({
      name: "invalidation",
      labels: { keyType: "user_id", layer: CacheLayer.REMOTE },
    });
  });

  it("rejects invalid future buffers before calling Redis", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });

    await expect(gcache.invalidateRemote("user_id", "123", -1)).rejects.toThrow("futureBufferMs");
    await expect(gcache.invalidateRemote("user_id", "123", 1.5)).rejects.toThrow("futureBufferMs");
    await expect(gcache.invalidateRemote("user_id", "123", Number.NaN)).rejects.toThrow("futureBufferMs");
    await expect(gcache.invalidateRemote("user_id", "123", Number.POSITIVE_INFINITY)).rejects.toThrow("futureBufferMs");
    expect(redis.setCalls).toBe(0);
  });

  it("constructs cluster-compatible tracked value and watermark keys", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({
      urnPrefix: "urn:galileo:test",
      redis: { client: redis, keyPrefix: "gcache:" },
    });
    const getUser = gcache.cached(async (userId: string, locale: string) => ({ userId, locale }), {
      keyType: "User",
      useCase: "ClusterSlotUser",
      cacheKey: (userId, locale) => ({ id: userId, args: { locale } }),
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await gcache.enable(async () => await getUser("123", "en"));
    await gcache.invalidateRemote("User", "123");

    expect([...redis.values.keys()].sort()).toEqual([
      "gcache:{urn%3Agalileo%3Atest:User:123}#watermark",
      "gcache:{urn%3Agalileo%3Atest:User:123}?locale=en#ClusterSlotUser:gcache-frame-v1",
    ]);
    expect(redisClusterHashTag(invalidationPrefix("urn", "user_id", "123"))).toBe("{urn:user_id:123}");
    expect(() => new GCacheKey({ keyType: "user_id", id: "{123}", useCase: "BadTrackedKey", trackForInvalidation: true })).toThrow(
      /hash tag/,
    );
  });

  it("documents that Redis invalidation does not evict local cache", async () => {
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let version = 1;
    const getUser = gcache.cached(async (userId: string) => ({ userId, version }), {
      keyType: "user_id",
      useCase: "LocalInvalidationLimit",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    });

    const before = await gcache.enable(async () => await getUser("123"));
    version = 2;
    await gcache.invalidateRemote("user_id", "123");
    const after = await gcache.enable(async () => await getUser("123"));

    expect(before).toEqual({ userId: "123", version: 1 });
    expect(after).toEqual({ userId: "123", version: 1 });
  });
});
