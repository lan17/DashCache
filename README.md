# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

**Runtime-controlled caching for Node.js backends, built for gradual and
reversible rollout.**

DialCache wraps async read functions with one typed read-through cache path:
request-local memoization, a bounded process-local LRU, and optional Redis or
Valkey TTL caching. Define the key and baseline policy once, then call the
wrapped function normally.

The “dial” is the runtime control. Each use case can start with every layer
disabled, ramp either shared layer gradually from 0% to 100%, and turn
everything back off without changing the wrapped function. The default sampler
is deterministic by key, so a partial rollout keeps the same keys consistently
in or out.

DialCache is an application library, not a cache server or Redis connection
client. Redis and Valkey remain optional shared stores; DialCache coordinates
the read path, rollout policy, request coalescing, targeted invalidation, and
observability around them.

## Safety comes from explicit controls

- **Off by default.** Outside `dialcache.enable(...)`, a wrapped function is a
  true pass-through: DialCache does not build a key, resolve config, access a
  cache, or coalesce the call. Inside an enabled scope, a layer still needs an
  effective policy before it participates.
- **Gradual and reversible rollout.** Configure TTL and ramp independently for
  the process-local and remote layers. A ramp of `0` is off, `100` is fully on,
  and `DialCacheKeyConfig.disabled()` is the all-layer policy kill switch.
- **Fail-open cache path.** Key, config, cache-read, and serialization-load
  failures fall through to the wrapped function. Cache-write,
  serialization-dump, logging, and metrics failures do not replace an otherwise
  usable fallback result. Explicit remote invalidation failures are rethrown so
  callers never assume a mutation was made safe when it was not.
- **Bounded defaults.** The process-local cache has a 10,000-entry default cap,
  and enabled fallback executions have a 60-second default deadline. Injected
  Redis, config, ramp, and serializer operations still need finite
  application-owned budgets.

Use DialCache when you want to:

- add caching to database or service reads without scattering cache get/set
  plumbing across call sites;
- begin with one layer or a small deterministic sample, observe it, and expand
  or reverse the rollout per use case;
- combine request-local, process-local, and shared caching behind one key and
  policy contract; or
