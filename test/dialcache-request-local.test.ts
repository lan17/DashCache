import { describe, expect, it, vi } from "vitest";

import { DialCache, DialCacheKeyConfig, type Serializer } from "../src/index.js";
import { DialCacheContext, RequestLocalCache, getOrCreateRequestLocalCache } from "../src/context.js";

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

const requestLocalConfig = (requestLocal = true): DialCacheKeyConfig =>
  new DialCacheKeyConfig({ requestLocal });

describe("DialCache request-local cache", () => {
  it("memoizes sequential request-local-only reads without sharing across outer scopes", async () => {
    const dialcache = new DialCache({ localMaxSize: 0 });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalScopeIsolation",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    const firstScope = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);
    const secondScope = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);

    expect(firstScope).toEqual([
      { id: "123", call: 1 },
      { id: "123", call: 1 },
    ]);
    expect(secondScope).toEqual([
      { id: "123", call: 2 },
      { id: "123", call: 2 },
    ]);
    expect(calls).toBe(2);
  });

  it("reuses the outer request-local scope through nested enable and disable boundaries", async () => {
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "NestedRequestLocalScope",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    const result = await dialcache.enable(async () => {
      const first = await getUser("123");
      const nestedEnabled = await dialcache.enable(async () => await getUser("123"));
      const nestedDisabled = await dialcache.disable(async () => {
        const bypass = await getUser("123");
        const reenabled = await dialcache.enable(async () => await getUser("123"));
        return { bypass, reenabled };
      });
      const after = await getUser("123");
      return { first, nestedEnabled, nestedDisabled, after };
    });

    expect(result.first).toEqual({ id: "123", call: 1 });
    expect(result.nestedEnabled).toBe(result.first);
    expect(result.nestedDisabled.bypass).toEqual({ id: "123", call: 2 });
    expect(result.nestedDisabled.reenabled).toBe(result.first);
    expect(result.after).toBe(result.first);
    expect(calls).toBe(2);
  });

  it("keeps enabled state isolated across concurrent sibling branches sharing one request holder", async () => {
    const disabledGate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "ConcurrentNestedScopeIsolation",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    const result = await dialcache.enable(async () => {
      const seeded = await getUser("123");
      const disabledBranch = dialcache.disable(async () => {
        await disabledGate.promise;
        return await getUser("123");
      });
      const enabledBranch = await getUser("123");
      disabledGate.resolve();
      return { seeded, enabledBranch, disabledBranch: await disabledBranch };
    });

    expect(result.enabledBranch).toBe(result.seeded);
    expect(result.disabledBranch).toEqual({ id: "123", call: 2 });
    expect(calls).toBe(2);
  });

  it("reads runtime config once per invocation and preserves scoped values across a true-false-true sequence", async () => {
    const configs = [requestLocalConfig(), requestLocalConfig(false), requestLocalConfig()];
    const cacheConfigProvider = vi.fn(async () => configs.shift() ?? null);
    const dialcache = new DialCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "RuntimeRequestLocalToggle",
      cacheKey: (id) => id,
    });

    const result = await dialcache.enable(async () => {
      const enabled = await getUser("123");
      const disabled = await getUser("123");
      const reenabled = await getUser("123");
      return { enabled, disabled, reenabled };
    });

    expect(result.enabled).toEqual({ id: "123", call: 1 });
    expect(result.disabled).toEqual({ id: "123", call: 2 });
    expect(result.reenabled).toBe(result.enabled);
    expect(calls).toBe(2);
    expect(cacheConfigProvider).toHaveBeenCalledTimes(3);
  });

  it("isolates distinct keys and distinguishes cached undefined from a miss", async () => {
    const dialcache = new DialCache();
    const calls = new Map<string, number>();
    const getOptional = dialcache.cached(async (id: string) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return id === "missing" ? undefined : { id };
    }, {
      keyType: "optional_id",
      useCase: "RequestLocalDistinctAndUndefined",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });
    const result = await dialcache.enable(async () => {
      const distinct = await Promise.all([getOptional("123"), getOptional("456")]);
      return [
        ...distinct,
        await getOptional("123"),
        await getOptional("missing"),
        await getOptional("missing"),
      ] as const;
    });

    expect(result).toEqual([{ id: "123" }, { id: "456" }, { id: "123" }, undefined, undefined]);
    expect(calls).toEqual(new Map([
      ["123", 1],
      ["456", 1],
      ["missing", 1],
    ]));
  });

  it("removes a rejected request-local in-flight entry so the same scope can retry", async () => {
    const gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      const call = ++calls;
      if (call === 1) {
        await gate.promise;
        throw new Error("database failed");
      }
      return { id, call };
    }, {
      keyType: "user_id",
      useCase: "RequestLocalRejectRetry",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    await dialcache.enable(async () => {
      const first = getUser("123");
      const follower = getUser("123");
      await tick();
      gate.resolve();

      const rejected = await Promise.allSettled([first, follower]);
      expect(rejected).toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "rejected", reason: expect.any(Error) },
      ]);
      expect(rejected[0]?.status === "rejected" ? rejected[0].reason.message : undefined).toBe("database failed");
      expect(rejected[1]?.status === "rejected" ? rejected[1].reason.message : undefined).toBe("database failed");

      const retry = await getUser("123");
      const cachedRetry = await getUser("123");
      expect(retry).toEqual({ id: "123", call: 2 });
      expect(cachedRetry).toBe(retry);
    });

    expect(calls).toBe(2);
  });

  it("does not let an active request-local flight repopulate a scope after its outer callback rejects", async () => {
    const fallbackStarted = deferred<void>();
    const fallbackGate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      const call = ++calls;
      if (call === 1) {
        fallbackStarted.resolve();
        await fallbackGate.promise;
      }
      return { id, call };
    }, {
      keyType: "user_id",
      useCase: "RequestLocalRejectedScopeLifecycle",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });
    let detached!: Promise<{
      readonly enabled: boolean;
      readonly flight: { id: string; call: number };
      readonly later: readonly [{ id: string; call: number }, { id: string; call: number }];
    }>;

    await expect(dialcache.enable(async () => {
      const activeFlight = getUser("123");
      detached = (async () => {
        const flight = await activeFlight;
        return {
          enabled: dialcache.isEnabled(),
          flight,
          later: [await getUser("123"), await getUser("123")] as const,
        };
      })();

      await fallbackStarted.promise;
      throw new Error("request failed");
    })).rejects.toThrow("request failed");

    expect(dialcache.isEnabled()).toBe(false);
    expect(calls).toBe(1);
    fallbackGate.resolve();

    await expect(detached).resolves.toEqual({
      enabled: false,
      flight: { id: "123", call: 1 },
      later: [
        { id: "123", call: 2 },
        { id: "123", call: 3 },
      ],
    });

    const fresh = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);
    expect(fresh[0]).toEqual({ id: "123", call: 4 });
    expect(fresh[1]).toBe(fresh[0]);
    expect(calls).toBe(4);
  });

  it("treats detached work as outside its closed outer scope", async () => {
    const detachedGate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalLifecycle",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });
    let detached: Promise<{
      readonly enabled: boolean;
      readonly values: readonly [{ id: string; call: number }, { id: string; call: number }];
    }> | undefined;

    const scoped = await dialcache.enable(async () => {
      expect(dialcache.isEnabled()).toBe(true);
      const value = await getUser("123");

      detached = (async () => {
        await detachedGate.promise;
        return {
          enabled: dialcache.isEnabled(),
          values: [await getUser("123"), await getUser("123")] as const,
        };
      })();
      return value;
    });

    expect(scoped).toEqual({ id: "123", call: 1 });

    detachedGate.resolve();
    await expect(detached).resolves.toEqual({
      enabled: false,
      values: [
        { id: "123", call: 2 },
        { id: "123", call: 3 },
      ],
    });
    expect(calls).toBe(3);
  });

  it("keeps a call pass-through when runtime config resolves after its outer scope closes", async () => {
    const configGate = deferred<DialCacheKeyConfig>();
    const cacheConfigProvider = vi.fn(async () => await configGate.promise);
    const dialcache = new DialCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "DetachedConfigResolution",
      cacheKey: (id) => id,
    });
    let detached!: Promise<{ id: string; call: number }>;

    await dialcache.enable(() => {
      detached = getUser("123");
    });
    expect(cacheConfigProvider).toHaveBeenCalledTimes(1);
    configGate.resolve(DialCacheKeyConfig.enabled(60));

    await expect(detached).resolves.toEqual({ id: "123", call: 1 });
    const liveValues = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);
    expect(liveValues[0]).toEqual({ id: "123", call: 2 });
    expect(liveValues[1]).toBe(liveValues[0]);
    expect(calls).toBe(2);
    expect(cacheConfigProvider).toHaveBeenCalledTimes(3);
  });

  it("allocates request-local state lazily and closes it at the outer boundary", async () => {
    const close = vi.spyOn(RequestLocalCache.prototype, "close");
    const context = new DialCacheContext();
    let retained: RequestLocalCache | undefined;

    try {
      await context.enable(async () => undefined);
      expect(close).not.toHaveBeenCalled();

      await context.enable(async () => {
        retained = getOrCreateRequestLocalCache(context) ?? undefined;
        retained?.set("value", "cached");
        retained?.inFlight.set("flight", Promise.resolve("pending"));
      });

      expect(close).toHaveBeenCalledTimes(1);
      expect(retained?.read("value")).toEqual({ status: "miss" });
      expect(retained?.inFlight.size).toBe(0);
      retained?.set("late", "stale");
      expect(retained?.read("late")).toEqual({ status: "miss" });
    } finally {
      close.mockRestore();
    }
  });

  it("returns the original value reference without cloning", async () => {
    const dialcache = new DialCache();
    const source = {
      id: "123",
      roles: ["reader"],
      metadata: new Map([["region", "us-west"]]),
      flags: new Set(["active"]),
      buffer: Buffer.from("cached"),
      typed: new Uint8Array([1, 2, 3]),
    };
    const serializer: Serializer<typeof source> = {
      dump: () => {
        throw new Error("request-local-only serializer should not be used");
      },
      load: () => {
        throw new Error("request-local-only serializer should not be used");
      },
    };
    let calls = 0;
    const getUser = dialcache.cached(async () => {
      calls += 1;
      return source;
    }, {
      keyType: "user_id",
      useCase: "RequestLocalReferenceIdentity",
      cacheKey: () => "123",
      defaultConfig: requestLocalConfig(),
      serializer,
    });

    const [first, second] = await dialcache.enable(async () => [await getUser(), await getUser()] as const);

    expect(first).toBe(source);
    expect(second).toBe(source);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("does not apply the process-local entry cap to request-local values", async () => {
    const dialcache = new DialCache({ localMaxSize: 1 });
    let calls = 0;
    const getValue = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "item_id",
      useCase: "UnboundedRequestLocalEntries",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    await dialcache.enable(async () => {
      const first = await getValue("0");
      const second = await getValue("1");
      expect(await getValue("0")).toBe(first);
      expect(await getValue("1")).toBe(second);
    });

    expect(calls).toBe(2);
  });
});
