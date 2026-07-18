import type { Awaitable } from "./config.js";

const redisProtocolErrorBrand = Symbol.for("dialcache.DialCacheRedisProtocolError");

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

export class DialCacheRedisProtocolError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DialCacheRedisProtocolError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return typeof value === "object"
      && value !== null
      && Object.getOwnPropertyDescriptor(value, redisProtocolErrorBrand)?.value === true;
  }

  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisProtocolError";
    // CJS adapter subpaths are separate bundles; a global symbol preserves root-export instanceof checks.
    Object.defineProperty(this, redisProtocolErrorBrand, { value: true });
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
}

export type RedisClientFactory = () => Awaitable<DialCacheRedisClient>;
