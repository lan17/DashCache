import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type RedisCachePayload,
} from "../redis-client.js";
import { REDIS_ENCODING_BINARY, REDIS_ENCODING_UTF8 } from "./redis-scripts.js";

export function redisPayloadEncoding(value: RedisCachePayload): number {
  return Buffer.isBuffer(value) ? REDIS_ENCODING_BINARY : REDIS_ENCODING_UTF8;
}

export function decodeRedisPayload(raw: Buffer): RedisCachePayload {
  if (raw.length === 0) {
    throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload");
  }

  const encoding = raw[0];
  const payload = raw.subarray(1);
  if (encoding === REDIS_ENCODING_UTF8) {
    return payload.toString("utf8");
  }
  if (encoding === REDIS_ENCODING_BINARY) {
    return payload;
  }
  throw new DialCacheRedisPayloadEncodingError("Invalid DialCache Redis payload encoding");
}
