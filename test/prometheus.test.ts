import {
  Counter,
  Histogram,
  Registry,
  register as defaultRegistry,
  type CounterConfiguration,
  type OpenMetricsContentType,
} from "prom-client";
import { describe, expect, it } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig, type MetricErrorKind } from "../src/index.js";
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

const GET_TIMER_HELP = "DialCache cache get latency in seconds.";
const GET_TIMER_LABELS = ["use_case", "key_type", "layer"] as const;
const CONFIGURED_TIMER_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const METRIC_ERROR_KINDS: Readonly<Record<MetricErrorKind, true>> = {
  key_construction: true,
  config_resolution: true,
  cache_read: true,
  cache_write: true,
  serialization_load: true,
  serialization_dump: true,
  invalidation: true,
  fallback: true,
  unknown: true,
};

interface IncompatibleCollectorCase {
  readonly schemaPart: string;
  register(registry: Registry, name: string): void;
}

const incompatibleCollectorCases: readonly IncompatibleCollectorCase[] = [
  {
    schemaPart: "type",
    register: (registry, name) => {
      new Counter({ name, help: GET_TIMER_HELP, labelNames: GET_TIMER_LABELS, registers: [registry] });
    },
  },
  {
    schemaPart: "label names",
    register: (registry, name) => {
      new Histogram({
        name,
        help: GET_TIMER_HELP,
        labelNames: ["use_case", "layer", "key_type"],
        buckets: CONFIGURED_TIMER_BUCKETS,
        registers: [registry],
      });
    },
  },
  {
    schemaPart: "help text",
    register: (registry, name) => {
      new Histogram({
        name,
        help: "Incompatible help text.",
        labelNames: GET_TIMER_LABELS,
        buckets: CONFIGURED_TIMER_BUCKETS,
        registers: [registry],
      });
    },
  },
  {
    schemaPart: "histogram buckets",
    register: (registry, name) => {
      new Histogram({
        name,
        help: GET_TIMER_HELP,
        labelNames: GET_TIMER_LABELS,
        buckets: [0.1, 1],
        registers: [registry],
      });
    },
  },
];

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

  it("preserves the public collector schema", async () => {
    const registry = new Registry();
    const metrics = new PrometheusDialCacheMetrics({ registry, prefix: "schema_" });
    const labels = {
      useCase: "PrometheusSchema",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
    } as const;

    metrics.request(labels);
    metrics.miss(labels);
    metrics.disabled({ ...labels, reason: "context" });
    metrics.error({ ...labels, error: "cache_read", inFallback: false });
    metrics.invalidation({ keyType: labels.keyType, layer: labels.layer });
    metrics.coalesced?.({ useCase: labels.useCase, keyType: labels.keyType, scope: "process" });
    metrics.observeGet(labels, 0.05);
    metrics.observeFallback(labels, 0.05);
    metrics.observeSerialization({ ...labels, operation: "dump" }, 0.05);
    metrics.observeSerialization({ ...labels, operation: "load" }, 0.05);
    metrics.observeSize(labels, 1_000);

    // prom-client declares MetricType as a numeric enum, but this JSON API returns string type names.
    const families = (await registry.getMetricsAsJSON()) as unknown as MetricFamily[];
    expect(families.map(metricSchema).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      counterSchema("schema_dialcache_coalesced_counter", ["use_case", "key_type", "scope"]),
      counterSchema("schema_dialcache_disabled_counter", ["use_case", "key_type", "layer", "reason"]),
      counterSchema("schema_dialcache_error_counter", [
        "use_case",
        "key_type",
        "layer",
        "error",
        "in_fallback",
      ]),
      histogramSchema("schema_dialcache_fallback_timer", ["use_case", "key_type", "layer"], TIMER_BUCKETS),
      histogramSchema("schema_dialcache_get_timer", ["use_case", "key_type", "layer"], TIMER_BUCKETS),
      counterSchema("schema_dialcache_invalidation_counter", ["key_type", "layer"]),
      counterSchema("schema_dialcache_miss_counter", ["use_case", "key_type", "layer"]),
      counterSchema("schema_dialcache_request_counter", ["use_case", "key_type", "layer"]),
      histogramSchema(
        "schema_dialcache_serialization_timer",
        ["use_case", "key_type", "layer", "operation"],
        TIMER_BUCKETS,
      ),
      histogramSchema("schema_dialcache_size_histogram", ["use_case", "key_type", "layer"], SIZE_BUCKETS),
    ]);

    const serialization = families.find(({ name }) => name === "schema_dialcache_serialization_timer");
    const serializationLabels = serialization?.values
      .filter(({ metricName }) => metricName === `${serialization.name}_sum`)
      .map(({ labels: sampleLabels }) => sampleLabels);
    expect(serializationLabels).toEqual([
      { use_case: labels.useCase, key_type: labels.keyType, layer: labels.layer, operation: "dump" },
      { use_case: labels.useCase, key_type: labels.keyType, layer: labels.layer, operation: "load" },
    ]);
  });

  it("exports every bounded error category without rewriting labels", async () => {
    const registry = new Registry();
    const metrics = new PrometheusDialCacheMetrics({ registry, prefix: "error_kind_" });
    const labels = {
      useCase: "PrometheusErrorKinds",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
    } as const;
    const errorKinds = Object.keys(METRIC_ERROR_KINDS) as MetricErrorKind[];

    for (const error of errorKinds) {
      metrics.error({ ...labels, error, inFallback: false });
    }

    for (const error of errorKinds) {
      await expect(
        sumMetric(registry, "error_kind_dialcache_error_counter", {
          use_case: labels.useCase,
          key_type: labels.keyType,
          layer: labels.layer,
          error,
          in_fallback: "false",
        }),
      ).resolves.toBe(1);
    }
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

  for (const { schemaPart, register } of incompatibleCollectorCases) {
    it(`rejects an existing collector with incompatible ${schemaPart} before registering anything`, () => {
      const registry = new Registry();
      const prefix = "collision_";
      const metricName = `${prefix}dialcache_get_timer`;
      register(registry, metricName);

      expect(() => new PrometheusDialCacheMetrics({ registry, prefix })).toThrowError(
        `Prometheus collector "${metricName}" already exists with an incompatible schema. ` +
          "Use a unique prefix or a separate Registry.",
      );
      expect(registry.getMetricsAsArray().map(({ name }) => name)).toEqual([metricName]);
    });
  }

  it("rejects exemplar-enabled collectors before registering anything", () => {
    const registry = new Registry<OpenMetricsContentType>();
    registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    const prefix = "exemplar_";
    const metricName = `${prefix}dialcache_get_timer`;
    new Histogram({
      name: metricName,
      help: GET_TIMER_HELP,
      labelNames: GET_TIMER_LABELS,
      buckets: CONFIGURED_TIMER_BUCKETS,
      enableExemplars: true,
      registers: [registry],
    });

    expect(() => new PrometheusDialCacheMetrics({ registry, prefix })).toThrowError(
      `Prometheus collector "${metricName}" already exists with an incompatible schema. ` +
        "Use a unique prefix or a separate Registry.",
    );
    expect(registry.getMetricsAsArray().map(({ name }) => name)).toEqual([metricName]);
  });

  it("treats an explicitly undefined exemplar mode as disabled", async () => {
    const registry = new Registry();
    const prefix = "undefined_exemplar_";
    const metricName = `${prefix}dialcache_request_counter`;
    const config = {
      name: metricName,
      help: "Total DialCache cache-layer requests.",
      labelNames: GET_TIMER_LABELS,
      enableExemplars: undefined,
      registers: [registry],
    } as unknown as CounterConfiguration<(typeof GET_TIMER_LABELS)[number]>;
    new Counter(config);
    const metrics = new PrometheusDialCacheMetrics({ registry, prefix });

    metrics.request({ useCase: "UndefinedExemplarMode", keyType: "user_id", layer: CacheLayer.LOCAL });

    await expect(
      sumMetric(registry, metricName, {
        use_case: "UndefinedExemplarMode",
        key_type: "user_id",
        layer: "local",
      }),
    ).resolves.toBe(1);
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
        const error = new Error("bad key for tenant-123");
        error.name = "Tenant123KeyError";
        throw error;
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
        error: "key_construction",
        in_fallback: "false",
      }),
    ).resolves.toBe(1);
    await expect(registry.metrics()).resolves.not.toMatch(/Tenant123KeyError|tenant-123|bad key/);
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

const TIMER_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, "+Inf"];
const SIZE_BUCKETS = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, "+Inf"];

