import {
  createDynamicQuickJsSandboxRuntime,
  createQuickJsSandboxRuntimeFromSource,
  createQuickJsSandboxRuntime,
  type FrontierQuickJsSandboxBundle
} from '../dist/index.js';
import {
  createSandboxSourceStore,
  defineSandboxSourceModule,
  type FrontierSandboxRuntime
} from '@shapeshift-labs/frontier-sandbox';

const bundle: FrontierQuickJsSandboxBundle = {
  id: 'typed',
  code: '({ actions: { "typed.echo": function (ctx) { return ctx.patch.set("/value", "ok"); } } })',
  manifest: {
    id: 'typed',
    actions: [{ id: 'typed.echo', reads: ['/value'], writes: ['/value'] }]
  }
};

const runtime: FrontierSandboxRuntime = createQuickJsSandboxRuntime({ bundle });
const warmRuntime: FrontierSandboxRuntime = createQuickJsSandboxRuntime({ bundle, isolation: 'runtime' });
void runtime.invoke('typed.echo', undefined, { state: { value: 'x' } });
void warmRuntime.invoke('typed.echo', undefined, { state: { value: 'x' } });

const sourceModule = defineSandboxSourceModule({
  id: 'typed-source',
  actions: [
    {
      id: 'typed-source.echo',
      reads: ['/value'],
      writes: ['/value'],
      format: 'function-body',
      source: 'return ctx.patch.set("/value", "ok");'
    }
  ]
});
const sourceRuntime: FrontierSandboxRuntime = createQuickJsSandboxRuntimeFromSource(sourceModule);
const sourceStore = createSandboxSourceStore(sourceModule);
const dynamicRuntime: FrontierSandboxRuntime = createDynamicQuickJsSandboxRuntime({ source: sourceStore });
void sourceRuntime.invoke('typed-source.echo', undefined, { state: { value: 'x' } });
void dynamicRuntime.invoke('typed-source.echo', undefined, { state: { value: 'x' } });
