import {
  Decoder,
  GlideClusterClient,
  Script,
  type GlideClient,
  type GlideReturnType,
  type GlideString,
} from "@valkey/valkey-glide";

import { decodeRedisPayload, redisPayloadEncoding } from "./internal/redis-payload.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  READ_CACHE_SCRIPT,
  READ_TRACKED_CACHE_SCRIPT,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
import { DialCacheRedisPayloadError, type DialCacheRedisClient } from "./redis-client.js";

type SupportedValkeyGlideClient = GlideClient | GlideClusterClient;

interface DialCacheGlideScripts {
  readonly read: Script;
  readonly readTracked: Script;
  readonly write: Script;
  readonly writeTracked: Script;
  readonly invalidate: Script;
}

export interface ValkeyGlideDialCacheClient extends DialCacheRedisClient {
  /** Release the adapter-owned GLIDE Script handles. Does not close the wrapped GLIDE client. */
  dispose(): void;
}

export function createValkeyGlideDialCacheClient(
  client: SupportedValkeyGlideClient,
): ValkeyGlideDialCacheClient {
  const scripts: DialCacheGlideScripts = {
    read: new Script(READ_CACHE_SCRIPT),
    readTracked: new Script(READ_TRACKED_CACHE_SCRIPT),
    write: new Script(WRITE_CACHE_SCRIPT),
    writeTracked: new Script(WRITE_TRACKED_CACHE_SCRIPT),
    invalidate: new Script(INVALIDATE_CACHE_SCRIPT),
  };
  let disposed = false;
  let activeInvocations = 0;

  const invoke = async (
    script: Script,
    keys: GlideString[],
    args: GlideString[] = [],
  ): Promise<GlideReturnType> => {
    if (disposed) {
      throw new Error("Valkey GLIDE DialCache client is disposed");
    }
    activeInvocations += 1;
    try {
      return await client.invokeScript(script, { keys, args, decoder: Decoder.Bytes });
    } finally {
      activeInvocations -= 1;
    }
  };

  return {
    async read({ valueKey, watermarkKey }) {
      const raw = watermarkKey === undefined
        ? await invoke(scripts.read, [valueKey])
        : await invoke(scripts.readTracked, [valueKey, watermarkKey]);
      if (raw === null) {
        return null;
      }
      if (!Buffer.isBuffer(raw)) {
        throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload reply");
      }
      return decodeRedisPayload(raw);
    },
    async write(request) {
      const { valueKey, watermarkKey, cacheTtlMs, value } = request;
      const encoding = redisPayloadEncoding(value);
      const raw = watermarkKey === undefined
        ? await invoke(scripts.write, [valueKey], [String(cacheTtlMs), String(encoding), value])
        : await invoke(
            scripts.writeTracked,
            [valueKey, watermarkKey],
            [String(cacheTtlMs), String(encoding), value, String(request.watermarkTtlFloorMs)],
          );
      return integerReply(raw, "write") === 1;
    },
    async invalidate({ watermarkKey, futureBufferMs, watermarkTtlFloorMs }) {
      const raw = await invoke(
        scripts.invalidate,
        [watermarkKey],
        [String(futureBufferMs), String(watermarkTtlFloorMs)],
      );
      integerReply(raw, "invalidate");
    },
    async flushAll() {
      if (disposed) {
        throw new Error("Valkey GLIDE DialCache client is disposed");
      }
      if (client instanceof GlideClusterClient) {
        await client.flushall({ route: "allPrimaries" });
      } else {
        await client.flushall();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      if (activeInvocations > 0) {
        throw new Error("Cannot dispose Valkey GLIDE DialCache client while operations are in flight");
      }
      disposed = true;
      for (const script of Object.values(scripts)) {
        script.release();
      }
    },
  };
}

function integerReply(reply: GlideReturnType, operation: string): number {
  if (typeof reply !== "number") {
    throw new Error(`Invalid DialCache Redis ${operation} reply`);
  }
  return reply;
}
