# DialCache

Fine-grained TypeScript caching with explicit enabled contexts, stable key construction, local and Redis TTL caching, runtime rollout controls, request coalescing, Prometheus-ready observability, and Redis watermark-based targeted invalidation.

## Install

```bash
pnpm add dialcache
# Choose a Redis client when using the remote layer:
pnpm add redis@~4.7.1
# or
pnpm add @valkey/valkey-glide@^2.4.2
```

DialCache requires Node.js 20 or Node.js 22 and newer.

## Quick start

```ts
import { DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);

// Caching is OFF outside an enable() scope (see "Enabled context"), so this runs the fn uncached:
await getUser("123");

// Inside enable(), reads are cached. Enable once at your request boundary (not per call site):
const user = await dialcache.enable(() => getUser("123"));
```

## Redis-backed TTL cache

Register DialCache's native node-redis scripts when creating the client, then pass that client to DialCache:

```ts
import { createClient } from "redis";
import { DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL,
  scripts: dialcacheRedisScripts,
});
await redisClient.connect();

const dialcache = new DialCache({
  redis: {
    client: createNodeRedisDialCacheClient(redisClient),
    keyPrefix: "dialcache:",
  },
});
```

The `redis.client` and `redis.createClient` options accept the semantic `DialCacheRedisClient` interface. Node-redis users should register the supplied scripts and wrap their client with `createNodeRedisDialCacheClient` as shown above.

Valkey GLIDE users pass an already-created standalone or cluster client to the GLIDE adapter:

```ts
import { GlideClient } from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
});
const redisClient = createValkeyGlideDialCacheClient(glideClient);
const dialcache = new DialCache({
  redis: { client: redisClient, keyPrefix: "dialcache:" },
});

function shutdown(): void {
  // Release adapter-owned scripts before closing GLIDE.
  redisClient.dispose();
  glideClient.close();
}
```

DialCache does not create, connect, or close the underlying Redis client. After outstanding cache operations finish, the GLIDE adapter's `dispose()` method releases its five native `Script` handles; it is idempotent and does not close the wrapped GLIDE connection.

When caching is enabled, reads flow through:

```text
local cache -> Redis cache -> fallback function
```

- Local hits return immediately.
- Local misses try Redis and populate local on a Redis hit.
- Redis misses call the fallback and write both Redis and local.
- Redis cache read/write failures are logged, counted in metrics, and fail open; fallback results still return when fallback succeeds. Explicit maintenance calls (`invalidateRemote`, `flushAll`) log/count Redis failures and rethrow them so callers do not assume mutation succeeded.
- Missing per-layer config disables that layer, records a disabled reason, and falls through to the next layer/fallback.

The local layer uses one process-local LRU per `DialCache` instance. It keeps at most 10,000 entries by default across all use cases while retaining each entry's configured local TTL. Set `localMaxSize` to a nonnegative safe integer to change the global entry cap; `0` disables local storage:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory. Recently read entries stay resident ahead of less recently used entries when the limit is reached.

Node-redis computes each script's SHA, uses `EVALSHA`, and retries with `EVAL` after `NOSCRIPT`. Its cluster client routes scripts by their first key and performs that fallback on the selected shard. The GLIDE adapter uses GLIDE's native `Script` lifecycle and byte decoder; GLIDE routes scripts from their declared keys and the adapter broadcasts `flushAll()` to all cluster primaries. Tracked reads are deliberately routed to primaries so a lagging replica cannot hide an invalidation watermark.

You can also provide a lazy factory that returns a script-enabled client:

```ts
const dialcache = new DialCache({
  redis: {
    createClient: async () => {
      const client = createClient({
        url: process.env.REDIS_URL,
        scripts: dialcacheRedisScripts,
      });
      await client.connect();
      return createNodeRedisDialCacheClient(client);
    },
  },
});
```

The core Redis boundary is the client-agnostic `DialCacheRedisClient` interface. It exchanges serialized values as `string | Buffer` and does not expose client commands or wire encodings. Distinct untracked/tracked read and write Lua sources, the invalidation source, and wire constants are available from `dialcache/redis-protocol`. Custom adapters can use the root-exported `DialCacheRedisPayloadError` and `DialCacheRedisPayloadEncodingError` classes to preserve the standard metrics labels.

Redis values use a compact binary frame:

