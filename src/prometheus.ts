import { Counter, Histogram, type OpenMetricsContentType, type Registry } from "prom-client";

import type {
  CacheMetricLabels,
  CoalescedMetricLabels,
  DialCacheMetricsAdapter,
  DisabledMetricLabels,
  ErrorMetricLabels,
  InvalidationMetricLabels,
  SerializationMetricLabels,
} from "./metrics.js";

export interface PrometheusMetricsOptions {
  readonly registry: PrometheusRegistry;
  readonly prefix?: string;
}

type PrometheusRegistry = Registry | Registry<OpenMetricsContentType>;

type CounterLabels = "cache_namespace" | "use_case" | "key_type" | "layer";
type DisabledLabels = CounterLabels | "reason";
type ErrorLabels = CounterLabels | "error" | "in_fallback";
type SerializationLabels = CounterLabels | "operation";
type InvalidationLabels = "cache_namespace" | "key_type" | "layer";
type CoalescedLabels = "cache_namespace" | "use_case" | "key_type" | "scope";

interface BaseCollectorConfig<T extends string> {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly T[];
}

interface CounterCollectorConfig<T extends string> extends BaseCollectorConfig<T> {
  readonly type: "counter";
}

interface HistogramCollectorConfig<T extends string> extends BaseCollectorConfig<T> {
  readonly type: "histogram";
  readonly buckets: readonly number[];
}

type CollectorConfig<T extends string = string> = CounterCollectorConfig<T> | HistogramCollectorConfig<T>;

interface CollectorShape {
  readonly name?: unknown;
  readonly help?: unknown;
  readonly type?: unknown;
  readonly labelNames?: unknown;
  readonly buckets?: unknown;
  readonly enableExemplars?: unknown;
}

const TIMER_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const SIZE_BUCKETS = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];

export class PrometheusDialCacheMetrics implements DialCacheMetricsAdapter {
  private readonly requestCounter: Counter<CounterLabels>;
  private readonly missCounter: Counter<CounterLabels>;
  private readonly disabledCounter: Counter<DisabledLabels>;
  private readonly errorCounter: Counter<ErrorLabels>;
  private readonly invalidationCounter: Counter<InvalidationLabels>;
  private readonly coalescedCounter: Counter<CoalescedLabels>;
  private readonly getTimer: Histogram<CounterLabels>;
  private readonly fallbackTimer: Histogram<CounterLabels>;
  private readonly serializationTimer: Histogram<SerializationLabels>;
  private readonly sizeHistogram: Histogram<CounterLabels>;

  constructor(options: PrometheusMetricsOptions) {
    const registry = options.registry;
    const prefix = options.prefix ?? "";
    const collectors = collectorConfigs(prefix);

    validateExistingCollectors(registry, Object.values(collectors));
    this.disabledCounter = counter(registry, collectors.disabledCounter);
    this.missCounter = counter(registry, collectors.missCounter);
    this.requestCounter = counter(registry, collectors.requestCounter);
    this.errorCounter = counter(registry, collectors.errorCounter);
    this.invalidationCounter = counter(registry, collectors.invalidationCounter);
    this.coalescedCounter = counter(registry, collectors.coalescedCounter);
    this.getTimer = histogram(registry, collectors.getTimer);
    this.fallbackTimer = histogram(registry, collectors.fallbackTimer);
    this.serializationTimer = histogram(registry, collectors.serializationTimer);
    this.sizeHistogram = histogram(registry, collectors.sizeHistogram);
  }

  request(labels: CacheMetricLabels): void {
    this.requestCounter.inc(cacheLabels(labels));
  }

  miss(labels: CacheMetricLabels): void {
    this.missCounter.inc(cacheLabels(labels));
  }

  disabled(labels: DisabledMetricLabels): void {
    this.disabledCounter.inc({ ...cacheLabels(labels), reason: labels.reason });
  }

  error(labels: ErrorMetricLabels): void {
    this.errorCounter.inc({
      ...cacheLabels(labels),
      error: labels.error,
      in_fallback: String(labels.inFallback),
    });
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.invalidationCounter.inc({
      cache_namespace: labels.cacheNamespace,
      key_type: labels.keyType,
      layer: labels.layer,
    });
  }

  coalesced(labels: CoalescedMetricLabels): void {
    this.coalescedCounter.inc({
      cache_namespace: labels.cacheNamespace,
      use_case: labels.useCase,
      key_type: labels.keyType,
      scope: labels.scope,
    });
  }

  observeGet(labels: CacheMetricLabels, seconds: number): void {
    this.getTimer.observe(cacheLabels(labels), seconds);
  }

  observeFallback(labels: CacheMetricLabels, seconds: number): void {
    this.fallbackTimer.observe(cacheLabels(labels), seconds);
  }

