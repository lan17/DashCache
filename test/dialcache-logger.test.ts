import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type DialCacheRedisClient,
  type Logger,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

function throwingLogger() {
  const fail = (): never => {
    throw new Error("logger failed");
  };
  return {
    debug: vi.fn(fail),
    error: vi.fn(fail),
    warn: vi.fn(fail),
  } satisfies Logger;
}

describe("DialCache logger isolation", () => {
  it("preserves fallback behavior when key construction and logging both fail", async () => {
    const logger = throwingLogger();
    const dialcache = new DialCache({ logger });
    const getUser = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "user_id",
      useCase: "ThrowingLoggerKeyConstruction",
      cacheKey: () => {
        throw new Error("key construction failed");
      },
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ source: "fallback" });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Could not construct DialCache key", expect.any(Error));
  });

  it("preserves fallback behavior when config resolution and logging both fail", async () => {
    const logger = throwingLogger();
    const dialcache = new DialCache({
      logger,
      cacheConfigProvider: () => {
        throw new Error("config provider failed");
      },
    });
    const getUser = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "user_id",
      useCase: "ThrowingLoggerConfigProvider",
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ source: "fallback" });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Could not resolve DialCache key config", expect.any(Error));
  });

  it("preserves fallback behavior when a local read and logging both fail", async () => {
    const logger = throwingLogger();
    const dialcache = new DialCache({ logger });
    const localCache = (dialcache as unknown as {
      readonly localCache: {
        getWithResolvedConfig: (key: DialCacheKey, config: { readonly ttlSec: number; readonly ramp: number }) => unknown;
      };
    }).localCache;
    vi.spyOn(localCache, "getWithResolvedConfig").mockImplementationOnce(() => {
      throw new Error("local read failed");
    });
    const getUser = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "user_id",
      useCase: "ThrowingLoggerLocalRead",
      cacheKey: () => "123",
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ source: "fallback" });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Error getting value from local cache", expect.any(Error));
  });

  it("preserves fallback behavior when a local write and logging both fail", async () => {
    const logger = throwingLogger();
    const dialcache = new DialCache({ logger });
    const localCache = (dialcache as unknown as {
      readonly localCache: {
        put: (key: DialCacheKey, value: unknown, config?: { readonly ttlSec: number }) => Promise<void>;
      };
    }).localCache;
    vi.spyOn(localCache, "put").mockRejectedValueOnce(new Error("local write failed"));
    const getUser = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "user_id",
      useCase: "ThrowingLoggerLocalWrite",
      cacheKey: () => "123",
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ source: "fallback" });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in local cache", expect.any(Error));
  });

  it("preserves fallback behavior when Redis reads, writes, and logging fail", async () => {
    const logger = throwingLogger();
    const redis = new FakeRedis();
    redis.failGet = true;
    redis.failSet = true;
    const dialcache = new DialCache({ logger, redis: { client: redis } });
    const getUser = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "user_id",
      useCase: "ThrowingLoggerRedisReadWrite",
      cacheKey: () => "123",
      defaultConfig: remoteOnly(),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ source: "fallback" });
    expect(redis.getCalls).toBe(1);
    expect(redis.setCalls).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("preserves the original invalidation error when logging also fails", async () => {
    const logger = throwingLogger();
    const invalidationError = new Error("invalidation failed");
    const redis = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate: vi.fn(async () => {
        throw invalidationError;
      }),
    } satisfies DialCacheRedisClient;
    const dialcache = new DialCache({ logger, redis: { client: redis } });

    await expect(dialcache.invalidateRemote("user_id", "123")).rejects.toBe(invalidationError);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Error writing DialCache invalidation watermark", invalidationError);
  });
});
