# @rungalileo/gcache

TypeScript port of GCache. Milestone 5 ships explicit enabled contexts, stable key construction, local/Redis TTL caching, runtime config providers, gradual rollout ramp controls, request coalescing for active cache work after local misses, Prometheus-ready observability, and Redis watermark-based targeted invalidation.

> [!NOTE]
> TypeScript support is experimental for now. This package is intended for early validation and feedback before treating the API and operational behavior as stable.

## Install

```bash
pnpm add @rungalileo/gcache
# For Redis-backed caching:
pnpm add redis@~4.7.1
```

## Quick start

```ts
import { GCache, GCacheKeyConfig } from "@rungalileo/gcache";

const gcache = new GCache();

const getUser = gcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: GCacheKeyConfig.enabled(60),
  },
);

// Caching is OFF outside an enable() scope (see "Enabled context"), so this runs the fn uncached:
await getUser("123");

// Inside enable(), reads are cached. Enable once at your request boundary (not per call site):
const user = await gcache.enable(() => getUser("123"));
```

## Redis-backed TTL cache

Register GCache's native node-redis scripts when creating the client, then pass that client to GCache:

```ts
import { createClient } from "redis";
import { GCache, GCacheKeyConfig } from "@rungalileo/gcache";
import { createNodeRedisGCacheClient, gcacheRedisScripts } from "@rungalileo/gcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL,
  scripts: gcacheRedisScripts,
});
await redisClient.connect();

const gcache = new GCache({
  redis: {
    client: createNodeRedisGCacheClient(redisClient),
    keyPrefix: "gcache:",
  },
});
```

> [!IMPORTANT]
> The Lua protocol changes the experimental Redis client contract. Existing callers must wrap node-redis with `createNodeRedisGCacheClient`; raw command clients are no longer accepted by `redis.client` or `redis.createClient`. The former `RedisCommandClient`, `RedisStoredValue`, and `RedisValueEnvelope` exports have been replaced by the `GCacheRedisClient` semantic interface and its request/payload types.

When caching is enabled, reads flow through:

```text
local cache -> Redis cache -> fallback function
```

- Local hits return immediately.
- Local misses try Redis and populate local on a Redis hit.
- Redis misses call the fallback and write both Redis and local.
- Redis cache read/write failures are logged, counted in metrics, and fail open; fallback results still return when fallback succeeds. Explicit maintenance calls (`invalidateRemote`, `flushAll`) log/count Redis failures and rethrow them so callers do not assume mutation succeeded.
- Missing per-layer config disables that layer, records a disabled reason, and falls through to the next layer/fallback.

Node-redis computes each script's SHA, uses `EVALSHA`, and retries with `EVAL` after `NOSCRIPT`. Its cluster client routes scripts by their first key and performs that fallback on the selected shard. Tracked reads are deliberately routed to primaries so a lagging Redis replica cannot hide an invalidation watermark. The adapter also fans `flushAll()` across every cluster master instead of silently clearing one shard.

You can also provide a lazy factory that returns a script-enabled client:

```ts
const gcache = new GCache({
  redis: {
    createClient: async () => {
      const client = createClient({
        url: process.env.REDIS_URL,
        scripts: gcacheRedisScripts,
      });
      await client.connect();
      return createNodeRedisGCacheClient(client);
    },
  },
});
```

The core Redis boundary is the client-agnostic `GCacheRedisClient` interface. Other clients can implement that semantic interface without changing GCache; the raw Lua sources and wire constants are available from `@rungalileo/gcache/redis-protocol`, so a Valkey GLIDE adapter can be added without depending on node-redis. Custom adapters can use the root-exported `GCacheRedisPayloadError` and `GCacheRedisPayloadEncodingError` classes to preserve the standard metrics labels.

Redis values use a compact binary frame:

