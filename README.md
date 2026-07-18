# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)

Fine-grained TypeScript caching with explicit enabled contexts, request-local memoization, process-local and Redis TTL caching, stable key construction, runtime rollout controls, request coalescing, adapter-based observability, and Redis watermark-based targeted invalidation.

## Install

```bash
pnpm add dialcache
# Choose a Redis client when using the remote layer:
pnpm add redis@~4.7.1
# or
pnpm add @valkey/valkey-glide@^2.4.2
# Add a metrics client only when using its adapter:
pnpm add prom-client@^15.1.3
# or
pnpm add hot-shots@^17.0.0
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

// Inside enable(), reads are cached:
const user = await dialcache.enable(() => getUser("123"));
```

## Request-local cache

Set `requestLocal: true` to memoize resolved values for the lifetime of the outermost `enable()` scope:

```ts
import { DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();
const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
  },
);
```

`requestLocal` is a runtime boolean rather than a TTL/ramp-controlled `CacheLayer`. The `cacheConfigProvider` can turn it on or off for each invocation. `DialCacheKeyConfig.enabled(ttlSec)` continues to enable only process-local and Redis caching, so request-local caching must be selected explicitly.

DialCache resolves the runtime config once per enabled invocation and uses it for the entire lookup. When `requestLocal` is missing or false, the invocation skips request-local lookup and storage without deleting an entry already memoized in the scope. A later invocation that enables request-local caching can reuse that entry.

The outermost `enable()` call owns the request-local lifetime, and nested `enable()` calls reuse that scope. Request-local state is allocated lazily, only when an invocation enables the layer, so scopes that use only process-local or Redis caching do not allocate it.

Wrap the complete Node HTTP handler so the request-local scope matches the handler's lifetime:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  void dialcache
    .enable(async () => {
      const user = await getUser(readUserId(req));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(user));
    })
    .catch((error: unknown) => handleRequestError(error, res));
});
```

Request-local storage has no capacity limit, eviction, or overflow mode. Entries are retained until the outermost `enable()` callback settles. Use it for short-lived scopes with bounded key cardinality; split long-running streams or large batch jobs into smaller scopes when necessary.

## Process-local cache

The process-local layer (`CacheLayer.LOCAL`) uses one LRU per `DialCache` instance. It keeps at most 10,000 entries by default across all use cases while retaining each entry's configured TTL. Set `localMaxSize` to a nonnegative safe integer to change the global entry cap; `0` disables process-local storage:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory. Recently read entries stay resident ahead of less recently used entries when the limit is reached.

## Redis-backed TTL cache

Register DialCache's native node-redis scripts when creating the client, then pass that client to DialCache:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL,
  scripts: dialcacheRedisScripts,
});
await redisClient.connect();

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
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
  namespace: "users-api",
  redis: { client: redisClient },
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
request-local cache -> process-local cache -> Redis cache -> fallback function
```

- Request-local hits return the value memoized in the current outermost `enable()` scope.
- Results from the lower chain are memoized request-locally when that layer is enabled.
- Process-local hits return immediately.
- Process-local misses try Redis and populate the process-local cache on a Redis hit.
- Redis misses call the fallback and write both Redis and the process-local cache.
- Redis cache read/write failures are logged, counted in metrics, and fail open; fallback results still return when fallback succeeds. `invalidateRemote` logs/counts Redis failures and rethrows them so callers do not assume invalidation succeeded.
- Missing process-local/Redis TTL or ramp config disables that layer, records a disabled reason, and falls through to the next layer/fallback.

Node-redis computes each script's SHA, uses `EVALSHA`, and retries with `EVAL` after `NOSCRIPT`. Its cluster client routes scripts by their first key and performs that fallback on the selected shard. The GLIDE adapter uses GLIDE's native `Script` lifecycle and byte decoder; GLIDE routes scripts from their declared keys. Tracked reads are deliberately routed to primaries so a lagging replica cannot hide an invalidation watermark.

You can also provide a lazy factory that returns a script-enabled client:

