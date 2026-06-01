import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import extension, {
  normalizeBaseUrl,
  mapGateframeModel,
  getFallbackModels,
  discoverModels,
  registerGateframeProvider,
  defaultGateframeConfig,
  loadModelOverrides,
  loadEnvFile,
  applyEnvFileToProcess,
  getResponsesApiModelIds,
  __resetLastGoodModelsCache,
} from '../extensions/gateframe-provider.ts';

test.beforeEach(() => {
  __resetLastGoodModelsCache();
});

function getHeader(init, name) {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  // Plain object. Do a case-insensitive lookup.
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return undefined;
}

test('normalizeBaseUrl preserves trailing /v1', () => {
  assert.equal(normalizeBaseUrl('http://node1.gateframe.ai:3000/v1'), 'http://node1.gateframe.ai:3000/v1');
});

test('normalizeBaseUrl appends /v1 when missing', () => {
  assert.equal(normalizeBaseUrl('http://node1.gateframe.ai:3000'), 'http://node1.gateframe.ai:3000/v1');
});

test('registerGateframeProvider skips registration when base url is missing', async () => {
  const providerCalls = [];
  const notices = [];

  await registerGateframeProvider({
    pi: { registerProvider: (...args) => providerCalls.push(args) },
    env: { GATEFRAME_API_KEY: 'gf_test' },
    notify: (...args) => notices.push(args),
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(providerCalls.length, 0, 'must not register without GATEFRAME_BASE_URL');
  assert.ok(
    notices.some(([msg, level]) => /GATEFRAME_BASE_URL/i.test(msg) && level === 'warning'),
    'should notify a warning naming GATEFRAME_BASE_URL',
  );
});

test('mapGateframeModel maps OpenAI model id to pi model definition', () => {
  const model = mapGateframeModel({ id: 'gateframe/minimax-2.7' });
  assert.equal(model.id, 'gateframe/minimax-2.7');
  assert.equal(typeof model.reasoning, 'boolean');
});

test('mapGateframeModel applies known-id default metadata', () => {
  const model = mapGateframeModel({ id: 'gateframe/opus-4.7' });
  // opus-4.7 is marked reasoning-capable in the built-in defaults table.
  assert.equal(model.reasoning, true);
});

test('mapGateframeModel falls back to safe defaults for unknown ids', () => {
  const model = mapGateframeModel({ id: 'gateframe/brand-new-model' });
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.cost.input, 0);
});

test('mapGateframeModel accepts runtime overrides', () => {
  const model = mapGateframeModel(
    { id: 'gateframe/minimax-2.7' },
    {
      'gateframe/minimax-2.7': {
        contextWindow: 256000,
        maxTokens: 4096,
        reasoning: true,
        cost: { input: 1.5, output: 4.5, cacheRead: 0.15, cacheWrite: 1.5 },
      },
    },
  );
  assert.equal(model.contextWindow, 256000);
  assert.equal(model.maxTokens, 4096);
  assert.equal(model.reasoning, true);
  assert.equal(model.cost.input, 1.5);
  assert.equal(model.cost.output, 4.5);
});

test('loadModelOverrides reads JSON file when path is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-overrides-'));
  const file = join(dir, 'overrides.json');
  writeFileSync(file, JSON.stringify({
    'gateframe/opus-4.7': { contextWindow: 200000, reasoning: true },
  }));

  try {
    const { overrides, error } = loadModelOverrides({ GATEFRAME_MODEL_OVERRIDES_PATH: file });
    assert.equal(error, undefined);
    assert.equal(overrides['gateframe/opus-4.7'].contextWindow, 200000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadModelOverrides returns empty overrides when path unset', () => {
  const { overrides, error } = loadModelOverrides({});
  assert.deepEqual(overrides, {});
  assert.equal(error, undefined);
});