```text
byte 1      format version
bytes 2-9   Redis-created timestamp in milliseconds (uint64, big-endian)
byte 10     payload encoding (0 = UTF-8, 1 = base64)
bytes 11... serialized payload
```

Redis's Lua `struct` library packs and unpacks the timestamp. Redis TTL is authoritative, so expiry metadata is not duplicated in the frame. `payload` is produced by the cached function's serializer, or by `JsonSerializer` by default. Custom serializers can return either `string` or `Buffer`; Buffer payloads are base64 encoded and reconstructed before `serializer.load`.

## Targeted invalidation and watermarks

Mutable Redis-backed use cases can opt into targeted invalidation by setting `trackForInvalidation: true` in the options and calling `gcache.invalidateRemote(keyType, id)` after writes:

```ts
import { CacheLayer, GCache, GCacheKeyConfig } from "@rungalileo/gcache";
import { createNodeRedisGCacheClient } from "@rungalileo/gcache/node-redis";

const gcache = new GCache({ redis: { client: createNodeRedisGCacheClient(redisClient) } });

const getUser = gcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    // Strongly invalidated mutable data should usually disable local cache.
    defaultConfig: new GCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    }),
  },
);

await updateUser("123", patch);
await gcache.invalidateRemote("user_id", "123");
```

Invalidation writes a Redis watermark at `{encodedUrnPrefix:encodedKeyType:encodedId}#watermark`. Tracked Redis cache entries use the same Redis Cluster hash tag, for example `{urn:user_id:123}?locale=en#GetMutableUser:gcache-frame-v1`, so the value key and watermark key live in the same slot. Key components are percent-encoded before joining so delimiters inside IDs or args cannot collide with delimiters in the key format. Components may not contain `{` or `}` because those characters would corrupt the hash tag.

The internal `:gcache-frame-v1` suffix isolates binary values from the previous JSON representation during upgrades and rollbacks. Watermarks remain decimal timestamps so both formats can read them, but legacy invalidators use application clocks and can move a watermark backward. Deploy this wire-protocol change to every invalidating process before enabling tracked binary entries; mixed-version invalidation is not a supported steady state.

A cached Redis value whose Redis-created timestamp is older than or equal to the watermark is treated as stale and refreshed through fallback. `invalidateRemote(keyType, id, futureBufferMs)` sets the watermark to the greater of its existing value and Redis's current time plus the buffer. While that future window is active, fallback results are returned but not written to Redis or local cache.

Tracked writes create a baseline watermark and extend its TTL to at least the value TTL plus one minute. Invalidation preserves that lifetime and extends it to cover the future buffer. `DEFAULT_WATERMARK_TTL_SEC` (4 hours) remains a configurable floor rather than a maximum, and reads do not extend watermark lifetime.

`futureBufferMs` must be a nonnegative safe integer. Size it to cover the longest interval from invalidation until any fallback that could have read stale source data completes its Redis write. Include source-replication lag, remaining fallback work, `serializer.dump`, Redis client queue/network latency, script execution, and a safety margin. Invalidate after the source mutation commits. The buffer prevents stale fallback results from being cached under those assumptions; it does not itself force the current fallback to read from an authoritative source.

Local cache limitation: targeted invalidation is enforced by Redis watermarks. Existing local cache hits are not synchronously invalidated across processes, so strongly invalidated mutable data should disable the local layer (or use very short local TTLs only when stale reads are acceptable).

## Runtime config and ramp controls

Every cached function can provide a per-use-case `defaultConfig`; a `cacheConfigProvider` can override it at runtime. If the provider returns `null`, GCache falls back to the cached function's `defaultConfig`. If neither exists, or a layer's TTL/ramp is missing or disabled, only that layer is skipped.

`cacheConfigProvider` is called for every enabled cached-function invocation before GCache checks local or Redis. Keep it cheap, cache any remote/config-store reads inside the provider, and avoid work that would erase the benefit of a cache hit.

