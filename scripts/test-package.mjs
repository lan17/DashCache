import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = await mkdtemp(join(tmpdir(), "dialcache-package-"));
const rootConsumer = `import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
  JsonSerializer,
  type CacheMetricLabels,
  type CacheConfigProvider,
  type CachedOptions,
  type CoalescedMetricLabels,
  type CoalescingScope,
  type DialCacheConfig,
  type DialCacheKeyInit,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type InvalidationMetricLabels,
  type MetricErrorKind,
  type RedisConfig,
  type Serializer,
} from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";
import { READ_CACHE_SCRIPT } from "dialcache/redis-protocol";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "dialcache/datadog";

const optionsFor = (useCase: string) => ({
  keyType: "id",
  useCase,
  cacheKey: (id: string) => id,
});
const metrics: DialCacheMetricsAdapter = {
  request: () => undefined,
  miss: () => undefined,
  disabled: () => undefined,
  error: () => undefined,
  invalidation: () => undefined,
  observeGet: () => undefined,
  observeFallback: () => undefined,
  observeSerialization: () => undefined,
  observeSize: () => undefined,
};
const dogStatsDClient: DatadogDogStatsDClient = {
  increment: () => undefined,
  histogram: () => undefined,
  distribution: () => undefined,
};
const datadogObservationMetricType: DatadogObservationMetricType = "distribution";
const datadogOptions: DatadogMetricsOptions = {
  client: dogStatsDClient,
  observationMetricType: datadogObservationMetricType,
};
const datadogMetrics = createDatadogDialCacheMetrics(datadogOptions);
const datadogClassAdapter = new DatadogDialCacheMetrics(datadogOptions);
// @ts-expect-error The observation type is an explicit, required choice.
const missingObservationType: DatadogMetricsOptions = { client: dogStatsDClient };
const cache = new DialCache({ namespace: "consumer-cache", metrics });
const redisProtocolError = new DialCacheRedisProtocolError("Invalid DialCache Redis write reply");
const load = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "Load",
  cacheKey: (id) => id,
  defaultConfig: DialCacheKeyConfig.enabled(60),
});

interface JsonCompatibleRecord {
  readonly id: string;
  readonly nested: { readonly enabled: boolean; readonly scores: readonly number[] };
  readonly nickname?: string;
}

const loadJsonRecord = cache.cached(
  async (id: string): Promise<JsonCompatibleRecord> => ({ id, nested: { enabled: true, scores: [1, 2] } }),
  optionsFor("JsonCompatibleRecord"),
);
const loadEmptyObject = cache.cached(async (_id: string) => ({}), optionsFor("EmptyObject"));
const loadUndefined = cache.cached(async (_id: string) => undefined, optionsFor("TopLevelUndefined"));
const loadVoid = cache.cached(async (_id: string): Promise<void> => undefined, optionsFor("TopLevelVoid"));

const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};
const loadDate = cache.cached(async (_id: string) => new Date(0), {
  ...optionsFor("DateWithSerializer"),
  serializer: dateSerializer,
});
const loadDateWithTrustedJsonAssertion = cache.cached(async (_id: string) => new Date(0), {
  ...optionsFor("DateWithTrustedJsonAssertion"),
  serializer: new JsonSerializer<Date>(),
});
type DateLoader = (id: string) => Promise<Date>;
const dateOptions: CachedOptions<DateLoader> = {
  ...optionsFor("TypedDateOptions"),
  serializer: dateSerializer,
};

class MethodBearingValue {
  constructor(readonly id: string) {}
  label(): string {
    return this.id;
  }
}

// @ts-expect-error Date needs an explicit serializer.
cache.cached(async (_id: string) => new Date(0), optionsFor("DateWithoutSerializer"));
// @ts-expect-error Map needs an explicit serializer.
cache.cached(async (_id: string) => new Map<string, string>(), optionsFor("MapWithoutSerializer"));
// @ts-expect-error Set needs an explicit serializer.
cache.cached(async (_id: string) => new Set<string>(), optionsFor("SetWithoutSerializer"));
// @ts-expect-error bigint needs an explicit serializer.
cache.cached(async (_id: string) => 1n, optionsFor("BigIntWithoutSerializer"));
// @ts-expect-error Functions need an explicit serializer.
cache.cached(async (_id: string) => (value: string) => value, optionsFor("FunctionWithoutSerializer"));
// @ts-expect-error Symbols need an explicit serializer.
cache.cached(async (_id: string) => Symbol("value"), optionsFor("SymbolWithoutSerializer"));
// @ts-expect-error Required nested undefined is not preserved by JSON.
cache.cached(async (_id: string): Promise<{ value: string | undefined }> => ({ value: undefined }), optionsFor("NestedUndefinedWithoutSerializer"));
// @ts-expect-error unknown cannot establish JSON compatibility.
cache.cached(async (_id: string): Promise<unknown> => ({ id: "unknown" }), optionsFor("UnknownWithoutSerializer"));
// @ts-expect-error any cannot establish JSON compatibility.
cache.cached(async (_id: string): Promise<any> => ({ id: "any" }), optionsFor("AnyWithoutSerializer"));
// @ts-expect-error Buffer needs an explicit serializer.
cache.cached(async (_id: string) => Buffer.from("value"), optionsFor("BufferWithoutSerializer"));
// @ts-expect-error Typed arrays need an explicit serializer.
cache.cached(async (_id: string) => new Uint8Array([1, 2]), optionsFor("TypedArrayWithoutSerializer"));
// @ts-expect-error Method-bearing class instances need an explicit serializer.
cache.cached(async (id: string) => new MethodBearingValue(id), optionsFor("ClassWithoutSerializer"));
// @ts-expect-error CachedOptions itself requires a serializer for Date values.
const missingDateSerializer: CachedOptions<DateLoader> = optionsFor("TypedDateOptionsWithoutSerializer");

const requestLocalConfig = new DialCacheKeyConfig({ requestLocal: true });
const structuralConfigProvider: CacheConfigProvider = () => ({
  ttlSec: { [CacheLayer.LOCAL]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100 },
});
const requestLocalCoalescingLabels: CoalescedMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  scope: "request_local",
};
const cacheMetricLabels: CacheMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  layer: CacheLayer.LOCAL,
};
const invalidationMetricLabels: InvalidationMetricLabels = {
  cacheNamespace: "consumer-cache",
  keyType: "id",
  layer: CacheLayer.REMOTE,
};
const keyInit: DialCacheKeyInit = {
  namespace: "consumer-cache",
  keyType: "id",
  id: "123",
  useCase: "Load",
};
const keyInitHasNoUrnPrefix: "urnPrefix" extends keyof DialCacheKeyInit ? false : true = true;
// @ts-expect-error DialCacheKeyInit.urnPrefix was renamed to namespace.
const legacyKeyInit: DialCacheKeyInit = { keyType: "id", id: "123", useCase: "Load", urnPrefix: "consumer-cache" };
const namespacedKey = new DialCacheKey(keyInit);
const requestLocalCoalescingScope: CoalescingScope = "request_local";
const boundedErrorKind: MetricErrorKind = "cache_read";
const metricErrorKinds: Readonly<Record<MetricErrorKind, true>> = {
  key_construction: true,
  config_resolution: true,
  cache_read: true,
  cache_write: true,
  serialization_load: true,
  serialization_dump: true,
  invalidation: true,
  fallback: true,
  unknown: true,
};
// @ts-expect-error Arbitrary exception names are not DialCache metric error categories.
const unboundedErrorKind: MetricErrorKind = "Tenant123Error";

const customRedisClient: DialCacheRedisClient = {
  read: async () => Buffer.from([0, 255]),
  write: async ({ value }) => typeof value === "string" || Buffer.isBuffer(value),
  invalidate: async () => undefined,
};
const cacheHasNoFlushAll: "flushAll" extends keyof DialCache ? false : true = true;
const cacheHasNoClose: "close" extends keyof DialCache ? false : true = true;
const clientHasNoFlushAll: "flushAll" extends keyof DialCacheRedisClient ? false : true = true;
const configHasNoMetricsRegistry: "metricsRegistry" extends keyof DialCacheConfig ? false : true = true;
const configHasNoMetricsPrefix: "metricsPrefix" extends keyof DialCacheConfig ? false : true = true;
const configRejectsFalseMetrics: false extends NonNullable<DialCacheConfig["metrics"]> ? false : true = true;
const configHasNamespace: "namespace" extends keyof DialCacheConfig ? true : false = true;
const configHasNoUrnPrefix: "urnPrefix" extends keyof DialCacheConfig ? false : true = true;
// @ts-expect-error urnPrefix was renamed to namespace.
const legacyNamespaceConfig: DialCacheConfig = { urnPrefix: "consumer-cache" };
const redisConfigHasNoKeyPrefix: "keyPrefix" extends keyof RedisConfig ? false : true = true;
// @ts-expect-error keyPrefix was removed in favor of DialCacheConfig.namespace.
const legacyKeyPrefixConfig: RedisConfig = { client: customRedisClient, keyPrefix: "legacy:" };
const redisConfigRequiresClient: {} extends Pick<RedisConfig, "client"> ? false : true = true;
const redisConfigHasNoCreateClient: "createClient" extends keyof RedisConfig ? false : true = true;
// @ts-expect-error Redis requires a caller-owned client.
const missingRedisClientConfig: RedisConfig = {};
// @ts-expect-error createClient was removed; construct and pass RedisConfig.client instead.
const legacyRedisFactoryConfig: RedisConfig = { createClient: () => customRedisClient };
// @ts-expect-error RedisClientFactory was removed with RedisConfig.createClient.
type LegacyRedisClientFactory = import("dialcache").RedisClientFactory;
type DialCacheRoot = typeof import("dialcache");
const rootHasNoPrometheusFactory: "createPrometheusDialCacheMetrics" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoDatadogFactory: "createDatadogDialCacheMetrics" extends keyof DialCacheRoot ? false : true = true;

void load;
void loadJsonRecord;
void loadEmptyObject;
void loadUndefined;
void loadVoid;
void loadDate;
void loadDateWithTrustedJsonAssertion;
void dateOptions;
void missingDateSerializer;
void requestLocalConfig;
void structuralConfigProvider;
void requestLocalCoalescingLabels;
void cacheMetricLabels;
void invalidationMetricLabels;
void keyInitHasNoUrnPrefix;
void legacyKeyInit;
void namespacedKey.namespace;
void redisProtocolError.name;
void requestLocalCoalescingScope;
void boundedErrorKind;
void metricErrorKinds;
void unboundedErrorKind;
void createNodeRedisDialCacheClient;
void READ_CACHE_SCRIPT;
void customRedisClient;
const globalSerializer: Serializer<unknown> = {
  dump: () => "global",
  load: () => ({ source: "global" }),
};
const cacheWithGlobalSerializer = new DialCache({
  redis: { client: customRedisClient, serializer: globalSerializer },
});
// @ts-expect-error A global serializer cannot establish per-function Date compatibility.
cacheWithGlobalSerializer.cached(async (_id: string) => new Date(0), optionsFor("GlobalSerializerNeedsTypedOverride"));
void cacheHasNoFlushAll;
void cacheHasNoClose;
void clientHasNoFlushAll;
void configHasNoMetricsRegistry;
void configHasNoMetricsPrefix;
void configRejectsFalseMetrics;
void configHasNamespace;
void configHasNoUrnPrefix;
void legacyNamespaceConfig;
void redisConfigHasNoKeyPrefix;
void legacyKeyPrefixConfig;
void redisConfigRequiresClient;
void redisConfigHasNoCreateClient;
void missingRedisClientConfig;
void legacyRedisFactoryConfig;
void rootHasNoPrometheusFactory;
void rootHasNoDatadogFactory;
void datadogMetrics;
void datadogClassAdapter;
void missingObservationType;
`;
const integrationConsumer = `import { DialCache } from "dialcache";
import StatsD from "hot-shots";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "dialcache/datadog";
import {
  PrometheusDialCacheMetrics,
  createPrometheusDialCacheMetrics,
  type PrometheusMetricsOptions,
} from "dialcache/prometheus";
import {
  createValkeyGlideDialCacheClient,
  type ValkeyGlideDialCacheClient,
} from "dialcache/valkey-glide";
import { Registry, type OpenMetricsContentType } from "prom-client";

const registry = new Registry();
const options: PrometheusMetricsOptions = { registry, prefix: "consumer_" };
const metrics = createPrometheusDialCacheMetrics(options);
const cache = new DialCache({ metrics });
const classAdapter = new PrometheusDialCacheMetrics({ registry, prefix: "class_" });
const openMetricsRegistry = new Registry<OpenMetricsContentType>();
openMetricsRegistry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
const openMetricsAdapter = new PrometheusDialCacheMetrics({ registry: openMetricsRegistry, prefix: "open_" });
const registryIsRequired: {} extends Pick<PrometheusMetricsOptions, "registry"> ? false : true = true;
const glideRedisClient: ValkeyGlideDialCacheClient | undefined = undefined;
const dogStatsD = new StatsD({ mock: true });
const compatibleDogStatsD: DatadogDogStatsDClient = dogStatsD;
const observationMetricType: DatadogObservationMetricType = "distribution";
const datadogOptions: DatadogMetricsOptions = {
  client: compatibleDogStatsD,
  observationMetricType,
};
const datadogMetrics = createDatadogDialCacheMetrics(datadogOptions);
const datadogClassAdapter = new DatadogDialCacheMetrics({
  client: dogStatsD,
  observationMetricType: "histogram",
});
const datadogCache = new DialCache({ metrics: datadogMetrics });
const observationMetricTypeIsRequired: {} extends Pick<DatadogMetricsOptions, "observationMetricType">
  ? false
  : true = true;

void cache;
void classAdapter;
void openMetricsAdapter;
void registryIsRequired;
void glideRedisClient;
void createValkeyGlideDialCacheClient;
void datadogClassAdapter;
void datadogCache;
void observationMetricTypeIsRequired;
`;