test('loadModelOverrides reports error for malformed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-overrides-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{ not json');

  try {
    const { overrides, error } = loadModelOverrides({ GATEFRAME_MODEL_OVERRIDES_PATH: file });
    assert.deepEqual(overrides, {});
    assert.ok(error, 'should return an error for malformed JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerGateframeProvider applies overrides file to discovered models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-overrides-'));
  const file = join(dir, 'overrides.json');
  writeFileSync(file, JSON.stringify({
    'gateframe/opus-4.7': { contextWindow: 200000, maxTokens: 16384, reasoning: true },
  }));

  const providerCalls = [];
  try {
    await registerGateframeProvider({
      pi: { registerProvider: (name, config) => providerCalls.push({ name, config }) },
      env: {
        GATEFRAME_API_KEY: 'gf_test',
        GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
        GATEFRAME_MODEL_OVERRIDES_PATH: file,
      },
      notify: () => {},
      fetchImpl: async () => new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'gateframe/opus-4.7', object: 'model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const opus = providerCalls[0].config.models.find(m => m.id === 'gateframe/opus-4.7');
  assert.ok(opus, 'should register opus model');
  assert.equal(opus.contextWindow, 200000);
  assert.equal(opus.maxTokens, 16384);
  assert.equal(opus.reasoning, true);
});

test('registerGateframeProvider warns when malformed overrides file is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-overrides-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, 'not-json');

  const notices = [];
  try {
    await registerGateframeProvider({
      pi: { registerProvider: () => {} },
      env: {
        GATEFRAME_API_KEY: 'gf_test',
        GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
        GATEFRAME_MODEL_OVERRIDES_PATH: file,
      },
      notify: (...args) => notices.push(args),
      fetchImpl: async () => new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'gateframe/opus-4.7', object: 'model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(
    notices.some(([msg, level]) => /overrides/i.test(msg) && level === 'warning'),
    'should notify a warning about bad overrides file',
  );
});

test('fallback models include all known gateframe ids', () => {
  const ids = getFallbackModels().map(model => model.id);
  for (const expected of [
    'gateframe/opus-4.7',
    'gateframe/qwen-3.6',
    'gateframe/minimax-2.7',
    'gateframe/chatgpt-5.4',
    'gateframe/glm-5.1',
  ]) {
    assert.ok(ids.includes(expected), `fallback should include ${expected}`);
  }
});

test('discoverModels returns mapped models from /v1/models', async () => {
  const models = await discoverModels({
    baseUrl: 'http://node1.gateframe.ai:3000',
    apiKey: 'gf_test',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://node1.gateframe.ai:3000/v1/models');
      assert.equal(getHeader(init, 'Authorization'), 'Bearer gf_test');
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gateframe/minimax-2.7', object: 'model' },
          { id: 'gateframe/other', object: 'model' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(models.map(model => model.id), ['gateframe/minimax-2.7', 'gateframe/other']);
});

test('discoverModels ignores malformed model entries', async () => {
  const models = await discoverModels({
    baseUrl: 'http://node1.gateframe.ai:3000',
    apiKey: 'gf_test',
    fetchImpl: async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gateframe/minimax-2.7', object: 'model' },
        { object: 'model' },
        null,
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  assert.deepEqual(models.map(model => model.id), ['gateframe/minimax-2.7']);
});

test('registerGateframeProvider skips registration without api key', async () => {
  const providerCalls = [];
  const notices = [];

  await registerGateframeProvider({
    pi: { registerProvider: (...args) => providerCalls.push(args) },
    env: {},
    notify: (...args) => notices.push(args),
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(providerCalls.length, 0);
  assert.equal(notices.length, 1);
});

test('registerGateframeProvider falls back when discovery fails', async () => {
  const providerCalls = [];
  const notices = [];

  await registerGateframeProvider({
    pi: { registerProvider: (name, config) => providerCalls.push({ name, config }) },
    env: {
      GATEFRAME_API_KEY: 'gf_test',
      GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000/v1',
    },
    notify: (...args) => notices.push(args),
    fetchImpl: async () => {
      throw new Error('boom');
    },
  });

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].name, 'gateframe');
  assert.equal(providerCalls[0].config.baseUrl, 'http://node1.gateframe.ai:3000/v1');
  assert.ok(
    providerCalls[0].config.models.some(m => m.id === 'gateframe/minimax-2.7'),
    'fallback models should include gateframe/minimax-2.7',
  );
  assert.equal(notices.length, 1);
  assert.equal(providerCalls[0].config.authHeader, undefined, 'should not set redundant authHeader with openai-completions');
  assert.equal(providerCalls[0].config.api, 'openai-completions');
});

test('registerGateframeProvider keeps previously discovered models when refresh fails', async () => {
  const providerCalls = [];
  const notices = [];
  let call = 0;

  const run = async (fetchImpl) => registerGateframeProvider({
    pi: { registerProvider: (name, config) => providerCalls.push({ name, config }) },
    env: {
      GATEFRAME_API_KEY: 'gf_test',
      GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
    },
    notify: (...args) => notices.push(args),
    fetchImpl,
  });

  // First call: discovery succeeds, registers two models.
  await run(async () => new Response(JSON.stringify({
    object: 'list',
    data: [
      { id: 'gateframe/opus-4.7', object: 'model' },
      { id: 'gateframe/qwen-3.6', object: 'model' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  // Second call: discovery fails. Extension must NOT shrink picker to fallback.
  await run(async () => { call++; throw new Error('transient'); });

  assert.equal(providerCalls.length, 2);
  const firstIds = providerCalls[0].config.models.map(m => m.id);
  const secondIds = providerCalls[1].config.models.map(m => m.id);
  assert.deepEqual(
    secondIds,
    firstIds,
    'second registration after failed refresh should reuse previously discovered models',
  );
  assert.ok(notices.some(([msg]) => /discovery failed/i.test(msg)));
});

test('discoverModels aborts when fetch exceeds timeout', async () => {
  const notices = [];
  const providerCalls = [];
  let fetchAborted = false;

  await registerGateframeProvider({
    pi: { registerProvider: (name, config) => providerCalls.push({ name, config }) },
    env: {
      GATEFRAME_API_KEY: 'gf_test',
      GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
    },
    notify: (...args) => notices.push(args),
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        fetchAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    }),
    discoveryTimeoutMs: 10,
  });

  assert.equal(fetchAborted, true, 'fetch should have been aborted by the timeout');
  assert.equal(providerCalls.length, 1, 'provider should still register with fallback models');
  assert.ok(
    providerCalls[0].config.models.some(m => m.id === 'gateframe/minimax-2.7'),
    'fallback models should include gateframe/minimax-2.7',
  );
  assert.ok(notices.some(([msg]) => /discovery failed/i.test(msg)), 'should notify about discovery failure');
});

test('defaultGateframeConfig returns normalized env configuration', () => {
  const config = defaultGateframeConfig({
    GATEFRAME_API_KEY: 'gf_test',
    GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000/v1',
  });

  assert.deepEqual(config, {
    apiKey: 'gf_test',
    baseUrl: 'http://node1.gateframe.ai:3000/v1',
  });
});

test('defaultGateframeConfig returns undefined baseUrl when env var is missing', () => {
  const config = defaultGateframeConfig({ GATEFRAME_API_KEY: 'gf_test' });
  assert.equal(config.apiKey, 'gf_test');
  assert.equal(config.baseUrl, undefined, 'no default baseUrl — must be explicit');
});

test('loadEnvFile parses simple KEY=VALUE lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-env-'));
  const file = join(dir, 'conf.env');
  writeFileSync(file, [
    '# a comment',
    '',
    'GATEFRAME_API_KEY=gf_abc',
    'export GATEFRAME_BASE_URL=https://node2.gateframe.ai',
    "QUOTED='single quoted value'",
    'DOUBLE="double quoted value"',
    'WITH_EQUALS=foo=bar=baz',
  ].join('\n'));

  try {
    const { values, error } = loadEnvFile(file);
    assert.equal(error, undefined);
    assert.equal(values.GATEFRAME_API_KEY, 'gf_abc');
    assert.equal(values.GATEFRAME_BASE_URL, 'https://node2.gateframe.ai');
    assert.equal(values.QUOTED, 'single quoted value');
    assert.equal(values.DOUBLE, 'double quoted value');
    assert.equal(values.WITH_EQUALS, 'foo=bar=baz');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEnvFile returns empty values when file does not exist', () => {
  const { values, error } = loadEnvFile('/tmp/gf-does-not-exist-12345.env');
  assert.deepEqual(values, {});
  assert.equal(error, undefined, 'missing file is not an error, just empty');
});

test('loadEnvFile reports error for unreadable file (directory)', () => {
  // Passing a directory will cause readFileSync to throw EISDIR; that is a real error.
  const dir = mkdtempSync(join(tmpdir(), 'gf-env-'));
  try {
    const { values, error } = loadEnvFile(dir);
    assert.deepEqual(values, {});
    assert.ok(error, 'should report an error when path is not a readable file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyEnvFileToProcess does not overwrite already-set vars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-env-'));
  const file = join(dir, 'conf.env');
  writeFileSync(file, 'GATEFRAME_API_KEY=from_file\nGATEFRAME_BASE_URL=https://from-file');

  const env = { GATEFRAME_API_KEY: 'from_shell' };
  try {
    const { applied, skipped } = applyEnvFileToProcess(file, env);
    assert.equal(env.GATEFRAME_API_KEY, 'from_shell', 'shell value must win');
    assert.equal(env.GATEFRAME_BASE_URL, 'https://from-file', 'unset value must be filled from file');
    assert.deepEqual(applied, ['GATEFRAME_BASE_URL']);
    assert.deepEqual(skipped, ['GATEFRAME_API_KEY']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default extension loads env file before registering provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-env-'));
  const file = join(dir, 'conf.env');
  writeFileSync(file, [
    'GATEFRAME_API_KEY=from_file',
    'GATEFRAME_BASE_URL=http://fromfile.test',
  ].join('\n'));

  const providerCalls = [];
  const eventHandlers = {};
  const fakePi = {
    on: (event, handler) => { eventHandlers[event] = handler; },
    registerCommand: () => {},
    registerProvider: (name, config) => providerCalls.push({ name, config }),
  };

  extension(fakePi);

  const originalEnv = process.env;
  process.env = { ...originalEnv, GATEFRAME_ENV_FILE: file };
  delete process.env.GATEFRAME_API_KEY;
  delete process.env.GATEFRAME_BASE_URL;

  try {
    // Use a fetch stub via module-wide override is not available; session_start
    // will attempt a real fetch. To avoid that, point the file at a URL that
    // will trigger the fallback branch instead. The key assertion is simply
    // that the provider is registered at all — which proves env-file loading
    // succeeded, because without it both required env vars would be missing
    // and the provider would be skipped.
    await eventHandlers.session_start({}, { ui: { notify() {} } });
  } finally {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(providerCalls.length, 2, 'provider should be registered during load and after session_start');
  assert.equal(providerCalls[0].name, 'gateframe');
});

test('default extension registers fallback gateframe models during extension load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf-env-'));
  const file = join(dir, 'conf.env');
  writeFileSync(file, [
    'GATEFRAME_API_KEY=from_file',
    'GATEFRAME_BASE_URL=http://fromfile.test',
  ].join('\n'));

  const providerCalls = [];
  const fakePi = {
    on: () => {},
    registerCommand: () => {},
    registerProvider: (name, config) => providerCalls.push({ name, config }),
  };

  const originalEnv = process.env;
  process.env = { ...originalEnv, GATEFRAME_ENV_FILE: file };
  delete process.env.GATEFRAME_API_KEY;
  delete process.env.GATEFRAME_BASE_URL;

  try {
    extension(fakePi);
  } finally {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].name, 'gateframe');
  assert.equal(providerCalls[0].config.baseUrl, 'http://fromfile.test/v1');
  assert.ok(
    providerCalls[0].config.models.some(m => m.id === 'gateframe/chatgpt-5.4'),
    'initial fallback registration should include gateframe/chatgpt-5.4',
  );
});

test('default extension registers the gateframe provider on session start', async () => {
  const providerCalls = [];
  const eventHandlers = {};
  const commands = {};
  const fakePi = {
    on(event, handler) {
      eventHandlers[event] = handler;
    },
    registerCommand(name, config) {
      commands[name] = config;
    },
    registerProvider(name, config) {
      providerCalls.push({ name, config });
    },
  };

  extension(fakePi);

  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    GATEFRAME_API_KEY: 'gf_test',
    GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
  };

  try {
    await eventHandlers.session_start({}, {
      ui: { notify() {} },
    });
  } finally {
    process.env = originalEnv;
  }

  assert.equal(typeof commands['gateframe-refresh']?.handler, 'function');
  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[0].name, 'gateframe');
  assert.equal(providerCalls[1].name, 'gateframe');
});

test('gateframe-refresh command re-registers provider and notifies user', async () => {
  const providerCalls = [];
  const eventHandlers = {};
  const commands = {};
  const notifications = [];
  const fakePi = {
    on(event, handler) {
      eventHandlers[event] = handler;
    },
    registerCommand(name, config) {
      commands[name] = config;
    },
    registerProvider(name, config) {
      providerCalls.push({ name, config });
    },
  };

  extension(fakePi);

  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    GATEFRAME_API_KEY: 'gf_test',
    GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
  };

  try {
    await commands['gateframe-refresh'].handler('', {
      ui: { notify: (...args) => notifications.push(args) },
    });
  } finally {
    process.env = originalEnv;
  }

  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[0].name, 'gateframe');
  assert.equal(providerCalls[1].name, 'gateframe');
  assert.equal(notifications.at(-1)?.[0], 'Gateframe models refreshed.');
});

test('package metadata exposes a root pi package', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'gateframe-pi-integration');
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi, { extensions: ['./extensions'] });
  assert.equal(pkg.peerDependencies['@mariozechner/pi-coding-agent'], '*');
});

test('installable extension entrypoint exists at extensions/gateframe-provider.ts', async () => {
  await access(new URL('../extensions/gateframe-provider.ts', import.meta.url));
});

test('documentation covers required Gateframe setup', async () => {
  const [envExample, readme] = await Promise.all([
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);

  assert.match(envExample, /GATEFRAME_API_KEY=/);
  assert.match(envExample, /GATEFRAME_BASE_URL=/);
  assert.match(envExample, /GATEFRAME_MODEL_OVERRIDES_PATH/);
  assert.match(readme, /pi install git:/);
  assert.match(readme, /pi install \$\(pwd\)/);
  assert.match(readme, /pi install \/absolute\/path\/to\/package/);
  assert.match(readme, /\/model/);
  assert.match(readme, /\/gateframe-refresh/);
  assert.match(readme, /GATEFRAME_MODEL_OVERRIDES_PATH/);
  assert.match(readme, /Node\.js \*\*22\.6\+\*\*/);
  assert.match(readme, /~\/\.config\/gateframe\/conf\.env/);
});

// ---------------------------------------------------------------------------
// Per-model API routing
// ---------------------------------------------------------------------------

test('mapGateframeModel leaves api undefined for gateframe/chatgpt-5.4 by default', () => {
  const model = mapGateframeModel({ id: 'gateframe/chatgpt-5.4' });
  assert.equal(model.api, undefined,
    'chatgpt-5.4 must inherit provider-level openai-completions because Gateframe returns 404 for /v1/responses');
  assert.equal(model.compat.supportsReasoningEffort, false,
    'chatgpt-5.4 must omit reasoning_effort on /v1/chat/completions');
});

test('mapGateframeModel allows overriding developer role support for gateframe/chatgpt-5.4', () => {
  const model = mapGateframeModel(
    { id: 'gateframe/chatgpt-5.4' },
    { 'gateframe/chatgpt-5.4': { compat: { supportsDeveloperRole: false } } },
  );

  assert.equal(model.compat.supportsDeveloperRole, false,
    'operators can force pi to send the system prompt as role: system instead of developer');
  assert.equal(model.compat.supportsReasoningEffort, false,
    'role override must preserve built-in Gateframe compatibility defaults');
});

test('mapGateframeModel leaves api undefined for completions-compatible models', () => {
  for (const id of ['gateframe/opus-4.7', 'gateframe/qwen-3.6', 'gateframe/minimax-2.7', 'gateframe/glm-5.1']) {
    const model = mapGateframeModel({ id });
    assert.equal(model.api, undefined, `${id} should not have a per-model api override`);
  }
});

test('mapGateframeModel respects runtime api override in overrides file', () => {
  // Operator can force any model to use /v1/responses via the overrides file.
  const model = mapGateframeModel(
    { id: 'gateframe/minimax-2.7' },
    { 'gateframe/minimax-2.7': { api: 'openai-responses' } },
  );
  assert.equal(model.api, 'openai-responses');
});

test('getResponsesApiModelIds returns known responses-api models', () => {
  const ids = getResponsesApiModelIds();
  assert.ok(!ids.has('gateframe/chatgpt-5.4'), 'chatgpt-5.4 must NOT be in the responses-api set by default');
  assert.ok(!ids.has('gateframe/opus-4.7'), 'opus-4.7 must NOT be in the responses-api set');
  assert.ok(!ids.has('gateframe/minimax-2.7'), 'minimax-2.7 must NOT be in the responses-api set');
});

test('getResponsesApiModelIds includes models with api override in overrides argument', () => {
  const ids = getResponsesApiModelIds({ 'gateframe/minimax-2.7': { api: 'openai-responses' } });
  assert.ok(ids.has('gateframe/minimax-2.7'));
  assert.ok(!ids.has('gateframe/chatgpt-5.4'));
});

test('registerGateframeProvider does not pass per-model api field for gateframe/chatgpt-5.4 by default', async () => {
  const providerCalls = [];
  await registerGateframeProvider({
    pi: { registerProvider: (name, config) => providerCalls.push({ name, config }) },
    env: {
      GATEFRAME_API_KEY: 'gf_test',
      GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gateframe/chatgpt-5.4', object: 'model' },
        { id: 'gateframe/opus-4.7', object: 'model' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });

  assert.equal(providerCalls.length, 1);
  const models = providerCalls[0].config.models;
  const chatgpt = models.find(m => m.id === 'gateframe/chatgpt-5.4');
  const opus = models.find(m => m.id === 'gateframe/opus-4.7');

  assert.equal(chatgpt.api, undefined,
    'chatgpt-5.4 must inherit provider-level openai-completions');
  assert.equal(chatgpt.compat.supportsReasoningEffort, false,
    'chatgpt-5.4 must not send reasoning_effort through chat completions');
  assert.equal(opus.api, undefined,
    'opus-4.7 must not carry a per-model api override (inherits provider default)');

  // Provider-level default is still openai-completions
  assert.equal(providerCalls[0].config.api, 'openai-completions');
});
