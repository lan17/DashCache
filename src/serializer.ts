import type { Awaitable } from "./config.js";

export interface Serializer<T = unknown> {
  dump(value: T): Awaitable<string | Buffer>;
  load(value: string | Buffer): Awaitable<T>;
}

const JSON_UNDEFINED_SENTINEL = "__dialcache_json_undefined_v1__";

/**
 * The native JSON serializer used by default for Redis values. The generic type
 * is a caller assertion; serialization does not perform semantic validation.
 */
export class JsonSerializer<T = unknown> implements Serializer<T> {
  async dump(value: T): Promise<string> {
    if (value === undefined) {
      return JSON_UNDEFINED_SENTINEL;
    }

    const payload = JSON.stringify(value);
    if (payload === undefined) {
      throw new Error("DialCache JSON serializer cannot serialize this value");
    }
    return payload;
  }

  async load(value: string | Buffer): Promise<T> {
    const payload = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (payload === JSON_UNDEFINED_SENTINEL) {
      return undefined as T;
    }
    return JSON.parse(payload) as T;
  }
}
