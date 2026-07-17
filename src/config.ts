import type { DialCacheKey } from "./key.js";
import type { DialCacheMetricsAdapter } from "./metrics.js";
import type { RedisConfig } from "./internal/redis-cache.js";

export enum CacheLayer {
  LOCAL = "local",
  REMOTE = "remote",
}

export type Awaitable<T> = T | Promise<T>;
export type LayerConfig = Partial<Record<CacheLayer, number>>;

export interface CacheRampSample {
  readonly key: DialCacheKey;
  readonly layer: CacheLayer;
  readonly ramp: number;
}

export type CacheRampSampler = (sample: CacheRampSample) => Awaitable<number>;

export const deterministicRampSampler: CacheRampSampler = ({ key, layer }) => stablePercent(`${key.urn}:${layer}`);
export const randomRampSampler: CacheRampSampler = () => Math.random() * 100;

// Tracked writes extend this floor when their value TTL is longer.
export const DEFAULT_WATERMARK_TTL_SEC = 3600 * 4;

export class DialCacheKeyConfig {
  readonly ttlSec: LayerConfig;
  readonly ramp: LayerConfig;
  /**
   * Memoize successful values for the lifetime of the outermost enabled scope.
   * Request-local caching is disabled by default and has no TTL or ramp.
   */
  readonly requestLocal?: boolean;

  constructor(config: { ttlSec?: LayerConfig; ramp?: LayerConfig; requestLocal?: boolean }) {
    this.ttlSec = { ...config.ttlSec };
    this.ramp = { ...config.ramp };
    this.requestLocal = config.requestLocal ?? false;
  }

  static enabled(ttlSec: number): DialCacheKeyConfig {
    return new DialCacheKeyConfig({
      ttlSec: {
        [CacheLayer.LOCAL]: ttlSec,
        [CacheLayer.REMOTE]: ttlSec,
      },
      ramp: {
        [CacheLayer.LOCAL]: 100,
        [CacheLayer.REMOTE]: 100,
      },
    });
  }
}

export type CacheConfigProvider = (key: DialCacheKey) => Awaitable<DialCacheKeyConfig | null>;

export type Logger = Pick<Console, "debug" | "error" | "warn">;

export interface DialCacheConfig {
  readonly cacheConfigProvider?: CacheConfigProvider;
  readonly urnPrefix?: string;
  readonly logger?: Logger;
  /**
   * Maximum local entries across every use case in this DialCache instance.
   * Must be a nonnegative safe integer.
   * Zero disables local storage. Defaults to 10,000.
   */
  readonly localMaxSize?: number;
  readonly redis?: RedisConfig;
  readonly rampSampler?: CacheRampSampler;
  readonly metrics?: DialCacheMetricsAdapter;
}

function stablePercent(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x1_0000_0000) * 100;
}