```text
byte 1      format version
bytes 2-9   Redis-created timestamp in milliseconds (uint64, big-endian)
byte 10     payload encoding (0 = UTF-8, 1 = raw binary)
bytes 11... serialized payload
```

Redis's Lua `struct` library packs and unpacks the timestamp. Redis TTL is authoritative, so expiry metadata is not duplicated in the frame. `payload` is produced by the cached function's serializer, or by `JsonSerializer` by default. Custom serializers can return either `string` or `Buffer`; strings are stored as UTF-8 and Buffers are stored byte-for-byte without base64 expansion. Adapters restore the same representation before calling `serializer.load`.

## Targeted invalidation and watermarks

Mutable Redis-backed use cases can opt into targeted invalidation by setting `trackForInvalidation: true` in the options and calling `dialcache.invalidateRemote(keyType, id)` after writes:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const dialcache = new DialCache({ redis: { client: createNodeRedisDialCacheClient(redisClient) } });

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    // Strongly invalidated mutable data should usually disable local cache.
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    }),
  },
);

await updateUser("123", patch);
await dialcache.invalidateRemote("user_id", "123");
```

Invalidation writes a Redis watermark at `{encodedUrnPrefix:encodedKeyType:encodedId}#watermark`. Tracked Redis cache entries use the same Redis Cluster hash tag, for example `{urn:user_id:123}?locale=en#GetMutableUser:dialcache-frame-v1`, so the value key and watermark key live in the same slot. Key components are percent-encoded before joining so delimiters inside IDs or args cannot collide with delimiters in the key format. Components may not contain `{` or `}` because those characters would corrupt the hash tag.

The internal `:dialcache-frame-v1` suffix identifies values written with DialCache's binary protocol. Watermarks are stored as decimal timestamps.

A cached Redis value whose Redis-created timestamp is older than or equal to the watermark is treated as stale and refreshed through fallback. `invalidateRemote(keyType, id, futureBufferMs)` sets the watermark to the greater of its existing value and Redis's current time plus the buffer. While that future window is active, fallback results are returned but not written to Redis or local cache.

Tracked writes create a baseline watermark and extend its TTL to at least the value TTL plus one minute. Invalidation preserves that lifetime and extends it to cover the future buffer. `DEFAULT_WATERMARK_TTL_SEC` (4 hours) remains a configurable floor rather than a maximum, and reads do not extend watermark lifetime.

`futureBufferMs` must be a nonnegative safe integer. Size it to cover the longest interval from invalidation until any fallback that could have read stale source data completes its Redis write. Include source-replication lag, remaining fallback work, `serializer.dump`, Redis client queue/network latency, script execution, and a safety margin. Invalidate after the source mutation commits. The buffer prevents stale fallback results from being cached under those assumptions; it does not itself force the current fallback to read from an authoritative source.

Local cache limitation: targeted invalidation is enforced by Redis watermarks. Existing local cache hits are not synchronously invalidated across processes, so strongly invalidated mutable data should disable the local layer (or use very short local TTLs only when stale reads are acceptable).

## Runtime config and ramp controls

Every cached function can provide a per-use-case `defaultConfig`; a `cacheConfigProvider` can override it at runtime. If the provider returns `null`, DialCache falls back to the cached function's `defaultConfig`. If neither exists, or a layer's TTL/ramp is missing or disabled, only that layer is skipped.

