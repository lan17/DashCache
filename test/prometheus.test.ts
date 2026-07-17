import { Registry, register as defaultRegistry } from "prom-client";
import { describe, expect, it } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../src/index.js";
import { PrometheusDialCacheMetrics, createPrometheusDialCacheMetrics } from "../src/prometheus.js";
import { FakeRedis } from "./fake-redis.js";

const localOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Prometheus metrics adapter", () => {
  it("keeps default DialCache construction detached from Prometheus", () => {
    const metricName = "dialcache_request_counter";
    expect(defaultRegistry.getSingleMetric(metricName)).toBeUndefined();

    const dialcache = new DialCache();

    expect(dialcache).toBeInstanceOf(DialCache);
    expect(defaultRegistry.getSingleMetric(metricName)).toBeUndefined();
  });

  it("registers collectors only in the caller-owned registry", () => {
    const registry = new Registry();
    const metricName = "owned_dialcache_request_counter";

    const metrics = new PrometheusDialCacheMetrics({ registry, prefix: "owned_" });

    expect(metrics).toBeInstanceOf(PrometheusDialCacheMetrics);
    expect(registry.getSingleMetric(metricName)).toBeDefined();
    expect(defaultRegistry.getSingleMetric(metricName)).toBeUndefined();
  });

  it("reuses existing collectors when multiple adapters share a registry", async () => {
    const registry = new Registry();
    const firstCache = new DialCache({ metrics: createPrometheusDialCacheMetrics({ registry }) });
    const secondCache = new DialCache({ metrics: createPrometheusDialCacheMetrics({ registry }) });
    const first = firstCache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "DuplicateMetricRegistrationFirst",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    const second = secondCache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "DuplicateMetricRegistrationSecond",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    await firstCache.enable(async () => await first("123"));
    await secondCache.enable(async () => await second("456"));

    await expect(sumMetric(registry, "dialcache_request_counter")).resolves.toBe(2);
    await expect(registry.getSingleMetricAsString("dialcache_request_counter")).resolves.toContain(
      "dialcache_request_counter",
    );
  });

  it("exports counters and histograms for requests, misses, fallbacks, gets, serialization, and size", async () => {
    const registry = new Registry();
    const redis = new FakeRedis();
    const metrics = createPrometheusDialCacheMetrics({ registry, prefix: "test_" });
    const dialcache = new DialCache({ redis: { client: redis }, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "PrometheusMetricExport",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    await expect(sumMetric(registry, "test_dialcache_request_counter", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBe(2);
    await expect(sumMetric(registry, "test_dialcache_miss_counter", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBe(1);
    await expect(sumMetric(registry, "test_dialcache_get_timer", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBeGreaterThan(0);
    await expect(sumMetric(registry, "test_dialcache_fallback_timer", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBeGreaterThan(0);
    await expect(
      sumMetric(registry, "test_dialcache_serialization_timer", { use_case: "PrometheusMetricExport", layer: "remote" }),
    ).resolves.toBeGreaterThan(0);
    await expect(sumMetric(registry, "test_dialcache_size_histogram", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBeGreaterThan(0);
  });

  it("exports disabled, error, invalidation, and scoped coalescing counters", async () => {
    const registry = new Registry();
    const redis = new FakeRedis();
    const metrics = createPrometheusDialCacheMetrics({ registry, prefix: "test_" });
    const dialcache = new DialCache({ redis: { client: redis }, metrics });
    const contextDisabled = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "PrometheusDisabledMetric",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    const keyBuildFailure = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "PrometheusErrorMetric",
      cacheKey: () => {
        throw new Error("bad key");
      },
      defaultConfig: localOnly(),
    });
    let releaseFallback: () => void = () => undefined;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    let coalescedCalls = 0;
    const coalesced = dialcache.cached(async (userId: string) => {
      coalescedCalls += 1;
      await fallbackGate;
      return userId;
    }, {
      keyType: "user_id",
      useCase: "PrometheusCoalescedMetric",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    let releaseRequestLocalFallback: () => void = () => undefined;
    const requestLocalFallbackGate = new Promise<void>((resolve) => {
      releaseRequestLocalFallback = resolve;
    });
    const requestLocalCoalesced = dialcache.cached(async (userId: string) => {
      await requestLocalFallbackGate;
      return userId;
    }, {
      keyType: "user_id",
      useCase: "PrometheusRequestLocalCoalescedMetric",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    await contextDisabled("123");
    await dialcache.enable(async () => await keyBuildFailure("123"));
    await dialcache.invalidateRemote("user_id", "123");
    const inflight = dialcache.enable(async () => await Promise.all([coalesced("456"), coalesced("456")]));
    await tick();
    releaseFallback();
    await inflight;
    const requestLocalInflight = dialcache.enable(async () =>
      await Promise.all([requestLocalCoalesced("789"), requestLocalCoalesced("789")]),
    );
    await tick();
    releaseRequestLocalFallback();
    await requestLocalInflight;

    expect(coalescedCalls).toBe(1);
    await expect(
      sumMetric(registry, "test_dialcache_disabled_counter", { use_case: "PrometheusDisabledMetric", layer: "noop", reason: "context" }),
    ).resolves.toBe(1);
    await expect(
      sumMetric(registry, "test_dialcache_error_counter", {
        use_case: "PrometheusErrorMetric",
        layer: "noop",
        error: "Error",
        in_fallback: "false",
      }),
    ).resolves.toBe(1);
    await expect(sumMetric(registry, "test_dialcache_invalidation_counter", { key_type: "user_id", layer: "remote" })).resolves.toBe(1);
    await expect(
      sumMetric(registry, "test_dialcache_coalesced_counter", {
        use_case: "PrometheusCoalescedMetric",
        key_type: "user_id",
        scope: "process",
      }),
    ).resolves.toBe(1);
    await expect(
      sumMetric(registry, "test_dialcache_coalesced_counter", {
        use_case: "PrometheusRequestLocalCoalescedMetric",
        key_type: "user_id",
        scope: "request_local",
      }),
    ).resolves.toBe(1);
  });
});

async function sumMetric(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metrics = (await registry.getMetricsAsJSON()) as Array<{
    readonly name: string;
    readonly values: Array<{ readonly value: number; readonly labels: Record<string, string | number> }>;
  }>;
  const metric = metrics.find((candidate) => candidate.name === name);
  return (
    metric?.values
      .filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
      .reduce((total, sample) => total + sample.value, 0) ?? 0
  );
}