- coalesce hot-key misses, invalidate related Redis entries, and emit bounded
  cache metrics without rebuilding those mechanisms for every function.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Dial caching up or down](#dial-caching-up-or-down)
- [How the read path works](#how-the-read-path-works)
- [Core concepts](#core-concepts)
- [Production checklist](#production-checklist)
- [Reference guides](#reference-guides)

## Install

```bash
pnpm add dialcache
```

DialCache requires Node.js 20 or Node.js 22 and newer. Redis, Valkey, Prometheus,
and Datadog integrations are optional and keep their clients application-owned:

- [Redis and Valkey setup](docs/redis.md)
- [Prometheus and Datadog setup](docs/observability.md)

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

// Outside enable(), this is a true pass-through to db.fetchUser:
await getUser("123");

// Inside enable(), the active cache layers participate:
const user = await dialcache.enable(() => getUser("123"));
```

`cached(fn, options)` preserves the function's parameters and returns a
Promise-based wrapper. `DialCacheKeyConfig.enabled(60)` gives the process-local
and remote layers a 60-second baseline TTL; the remote layer participates only
when a Redis or Valkey client is configured.

Enable caching once at a read-request boundary instead of at every call site.
Keep nested mutation work uncached with `disable()`:

```ts
await dialcache.enable(async () => {
  const user = await getUser("123");

  await dialcache.disable(async () => {
    await updateUser("123", patch);
  });
});
```

Enabled state follows the current asynchronous call chain through Node
`AsyncLocalStorage`; it is not process-global. Nested scopes restore the
previous state when their callbacks settle.

`disable()` prevents cache access during its callback; it does not evict values
cached before a mutation. Use the appropriate invalidation or TTL policy before
serving later reads of mutable data.

## Dial caching up or down

Every cached function can declare a stable `defaultConfig`. An optional
`cacheConfigProvider` returns a sparse runtime overlay for the current key, so
policy can change independently of the wrapped function:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const runtimePolicies = new Map<string, DialCacheKeyConfig>();

const dialcache = new DialCache({
  cacheConfigProvider: (key) => runtimePolicies.get(key.useCase) ?? null,
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);

// Start with 10% of keys using process-local cache and remote cache off.
runtimePolicies.set(
  "GetUser",
  new DialCacheKeyConfig({
    ramp: {
      [CacheLayer.LOCAL]: 10,
      [CacheLayer.REMOTE]: 0,
    },
  }),
);

// Later, ramp both shared layers to 100%.
runtimePolicies.set(
  "GetUser",
  new DialCacheKeyConfig({
    ramp: {
      [CacheLayer.LOCAL]: 100,
      [CacheLayer.REMOTE]: 100,
    },
  }),
);

// Reverse the rollout without changing getUser.
runtimePolicies.set("GetUser", DialCacheKeyConfig.disabled());
```

In production, the provider can read from an application-owned dynamic config
client instead of an in-memory map. DialCache resolves one policy snapshot per
enabled invocation. Keep the provider cheap and give any asynchronous work its
own finite budget.

For the process-local and remote layers:

- a missing effective TTL disables that layer by policy;
- a configured TTL with no ramp defaults to `100`;
- `0` disables the layer;
- `100` enables the layer for every key; and
- an intermediate ramp uses the `rampSampler`, deterministic by key and layer
  by default.

Request-local caching is controlled separately by the `requestLocal` boolean.
`DialCacheKeyConfig.disabled()` sets it to `false` and ramps both shared layers
to `0`. Provider errors do not silently activate the baseline: the invocation
records a config error and runs the wrapped function uncached.

See [Configuration and cache layers](docs/configuration.md) for sparse-overlay
precedence, validation, custom sampling, and layer behavior.

## How the read path works

Inside an enabled scope, active layers are checked in order:

```text
request-local -> process-local LRU -> Redis or Valkey -> wrapped function
```

The wrapped function is the fallback and remains the source of the returned
value when every active layer misses or a cache operation fails open.

- A request-local hit returns the value memoized in the current outermost
  `enable()` scope.
- A process-local hit returns from the `DialCache` instance's bounded LRU.
- A process-local miss can read Redis and populate the process-local cache.
- A remote miss runs the fallback and attempts to populate active shared
  layers.
- Same-key concurrent work is coalesced at the lifetime of the first active
  layer.

When all layers are disabled by policy, an initially enabled call remains
uncached and uncoalesced, but its fallback deadline still applies. A call that
started outside an enabled scope remains a true pass-through and does not get a
DialCache deadline.

## Core concepts

### Cached functions and keys

`cached(fn, options)` defines both a callable and the value-identity contract:

| Option | Required | Purpose |
| --- | --- | --- |
| `keyType` | yes | Names the kind of id and, with `id`, the invalidation unit for tracked Redis entries. |
| `useCase` | yes | Identifies this individual cache in stored keys and metrics. |
| `cacheKey` | yes | Selects the bare id or `{ id, args }` from the function parameters. |
| `defaultConfig` | no | Supplies the baseline policy overlaid by runtime config. |
| `serializer` | for statically non-JSON return types | Defines the Redis representation for this function's value. |
| `trackForInvalidation` | no | Opts the remote entries into watermark-based targeted invalidation. |
| `fallbackTimeoutMs` | no | Sets the fallback deadline; defaults to `60_000`, and `null` disables it. |

The `cacheKey` selector must include every input dimension that can affect the
returned value. Same-key concurrent calls may share the leader's execution, so
ignored values such as auth context, locale, or cancellation behavior must
truly be safe to share.

Set a stable, application-specific `namespace` when applications or
environments share Redis:

```ts
const dialcache = new DialCache({
  namespace: "production-users-api",
  redis: { client: dialCacheRedisClient },
});
```

See [Configuration and cache layers](docs/configuration.md) for key encoding,
secondary arguments, namespace changes, serializers, and value ownership.

### Cache layers

| Layer | Scope | Primary use |
| --- | --- | --- |
| Request-local | Outermost `enable()` scope | Memoize repeated reads during one bounded request or job. |
| Process-local | One `DialCache` instance | Serve hot values from a bounded in-process LRU. |
| Redis or Valkey | Shared remote store | Reuse TTL-cached values across processes and hosts. |

Each invocation uses one resolved policy snapshot for all three layers.
Request-local storage has no capacity limit, so use it only for short-lived
scopes with bounded key cardinality. Process-local values count toward one
instance-wide entry cap. Remote values use a serializer selected by the cached
function or the Redis configuration.

Cached in-memory values are shared by reference. Treat every returned value as
immutable, or copy it explicitly before mutation.

### Targeted invalidation

Mutable Redis-backed use cases can opt into watermark-based invalidation with
`trackForInvalidation: true`, then call:

```ts
await updateUser("123", patch);
await dialcache.invalidateRemote(
  "user_id",
  "123",
  USER_INVALIDATION_BUFFER_MS,
);
```

Invalidation is deliberately remote-only. It does not evict existing
request-local or process-local values, so strongly invalidated mutable data
should disable those layers or tolerate their TTL-bounded staleness.

The buffer must be a named, application-owned nonzero value sized for clock
skew and the full stale-work window. See
[Targeted invalidation](docs/invalidation.md) before enabling it in production.

### Request coalescing and fallback deadlines

Concurrent callers with the same cache key share active work within the first
active cache scope: one outer request for request-local caching, or one
`DialCache` instance for the shared layers. This mitigates hot-key stampedes
inside that scope; it is not cross-process coordination.

Enabled fallbacks have a 60-second monotonic deadline by default. Timing out
rejects the DialCache chain and prevents the late result from being published,
but it does not cancel the underlying function. Give source operations their
own native timeout or `AbortSignal`.

See [Coalescing and fallback liveness](docs/coalescing.md) for exact sharing,
deadline, cleanup, and admission-control contracts.

### Observability

Metrics are disabled unless a `DialCacheMetricsAdapter` is supplied. First-party
adapters support caller-owned Prometheus registries and Datadog DogStatsD
clients. Bounded labels report layer requests, misses, disabled reasons,
coalescing scopes, serialization work, and cache versus fallback failures.

See [Observability](docs/observability.md) for installation, collector schemas,
metric names, and custom adapters.

## Production checklist

Before ramping a use case:

- enable DialCache only around read paths, and keep mutation paths inside
  `disable()` or outside the enabled boundary;
- verify that `cacheKey` includes every value and execution dimension that is
  unsafe to share;
- begin at `0` or a small deterministic ramp, monitor source load, cache errors,
  hit rate, latency, fallback deadlines, and coalescing state, then increase in
  controlled steps;
- keep a runtime path to `DialCacheKeyConfig.disabled()`;
- configure finite, resource-native budgets for Redis, config providers, ramp
  samplers, serializers, and the wrapped source operation;
- use a conservative `localMaxSize` and bounded request-local scopes;
- treat cached values as immutable;
- verify serializer compatibility across mixed application versions; and
- for tracked invalidation, synchronize promotion-eligible Redis clocks and
  size a nonzero buffer from measured or conservatively bounded timings.

## Reference guides

- [Configuration and cache layers](docs/configuration.md) — definitions, keys,
  runtime overlays, request-local and process-local behavior, and value
  ownership.
- [Redis and Valkey](docs/redis.md) — node-redis and GLIDE setup, lifecycle,
  liveness, binary protocol, and serialization.
- [Targeted invalidation](docs/invalidation.md) — watermarks, Redis Cluster
  placement, clock assumptions, and buffer sizing.
- [Coalescing and fallback liveness](docs/coalescing.md) — sharing scopes,
  deadlines, state inspection, cleanup, and backpressure.
- [Observability](docs/observability.md) — Prometheus, Datadog, metric schemas,
  error categories, and custom adapters.
- [Maintainer guide](docs/maintainers.md) — benchmarks and the protected release
  workflow.

DialCache is licensed under the [MIT License](LICENSE).
