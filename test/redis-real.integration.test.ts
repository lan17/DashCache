import { commandOptions, createClient } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";

const engines = [
  { name: "Redis 6.2", image: "redis:6.2-alpine" },
  { name: "Valkey 8", image: "valkey/valkey:8-alpine" },
] as const;

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestClient = (url: string) => createClient({ url, scripts: dialcacheRedisScripts });

function encodeFrame(payload: string | Buffer, encoding: number, createdAtMs = Date.now(), version = 1): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  return Buffer.concat([Buffer.from([version]), timestamp, Buffer.from([encoding]), Buffer.from(payload)]);
}

describe.each(engines)("DialCache Lua protocol on $name", ({ image }) => {
  let container: StartedTestContainer | undefined;
  let client: ReturnType<typeof createTestClient> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(image)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    client = createTestClient(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
    client.on("error", () => undefined);
    await client.connect();
  });

  afterAll(async () => {
    await client?.quit();
    await container?.stop();
  });

  it("round-trips untracked UTF-8 and binary values", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient: DialCacheRedisClient = createNodeRedisDialCacheClient(client);
    const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient } });
    let jsonCalls = 0;
    let binaryCalls = 0;
    const getJson = dialcache.cached(async (id: string) => ({ id, calls: ++jsonCalls }), {
      keyType: "item_id",
      useCase: "RealJson",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly,
    });
    const binarySerializer: Serializer<string> = {
      dump: async (value) => Buffer.from(value, "utf8"),
      load: async (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value),
    };
    const getBinary = dialcache.cached(async (id: string) => `binary:${id}:${++binaryCalls}`, {
      keyType: "item_id",
      useCase: "RealBinary",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly,
      serializer: binarySerializer,
    });

    const firstJson = await dialcache.enable(async () => await getJson("json"));
    const secondJson = await dialcache.enable(async () => await getJson("json"));
    const firstBinary = await dialcache.enable(async () => await getBinary("buffer"));
    const secondBinary = await dialcache.enable(async () => await getBinary("buffer"));

    expect(firstJson).toEqual({ id: "json", calls: 1 });
    expect(secondJson).toEqual(firstJson);
    expect(firstBinary).toBe("binary:buffer:1");
    expect(secondBinary).toBe(firstBinary);
    expect(jsonCalls).toBe(1);
    expect(binaryCalls).toBe(1);
  });

  it("stores arbitrary binary payloads without base64 expansion", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const payloads = [
      Buffer.alloc(0),
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
      Buffer.alloc(2 * 1024 * 1024, 0xa5),
    ];

    for (const [index, payload] of payloads.entries()) {
      const valueKey = `binary-raw:{item:${index}}:value`;
      expect(await scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: payload })).toBe(true);

      const roundTrip = await scriptClient.read({ valueKey });
      const stored = await client.get(commandOptions({ returnBuffers: true }), valueKey);

      expect(Buffer.isBuffer(roundTrip)).toBe(true);
      expect(roundTrip).toEqual(payload);
      expect(stored).not.toBeNull();
      expect(stored?.length).toBe(10 + payload.length);
      expect(stored?.[0]).toBe(1);
      expect(stored?.[9]).toBe(1);
      expect(stored?.subarray(10)).toEqual(payload);
    }

    const trackedValueKey = "binary-raw:{item:tracked}:value";
    const watermarkKey = "binary-raw:{item:tracked}:watermark";
    const trackedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
    expect(
      await scriptClient.write({
        valueKey: trackedValueKey,
        watermarkKey,
        cacheTtlMs: 60_000,
        value: trackedPayload,
        watermarkTtlFloorMs: 60_000,
      }),
    ).toBe(true);
    expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toEqual(trackedPayload);
  });

  it("recovers every distinct read and write script after SCRIPT FLUSH", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const valueKey = "script-recovery:{item:untracked}:value";

    expect(dialcacheRedisScripts.dialcacheRead.SHA1).not.toBe(dialcacheRedisScripts.dialcacheReadTracked.SHA1);
    expect(dialcacheRedisScripts.dialcacheWrite.SHA1).not.toBe(dialcacheRedisScripts.dialcacheWriteTracked.SHA1);

    await client.scriptFlush();
    expect(await client.dialcacheWrite(valueKey, 60_000, 0, "untracked")).toBe(1);
    await client.scriptFlush();
    expect(await scriptClient.read({ valueKey })).toBe("untracked");

    const trackedValueKey = "script-recovery:{item:tracked}:value";
    const watermarkKey = "script-recovery:{item:tracked}:watermark";
    await client.scriptFlush();
    expect(await client.dialcacheWriteTracked(trackedValueKey, watermarkKey, 60_000, 0, "tracked", 60_000)).toBe(1);
    await client.scriptFlush();
    expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toBe("tracked");
  });

  it("treats every invalid read frame and watermark state as a miss", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const valueKey = "read-paths:{item:read}:value";
    const watermarkKey = "read-paths:{item:read}:watermark";

    expect(await scriptClient.read({ valueKey })).toBeNull();

    await client.set(valueKey, Buffer.alloc(9));
    expect(await scriptClient.read({ valueKey })).toBeNull();

    await client.set(valueKey, encodeFrame("wrong-version", 0, 1_000, 2));
    expect(await scriptClient.read({ valueKey })).toBeNull();

    await client.set(valueKey, encodeFrame("tracked", 0, 1_000));
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

    await client.set(watermarkKey, "not-a-watermark");
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

    await client.set(watermarkKey, "9".repeat(400));
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

    await client.set(watermarkKey, "1000");
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

    await client.set(watermarkKey, "999.5");
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("tracked");
  });

  it("rejects invalid raw script arguments before mutating Redis", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const valueKey = "invalid-args:{item:invalid}:value";
    const watermarkKey = "invalid-args:{item:invalid}:watermark";
    const notANumber = "not-a-number" as unknown as number;

    await expect(client.dialcacheWrite(valueKey, 0, 0, "value")).rejects.toThrow("invalid DialCache TTL");
    await expect(client.dialcacheWrite(valueKey, notANumber, 0, "value")).rejects.toThrow("invalid DialCache TTL");
    await expect(client.dialcacheWrite(valueKey, Number.NaN, 0, "value")).rejects.toThrow("invalid DialCache TTL");
    await expect(client.dialcacheWrite(valueKey, Number.POSITIVE_INFINITY, 0, "value")).rejects.toThrow("invalid DialCache TTL");
    await expect(client.dialcacheWrite(valueKey, Number.NEGATIVE_INFINITY, 0, "value")).rejects.toThrow("invalid DialCache TTL");
    await expect(client.dialcacheWrite(valueKey, 1_000, notANumber, "value")).rejects.toThrow("invalid DialCache payload encoding");
    await expect(client.dialcacheWrite(valueKey, 1_000, Number.NaN, "value")).rejects.toThrow("invalid DialCache payload encoding");
    await expect(client.dialcacheWrite(valueKey, 1_000, 2, "value")).rejects.toThrow("invalid DialCache payload encoding");
    await expect(client.dialcacheWriteTracked(valueKey, watermarkKey, 1_000, 0, "value", 0)).rejects.toThrow(
      "invalid DialCache watermark TTL",
    );
    await expect(client.dialcacheWriteTracked(valueKey, watermarkKey, 1_000, 0, "value", Number.NaN)).rejects.toThrow(
      "invalid DialCache watermark TTL",
    );
    await expect(client.dialcacheInvalidate(watermarkKey, -1, 1_000)).rejects.toThrow("invalid DialCache future buffer");
    await expect(client.dialcacheInvalidate(watermarkKey, notANumber, 1_000)).rejects.toThrow("invalid DialCache future buffer");
    await expect(client.dialcacheInvalidate(watermarkKey, Number.NaN, 1_000)).rejects.toThrow("invalid DialCache future buffer");
    await expect(client.dialcacheInvalidate(watermarkKey, Number.POSITIVE_INFINITY, 1_000)).rejects.toThrow(
      "invalid DialCache future buffer",
    );
    await expect(client.dialcacheInvalidate(watermarkKey, Number.NEGATIVE_INFINITY, 1_000)).rejects.toThrow(
      "invalid DialCache future buffer",
    );
    await expect(client.dialcacheInvalidate(watermarkKey, 0, 0)).rejects.toThrow("invalid DialCache watermark TTL");
    await expect(client.dialcacheInvalidate(watermarkKey, 0, notANumber)).rejects.toThrow("invalid DialCache watermark TTL");
    await expect(client.dialcacheInvalidate(watermarkKey, 0, Number.NaN)).rejects.toThrow("invalid DialCache watermark TTL");
    await expect(client.dialcacheInvalidate(watermarkKey, 0, Number.POSITIVE_INFINITY)).rejects.toThrow(
      "invalid DialCache watermark TTL",
    );

    expect(await client.exists([valueKey, watermarkKey])).toBe(0);
  });

  it("rounds fractional raw protocol durations upward", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const valueKey = "fractional-args:{item:fractional}:value";
    const watermarkKey = "fractional-args:{item:fractional}:watermark";

    expect(await client.dialcacheWrite(valueKey, 1_000.1, 0, "value")).toBe(1);
    expect(await client.pTTL(valueKey)).toBeGreaterThan(900);
    expect(await client.pTTL(valueKey)).toBeLessThanOrEqual(1_001);

    const trackedValueKey = "fractional-args:{item:tracked-floor}:value";
    const trackedWatermarkKey = "fractional-args:{item:tracked-floor}:watermark";
    expect(
      await client.dialcacheWriteTracked(trackedValueKey, trackedWatermarkKey, 1_000, 0, "value", 70_000.1),
    ).toBe(1);
    expect(await client.get(trackedWatermarkKey)).toBe("0");
    expect(await client.pTTL(trackedWatermarkKey)).toBeGreaterThan(69_000);
    expect(await client.pTTL(trackedWatermarkKey)).toBeLessThanOrEqual(70_001);

    const beforeMs = (await client.time()).getTime();
    expect(await client.dialcacheInvalidate(watermarkKey, 100.1, 70_000.1)).toBe(1);
    const watermark = Number(await client.get(watermarkKey));
    expect(Number.isSafeInteger(watermark)).toBe(true);
    expect(watermark).toBeGreaterThanOrEqual(beforeMs + 101);
    expect(await client.pTTL(watermarkKey)).toBeGreaterThan(69_000);
    expect(await client.pTTL(watermarkKey)).toBeLessThanOrEqual(70_001);
  });

  it("invalidates tracked entries and recovers after SCRIPT FLUSH", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient: DialCacheRedisClient = createNodeRedisDialCacheClient(client);
    const dialcache = new DialCache({ namespace: "tracked", redis: { client: scriptClient } });
    let version = 1;
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, version, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RealTracked",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    version = 2;
    const cached = await dialcache.enable(async () => await getUser("123"));
    await dialcache.invalidateRemote("user_id", "123");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const refreshed = await dialcache.enable(async () => await getUser("123"));
    await client.scriptFlush();
    const afterScriptFlush = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ id: "123", version: 1, calls: 1 });
    expect(cached).toEqual(first);
    expect(refreshed).toEqual({ id: "123", version: 2, calls: 2 });
    expect(afterScriptFlush).toEqual(refreshed);
  });

  it("fails open without caching malformed watermark state", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const logger = { debug: () => undefined, warn: () => undefined, error: () => undefined };
    const dialcache = new DialCache({ namespace: "malformed", redis: { client: scriptClient }, logger });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "user_id",
      useCase: "MalformedWatermark",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });
    await client.set("{malformed:user_id:bad}#watermark", "0x10");

    const first = await dialcache.enable(async () => await getUser("bad"));
    const second = await dialcache.enable(async () => await getUser("bad"));

    expect(first).toEqual({ id: "bad", calls: 1 });
    expect(second).toEqual({ id: "bad", calls: 2 });
  });

  it("rejects malformed tracked watermark writes without overwriting the cached value", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const valueKey = "malformed-write:{item:malformed}:value";
    const watermarkKey = "malformed-write:{item:malformed}:watermark";
    expect(await client.dialcacheWrite(valueKey, 60_000, 0, "original")).toBe(1);

    for (const malformed of ["not-a-watermark", "9".repeat(400)]) {
      await client.set(watermarkKey, malformed, { PX: 60_000 });
      await expect(client.dialcacheWriteTracked(valueKey, watermarkKey, 60_000, 0, "replacement", 60_000)).rejects.toThrow(
        "invalid DialCache watermark",
      );
      expect(await scriptClient.read({ valueKey })).toBe("original");
    }
  });

  it("labels malformed payload encoding through the production adapter", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const adapter = createNodeRedisDialCacheClient(client);
    const write = vi.fn(adapter.write);
    const redisClient: DialCacheRedisClient = { ...adapter, write };
    const metrics: DialCacheMetricsAdapter = {
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
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const namespace = "bad-encoding";
    const valueKey = `{${namespace}:user_id:bad}#RealMalformedEncoding:dialcache-frame-v1`;
    const watermarkKey = `{${namespace}:user_id:bad}#watermark`;
    await client.set(valueKey, encodeFrame("malformed", 2), { PX: 60_000 });
    await client.set(watermarkKey, "0", { PX: 60_000 });

    const dialcache = new DialCache({ namespace, redis: { client: redisClient }, logger, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RealMalformedEncoding",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const value = await dialcache.enable(async () => await getUser("bad"));

    expect(value).toEqual({ id: "bad", calls: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: namespace,
      useCase: "RealMalformedEncoding",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "cache_read",
      inFallback: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Error getting value from Redis cache",
      expect.objectContaining({ name: "DialCacheRedisPayloadEncodingError" }),
    );
  });

  it("keeps future fractional watermarks alive without shortening longer TTLs", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const redisNowMs = (await client.time()).getTime();
    const legacyWatermark = redisNowMs + 30_000.5;
    const shortTtlKey = "legacy:{urn:user_id:short}#watermark";
    await client.set(shortTtlKey, String(legacyWatermark), { PX: 1_000 });

    await scriptClient.invalidate({
      watermarkKey: shortTtlKey,
      futureBufferMs: 1_000,
      watermarkTtlFloorMs: 60_000,
    });

    expect(Number(await client.get(shortTtlKey))).toBeGreaterThanOrEqual(Math.ceil(legacyWatermark));
    expect(await client.pTTL(shortTtlKey)).toBeGreaterThan(89_000);

    const longTtlKey = "legacy:{urn:user_id:long}#watermark";
    await client.set(longTtlKey, String(legacyWatermark), { PX: 120_000 });
    const ttlBefore = await client.pTTL(longTtlKey);

    await scriptClient.invalidate({
      watermarkKey: longTtlKey,
      futureBufferMs: 1_000,
      watermarkTtlFloorMs: 60_000,
    });

    expect(Number(await client.get(longTtlKey))).toBeGreaterThanOrEqual(Math.ceil(legacyWatermark));
    const ttlAfter = await client.pTTL(longTtlKey);
    expect(ttlAfter).toBeGreaterThan(ttlBefore - 1_000);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
  });

  it("creates missing and repairs malformed invalidation watermarks", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const missingKey = "invalidate-paths:{item:missing}:watermark";
    const beforeMs = (await client.time()).getTime();

    await scriptClient.invalidate({ watermarkKey: missingKey, futureBufferMs: 100, watermarkTtlFloorMs: 1_000 });

    const created = Number(await client.get(missingKey));
    expect(Number.isSafeInteger(created)).toBe(true);
    expect(created).toBeGreaterThanOrEqual(beforeMs + 100);
    expect(await client.pTTL(missingKey)).toBeGreaterThan(60_000);

    for (const [suffix, malformed] of [
      ["syntax", "not-a-watermark"],
      ["overflow", "9".repeat(400)],
    ] as const) {
      const watermarkKey = `invalidate-paths:{item:${suffix}}:watermark`;
      await client.set(watermarkKey, malformed, { PX: 1_000 });
      await scriptClient.invalidate({ watermarkKey, futureBufferMs: 0, watermarkTtlFloorMs: 2_000 });
      expect(Number.isSafeInteger(Number(await client.get(watermarkKey)))).toBe(true);
      expect(await client.pTTL(watermarkKey)).toBeGreaterThan(59_000);
    }
  });

  it("keeps persistent invalidation watermarks persistent", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const watermarkKey = "invalidate-persistent:{item:persistent}:watermark";
    await client.set(watermarkKey, "1");

    await scriptClient.invalidate({ watermarkKey, futureBufferMs: 0, watermarkTtlFloorMs: 60_000 });

    expect(Number(await client.get(watermarkKey))).toBeGreaterThan(1);
    expect(await client.pTTL(watermarkKey)).toBe(-1);
  });

  it("preserves a fractional legacy watermark while extending its TTL", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const valueKey = "legacy-write:{urn:user_id:123}:value";
    const watermarkKey = "legacy-write:{urn:user_id:123}:watermark";
    await client.set(watermarkKey, "1.75", { PX: 1_000 });

    const wrote = await scriptClient.write({
      valueKey,
      watermarkKey,
      cacheTtlMs: 2_000,
      value: "cached",
      watermarkTtlFloorMs: 1_000,
    });

    expect(wrote).toBe(true);
    expect(await client.get(watermarkKey)).toBe("1.75");
    expect(await client.pTTL(watermarkKey)).toBeGreaterThanOrEqual(61_000);
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("cached");
  });

  it("does not rewrite sufficient or persistent watermarks on tracked writes", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const sufficientValueKey = "write-sufficient:{item:sufficient}:value";
    const sufficientWatermarkKey = "write-sufficient:{item:sufficient}:watermark";
    await client.set(sufficientWatermarkKey, "1.75", { PX: 120_000 });
    const sufficientTtlBefore = await client.pTTL(sufficientWatermarkKey);

    expect(
      await scriptClient.write({
        valueKey: sufficientValueKey,
        watermarkKey: sufficientWatermarkKey,
        cacheTtlMs: 2_000,
        value: "cached",
        watermarkTtlFloorMs: 1_000,
      }),
    ).toBe(true);

    expect(await client.get(sufficientWatermarkKey)).toBe("1.75");
    expect(await client.pTTL(sufficientWatermarkKey)).toBeGreaterThan(sufficientTtlBefore - 1_000);
    expect(await client.pTTL(sufficientWatermarkKey)).toBeLessThanOrEqual(sufficientTtlBefore);

    const persistentValueKey = "write-persistent:{item:persistent}:value";
    const persistentWatermarkKey = "write-persistent:{item:persistent}:watermark";
    await client.set(persistentWatermarkKey, "2.25");

    expect(
      await scriptClient.write({
        valueKey: persistentValueKey,
        watermarkKey: persistentWatermarkKey,
        cacheTtlMs: 2_000,
        value: "cached",
        watermarkTtlFloorMs: 1_000,
      }),
    ).toBe(true);
    expect(await client.get(persistentWatermarkKey)).toBe("2.25");
    expect(await client.pTTL(persistentWatermarkKey)).toBe(-1);
  });

  it("atomically blocks writes during the buffer and extends watermark TTL", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(client);
    const valueKey = "protocol:{item:ttl}:value";
    const watermarkKey = "protocol:{item:ttl}:watermark";
    const writeRequest = {
      valueKey,
      watermarkKey,
      cacheTtlMs: 2_000,
      value: "cached",
      watermarkTtlFloorMs: 1_000,
    };

    expect(await scriptClient.write(writeRequest)).toBe(true);
    expect(await client.get(watermarkKey)).toBe("0");
    const ttlAfterWrite = await client.pTTL(watermarkKey);
    expect(ttlAfterWrite).toBeGreaterThanOrEqual(61_000);

    await scriptClient.invalidate({ watermarkKey, futureBufferMs: 100, watermarkTtlFloorMs: 1_000 });
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();
    expect(await scriptClient.write({ ...writeRequest, value: "blocked" })).toBe(false);
    expect(await scriptClient.read({ valueKey })).toBe("cached");
    const ttlBeforeRead = await client.pTTL(watermarkKey);
    await scriptClient.read({ valueKey, watermarkKey });
    expect(await client.pTTL(watermarkKey)).toBeLessThanOrEqual(ttlBeforeRead);

    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(await scriptClient.write({ ...writeRequest, value: "fresh" })).toBe(true);
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("fresh");
  });
});
