# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

Fine-grained TypeScript caching with explicit enabled contexts, request-local memoization, process-local and Redis TTL caching, stable key construction, runtime rollout controls, request coalescing, adapter-based observability, and Redis watermark-based targeted invalidation.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How caching works](#how-caching-works)
- [Enabled context](#enabled-context)
- [Defining cached functions](#defining-cached-functions)
- [Keys, ids, and extra dimensions](#keys-ids-and-extra-dimensions)
- [Runtime config and ramp controls](#runtime-config-and-ramp-controls)
- [Cache layers](#cache-layers)
  - [Request-local cache](#request-local-cache) · [Process-local cache](#process-local-cache) · [Redis-backed TTL cache](#redis-backed-ttl-cache) · [Serialization](#serialization)
- [Cached-value ownership](#cached-value-ownership)
- [Targeted invalidation and watermarks](#targeted-invalidation-and-watermarks)
- [Request coalescing](#request-coalescing)
  - [Fallback deadlines](#fallback-deadlines) · [Coalescing state](#coalescing-state)
- [Metrics](#metrics)
- [Maintainers](#maintainers)

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

## How caching works

The wrapped function is the **fallback**: it runs whenever no active cache layer returns a value, whether because layers missed, were disabled, or failed open.

When caching is enabled, reads flow through:

```text
request-local cache -> process-local cache -> Redis cache -> fallback function
```

- Request-local hits return the value memoized in the current outermost `enable()` scope.
- Results from the lower chain are memoized request-locally when that layer is enabled.
- Process-local hits return immediately.
- Process-local misses try Redis and populate the process-local cache on a Redis hit.
- Redis misses call the fallback and attempt to populate Redis and, when active, the process-local cache. Tracked invalidation may suppress both publications.
- Redis cache read/write failures are logged, counted in metrics, and fail open; fallback results still return when fallback succeeds. `invalidateRemote` logs/counts Redis failures and rethrows them so callers do not assume invalidation succeeded.
- Cache-key construction and config-provider failures also fail open and run the fallback uncached.
- A missing effective process-local/Redis TTL disables that layer by policy; a configured TTL with no ramp defaults to 100%. Disabled layers record a disabled reason and fall through to the next layer/fallback.

Caching as a whole is only active inside an enabled context, described next.

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

## Defining cached functions

`cached(fn, options)` wraps a function; the wrapped callable has the same parameters and always returns a `Promise`.

| Option | Required | Description |
| --- | --- | --- |
| `keyType` | yes | The kind of id the key addresses (e.g. `"user_id"`). Together with the id, the invalidation unit for tracked entries. |
| `useCase` | yes | Identifies the individual cache: part of the stored key and the metrics label. |
| `cacheKey` | yes | Selector over `fn`'s parameters; returns a bare id or `{ id, args }`. |
| `defaultConfig` | no | `DialCacheKeyConfig` baseline policy that runtime config overlays field by field (see [Runtime config](#runtime-config-and-ramp-controls)). |
| `serializer` | when the return type is not statically JSON-compatible | Per-function `Serializer<T>` for Redis values (see [Serialization](#serialization)). |
| `trackForInvalidation` | no (default `false`) | Opts this use case's Redis entries into watermark-based targeted invalidation. |
| `fallbackTimeoutMs` | no (default `60_000`) | Fallback deadline in milliseconds, at most 2,147,483,647; `null` disables it (see [Fallback deadlines](#fallback-deadlines)). |

`useCase` is validated at registration: a duplicate within one `DialCache` instance throws `UseCaseIsAlreadyRegisteredError`, and the internal name `watermark` throws `UseCaseNameIsReservedError`.

## Keys, ids, and extra dimensions

The cache key comes from the required `cacheKey` selector whose parameters are inferred from `fn`. Return a bare id, or return `{ id, args }` to extract a field or add secondary dimensions:

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

`DialCacheConfig.namespace` is the logical cache namespace and the first component of every key. It defaults to `"urn"`, producing keys such as `urn:user_id:123#GetUser`. Set a stable application-specific value when multiple applications may use the same Redis deployment:

```ts
const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});
```

That produces Redis keys beginning with `users-api:...`, or `{users-api:...}` for invalidation-tracked values. `namespace` is DialCache's single cache-identity and key-partitioning setting: it participates in request-local, process-local, Redis, coalescing, deterministic ramp, invalidation, and metrics. It may not contain `{` or `}` because DialCache reserves those characters for Redis Cluster hash tags. Use a namespace to express any required application or environment separation, such as `production-users-api`.

- **`keyType` + `id` is the invalidation unit for tracked Redis entries.** `dialcache.invalidateRemote("user_id", "123", futureBufferMs)` writes one watermark for that user; any `trackForInvalidation` Redis entry with the same `keyType` and `id` is refreshed across all `args` variants when Redis is read. `invalidateRemote` does not evict existing request-local or process-local entries (see [Targeted invalidation](#targeted-invalidation-and-watermarks)), and untracked Redis entries do not consult the watermark. `useCase` identifies the individual cache (it's the metrics label and part of the stored key).
- **`args` are part of the cache key** — different `args` produce different entries — but invalidation is by `id` only.
- **Scalar key equality is string-based.** Runtime type is not an identity dimension: for matching surrounding dimensions, numeric `1`, string `"1"`, and bigint `1n` identify the same key; argument values `null` and `"null"` also match. `-0` matches `0`, and an `undefined` argument is omitted. If a deployment changes the logical meaning represented by a scalar, change an explicit identity dimension such as `keyType`, `useCase`, or an argument name/value.
- **Non-key inputs** (for example a db handle) are simply parameters the `cacheKey` selector ignores. They still reach `fn` for non-coalesced executions, but concurrent same-key cache misses share the leader's execution, so do not ignore values like `AbortSignal`, auth context, locale, or other request-scoped inputs unless sharing one result is correct.
- **Methods:** pass `obj.method.bind(obj)` (or `(...a) => obj.method(...a)`) — a bare `obj.method` reference loses `this`.

Changing the namespace value intentionally creates a cold-cache boundary across every layer. Old and new keyspaces do not share Redis values or invalidation watermarks. During an overlapping deployment, an invalidation handled by one version is invisible to the other, which can continue serving a stale tracked value until its value TTL expires. If remote invalidation correctness matters, a normal rolling deployment is unsafe: use a coordinated no-overlap cutover, or an operational bridge that prevents both versions from serving remote cache across mutations (for example, temporarily disable and clear remote caching during the transition). After the cutover, provision for fallback/refill load and allow old Redis keys to expire by TTL.

## Runtime config and ramp controls

Instance-wide behavior is set through the `DialCache` constructor:

| `DialCacheConfig` option | Default | Description |
| --- | --- | --- |
| `namespace` | `"urn"` | Logical cache namespace and first key component (see [Keys, ids, and extra dimensions](#keys-ids-and-extra-dimensions)). |
| `redis` | none | `{ client: DialCacheRedisClient }`; enables the Redis layer (see [Redis-backed TTL cache](#redis-backed-ttl-cache)). |
| `localMaxSize` | `10_000` | Global process-local entry cap; `0` disables process-local storage. Nonnegative safe integer. |
| `cacheConfigProvider` | none | Resolves runtime config per enabled invocation as a sparse overlay on the function's `defaultConfig`; `null` applies no overrides. |
| `rampSampler` | deterministic by key and layer | Percentage sampler for partial ramps; `randomRampSampler` is also exported. |
| `metrics` | disabled | A `DialCacheMetricsAdapter` (see [Metrics](#metrics)). |
| `logger` | `console` | Receives operational cache failures (`debug`, `warn`, `error`). |

Per-invocation cache policy is a `DialCacheKeyConfig`: per-layer `ttlSec` and `ramp` maps keyed by `CacheLayer.LOCAL` (process-local) and `CacheLayer.REMOTE` (Redis), plus a `requestLocal` boolean.

Every cached function can provide an optional per-use-case `defaultConfig`. It is the baseline policy, and the `cacheConfigProvider` result is a sparse field-level overlay on that baseline. Precedence is: runtime field, then `defaultConfig` field, then DialCache's disabled baseline.

The disabled baseline sets `requestLocal` to false and leaves the process-local and Redis TTLs unset. A shared layer with no effective TTL is disabled by policy. When a shared layer has an effective TTL but no effective ramp, its ramp defaults to 100%.

`DialCacheKeyConfig` preserves an omitted `requestLocal` as `undefined` so the overlay can distinguish omission from an explicit `false`; the effective value still defaults to false after resolution.

A provider result of `null` (or defensive `undefined`) applies no overrides. An empty `DialCacheKeyConfig` and omitted runtime fields also inherit the baseline. Use explicit values to override inherited policy: `requestLocal: false` disables request-local caching and a layer ramp of `0` disables that shared layer. `DialCacheKeyConfig.disabled()` is that explicit kill switch in one call: request-local off and both shared layers ramped to 0.

DialCache validates `defaultConfig` when `cached()` registers the definition: TTLs must be positive safe integers, ramps must be finite percentages from 0 to 100, layer maps must be objects, and `requestLocal` must be a boolean when present. Invalid defaults are rejected immediately.

Registration captures an immutable internal snapshot of `defaultConfig`; mutating the supplied config or its maps later does not change the use case's baseline. Runtime policy changes belong in the provider's returned overlay.

Runtime TTL and ramp leaves are used as supplied instead of falling back to valid default leaves. An invalid TTL disables that layer with `invalid_ttl`; a non-finite or nonnumeric ramp disables it with `invalid_ramp`; finite runtime ramps retain the defensive clamp to 0–100. Other layers can still run, and invalid leaves also record a `config_resolution` error so provider garbage is alertable separately from intentional ramp-downs. A malformed runtime config object, layer-map shape, or `requestLocal` value fails config resolution for the invocation, records `config_error`, and executes the fallback uncached.

`cacheConfigProvider` is called for every enabled cached-function invocation before DialCache performs any cache lookup. Keep it cheap, cache any remote/config-store reads inside the provider, and avoid work that would erase the benefit of a cache hit.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new DialCacheKeyConfig({
        // Sparse override: inherit both TTLs and the local ramp from defaultConfig.
        ramp: { [CacheLayer.REMOTE]: 25 },
      });
    }
    return null; // apply no overrides; use the cached function's baseline
  },
  rampSampler: ({ key, layer }) => deterministicPercentFor(`${key.urn}:${layer}`),
});

const getUser = dialcache.cached((userId: string) => db.fetchUser(userId), {
  keyType: "user_id",
  useCase: "GetUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    // Omitted ramps default to 100% because these layers have TTLs.
    ttlSec: { [CacheLayer.LOCAL]: 30, [CacheLayer.REMOTE]: 300 },
  }),
});
```

`ramp` values are percentages from 0 to 100. `0` disables the layer, `100` enables it, and intermediate values use `rampSampler`; the default sampler is deterministic by cache key and layer, so the same key is consistently sampled in or out of a partial rollout. DialCache fetches and resolves one config snapshot per enabled invocation. Provider errors do not activate defaults: they fail open, record `config_error`, and execute the fallback function uncached.

## Cache layers

### Request-local cache

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

`requestLocal` is a runtime boolean rather than a TTL/ramp-controlled `CacheLayer`. The `cacheConfigProvider` can turn it on or off for each invocation. `DialCacheKeyConfig.enabled(ttlSec)` enables only process-local and Redis caching, so request-local caching must be selected explicitly.

DialCache resolves the runtime config once per enabled invocation and uses it for the entire lookup. When the effective `requestLocal` value is false, the invocation skips request-local lookup and storage without deleting an entry already memoized in the scope. A later invocation that enables request-local caching can reuse that entry.

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

### Process-local cache

The process-local layer (`CacheLayer.LOCAL`) uses one LRU per `DialCache` instance. It keeps at most 10,000 entries by default across all use cases while retaining each entry's configured TTL. Set `localMaxSize` to a nonnegative safe integer to change the global entry cap; `0` disables process-local storage:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory. Recently read entries stay resident ahead of less recently used entries when the limit is reached.

### Redis-backed TTL cache

The Redis layer supports standalone Redis, Valkey, and Redis Cluster. Register DialCache's native node-redis scripts when creating the client, then pass that client to DialCache:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL,
  scripts: dialcacheRedisScripts,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1_000,
  socket: { connectTimeout: 2_000 },
});
await redisClient.connect();

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
});

async function shutdown(): Promise<void> {
  // Stop new work and await every outstanding cached call and invalidation first.
  await redisClient.quit();
}
```

`redis.client` is required when Redis is configured and accepts the semantic `DialCacheRedisClient` interface. Create and connect the underlying client before constructing `DialCache`. Node-redis users should register the supplied scripts and wrap their client with `createNodeRedisDialCacheClient` as shown above.

Valkey GLIDE users pass an already-created standalone or cluster client to the GLIDE adapter:

```ts
import { GlideClient } from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
  requestTimeout: 2_000,
  advancedConfiguration: { connectionTimeout: 2_000 },
});
const redisClient = createValkeyGlideDialCacheClient(glideClient);
const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});

function shutdown(): void {
  // After draining cached calls and invalidations, release scripts before closing GLIDE.
  redisClient.dispose();
  glideClient.close();
}
```

The application owns the complete Redis lifecycle. It creates and connects the underlying client and passes the semantic adapter to DialCache. During shutdown, stop starting DialCache-backed work and await every outstanding cached-function and `invalidateRemote()` promise, including calls still running fallbacks that may later write Redis. Then dispose adapter-owned resources and close the underlying connection. DialCache only borrows `redis.client`; it has no close or drain method and never disposes or closes caller resources.

The node-redis adapter owns no additional resources, so the application closes the underlying node-redis client after draining work. The GLIDE adapter owns five native `Script` handles but not the wrapped connection. After outstanding operations finish, call its idempotent `dispose()` before closing GLIDE as shown above; disposal while an adapter operation is in flight throws rather than releasing a live script.

Node-redis computes each script's SHA, uses `EVALSHA`, and retries with `EVAL` after `NOSCRIPT`. Its cluster client routes scripts by their first key and performs that fallback on the selected shard. The GLIDE adapter uses GLIDE's native `Script` lifecycle and byte decoder; GLIDE routes scripts from their declared keys. Tracked reads are deliberately routed to primaries so a lagging replica cannot hide an invalidation watermark.

#### Async liveness contract

DialCache fail-open behavior is rejection-driven: a Redis promise that never settles cannot fall through. Every `DialCacheRedisClient.read`, `write`, and `invalidate` promise must therefore resolve or reject within a finite application-defined budget covering connection establishment, reconnection, retries, offline queueing, dispatch, and response time. A connection timeout alone does not satisfy this contract. A pending read prevents fallback from starting, while a pending write withholds an already-computed fallback result and retains its process flight.

Valkey GLIDE users should configure [`requestTimeout`](https://github.com/valkey-io/valkey-glide/blob/v2.4.2/node/src/BaseClient.ts#L770-L776) and [`advancedConfiguration.connectionTimeout`](https://github.com/valkey-io/valkey-glide/blob/v2.4.2/node/src/BaseClient.ts#L957-L964), as shown above. GLIDE applies the request timeout while sending, waiting for a response, reconnecting, and retrying. This bounds client waiting; it is not server-side cancellation, so a write dispatched before timeout may still execute.

In node-redis 4.7, `socket.connectTimeout`, `disableOfflineQueue`, and `commandsQueueMaxLength` bound connection or queue behavior but do not impose a response deadline on a dispatched command. A [per-command `AbortSignal`](https://redis.io/docs/latest/develop/clients/nodejs/produsage/) can remove work that is still waiting to be sent, but once dispatched it no longer controls the pending reply. Node-redis 4.7 has no built-in strict dispatched-response deadline, and the bundled adapter does not inject queue cancellation. Applications requiring finite node-redis settlement must supply and document a custom `DialCacheRedisClient` policy for queue removal, hung connections, and ambiguous writes. Do not put Redis writes or invalidations behind a bare `Promise.race`: rejecting the outer promise neither removes queued work nor proves that an already-dispatched command did not execute.

The same finite-settlement responsibility applies to async `cacheConfigProvider`, `rampSampler`, and custom `Serializer` methods. DialCache's [fallback deadline](#fallback-deadlines) below covers only the wrapped application function. Prefer resource-native budgets and cooperative cancellation for every injected async operation. Native budgets can bound client waiting and may prevent queued work; only a cooperating operation can guarantee that underlying work stops.

#### Serialization

The core Redis boundary is the client-agnostic `DialCacheRedisClient` interface. It exchanges serialized values as `string | Buffer` and does not expose client commands or wire encodings. Distinct untracked/tracked read and write Lua sources, the invalidation source, and wire constants are available from `dialcache/redis-protocol`. Custom adapters can throw the root-exported `DialCacheRedisPayloadError`, `DialCacheRedisPayloadEncodingError`, and `DialCacheRedisProtocolError` classes to distinguish malformed payloads, unsupported encodings, and Lua reply-domain violations in logs. DialCache records bounded `cache_read`, `cache_write`, or `invalidation` metrics by failure site.

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

## Targeted invalidation and watermarks

Mutable Redis-backed use cases can opt into targeted invalidation by setting `trackForInvalidation: true` in the options and calling `dialcache.invalidateRemote(keyType, id, futureBufferMs)` after writes. The buffer is an application-owned safety value; DialCache cannot choose a universally safe nonzero value:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
});

// Chosen from this application's clock-skew bound and measured worst-case source/fallback timings.
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

The bundled timestamp protocol assumes that system clocks are synchronized across every Redis node eligible for primary promotion. Redis does not guarantee that `TIME` is monotonic across nodes, and DialCache does not detect or compensate for cross-node clock skew. If this deployment assumption is violated, failover can temporarily suppress tracked cache fills or allow a pre-invalidation value to remain readable until it expires or a later invalidation advances the watermark past its timestamp.

Tracked writes create a baseline watermark and extend its TTL to at least the value TTL plus one minute. Invalidation preserves that lifetime and extends it to cover the future buffer. `DEFAULT_WATERMARK_TTL_SEC` (4 hours) remains a configurable floor rather than a maximum, and reads do not extend watermark lifetime.

`futureBufferMs` must be a nonnegative safe integer. The default is zero, but zero provides no stale-publication protection once Redis time advances. Every production invalidation should pass a named, application-owned nonzero value based on that application's measured or conservatively bounded timings; there is no universally safe library value.

Size the buffer to cover the maximum expected negative clock skew between promotion-eligible Redis nodes plus the complete interval in which stale data could still reach the Redis write: source visibility or replication lag, the full remaining tail of any fallback that may already have observed the pre-mutation value, `serializer.dump`, Redis client queue and network latency, Lua script execution, the write itself, and a safety margin. Invalidate only after the source mutation commits. Underestimating this interval can allow a delayed stale fallback to repopulate Redis after the watermark window ends. Overestimating it lengthens the tracked Redis miss/write-suppression window described above, increasing fallback load without publishing stale values. A larger buffer does not delay or suppress returning fallback values to callers.

This is a timing contract rather than a cancellation or acquisition fence: the buffer prevents stale fallback results from passing that tracked Redis write only while the configured window remains active, and it does not force a fallback to read from an authoritative source.

Targeted invalidation is remote-only and enforced by Redis watermarks. `invalidateRemote` does not evict existing request-local or process-local entries. Strongly invalidated mutable data should disable request-local and process-local caching (or use a very short process-local TTL only when stale reads are acceptable).

## Request coalescing

DialCache coalesces in-flight work at the lifetime of the first active cache layer:

- When request-local caching is enabled, same-key callers in one outermost `enable()` scope share request-scoped in-flight work before the request-local lookup. Its resolved value is then memoized for later sequential calls in that scope.
- When process-local or Redis caching is enabled, same-key callers share in-flight work within one `DialCache` instance before the first active shared layer. This is reported as `scope="process"`, still applies when request-local caching is off, and can combine leaders from separate request scopes using the same instance.

```ts
await dialcache.enable(async () => {
  // Same cold key, concurrent calls: one fallback execution, one shared result.
  const [a, b] = await Promise.all([getUser("456"), getUser("456")]);
});
```

With Redis configured, an instance-scoped leader that misses the process-local cache runs the Redis read and, on miss, the fallback/cache write; followers await that result. Process-local-only misses share the leader's fallback/cache write. This protects Redis and the source of truth from a thundering herd on hot keys.

Coalescing only applies when at least one cache layer is active. Calls outside `enable()` are true pass-through. Calls where request-local, process-local, and Redis are all disabled are uncached and uncoalesced, but because they were initially enabled, the fallback deadline below still applies.

Because coalescing is keyed by `cacheKey`, concurrent calls with the same key share the leader's execution. Any argument ignored by `cacheKey` must be safe to share this way; include inputs such as locale, auth context, or cancellation behavior in the key when they can change the returned value or whether the underlying function should run separately.

### Fallback deadlines

Once an initially enabled invocation starts its fallback, DialCache applies a 60-second monotonic deadline by default. Set `fallbackTimeoutMs` once on a cached wrapper to choose a positive integer deadline in milliseconds, up to 2,147,483,647, or set it to `null` to preserve an intentionally unbounded fallback:

```ts
import { FallbackTimeoutError } from "dialcache";

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUserWithDeadline",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
    fallbackTimeoutMs: 2_000,
  },
);

try {
  await dialcache.enable(() => getUser("123"));
} catch (error) {
  if (error instanceof FallbackTimeoutError) {
    logger.warn("source lookup exceeded its DialCache budget", {
      useCase: error.useCase,
      timeoutMs: error.timeoutMs,
    });
  }
}
```

The timer starts only when the fallback begins. Same-key followers share the process or request-local leader's remaining budget and receive its `FallbackTimeoutError`; pass-through invocations where every layer is disabled have independent timers. Cache hits create no fallback timer. Calls that were initially outside an enabled context remain true pass-through and are not timed out, even when the wrapper configures `fallbackTimeoutMs`.

Deadline delivery requires the JavaScript event loop to make progress. It cannot preempt a synchronous fallback prefix or other event-loop blocking, so rejection can arrive later than the configured duration; when control returns, DialCache checks the monotonic deadline before accepting the result. The deadline timer remains referenced until the fallback settles or times out. Consequently, an abandoned enabled fallback can keep an otherwise idle short-lived process alive until that deadline; shutdown code should drain outstanding DialCache work rather than discarding its promises.

Timing out rejects the DialCache chain and clears its flight normally. A later fallback resolution is ignored, so that timed-out invocation cannot proceed to serializer, Redis, or local-cache publication. The underlying function is not canceled and may continue its own I/O or side effects; give the source operation its own native timeout or `AbortSignal` whenever possible. `fallbackTimeoutMs: null` disables this guard and makes finite fallback settlement entirely application-owned. Use the `null` escape hatch only after intentionally accepting that liveness risk.

Timeout failures retain the bounded metrics classification `error="fallback"` with `in_fallback="true"`; the typed error provides the timeout details without adding high-cardinality labels.

### Coalescing state

`getCoalescingState()` returns a detached, point-in-time snapshot of process-scoped flights owned by that `DialCache` instance:

```ts
const state = dialcache.getCoalescingState();

state.process.activeLeaders;
state.process.activeFollowers;
state.process.oldestLeaderAgeMs; // null when idle
```

A leader is one exact cache key currently tracked by the instance-scoped coalescer. A follower is each later invocation that joined that pending leader; the initiating invocation is not counted as a follower. Followers remain counted until their leader settles because abandoning a JavaScript promise is not observable. Request-local flights are deliberately excluded because their lifecycle is bounded by the outer `enable()` scope. `oldestLeaderAgeMs` uses a monotonic clock and is computed when the snapshot is requested.

There is no library-wide flight cap or age-based replacement. A registry cap would bound only DialCache metadata while overflow or eviction could still create unbounded source work and unsafe duplicate publication. Finite operation deadlines provide eventual cleanup; application admission control and backpressure remain responsible for bounding simultaneous distinct-key work. Monitor leader count and oldest age to verify that those budgets hold in production.

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
| `dialcache_disabled_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `policy_disabled`, `invalid_ttl`, `invalid_ramp`, `ramped_down`, `config_error`) |
| `dialcache_error_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors classified by a bounded failure site |
| `dialcache_invalidation_counter` | Counter | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache_coalesced_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests split by `request_local` or `process` scope |
| `dialcache_get_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache_fallback_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the underlying function settles or timeout rejection is delivered |
| `dialcache_serialization_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `dialcache_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

`policy_disabled` means that a process-local or Redis layer has no effective TTL after runtime overlays are applied. It is an intentional policy outcome, including the default when `defaultConfig` is omitted, rather than a configuration-loading failure.

Every metric carries `cache_namespace`, including disabled-context, key-construction, coalescing, and invalidation paths that do not have a constructed key. Its value is `DialCacheConfig.namespace`, defaulting to `urn`. The `layer` label is `request_local`, `local` (process-local), or `remote`. Disabled-context, key-construction, and config-provider failures use `noop` because no cache layer was reached. The bounded `scope` label on `dialcache_coalesced_counter` distinguishes request-local from instance-scoped single-flight work. `scope="process"` coordinates calls only within one `DialCache` instance; separate instances in the same process do not share in-flight state.

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
| `dialcache.fallback.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the underlying function settles or timeout rejection is delivered |
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
| `fallback` | The wrapped application function failed or exceeded its DialCache deadline |
| `unknown` | Reserved for an otherwise unclassified future failure site |

These values are defined by the backend-neutral core and are identical for every metrics adapter. Raw thrown values, error names, messages, cache IDs, arguments, and Redis keys are never included in metric labels. Operational errors are still passed to the configured logger where the existing failure path logs them. `in_fallback` remains the explicit cache-plumbing-versus-application distinction.

### Custom adapters

For other telemetry backends, implement `DialCacheMetricsAdapter` and pass the adapter through `new DialCache({ metrics })`. Every backend-neutral label object exposes the logical namespace as camel-case `cacheNamespace`; adapters should map it to their backend's `cache_namespace` label/tag. This field is present even when no key or cache layer was reached. Synchronous adapter failures are isolated from cache behavior and application fallbacks. Omit `metrics` to disable metrics.

## Maintainers

### Cache-path benchmark

From a repository checkout, run the semantic microbenchmark after installing dependencies:

```bash
pnpm benchmark:request-local
```

The command builds `dist` before reporting five scenarios: sequential request-local hits, sequential process-local hits, enabled bounded fallbacks, request-local coalescing fan-out, and process coalescing fan-out. The benchmark is a maintainer tool and is not included in the published package. It asserts fallback counts, coalescing state, and returned values but deliberately applies no timing threshold. Override its work sizes with `DIALCACHE_BENCH_ITERATIONS` and `DIALCACHE_BENCH_FANOUT`.

### Releasing

Publishing starts by manually running the `Release` workflow from current `main`. After the package checks pass, Semantic Release selects the next version from Conventional Commits since the highest stable `vX.Y.Z` tag. Breaking changes bump major, `feat` bumps minor, and every other normal PR-title type (`fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`, `chore`, `ci`, and `revert`) bumps patch. The highest required bump wins.

The workflow opens a `release: <version>` PR whose only change is the matching `package.json` version. `release` is a reserved Conventional Commit type configured not to request another release, so the version-control commit does not cause an extra bump. GitHub marks workflow runs for a PR opened with `GITHUB_TOKEN` as approval-required; approve those runs, review the PR, and squash-merge it normally through the protected branch.

The merge triggers the publish job. Before any release side effect, it verifies current `main`, the release commit subject, the one-file diff, the package version, the absent tag, and Semantic Release's independently calculated version and commit. It then reruns the package checks and asks Semantic Release to create the matching Git tag, publish the public npm package with provenance, and publish the GitHub release.

The repository must enable **Allow GitHub Actions to create and approve pull requests** under Actions workflow permissions. This workflow uses that capability only to create the version PR; it never approves or merges one, and no ruleset bypass actor or persistent release credential is required.
