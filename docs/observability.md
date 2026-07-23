# Observability

[Back to the README](../README.md)

Metrics are disabled unless a `DialCacheMetricsAdapter` is passed to the
constructor. `new DialCache()` does not import a metrics backend, register
collectors, or emit metrics.

DialCache provides first-party adapters for Prometheus and Datadog. Both use
caller-created, caller-owned clients and preserve one backend-neutral set of
bounded labels.

## Prometheus

Install `prom-client` separately:

```bash
pnpm add prom-client@^15.1.3
```

Create the registry your application owns, then pass an explicit adapter to
DialCache:

```ts
import { Registry } from "prom-client";
import { DialCache } from "dialcache";
import { createPrometheusDialCacheMetrics } from "dialcache/prometheus";

const registry = new Registry();

const dialcache = new DialCache({
  namespace: "users-api",
  metrics: createPrometheusDialCacheMetrics({
    registry,
    prefix: "myapp_",
  }),
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

The adapter requires a caller-owned `Registry`. It never uses the global
default registry, and it does not clear or otherwise own the registry
lifecycle.

Multiple adapters with the same registry and prefix reuse existing collectors
when their type, help, labels, histogram buckets, and exemplar mode match.
Adapter construction fails before registering anything if a same-name
collector has an incompatible schema. Use a unique prefix or separate registry
to resolve a collision.

### Prometheus metrics

The names below exclude the optional caller-selected prefix:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `dialcache_request_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache_miss_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache misses |
| `dialcache_disabled_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips by bounded reason |
| `dialcache_error_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache or fallback errors by bounded failure site |
| `dialcache_invalidation_counter` | Counter | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache_coalesced_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests split by request-local or process scope |
| `dialcache_get_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache_fallback_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the wrapped fallback settles or timeout rejection is delivered |
| `dialcache_serialization_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency in seconds |
| `dialcache_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

The disabled reasons are:

- `context`;
- `policy_disabled`;
- `invalid_ttl`;
- `invalid_ramp`;
- `ramped_down`; and
- `config_error`.

`policy_disabled` means that a process-local or remote layer has no effective
TTL after runtime overlays. This is an intentional policy result, including the
default when `defaultConfig` is omitted, rather than a configuration-loading
failure.

Every metric includes `cache_namespace`, even disabled-context,
key-construction, coalescing, and invalidation paths that do not have a
constructed key. Its value is `DialCacheConfig.namespace`, which defaults to
`urn`.

The `layer` label is:

- `request_local`;
- `local`, meaning process-local;
- `remote`; or
- `noop` for disabled-context, key-construction, and config-provider failures
  where no cache layer was reached.

The bounded `scope` label on `dialcache_coalesced_counter` distinguishes
`request_local` from `process`. `scope="process"` coordinates calls only within
one `DialCache` instance; separate instances in the same process do not share
in-flight state.

## Datadog

Install `hot-shots` separately:

```bash
pnpm add hot-shots@^17.0.0
```

Create the DogStatsD client your application owns, then pass it to the Datadog
adapter:

```ts
import StatsD from "hot-shots";
import { DialCache } from "dialcache";
import { createDatadogDialCacheMetrics } from "dialcache/datadog";

const dogStatsD = new StatsD({
  host: process.env.DD_AGENT_HOST,
  globalTags: {
    service: "users-api",
    env: process.env.DD_ENV ?? "development",
  },
  errorHandler: (error) =>
    logger.warn("DogStatsD error", { error }),
});

const dialcache = new DialCache({
  namespace: "users-api",
  metrics: createDatadogDialCacheMetrics({
    client: dogStatsD,
    observationMetricType: "distribution",
    namespace: "dialcache",
  }),
});

