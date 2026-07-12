import type {
  DialCacheRedisClient,
  RedisCachePayload,
  RedisInvalidationRequest,
  RedisReadRequest,
  RedisWriteRequest,
} from "../src/index.js";
import { DialCacheRedisPayloadEncodingError } from "../src/redis-client.js";

const FRAME_VERSION = 1;
const ENCODING_OFFSET = 9;
const PAYLOAD_OFFSET = 10;
const WATERMARK_TTL_MARGIN_MS = 60_000;

interface StoredValue {
  value: Buffer;
  expiresAtMs: number;
}

export class FakeRedis implements DialCacheRedisClient {
  readonly values = new Map<string, StoredValue>();
  getCalls = 0;
  mGetCalls = 0;
  setCalls = 0;
  flushAllCalls = 0;
  failGet = false;
  failSet = false;
  failFlushAll = false;
  failWatermarkGet = false;
  getGate: Promise<void> | null = null;

  async read({ valueKey, watermarkKey }: RedisReadRequest): Promise<RedisCachePayload | null> {
    if (watermarkKey === undefined) {
      this.getCalls += 1;
    } else {
      this.mGetCalls += 1;
    }
    await this.waitForRead();
    this.throwIfReadFails(watermarkKey !== undefined);
    return this.readPayload(valueKey, watermarkKey ?? null);
  }

  async write({
    valueKey,
    watermarkKey,
    cacheTtlMs,
    value,
    watermarkTtlFloorMs,
  }: RedisWriteRequest): Promise<boolean> {
    this.setCalls += 1;
    this.throwIfWriteFails();
    if (watermarkKey !== undefined) {
      const watermark = this.readWatermark(watermarkKey) ?? 0;
      if (watermark >= Date.now()) {
        return false;
      }
      this.storeFrame(valueKey, cacheTtlMs, value);
      const currentTtlMs = this.remainingTtlMs(watermarkKey);
      const desiredTtlMs = Math.max(currentTtlMs, watermarkTtlFloorMs, cacheTtlMs + WATERMARK_TTL_MARGIN_MS);
      this.storeWatermark(watermarkKey, watermark, desiredTtlMs);
      return true;
    }

    this.storeFrame(valueKey, cacheTtlMs, value);
    return true;
  }

  async invalidate({ watermarkKey, futureBufferMs, watermarkTtlFloorMs }: RedisInvalidationRequest): Promise<void> {
    this.setCalls += 1;
    this.throwIfWriteFails();
    let current = 0;
    try {
      current = this.readWatermark(watermarkKey) ?? 0;
    } catch {
      current = 0;
    }
    const watermark = Math.max(current, Date.now() + futureBufferMs);
    const currentTtlMs = this.remainingTtlMs(watermarkKey);
    const desiredTtlMs = Math.max(
      currentTtlMs,
      watermarkTtlFloorMs,
      futureBufferMs + WATERMARK_TTL_MARGIN_MS,
      watermark - Date.now() + WATERMARK_TTL_MARGIN_MS,
    );
    this.storeWatermark(watermarkKey, watermark, desiredTtlMs);
  }

  async flushAll(): Promise<void> {
    this.flushAllCalls += 1;
    if (this.failFlushAll) {
      throw new Error("redis flushAll failed");
    }
    this.values.clear();
  }

  raw(key: string): Buffer {
    const value = this.readRaw(key);
    if (value === null) {
      throw new Error(`missing value for ${key}`);
    }
    return value;
  }

  setRaw(key: string, value: string | Buffer, ttlMs = 60_000): void {
    this.values.set(key, {
      value: Buffer.isBuffer(value) ? value : Buffer.from(value),
      expiresAtMs: Date.now() + ttlMs,
    });
  }

  ttlMs(key: string): number {
    return this.remainingTtlMs(key);
  }

  readWatermarkValue(key: string): number | null {
    return this.readWatermark(key);
  }

  private async waitForRead(): Promise<void> {
    if (this.getGate !== null) {
      await this.getGate;
    }
  }

  private throwIfReadFails(watermark: boolean): void {
    if (this.failGet || (watermark && this.failWatermarkGet)) {
      throw new Error(watermark ? "watermark read failed" : "redis get failed");
    }
  }

  private throwIfWriteFails(): void {
    if (this.failSet) {
      throw new Error("redis set failed");
    }
  }

  private readPayload(valueKey: string, watermarkKey: string | null): RedisCachePayload | null {
    const raw = this.readRaw(valueKey);
    if (raw === null || raw.length < PAYLOAD_OFFSET || raw[0] !== FRAME_VERSION) {
      return null;
    }

    if (watermarkKey !== null) {
      let watermark: number | null;
      try {
        watermark = this.readWatermark(watermarkKey);
      } catch {
        return null;
      }
      if (watermark === null || Number(readTimestamp(raw)) <= watermark) {
        return null;
      }
    }

    const encoding = raw[ENCODING_OFFSET];
    if (encoding === 0) {
      return raw.subarray(PAYLOAD_OFFSET).toString("utf8");
    }
    if (encoding === 1) {
      return raw.subarray(PAYLOAD_OFFSET);
    }
    throw new DialCacheRedisPayloadEncodingError("Invalid DialCache Redis payload encoding");
  }

  private storeFrame(key: string, ttlMs: number, payload: RedisCachePayload): void {
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(BigInt(Date.now()));
    this.values.set(key, {
      value: Buffer.concat([
        Buffer.from([FRAME_VERSION]),
        timestamp,
        Buffer.from([Buffer.isBuffer(payload) ? 1 : 0]),
        Buffer.from(payload),
      ]),
      expiresAtMs: Date.now() + ttlMs,
    });
  }

  private storeWatermark(key: string, watermark: number, ttlMs: number): void {
    this.values.set(key, { value: Buffer.from(String(Math.floor(watermark))), expiresAtMs: Date.now() + ttlMs });
  }

  private readWatermark(key: string): number | null {
    const raw = this.readRaw(key);
    if (raw === null) {
      return null;
    }
    const text = raw.toString("utf8");
    if (!/^\d+(?:\.\d+)?$/.test(text)) {
      throw new Error("Invalid DialCache watermark");
    }
    const legacy = Number(text);
    if (!Number.isFinite(legacy) || legacy < 0) {
      throw new Error("Invalid DialCache watermark");
    }
    return legacy;
  }

  private readRaw(key: string): Buffer | null {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private remainingTtlMs(key: string): number {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return -2;
    }
    return Math.max(entry.expiresAtMs - Date.now(), 0);
  }
}

export function encodeFrame(value: unknown, createdAtMs = Date.now(), encoding = 0): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  const payload = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return Buffer.concat([Buffer.from([FRAME_VERSION]), timestamp, Buffer.from([encoding]), payload]);
}

export function decodeFrame(
  raw: Buffer,
): { readonly createdAtMs: number; readonly encoding: number; readonly payload: string | Buffer } {
  if (raw.length < PAYLOAD_OFFSET || raw[0] !== FRAME_VERSION) {
    throw new Error("Invalid DialCache frame");
  }
  const encoding = raw[ENCODING_OFFSET] ?? -1;
  const payload = raw.subarray(PAYLOAD_OFFSET);
  return {
    createdAtMs: Number(readTimestamp(raw)),
    encoding,
    payload: encoding === 0 ? payload.toString("utf8") : payload,
  };
}

function readTimestamp(raw: Buffer): bigint {
  return raw.subarray(1, 9).readBigUInt64BE();
}
