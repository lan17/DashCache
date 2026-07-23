# Configuration and cache layers

[Back to the README](../README.md)

This guide covers cached-function definitions, cache identity, runtime policy,
request-local and process-local behavior, and cached-value ownership. For the
shared remote layer, see [Redis and Valkey](redis.md).

## Defining cached functions

`cached(fn, options)` wraps a function; the wrapped callable has the same
parameters and always returns a `Promise`.

| Option | Required | Description |
| --- | --- | --- |
| `keyType` | yes | The kind of id the key addresses, such as `"user_id"`. Together with the id, this is the invalidation unit for tracked entries. |
| `useCase` | yes | Identifies the individual cache. It is part of the stored key and a metrics label. |
| `cacheKey` | yes | Selects a bare id or `{ id, args }` from `fn`'s parameters. |
| `defaultConfig` | no | Provides the `DialCacheKeyConfig` baseline that runtime config overlays field by field. |
| `serializer` | when the return type is not statically JSON-compatible | Selects a per-function `Serializer<T>` for Redis values; see [Serialization](redis.md#serialization). |
| `trackForInvalidation` | no; default `false` | Opts this use case's Redis entries into watermark-based [targeted invalidation](invalidation.md). |
| `fallbackTimeoutMs` | no; default `60_000` | Sets the fallback deadline in milliseconds, up to 2,147,483,647. `null` disables it; see [Fallback deadlines](coalescing.md#fallback-deadlines). |

`useCase` is validated when the function is registered. A duplicate within one
`DialCache` instance throws `UseCaseIsAlreadyRegisteredError`, and the internal
name `watermark` throws `UseCaseNameIsReservedError`.

## Keys, ids, and extra dimensions

The required `cacheKey` selector receives the wrapped function's inferred
parameters. Return a bare id, or return `{ id, args }` to add secondary
dimensions:

```ts
const searchPosts = dialcache.cached(
  (userId: string, page: number, filter: string) =>
    db.searchPosts(userId, page, filter),
  {
    keyType: "user_id",
    useCase: "SearchPosts",
    cacheKey: (userId, page, filter) => ({
      id: userId,
      args: { page, filter },
    }),
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);

await dialcache.enable(() => searchPosts("u1", 2, "active"));
```

The selector is the value-identity contract. It must include every input
dimension that can affect the returned value. Otherwise, distinct calls can
reuse the same cached value or share the same in-flight fallback through
request coalescing.

### Namespace

`DialCacheConfig.namespace` is the logical cache namespace and the first
component of every key. It defaults to `"urn"`, producing keys such as
`urn:user_id:123#GetUser`.

Set a stable application-specific value when applications or environments may
share one Redis deployment:

```ts
const dialcache = new DialCache({
  namespace: "production-users-api",
  redis: { client: dialCacheRedisClient },
});
```

That produces Redis keys beginning with `production-users-api:...`, or
`{production-users-api:...}` for invalidation-tracked values. `namespace` is
DialCache's single cache-identity and key-partitioning setting. It participates
in request-local, process-local, Redis, coalescing, deterministic ramp,
invalidation, and metrics.

A namespace may not contain `{` or `}` because DialCache reserves those
characters for Redis Cluster hash tags.

### Identity rules

- **`keyType` plus `id` is the invalidation unit for tracked Redis entries.**
  `dialcache.invalidateRemote("user_id", "123", futureBufferMs)` writes one
  watermark for that user. Any tracked Redis entry with the same `keyType` and
  `id` is refreshed across all `args` variants when Redis is read. Untracked
  entries do not consult the watermark. Invalidation does not evict existing
  request-local or process-local entries.
- **`args` are part of the cache key.** Different arguments produce different
  entries, but targeted invalidation is by id rather than by argument.
- **Scalar equality is string-based.** For matching surrounding dimensions,
  numeric `1`, string `"1"`, and bigint `1n` identify the same key. Argument
  values `null` and `"null"` also match, `-0` matches `0`, and an `undefined`
  argument is omitted. If a deployment changes the logical meaning represented
  by a scalar, change an explicit identity dimension such as `keyType`,
  `useCase`, or an argument name or value.
- **Ignored inputs still reach the wrapped function.** A database handle can be
  a normal parameter that the selector ignores. However, concurrent same-key
  misses share the leader's execution. Do not ignore values such as
  `AbortSignal`, auth context, locale, or other request-scoped inputs unless
  sharing one result is correct.
- **Methods need a receiver.** Pass `obj.method.bind(obj)` or
  `(...args) => obj.method(...args)`; a bare `obj.method` reference loses
  `this`.

### Changing a namespace

Changing `namespace` intentionally creates a cold-cache boundary across every
layer. Old and new keyspaces do not share Redis values or invalidation
watermarks.

During an overlapping deployment, an invalidation handled by one version is
invisible to the other. The other version can continue serving a stale tracked
value until its value TTL expires. If remote invalidation correctness matters,
a normal rolling namespace change is unsafe.

Use a coordinated no-overlap cutover, or an operational bridge that prevents
both versions from serving remote cache across mutations. For example,
temporarily disable and clear remote caching during the transition. After the
cutover, provision for fallback and refill load, and allow old Redis keys to
expire by TTL.

## Runtime config and ramp controls

Instance-wide behavior is set through the `DialCache` constructor:

| `DialCacheConfig` option | Default | Description |
| --- | --- | --- |
| `namespace` | `"urn"` | Logical cache namespace and first key component. |
| `redis` | none | `{ client: DialCacheRedisClient }`; enables the [remote layer](redis.md). |
| `localMaxSize` | `10_000` | Global process-local entry cap. `0` disables process-local storage. Must be a nonnegative safe integer. |
| `cacheConfigProvider` | none | Resolves runtime config per enabled invocation as a sparse overlay on the function's `defaultConfig`; `null` applies no overrides. |
| `rampSampler` | deterministic by key and layer | Selects keys for partial ramps. `randomRampSampler` is also exported. |
| `metrics` | disabled | A `DialCacheMetricsAdapter`; see [Observability](observability.md). |
| `logger` | `console` | Receives operational cache failures through `debug`, `warn`, and `error`. |

Per-invocation policy is a `DialCacheKeyConfig`: per-layer `ttlSec` and `ramp`
maps keyed by `CacheLayer.LOCAL` and `CacheLayer.REMOTE`, plus a
`requestLocal` boolean.

### Baseline and overlay precedence

Every cached function can provide an optional per-use-case `defaultConfig`.
That is the baseline policy. The `cacheConfigProvider` result is a sparse
field-level overlay on it.

Precedence for each field is:

```text
runtime field -> defaultConfig field -> DialCache disabled baseline
```

The disabled baseline sets `requestLocal` to `false` and leaves the
process-local and remote TTLs unset. A shared layer with no effective TTL is
disabled by policy. A shared layer with an effective TTL but no effective ramp
defaults to a 100% ramp.

`DialCacheKeyConfig` preserves an omitted `requestLocal` as `undefined`, so the
overlay can distinguish omission from an explicit `false`. Its effective value
still defaults to `false` after resolution.

A provider result of `null`, or a defensive `undefined`, applies no overrides.
An empty `DialCacheKeyConfig` and omitted runtime fields also inherit the
baseline.

Use explicit values to replace inherited policy:

- `requestLocal: false` disables request-local caching;
- a shared-layer ramp of `0` disables that layer; and
- `DialCacheKeyConfig.disabled()` turns request-local off and ramps both shared
  layers to `0`.

### Validation and snapshots

DialCache validates `defaultConfig` when `cached()` registers the definition:

- TTLs must be positive safe integers;
- ramps must be finite percentages from 0 to 100;
- layer maps must be objects; and
- `requestLocal` must be a boolean when present.

Invalid defaults are rejected immediately. Registration captures an immutable
internal snapshot, so mutating the supplied config or its maps later does not
change the use case's baseline. Runtime policy changes belong in the provider's
returned overlay.

Runtime TTL and ramp leaves are used as supplied rather than falling back to
valid default leaves:

- an invalid TTL disables that layer with `invalid_ttl`;
- a nonnumeric or non-finite ramp disables it with `invalid_ramp`;
- a finite runtime ramp retains a defensive clamp to 0 through 100; and
- other valid layers can continue to run.

Invalid leaves also record a `config_resolution` error, distinguishing provider
garbage from an intentional ramp-down. A malformed runtime config object,
layer-map shape, or `requestLocal` value fails config resolution for the whole
invocation, records `config_error`, and executes the fallback uncached.

### Provider behavior

`cacheConfigProvider` is called for every enabled cached-function invocation
before any cache lookup. Keep it cheap, cache remote or config-store reads
inside the provider, and give asynchronous work a finite application-owned
deadline.

DialCache fetches and resolves one config snapshot per enabled invocation.
Provider errors do not activate defaults: they fail open, record
`config_error`, and execute the fallback uncached.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new DialCacheKeyConfig({
        // Sparse override: inherit both TTLs and the local ramp.
        ramp: { [CacheLayer.REMOTE]: 25 },
      });
    }
    return null;
  },
  rampSampler: ({ key, layer }) =>
    deterministicPercentFor(`${key.urn}:${layer}`),
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      // Omitted ramps default to 100% because these layers have TTLs.
      ttlSec: {
        [CacheLayer.LOCAL]: 30,
        [CacheLayer.REMOTE]: 300,
      },
    }),
  },
);
```

Ramp values are percentages from 0 to 100. Intermediate values use the
`rampSampler`. The default sampler is deterministic by cache key and layer, so
the same key is consistently sampled in or out of a partial rollout.

## Request-local cache

Set `requestLocal: true` to memoize resolved values for the lifetime of the
outermost `enable()` scope:

```ts
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

