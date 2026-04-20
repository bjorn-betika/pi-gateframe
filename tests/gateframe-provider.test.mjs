import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import extension, {
  normalizeBaseUrl,
  mapGateframeModel,
  getFallbackModels,
  discoverModels,
  registerGateframeProvider,
  defaultGateframeConfig,
} from '../.pi/extensions/gateframe-provider/index.ts';

test('normalizeBaseUrl preserves trailing /v1', () => {
  assert.equal(normalizeBaseUrl('http://node1.gateframe.ai:3000/v1'), 'http://node1.gateframe.ai:3000/v1');
});

test('normalizeBaseUrl appends /v1 when missing', () => {
  assert.equal(normalizeBaseUrl('http://node1.gateframe.ai:3000'), 'http://node1.gateframe.ai:3000/v1');
});

test('mapGateframeModel maps OpenAI model id to pi model definition', () => {
  const model = mapGateframeModel({ id: 'gateframe/minimax-2.7', object: 'model' });
  assert.equal(model.id, 'gateframe/minimax-2.7');
  assert.equal(model.reasoning, false);
});

test('fallback models include gateframe/minimax-2.7', () => {
  const ids = getFallbackModels().map(model => model.id);
  assert.ok(ids.includes('gateframe/minimax-2.7'));
});

test('discoverModels returns mapped models from /v1/models', async () => {
  const models = await discoverModels({
    baseUrl: 'http://node1.gateframe.ai:3000',
    apiKey: 'gf_test',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://node1.gateframe.ai:3000/v1/models');
      assert.equal(init.headers.Authorization, 'Bearer gf_test');
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
  assert.deepEqual(providerCalls[0].config.models.map(model => model.id), ['gateframe/minimax-2.7']);
  assert.equal(notices.length, 1);
  assert.equal(providerCalls[0].config.authHeader, undefined, 'should not set redundant authHeader with openai-completions');
  assert.equal(providerCalls[0].config.api, 'openai-completions');
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
  assert.deepEqual(providerCalls[0].config.models.map(m => m.id), ['gateframe/minimax-2.7']);
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
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].name, 'gateframe');
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

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].name, 'gateframe');
  assert.equal(notifications.at(-1)?.[0], 'Gateframe models refreshed.');
});

test('documentation covers required Gateframe setup', async () => {
  const [envExample, readme] = await Promise.all([
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);

  assert.match(envExample, /GATEFRAME_API_KEY=/);
  assert.match(envExample, /GATEFRAME_BASE_URL=/);
  assert.match(readme, /\.pi\/extensions\/gateframe-provider/);
  assert.match(readme, /\/model/);
});
