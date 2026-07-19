import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../dist/index.js";

const sequentialIterations = readPositiveInteger("DIALCACHE_BENCH_ITERATIONS", 50_000);
const coalescingFanout = readPositiveInteger("DIALCACHE_BENCH_FANOUT", 1_000);

const results = [
  await benchmarkSequentialRequestLocalHits(sequentialIterations),
  await benchmarkSequentialProcessLocalHits(sequentialIterations),
  await benchmarkEnabledFallbacks(sequentialIterations),
  await benchmarkRequestLocalCoalescing(coalescingFanout),
  await benchmarkProcessCoalescing(coalescingFanout),
];

console.table(
  results.map(({ scenario, operations, elapsedMs, fallbackCalls }) => ({
    scenario,
    operations,
    "elapsed (ms)": elapsedMs.toFixed(2),
    "operations/sec": Math.round((operations / elapsedMs) * 1_000).toLocaleString("en-US"),
    "fallback calls": fallbackCalls,
  })),
);

console.log("Semantic assertions passed; elapsed times are informational and have no pass/fail threshold.");

async function benchmarkSequentialRequestLocalHits(iterations) {
  const dialcache = new DialCache();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return { id };
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkRequestLocalSequential",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    },
  );

  let elapsedMs = 0;
  await dialcache.enable(async () => {
    const expected = await getValue("shared");
    let actual = expected;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      actual = await getValue("shared");
    }
    elapsedMs = performance.now() - start;
    assert.strictEqual(actual, expected);
  });

  assert.equal(fallbackCalls, 1, "sequential request-local hits should execute the fallback once");
  return { scenario: "request-local sequential hits", operations: iterations, elapsedMs, fallbackCalls };
}

async function benchmarkSequentialProcessLocalHits(iterations) {
  const dialcache = new DialCache();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return { id };
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkProcessLocalSequential",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    },
  );

  let elapsedMs = 0;
  await dialcache.enable(async () => {
    const expected = await getValue("shared");
    let actual = expected;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      actual = await getValue("shared");
    }
    elapsedMs = performance.now() - start;
    assert.strictEqual(actual, expected);
  });

  assert.equal(fallbackCalls, 1, "process-local hits should reuse the first fallback value");
  return { scenario: "process-local sequential hits", operations: iterations, elapsedMs, fallbackCalls };
}

async function benchmarkEnabledFallbacks(iterations) {
  const dialcache = new DialCache();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkEnabledFallbacks",
      cacheKey: (id) => id,
    },
  );

  let elapsedMs = 0;
  await dialcache.enable(async () => {
    await getValue("warmup");
    fallbackCalls = 0;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      await getValue("shared");
    }
    elapsedMs = performance.now() - start;
  });

  assert.equal(fallbackCalls, iterations, "enabled uncached calls should each run a bounded fallback");
  return { scenario: "enabled bounded fallbacks", operations: iterations, elapsedMs, fallbackCalls };
}

async function benchmarkRequestLocalCoalescing(fanout) {
  const dialcache = new DialCache();
  const gate = deferred();
  const started = deferred();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      started.resolve();
      await gate.promise;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkRequestLocalCoalescing",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    },
  );

  const start = performance.now();
  const valuesPromise = dialcache.enable(async () => {
    const values = Array.from({ length: fanout }, () => getValue("shared"));
    await started.promise;
    await nextTurn();
    gate.resolve();
    return await Promise.all(values);
  });
  const values = await valuesPromise;
  const elapsedMs = performance.now() - start;

  assert.deepEqual(new Set(values), new Set(["shared"]));
  assert.equal(fallbackCalls, 1, "request-local coalescing should execute the fallback once");
  return { scenario: "request-local coalescing", operations: fanout, elapsedMs, fallbackCalls };
}

async function benchmarkProcessCoalescing(fanout) {
  const dialcache = new DialCache();
  const gate = deferred();
  const started = deferred();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      started.resolve();
      await gate.promise;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkProcessCoalescing",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    },
  );

  const start = performance.now();
  const valuesPromise = Promise.all(
    Array.from({ length: fanout }, () => dialcache.enable(async () => await getValue("shared"))),
  );
  await started.promise;
  await nextTurn();
  const activeState = dialcache.getCoalescingState().process;
  assert.equal(activeState.activeLeaders, 1);
  assert.equal(activeState.activeFollowers, fanout - 1);
  assert.equal(typeof activeState.oldestLeaderAgeMs, "number");
  gate.resolve();
  const values = await valuesPromise;
  const elapsedMs = performance.now() - start;

  assert.deepEqual(new Set(values), new Set(["shared"]));
  assert.equal(fallbackCalls, 1, "process coalescing should execute the fallback once across enabled scopes");
  assert.deepEqual(dialcache.getCoalescingState().process, {
    activeLeaders: 0,
    activeFollowers: 0,
    oldestLeaderAgeMs: null,
  });
  return { scenario: "process coalescing", operations: fanout, elapsedMs, fallbackCalls };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}
