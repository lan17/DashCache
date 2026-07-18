import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  type CacheMetricLabels,
  type CoalescedMetricLabels,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type InvalidationMetricLabels,
  type SerializationMetricLabels,
  type Serializer,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly events: Array<{ readonly name: string; readonly labels: Record<string, unknown>; readonly value?: number }> = [];

  request(labels: CacheMetricLabels): void {
    this.record("request", labels);
  }

  miss(labels: CacheMetricLabels): void {
    this.record("miss", labels);
  }

  disabled(labels: DisabledMetricLabels): void {
    this.record("disabled", labels);
  }

  error(labels: ErrorMetricLabels): void {
    this.record("error", labels);
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.record("invalidation", labels);
  }

  coalesced(labels: CoalescedMetricLabels): void {
    this.record("coalesced", labels);
  }

  observeGet(labels: CacheMetricLabels, seconds: number): void {
    this.record("get", labels, seconds);
  }

  observeFallback(labels: CacheMetricLabels, seconds: number): void {
    this.record("fallback", labels, seconds);
  }

  observeSerialization(labels: SerializationMetricLabels, seconds: number): void {
    this.record("serialization", labels, seconds);
  }

  observeSize(labels: CacheMetricLabels, bytes: number): void {
    this.record("size", labels, bytes);
  }

  private record(name: string, labels: object, value?: number): void {
    this.events.push({ name, labels: { ...labels }, ...(value === undefined ? {} : { value }) });
  }
}

