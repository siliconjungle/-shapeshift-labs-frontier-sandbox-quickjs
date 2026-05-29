import { getQuickJS } from 'quickjs-emscripten';
import {
  assertSandboxSource,
  createDynamicSandboxRuntime,
  defineSandboxSourceModule,
  getSandboxActionManifest,
  normalizeSandboxResult,
  validateSandboxResult,
  type FrontierSandboxActionSource,
  type FrontierSandboxDynamicRuntime,
  type FrontierSandboxInvokeOptions,
  type FrontierSandboxModuleManifest,
  type FrontierSandboxResult,
  type FrontierSandboxRuntime,
  type FrontierSandboxSourceModule,
  type FrontierSandboxSourceProvider,
  type FrontierSandboxSourcePolicy
} from '@shapeshift-labs/frontier-sandbox';
import { assertJsonValue } from '@shapeshift-labs/frontier/validate';
import type { JsonValue } from '@shapeshift-labs/frontier';

export type FrontierQuickJsSandboxBundleFormat = 'expression' | 'script';
export type FrontierQuickJsSandboxIsolationMode = 'invocation' | 'runtime';

export interface FrontierQuickJsSandboxBundle {
  id: string;
  code: string;
  format?: FrontierQuickJsSandboxBundleFormat;
  manifest: FrontierSandboxModuleManifest;
  sourcePolicy?: FrontierSandboxSourcePolicy;
}

export interface FrontierQuickJsSandboxRuntimeOptions {
  bundle: FrontierQuickJsSandboxBundle;
  isolation?: FrontierQuickJsSandboxIsolationMode;
  deadlineMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  sourcePolicy?: FrontierSandboxSourcePolicy;
}

export interface FrontierQuickJsSourceBundleOptions {
  sourcePolicy?: FrontierSandboxSourcePolicy;
}

export interface FrontierQuickJsDynamicSandboxRuntimeOptions extends Omit<FrontierQuickJsSandboxRuntimeOptions, 'bundle'> {
  source: FrontierSandboxSourceModule | FrontierSandboxSourceProvider | (() => FrontierSandboxSourceModule | PromiseLike<FrontierSandboxSourceModule>);
}

export class FrontierQuickJsSandboxError extends Error {
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'FrontierQuickJsSandboxError';
    this.detail = detail;
  }
}

export function createQuickJsSandboxRuntime(options: FrontierQuickJsSandboxRuntimeOptions): FrontierSandboxRuntime {
  const bundle = options.bundle;
  if (!bundle || typeof bundle.id !== 'string' || bundle.id.length === 0) {
    throw new TypeError('Frontier QuickJS sandbox bundle requires an id');
  }
  assertSandboxSource(bundle.code, { ...(options.sourcePolicy ?? {}), ...(bundle.sourcePolicy ?? {}) });
  if (options.isolation === 'runtime') return createReusableQuickJsSandboxRuntime(options);
  return {
    async invoke(actionId: string, input?: JsonValue, invokeOptions: FrontierSandboxInvokeOptions = {}): Promise<FrontierSandboxResult> {
      if (invokeOptions.signal?.aborted) throw new Error('Frontier QuickJS sandbox invocation aborted before start');
      if (input !== undefined) assertJsonValue(input);
      const actionManifest = getSandboxActionManifest(bundle.manifest, actionId);
      const raw = await evaluateQuickJsBundle(bundle, actionId, input, invokeOptions.state, {
        deadlineMs: options.deadlineMs,
        memoryLimitBytes: options.memoryLimitBytes,
        maxStackSizeBytes: options.maxStackSizeBytes,
        signal: invokeOptions.signal
      });
      if (invokeOptions.signal?.aborted) throw new Error('Frontier QuickJS sandbox invocation aborted');
      const result = normalizeSandboxResult(raw as never);
      validateSandboxResult(actionManifest, result, bundle.manifest);
      return result;
    }
  };
}