  observeSerialization(labels: SerializationMetricLabels, seconds: number): void {
    this.serializationTimer.observe({ ...cacheLabels(labels), operation: labels.operation }, seconds);
  }

  observeSize(labels: CacheMetricLabels, bytes: number): void {
    this.sizeHistogram.observe(cacheLabels(labels), bytes);
  }
}

export function createPrometheusDialCacheMetrics(options: PrometheusMetricsOptions): DialCacheMetricsAdapter {
  return new PrometheusDialCacheMetrics(options);
}

function cacheLabels(labels: CacheMetricLabels): Record<CounterLabels, string> {
  return {
    cache_namespace: labels.cacheNamespace,
    use_case: labels.useCase,
    key_type: labels.keyType,
    layer: labels.layer,
  };
}

function collectorConfigs(prefix: string) {
  return {
    disabledCounter: {
      type: "counter",
      name: `${prefix}dialcache_disabled_counter`,
      help: "Requests where DialCache skipped a cache layer.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer", "reason"],
    },
    missCounter: {
      type: "counter",
      name: `${prefix}dialcache_miss_counter`,
      help: "DialCache cache misses.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer"],
    },
    requestCounter: {
      type: "counter",
      name: `${prefix}dialcache_request_counter`,
      help: "Total DialCache cache-layer requests.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer"],
    },
    errorCounter: {
      type: "counter",
      name: `${prefix}dialcache_error_counter`,
      help: "Errors during DialCache cache operations or fallback execution.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer", "error", "in_fallback"],
    },
    invalidationCounter: {
      type: "counter",
      name: `${prefix}dialcache_invalidation_counter`,
      help: "DialCache invalidation calls by key type and layer.",
      labelNames: ["cache_namespace", "key_type", "layer"],
    },
    coalescedCounter: {
      type: "counter",
      name: `${prefix}dialcache_coalesced_counter`,
      help: "DialCache requests coalesced onto in-flight work by sharing scope.",
      labelNames: ["cache_namespace", "use_case", "key_type", "scope"],
    },
    getTimer: {
      type: "histogram",
      name: `${prefix}dialcache_get_timer`,
      help: "DialCache cache get latency in seconds.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer"],
      buckets: TIMER_BUCKETS,
    },
    fallbackTimer: {
      type: "histogram",
      name: `${prefix}dialcache_fallback_timer`,
      help: "Time spent in the underlying fallback function in seconds.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer"],
      buckets: TIMER_BUCKETS,
    },
    serializationTimer: {
      type: "histogram",
      name: `${prefix}dialcache_serialization_timer`,
      help: "DialCache serialization latency in seconds.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer", "operation"],
      buckets: TIMER_BUCKETS,
    },
    sizeHistogram: {
      type: "histogram",
      name: `${prefix}dialcache_size_histogram`,
      help: "Serialized DialCache value sizes in bytes.",
      labelNames: ["cache_namespace", "use_case", "key_type", "layer"],
      buckets: SIZE_BUCKETS,
    },
  } as const;
}

function validateExistingCollectors(registry: PrometheusRegistry, configs: readonly CollectorConfig[]): void {
  for (const config of configs) {
    const existing = registry.getSingleMetric(config.name);
    if (existing === undefined) {
      continue;
    }

    // prom-client exposes collector schema fields at runtime but omits them from its public class types.
    const collector = existing as unknown as CollectorShape;
    const compatible =
      collector.name === config.name &&
      collector.help === config.help &&
      collector.type === config.type &&
      collector.enableExemplars !== true &&
      arraysEqual(collector.labelNames, config.labelNames) &&
      (config.type === "counter" || arraysEqual(collector.buckets, config.buckets));
    if (!compatible) {
      throw new Error(
        `Prometheus collector "${config.name}" already exists with an incompatible schema. ` +
          "Use a unique prefix or a separate Registry.",
      );
    }
  }
}

function arraysEqual(actual: unknown, expected: readonly unknown[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => Object.is(value, expected[index]))
  );
}

function counter<T extends string>(
  registry: PrometheusRegistry,
  config: CounterCollectorConfig<T>,
): Counter<T> {
  const existing = registry.getSingleMetric(config.name) as Counter<T> | undefined;
  if (existing !== undefined) {
    return existing;
  }
  return new Counter<T>({
    name: config.name,
    help: config.help,
    labelNames: config.labelNames,
    registers: [registry],
  });
}

function histogram<T extends string>(
  registry: PrometheusRegistry,
  config: HistogramCollectorConfig<T>,
): Histogram<T> {
  const existing = registry.getSingleMetric(config.name) as Histogram<T> | undefined;
  if (existing !== undefined) {
    return existing;
  }
  return new Histogram<T>({
    name: config.name,
    help: config.help,
    labelNames: config.labelNames,
    buckets: [...config.buckets],
    registers: [registry],
  });
}
