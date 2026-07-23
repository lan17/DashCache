# Coalescing and fallback liveness

[Back to the README](../README.md)

DialCache shares same-key in-flight work within the lifetime of the first active
cache layer. It also applies a default deadline once an initially enabled
invocation begins its wrapped fallback.

These mechanisms reduce duplicate source work and give active flights eventual
cleanup. They do not replace cross-process coordination, source-native
cancellation, application admission control, or backpressure.

## Request coalescing

DialCache has two sharing scopes.

### Request-local scope

When request-local caching is active, callers with the same key in one outermost
`enable()` scope share in-flight work before the request-local lookup.

The resolved value is memoized for later sequential calls in that scope. A
different outer request has a different request-local flight registry.

### Process scope

When process-local or remote caching is active, same-key callers share work
within one `DialCache` instance before the first active shared layer.

This is reported as `scope="process"`, but it is instance-scoped:

- separate requests using the same `DialCache` instance can share;
- separate `DialCache` instances in one process do not share; and
- separate processes or hosts do not share.

```ts
await dialcache.enable(async () => {
  // Same cold key and active shared layer:
  // one fallback execution, one shared result.
  const [first, second] = await Promise.all([
    getUser("456"),
    getUser("456"),
  ]);
});
```

With a remote layer configured, an instance-scoped leader that misses
process-local cache performs the Redis read. On a remote miss, it runs the
fallback and cache write. Followers await that result.

For a process-local-only miss, followers share the leader's fallback and local
write. This mitigates a thundering herd on one hot key within the instance.

## When calls do not coalesce

Coalescing applies only when at least one cache layer is active:

- calls that start outside `enable()` are true pass-through;
- initially enabled calls with every layer disabled are uncached and
  uncoalesced; and
- process-scoped work is never shared across `DialCache` instances.

An initially enabled all-disabled call still receives the fallback deadline
described below.

Because coalescing is keyed by `cacheKey`, concurrent calls with the same key
share the leader's execution. Every argument ignored by `cacheKey` must be safe
to share this way.

Include locale, auth context, cancellation behavior, or any other input in the
key when it can change:

- the returned value;
- whether the underlying function should run independently; or
- whether two callers may safely share one result.

## Fallback deadlines

Once an initially enabled invocation begins its wrapped fallback, DialCache
applies a 60-second monotonic deadline by default.

Set `fallbackTimeoutMs` on a cached wrapper to choose a positive integer
deadline in milliseconds, up to 2,147,483,647. Set it to `null` only when the
application intentionally accepts an unbounded fallback:

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
  throw error;
}
```

### When the timer runs

The timer starts only when the fallback begins:

- same-key followers share the request-local or process leader's remaining
  budget and receive its `FallbackTimeoutError`;
- enabled pass-through invocations where every layer is disabled have
  independent timers;
- cache hits create no fallback timer; and
- calls that began outside an enabled context remain true pass-through and are
  not timed out, even when the wrapper has `fallbackTimeoutMs`.

The fallback deadline does not cover work that happens before fallback, such as
a pending config provider, ramp sampler, Redis read, or serializer load. It also
does not cover serialization or a Redis write after the fallback resolves.
Every injected asynchronous operation needs its own finite,
application-defined budget.

### Event-loop behavior

Deadline delivery requires the JavaScript event loop to make progress. It
cannot preempt a synchronous fallback prefix or other event-loop blocking.
Rejection can therefore arrive later than the configured duration.

When control returns, DialCache checks the monotonic deadline before accepting
the result. The timer remains referenced until the fallback settles or times
out. An abandoned enabled fallback can keep an otherwise idle short-lived
process alive until the deadline.

Shutdown code should drain outstanding DialCache work rather than discarding
its promises.

### Timeout does not cancel the source

Timing out:

1. rejects the DialCache chain;
2. clears its tracked flight normally;
3. ignores a later fallback resolution; and
4. prevents that invocation from proceeding to serializer, Redis, or local
   publication.

The underlying function is not canceled and may continue its own I/O or side
effects. Give the source operation a native timeout or `AbortSignal` whenever
possible.

`fallbackTimeoutMs: null` disables the guard and makes finite fallback
settlement entirely application-owned. Use that escape hatch only after
intentionally accepting the liveness risk.

Timeout failures retain the bounded metrics classification
`error="fallback"` with `in_fallback="true"`. The typed error carries timeout
details without adding high-cardinality labels.

## Inspecting process-scoped flights

`getCoalescingState()` returns a detached, point-in-time snapshot of
process-scoped flights owned by one `DialCache` instance:

```ts
const state = dialcache.getCoalescingState();

state.process.activeLeaders;
state.process.activeFollowers;
state.process.oldestLeaderAgeMs; // null when idle
```

A leader is one exact cache key currently tracked by the instance-scoped
coalescer. A follower is each later invocation that joined that pending leader;
the initiating invocation is not counted as a follower.

Followers remain counted until their leader settles because abandoning a
JavaScript promise is not observable. Request-local flights are deliberately
excluded because their lifecycle is bounded by the outer `enable()` scope.
`oldestLeaderAgeMs` uses a monotonic clock and is computed when the snapshot is
requested.

## Admission control remains application-owned

There is no library-wide flight cap or age-based replacement.

A registry cap would bound only DialCache metadata. Overflow or eviction could
still create unbounded source work and unsafe duplicate publication. Finite
operation deadlines provide eventual cleanup; application admission control
and backpressure remain responsible for bounding simultaneous distinct-key
work.

Monitor:

- active leader count;
- active follower count;
- oldest leader age;
- fallback deadline errors; and
- source concurrency and saturation.

Use those signals to verify that application budgets and admission control hold
under production load.