// Drain outstanding cache operations before application shutdown.
dogStatsD.close();
```

`hot-shots` is the supported and tested client, but the adapter depends only on
the exported `DatadogDogStatsDClient` structural interface.

DialCache does not:

- import or install `hot-shots`;
- create a client;
- flush buffers;
- close sockets; or
- otherwise own the client lifecycle.

### Distribution or histogram

`observationMetricType` is required.

Choose `"distribution"` when latency and size percentiles must aggregate across
hosts. Enable the desired distribution percentiles and aggregations in
Datadog.

Choose `"histogram"` when host-level histogram aggregation matches the existing
Datadog setup. The choice applies uniformly to all four duration and size
metrics. Both modes produce Datadog custom metrics.

Distribution volume scales with unique tag-value combinations. Datadog counts
five baseline aggregations per combination; enabling percentile aggregations
adds five more. Review
[Datadog's custom-metrics billing guidance](https://docs.datadoghq.com/account_management/billing/custom_metrics/)
before rollout.

Do not send both observation types under the same metric namespace. When
changing types, use a new namespace during migration so one metric identity
never mixes histogram and distribution points.

### Datadog namespaces

`DatadogMetricsOptions.namespace` is the metric-name namespace and defaults to
`dialcache`. It is separate from `DialCacheConfig.namespace`, the logical cache
namespace emitted as the `cache_namespace` tag.

The Datadog metric namespace must:

- start with a letter;
- contain only letters, numbers, underscores, and dot-separated non-empty
  segments; and
- produce final metric names no longer than 200 characters.

The adapter rejects invalid namespaces and overlong final names instead of
relying on client-side normalization.

A `hot-shots` `prefix` is applied after the adapter constructs the name. Include
that prefix when checking final length, and avoid accidentally combining it
with the adapter namespace. Client-level `globalTags` are appended by
`hot-shots`; the table below lists only tags added by DialCache.

### Datadog metrics

The adapter emits exact increments of `1` for counters and preserves seconds
and bytes without unit conversion:

| Metric | Type | Tags | Description |
| --- | --- | --- | --- |
| `dialcache.request.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache.miss.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache misses |
| `dialcache.disabled.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips by bounded reason |
| `dialcache.error.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache or fallback errors by bounded failure site |
| `dialcache.invalidation.count` | Count | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache.coalesced.count` | Count | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests by sharing scope |
| `dialcache.get.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache.fallback.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the wrapped fallback settles or timeout rejection is delivered |
| `dialcache.serialization.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency in seconds |
| `dialcache.serialization.size` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

Synchronous client throws are isolated by DialCache's fail-open metrics
boundary. Buffered transport failures happen outside that synchronous call.
Configure the DogStatsD client's error handling and shutdown behavior as part
of application ownership.

## Error categories

The `error` label reports the operation that failed instead of copying the
thrown value's class or `Error.name`:

| `error` | Meaning |
| --- | --- |
| `key_construction` | The cache-key selector or `DialCacheKey` construction failed |
| `config_resolution` | Runtime or layer configuration, or ramp resolution, failed |
| `cache_read` | A process-local or remote cache read failed |
| `cache_write` | A process-local or remote cache write failed |
| `serialization_load` | Deserializing a Redis payload failed |
| `serialization_dump` | Serializing a value for Redis failed |
| `invalidation` | Writing an invalidation watermark failed |
| `fallback` | The wrapped application function failed or exceeded its DialCache deadline |
| `unknown` | Reserved for a future failure site that cannot be classified otherwise |

These values are defined by the backend-neutral core and are identical for
every adapter.

Raw thrown values, error names, messages, cache ids, arguments, and Redis keys
are never included in labels. Operational errors still reach the configured
logger. `in_fallback` remains the explicit distinction between cache plumbing
and application fallback failures.

## Custom adapters

Implement `DialCacheMetricsAdapter` and pass it through
`new DialCache({ metrics })` for another telemetry backend.

Every backend-neutral label object exposes the logical namespace as camel-case
`cacheNamespace`. Map it to the backend's `cache_namespace` label or tag. This
field is present even when no key or cache layer was reached.

Synchronous adapter failures are isolated from cache behavior and application
fallbacks. Omit `metrics` to disable metrics entirely.