```ts
const dialcache = new DialCache({
  namespace: "users-api",
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

### Serialization

The core Redis boundary is the client-agnostic `DialCacheRedisClient` interface. It exchanges serialized values as `string | Buffer` and does not expose client commands or wire encodings. Distinct untracked/tracked read and write Lua sources, the invalidation source, and wire constants are available from `dialcache/redis-protocol`. Custom adapters can use the root-exported `DialCacheRedisPayloadError` and `DialCacheRedisPayloadEncodingError` classes to preserve the standard metrics labels.

Redis values use a compact binary frame:

```text
byte 1      format version
bytes 2-9   Redis-created timestamp in milliseconds (uint64, big-endian)
byte 10     payload encoding (0 = UTF-8, 1 = raw binary)
bytes 11... serialized payload
```

Redis's Lua `struct` library packs and unpacks the timestamp. Redis TTL is authoritative, so expiry metadata is not duplicated in the frame. `payload` is produced by the cached function's serializer, or by `JsonSerializer` by default. Custom serializers can return either `string` or `Buffer`; strings are stored as UTF-8 and Buffers are stored byte-for-byte without base64 expansion. Adapters restore the same representation before calling `serializer.load`.

DialCache uses native `JSON.stringify` and `JSON.parse` by default. There is no runtime validation pass, so the default adds no traversal beyond JSON serialization itself. A top-level `undefined` result is supported with an internal sentinel.

When `serializer.load` rejects a Redis payload, DialCache records a `serialization_load` error, counts the read as a remote cache miss, runs the fallback, and attempts to replace the rejected payload. A validating custom serializer can therefore treat an incompatible cached value as a refreshable miss without adding a schema version to the cache key.

`JsonSerializer` validates JSON syntax only. It cannot detect that a structurally valid payload came from an incompatible application value schema. Applications that keep the same `useCase` across deployments must keep default-JSON values backward compatible. For an incompatible change, either provide a serializer whose `load` method validates and rejects the old shape, or change `useCase` to isolate the new cache entries. During a mixed deployment, mutually incompatible validating serializers can repeatedly reject and replace each other's values; correctness is preserved, but expect additional fallback and Redis-write load until the rollout converges.

When a cached function's resolved return type is statically JSON-compatible, `serializer` remains optional. This includes JSON primitives, arrays, plain object/interface shapes, optional object fields, and a top-level `undefined`. Types known not to survive the default round trip require a per-function `Serializer<T>`:

```ts
import { DialCache, type Serializer } from "dialcache";

const dialcache = new DialCache();
const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};

const getUpdatedAt = dialcache.cached(
  (userId: string) => db.fetchUpdatedAt(userId),
  {
    keyType: "user_id",
    useCase: "GetUpdatedAt",
    cacheKey: (userId) => userId,
    serializer: dateSerializer,
  },
);
```

The compile-time guard rejects known incompatible shapes such as `Date`, `Map`, `Set`, `bigint`, symbols, functions, Buffers, typed arrays, method-bearing class instances, required nested `undefined`, `unknown`, and `any`. It applies to every `cached()` declaration because active layers are selected at runtime. A global Redis serializer is not parameterized by each cached return type, so it cannot discharge this requirement; non-JSON functions must select a typed per-function serializer.

This guard is deliberately conservative and is not a proof of runtime data. TypeScript cannot detect non-finite numbers, cyclic/shared references, runtime getter or `toJSON` behavior, or data-only class instances that look like plain objects. Opaque, generic, or deeply recursive types may also require an explicit serializer. Providing `Serializer<T>` (including an explicitly typed `JsonSerializer<T>`) is a trusted caller assertion; DialCache does not serialize-and-deserialize again to validate it.

## Targeted invalidation and watermarks

Mutable Redis-backed use cases can opt into targeted invalidation by setting `trackForInvalidation: true` in the options and calling `dialcache.invalidateRemote(keyType, id, futureBufferMs)` after writes. The buffer is an application-owned safety value; DialCache cannot choose a universally safe nonzero value:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
});

// Chosen from this application's measured worst-case source and fallback timings.
const USER_INVALIDATION_BUFFER_MS = 5_000;

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    // Strongly invalidated mutable data should disable request-local and process-local caching.
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    }),
  },
);

await updateUser("123", patch);
await dialcache.invalidateRemote("user_id", "123", USER_INVALIDATION_BUFFER_MS);
```

