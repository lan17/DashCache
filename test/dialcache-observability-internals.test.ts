import { describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCacheKey, DialCacheKeyConfig } from "../src/index.js";
import { LocalCache } from "../src/internal/local-cache.js";
import { RedisCache } from "../src/internal/redis-cache.js";
import { resolveLayerConfig } from "../src/internal/runtime-config.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

const key = (defaultConfig: DialCacheKeyConfig | null = DialCacheKeyConfig.enabled(60)) =>
  new DialCacheKey({ keyType: "user_id", id: "123", useCase: "ObservabilityInternals", defaultConfig });

describe("DialCache observability internal compatibility paths", () => {
  it("keeps LocalCache get/getIfPresent compatibility while exposing disabled reads", async () => {
    // Given a local cache with enabled config and a second key with no config.
    const cache = new LocalCache(async () => null, () => 0, 10);
    const enabledKey = key();
    const disabledKey = key(null);
    let calls = 0;

    // When get() populates a value and getIfPresent() reads it back.
    const first = await cache.get(enabledKey, async () => ({ calls: ++calls }));
    const hit = await cache.getIfPresent<{ calls: number }>(enabledKey);
    const disabled = await cache.getIfPresentResult(disabledKey);

    // Then compatibility helpers still behave like the pre-metrics API, and disabled state is explicit.
    expect(first).toEqual({ calls: 1 });
    expect(hit).toEqual({ calls: 1 });
    expect(disabled).toEqual({ status: "disabled", reason: "missing_config" });
    expect(calls).toBe(1);
  });

  it("keeps RedisCache get compatibility and skips writes when remote config is disabled", async () => {
    // Given a Redis cache with one valid stored frame and one key without remote config.
    const redis = new FakeRedis();
    const redisCache = new RedisCache({
      configProvider: async () => null,
      rampSampler: () => 0,
      redis: { client: redis },
      metrics: null,
    });
    const enabledKey = key();
    const disabledKey = new DialCacheKey({
      keyType: "user_id",
      id: "456",
      useCase: "ObservabilityInternals",
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });
    redis.setRaw(`${enabledKey.urn}:dialcache-frame-v1`, encodeFrame({ source: "redis" }));

    // When the compatibility get() reads Redis and put() sees disabled remote config.
    const hit = await redisCache.get<{ source: string }>(enabledKey);
    await redisCache.put(disabledKey, { source: "fallback" });

    // Then get() unwraps the value and the disabled remote write is skipped.
    expect(hit).toEqual({ source: "redis" });
    expect(redis.values.has(`${disabledKey.urn}:dialcache-frame-v1`)).toBe(false);
  });

  it("preserves runtime-config edge behavior used by metrics", async () => {
    // Given configs for missing ramp and non-finite ramp samples.
    const missingRamp = new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 }, ramp: {} });
    const partialRamp = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      ramp: { [CacheLayer.LOCAL]: 50 },
    });

    // When runtime config is resolved through compatibility and sampled disabled paths.
    const noConfig = await resolveLayerConfig({
      config: null,
      key: key(null),
      layer: CacheLayer.LOCAL,
      rampSampler: vi.fn(),
    });
    const noRamp = await resolveLayerConfig({
      config: missingRamp,
      key: key(),
      layer: CacheLayer.LOCAL,
      rampSampler: vi.fn(),
    });
    const nonFiniteSample = await resolveLayerConfig({
      config: partialRamp,
      key: key(),
      layer: CacheLayer.LOCAL,
      rampSampler: () => Number.NaN,
    });

    // Then disabled configuration paths remain explicit.
    expect(noConfig).toBeNull();
    expect(noRamp).toBeNull();
    expect(nonFiniteSample).toBeNull();
  });
});