function createReusableQuickJsSandboxRuntime(options: FrontierQuickJsSandboxRuntimeOptions): FrontierSandboxRuntime {
  let runnerPromise: Promise<FrontierReusableQuickJsRunner> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function getRunner(): Promise<FrontierReusableQuickJsRunner> {
    return runnerPromise ?? (runnerPromise = createReusableQuickJsRunner(options));
  }
  return {
    invoke(actionId: string, input?: JsonValue, invokeOptions: FrontierSandboxInvokeOptions = {}): Promise<FrontierSandboxResult> {
      const run = async () => {
        if (invokeOptions.signal?.aborted) throw new Error('Frontier QuickJS sandbox invocation aborted before start');
        if (input !== undefined) assertJsonValue(input);
        const actionManifest = getSandboxActionManifest(options.bundle.manifest, actionId);
        const runner = await getRunner();
        const raw = runner.invoke(actionId, input, invokeOptions.state, {
          deadlineMs: options.deadlineMs,
          signal: invokeOptions.signal
        });
        if (invokeOptions.signal?.aborted) throw new Error('Frontier QuickJS sandbox invocation aborted');
        const result = normalizeSandboxResult(raw as never);
        validateSandboxResult(actionManifest, result, options.bundle.manifest);
        return result;
      };
      const pending = queue.then(run, run);
      queue = pending.catch(() => undefined);
      return pending;
    },
    async dispose() {
      const runner = await runnerPromise;
      runner?.dispose();
    }
  };
}

interface FrontierReusableQuickJsRunner {
  invoke(
    actionId: string,
    input: JsonValue | undefined,
    state: JsonValue | undefined,
    limits: { deadlineMs?: number; signal?: AbortSignal }
  ): unknown;
  dispose(): void;
}

export function createQuickJsSandboxBundleFromSource(
  source: FrontierSandboxSourceModule,
  options: FrontierQuickJsSourceBundleOptions = {}
): FrontierQuickJsSandboxBundle {
  const normalized = normalizeQuickJsSourceModule(source, options.sourcePolicy);
  return {
    id: normalized.id,
    code: createQuickJsModuleExpression(normalized.actions),
    format: 'expression',
    manifest: normalized.manifest,
    sourcePolicy: options.sourcePolicy
  };
}

export function createQuickJsSandboxRuntimeFromSource(
  source: FrontierSandboxSourceModule,
  options: Omit<FrontierQuickJsSandboxRuntimeOptions, 'bundle'> = {}
): FrontierSandboxRuntime {
  return createQuickJsSandboxRuntime({
    ...options,
    bundle: createQuickJsSandboxBundleFromSource(source, { sourcePolicy: options.sourcePolicy })
  });
}

export function createDynamicQuickJsSandboxRuntime(
  options: FrontierQuickJsDynamicSandboxRuntimeOptions
): FrontierSandboxDynamicRuntime {
  return createDynamicSandboxRuntime({
    source: options.source,
    createRuntime(source) {
      return createQuickJsSandboxRuntimeFromSource(source, options);
    }
  });
}