`requestLocal` is a runtime boolean rather than a TTL/ramp-controlled
`CacheLayer`. The provider can turn it on or off for each invocation.
`DialCacheKeyConfig.enabled(ttlSec)` enables only process-local and remote
caching, so request-local caching must be selected explicitly.

The resolved config applies to the whole invocation. When `requestLocal` is
false, the invocation skips request-local lookup and storage without deleting a
value already memoized in the scope. A later invocation that enables it can
reuse that value.

The outermost `enable()` call owns the request-local lifetime; nested `enable()`
calls reuse the same scope. State is allocated lazily, so scopes that use only
process-local or remote caching do not allocate it.

Wrap the complete Node HTTP handler so the scope matches the request:

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

Request-local storage has no capacity limit, eviction, or overflow mode. Values
are retained until the outermost callback settles. Use it for short-lived
scopes with bounded key cardinality. Split long-running streams or large batch
jobs into smaller scopes.

## Process-local cache

The process-local layer, `CacheLayer.LOCAL`, uses one LRU per `DialCache`
instance. It keeps at most 10,000 entries by default across all use cases while
retaining each entry's configured TTL.

Set `localMaxSize` to a nonnegative safe integer to change the global entry cap.
`0` disables process-local storage:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory.
Recently read entries stay resident ahead of less recently used entries when
the limit is reached.

## Cached-value ownership

Treat values returned by cached functions as immutable. DialCache does not
clone or freeze values stored in request-local or process-local memory.
Mutating a cached object can be observed by:

- later callers in the same request;
- callers in other requests that hit the process-local cache; and
- callers that coalesced onto the same in-flight result.

This contract includes nested objects and arrays, `Map`, `Set`, `Buffer`, typed
arrays, and class instances. Redis deserialization can produce a different
reference from an in-memory hit, so reference identity is layer-dependent and
is not part of the API contract.

Copy a value explicitly before changing it:

```ts
const sharedUser = await getUser("123");
const editableUser = structuredClone(sharedUser);
editableUser.displayName = "New name";
```

Use a narrower copy when its semantics are sufficient. The ownership boundary
remains the caller's responsibility.
