import type { CacheLayer } from "./config.js";
import type { DialCacheKey } from "./key.js";

export const NO_CACHE_LAYER = "noop";
export const REQUEST_LOCAL_CACHE_LAYER = "request_local";

type NoCacheLayer = typeof NO_CACHE_LAYER;
type RequestLocalCacheLayer = typeof REQUEST_LOCAL_CACHE_LAYER;
export type MetricLayer = CacheLayer | RequestLocalCacheLayer | NoCacheLayer;
export type CoalescingScope = "request_local" | "process";
export type DisabledReason = "context" | "missing_config" | "invalid_ttl" | "ramped_down" | "config_error";

export interface CacheMetricLabels {
  readonly useCase: string;
  readonly keyType: string;
  readonly layer: MetricLayer;
}

export interface DisabledMetricLabels extends CacheMetricLabels {
  readonly reason: DisabledReason;
}

export interface ErrorMetricLabels extends CacheMetricLabels {
  readonly error: string;
  readonly inFallback: boolean;
}

export interface SerializationMetricLabels extends CacheMetricLabels {
  readonly operation: "dump" | "load";
}

export interface InvalidationMetricLabels {
  readonly keyType: string;
  readonly layer: CacheLayer;
}

export interface CoalescedMetricLabels {
  readonly useCase: string;
  readonly keyType: string;
  readonly scope: CoalescingScope;
}

export interface DialCacheMetricsAdapter {
  request(labels: CacheMetricLabels): void;
  miss(labels: CacheMetricLabels): void;
  disabled(labels: DisabledMetricLabels): void;
  error(labels: ErrorMetricLabels): void;
  invalidation(labels: InvalidationMetricLabels): void;
  // Optional so existing custom adapters keep compiling without changes.
  coalesced?(labels: CoalescedMetricLabels): void;
  observeGet(labels: CacheMetricLabels, seconds: number): void;
  observeFallback(labels: CacheMetricLabels, seconds: number): void;
  observeSerialization(labels: SerializationMetricLabels, seconds: number): void;
  observeSize(labels: CacheMetricLabels, bytes: number): void;
}

export function labelsFor(key: DialCacheKey, layer: MetricLayer): CacheMetricLabels {
  return { useCase: key.useCase, keyType: key.keyType, layer };
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
