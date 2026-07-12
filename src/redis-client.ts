import type { Awaitable } from "./config.js";

export class DialCacheRedisPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisPayloadError";
  }
}

export class DialCacheRedisPayloadEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisPayloadEncodingError";
  }
}

/** Serialized cache data, independent of any Redis client or wire framing. */
export type RedisCachePayload = string | Buffer;

interface RedisValueRequest {
  readonly valueKey: string;
}

interface TrackedRedisValueRequest extends RedisValueRequest {
  readonly watermarkKey: string;
}

interface UntrackedRedisValueRequest extends RedisValueRequest {
  readonly watermarkKey?: never;
}

export type RedisReadRequest = TrackedRedisValueRequest | UntrackedRedisValueRequest;

interface RedisWriteBase extends RedisValueRequest {
  readonly cacheTtlMs: number;
  readonly value: RedisCachePayload;
}

interface TrackedRedisWriteRequest extends RedisWriteBase, TrackedRedisValueRequest {
  readonly watermarkTtlFloorMs: number;
}

interface UntrackedRedisWriteRequest extends RedisWriteBase, UntrackedRedisValueRequest {
  readonly watermarkTtlFloorMs?: never;
}

export type RedisWriteRequest = TrackedRedisWriteRequest | UntrackedRedisWriteRequest;

export interface RedisInvalidationRequest {
  readonly watermarkKey: string;
  readonly futureBufferMs: number;
  readonly watermarkTtlFloorMs: number;
}

export interface DialCacheRedisClient {
  /** Atomically read and validate a value against its watermark when tracked. */
  read(request: RedisReadRequest): Awaitable<RedisCachePayload | null>;
  /** Atomically write using server time. False means invalidation blocked the write. */
  write(request: RedisWriteRequest): Awaitable<boolean>;
  /** Advance the watermark monotonically after the source mutation commits. */
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
  /** Remove cached values from every backing shard. */
  flushAll(): Awaitable<void>;
}

export type RedisClientFactory = () => Awaitable<DialCacheRedisClient>;