```ts
import { CacheLayer, GCache, GCacheKeyConfig } from "@rungalileo/gcache";

const gcache = new GCache({
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 30, [CacheLayer.REMOTE]: 300 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 25 },
      });
    }
    return null; // use the cached function's defaultConfig
  },
  rampSampler: ({ key, layer }) => deterministicPercentFor(`${key.urn}:${layer}`),
});
```

`ramp` values are percentages from 0 to 100. `0` disables the layer, `100` enables it, and intermediate values use `rampSampler`; the default sampler is deterministic by cache key and layer, so the same key is consistently sampled in or out of a partial rollout. Provider errors fail open and execute the fallback function.

## Request coalescing

When caching is enabled and a call misses local cache, concurrent callers for the same cache key share the same in-flight cache work. With Redis configured, the leader runs the Redis read and, on miss, the fallback/cache write; followers await that result. Local-only misses share the leader's fallback/cache write. This protects Redis and the source of truth from a thundering herd on hot keys.

Coalescing only applies after a real cache layer is active. Calls outside `enable()` are true pass-through, and calls where every layer is disabled by missing config, invalid TTL, or ramp are true pass-through.

Because coalescing is keyed by `cacheKey`, concurrent calls with the same key share the leader's execution. Any argument ignored by `cacheKey` must be safe to share this way; include inputs such as locale, auth context, or cancellation behavior in the key when they can change the returned value or whether the underlying function should run separately.

```ts
const getUser = gcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: GCacheKeyConfig.enabled(60),
  },
);
```

## Enabled context

Caching is **off by default** and only active inside a `gcache.enable(...)` scope. This is deliberate: it lets you turn caching **off in write paths** so a stale read can't be cached around a write. The TypeScript port uses Node `AsyncLocalStorage` to mirror Python's `with gcache.enable():` model.

**Enable once at your request boundary** (e.g. a middleware that wraps read-request handling) so individual call sites don't each need it; wrap mutation handlers in `disable()`:

```ts
await gcache.enable(async () => {
  await getUser("123"); // cached

  await gcache.disable(async () => {
    await updateUser("123", patch); // reads here are uncached
  });

  await getUser("123"); // cached again
});
```

- Default is disabled — a cached function called **outside** any `enable()` scope simply runs uncached (no error), so wrap your read paths to actually cache.
- Enabled state is async-scope-local, not process-global.
- Nested `enable` / `disable` scopes restore the previous behavior when the callback completes.

## Keys, ids, and extra dimensions

`cached(fn, options)` wraps a function; the wrapped callable has the same parameters and always returns a `Promise`. The cache key comes from a required `cacheKey` selector whose parameters are inferred from `fn`. Return a bare id, or return `{ id, args }` to extract a field or add secondary dimensions:

The `cacheKey` selector is the value identity contract. It must include every input dimension that can affect the returned value; otherwise distinct calls can reuse the same cached value or share the same in-flight fallback through request coalescing.

```ts
const searchPosts = gcache.cached(
  (userId: string, page: number, filter: string) => db.searchPosts(userId, page, filter),
  {
    keyType: "user_id",
    useCase: "SearchPosts",
    cacheKey: (userId, page, filter) => ({ id: userId, args: { page, filter } }),
    defaultConfig: GCacheKeyConfig.enabled(60),
  },
);
await gcache.enable(() => searchPosts("u1", 2, "active"));
```