Invalidation writes a Redis watermark at `{encodedNamespace:encodedKeyType:encodedId}#watermark`. Tracked Redis cache entries use the same Redis Cluster hash tag, for example `{users-api:user_id:123}?locale=en#GetMutableUser:dialcache-frame-v1`, so the value key and watermark key live in the same slot. Key components are percent-encoded before joining so delimiters inside IDs or args cannot collide with delimiters in the key format. Components may not contain `{` or `}` because those characters would corrupt the hash tag.

The internal `:dialcache-frame-v1` suffix identifies values written with DialCache's binary protocol. Watermarks are stored as decimal timestamps.

A cached Redis value whose Redis-created timestamp is older than or equal to the watermark is treated as stale and refreshed through fallback. `invalidateRemote(keyType, id, futureBufferMs)` sets the watermark to the greater of its existing value and Redis's current time plus the buffer. While that future window is active, an invocation that reaches the tracked Redis read treats the covered value as a miss. If its fallback then reaches the tracked Redis write, Redis rejects the write and DialCache also suppresses the corresponding process-local population; the fallback value still returns to its caller. Request-local memoization remains unconditional, and invocations whose remote layer is disabled or ramped out do not consult the watermark and are not fenced by it.

Tracked writes create a baseline watermark and extend its TTL to at least the value TTL plus one minute. Invalidation preserves that lifetime and extends it to cover the future buffer. `DEFAULT_WATERMARK_TTL_SEC` (4 hours) remains a configurable floor rather than a maximum, and reads do not extend watermark lifetime.

`futureBufferMs` must be a nonnegative safe integer. The default remains zero for backward compatibility, but zero provides no stale-publication protection once Redis time advances. Every production invalidation should pass a named, application-owned nonzero value based on that application's measured or conservatively bounded timings; there is no universally safe library value.

Size the buffer to cover the complete interval in which stale data could still reach the Redis write: source visibility or replication lag, plus the full remaining tail of any fallback that may already have observed the pre-mutation value, `serializer.dump`, Redis client queue and network latency, Lua script execution, the write itself, and a safety margin. Invalidate only after the source mutation commits. Underestimating this interval can allow a delayed stale fallback to repopulate Redis after the watermark window ends. Overestimating it lengthens the tracked Redis miss/write-suppression window described above, increasing fallback load without publishing stale values. A larger buffer does not delay or suppress returning fallback values to callers.

This is a timing contract rather than a cancellation or acquisition fence: the buffer prevents stale fallback results from passing that tracked Redis write only while the configured window remains active, and it does not force a fallback to read from an authoritative source.

Targeted invalidation is remote-only and enforced by Redis watermarks. `invalidateRemote` does not evict existing request-local or process-local entries. Strongly invalidated mutable data should disable request-local and process-local caching (or use a very short process-local TTL only when stale reads are acceptable).

## Runtime config and ramp controls

Every cached function can provide a per-use-case `defaultConfig`; a `cacheConfigProvider` can override it at runtime. If the provider returns `null`, DialCache falls back to the cached function's `defaultConfig`. If neither exists, or a layer's TTL/ramp is missing or disabled, only that layer is skipped.

`cacheConfigProvider` is called for every enabled cached-function invocation before DialCache performs any cache lookup. Keep it cheap, cache any remote/config-store reads inside the provider, and avoid work that would erase the benefit of a cache hit.

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

DialCache coalesces in-flight work at the lifetime of the first active cache layer:

- When request-local caching is enabled, same-key callers in one outermost `enable()` scope share request-scoped in-flight work before the request-local lookup. Its resolved value is then memoized for later sequential calls in that scope.
- When process-local or Redis caching is enabled, same-key callers share in-flight work within one `DialCache` instance before the first active shared layer. This is reported as `scope="process"`, still applies when request-local caching is off, and can combine leaders from separate request scopes using the same instance.

With Redis configured, an instance-scoped leader that misses the process-local cache runs the Redis read and, on miss, the fallback/cache write; followers await that result. Process-local-only misses share the leader's fallback/cache write. This protects Redis and the source of truth from a thundering herd on hot keys.

