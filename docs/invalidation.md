# Targeted invalidation

[Back to the README](../README.md)

DialCache can invalidate related Redis entries without scanning or enumerating
keys. The mechanism is opt-in, remote-only, and based on per-identity Redis
watermarks.

Read this complete contract before using targeted invalidation for mutable
production data. Correctness depends on cache-layer policy, Redis clock
synchronization, and an application-owned timing buffer.

## Configure a tracked use case

Set `trackForInvalidation: true` on a Redis-backed cached function. After the
source mutation commits, call
`dialcache.invalidateRemote(keyType, id, futureBufferMs)`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: dialCacheRedisClient },
});

// Chosen from this application's clock-skew bound and measured
// worst-case source and fallback timings.
const USER_INVALIDATION_BUFFER_MS = 5_000;

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    // Strongly invalidated mutable data should not use in-memory layers.
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: {
        [CacheLayer.REMOTE]: 300,
      },
      ramp: {
        [CacheLayer.REMOTE]: 100,
      },
    }),
  },
);

await updateUser("123", patch);
await dialcache.invalidateRemote(
  "user_id",
  "123",
  USER_INVALIDATION_BUFFER_MS,
);
```

The buffer is an application-owned safety value. DialCache cannot choose a
universally safe nonzero default.

## Identity and Redis Cluster placement

Invalidation writes a watermark at:

```text
{encodedNamespace:encodedKeyType:encodedId}#watermark
```

Tracked Redis values use the same Redis Cluster hash tag. For example:

```text
{users-api:user_id:123}?locale=en#GetMutableUser:dialcache-frame-v1
```

The value and watermark therefore live in the same Redis Cluster slot. Key
components are percent-encoded before joining, so delimiters inside ids or
arguments cannot collide with delimiters in the key format. Components may not
contain `{` or `}` because those characters would corrupt the hash tag.

The internal `:dialcache-frame-v1` suffix identifies values written with
DialCache's binary protocol. Watermarks are stored as decimal timestamps.

`keyType` plus `id` is the invalidation unit. One watermark covers every tracked
`useCase` and `args` variant with that identity. Untracked values do not consult
it.

## Read and write behavior

A tracked Redis value whose Redis-created timestamp is older than or equal to
the watermark is treated as stale and refreshed through fallback.

`invalidateRemote(keyType, id, futureBufferMs)` sets the watermark to the
greater of:

- its existing value; and
- Redis's current time plus the buffer.

While that future window is active:

1. A tracked Redis read treats the covered value as a miss.
2. The invocation runs its fallback.
3. If that fallback reaches the tracked Redis write before the window ends,
   Redis rejects the write.
4. DialCache also suppresses the corresponding process-local population.
5. The fallback value still returns to its caller.

Request-local memoization remains unconditional. An invocation whose remote
layer is disabled or ramped out does not consult the watermark and is not
fenced by it.

This is a timing contract, not a cancellation or acquisition fence. The buffer
blocks stale fallback results from passing the tracked Redis write only while
the configured window remains active. It does not cancel the fallback or force
it to read from an authoritative source.

## Redis clock contract

The bundled timestamp protocol assumes synchronized system clocks across every
Redis node eligible for primary promotion.

Redis does not guarantee that `TIME` is monotonic across nodes, and DialCache
does not detect or compensate for cross-node clock skew. If the assumption is
violated, failover can:

- temporarily suppress tracked cache fills; or
- allow a pre-invalidation value to remain readable until it expires or a later
  invalidation advances the watermark past its timestamp.

Monitor and bound the maximum negative clock skew across all promotion-eligible
nodes. Include that bound when sizing `futureBufferMs`.

## Watermark lifetime

Tracked writes create a baseline watermark and extend its TTL to at least the
value TTL plus one minute. Invalidation preserves that lifetime and extends it
to cover the future buffer.

`DEFAULT_WATERMARK_TTL_SEC`, four hours, is a configurable floor rather than a
maximum. Reads do not extend watermark lifetime.

## Choosing `futureBufferMs`

`futureBufferMs` must be a nonnegative safe integer. The API default is zero,
but zero provides no stale-publication protection once Redis time advances.

Every production invalidation should pass a named, application-owned nonzero
value based on measured or conservatively bounded timings. Size it to cover:

- maximum expected negative clock skew between promotion-eligible Redis nodes;
- source visibility or replication lag;
- the full remaining tail of any fallback that may already have observed the
  pre-mutation value;
- `serializer.dump`;
- Redis client queue and network latency;
- Lua script execution;
- the Redis write itself; and
- a safety margin.

Invalidate only after the source mutation commits.

Underestimating the interval can allow a delayed stale fallback to repopulate
Redis after the watermark window ends. Overestimating it lengthens the tracked
Redis miss and write-suppression window, increasing fallback load without
publishing stale values.

A larger buffer does not delay or suppress returning fallback values to
callers.

## In-memory layers remain local

Targeted invalidation is remote-only. `invalidateRemote` does not evict existing
request-local or process-local entries.

Strongly invalidated mutable data should disable request-local and process-local
caching. A short process-local TTL is appropriate only when the application
explicitly accepts that bounded stale-read window.

If those layers remain enabled, their existing values can be returned without
reaching the remote watermark.