`cacheConfigProvider` is called for every enabled cached-function invocation before DialCache checks local or Redis. Keep it cheap, cache any remote/config-store reads inside the provider, and avoid work that would erase the benefit of a cache hit.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new DialCacheKeyConfig({
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
const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);
```

## Enabled context

Caching is **off by default** and only active inside a `dialcache.enable(...)` scope. This is deliberate: it lets you turn caching **off in write paths** so a stale read can't be cached around a write. DialCache uses Node `AsyncLocalStorage` to keep enabled state scoped to the current asynchronous call chain.

**Enable once at your request boundary** (e.g. a middleware that wraps read-request handling) so individual call sites don't each need it; wrap mutation handlers in `disable()`:

```ts
await dialcache.enable(async () => {
  await getUser("123"); // cached

  await dialcache.disable(async () => {
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
const searchPosts = dialcache.cached(
  (userId: string, page: number, filter: string) => db.searchPosts(userId, page, filter),
  {
    keyType: "user_id",
    useCase: "SearchPosts",
    cacheKey: (userId, page, filter) => ({ id: userId, args: { page, filter } }),
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);
await dialcache.enable(() => searchPosts("u1", 2, "active"));
```

- **`keyType` + `id` is the invalidation unit for tracked Redis entries.** `dialcache.invalidateRemote("user_id", "123")` writes one watermark for that user; any `trackForInvalidation` Redis entry with the same `keyType` and `id` is refreshed across all `args` variants when Redis is read. Existing local hits follow the local-cache limitation above, and untracked Redis entries do not consult the watermark. `useCase` identifies the individual cache (it's the metrics label and part of the stored key).
- **`args` are part of the cache key** — different `args` produce different entries — but invalidation is by `id` only.
- **Non-key inputs** (for example a db handle) are simply parameters the `cacheKey` selector ignores. They still reach `fn` for non-coalesced executions, but concurrent same-key cache misses share the leader's execution, so do not ignore values like `AbortSignal`, auth context, locale, or other request-scoped inputs unless sharing one result is correct.
- **Methods:** pass `obj.method.bind(obj)` (or `(...a) => obj.method(...a)`) — a bare `obj.method` reference loses `this`.

## Metrics

DialCache registers Prometheus metrics by default via `prom-client`:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `dialcache_request_counter` | Counter | `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache_miss_counter` | Counter | `use_case`, `key_type`, `layer` | Cache misses |
| `dialcache_disabled_counter` | Counter | `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `missing_config`, `invalid_ttl`, `ramped_down`, `config_error`) |
| `dialcache_error_counter` | Counter | `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors, with `in_fallback` separating cache plumbing failures from application fallback failures |
| `dialcache_invalidation_counter` | Counter | `key_type`, `layer` | Invalidation calls for the layers touched today |
| `dialcache_coalesced_counter` | Counter | `use_case`, `key_type` | Requests that awaited active in-flight cache work |
| `dialcache_get_timer` | Histogram | `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache_fallback_timer` | Histogram | `use_case`, `key_type`, `layer` | Time spent in the underlying function |
| `dialcache_serialization_timer` | Histogram | `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `dialcache_size_histogram` | Histogram | `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

The `layer` label is usually `local` or `remote`. Disabled-context, key-construction, and config-provider failures use `noop` because no cache layer was reached.

Use a custom registry or prefix when embedding DialCache in an app with its own metrics endpoint:

```ts
import { Registry } from "prom-client";
import { DialCache } from "dialcache";

const registry = new Registry();
const dialcache = new DialCache({
  metricsRegistry: registry,
  metricsPrefix: "myapp_", // myapp_dialcache_request_counter, etc.
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

For non-Prometheus telemetry, inject a `DialCacheMetricsAdapter` through `new DialCache({ metrics })`. Pass `metrics: false` to disable metrics entirely. DialCache reuses existing collectors in a registry so repeated instances with the same prefix do not throw duplicate-registration errors.

## Current scope

Included:

- Local TTL/LRU cache with a global entry-count bound
- Redis TTL cache
- Local → Redis → fallback read-through chain
- Lazy Redis client factory support
- Lua-backed Redis reads and writes with Redis-generated timestamps
- Versioned binary Redis frames for UTF-8 and Buffer serializer output
- Native node-redis script registration with automatic `NOSCRIPT` recovery
- Native Valkey GLIDE adapter with explicit script disposal and automatic script-cache recovery
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

## Releasing

Publishing is driven manually from the `Release` workflow in GitHub Actions. Run it from `main`; the workflow rejects any other ref or a stale main commit. It calculates the next patch version from the highest stable `vX.Y.Z` tag, using the `package.json` version as the seed when no release tag exists. For example, the current `0.1.0` seed produces the first `v0.1.1` release, followed by `v0.1.2`.

Every release is a patch bump. Semantic PR-title prefixes such as `feat:`, `fix:`, and `docs:` remain in the generated release notes but do not change the version magnitude. After validating, building, and package-testing the release artifact, the workflow creates a draft GitHub release, publishes the public npm package with provenance, and publishes the GitHub release only after npm succeeds.

The first publish requires a granular npm token in the repository's `NPM_TOKEN` secret because npm trusted publishing can only be configured after the package exists. After the bootstrap release, configure `lan17/DialCache` and `release.yaml` as the package's trusted GitHub publisher, then remove the long-lived token.
