import { createCluster, type RedisClusterOptions } from "redis";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CacheLayer, GCache, GCacheKeyConfig, type GCacheRedisClient } from "../src/index.js";
import { createNodeRedisGCacheClient, gcacheRedisScripts } from "../src/node-redis.js";

const remoteOnly = new GCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestCluster = (options: RedisClusterOptions) =>
  createCluster({
    ...options,
    scripts: gcacheRedisScripts,
  });

async function waitForCluster(container: StartedTestContainer): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await container.exec(["redis-cli", "cluster", "info"]);
    if (result.output.includes("cluster_state:ok")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Redis Cluster did not become ready");
}

describe("GCache Lua protocol on Redis Cluster", () => {
  let network: StartedNetwork | undefined;
  let containers: Array<StartedTestContainer> = [];
  let cluster: ReturnType<typeof createTestCluster> | undefined;

  beforeAll(async () => {
    const startedNetwork = await new Network().start();
    network = startedNetwork;
    for (const alias of ["redis-1", "redis-2", "redis-3"]) {
      containers.push(
        await new GenericContainer("redis:7-alpine")
          .withNetwork(startedNetwork)
          .withNetworkAliases(alias)
          .withExposedPorts(6379)
          .withCommand([
            "redis-server",
            "--port",
            "6379",
            "--cluster-enabled",
            "yes",
            "--cluster-config-file",
            "/tmp/nodes.conf",
            "--cluster-node-timeout",
            "5000",
            "--appendonly",
            "no",
            "--protected-mode",
            "no",
          ])
          .withWaitStrategy(Wait.forListeningPorts())
          .start(),
      );
    }

    const networkName = network.getName();
    const internalAddresses = containers.map((container) => `${container.getIpAddress(networkName)}:6379`);
    const firstContainer = containers[0];
    if (firstContainer === undefined) {
      throw new Error("Redis Cluster containers did not start");
    }
    const createResult = await firstContainer.exec([
      "redis-cli",
      "--cluster",
      "create",
      ...internalAddresses,
      "--cluster-replicas",
      "0",
      "--cluster-yes",
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Could not create Redis Cluster: ${createResult.output}`);
    }
    await Promise.all(containers.map(waitForCluster));

    const nodeAddressMap = Object.fromEntries(
      containers.map((container) => [
        `${container.getIpAddress(networkName)}:6379`,
        { host: container.getHost(), port: container.getMappedPort(6379) },
      ]),
    );
    cluster = createTestCluster({
      rootNodes: [{ url: `redis://${firstContainer.getHost()}:${firstContainer.getMappedPort(6379)}` }],
      nodeAddressMap,
    });
    cluster.on("error", () => undefined);
    await cluster.connect();
  });

  afterAll(async () => {
    await cluster?.quit();
    await Promise.all(containers.map(async (container) => await container.stop()));
    await network?.stop();
  });

  it("routes scripts across slots and reloads them per node", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const activeCluster = cluster;
    const scriptClient: GCacheRedisClient = createNodeRedisGCacheClient(activeCluster);
    const gcache = new GCache({ redis: { client: scriptClient, keyPrefix: "cluster:" } });
    const ids = Array.from({ length: 30 }, (_, index) => `item-${index}`);
    let calls = 0;
    const getValue = gcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "item_id",
      useCase: "ClusterSlots",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly,
    });

    const first = await gcache.enable(async () => await Promise.all(ids.map(getValue)));
    const sizesBeforeFlush = await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        return await client.dbSize();
      }),
    );
    await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        await client.scriptFlush();
      }),
    );
    const second = await gcache.enable(async () => await Promise.all(ids.map(getValue)));
    await gcache.flushAll();
    const sizesAfterFlush = await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        return await client.dbSize();
      }),
    );
    const afterFlush = await gcache.enable(async () => await Promise.all(ids.map(getValue)));

    expect(first.map(({ id }) => id)).toEqual(ids);
    expect(calls).toBe(60);
    expect(sizesBeforeFlush.every((size) => size > 0)).toBe(true);
    expect(second).toEqual(first);
    expect(sizesAfterFlush).toEqual([0, 0, 0]);
    expect(afterFlush.map(({ id }) => id)).toEqual(ids);
    expect(new Set(afterFlush.map(({ calls: call }) => call))).toEqual(new Set(ids.map((_, index) => index + 31)));
  });

  it("keeps tracked keys colocated and rejects mismatched hash tags", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    expect(gcacheRedisScripts.gcacheRead.IS_READ_ONLY).toBe(true);
    expect(gcacheRedisScripts.gcacheReadTracked.IS_READ_ONLY).toBe(false);
    expect(gcacheRedisScripts.gcacheRead.SHA1).not.toBe(gcacheRedisScripts.gcacheReadTracked.SHA1);
    expect(gcacheRedisScripts.gcacheWrite.SHA1).not.toBe(gcacheRedisScripts.gcacheWriteTracked.SHA1);
    const scriptClient: GCacheRedisClient = createNodeRedisGCacheClient(cluster);
    const gcache = new GCache({ redis: { client: scriptClient, keyPrefix: "cluster:" } });
    let version = 1;
    const getUser = gcache.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "ClusterTracked",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const before = await gcache.enable(async () => await getUser("123"));
    version = 2;
    await gcache.invalidateRemote("user_id", "123");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const after = await gcache.enable(async () => await getUser("123"));

    expect(before).toEqual({ id: "123", version: 1 });
    expect(after).toEqual({ id: "123", version: 2 });
    await expect(cluster.gcacheReadTracked("{slot-a}:value", "{slot-b}:watermark")).rejects.toThrow(/CROSSSLOT/);
  });
});
