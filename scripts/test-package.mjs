import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = await mkdtemp(join(tmpdir(), "dialcache-package-"));
const consumer = `import { DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";
import { READ_CACHE_SCRIPT } from "dialcache/redis-protocol";

const cache = new DialCache();
const load = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "Load",
  cacheKey: (id) => id,
  defaultConfig: DialCacheKeyConfig.enabled(60),
});

void load;
void createNodeRedisDialCacheClient;
void READ_CACHE_SCRIPT;
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
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.json")],
    { cwd: workspace },
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