async function evaluateQuickJsBundle(
  bundle: FrontierQuickJsSandboxBundle,
  actionId: string,
  input: JsonValue | undefined,
  state: JsonValue | undefined,
  limits: {
    deadlineMs?: number;
    memoryLimitBytes?: number;
    maxStackSizeBytes?: number;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  const deadline = limits.deadlineMs && limits.deadlineMs > 0 ? Date.now() + limits.deadlineMs : 0;
  if (typeof runtime.setMemoryLimit === 'function' && limits.memoryLimitBytes !== undefined) {
    runtime.setMemoryLimit(limits.memoryLimitBytes);
  }
  if (typeof runtime.setMaxStackSize === 'function' && limits.maxStackSizeBytes !== undefined) {
    runtime.setMaxStackSize(limits.maxStackSizeBytes);
  }
  if (typeof runtime.setInterruptHandler === 'function' && (deadline !== 0 || limits.signal)) {
    runtime.setInterruptHandler(() => {
      if (limits.signal?.aborted) return true;
      return deadline !== 0 && Date.now() > deadline;
    });
  }
  const vm = runtime.newContext();
  try {
    const source = createEvaluationSource(bundle, actionId, input, state);
    return evaluateQuickJsJson(vm, source);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

async function createReusableQuickJsRunner(options: FrontierQuickJsSandboxRuntimeOptions): Promise<FrontierReusableQuickJsRunner> {
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  let deadline = 0;
  let signal: AbortSignal | undefined;
  if (typeof runtime.setMemoryLimit === 'function' && options.memoryLimitBytes !== undefined) {
    runtime.setMemoryLimit(options.memoryLimitBytes);
  }
  if (typeof runtime.setMaxStackSize === 'function' && options.maxStackSizeBytes !== undefined) {
    runtime.setMaxStackSize(options.maxStackSizeBytes);
  }
  if (typeof runtime.setInterruptHandler === 'function') {
    runtime.setInterruptHandler(() => {
      if (signal?.aborted) return true;
      return deadline !== 0 && Date.now() > deadline;
    });
  }
  const vm = runtime.newContext();
  try {
    evaluateQuickJsJson(vm, createPersistentEvaluationSource(options.bundle));
  } catch (error) {
    vm.dispose();
    runtime.dispose();
    throw error;
  }
  return {
    invoke(actionId, input, state, limits) {
      deadline = limits.deadlineMs && limits.deadlineMs > 0 ? Date.now() + limits.deadlineMs : 0;
      signal = limits.signal;
      try {
        return evaluateQuickJsJson(vm, createInvocationSource(options.bundle.manifest, actionId, input, state));
      } finally {
        deadline = 0;
        signal = undefined;
      }
    },
    dispose() {
      vm.dispose();
      runtime.dispose();
    }
  };
}

function createEvaluationSource(
  bundle: FrontierQuickJsSandboxBundle,
  actionId: string,
  input: JsonValue | undefined,
  state: JsonValue | undefined
): string {
  return createPersistentEvaluationSource(bundle) + '\n' + createInvocationSource(bundle.manifest, actionId, input, state);
}

function createPersistentEvaluationSource(bundle: FrontierQuickJsSandboxBundle): string {
  const moduleSource = bundle.format === 'script'
    ? bundle.code
    : 'globalThis.__frontierSandboxModule = (' + bundle.code + ');';
  return [
    '"use strict";',
    QUICKJS_LOCKDOWN_SOURCE,
    moduleSource,
    QUICKJS_GUEST_SOURCE,
    'JSON.stringify({ ready: true });'
  ].join('\n');
}

function createInvocationSource(
  manifest: FrontierSandboxModuleManifest,
  actionId: string,
  input: JsonValue | undefined,
  state: JsonValue | undefined
): string {
  const action = createGuestActionManifest(manifest, actionId);
  return 'JSON.stringify(__frontierInvoke(' +
    JSON.stringify(actionId) + ',' +
    JSON.stringify(input === undefined ? null : input) + ',' +
    JSON.stringify(state === undefined ? null : state) + ',' +
    JSON.stringify(action) +
  '));';
}

function evaluateQuickJsJson(vm: { evalCode(source: string): unknown; dump(value: unknown): unknown }, source: string): unknown {
  const evaluated = vm.evalCode(source) as { error?: { dispose(): void }; value?: { dispose(): void } };
  if ('error' in evaluated) {
    const detail = vm.dump(evaluated.error);
    evaluated.error?.dispose();
    throw new FrontierQuickJsSandboxError('Frontier QuickJS sandbox evaluation failed', detail);
  }
  const value = evaluated.value;
  const dumped = vm.dump(value);
  value?.dispose();
  if (typeof dumped !== 'string') {
    throw new FrontierQuickJsSandboxError('Frontier QuickJS sandbox did not return serialized JSON', dumped);
  }
  return JSON.parse(dumped);
}

function createGuestActionManifest(manifest: FrontierSandboxModuleManifest, actionId: string): ReturnType<typeof getSandboxActionManifest> {
  const action = getSandboxActionManifest(manifest, actionId);
  if (!manifest.capabilities || manifest.capabilities.length === 0) return action;
  return {
    ...action,
    capabilities: uniqueStrings([...(action.capabilities ?? []), ...manifest.capabilities])
  };
}

function normalizeQuickJsSourceModule(
  source: FrontierSandboxSourceModule,
  sourcePolicy: FrontierSandboxSourcePolicy = {}
): FrontierSandboxSourceModule {
  return defineSandboxSourceModule({
    id: source.id,
    version: source.version,
    revision: source.revision,
    actions: source.actions,
    capabilities: source.capabilities ?? source.manifest.capabilities,
    metadata: source.metadata,
    manifest: source.manifest,
    contentHash: source.contentHash,
    sourcePolicy
  });
}

function createQuickJsModuleExpression(actions: readonly FrontierSandboxActionSource[]): string {
  return '({ actions: {' + actions.map((action) => JSON.stringify(action.id) + ': ' + renderQuickJsActionSource(action)).join(',') + '} })';
}

function renderQuickJsActionSource(action: FrontierSandboxActionSource): string {
  switch (action.format ?? 'function-body') {
    case 'function-body':
      return 'function(ctx, input) {\n' + action.source + '\n}';
    case 'function-expression':
      return '(' + action.source + ')';
    case 'expression':
      return 'function(ctx, input) { return (' + action.source + '); }';
    default:
      throw new TypeError('Unsupported Frontier QuickJS action source format: ' + action.format);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

const QUICKJS_LOCKDOWN_SOURCE = `
globalThis.eval = undefined;
globalThis.Function = undefined;
globalThis.Date = undefined;
globalThis.fetch = undefined;
globalThis.WebSocket = undefined;
globalThis.XMLHttpRequest = undefined;
if (globalThis.Math) {
  Object.defineProperty(globalThis.Math, 'random', {
    value: function () { throw new Error('Math.random requires a Frontier sandbox capability'); },
    configurable: false
  });
}
`;

const QUICKJS_GUEST_SOURCE = `
function __frontierNormalizePath(path) {
  if (Array.isArray(path)) return path.map(function (segment) {
    if (typeof segment !== 'string' && typeof segment !== 'number') throw new Error('Frontier sandbox path segment must be string or number');
    return segment;
  });
  if (path === '') return [];
  if (typeof path !== 'string' || path.charAt(0) !== '/') throw new Error('Frontier sandbox path must be a JSON pointer');
  if (path === '/') return [''];
  return path.slice(1).split('/').map(function (segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

function __frontierPathMatches(pattern, path) {
  var expected = __frontierNormalizePath(pattern);
  var actual = __frontierNormalizePath(path);
  for (var i = 0; i < expected.length; i++) {
    var segment = String(expected[i]);
    if (segment === '**') return true;
    if (i >= actual.length) return false;
    if (segment === '*' || segment.charAt(0) === ':') continue;
    if (segment !== String(actual[i])) return false;
  }
  return expected.length === actual.length;
}

function __frontierAssertAllowed(patterns, path, operation, actionId) {
  if (!patterns || patterns.length === 0) throw new Error('Frontier sandbox action ' + actionId + ' does not declare any ' + operation + ' paths');
  for (var i = 0; i < patterns.length; i++) {
    if (__frontierPathMatches(patterns[i], path)) return;
  }
  throw new Error('Frontier sandbox action ' + actionId + ' attempted undeclared ' + operation + ' path');
}

function __frontierReadPath(value, path) {
  var parts = __frontierNormalizePath(path);
  var cursor = value;
  for (var i = 0; i < parts.length; i++) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = cursor[String(parts[i])];
  }
  return cursor;
}

function __frontierAssertCapability(action, capability) {
  var capabilities = action.capabilities || [];
  for (var i = 0; i < capabilities.length; i++) {
    if (capabilities[i] === capability) return;
  }
  throw new Error('Frontier sandbox action ' + action.id + ' attempted undeclared capability ' + capability);
}

function __frontierCreateCtx(action, state) {
  function op(code, path, a, b) {
    var normalized = __frontierNormalizePath(path);
    if (arguments.length === 2) return [code, normalized];
    if (arguments.length === 3) return [code, normalized, a];
    return [code, normalized, a, b];
  }
  return {
    action: action,
    read: function (path) {
      __frontierAssertAllowed(action.reads, path, 'read', action.id);
      return __frontierReadPath(state, path);
    },
    patch: {
      set: function (path, value) { return op(0, path, value); },
      replace: function (path, value) { return op(0, path, value); },
      remove: function (path) { return op(1, path); },
      assign: function (path, value) { return op(4, path, value); },
      append: function (path, values) { return op(3, path, values); },
      truncate: function (path, length) { return op(2, path, length); }
    },
    effect: function (capability, input, metadata) {
      __frontierAssertCapability(action, capability);
      return { kind: 'frontier.sandbox.effect', capability: capability, input: input, metadata: metadata };
    },
    event: function (type, payload, metadata) {
      return { kind: 'frontier.sandbox.event', type: type, payload: payload, metadata: metadata };
    },
    log: function (level, message, metadata) {
      return { kind: 'frontier.sandbox.log', level: level, message: message, metadata: metadata };
    }
  };
}

function __frontierInvoke(actionId, input, state, action) {
  var module = globalThis.__frontierSandboxModule || globalThis.frontierSandboxModule;
  if (!module || !module.actions || typeof module.actions[actionId] !== 'function') {
    throw new Error('Unknown Frontier sandbox action: ' + actionId);
  }
  var result = module.actions[actionId](__frontierCreateCtx(action, state), input);
  if (result && typeof result.then === 'function') {
    throw new Error('Async Frontier sandbox actions are not supported by this QuickJS adapter');
  }
  return result === undefined ? null : result;
}
`;
