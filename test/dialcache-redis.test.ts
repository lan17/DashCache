import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  DialCacheRedisPayloadEncodingError,
  type DialCacheRedisClient,
  type RedisConfig,
  type Serializer,
} from "../src/index.js";
import { decodeFrame, encodeFrame, FakeRedis } from "./fake-redis.js";

const keyFor = (id: string, useCase: string, trackForInvalidation = false): DialCacheKey =>
  new DialCacheKey({ keyType: "user_id", id, useCase, trackForInvalidation });
const redisKeyFor = (id: string, useCase: string, trackForInvalidation = false): string =>
  `${keyFor(id, useCase, trackForInvalidation).urn}:dialcache-frame-v1`;

describe("DialCache Redis TTL layer", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads local miss from Redis and populates the local layer", async () => {
    // Given one process has already written a value into the shared Redis cache.
    const redis = new FakeRedis();
    const writer = new DialCache({ redis: { client: redis } });
    let writerCalls = 0;
    const writeUser = writer.cached(async (userId: string) => ({ userId, calls: ++writerCalls }), {
      keyType: "user_id",
      useCase: "RedisLocalPopulate",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });
    await writer.enable(async () => await writeUser("123"));

    const reader = new DialCache({ redis: { client: redis } });
    let readerCalls = 0;
    const readUser = reader.cached(async (userId: string) => ({ userId, calls: ++readerCalls }), {
      keyType: "user_id",
      useCase: "RedisLocalPopulate",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });
    redis.getCalls = 0;

    // When a second process reads the same key twice.
    const first = await reader.enable(async () => await readUser("123"));
    redis.failGet = true;
    const second = await reader.enable(async () => await readUser("123"));

    // Then the first read comes from Redis and the second read comes from the populated local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(readerCalls).toBe(0);
    expect(redis.getCalls).toBe(1);
  });

  it("does not populate local cache when the local layer was disabled for the read", async () => {
    // Given one process has already written a value into the shared Redis cache.
    const redis = new FakeRedis();
    const writer = new DialCache({ redis: { client: redis } });
    const writeUser = writer.cached(async (userId: string) => ({ userId, source: "redis" }), {
      keyType: "user_id",
      useCase: "RedisNoDisabledLocalPopulate",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });
    await writer.enable(async () => await writeUser("123"));

    // And the reader sees local cache disabled for the first read, then enabled afterward.
    let providerCalls = 0;
    const remoteOnlyConfig = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 60 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    });
    const cacheConfigProvider = vi.fn(async () => (++providerCalls <= 2 ? remoteOnlyConfig : DialCacheKeyConfig.enabled(60)));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reader = new DialCache({ redis: { client: redis }, cacheConfigProvider, logger });
    let readerCalls = 0;
    const readUser = reader.cached(async (userId: string) => ({ userId, source: `fallback-${++readerCalls}` }), {
      keyType: "user_id",
      useCase: "RedisNoDisabledLocalPopulate",
      cacheKey: (userId) => userId,
    });
    redis.getCalls = 0;

    // When the first read hits Redis while local is disabled and the next read cannot reach Redis.
    const first = await reader.enable(async () => await readUser("123"));
    redis.failGet = true;
    const second = await reader.enable(async () => await readUser("123"));

    // Then the Redis value was not silently written into local after a disabled local read.
    expect(first).toEqual({ userId: "123", source: "redis" });
    expect(second).toEqual({ userId: "123", source: "fallback-1" });
    expect(readerCalls).toBe(1);
    expect(redis.getCalls).toBe(2);
  });

  it("does not refetch runtime config after a remote read failure", async () => {
    const redis = new FakeRedis();
    redis.failGet = true;
    const remoteOnlyConfig = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 60 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    });
    const cacheConfigProvider = vi.fn(async () => remoteOnlyConfig);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, cacheConfigProvider, logger });
    const getUser = dialcache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "RemoteFailureConfigSnapshot",
      cacheKey: (userId) => userId,
    });

    await dialcache.enable(async () => await getUser("123"));

    expect(cacheConfigProvider).toHaveBeenCalledTimes(1);
    expect(redis.getCalls).toBe(1);
    expect(redis.setCalls).toBe(1);
  });

  it("writes Redis misses with a timestamped binary frame", async () => {
    // Given an enabled Redis-backed cache with deterministic time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T17:00:00.000Z"));
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisEnvelopeWrite",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(30),
    });

    // When Redis misses and the fallback succeeds.
    const value = await dialcache.enable(async () => await getUser("123"));
    const redisKey = redisKeyFor("123", "RedisEnvelopeWrite");
    const frame = decodeFrame(redis.raw(redisKey));

    // Then DialCache stores the fallback result with a versioned timestamp and UTF-8 payload.
    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(frame).toEqual({
      createdAtMs: Date.parse("2026-05-12T17:00:00.000Z"),
      encoding: 0,
      payload: JSON.stringify({ userId: "123", calls: 1 }),
    });
  });

  it.each(["dialcache:", undefined])("rejects the removed Redis keyPrefix option value %s for untyped callers", (keyPrefix) => {
    const legacyRedisConfig = { client: new FakeRedis(), keyPrefix } as unknown as RedisConfig;

    expect(() => new DialCache({ redis: legacyRedisConfig })).toThrow(
      new TypeError("RedisConfig.keyPrefix was removed; use DialCacheConfig.namespace for cache identity"),
    );
  });

  it.each([() => new FakeRedis(), undefined])(
    "rejects the removed Redis createClient option value %s for untyped callers",
    (createClient) => {
      const legacyRedisConfig = { client: new FakeRedis(), createClient } as unknown as RedisConfig;

      expect(() => new DialCache({ redis: legacyRedisConfig })).toThrow(
        new TypeError(
          "RedisConfig.createClient was removed; create and connect a client, then pass it as RedisConfig.client",
        ),
      );
    },
  );

  it("fails open when Redis operations fail before fallback", async () => {
    // Given Redis is unavailable and local caching is not configured for this key.
    const redis = new FakeRedis();
    redis.failGet = true;
    redis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
    });

    // When the cached function is called while cache reads and writes fail.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then application fallback results are still returned and no Redis error escapes.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("round-trips Redis values through a custom serializer", async () => {
    // Given a custom serializer is configured for a cached function.
    const redis = new FakeRedis();
    const serializer: Serializer<{ id: string; source: string }> = {
      dump: vi.fn(async (value) => Buffer.from(`${value.id}|${value.source}`, "utf8")),
      load: vi.fn(async (value) => {
        const [id, source] = Buffer.isBuffer(value) ? value.toString("utf8").split("|") : value.split("|");
        return { id: id ?? "", source: source ?? "" };
      }),
    };
    const writer = new DialCache({ redis: { client: redis } });
    const readFromWriter = writer.cached(async (userId: string) => ({ id: userId, source: "fallback" }), {
      keyType: "user_id",
      useCase: "RedisCustomSerializer",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
      serializer,
    });
    await writer.enable(async () => await readFromWriter("123"));

    const reader = new DialCache({ redis: { client: redis } });
    let readerCalls = 0;
    const readFromRedis = reader.cached(async (userId: string) => ({ id: userId, source: `fallback-${++readerCalls}` }), {
      keyType: "user_id",
      useCase: "RedisCustomSerializer",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
      serializer,
    });

    // When another process reads the value from Redis.
    const value = await reader.enable(async () => await readFromRedis("123"));
    const frame = decodeFrame(redis.raw(redisKeyFor("123", "RedisCustomSerializer")));

    // Then the custom serializer handles the Redis payload instead of JSON serialization.
    expect(value).toEqual({ id: "123", source: "fallback" });
    expect(readerCalls).toBe(0);
    expect(frame.encoding).toBe(1);
    expect(frame.payload).toEqual(Buffer.from("123|fallback"));
    expect(serializer.dump).toHaveBeenCalledOnce();
    expect(serializer.load).toHaveBeenCalledOnce();
  });

  it("round-trips a statically non-JSON value through its required serializer", async () => {
    const redis = new FakeRedis();
    const serializer: Serializer<Date> = {
      dump: vi.fn((value) => value.toISOString()),
      load: vi.fn((value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value)),
    };
    const writer = new DialCache({ redis: { client: redis } });
    const writeUpdatedAt = writer.cached(async () => new Date("2026-07-17T12:00:00.000Z"), {
      keyType: "user_id",
      useCase: "RedisDateSerializer",
      cacheKey: () => "123",
      defaultConfig: DialCacheKeyConfig.enabled(60),
      serializer,
    });
    await writer.enable(async () => await writeUpdatedAt());

    const reader = new DialCache({ redis: { client: redis } });
    let readerCalls = 0;
    const readUpdatedAt = reader.cached(
      async () => {
        readerCalls += 1;
        return new Date("2026-07-18T12:00:00.000Z");
      },
      {
        keyType: "user_id",
        useCase: "RedisDateSerializer",
        cacheKey: () => "123",
        defaultConfig: DialCacheKeyConfig.enabled(60),
        serializer,
      },
    );

    const value = await reader.enable(async () => await readUpdatedAt());

    expect(value).toEqual(new Date("2026-07-17T12:00:00.000Z"));
    expect(readerCalls).toBe(0);
    expect(serializer.dump).toHaveBeenCalledOnce();
    expect(serializer.load).toHaveBeenCalledOnce();
  });

  it("isolates binary read payloads from the stored Redis frame", async () => {
    const redis = new FakeRedis();
    const valueKey = "binary-isolation:{item:123}:value";
    const payload = Buffer.from([0, 1, 2, 0xff]);
    await redis.write({ valueKey, cacheTtlMs: 60_000, value: payload });

    const firstRead = await redis.read({ valueKey });
    if (!Buffer.isBuffer(firstRead)) {
      throw new Error("Expected a binary Redis payload");
    }
    firstRead[0] = 0xff;

    expect(await redis.read({ valueKey })).toEqual(payload);
  });

  it("fails open when Redis serializer dump fails", async () => {
    // Given Redis serialization fails after the fallback returns but local cache is still configured.
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const serializer: Serializer<{ userId: string; calls: number }> = {
      dump: vi.fn(async () => {
        throw new Error("dump failed");
      }),
      load: vi.fn(async () => ({ userId: "never", calls: 0 })),
    };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisSerializerDumpFailure",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
      serializer,
    });

    // When Redis write serialization fails on the first miss and the same key is read again.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then application results still return, Redis is not written, and local cache can still serve the second read.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(redis.setCalls).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("refreshes tracked Redis values when serializer load fails", async () => {
    // Given Redis contains a tracked frame whose payload cannot be decoded by the configured serializer.
    const redis = new FakeRedis();
    const redisKey = redisKeyFor("123", "RedisSerializerLoadFailure", true);
    redis.setRaw(redisKey, encodeFrame({ userId: "123", source: "stale" }));
    redis.setRaw("{urn:user_id:123}#watermark", "0");
    let failNextLoad = true;
    const serializer: Serializer<{ userId: string; source: string }> = {
      dump: vi.fn(async (value) => JSON.stringify(value)),
      load: vi.fn(async (value) => {
        if (failNextLoad) {
          failNextLoad = false;
          throw new Error("load failed");
        }
        return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value) as { userId: string; source: string };
      }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, source: `fallback-${++calls}` }), {
      keyType: "user_id",
      useCase: "RedisSerializerLoadFailure",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
      serializer,
    });

    // When the first Redis hit cannot deserialize and a later read sees the refreshed value.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the decode failure is treated as a refreshable miss and overwrites Redis.
    expect(first).toEqual({ userId: "123", source: "fallback-1" });
    expect(second).toEqual({ userId: "123", source: "fallback-1" });
    expect(calls).toBe(1);
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
  });

  it("refreshes expired or malformed Redis frames by falling through to fallback", async () => {
    // Given Redis contains an expired frame and two malformed frames.
    const redis = new FakeRedis();
    const staleKey = redisKeyFor("stale", "RedisBadEnvelope");
    const badKey = redisKeyFor("bad", "RedisBadEnvelope");
    const nonFiniteKey = redisKeyFor("nonfinite", "RedisBadEnvelope");
    redis.setRaw(staleKey, encodeFrame({ stale: true }), -1);
    redis.setRaw(badKey, Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    redis.setRaw(nonFiniteKey, Buffer.from([1, 0]));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisBadEnvelope",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When both keys are read through the Redis chain.
    const stale = await dialcache.enable(async () => await getUser("stale"));
    const malformed = await dialcache.enable(async () => await getUser("bad"));
    const nonFinite = await dialcache.enable(async () => await getUser("nonfinite"));

    // Then expired and malformed entries miss, fail open, and are replaced by fallback results.
    expect(stale).toEqual({ userId: "stale", calls: 1 });
    expect(malformed).toEqual({ userId: "bad", calls: 2 });
    expect(nonFinite).toEqual({ userId: "nonfinite", calls: 3 });
    expect(redis.values.get(staleKey)).toBeDefined();
    expect(redis.values.get(badKey)).toBeDefined();
    expect(redis.values.get(nonFiniteKey)).toBeDefined();
    expect(logger.warn).not.toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
  });

  it("records a distinct metric label when a Redis adapter reports invalid payload encoding", async () => {
    const redisClient: DialCacheRedisClient = {
      read: vi.fn(async () => {
        throw new DialCacheRedisPayloadEncodingError("Invalid DialCache Redis payload encoding");
      }),
      write: vi.fn(async () => true),
      invalidate: vi.fn(async () => undefined),
    };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      request: vi.fn(),
      miss: vi.fn(),
      disabled: vi.fn(),
      error: vi.fn(),
      invalidation: vi.fn(),
      observeGet: vi.fn(),
      observeFallback: vi.fn(),
      observeSerialization: vi.fn(),
      observeSize: vi.fn(),
    };
    const dialcache = new DialCache({ redis: { client: redisClient }, logger, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisBadPayloadEncoding",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(redisClient.write).not.toHaveBeenCalled();
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "RedisBadPayloadEncoding",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "cache_read",
      inFallback: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Error getting value from Redis cache",
      expect.objectContaining({ name: "DialCacheRedisPayloadEncodingError" }),
    );
  });

  it("records the same payload encoding label for malformed FakeRedis frames", async () => {
    const redis = new FakeRedis();
    const redisKey = redisKeyFor("123", "RedisFakeBadPayloadEncoding");
    redis.setRaw(redisKey, encodeFrame({ userId: "123", source: "stale" }, Date.now(), 2));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      request: vi.fn(),
      miss: vi.fn(),
      disabled: vi.fn(),
      error: vi.fn(),
      invalidation: vi.fn(),
      observeGet: vi.fn(),
      observeFallback: vi.fn(),
      observeSerialization: vi.fn(),
      observeSize: vi.fn(),
    };
    const dialcache = new DialCache({ redis: { client: redis }, logger, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisFakeBadPayloadEncoding",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    const value = await dialcache.enable(async () => await getUser("123"));

    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(1);
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "RedisFakeBadPayloadEncoding",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "cache_read",
      inFallback: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Error getting value from Redis cache",
      expect.objectContaining({ name: "DialCacheRedisPayloadEncodingError" }),
    );
  });

  it("falls through when remote config is missing", async () => {
    // Given Redis is configured but the key has no remote TTL.
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RedisMissingRemoteTtl",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    // When a cache read is attempted.
    const value = await dialcache.enable(async () => await getUser("123"));

    // Then missing remote config disables Redis reads/writes without logging an operational failure.
    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rejects Redis config without a client", () => {
    // Given an untyped Redis config without the required caller-owned client.
    const construct = () => new DialCache({ redis: {} as RedisConfig });

    // When the cache is constructed, then the invalid Redis configuration is rejected.
    expect(construct).toThrow(new TypeError("Redis config requires client"));
  });

});
