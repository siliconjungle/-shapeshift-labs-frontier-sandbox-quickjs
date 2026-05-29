# Frontier Sandbox QuickJS

QuickJS/WebAssembly runtime adapter for Frontier sandbox actions.

This package executes compiled sandbox bundles behind `quickjs-emscripten` and returns Frontier sandbox results:

- compact Frontier patches;
- effect requests;
- event records;
- log records.

The adapter intentionally does not expose host state directly. Each invocation receives a JSON snapshot, a small guest `ctx`, declared action metadata, and no ambient network/filesystem APIs.

```ts
import { createQuickJsSandboxRuntime } from '@shapeshift-labs/frontier-sandbox-quickjs';

const runtime = createQuickJsSandboxRuntime({
  bundle: {
    id: 'todos',
    format: 'expression',
    manifest: {
      id: 'todos',
      actions: [
        {
          id: 'todos.toggle',
          reads: ['/todos/:id/done'],
          writes: ['/todos/:id/done'],
          capabilities: ['audit.log']
        }
      ]
    },
    code: `({
      actions: {
        "todos.toggle"(ctx, input) {
          const path = "/todos/" + input.id + "/done";
          const done = ctx.read(path);
          return [
            ctx.patch.replace(path, !done),
            ctx.effect("audit.log", { id: input.id })
          ];
        }
      }
    })`
  },
  isolation: 'invocation',
  deadlineMs: 25,
  memoryLimitBytes: 4 * 1024 * 1024
});

const result = await runtime.invoke('todos.toggle', { id: 'a' }, {
  state: { todos: { a: { done: false } } }
});
```

Keep host effects outside the VM. Guest code should request effects as data, and the host should decide whether to execute them.

`isolation: 'invocation'` creates a fresh QuickJS runtime/context for each call. `isolation: 'runtime'` keeps one QuickJS runtime/context warm and queues invocations through it. Use runtime isolation for trusted or already-reviewed dynamic code when repeated execution latency matters; use invocation isolation as the stricter default.

## Source Strings

Dynamic contexts can use `FrontierSandboxSourceModule` from `@shapeshift-labs/frontier-sandbox`. The source is plain text, so CRDTs, event logs, or game-state patches can sync it directly.

```ts
import {
  createSandboxSourceStore,
  defineSandboxSourceModule
} from '@shapeshift-labs/frontier-sandbox';
import {
  createDynamicQuickJsSandboxRuntime
} from '@shapeshift-labs/frontier-sandbox-quickjs';

const source = defineSandboxSourceModule({
  id: 'world.behaviors',
  actions: [
    {
      id: 'npc.rename',
      reads: ['/npcs/:id/name'],
      writes: ['/npcs/:id/name'],
      format: 'function-body',
      source: `
        const path = '/npcs/' + input.id + '/name';
        return ctx.patch.replace(path, input.name);
      `
    }
  ]
});

const store = createSandboxSourceStore(source);
const runtime = createDynamicQuickJsSandboxRuntime({
  source: store,
  isolation: 'runtime',
  deadlineMs: 25,
  memoryLimitBytes: 4 * 1024 * 1024
});

store.applySandboxSourceEvent({
  kind: 'frontier.sandbox.source.action.upsert',
  action: {
    id: 'npc.rename',
    reads: ['/npcs/:id/name'],
    writes: ['/npcs/:id/name'],
    format: 'expression',
    source: 'ctx.patch.replace("/npcs/" + input.id + "/name", input.name)'
  }
});
```

`function-body`, `function-expression`, and `expression` sources are supported. TypeScript should be compiled to JavaScript by the host build layer before entering QuickJS.

Run focused benchmarks with:

```sh
npm run bench
```
