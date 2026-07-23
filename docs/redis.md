# Redis and Valkey

[Back to the README](../README.md)

DialCache's remote TTL layer supports standalone Redis, standalone Valkey, and
Redis Cluster. The application creates, connects, configures, drains, and closes
the underlying client. DialCache borrows a semantic `DialCacheRedisClient` and
does not own the connection lifecycle.

## Install a client

Choose one supported integration:

```bash
# node-redis
pnpm add redis@~4.7.1

# or Valkey GLIDE
pnpm add @valkey/valkey-glide
```

## node-redis

Register DialCache's native scripts when creating the client, connect it, and
pass the semantic adapter to `DialCache`:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import {
  createNodeRedisDialCacheClient,
  dialcacheRedisScripts,
} from "dialcache/node-redis";

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
  redis: {
    client: createNodeRedisDialCacheClient(redisClient),
  },
});

async function shutdown(): Promise<void> {
  // Stop new work and await every cached call and invalidation first.
  await redisClient.quit();
}
```

`redis.client` is required when the remote layer is configured. Node-redis
users should register the supplied scripts and wrap the connected client with
`createNodeRedisDialCacheClient` as shown above.

The adapter computes each script's SHA, uses `EVALSHA`, and retries with `EVAL`
after `NOSCRIPT`. Its cluster client routes scripts by their first key and
performs that fallback on the selected shard. Tracked reads are deliberately
routed to primaries so a lagging replica cannot hide an invalidation watermark.

## Valkey GLIDE

Pass an already-created standalone or cluster client and the exact module
namespace that created it:

```ts
import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await valkeyGlide.GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
  requestTimeout: 2_000,
  advancedConfiguration: {
    connectionTimeout: 2_000,
  },
});

const redisClient = createValkeyGlideDialCacheClient(
  glideClient,
  valkeyGlide,
);

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});

