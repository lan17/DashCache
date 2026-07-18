import type { CacheLayer } from "./config.js";
import type { DialCacheKey } from "./key.js";

export const NO_CACHE_LAYER = "noop";
export const REQUEST_LOCAL_CACHE_LAYER = "request_local";

type NoCacheLayer = typeof NO_CACHE_LAYER;
type RequestLocalCacheLayer = typeof REQUEST_LOCAL_CACHE_LAYER;
export type MetricLayer = CacheLayer | RequestLocalCacheLayer | NoCacheLayer;
export type CoalescingScope = "request_local" | "process";
export type DisabledReason = "context" | "missing_config" | "invalid_ttl" | "ramped_down" | "config_error";
/** Stable failure sites used instead of backend- or application-defined error names. */
export type MetricErrorKind =
  | "key_construction"
  | "config_resolution"
  | "cache_read"
  | "cache_write"
  | "serialization_load"
  | "serialization_dump"
  | "invalidation"
  | "fallback"
  | "unknown";

export interface CacheMetricLabels {
  /** Logical DialCache namespace, independent of backend metric-name namespaces. */
  readonly cacheNamespace: string;
  readonly useCase: string;
  readonly keyType: string;
  readonly layer: MetricLayer;
}

export interface DisabledMetricLabels extends CacheMetricLabels {
  readonly reason: DisabledReason;
}

export interface ErrorMetricLabels extends CacheMetricLabels {
  readonly error: MetricErrorKind;
  readonly inFallback: boolean;
}

export interface SerializationMetricLabels extends CacheMetricLabels {
  readonly operation: "dump" | "load";
}

export interface InvalidationMetricLabels {
  readonly cacheNamespace: string;
  readonly keyType: string;
  readonly layer: CacheLayer;
}

export interface CoalescedMetricLabels {
  readonly cacheNamespace: string;
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
  return { cacheNamespace: key.namespace, useCase: key.useCase, keyType: key.keyType, layer };
}
