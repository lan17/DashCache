import type { Registry } from "prom-client";

import type { GCacheKey } from "./key.js";
import type { GCacheMetricsAdapter } from "./metrics.js";
import type { RedisConfig } from "./internal/redis-cache.js";

export enum CacheLayer {
  LOCAL = "local",
  REMOTE = "remote",
}

export type Awaitable<T> = T | Promise<T>;
export type LayerConfig = Partial<Record<CacheLayer, number>>;

export interface CacheRampSample {
  readonly key: GCacheKey;
  readonly layer: CacheLayer;
  readonly ramp: number;
}

export type CacheRampSampler = (sample: CacheRampSample) => Awaitable<number>;

export const deterministicRampSampler: CacheRampSampler = ({ key, layer }) => stablePercent(`${key.urn}:${layer}`);
export const randomRampSampler: CacheRampSampler = () => Math.random() * 100;

// Tracked writes extend this floor when their value TTL is longer.
export const DEFAULT_WATERMARK_TTL_SEC = 3600 * 4;

export class GCacheKeyConfig {
  readonly ttlSec: LayerConfig;
  readonly ramp: LayerConfig;

  constructor(config: { ttlSec: LayerConfig; ramp: LayerConfig }) {
    this.ttlSec = { ...config.ttlSec };
    this.ramp = { ...config.ramp };
  }

  static enabled(ttlSec: number): GCacheKeyConfig {
    return new GCacheKeyConfig({
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

export type CacheConfigProvider = (key: GCacheKey) => Awaitable<GCacheKeyConfig | null>;

export type Logger = Pick<Console, "debug" | "error" | "warn">;

export interface GCacheConfig {
  readonly cacheConfigProvider?: CacheConfigProvider;
  readonly urnPrefix?: string;
  readonly logger?: Logger;
  readonly localMaxSize?: number;
  readonly redis?: RedisConfig;
  readonly rampSampler?: CacheRampSampler;
  readonly metrics?: GCacheMetricsAdapter | false;
  readonly metricsPrefix?: string;
  readonly metricsRegistry?: Registry;
}

function stablePercent(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x1_0000_0000) * 100;
}
