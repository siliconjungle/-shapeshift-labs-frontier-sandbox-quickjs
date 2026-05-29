import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { defineSandboxSourceModule } from '@shapeshift-labs/frontier-sandbox';
import {
  createDynamicQuickJsSandboxRuntime,
  createQuickJsSandboxRuntime,
  createQuickJsSandboxRuntimeFromSource
} from '../dist/index.js';

const outPath = readOutPath(process.argv);
const rows = [];

const bundle = {
  id: 'bench.quickjs',
  format: 'expression',
  manifest: {
    id: 'bench.quickjs',
    actions: [{ id: 'bench.set', reads: ['/rows/:id/value'], writes: ['/rows/:id/value'] }]
  },
  code: `({
    actions: {
      "bench.set": function (ctx, input) {
        return ctx.patch.replace("/rows/" + input.id + "/value", input.value);
      }
    }
  })`
};

const state = { rows: { a: { value: 1 } } };
const input = { id: 'a', value: 2 };

const isolated = createQuickJsSandboxRuntime({
  bundle,
  isolation: 'invocation',
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
rows.push(await measureAsync('quickjs.invoke.invocation-isolated', 25, async () => {
  await isolated.invoke('bench.set', input, { state });
}));

const warm = createQuickJsSandboxRuntime({
  bundle,
  isolation: 'runtime',
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
rows.push(await measureAsync('quickjs.invoke.runtime-isolated', 250, async () => {
  await warm.invoke('bench.set', input, { state });
}));
await warm.dispose();

const source = defineSandboxSourceModule({
  id: 'bench.source.quickjs',
  actions: [
    {
      id: 'bench.source.set',
      reads: ['/rows/:id/value'],
      writes: ['/rows/:id/value'],
      format: 'function-body',
      source: 'return ctx.patch.replace("/rows/" + input.id + "/value", input.value);'
    }
  ]
});
const sourceRuntime = createQuickJsSandboxRuntimeFromSource(source, {
  isolation: 'runtime',
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
rows.push(await measureAsync('quickjs.source.runtime-isolated', 250, async () => {
  await sourceRuntime.invoke('bench.source.set', input, { state });
}));
await sourceRuntime.dispose();

let currentSource = source;
const dynamic = createDynamicQuickJsSandboxRuntime({
  source: () => currentSource,
  isolation: 'runtime',
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
await dynamic.refresh();
rows.push(await measureAsync('quickjs.dynamic.cached-source', 250, async () => {
  await dynamic.invoke('bench.source.set', input, { state });
}));
await dynamic.dispose();

const result = {
  kind: 'frontier.sandbox.quickjs.benchmark',
  version: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  rows
};

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
}

for (const row of rows) {
  console.log(`${row.name}: ${row.usPerOp.toFixed(2)}us/op iterations=${row.iterations}`);
}

async function measureAsync(name, iterations, fn) {
  for (let i = 0; i < Math.min(10, iterations); i++) await fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - start;
  return {
    name,
    iterations,
    totalMs,
    usPerOp: (totalMs * 1000) / iterations
  };
}

function readOutPath(argv) {
  const index = argv.indexOf('--out');
  return index === -1 ? '' : argv[index + 1] || '';
}

