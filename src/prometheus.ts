import { Counter, Histogram, type Registry } from "prom-client";

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
  readonly registry: Registry;
  readonly prefix?: string;
}

type CounterLabels = "use_case" | "key_type" | "layer";
type DisabledLabels = CounterLabels | "reason";
type ErrorLabels = CounterLabels | "error" | "in_fallback";
type SerializationLabels = CounterLabels | "operation";
type InvalidationLabels = "key_type" | "layer";
type CoalescedLabels = "use_case" | "key_type" | "scope";

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

    this.disabledCounter = counter(registry, {
      name: `${prefix}dialcache_disabled_counter`,
      help: "Requests where DialCache skipped a cache layer.",
      labelNames: ["use_case", "key_type", "layer", "reason"] as const,
    });
    this.missCounter = counter(registry, {
      name: `${prefix}dialcache_miss_counter`,
      help: "DialCache cache misses.",
      labelNames: ["use_case", "key_type", "layer"] as const,
    });
    this.requestCounter = counter(registry, {
      name: `${prefix}dialcache_request_counter`,
      help: "Total DialCache cache-layer requests.",
      labelNames: ["use_case", "key_type", "layer"] as const,
    });
    this.errorCounter = counter(registry, {
      name: `${prefix}dialcache_error_counter`,
      help: "Errors during DialCache cache operations or fallback execution.",
      labelNames: ["use_case", "key_type", "layer", "error", "in_fallback"] as const,
    });
    this.invalidationCounter = counter(registry, {
      name: `${prefix}dialcache_invalidation_counter`,
      help: "DialCache invalidation calls by key type and layer.",
      labelNames: ["key_type", "layer"] as const,
    });
    this.coalescedCounter = counter(registry, {
      name: `${prefix}dialcache_coalesced_counter`,
      help: "DialCache requests coalesced onto in-flight work by sharing scope.",
      labelNames: ["use_case", "key_type", "scope"] as const,
    });
    this.getTimer = histogram(registry, {
      name: `${prefix}dialcache_get_timer`,
      help: "DialCache cache get latency in seconds.",
      labelNames: ["use_case", "key_type", "layer"] as const,
      buckets: TIMER_BUCKETS,
    });
    this.fallbackTimer = histogram(registry, {
      name: `${prefix}dialcache_fallback_timer`,
      help: "Time spent in the underlying fallback function in seconds.",
      labelNames: ["use_case", "key_type", "layer"] as const,
      buckets: TIMER_BUCKETS,
    });
    this.serializationTimer = histogram(registry, {
      name: `${prefix}dialcache_serialization_timer`,
      help: "DialCache serialization latency in seconds.",
      labelNames: ["use_case", "key_type", "layer", "operation"] as const,
      buckets: TIMER_BUCKETS,
    });
    this.sizeHistogram = histogram(registry, {
      name: `${prefix}dialcache_size_histogram`,
      help: "Serialized DialCache value sizes in bytes.",
      labelNames: ["use_case", "key_type", "layer"] as const,
      buckets: SIZE_BUCKETS,
    });
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
    this.invalidationCounter.inc({ key_type: labels.keyType, layer: labels.layer });
  }

  coalesced(labels: CoalescedMetricLabels): void {
    this.coalescedCounter.inc({
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
    use_case: labels.useCase,
    key_type: labels.keyType,
    layer: labels.layer,
  };
}

function counter<T extends string>(
  registry: Registry,
  config: { readonly name: string; readonly help: string; readonly labelNames: readonly T[] },
): Counter<T> {
  return (registry.getSingleMetric(config.name) as Counter<T> | undefined) ??
    new Counter<T>({ ...config, registers: [registry] });
}

function histogram<T extends string>(
  registry: Registry,
  config: {
    readonly name: string;
    readonly help: string;
    readonly labelNames: readonly T[];
    readonly buckets: readonly number[];
  },
): Histogram<T> {
  return (registry.getSingleMetric(config.name) as Histogram<T> | undefined) ??
    new Histogram<T>({ ...config, buckets: [...config.buckets], registers: [registry] });
}
