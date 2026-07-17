import type {
  CacheMetricLabels,
  CoalescedMetricLabels,
  DialCacheMetricsAdapter,
  DisabledMetricLabels,
  ErrorMetricLabels,
  InvalidationMetricLabels,
  SerializationMetricLabels,
} from "./metrics.js";

export type DatadogObservationMetricType = "histogram" | "distribution";

/**
 * The subset of the DogStatsD client API used by DialCache.
 *
 * hot-shots satisfies this interface, but callers may provide any compatible
 * client. DialCache never creates, flushes, or closes the client.
 */
export interface DatadogDogStatsDClient {
  increment(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  distribution(name: string, value: number, tags?: Record<string, string>): void;
}

export interface DatadogMetricsOptions {
  readonly client: DatadogDogStatsDClient;
  readonly observationMetricType: DatadogObservationMetricType;
  readonly namespace?: string;
}

type CacheTag = "use_case" | "key_type" | "layer";
type DatadogTags = Record<string, string>;
type Observation = (name: string, value: number, tags: DatadogTags) => void;

const DEFAULT_NAMESPACE = "dialcache";
const DATADOG_METRIC_NAME_MAX_LENGTH = 200;
const NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

const METRIC_SUFFIXES = {
  request: "request.count",
  miss: "miss.count",
  disabled: "disabled.count",
  error: "error.count",
  invalidation: "invalidation.count",
  coalesced: "coalesced.count",
  get: "get.duration",
  fallback: "fallback.duration",
  serialization: "serialization.duration",
  size: "serialization.size",
} as const;

type MetricName = keyof typeof METRIC_SUFFIXES;

export class DatadogDialCacheMetrics implements DialCacheMetricsAdapter {
  private readonly client: DatadogDogStatsDClient;
  private readonly metricNames: Readonly<Record<MetricName, string>>;
  private readonly observe: Observation;

  constructor(options: DatadogMetricsOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Datadog metrics options must be an object.");
    }

    const client = validateClient(options.client);
    const namespace = validateNamespace(options.namespace === undefined ? DEFAULT_NAMESPACE : options.namespace);
    const observationMetricType = validateObservationMetricType(options.observationMetricType);

    this.client = client;
    this.metricNames = metricNames(namespace);
    this.observe =
      observationMetricType === "distribution"
        ? (name, value, tags) => client.distribution(name, value, tags)
        : (name, value, tags) => client.histogram(name, value, tags);
  }

  request(labels: CacheMetricLabels): void {
    this.increment(this.metricNames.request, cacheTags(labels));
  }

  miss(labels: CacheMetricLabels): void {
    this.increment(this.metricNames.miss, cacheTags(labels));
  }

  disabled(labels: DisabledMetricLabels): void {
    this.increment(this.metricNames.disabled, { ...cacheTags(labels), reason: labels.reason });
  }

  error(labels: ErrorMetricLabels): void {
    this.increment(this.metricNames.error, {
      ...cacheTags(labels),
      error: labels.error,
      in_fallback: String(labels.inFallback),
    });
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.increment(this.metricNames.invalidation, {
      key_type: labels.keyType,
      layer: labels.layer,
    });
  }

  coalesced(labels: CoalescedMetricLabels): void {
    this.increment(this.metricNames.coalesced, {
      use_case: labels.useCase,
      key_type: labels.keyType,
      scope: labels.scope,
    });
  }

  observeGet(labels: CacheMetricLabels, seconds: number): void {
    this.observe(this.metricNames.get, seconds, cacheTags(labels));
  }

  observeFallback(labels: CacheMetricLabels, seconds: number): void {
    this.observe(this.metricNames.fallback, seconds, cacheTags(labels));
  }

  observeSerialization(labels: SerializationMetricLabels, seconds: number): void {
    this.observe(this.metricNames.serialization, seconds, {
      ...cacheTags(labels),
      operation: labels.operation,
    });
  }

  observeSize(labels: CacheMetricLabels, bytes: number): void {
    this.observe(this.metricNames.size, bytes, cacheTags(labels));
  }

  private increment(name: string, tags: DatadogTags): void {
    this.client.increment(name, 1, tags);
  }
}

export function createDatadogDialCacheMetrics(options: DatadogMetricsOptions): DialCacheMetricsAdapter {
  return new DatadogDialCacheMetrics(options);
}

function cacheTags(labels: CacheMetricLabels): Record<CacheTag, string> {
  return {
    use_case: labels.useCase,
    key_type: labels.keyType,
    layer: labels.layer,
  };
}

function validateClient(client: DatadogDogStatsDClient): DatadogDogStatsDClient {
  if (client === null || typeof client !== "object") {
    throw new TypeError("Datadog metrics client must be an object.");
  }

  for (const method of ["increment", "histogram", "distribution"] as const) {
    if (typeof client[method] !== "function") {
      throw new TypeError(`Datadog metrics client must implement ${method}().`);
    }
  }

  return client;
}

function validateObservationMetricType(value: DatadogObservationMetricType): DatadogObservationMetricType {
  if (value !== "histogram" && value !== "distribution") {
    throw new TypeError('Datadog observationMetricType must be either "histogram" or "distribution".');
  }
  return value;
}

function validateNamespace(namespace: string): string {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(
      "Datadog namespace must start with a letter and contain only letters, numbers, underscores, " +
        "and dot-separated non-empty segments.",
    );
  }
  return namespace;
}

function metricNames(namespace: string): Readonly<Record<MetricName, string>> {
  const entries = Object.entries(METRIC_SUFFIXES).map(([metric, suffix]) => {
    const name = `${namespace}.${suffix}`;
    if (name.length > DATADOG_METRIC_NAME_MAX_LENGTH) {
      throw new RangeError(
        `Datadog metric name "${name}" exceeds the ${DATADOG_METRIC_NAME_MAX_LENGTH}-character limit.`,
      );
    }
    return [metric, name] as const;
  });
  return Object.fromEntries(entries) as Record<MetricName, string>;
}