try {
  await exec("corepack", ["pnpm", "pack", "--pack-destination", workspace], { cwd: root });
  const tarball = (await readdir(workspace)).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("pnpm pack did not produce a tarball");
  }
  const packageTarball = join(workspace, tarball);

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      packageTarball,
      "redis@~4.7.1",
      "typescript@5.9.3",
    ],
    { cwd: workspace },
  );

  for (const integrationDependency of ["prom-client", "@valkey/valkey-glide", "hot-shots"]) {
    if (await isResolvable(integrationDependency, workspace)) {
      throw new Error(`The ${integrationDependency} integration dependency was installed automatically`);
    }
  }

  await Promise.all([
    writeFile(join(workspace, "root-consumer.mts"), rootConsumer),
    writeFile(join(workspace, "root-consumer.cts"), rootConsumer),
    writeFile(
      join(workspace, "tsconfig.root.json"),
      typescriptConfig(["root-consumer.mts", "root-consumer.cts"]),
    ),
  ]);

  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
const nodeRedis = await import("dialcache/node-redis");
await import("dialcache/datadog");
await import("dialcache/redis-protocol");
try {
  nodeRedis.dialcacheRedisScripts.dialcacheWrite.transformReply(2);
  throw new Error("Expected an invalid node-redis script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The node-redis protocol error does not match the root ESM export");
  }
}`,
    ],
    { cwd: workspace },
  );
  await exec(
    process.execPath,
    [
      "--eval",
      `const root = require("dialcache");
