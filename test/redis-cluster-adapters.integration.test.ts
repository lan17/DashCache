import { createServer } from "node:net";

import { GlideClusterClient } from "@valkey/valkey-glide";
import { commandOptions, createCluster } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig, type DialCacheRedisClient } from "../src/index.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";
import {
  createValkeyGlideDialCacheClient,
  type ValkeyGlideDialCacheClient,
} from "../src/valkey-glide.js";

const adapterKinds = [
  { kind: "nodeRedis", name: "node-redis" },
  { kind: "valkeyGlide", name: "Valkey GLIDE" },
] as const;
type AdapterKind = (typeof adapterKinds)[number]["kind"];

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createNodeRedisCluster = (port: number) =>
  createCluster({
    rootNodes: [{ url: `redis://127.0.0.1:${port}` }],
    scripts: dialcacheRedisScripts,
  });

async function waitForCluster(container: StartedTestContainer, port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await container.exec(["redis-cli", "-p", String(port), "cluster", "info"]);
    if (result.output.includes("cluster_state:ok")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Redis Cluster did not become ready");
}

async function chooseClusterPorts(): Promise<readonly [number, number, number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = 20_000 + Math.floor(Math.random() * 25_000);
    const ports = [base, base + 1, base + 2] as const;
    if ((await Promise.all(ports.map(portIsAvailable))).every(Boolean)) {
      return ports;
    }
  }
  throw new Error("Could not reserve ports for Redis Cluster integration tests");
}

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function redisClusterCommand(ports: readonly number[]): string[] {
  const commands = ports.map(
    (port) =>
      `redis-server --port ${port} --cluster-enabled yes ` +
      `--cluster-config-file /tmp/nodes-${port}.conf --cluster-node-timeout 5000 ` +
      `--appendonly no --protected-mode no --bind 0.0.0.0 ` +
      `--cluster-announce-ip 127.0.0.1 --cluster-announce-port ${port} ` +
      `--cluster-announce-bus-port ${port + 10_000} --daemonize yes`,
  );
  return ["sh", "-c", `${commands.join(" && ")} && tail -f /dev/null`];
}