Coalescing only applies when at least one cache layer is active. Calls outside `enable()` are true pass-through, and calls where request-local, process-local, and Redis are all disabled are true pass-through.

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
- Nested `enable` / `disable` scopes restore the previous behavior when the callback completes. Nested `enable()` calls reuse the outer request-local scope rather than creating a new one.

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

`DialCacheConfig.namespace` is the logical cache namespace and the first component of every key. It defaults to `"urn"`, so omitting it preserves keys such as `urn:user_id:123#GetUser`. Set a stable application-specific value when multiple applications may use the same Redis deployment:

```ts
const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});
```

That produces Redis keys beginning with `users-api:...`, or `{users-api:...}` for invalidation-tracked values. `namespace` is DialCache's single cache-identity and key-partitioning setting: it participates in request-local, process-local, Redis, coalescing, deterministic ramp, invalidation, and metrics. It may not contain `{` or `}` because DialCache reserves those characters for Redis Cluster hash tags.

- **`keyType` + `id` is the invalidation unit for tracked Redis entries.** `dialcache.invalidateRemote("user_id", "123", USER_INVALIDATION_BUFFER_MS)` writes one watermark for that user; any `trackForInvalidation` Redis entry with the same `keyType` and `id` is refreshed across all `args` variants when Redis is read. Existing request-local and process-local hits follow the limitation above, and untracked Redis entries do not consult the watermark. `useCase` identifies the individual cache (it's the metrics label and part of the stored key).
- **`args` are part of the cache key** — different `args` produce different entries — but invalidation is by `id` only.
- **Scalar key equality is string-based.** Runtime type is not an identity dimension: for matching surrounding dimensions, numeric `1`, string `"1"`, and bigint `1n` identify the same key; argument values `null` and `"null"` also match. `-0` matches `0`, and an `undefined` argument is omitted. If a deployment changes the logical meaning represented by a scalar, change an explicit identity dimension such as `keyType`, `useCase`, or an argument name/value.
- **Non-key inputs** (for example a db handle) are simply parameters the `cacheKey` selector ignores. They still reach `fn` for non-coalesced executions, but concurrent same-key cache misses share the leader's execution, so do not ignore values like `AbortSignal`, auth context, locale, or other request-scoped inputs unless sharing one result is correct.
- **Methods:** pass `obj.method.bind(obj)` (or `(...a) => obj.method(...a)`) — a bare `obj.method` reference loses `this`.

### Migrating to `namespace`

The public `urnPrefix` option and `DialCacheKey.urnPrefix` property were renamed to `namespace`. For callers that did not configure `redis.keyPrefix`, replacing the property name while keeping the same value preserves generated key bytes, invalidation watermarks, deterministic ramp cohorts, and cache behavior:

```ts
// Before
new DialCache({ urnPrefix: "users-api", redis: { client: redisClient } });

// After
new DialCache({ namespace: "users-api", redis: { client: redisClient } });
```

Callers that omitted `urnPrefix` can continue omitting `namespace`; both defaults are `"urn"`. TypeScript rejects the removed property. The `DialCache` constructor throws `DialCacheConfig.urnPrefix was renamed to "namespace"`, and direct `DialCacheKey` construction throws `DialCacheKeyInit.urnPrefix was renamed to "namespace"`, when an untyped or JavaScript caller still supplies it. These errors prevent a custom legacy value from silently falling back to `urn`.

`redis.keyPrefix` was removed so `namespace` is the only public cache-partitioning control. TypeScript rejects the removed Redis option, and untyped or JavaScript construction throws `RedisConfig.keyPrefix was removed; use DialCacheConfig.namespace for cache identity`. Move any required application or environment separation into a stable namespace such as `production-users-api`.

Changing the namespace value intentionally creates a cold-cache boundary across every layer. Removing a previous Redis key prefix also changes the remote key bytes even if the namespace value stays the same. Old and new keyspaces do not share Redis values or invalidation watermarks. During an overlapping deployment, an invalidation handled by one version is invisible to the other, which can continue serving a stale tracked value until its value TTL expires. If remote invalidation correctness matters, a normal rolling deployment is unsafe: use a coordinated no-overlap cutover, or an operational bridge that prevents both versions from serving remote cache across mutations (for example, temporarily disable and clear remote caching during the transition). After the cutover, provision for fallback/refill load and allow old Redis keys to expire by TTL.

## Cached-value ownership

Treat values returned by cached functions as immutable. DialCache does not clone or freeze values stored in request-local or process-local memory. Mutating a cached object can therefore be observed by later callers in the same request, callers in other requests that hit the process-local cache, or callers that coalesced onto the same in-flight result.

This contract includes nested objects and arrays, `Map`, `Set`, `Buffer`, typed arrays, and class instances. Redis deserialization can produce a different reference from an in-memory hit, so reference identity is layer-dependent and is not part of the API contract; never rely on a specific layer cloning a value before mutation.

If a caller needs a mutable value, copy it explicitly before changing it:

```ts
const sharedUser = await getUser("123");
const editableUser = structuredClone(sharedUser);
editableUser.displayName = "New name";
```

Use a narrower copy when its semantics are sufficient; the ownership boundary is the caller's responsibility.

## Metrics

Metrics are disabled unless a `DialCacheMetricsAdapter` is passed to the constructor. `new DialCache()` does not import a metrics backend, register collectors, or emit metrics.

### Prometheus

Install `prom-client` separately, create the registry your application owns, and pass the explicit Prometheus adapter to DialCache:

```bash
pnpm add prom-client@^15.1.3
```

```ts
import { Registry } from "prom-client";
import { DialCache } from "dialcache";
import { createPrometheusDialCacheMetrics } from "dialcache/prometheus";

const registry = new Registry();
const dialcache = new DialCache({
  namespace: "users-api",
  metrics: createPrometheusDialCacheMetrics({
    registry,
    prefix: "myapp_", // myapp_dialcache_request_counter, etc.
  }),
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

The adapter requires a caller-owned `Registry`; it never uses the global default registry and does not clear or otherwise own the registry lifecycle. Multiple adapters with the same registry and prefix reuse existing collectors when their type, help, labels, histogram buckets, and exemplar mode match. Adapter construction fails before registering anything if a same-name collector has an incompatible schema; use a unique prefix or a separate registry to resolve the collision.

The Prometheus adapter emits:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `dialcache_request_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache_miss_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache misses |
| `dialcache_disabled_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `missing_config`, `invalid_ttl`, `ramped_down`, `config_error`) |
| `dialcache_error_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors classified by a bounded failure site |
| `dialcache_invalidation_counter` | Counter | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched today |
| `dialcache_coalesced_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests split by `request_local` or `process` scope |
| `dialcache_get_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache_fallback_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Time spent in the underlying function |
| `dialcache_serialization_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `dialcache_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

Every metric carries `cache_namespace`, including disabled-context, key-construction, coalescing, and invalidation paths that do not have a constructed key. Its value is `DialCacheConfig.namespace`, defaulting to `urn`. The `layer` label is `request_local`, `local` (process-local), or `remote`. Disabled-context, key-construction, and config-provider failures use `noop` because no cache layer was reached. The bounded `scope` label on `dialcache_coalesced_counter` distinguishes request-local from instance-scoped single-flight work. `scope="process"` coordinates calls only within one `DialCache` instance; separate instances in the same process do not share in-flight state.

Metric names are unchanged, but `cache_namespace` is a new required label/tag on every series. Update dashboards and alerts that enumerate exact label sets. A Prometheus registry containing collectors created by an older DialCache adapter has an incompatible schema; construct the upgraded adapter in a fresh registry/process, or use a new adapter prefix during an in-process migration.

### Datadog

Install `hot-shots` separately, create the DogStatsD client your application owns, and pass it to the Datadog adapter:

```bash
pnpm add hot-shots@^17.0.0
```

```ts
import StatsD from "hot-shots";
import { DialCache } from "dialcache";
import { createDatadogDialCacheMetrics } from "dialcache/datadog";

const dogStatsD = new StatsD({
  host: process.env.DD_AGENT_HOST,
  globalTags: { service: "users-api", env: process.env.DD_ENV ?? "development" },
  errorHandler: (error) => logger.warn("DogStatsD error", { error }),
});

const dialcache = new DialCache({
  namespace: "users-api", // cache identity and cache_namespace tag
  metrics: createDatadogDialCacheMetrics({
    client: dogStatsD,
    observationMetricType: "distribution",
    namespace: "dialcache", // metric-name prefix: dialcache.request.count, etc.
  }),
});

// After outstanding cache operations finish during application shutdown:
dogStatsD.close();
```

`hot-shots` is the supported and tested client, but the adapter depends only on the exported `DatadogDogStatsDClient` structural interface. DialCache does not import or install `hot-shots`, create a client, flush buffers, close sockets, or otherwise own the client lifecycle.

`observationMetricType` is required. `"distribution"` is recommended when latency and size percentiles must aggregate across hosts; enable the desired distribution percentiles and aggregations in Datadog. Choose `"histogram"` when host-level histogram aggregation matches your existing Datadog setup. The choice applies uniformly to all four duration/size metrics. Both modes produce Datadog custom metrics. Distribution volume scales with unique tag-value combinations: Datadog counts five baseline aggregations per combination, and enabling percentile aggregations adds five more. Review [Datadog's custom-metrics billing guidance](https://docs.datadoghq.com/account_management/billing/custom_metrics/) before rollout. Do not send both types under the same namespace: when changing types, use a new namespace during migration so one metric identity never mixes histogram and distribution points.

`DatadogMetricsOptions.namespace` is the metric-name namespace and defaults to `dialcache`. It is separate from `DialCacheConfig.namespace`, the logical cache namespace emitted as the `cache_namespace` tag. The Datadog metric namespace must start with a letter and contain only letters, numbers, underscores, and dot-separated non-empty segments. The adapter rejects invalid metric namespaces and final metric names longer than 200 characters rather than relying on client-side normalization. A `hot-shots` `prefix` is applied after the adapter constructs the name, so include that prefix when checking the final length and avoid combining it with the metric namespace accidentally. Client-level `globalTags` are appended by `hot-shots`; the table below lists the tags added by the adapter.

The Datadog adapter emits exact increments of `1` for counters and preserves seconds and bytes without unit conversion:

| Metric | Type | Tags | Description |
| --- | --- | --- | --- |
| `dialcache.request.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache.miss.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache misses |
| `dialcache.disabled.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips by bounded reason |
| `dialcache.error.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors by bounded failure site |
| `dialcache.invalidation.count` | Count | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache.coalesced.count` | Count | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests by sharing scope |
| `dialcache.get.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache.fallback.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Time spent in the underlying function in seconds |
| `dialcache.serialization.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency in seconds |
| `dialcache.serialization.size` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

Synchronous client throws are isolated by DialCache's fail-open metrics boundary. Buffered transport failures happen outside that synchronous call, so configure the DogStatsD client's error handling and shutdown behavior as part of application ownership.

### Error categories

The `error` label reports where an operation failed rather than copying the thrown value's class or `Error.name`:

| `error` | Meaning |
| --- | --- |
| `key_construction` | The cache-key selector or `DialCacheKey` construction failed |
| `config_resolution` | Runtime or layer configuration, or ramp resolution, failed |
| `cache_read` | A local-cache or Redis read failed |
| `cache_write` | A local-cache or Redis write failed |
| `serialization_load` | Deserializing a Redis payload failed |
| `serialization_dump` | Serializing a value for Redis failed |
| `invalidation` | Writing an invalidation watermark failed |
| `fallback` | The wrapped application function failed |
| `unknown` | Reserved for an otherwise unclassified future failure site |

These values are defined by the backend-neutral core and are identical for every metrics adapter. Raw thrown values, error names, messages, cache IDs, arguments, and Redis keys are never included in metric labels. Operational errors are still passed to the configured logger where the existing failure path logs them. `in_fallback` remains the explicit cache-plumbing-versus-application distinction for existing dashboards.

Applications upgrading from exception-name labels must update alerts and dashboards to match these failure-site values.

### Custom adapters

For other telemetry backends, implement `DialCacheMetricsAdapter` and pass the adapter through `new DialCache({ metrics })`. Every backend-neutral label object exposes the logical namespace as camel-case `cacheNamespace`; adapters should map it to their backend's `cache_namespace` label/tag. This field is present even when no key or cache layer was reached. Synchronous adapter failures are isolated from cache behavior and application fallbacks. Omit `metrics` to disable metrics.

### Migrating from implicit Prometheus metrics

| Before | After |
| --- | --- |
| `new DialCache()` registered Prometheus collectors | `new DialCache()` has metrics disabled |
| `new DialCache({ metrics: false })` | `new DialCache()` |
| `new DialCache({ metricsRegistry, metricsPrefix })` | `new DialCache({ metrics: createPrometheusDialCacheMetrics({ registry, prefix }) })` |
| Prometheus imports from `dialcache` | Prometheus imports from `dialcache/prometheus` |

## Current scope

Included:

- Request-local caching for the lifetime of the outermost enabled context
- Process-local TTL/LRU cache with a global entry-count bound
- Redis TTL cache
- Request-local → process-local → Redis → fallback read-through chain
- Lazy Redis client factory support
- Lua-backed Redis reads and writes with Redis-generated timestamps
- Versioned binary Redis frames for UTF-8 and Buffer serializer output
- Native node-redis script registration with automatic `NOSCRIPT` recovery
- Native Valkey GLIDE adapter with explicit script disposal and automatic script-cache recovery
- Standalone Redis, Valkey, and Redis Cluster support
- JSON and custom serializer support for Redis values
- Duplicate and reserved use-case validation
- Fail-open behavior for key/config/cache read-write errors; explicit invalidation mutations surface failures
- Runtime config provider with fallback to cached-function `defaultConfig`
- Per-layer TTL and ramp controls
- Deterministic default ramp sampler with injectable override hooks
- Missing config disables only the relevant layer and falls through
- Optional Prometheus adapter with caller-owned registries and duplicate-registration safety
- Optional Datadog DogStatsD adapter with caller-owned clients and explicit distribution/histogram semantics
- Backend-neutral custom metrics adapter hook; metrics are disabled when omitted
- Cache-vs-fallback error classification through the `in_fallback` label
- Serialization latency and cached payload size metrics for Redis values
- Logger injection for cache operational failures
- `trackForInvalidation` on cached functions
- `invalidateRemote(keyType, id, futureBufferMs)` Redis watermark API
- Redis Cluster hash-tagged value/watermark keys for invalidation-tracked entries
- Dynamically extended watermark TTL with a configurable `DEFAULT_WATERMARK_TTL_SEC` floor
- Future-buffer behavior that avoids cache writes during active invalidation windows
- Request-scoped and instance-scoped coalescing for active cache work

Not included yet:

- Framework middleware helpers/integrations
- `cachedObject`
- Expanded examples

## Request-local benchmark

From a repository checkout, run the semantic microbenchmark after installing dependencies:

```bash
pnpm benchmark:request-local
```

The command builds `dist` before reporting request-local sequential-hit throughput plus request-local and instance-scoped coalescing fan-out. The benchmark is a maintainer tool and is not included in the published package. It asserts fallback counts and returned values but deliberately applies no timing threshold. Override its work sizes with `DIALCACHE_BENCH_ITERATIONS` and `DIALCACHE_BENCH_FANOUT`.

## Releasing

Publishing is driven manually from the `Release` workflow in GitHub Actions. Run it from `main`; the workflow rejects any other ref or a stale main commit. Semantic Release selects the next version from Conventional Commits since the highest stable `vX.Y.Z` tag. Breaking changes bump major, `feat` bumps minor, and every other allowed PR-title type (`fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`, `chore`, `ci`, and `revert`) bumps patch. The highest required bump wins.

After validating, building, and package-testing the release artifact, Semantic Release stamps the package version, creates the Git tag, publishes the public npm package with provenance, and publishes the GitHub release. The repository's `package.json` remains at its development seed version between releases.

The workflow retains the `NPM_TOKEN` secret as a publishing fallback. After configuring `lan17/DialCache` and `release.yaml` as the package's trusted GitHub publisher, remove the long-lived token; the workflow's OIDC permission then provides npm authentication and provenance.
