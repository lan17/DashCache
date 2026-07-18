import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
} from "../src/index.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";

const INVALID_WRITE_REPLIES: readonly unknown[] = [
  -1,
  2,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "1",
  1n,
  true,
  null,
  undefined,
];
const INVALID_INVALIDATION_REPLIES: readonly unknown[] = [0, ...INVALID_WRITE_REPLIES];

interface FakeReplies {
  readonly read?: Buffer | null;
  readonly readTracked?: Buffer | null;
  readonly write?: unknown;
  readonly writeTracked?: unknown;
  readonly invalidate?: unknown;
}

function fakeClient(replies: FakeReplies = {}) {
  return {
    dialcacheRead: vi.fn(async () => Object.hasOwn(replies, "read") ? replies.read : null),
    dialcacheReadTracked: vi.fn(async () => Object.hasOwn(replies, "readTracked") ? replies.readTracked : null),
    dialcacheWrite: vi.fn(async () => Object.hasOwn(replies, "write") ? replies.write : 1),
    dialcacheWriteTracked: vi.fn(async () => Object.hasOwn(replies, "writeTracked") ? replies.writeTracked : 1),
    dialcacheInvalidate: vi.fn(async () => Object.hasOwn(replies, "invalidate") ? replies.invalidate : 1),
  };
}

async function expectProtocolError(operation: Promise<unknown>, message: string): Promise<void> {
  let rejection: unknown;
  try {
    await operation;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(DialCacheRedisProtocolError);
  expect(rejection).toMatchObject({ name: "DialCacheRedisProtocolError", message });
}

describe("node-redis adapter", () => {
  it("provides the expected arguments for every bundled script", () => {
    const binary = Buffer.from([0, 0xff]);

    expect(dialcacheRedisScripts.dialcacheRead.transformArguments("plain:value")).toEqual(["plain:value"]);
    expect(
      dialcacheRedisScripts.dialcacheReadTracked.transformArguments(
        "tracked:{id}:value",
        "tracked:{id}:watermark",
      ),
    ).toEqual(["tracked:{id}:value", "tracked:{id}:watermark"]);
    expect(dialcacheRedisScripts.dialcacheWrite.transformArguments("plain:value", 1_000, 0, "plain")).toEqual([
      "plain:value",
      "1000",
      "0",
      "plain",
    ]);
    expect(
      dialcacheRedisScripts.dialcacheWriteTracked.transformArguments(
        "tracked:{id}:value",
        "tracked:{id}:watermark",
        1_000,
        1,
        binary,
        2_000,
      ),
    ).toEqual(["tracked:{id}:value", "tracked:{id}:watermark", "1000", "1", binary, "2000"]);
    expect(
      dialcacheRedisScripts.dialcacheInvalidate.transformArguments("tracked:{id}:watermark", 50, 2_000),
    ).toEqual(["tracked:{id}:watermark", "50", "2000"]);
  });

  it("accepts the exact write and invalidation reply domains", async () => {
    const client = fakeClient({
      read: Buffer.from([0, ...Buffer.from("plain")]),
      readTracked: Buffer.from([1, 0, 0xff]),
      write: 1,
      writeTracked: 0,
      invalidate: 1,
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.read({ valueKey: "plain:value" })).resolves.toBe("plain");
    await expect(
      adapter.read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
    ).resolves.toEqual(Buffer.from([0, 0xff]));
    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).resolves.toBe(true);
    await expect(
      adapter.write({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        cacheTtlMs: 1_000,
        value: "tracked",
        watermarkTtlFloorMs: 2_000,
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50, watermarkTtlFloorMs: 2_000 }),
    ).resolves.toBeUndefined();
  });

  it("rejects every out-of-domain reply returned by a node-redis client", async () => {
    const writeMessage = "Invalid DialCache Redis write reply; expected integer 0 or 1";
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of INVALID_WRITE_REPLIES) {
      const untracked = createNodeRedisDialCacheClient(fakeClient({ write: reply }) as never);
      await expectProtocolError(
        Promise.resolve(untracked.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
        writeMessage,
      );

      const tracked = createNodeRedisDialCacheClient(fakeClient({ writeTracked: reply }) as never);
      await expectProtocolError(
        Promise.resolve(tracked.write({
          valueKey: "tracked:{id}:value",
          watermarkKey: "tracked:{id}:watermark",
          cacheTtlMs: 1_000,
          value: "tracked",
          watermarkTtlFloorMs: 2_000,
        })),
        writeMessage,
      );
    }

    for (const reply of INVALID_INVALIDATION_REPLIES) {
      const adapter = createNodeRedisDialCacheClient(fakeClient({ invalidate: reply }) as never);
      await expectProtocolError(
        Promise.resolve(adapter.invalidate({
          watermarkKey: "tracked:{id}:watermark",
          futureBufferMs: 50,
          watermarkTtlFloorMs: 2_000,
        })),
        invalidationMessage,
      );
    }
  });

  it("validates replies at the public node-redis script transform boundary", () => {
    expect(dialcacheRedisScripts.dialcacheWrite.transformReply(0)).toBe(0);
    expect(dialcacheRedisScripts.dialcacheWriteTracked.transformReply(1)).toBe(1);
    expect(dialcacheRedisScripts.dialcacheInvalidate.transformReply(1)).toBe(1);

    for (const reply of INVALID_WRITE_REPLIES) {
      expect(() => dialcacheRedisScripts.dialcacheWrite.transformReply(reply as number)).toThrow(
        DialCacheRedisProtocolError,
      );
      expect(() => dialcacheRedisScripts.dialcacheWriteTracked.transformReply(reply as number)).toThrow(
        DialCacheRedisProtocolError,
      );
    }
    for (const reply of INVALID_INVALIDATION_REPLIES) {
      expect(() => dialcacheRedisScripts.dialcacheInvalidate.transformReply(reply as number)).toThrow(
        DialCacheRedisProtocolError,
      );
    }
  });

  it("surfaces protocol failures through the normal DialCache observability path", async () => {
    const redisClient = createNodeRedisDialCacheClient(fakeClient({ write: 2, invalidate: 0 }) as never);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      request: vi.fn(),
      miss: vi.fn(),
      disabled: vi.fn(),
      error: vi.fn(),
      invalidation: vi.fn(),
      observeGet: vi.fn(),
      observeFallback: vi.fn(),
      observeSerialization: vi.fn(),
      observeSize: vi.fn(),
    };
    const dialcache = new DialCache({ redis: { client: redisClient }, logger, metrics });
    const load = dialcache.cached(async (id: string) => ({ id }), {
      keyType: "user_id",
      useCase: "ProtocolFailure",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    await expect(dialcache.enable(async () => await load("123"))).resolves.toEqual({ id: "123" });
    await expectProtocolError(
      dialcache.invalidateRemote("user_id", "123"),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Error putting value in Redis cache",
      expect.any(DialCacheRedisProtocolError),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Error writing DialCache invalidation watermark",
      expect.any(DialCacheRedisProtocolError),
    );
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "ProtocolFailure",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "cache_write",
      inFallback: false,
    });
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "watermark",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "invalidation",
      inFallback: false,
    });
  });
});
