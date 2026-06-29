import type { Registry } from "prom-client";

import type { GCacheKey } from "./key.js";
import type { GCacheMetricsAdapter } from "./metrics.js";
import type { RedisConfig } from "./internal/redis-cache.js";

export enum CacheLayer {
  NOOP = "noop",
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

// Watermark TTL must be longer than the longest Redis TTL used by any
// invalidation-tracked cached function. Otherwise the watermark can expire
// before older cached values do, allowing stale values to become readable again.
export const DEFAULT_WATERMARK_TTL_SEC = 3600 * 4;

export class GCacheKeyConfig {
  readonly ttlSec: LayerConfig;
  readonly ramp: LayerConfig;
  // Single-flight toggle for the whole read-through chain. Chain-level, not
  // per-layer. When set here (via the runtime provider) it overrides the
  // per-use-case `coalesce` option on the cached function.
  readonly coalesce?: boolean | undefined;

  constructor(config: { ttlSec: LayerConfig; ramp: LayerConfig; coalesce?: boolean }) {
    this.ttlSec = { ...config.ttlSec };
    this.ramp = { ...config.ramp };
    this.coalesce = config.coalesce;
  }

  static enabled(ttlSec: number): GCacheKeyConfig {
    return new GCacheKeyConfig({
      ttlSec: {
        [CacheLayer.LOCAL]: ttlSec,
        [CacheLayer.REMOTE]: ttlSec,
        [CacheLayer.NOOP]: ttlSec,
      },
      ramp: {
        [CacheLayer.LOCAL]: 100,
        [CacheLayer.REMOTE]: 100,
        [CacheLayer.NOOP]: 100,
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
  // Fleet-wide default for single-flight coalescing. Defaults to true; a
  // per-use-case option or the runtime provider can override it.
  readonly coalesceByDefault?: boolean;
}

function stablePercent(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x1_0000_0000) * 100;
}
