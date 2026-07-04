import { CacheLayer, type CacheConfigProvider, type CacheRampSampler, type GCacheKeyConfig } from "../config.js";
import type { GCacheKey } from "../key.js";
import type { DisabledReason } from "../metrics.js";

export interface ResolvedLayerConfig {
  readonly ttlSec: number;
  readonly ramp: number;
}

export type LayerConfigResolution =
  | { readonly status: "enabled"; readonly config: ResolvedLayerConfig }
  | { readonly status: "disabled"; readonly reason: DisabledReason };

interface ResolveLayerConfigOptions {
  readonly config: GCacheKeyConfig | null;
  readonly key: GCacheKey;
  readonly layer: CacheLayer;
  readonly rampSampler: CacheRampSampler;
}

export async function fetchKeyConfig(
  configProvider: CacheConfigProvider,
  key: GCacheKey,
): Promise<GCacheKeyConfig | null> {
  return (await configProvider(key)) ?? key.defaultConfig;
}

export async function resolveLayerConfig(options: ResolveLayerConfigOptions): Promise<ResolvedLayerConfig | null> {
  const resolution = await resolveLayerConfigResult(options);
  return resolution.status === "enabled" ? resolution.config : null;
}

export async function resolveLayerConfigResult(options: ResolveLayerConfigOptions): Promise<LayerConfigResolution> {
  const config = options.config;
  if (config === null) {
    return { status: "disabled", reason: "missing_config" };
  }

  const ttlSec = config.ttlSec[options.layer];
  if (ttlSec === undefined) {
    return { status: "disabled", reason: "missing_config" };
  }
  if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) {
    return { status: "disabled", reason: "invalid_ttl" };
  }

  const configuredRamp = config.ramp[options.layer];
  if (configuredRamp === undefined) {
    return { status: "disabled", reason: "missing_config" };
  }
  if (!Number.isFinite(configuredRamp)) {
    return { status: "disabled", reason: "ramped_down" };
  }

  const ramp = clampPercentage(configuredRamp);
  if (ramp <= 0) {
    return { status: "disabled", reason: "ramped_down" };
  }
  if (ramp >= 100) {
    return { status: "enabled", config: { ttlSec, ramp } };
  }

  const sample = await options.rampSampler({ key: options.key, layer: options.layer, ramp });
  if (!Number.isFinite(sample)) {
    return { status: "disabled", reason: "ramped_down" };
  }

  return clampPercentage(sample) < ramp
    ? { status: "enabled", config: { ttlSec, ramp } }
    : { status: "disabled", reason: "ramped_down" };
}

function clampPercentage(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return value;
}
