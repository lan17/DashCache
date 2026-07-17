import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = await mkdtemp(join(tmpdir(), "dialcache-package-"));
const consumer = `import { CacheLayer, DialCache, DialCacheKeyConfig, JsonSerializer, type CacheConfigProvider, type CachedOptions, type CoalescedMetricLabels, type CoalescingScope, type DialCacheRedisClient, type Serializer } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";
import { READ_CACHE_SCRIPT } from "dialcache/redis-protocol";
import { createValkeyGlideDialCacheClient, type ValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const cache = new DialCache();
const optionsFor = (useCase: string) => ({
  keyType: "id",
  useCase,
  cacheKey: (id: string) => id,
});
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
  useCase: "Load",
  keyType: "id",
  scope: "request_local",
};
const requestLocalCoalescingScope: CoalescingScope = "request_local";

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
void requestLocalCoalescingScope;
void createNodeRedisDialCacheClient;
void createValkeyGlideDialCacheClient;
void READ_CACHE_SCRIPT;

const customRedisClient: DialCacheRedisClient = {
  read: async () => Buffer.from([0, 255]),
  write: async ({ value }) => typeof value === "string" || Buffer.isBuffer(value),
  invalidate: async () => undefined,
};
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
const cacheHasNoFlushAll: "flushAll" extends keyof DialCache ? false : true = true;
const clientHasNoFlushAll: "flushAll" extends keyof DialCacheRedisClient ? false : true = true;
void cacheHasNoFlushAll;
void clientHasNoFlushAll;
const glideRedisClient: ValkeyGlideDialCacheClient | undefined = undefined;
void glideRedisClient;
`;

try {
  await exec("corepack", ["pnpm", "pack", "--pack-destination", workspace], { cwd: root });
  const tarball = (await readdir(workspace)).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("pnpm pack did not produce a tarball");
  }

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      join(workspace, tarball),
      "redis@~4.7.1",
      "typescript@5.9.3",
    ],
    { cwd: workspace },
  );

  let glideWasInstalled = false;
  try {
    await exec(process.execPath, ["--eval", "require.resolve('@valkey/valkey-glide')"], { cwd: workspace });
    glideWasInstalled = true;
  } catch {
    // Optional peers remain absent until the consumer selects the corresponding adapter.
  }
  if (glideWasInstalled) {
    throw new Error("The optional Valkey GLIDE peer was installed automatically");
  }

  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('dialcache'); await import('dialcache/redis-protocol'); await import('dialcache/node-redis')",
    ],
    { cwd: workspace },
  );
  await exec(
    process.execPath,
    ["--eval", "require('dialcache'); require('dialcache/redis-protocol'); require('dialcache/node-redis')"],
    { cwd: workspace },
  );
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      join(workspace, tarball),
      "redis@~4.7.1",
      "typescript@5.9.3",
      "@valkey/valkey-glide@^2.4.2",
    ],
    { cwd: workspace },
  );

  await Promise.all([
    writeFile(join(workspace, "consumer.mts"), consumer),
    writeFile(join(workspace, "consumer.cts"), consumer),
    writeFile(
      join(workspace, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "Node16",
            moduleResolution: "Node16",
            noEmit: true,
            strict: true,
          },
          include: ["consumer.mts", "consumer.cts"],
        },
        null,
        2,
      )}\n`,
    ),
  ]);

  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('dialcache'); await import('dialcache/redis-protocol'); await import('dialcache/node-redis'); await import('dialcache/valkey-glide')",
    ],
    { cwd: workspace },
  );
  await exec(
    process.execPath,
    [
      "--eval",
      "require('dialcache'); require('dialcache/redis-protocol'); require('dialcache/node-redis'); require('dialcache/valkey-glide')",
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