const nodeRedis = require("dialcache/node-redis");
require("dialcache/datadog");
require("dialcache/redis-protocol");
try {
  nodeRedis.dialcacheRedisScripts.dialcacheWrite.transformReply(2);
  throw new Error("Expected an invalid node-redis script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The node-redis protocol error does not match the root CommonJS export");
  }
}`,
    ],
    { cwd: workspace },
  );
  await exec(
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.root.json")],
    { cwd: workspace },
  );

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      packageTarball,
      "redis@~4.7.1",
      "typescript@5.9.3",
      "prom-client@^15.1.3",
      "@valkey/valkey-glide@^2.4.2",
      "hot-shots@^17.0.0",
    ],
    { cwd: workspace },
  );

  await Promise.all([
    writeFile(join(workspace, "consumer.mts"), integrationConsumer),
    writeFile(join(workspace, "consumer.cts"), integrationConsumer),
    writeFile(join(workspace, "tsconfig.json"), typescriptConfig(["consumer.mts", "consumer.cts"])),
  ]);

  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
const glide = await import("dialcache/valkey-glide");
await import("dialcache/datadog");
await import("dialcache/prometheus");
await import("dialcache/redis-protocol");
await import("dialcache/node-redis");
const adapter = glide.createValkeyGlideDialCacheClient({ invokeScript: async () => 2 });
try {
  await adapter.write({ valueKey: "value", cacheTtlMs: 1_000, value: "payload" });
  throw new Error("Expected an invalid GLIDE script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The GLIDE protocol error does not match the root ESM export");
  }
} finally {
  adapter.dispose();
}`,
    ],
    { cwd: workspace },
  );
  await exec(
    process.execPath,
    [
      "--eval",
      `const root = require("dialcache");
const glide = require("dialcache/valkey-glide");
require("dialcache/datadog");
require("dialcache/prometheus");
require("dialcache/redis-protocol");
require("dialcache/node-redis");
void (async () => {
  const adapter = glide.createValkeyGlideDialCacheClient({ invokeScript: async () => 2 });
  try {
    await adapter.write({ valueKey: "value", cacheTtlMs: 1_000, value: "payload" });
    throw new Error("Expected an invalid GLIDE script reply to fail");
  } catch (error) {
    if (!(error instanceof root.DialCacheRedisProtocolError)) {
      throw new Error("The GLIDE protocol error does not match the root CommonJS export");
    }
  } finally {
    adapter.dispose();
  }
})();`,
    ],
    { cwd: workspace },
  );
  await exec(
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.json")],
    { cwd: workspace },
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function isResolvable(specifier, cwd) {
  try {
    await exec(process.execPath, ["--eval", `require.resolve(${JSON.stringify(specifier)})`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function typescriptConfig(include) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        module: "Node16",
        moduleResolution: "Node16",
        noEmit: true,
        strict: true,
      },
      include,
    },
    null,
    2,
  )}\n`;
}
