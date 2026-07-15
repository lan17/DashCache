# AGENTS.md

## Project overview

DialCache is a TypeScript caching library with explicit request-scoped enablement, local and Redis layers, runtime rollout controls, request coalescing, targeted invalidation, and Prometheus-compatible observability.

## Structure

```text
src/
  dialcache.ts          # Main DialCache API and cached-function wrapper
  config.ts             # Public configuration and rollout types
  context.ts            # AsyncLocalStorage-based enabled context
  key.ts                # Structured cache keys and Redis hash tags
  metrics.ts            # Metrics adapter and Prometheus implementation
  redis-client.ts       # Client-independent semantic Redis interface
  node-redis.ts          # node-redis adapter and script registration
  redis-protocol.ts      # Public Lua protocol exports
  serializer.ts         # Serializer contract and JSON implementation
  internal/             # Cache layers, runtime config, and Lua scripts
test/                   # Unit and Redis integration tests
```

## Critical behavior

- Caching is disabled by default and enabled only inside `dialcache.enable(...)`.
- Disabled calls are true pass-through and must not build keys, resolve config, or coalesce work.
- Active same-key misses are coalesced after the local-cache check.
- Cache plumbing fails open; explicit maintenance operations surface mutation failures.
- Tracked Redis values and invalidation watermarks share a Redis Cluster hash tag.
- Tracked reads run on primaries so replica lag cannot hide invalidation.
- Local entries are process-local and are not synchronously invalidated across instances.

## Conventions

- Preserve strict TypeScript settings and public abstraction boundaries.
- Keep Redis client-specific behavior in adapters; core code depends on `DialCacheRedisClient`.
- Public exports belong in `src/index.ts`, `src/node-redis.ts`, or `src/redis-protocol.ts`.
- Use `corepack pnpm` for project commands.

## Validation

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:package
corepack pnpm test:integration
```
