import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  UseCaseNameIsReservedError,
  type DialCacheKey,
  type DialCacheMetricsAdapter,
  type Serializer,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const localOnly = (ttlSec = 60): DialCacheKeyConfig =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: ttlSec },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = (ttlSec = 60): DialCacheKeyConfig =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: ttlSec },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

function spyMetrics(): DialCacheMetricsAdapter {
  return {
    request: vi.fn(),
    miss: vi.fn(),
    disabled: vi.fn(),
    error: vi.fn(),
    invalidation: vi.fn(),
    coalesced: vi.fn(),
    observeGet: vi.fn(),
    observeFallback: vi.fn(),
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
}

describe("DialCache getOrLoad", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses a stable use case without registering it and still rejects the reserved name", async () => {
    const dialcache = new DialCache();
    let calls = 0;
    const options = {
      keyType: "user_id",
      useCase: "InlineStableUseCase",
      key: "123",
      defaultConfig: localOnly(),
    } as const;

    const first = await dialcache.enable(async () =>
      await dialcache.getOrLoad(async () => ({ calls: ++calls }), options),
    );
    const second = await dialcache.enable(async () =>
      await dialcache.getOrLoad(async () => ({ calls: ++calls }), options),
    );

    const registered = dialcache.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "InlineStableUseCase",
      cacheKey: (id) => id,
    });
    const afterRegistration = await dialcache.getOrLoad(async () => "pass-through", {
      keyType: "user_id",
      useCase: "InlineStableUseCase",
      key: "other",
    });

    expect(first).toEqual({ calls: 1 });
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(afterRegistration).toBe("pass-through");
    expect(registered).toBeTypeOf("function");
    expect(() =>
      dialcache.getOrLoad(async () => "value", {
        keyType: "user_id",
        useCase: "watermark",
        key: "123",
      }),
    ).toThrow(UseCaseNameIsReservedError);
  });

  it("uses captured values from each invocation and requires them in the direct key", async () => {
    const dialcache = new DialCache();
    let calls = 0;
    const buildProfile = async (userId: string, locale: string) =>
      await dialcache.getOrLoad(
        async () => ({ userId, locale, calls: ++calls }),
        {
          keyType: "user_id",
          useCase: "BuildInlineProfile",
          key: { id: userId, args: { locale } },
          defaultConfig: localOnly(),
        },
      );

    const values = await dialcache.enable(async () => [
      await buildProfile("u1", "en"),
      await buildProfile("u1", "fr"),
      await buildProfile("u2", "en"),
      await buildProfile("u1", "en"),
    ]);

    expect(values).toEqual([
      { userId: "u1", locale: "en", calls: 1 },
      { userId: "u1", locale: "fr", calls: 2 },
      { userId: "u2", locale: "en", calls: 3 },
      { userId: "u1", locale: "en", calls: 1 },
    ]);
    expect(calls).toBe(3);
  });

  it.each([
    ["request-local", "InlineRequestLocalCoalescing", new DialCacheKeyConfig({ requestLocal: true }), 0],
    ["process", "InlineProcessCoalescing", localOnly(), 1],
  ] as const)("preserves %s same-key single-flight behavior", async (_scope, useCase, defaultConfig, activeLeaders) => {
    const dialcache = new DialCache();
    const gate = deferred<void>();
    let calls = 0;
    const options = {
      keyType: "user_id",
      useCase,
      key: "123",
      defaultConfig,
    } as const;

    const pending = dialcache.enable(async () => {
      const leader = dialcache.getOrLoad(async () => {
        calls += 1;
        await gate.promise;
        return { source: "leader" };
      }, options);
      const follower = dialcache.getOrLoad(async () => {
        calls += 1;
        return { source: "follower" };
      }, options);

      await tick();
      expect(dialcache.getCoalescingState().process.activeLeaders).toBe(activeLeaders);
      gate.resolve();
      return await Promise.all([leader, follower]);
    });

    const [leader, follower] = await pending;

    expect(calls).toBe(1);
    expect(follower).toBe(leader);
    expect(follower).toEqual({ source: "leader" });
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("is true pass-through outside an enabled scope", async () => {
    const dialcache = new DialCache();
    let calls = 0;
    const key = Object.defineProperty({}, "id", {
      get: () => {
        throw new Error("disabled getOrLoad should not inspect the key");
      },
    }) as { readonly id: string };
    const options = {
      keyType: "user_id",
      useCase: "InlineDisabledContext",
      key,
      defaultConfig: localOnly(),
      fallbackTimeoutMs: 1,
    } as const;

    const first = await dialcache.getOrLoad(async () => ({ calls: ++calls }), options);
    const second = await dialcache.getOrLoad(async () => ({ calls: ++calls }), options);

    expect(first).toEqual({ calls: 1 });
    expect(second).toEqual({ calls: 2 });
  });

  it("validates and snapshots defaultConfig independently for each invocation", async () => {
    const seenKeys: DialCacheKey[] = [];
    const dialcache = new DialCache({
      cacheConfigProvider: (key) => {
        seenKeys.push(key);
        return DialCacheKeyConfig.disabled();
      },
    });
    const defaultConfig = localOnly(60);
    const options = {
      keyType: "user_id",
      useCase: "InlineDefaultSnapshot",
      key: "123",
      defaultConfig,
    } as const;

    await dialcache.enable(async () => await dialcache.getOrLoad(async () => "first", options));
    defaultConfig.ttlSec[CacheLayer.LOCAL] = 30;
    await dialcache.enable(async () => await dialcache.getOrLoad(async () => "second", options));

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]?.defaultConfig?.ttlSec[CacheLayer.LOCAL]).toBe(60);
    expect(seenKeys[1]?.defaultConfig?.ttlSec[CacheLayer.LOCAL]).toBe(30);
    expect(Object.isFrozen(seenKeys[0]?.defaultConfig)).toBe(true);
    expect(() =>
      dialcache.getOrLoad(async () => "invalid", {
        ...options,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.LOCAL]: 0 },
        }),
      }),
    ).toThrow(new RangeError("DialCache defaultConfig ttlSec.local must be a positive safe integer"));
  });

  it("reads and writes Redis values with the per-invocation serializer", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    const serializer: Serializer<Date> = {
      dump: vi.fn((value) => value.toISOString()),
      load: vi.fn((value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value)),
    };
    let calls = 0;
    const options = {
      keyType: "user_id",
      useCase: "InlineRedisDate",
      key: "123",
      defaultConfig: remoteOnly(),
      serializer,
    } as const;

    const first = await dialcache.enable(async () =>
      await dialcache.getOrLoad(async () => {
        calls += 1;
        return new Date("2026-07-23T12:00:00.000Z");
      }, options),
    );
    const second = await dialcache.enable(async () =>
      await dialcache.getOrLoad(async (): Promise<Date> => {
        calls += 1;
        throw new Error("Redis hit should not invoke the loader");
      }, options),
    );

    expect(first.toISOString()).toBe("2026-07-23T12:00:00.000Z");
    expect(second.toISOString()).toBe(first.toISOString());
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
    expect(serializer.dump).toHaveBeenCalledTimes(1);
    expect(serializer.load).toHaveBeenCalledTimes(1);
  });

  it("preserves tracked invalidation behavior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T13:00:00.000Z"));
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    let version = 1;
    const load = async () =>
      await dialcache.getOrLoad(
        async () => ({ version }),
        {
          keyType: "user_id",
          useCase: "InlineTrackedProfile",
          key: "123",
          trackForInvalidation: true,
          defaultConfig: remoteOnly(),
        },
      );

    const first = await dialcache.enable(load);
    version = 2;
    vi.advanceTimersByTime(1);
    await dialcache.invalidateRemote("user_id", "123");
    vi.advanceTimersByTime(1);
    const second = await dialcache.enable(load);

    expect(first).toEqual({ version: 1 });
    expect(second).toEqual({ version: 2 });
  });

  it("fails open through Redis read and write failures", async () => {
    const redis = new FakeRedis();
    redis.failGet = true;
    redis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({ redis: { client: redis }, logger });
    let calls = 0;
    const load = async () =>
      await dialcache.getOrLoad(
        async () => ({ calls: ++calls }),
        {
          keyType: "user_id",
          useCase: "InlineRedisFailOpen",
          key: "123",
          defaultConfig: remoteOnly(),
        },
      );

    const first = await dialcache.enable(load);
    const second = await dialcache.enable(load);

    expect(first).toEqual({ calls: 1 });
    expect(second).toEqual({ calls: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("propagates loader errors, records them as fallback failures, and clears the flight", async () => {
    const metrics = spyMetrics();
    const dialcache = new DialCache({ metrics });
    const error = new Error("loader failed");
    const options = {
      keyType: "user_id",
      useCase: "InlineLoaderError",
      key: "123",
      defaultConfig: localOnly(),
    } as const;

    await expect(
      dialcache.enable(async () =>
        await dialcache.getOrLoad(async () => {
          throw error;
        }, options),
      ),
    ).rejects.toBe(error);
    const recovered = await dialcache.enable(async () =>
      await dialcache.getOrLoad(async () => "recovered", options),
    );

    expect(recovered).toBe("recovered");
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "InlineLoaderError",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
      error: "fallback",
      inFallback: true,
    });
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("applies the per-invocation fallback deadline inside enabled scopes", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const dialcache = new DialCache();
    const started = deferred<void>();
    const pending = dialcache.enable(async () =>
      await dialcache.getOrLoad(
        async () => {
          started.resolve();
          return await new Promise<string>(() => undefined);
        },
        {
          keyType: "user_id",
          useCase: "InlineFallbackDeadline",
          key: "123",
          defaultConfig: localOnly(),
          fallbackTimeoutMs: 25,
        },
      ),
    );
    await started.promise;
    const rejection = expect(pending).rejects.toMatchObject({
      name: FallbackTimeoutError.name,
      useCase: "InlineFallbackDeadline",
      timeoutMs: 25,
    });

    nowMs = 25;
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });
});