interface MetricValue {
  readonly metricName?: string;
  readonly labels: Record<string, string | number>;
}

interface MetricFamily {
  readonly name: string;
  readonly type: string;
  readonly values: readonly MetricValue[];
}

interface MetricSchema {
  readonly name: string;
  readonly type: string;
  readonly labelNames: readonly string[];
  readonly buckets?: readonly unknown[];
}

function counterSchema(name: string, labelNames: readonly string[]): MetricSchema {
  return { name, type: "counter", labelNames };
}

function histogramSchema(
  name: string,
  labelNames: readonly string[],
  buckets: readonly (number | string)[],
): MetricSchema {
  return { name, type: "histogram", labelNames, buckets };
}

function metricSchema(metric: MetricFamily): MetricSchema {
  const nonBucketSample = metric.values.find(({ metricName }) => metricName !== `${metric.name}_bucket`);
  if (metric.type !== "histogram") {
    return {
      name: metric.name,
      type: metric.type,
      labelNames: Object.keys(nonBucketSample?.labels ?? {}),
    };
  }

  const firstSeriesLabels = nonBucketSample?.labels ?? {};
  const buckets = metric.values
    .filter(
      ({ metricName, labels }) =>
        metricName === `${metric.name}_bucket` &&
        Object.entries(firstSeriesLabels).every(([label, value]) => labels[label] === value),
    )
    .map(({ labels }) => labels.le);
  return {
    name: metric.name,
    type: metric.type,
    labelNames: Object.keys(firstSeriesLabels),
    buckets,
  };
}

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