function shutdown(): void {
  // Drain cached calls and invalidations before releasing resources.
  redisClient.dispose();
  glideClient.close();
}
```

DialCache uses the supplied namespace's `Script` constructor and
`Decoder.Bytes` value without importing a GLIDE runtime itself. Passing the same
module namespace that created the client prevents linked workspaces or
applications with another installed GLIDE version from mixing native script
handles.

The GLIDE adapter uses GLIDE's native script lifecycle and byte decoder. GLIDE
routes scripts from their declared keys.

## Lifecycle ownership

The application owns the complete Redis lifecycle:

1. Create and connect the underlying client.
2. Construct the semantic DialCache adapter.
3. Pass that adapter as `redis.client`.
4. During shutdown, stop starting DialCache-backed work.
5. Await every outstanding cached-function and `invalidateRemote()` promise,
   including fallbacks that may still write Redis.
6. Dispose adapter-owned resources.
7. Close the underlying connection.

DialCache has no `close()` or drain method. It never disposes or closes caller
resources.

The node-redis adapter owns no additional resources, so close the underlying
client after draining work. The GLIDE adapter owns five native `Script` handles
but not the wrapped connection. Call its idempotent `dispose()` after operations
finish and before closing GLIDE. Disposing while an adapter operation is in
flight throws rather than releasing a live script.

## Async liveness contract

DialCache fail-open behavior is rejection-driven: a promise that never settles
cannot fall through.

Every `DialCacheRedisClient.read`, `write`, and `invalidate` promise must resolve
or reject within a finite application-defined budget covering:

- connection establishment;
- reconnection and retries;
- offline queueing;
- dispatch; and
- response time.

A connection timeout alone does not satisfy this contract. A pending read
prevents fallback from starting. A pending write withholds an already-computed
fallback result and retains its process flight.

### Valkey GLIDE budgets

Configure
[`requestTimeout`](https://glide.valkey.io/languages/nodejs/api/interfaces/BaseClient.BaseClientConfiguration.html)
and
[`advancedConfiguration.connectionTimeout`](https://glide.valkey.io/languages/nodejs/api/interfaces/BaseClient.AdvancedBaseClientConfiguration.html),
as shown above.

GLIDE applies the request timeout while sending, waiting for a response,
reconnecting, and retrying. This bounds client waiting; it is not server-side
cancellation, so a write dispatched before timeout may still execute.

### node-redis 4.7 budgets

In node-redis 4.7, `socket.connectTimeout`, `disableOfflineQueue`, and
`commandsQueueMaxLength` bound connection or queue behavior but do not impose a
response deadline on a dispatched command.

A
[per-command `AbortSignal`](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)
can remove work that is still waiting to be sent. Once dispatched, it no longer
controls the pending reply.

Node-redis 4.7 has no built-in strict dispatched-response deadline, and the
bundled adapter does not inject queue cancellation. Applications requiring
finite node-redis settlement must supply and document a custom
`DialCacheRedisClient` policy for queue removal, hung connections, and ambiguous
writes.

Do not put Redis writes or invalidations behind a bare `Promise.race`.
Rejecting the outer promise neither removes queued work nor proves that an
already-dispatched command did not execute.

### Other injected operations

The same finite-settlement responsibility applies to asynchronous:

- `cacheConfigProvider`;
- `rampSampler`; and
- custom `Serializer` methods.

DialCache's [fallback deadline](coalescing.md#fallback-deadlines) covers only the
wrapped application function. Prefer resource-native budgets and cooperative
cancellation for every injected operation. Native budgets can bound client
waiting and may prevent queued work; only a cooperating operation can guarantee
that underlying work stops.

## Serialization

The core Redis boundary is the client-agnostic `DialCacheRedisClient` interface.
It exchanges serialized values as `string | Buffer` and does not expose
client-specific commands or wire encodings.

Distinct untracked and tracked read/write Lua sources, the invalidation source,
and wire constants are exported from `dialcache/redis-protocol`. Custom adapters
can throw these root-exported error classes:

- `DialCacheRedisPayloadError`;
- `DialCacheRedisPayloadEncodingError`; and
- `DialCacheRedisProtocolError`.

They distinguish malformed payloads, unsupported encodings, and invalid Lua
reply domains in logs. DialCache records bounded `cache_read`, `cache_write`, or
`invalidation` metrics by failure site.

### Binary frame

Redis values use a compact binary frame:

```text
byte 1      format version
bytes 2-9   Redis-created timestamp in milliseconds (uint64, big-endian)
byte 10     payload encoding (0 = UTF-8, 1 = raw binary)
bytes 11... serialized payload
```

Redis's Lua `struct` library packs and unpacks the timestamp. Redis TTL is
authoritative, so expiry metadata is not duplicated in the frame.

The payload comes from the cached function's serializer or `JsonSerializer` by
default. Custom serializers can return `string` or `Buffer`. Strings are stored
as UTF-8; Buffers are stored byte-for-byte without base64 expansion. Adapters
restore the same representation before calling `serializer.load`.

### Default JSON behavior

DialCache uses native `JSON.stringify` and `JSON.parse` by default. There is no
runtime validation pass, so the default adds no traversal beyond JSON
serialization itself. A top-level `undefined` result is supported with an
internal sentinel.

When `serializer.load` rejects a Redis payload, DialCache:

1. records a `serialization_load` error;
2. counts the read as a remote miss;
3. runs the fallback; and
4. attempts to replace the rejected payload.

A validating custom serializer can therefore treat an incompatible cached
value as a refreshable miss without adding a schema version to the cache key.

`JsonSerializer` validates JSON syntax only. It cannot detect that a
structurally valid payload came from an incompatible application value schema.
Applications that retain one `useCase` across deployments must keep
default-JSON values backward compatible.

For an incompatible change, either:

- provide a serializer whose `load` method validates and rejects the old shape;
  or
- change `useCase` to isolate the new cache entries.

During a mixed deployment, mutually incompatible validating serializers can
repeatedly reject and replace each other's values. Correctness is preserved,
but expect additional fallback and Redis-write load until the rollout
converges.

### Typed serializer requirement

When a cached function's resolved return type is statically JSON-compatible,
`serializer` is optional. This includes JSON primitives, arrays, plain object
or interface shapes, optional object fields, and a top-level `undefined`.

Types known not to survive the default round trip require a per-function
`Serializer<T>`:

```ts
import { DialCache, type Serializer } from "dialcache";

const dialcache = new DialCache();

const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) =>
    new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
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

The compile-time guard rejects known incompatible shapes such as:

- `Date`, `Map`, and `Set`;
- `bigint`, symbols, and functions;
- Buffers and typed arrays;
- method-bearing class instances;
- required nested `undefined`; and
- `unknown` and `any`.

The guard applies to every `cached()` declaration because active layers are
selected at runtime. A global Redis serializer is not parameterized by each
cached return type, so it cannot discharge this requirement. Non-JSON functions
must select a typed per-function serializer.

This guard is deliberately conservative rather than a proof of runtime data.
TypeScript cannot detect non-finite numbers, cyclic or shared references,
runtime getters, `toJSON` behavior, or data-only class instances that resemble
plain objects. Opaque, generic, or deeply recursive types may also require an
explicit serializer.

Providing `Serializer<T>`, including an explicitly typed
`JsonSerializer<T>`, is a trusted caller assertion. DialCache does not perform
an additional serialize-and-deserialize cycle to validate it.