const localOnly = (ttlSec = 60) =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: ttlSec },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("DialCache observability metrics", () => {
  it("includes the configured cache namespace on every metric path", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    let releaseFallback: () => void = () => undefined;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    const dialcache = new DialCache({
      namespace: "users-cache",
      metrics,
      redis: { client: redis },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const getUser = dialcache.cached(async (userId: string) => {
      if (userId === "123") {
        await fallbackGate;
      }
      return { userId };
    }, {
      keyType: "user_id",
      useCase: "NamespaceMetrics",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });
    const badKey = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "NamespaceNoKeyMetrics",
      cacheKey: () => {
        throw new Error("bad key");
      },
      defaultConfig: localOnly(),
    });

    await getUser("disabled");
    const pending = dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));
    await tick();
    releaseFallback();
    await pending;
    await dialcache.enable(async () => await badKey("123"));
    await dialcache.invalidateRemote("user_id", "123");

    expect(new Set(metrics.events.map(({ name }) => name))).toEqual(
      new Set([
        "request",
        "miss",
        "disabled",
        "error",
        "invalidation",
        "coalesced",
        "get",
        "fallback",
        "serialization",
        "size",
      ]),
    );
    expect(metrics.events.every(({ labels }) => labels.cacheNamespace === "users-cache")).toBe(true);
    expect(events(metrics, "disabled", { useCase: "NamespaceMetrics", layer: "noop", reason: "context" })).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "NamespaceNoKeyMetrics",
        layer: "noop",
        error: "key_construction",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(events(metrics, "invalidation", { keyType: "user_id", layer: CacheLayer.REMOTE })).toHaveLength(1);
  });

  it("supports an injected metrics adapter without requiring Prometheus", async () => {
    // Given a custom in-memory metrics adapter.
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "CustomMetricsAdapter",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    // When a local miss is followed by a local hit.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the adapter receives behavioral request/miss/timer events for the local layer.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(events(metrics, "request", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(2);
    expect(events(metrics, "miss", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(1);
    expect(events(metrics, "fallback", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(1);
    expect(events(metrics, "get", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(2);
  });

  it("reports request-local cache activity and request-scoped coalescing with bounded labels", async () => {
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalMetrics",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const values = await dialcache.enable(async () => {
      const concurrent = await Promise.all([getUser("123"), getUser("123")]);
      return [...concurrent, await getUser("123")];
    });

    expect(values[1]).toBe(values[0]);
    expect(values[2]).toBe(values[0]);
    expect(calls).toBe(1);
    expect(events(metrics, "request", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(2);
    expect(events(metrics, "miss", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(1);
    expect(events(metrics, "get", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(2);
    expect(events(metrics, "fallback", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(1);
    expect(events(metrics, "coalesced", { useCase: "RequestLocalMetrics", scope: "request_local" })).toHaveLength(1);
  });

  it("fails open when an injected metrics adapter throws", async () => {
    // Given a custom metrics adapter throws for every metric call.
    const throwingMetrics: DialCacheMetricsAdapter = {
      request: () => { throw new Error("metrics unavailable"); },
      miss: () => { throw new Error("metrics unavailable"); },
      disabled: () => { throw new Error("metrics unavailable"); },
      error: () => { throw new Error("metrics unavailable"); },
      invalidation: () => { throw new Error("metrics unavailable"); },
      observeGet: () => { throw new Error("metrics unavailable"); },
      observeFallback: () => { throw new Error("metrics unavailable"); },
      observeSerialization: () => { throw new Error("metrics unavailable"); },
      observeSize: () => { throw new Error("metrics unavailable"); },
    };
    const dialcache = new DialCache({ metrics: throwingMetrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ThrowingMetricsFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    // When metrics emission fails around a cache miss and hit.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then metrics failures do not break application fallback or cache behavior.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
  });

  it("fails open when the coalesced metrics hook throws", async () => {
    const metrics = new RecordingMetrics();
    const coalesced = vi.spyOn(metrics, "coalesced").mockImplementation(() => {
      throw new Error("metrics unavailable");
    });
    let releaseFallback: () => void = () => undefined;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => {
      calls += 1;
      await fallbackGate;
      return { userId, calls };
    }, {
      keyType: "user_id",
      useCase: "ThrowingCoalescedMetricFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    const inflight = dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));
    await tick();

    expect(calls).toBe(1);
    expect(coalesced).toHaveBeenCalledTimes(1);

    releaseFallback();

    await expect(inflight).resolves.toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 1 },
    ]);
  });

  it("classifies disabled cache skips by reason", async () => {
    // Given one cache call is outside context and other enabled calls have disabled layer config.
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ metrics });
    const contextDisabled = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByContext",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    const missingConfig = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByMissingConfig",
      cacheKey: (userId) => userId,
    });
    const invalidTtl = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByInvalidTtl",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(0),
    });
    const rampedDown = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByRamp",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 0 },
      }),
    });

    // When each path is called.
    await contextDisabled("123");
    await dialcache.enable(async () => {
      await missingConfig("123");
      await invalidTtl("123");
      await rampedDown("123");
    });

    // Then disabled metrics preserve the operational reason labels.
    expect(events(metrics, "disabled", { useCase: "DisabledByContext", layer: "noop", reason: "context" })).toHaveLength(1);
    expect(
      events(metrics, "disabled", { useCase: "DisabledByMissingConfig", layer: CacheLayer.LOCAL, reason: "missing_config" }),
    ).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByInvalidTtl", layer: CacheLayer.LOCAL, reason: "invalid_ttl" })).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByRamp", layer: CacheLayer.LOCAL, reason: "ramped_down" })).toHaveLength(1);
  });

  it("labels cache errors separately from fallback errors", async () => {
    // Given cache and fallback errors carry caller-defined names containing dynamic identifiers.
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cacheError = new Error("redis key urn:user_id:tenant-123 failed");
    cacheError.name = "Tenant123RedisError";
    const failingRedis: DialCacheRedisClient = {
      read: vi.fn(async () => {
        throw cacheError;
      }),
      write: vi.fn(async () => true),
      invalidate: vi.fn(async () => undefined),
    };
    const cacheFailure = new DialCache({ redis: { client: failingRedis }, metrics, logger });
    const readThroughFailure = cacheFailure.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "CacheErrorClassification",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });
    const fallbackCache = new DialCache({ redis: { client: new FakeRedis() }, metrics, logger });
    const fallbackFailure = fallbackCache.cached(async (userId: string) => {
      const fallbackError = new TypeError("database failed for tenant-456");
      fallbackError.name = "Tenant456DatabaseError";
      throw fallbackError;
    }, {
      keyType: "user_id",
      useCase: "FallbackErrorClassification",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    // When the cache error fails open and the fallback error escapes.
    await cacheFailure.enable(async () => await readThroughFailure("123"));
    await expect(fallbackCache.enable(async () => await fallbackFailure("123"))).rejects.toThrow("database failed for tenant-456");

    // Then stable failure sites reach the adapter without raw names, messages, IDs, or Redis keys.
    expect(
      events(metrics, "error", {
        useCase: "CacheErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "cache_read",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "FallbackErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(events(metrics, "error", {}))).not.toMatch(
      /Tenant123RedisError|Tenant456DatabaseError|tenant-123|tenant-456|urn:user_id/,
    );
  });

  it("classifies config, Redis write, and serializer failures by stable operation", async () => {
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const configFailure = new DialCache({
      metrics,
      logger,
      rampSampler: () => {
        throw new Error("tenant-123 ramp source failed");
      },
    });
    const resolveConfig = configFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "ConfigErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 50 },
      }),
    });
    await configFailure.enable(async () => await resolveConfig("123"));

    const failingWriteRedis = new FakeRedis();
    failingWriteRedis.failSet = true;
    const writeFailure = new DialCache({ redis: { client: failingWriteRedis }, metrics, logger });
    const writeValue = writeFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "WriteErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
    });
    await writeFailure.enable(async () => await writeValue("123"));

    const dumpError = new Error("tenant-456 serializer dump failed");
    dumpError.name = "Tenant456DumpError";
    const dumpSerializer: Serializer<string> = {
      dump: async () => {
        throw dumpError;
      },
      load: async (value) => value.toString(),
    };
    const dumpFailure = new DialCache({ redis: { client: new FakeRedis() }, metrics, logger });
    const dumpValue = dumpFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "SerializationDumpClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
      serializer: dumpSerializer,
    });
    await dumpFailure.enable(async () => await dumpValue("123"));

    const loadRedis = new FakeRedis();
    const loadWriter = new DialCache({ redis: { client: loadRedis } });
    const writeLoadFixture = loadWriter.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "SerializationLoadClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
    });
    await loadWriter.enable(async () => await writeLoadFixture("123"));
    const loadError = new Error("tenant-789 serializer load failed");
    loadError.name = "Tenant789LoadError";
    const loadSerializer: Serializer<string> = {
      dump: async (value) => value,
      load: async () => {
        throw loadError;
      },
    };
    const loadFailure = new DialCache({ redis: { client: loadRedis }, metrics, logger });
    const loadValue = loadFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "SerializationLoadClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
      serializer: loadSerializer,
    });
    await loadFailure.enable(async () => await loadValue("123"));

    expect(
      events(metrics, "error", {
        useCase: "ConfigErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "config_resolution",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "WriteErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "cache_write",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "SerializationDumpClassification",
        layer: CacheLayer.REMOTE,
        error: "serialization_dump",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "SerializationDumpClassification",
        layer: CacheLayer.REMOTE,
        error: "cache_write",
        inFallback: false,
      }),
    ).toHaveLength(0);
    expect(
      events(metrics, "error", {
        useCase: "SerializationLoadClassification",
        layer: CacheLayer.REMOTE,
        error: "serialization_load",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "miss", {
        useCase: "SerializationLoadClassification",
        layer: CacheLayer.REMOTE,
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(events(metrics, "error", {}))).not.toMatch(
      /Tenant456DumpError|Tenant789LoadError|tenant-456|tenant-789/,
    );
  });

  it("classifies provider and remote layer config failures", async () => {
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const providerError = new Error("config provider failed for tenant-123");
    providerError.name = "Tenant123ConfigProviderError";
    const providerFailure = new DialCache({
      metrics,
      logger,
      cacheConfigProvider: async () => {
        throw providerError;
      },
    });
    const resolveProviderConfig = providerFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "ProviderConfigErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    const remoteError = new Error("remote ramp failed for tenant-456");
    remoteError.name = "Tenant456RemoteRampError";
    const remoteFailure = new DialCache({
      redis: { client: new FakeRedis() },
      metrics,
      logger,
      rampSampler: ({ layer }) => {
        if (layer === CacheLayer.REMOTE) {
          throw remoteError;
        }
        return 0;
      },
    });
    const resolveRemoteConfig = remoteFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "RemoteConfigErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 50 },
      }),
    });

    await providerFailure.enable(async () => await resolveProviderConfig("123"));
    await remoteFailure.enable(async () => await resolveRemoteConfig("456"));

    expect(
      events(metrics, "error", {
        useCase: "ProviderConfigErrorClassification",
        layer: "noop",
        error: "config_resolution",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "RemoteConfigErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "config_resolution",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(events(metrics, "error", {}))).not.toMatch(
      /Tenant123ConfigProviderError|Tenant456RemoteRampError|tenant-123|tenant-456/,
    );
  });

  it("classifies local cache reads and writes", async () => {
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const readFailure = new DialCache({ metrics, logger });
    const readLocalCache = (readFailure as unknown as {
      readonly localCache: { getWithResolvedConfig: () => unknown };
    }).localCache;
    vi.spyOn(readLocalCache, "getWithResolvedConfig").mockImplementationOnce(() => {
      throw new Error("local read failed");
    });
    const readValue = readFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "LocalReadErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    const writeFailure = new DialCache({ metrics, logger });
    const writeLocalCache = (writeFailure as unknown as {
      readonly localCache: { put: () => Promise<void> };
    }).localCache;
    vi.spyOn(writeLocalCache, "put").mockRejectedValueOnce(new Error("local write failed"));
    const writeValue = writeFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "LocalWriteErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    await readFailure.enable(async () => await readValue("123"));
    await writeFailure.enable(async () => await writeValue("456"));

    expect(
      events(metrics, "error", {
        useCase: "LocalReadErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "cache_read",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "LocalWriteErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "cache_write",
        inFallback: false,
      }),
    ).toHaveLength(1);
  });

  it("labels fallback errors with every reachable metric layer", async () => {
    const metrics = new RecordingMetrics();
    const noopFailure = new DialCache({ metrics });
    const noopFallback = noopFailure.cached(async () => {
      throw new Error("noop fallback failed");
    }, {
      keyType: "user_id",
      useCase: "NoopFallbackErrorClassification",
      cacheKey: () => {
        throw new Error("key construction failed");
      },
      defaultConfig: localOnly(),
    });
    const requestLocalFailure = new DialCache({ metrics });
    const requestLocalFallback = requestLocalFailure.cached(async (_id: string) => {
      throw new Error("request-local fallback failed");
    }, {
      keyType: "user_id",
      useCase: "RequestLocalFallbackErrorClassification",
      cacheKey: (id: string) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });
    const localFailure = new DialCache({ metrics });
    const localFallback = localFailure.cached(async (_id: string) => {
      throw new Error("local fallback failed");
    }, {
      keyType: "user_id",
      useCase: "LocalFallbackErrorClassification",
      cacheKey: (id: string) => id,
      defaultConfig: localOnly(),
    });
    const remoteFailure = new DialCache({ redis: { client: new FakeRedis() }, metrics });
    const remoteFallback = remoteFailure.cached(async (_id: string) => {
      throw new Error("remote fallback failed");
    }, {
      keyType: "user_id",
      useCase: "RemoteFallbackErrorClassification",
      cacheKey: (id: string) => id,
      defaultConfig: remoteOnly(),
    });

    await expect(noopFailure.enable(async () => await noopFallback())).rejects.toThrow("noop fallback failed");
    await expect(requestLocalFailure.enable(async () => await requestLocalFallback("123"))).rejects.toThrow(
      "request-local fallback failed",
    );
    await expect(localFailure.enable(async () => await localFallback("123"))).rejects.toThrow("local fallback failed");
    await expect(remoteFailure.enable(async () => await remoteFallback("123"))).rejects.toThrow("remote fallback failed");

    expect(
      events(metrics, "error", {
        useCase: "NoopFallbackErrorClassification",
        layer: "noop",
        error: "key_construction",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "NoopFallbackErrorClassification",
        layer: "noop",
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "RequestLocalFallbackErrorClassification",
        layer: "request_local",
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "LocalFallbackErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "RemoteFallbackErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
  });

});

function events(
  metrics: RecordingMetrics,
  name: string,
  labels: Record<string, string | boolean>,
): Array<{ readonly name: string; readonly labels: Record<string, unknown>; readonly value?: number }> {
  return metrics.events.filter(
    (event) => event.name === name && Object.entries(labels).every(([key, value]) => event.labels[key] === value),
  );
}
