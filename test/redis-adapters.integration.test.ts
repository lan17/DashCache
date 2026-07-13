import { GlideClient } from "@valkey/valkey-glide";
import { createClient } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  DialCacheRedisPayloadEncodingError,
  type DialCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";
import {
  createValkeyGlideDialCacheClient,
  type ValkeyGlideDialCacheClient,
} from "../src/valkey-glide.js";

const engines = [
  { name: "Redis 6.2", image: "redis:6.2-alpine" },
  { name: "Valkey 8", image: "valkey/valkey:8-alpine" },
] as const;

const adapterKinds = [
  { kind: "nodeRedis", name: "node-redis" },
  { kind: "valkeyGlide", name: "Valkey GLIDE" },
] as const;
type AdapterKind = (typeof adapterKinds)[number]["kind"];

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createNodeRedisClient = (url: string) => createClient({ url, scripts: dialcacheRedisScripts });

function encodeFrame(payload: string | Buffer, encoding: number, createdAtMs = Date.now(), version = 1): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  return Buffer.concat([Buffer.from([version]), timestamp, Buffer.from([encoding]), Buffer.from(payload)]);
}

describe.each(engines)("DialCache Redis adapter conformance on $name", ({ image }) => {
  let container: StartedTestContainer | undefined;
  let admin: ReturnType<typeof createNodeRedisClient> | undefined;
  let glide: GlideClient | undefined;
  let glideAdapter: ValkeyGlideDialCacheClient | undefined;
  let adapters: Record<AdapterKind, DialCacheRedisClient> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(image)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(6379);
    admin = createNodeRedisClient(`redis://${host}:${port}`);
    admin.on("error", () => undefined);
    await admin.connect();
    glide = await GlideClient.createClient({ addresses: [{ host, port }] });
    glideAdapter = createValkeyGlideDialCacheClient(glide);
    adapters = {
      nodeRedis: createNodeRedisDialCacheClient(admin),
      valkeyGlide: glideAdapter,
    };
  });

  beforeEach(async () => {
    await admin?.flushAll();
  });

  afterAll(async () => {
    glideAdapter?.dispose();
    glide?.close();
    await admin?.quit();
    await container?.stop();
  });

  describe.each(adapterKinds)("$name adapter", ({ kind }) => {
    function adapter(): DialCacheRedisClient {
      const active = adapters?.[kind];
      if (active === undefined) {
        throw new Error("Redis adapters did not start");
      }
      return active;
    }

    it("round-trips UTF-8 and arbitrary binary payloads", async () => {
      const client = adapter();
      const binary = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

      await expect(client.write({ valueKey: `${kind}:utf8`, cacheTtlMs: 60_000, value: "hello" })).resolves.toBe(true);
      await expect(client.read({ valueKey: `${kind}:utf8` })).resolves.toBe("hello");
      await expect(client.write({ valueKey: `${kind}:binary`, cacheTtlMs: 60_000, value: binary })).resolves.toBe(true);
      await expect(client.read({ valueKey: `${kind}:binary` })).resolves.toEqual(binary);
      await expect(
        client.write({ valueKey: `${kind}:empty-binary`, cacheTtlMs: 60_000, value: Buffer.alloc(0) }),
      ).resolves.toBe(true);
      await expect(client.read({ valueKey: `${kind}:empty-binary` })).resolves.toEqual(Buffer.alloc(0));
    });

    it("round-trips tracked values and honors invalidation watermarks", async () => {
      const client = adapter();
      const valueKey = `${kind}:{tracked}:value`;
      const watermarkKey = `${kind}:{tracked}:watermark`;
      const request = {
        valueKey,
        watermarkKey,
        cacheTtlMs: 60_000,
        value: Buffer.from([0, 0xff, 0x80]),
        watermarkTtlFloorMs: 60_000,
      } as const;

      await expect(client.write(request)).resolves.toBe(true);
      await expect(client.read({ valueKey, watermarkKey })).resolves.toEqual(request.value);
      await client.invalidate({ watermarkKey, futureBufferMs: 1_000, watermarkTtlFloorMs: 60_000 });
      await expect(client.read({ valueKey, watermarkKey })).resolves.toBeNull();
      await expect(client.write(request)).resolves.toBe(false);
    });

    it("recovers its scripts after the server script cache is flushed", async () => {
      const client = adapter();
      const valueKey = `${kind}:script-recovery`;
      if (admin === undefined) {
        throw new Error("Redis admin client did not start");
      }

      await admin.scriptFlush();
      await expect(client.write({ valueKey, cacheTtlMs: 60_000, value: "cached" })).resolves.toBe(true);
      await admin.scriptFlush();
      await expect(client.read({ valueKey })).resolves.toBe("cached");
    });

    it("treats invalid frames as misses and preserves encoding errors", async () => {
      const client = adapter();
      if (admin === undefined) {
        throw new Error("Redis admin client did not start");
      }

      await admin.set(`${kind}:empty-frame`, Buffer.alloc(9));
      await expect(client.read({ valueKey: `${kind}:empty-frame` })).resolves.toBeNull();

      await admin.set(`${kind}:bad-encoding`, encodeFrame("bad", 2), { PX: 60_000 });
      await expect(client.read({ valueKey: `${kind}:bad-encoding` })).rejects.toBeInstanceOf(
        DialCacheRedisPayloadEncodingError,
      );
    });

    it("backs a complete DialCache serializer round trip", async () => {
      const dialcache = new DialCache({ redis: { client: adapter(), keyPrefix: `${kind}:cache:` } });
      let calls = 0;
      const serializer: Serializer<string> = {
        dump: async (value) => Buffer.from(value, "utf8"),
        load: async (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value),
      };
      const load = dialcache.cached(async (id: string) => `${id}:${++calls}`, {
        keyType: "item_id",
        useCase: `Adapter${kind}`,
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
        serializer,
      });

      const first = await dialcache.enable(async () => await load("one"));
      const second = await dialcache.enable(async () => await load("one"));
      expect(first).toBe("one:1");
      expect(second).toBe(first);
      expect(calls).toBe(1);
    });

    it("flushes all cached values", async () => {
      const client = adapter();
      if (admin === undefined) {
        throw new Error("Redis admin client did not start");
      }
      await client.write({ valueKey: `${kind}:flush`, cacheTtlMs: 60_000, value: "cached" });
      await client.flushAll();
      await expect(admin.exists(`${kind}:flush`)).resolves.toBe(0);
    });
  });

  it("uses one wire format across node-redis and Valkey GLIDE", async () => {
    if (adapters === undefined) {
      throw new Error("Redis adapters did not start");
    }
    const binary = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);

    await adapters.nodeRedis.write({ valueKey: "interop:node-to-glide", cacheTtlMs: 60_000, value: binary });
    await expect(adapters.valkeyGlide.read({ valueKey: "interop:node-to-glide" })).resolves.toEqual(binary);

    await adapters.valkeyGlide.write({ valueKey: "interop:glide-to-node", cacheTtlMs: 60_000, value: "hello" });
    await expect(adapters.nodeRedis.read({ valueKey: "interop:glide-to-node" })).resolves.toBe("hello");

    const valueKey = "interop:{tracked}:value";
    const watermarkKey = "interop:{tracked}:watermark";
    await adapters.nodeRedis.write({
      valueKey,
      watermarkKey,
      cacheTtlMs: 60_000,
      value: binary,
      watermarkTtlFloorMs: 60_000,
    });
    await expect(adapters.valkeyGlide.read({ valueKey, watermarkKey })).resolves.toEqual(binary);
  });
});