describe("DialCache Redis adapter conformance on Redis Cluster", () => {
  let container: StartedTestContainer | undefined;
  let nodeCluster: ReturnType<typeof createNodeRedisCluster> | undefined;
  let glideCluster: GlideClusterClient | undefined;
  let glideAdapter: ValkeyGlideDialCacheClient | undefined;
  let adapters: Record<AdapterKind, DialCacheRedisClient> | undefined;

  beforeAll(async () => {
    const ports = await chooseClusterPorts();
    const exposedPorts = ports.map((port) => ({
      container: port,
      host: port,
    }));
    container = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(...exposedPorts)
      .withCommand(redisClusterCommand(ports))
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const createResult = await container.exec([
      "redis-cli",
      "--cluster",
      "create",
      ...ports.map((port) => `127.0.0.1:${port}`),
      "--cluster-replicas",
      "0",
      "--cluster-yes",
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Could not create Redis Cluster: ${createResult.output}`);
    }
    await waitForCluster(container, ports[0]);

    nodeCluster = createNodeRedisCluster(ports[0]);
    nodeCluster.on("error", () => undefined);
    await nodeCluster.connect();
    glideCluster = await GlideClusterClient.createClient({
      addresses: ports.map((port) => ({ host: "127.0.0.1", port })),
    });
    glideAdapter = createValkeyGlideDialCacheClient(glideCluster);
    adapters = {
      nodeRedis: createNodeRedisDialCacheClient(nodeCluster),
      valkeyGlide: glideAdapter,
    };
  });

  beforeEach(async () => {
    await adapters?.nodeRedis.flushAll();
  });

  afterAll(async () => {
    glideAdapter?.dispose();
    glideCluster?.close();
    await nodeCluster?.quit();
    await container?.stop();
  });

  describe.each(adapterKinds)("$name adapter", ({ kind }) => {
    function adapter(): DialCacheRedisClient {
      const active = adapters?.[kind];
      if (active === undefined) {
        throw new Error("Redis Cluster adapters did not start");
      }
      return active;
    }

    it("routes cached operations across cluster slots", async () => {
      const dialcache = new DialCache({ redis: { client: adapter(), keyPrefix: `${kind}:cluster:` } });
      const ids = Array.from({ length: 30 }, (_, index) => `item-${index}`);
      let calls = 0;
      const load = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
        keyType: "item_id",
        useCase: `Cluster${kind}`,
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
      });

      const first = await dialcache.enable(async () => await Promise.all(ids.map(load)));
      const second = await dialcache.enable(async () => await Promise.all(ids.map(load)));
      expect(second).toEqual(first);
      expect(calls).toBe(ids.length);
    });

    it("keeps tracked keys colocated and rejects mismatched hash slots", async () => {
      const client = adapter();
      const valueKey = `${kind}:{same}:value`;
      const watermarkKey = `${kind}:{same}:watermark`;
      await expect(
        client.write({
          valueKey,
          watermarkKey,
          cacheTtlMs: 60_000,
          value: "tracked",
          watermarkTtlFloorMs: 60_000,
        }),
      ).resolves.toBe(true);
      await expect(client.read({ valueKey, watermarkKey })).resolves.toBe("tracked");
      await expect(
        client.read({ valueKey: `${kind}:{slot-a}:value`, watermarkKey: `${kind}:{slot-b}:watermark` }),
      ).rejects.toThrow(/CROSSSLOT|same slot/i);
    });

    it("round-trips binary payloads through cluster script routing", async () => {
      const client = adapter();
      if (nodeCluster === undefined) {
        throw new Error("Redis Cluster did not start");
      }
      const payload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
      const valueKey = `${kind}:{binary}:value`;
      await expect(client.write({ valueKey, cacheTtlMs: 60_000, value: payload })).resolves.toBe(true);
      await expect(client.read({ valueKey })).resolves.toEqual(payload);
      const stored = await nodeCluster.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(1);
      expect(stored?.[9]).toBe(1);
      expect(stored?.subarray(10)).toEqual(payload);
    });

    it("reloads scripts on every shard after SCRIPT FLUSH", async () => {
      const client = adapter();
      if (nodeCluster === undefined) {
        throw new Error("Redis Cluster did not start");
      }
      const activeCluster = nodeCluster;
      await Promise.all(
        activeCluster.masters.map(async (master) => {
          const node = await activeCluster.nodeClient(master);
          await node.scriptFlush();
        }),
      );

      const keys = Array.from({ length: 30 }, (_, index) => `${kind}:recovery:{item-${index}}:value`);
      await Promise.all(keys.map(async (valueKey) => await client.write({ valueKey, cacheTtlMs: 60_000, value: valueKey })));
      await expect(Promise.all(keys.map(async (valueKey) => await client.read({ valueKey })))).resolves.toEqual(keys);
    });

    it("flushes every primary shard", async () => {
      const client = adapter();
      if (nodeCluster === undefined) {
        throw new Error("Redis Cluster did not start");
      }
      const activeCluster = nodeCluster;
      const keys = Array.from({ length: 30 }, (_, index) => `${kind}:flush:{item-${index}}:value`);
      await Promise.all(keys.map(async (valueKey) => await client.write({ valueKey, cacheTtlMs: 60_000, value: valueKey })));
      const sizesBefore = await Promise.all(
        activeCluster.masters.map(async (master) => {
          const node = await activeCluster.nodeClient(master);
          return await node.dbSize();
        }),
      );
      expect(sizesBefore.every((size) => size > 0)).toBe(true);
      await client.flushAll();
      const sizes = await Promise.all(
        activeCluster.masters.map(async (master) => {
          const node = await activeCluster.nodeClient(master);
          return await node.dbSize();
        }),
      );
      expect(sizes).toEqual([0, 0, 0]);
    });
  });

  it("uses one cluster wire format across node-redis and Valkey GLIDE", async () => {
    if (adapters === undefined) {
      throw new Error("Redis Cluster adapters did not start");
    }
    const nodeValueKey = "interop:{node-to-glide}:value";
    const glideValueKey = "interop:{glide-to-node}:value";
    const binary = Buffer.from([0, 0xff, 0x80]);

    await adapters.nodeRedis.write({ valueKey: nodeValueKey, cacheTtlMs: 60_000, value: binary });
    await expect(adapters.valkeyGlide.read({ valueKey: nodeValueKey })).resolves.toEqual(binary);
    await adapters.valkeyGlide.write({ valueKey: glideValueKey, cacheTtlMs: 60_000, value: "hello" });
    await expect(adapters.nodeRedis.read({ valueKey: glideValueKey })).resolves.toBe("hello");
  });
});
