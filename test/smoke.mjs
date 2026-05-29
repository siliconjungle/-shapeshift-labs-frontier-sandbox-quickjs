import assert from 'node:assert';
import {
  createDynamicQuickJsSandboxRuntime,
  createQuickJsSandboxRuntime,
  createQuickJsSandboxRuntimeFromSource,
  FrontierQuickJsSandboxError
} from '../dist/index.js';
import {
  createSandboxSourceStore,
  defineSandboxSourceModule
} from '@shapeshift-labs/frontier-sandbox';

const bundle = {
  id: 'todos',
  format: 'expression',
  manifest: {
    id: 'todos',
    capabilities: ['module.audit'],
    actions: [
      {
        id: 'todos.toggle',
        reads: ['/todos/:id/done'],
        writes: ['/todos/:id/done'],
        capabilities: ['audit.log']
      },
      {
        id: 'todos.random',
        reads: ['/todos/:id/done'],
        writes: ['/todos/:id/done']
      }
    ]
  },
  code: `({
    actions: {
      "todos.toggle": function (ctx, input) {
        var path = "/todos/" + input.id + "/done";
        var done = ctx.read(path);
        return [
          ctx.patch.replace(path, !done),
          ctx.effect("audit.log", { id: input.id }),
          ctx.effect("module.audit", { id: input.id }),
          ctx.event("todos.toggled", { id: input.id }),
          ctx.log("info", "toggled todo", { id: input.id })
        ];
      },
      "todos.random": function () {
        return Math.random();
      }
    }
  })`
};

const runtime = createQuickJsSandboxRuntime({
  bundle,
  sourcePolicy: { allowAmbientRandom: true },
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024
});

const result = await runtime.invoke('todos.toggle', { id: 'a' }, {
  state: { todos: { a: { done: false } } }
});

assert.deepStrictEqual(result.patches, [[0, ['todos', 'a', 'done'], true]]);
assert.strictEqual(result.effects[0].capability, 'audit.log');
assert.strictEqual(result.effects[1].capability, 'module.audit');
assert.strictEqual(result.events[0].type, 'todos.toggled');
assert.strictEqual(result.logs[0].level, 'info');

await assert.rejects(
  runtime.invoke('todos.random', { id: 'a' }, { state: { todos: { a: { done: false } } } }),
  FrontierQuickJsSandboxError
);

const warmRuntime = createQuickJsSandboxRuntime({
  bundle,
  isolation: 'runtime',
  sourcePolicy: { allowAmbientRandom: true },
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
const warmResult = await warmRuntime.invoke('todos.toggle', { id: 'a' }, {
  state: { todos: { a: { done: true } } }
});
assert.deepStrictEqual(warmResult.patches, [[0, ['todos', 'a', 'done'], false]]);
await warmRuntime.dispose();

assert.throws(
  () => createQuickJsSandboxRuntime({
    bundle: {
      ...bundle,
      id: 'bad',
      code: '({ actions: { bad: function () { return fetch("/x"); } } })'
    }
  }),
  /ambient-network/
);

const sourceModule = defineSandboxSourceModule({
  id: 'source.todos',
  revision: 1,
  actions: [
    {
      id: 'source.rename',
      reads: ['/user/name'],
      writes: ['/user/name'],
      capabilities: ['audit.log'],
      format: 'function-body',
      source: `
        const previous = ctx.read('/user/name');
        return [
          ctx.patch.replace('/user/name', input.name + ':' + previous),
          ctx.effect('audit.log', { previous })
        ];
      `
    },
    {
      id: 'source.flag',
      reads: ['/flag'],
      writes: ['/flag'],
      format: 'expression',
      source: 'ctx.patch.replace("/flag", true)'
    }
  ]
});
const sourceRuntime = createQuickJsSandboxRuntimeFromSource(sourceModule, {
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
const sourceResult = await sourceRuntime.invoke('source.rename', { name: 'Grace' }, { state: { user: { name: 'Ada' } } });
assert.deepStrictEqual(sourceResult.patches, [[0, ['user', 'name'], 'Grace:Ada']]);
assert.strictEqual(sourceResult.effects[0].capability, 'audit.log');
const expressionResult = await sourceRuntime.invoke('source.flag', undefined, { state: { flag: false } });
assert.deepStrictEqual(expressionResult.patches, [[0, ['flag'], true]]);

const sourceStore = createSandboxSourceStore(sourceModule);
const dynamicRuntime = createDynamicQuickJsSandboxRuntime({
  source: sourceStore,
  deadlineMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024
});
sourceStore.applySandboxSourceEvent({
  kind: 'frontier.sandbox.source.action.upsert',
  revision: 2,
  action: {
    id: 'source.rename',
    reads: ['/user/name'],
    writes: ['/user/name'],
    format: 'function-expression',
    source: '(ctx, input) => ctx.patch.replace("/user/name", input.name + ":dynamic")'
  }
});
const dynamicResult = await dynamicRuntime.invoke('source.rename', { name: 'Lin' }, { state: { user: { name: 'Ada' } } });
assert.deepStrictEqual(dynamicResult.patches, [[0, ['user', 'name'], 'Lin:dynamic']]);

console.log('frontier sandbox quickjs smoke passed');