- **`keyType` + `id` is the invalidation unit for tracked Redis entries.** `gcache.invalidateRemote("user_id", "123")` writes one watermark for that user; any `trackForInvalidation` Redis entry with the same `keyType` and `id` is refreshed across all `args` variants when Redis is read. Existing local hits follow the local-cache limitation above, and untracked Redis entries do not consult the watermark. `useCase` identifies the individual cache (it's the metrics label and part of the stored key).
- **`args` are part of the cache key** — different `args` produce different entries — but invalidation is by `id` only.
- **Non-key inputs** (for example a db handle) are simply parameters the `cacheKey` selector ignores. They still reach `fn` for non-coalesced executions, but concurrent same-key cache misses share the leader's execution, so do not ignore values like `AbortSignal`, auth context, locale, or other request-scoped inputs unless sharing one result is correct.
- **Methods:** pass `obj.method.bind(obj)` (or `(...a) => obj.method(...a)`) — a bare `obj.method` reference loses `this`.

## Metrics

GCache registers Prometheus metrics by default via `prom-client`. Metric names intentionally follow the Python package where practical:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `gcache_request_counter` | Counter | `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `gcache_miss_counter` | Counter | `use_case`, `key_type`, `layer` | Cache misses |
| `gcache_disabled_counter` | Counter | `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `missing_config`, `invalid_ttl`, `ramped_down`, `config_error`) |
| `gcache_error_counter` | Counter | `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors, with `in_fallback` separating cache plumbing failures from application fallback failures |
| `gcache_invalidation_counter` | Counter | `key_type`, `layer` | Invalidation calls for the layers touched today |
| `gcache_coalesced_counter` | Counter | `use_case`, `key_type` | Requests that awaited active in-flight cache work |
| `gcache_get_timer` | Histogram | `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `gcache_fallback_timer` | Histogram | `use_case`, `key_type`, `layer` | Time spent in the underlying function |
| `gcache_serialization_timer` | Histogram | `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `gcache_size_histogram` | Histogram | `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

The `layer` label is usually `local` or `remote`. Disabled-context, key-construction, and config-provider failures use `noop` because no cache layer was reached.

Use a custom registry or prefix when embedding GCache in an app with its own metrics endpoint:

```ts
import { Registry } from "prom-client";
import { GCache } from "@rungalileo/gcache";

const registry = new Registry();
const gcache = new GCache({
  metricsRegistry: registry,
  metricsPrefix: "myapp_", // myapp_gcache_request_counter, etc.
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

For non-Prometheus telemetry, inject a `GCacheMetricsAdapter` through `new GCache({ metrics })`. Pass `metrics: false` to disable metrics entirely. GCache reuses existing collectors in a registry so repeated instances with the same prefix do not throw duplicate-registration errors.

## Current scope

Included:

- Local TTL cache
- Redis TTL cache
- Local → Redis → fallback read-through chain
- Lazy Redis client factory support
- Lua-backed Redis reads and writes with Redis-generated timestamps
- Versioned binary Redis frames for UTF-8 and Buffer serializer output
- Native node-redis script registration with automatic `NOSCRIPT` recovery
- Standalone Redis, Valkey, and Redis Cluster support
- JSON and custom serializer support for Redis values
- Duplicate and reserved use-case validation
- `invalidateRemote` for Redis watermark invalidation and `flushAll` across configured layers
- Fail-open behavior for key/config/cache read-write errors; maintenance mutations surface failures
- Runtime config provider with fallback to cached-function `defaultConfig`
- Per-layer TTL and ramp controls
- Deterministic default ramp sampler with injectable override hooks
- Missing config disables only the relevant layer and falls through
- Prometheus metrics with duplicate-registration safety
- Custom metrics adapter/registry/prefix hooks
- Cache-vs-fallback error classification through the `in_fallback` label
- Serialization latency and cached payload size metrics for Redis values
- Logger injection for cache operational failures
- `trackForInvalidation` on cached functions
- `invalidateRemote(keyType, id, futureBufferMs)` Redis watermark API
- Redis Cluster hash-tagged value/watermark keys for invalidation-tracked entries
- Dynamically extended watermark TTL with a configurable `DEFAULT_WATERMARK_TTL_SEC` floor
- Future-buffer behavior that avoids cache writes during active invalidation windows
- Request coalescing for active cache work after local misses

Not included yet:

- Framework middleware helpers/integrations
- `cachedObject`
- Expanded examples
- Release hardening
