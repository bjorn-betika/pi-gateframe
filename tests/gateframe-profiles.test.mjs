import { describe, it, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readProfilesFile,
  writeProfilesFile,
  validateProfileName,
  resolveBaseUrl,
  intersectModels,
  activateProfile,
  deactivateProfile,
  getActiveProfile,
  getCachedModels,
  __resetProfileState,
  startupActivateProfile,
  handleProfileAdd,
  handleProfileRemove,
  handleProfileEdit,
  handleProfileEnable,
  handleProfileDisable,
  handleProfileUse,
  handleProfileList,
  handleModelsList,
  handleInit,
  handleRefresh,
  DEFAULT_BASE_URL,
} from '../.pi/extensions/gateframe-provider/profiles.ts';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gf-profiles-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { __resetProfileState(); });

// ---------------------------------------------------------------------------
// Task 1: Profile file I/O
// ---------------------------------------------------------------------------

describe('readProfilesFile', () => {
  it('returns empty profiles for missing file', () => {
    const result = readProfilesFile(join(dir, 'nope.json'));
    assert.deepEqual(result, { profiles: {} });
  });

  it('reads valid JSON', () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: {
          apiKey: 'gf_abc',
          baseUrl: 'https://router.gateframe.ai',
          models: ['gateframe/opus-4.7'],
          enabled: true,
        },
      },
    }));
    const result = readProfilesFile(file);
    assert.equal(result.profiles.coding.apiKey, 'gf_abc');
    assert.deepEqual(result.profiles.coding.models, ['gateframe/opus-4.7']);
  });

  it('returns error for malformed JSON', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{not valid');
    const result = readProfilesFile(file);
    assert.ok(result.error, 'should have error');
    assert.deepEqual(result.profiles, {});
  });
});

describe('writeProfilesFile', () => {
  it('writes JSON atomically', () => {
    const file = join(dir, 'profiles.json');
    const data = { profiles: { test: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: true } } };
    writeProfilesFile(file, data);
    const back = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(back.profiles.test.apiKey, 'gf_x');
  });

  it('creates parent directories', () => {
    const file = join(dir, 'sub', 'deep', 'profiles.json');
    const data = { profiles: {} };
    writeProfilesFile(file, data);
    const back = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(back.profiles, {});
  });
});

describe('validateProfileName', () => {
  it('accepts alphanumeric with dashes and underscores', () => {
    assert.equal(validateProfileName('coding'), undefined);
    assert.equal(validateProfileName('my-profile_1'), undefined);
  });

  it('rejects invalid names', () => {
    assert.ok(validateProfileName(''));
    assert.ok(validateProfileName('has space'));
    assert.ok(validateProfileName('special!'));
    assert.ok(validateProfileName('../escape'));
  });
});

// ---------------------------------------------------------------------------
// Task 3: Profile resolution and model intersection
// ---------------------------------------------------------------------------

describe('resolveBaseUrl', () => {
  it('uses profile baseUrl when present', () => {
    const result = resolveBaseUrl(
      { apiKey: 'x', models: [], enabled: true, baseUrl: 'https://custom.gateframe.ai' },
      {},
    );
    assert.equal(result, 'https://custom.gateframe.ai/v1');
  });

  it('falls back to GATEFRAME_BASE_URL env var', () => {
    const result = resolveBaseUrl(
      { apiKey: 'x', models: [], enabled: true },
      { GATEFRAME_BASE_URL: 'https://env-host.com' },
    );
    assert.equal(result, 'https://env-host.com/v1');
  });

  it('falls back to DEFAULT_BASE_URL', () => {
    const result = resolveBaseUrl(
      { apiKey: 'x', models: [], enabled: true },
      {},
    );
    assert.equal(result, 'https://router.gateframe.ai/v1');
  });

  it('normalizes trailing /v1', () => {
    const result = resolveBaseUrl(
      { apiKey: 'x', models: [], enabled: true, baseUrl: 'https://host.com/v1' },
      {},
    );
    assert.equal(result, 'https://host.com/v1');
  });
});

describe('intersectModels', () => {
  it('returns models present in both declared and discovered', () => {
    const declared = ['gateframe/opus-4.7', 'gateframe/qwen-3.6', 'gateframe/minimax-2.7'];
    const discovered = ['gateframe/opus-4.7', 'gateframe/minimax-2.7'];
    const result = intersectModels(declared, discovered);
    assert.deepEqual(result.matched, ['gateframe/opus-4.7', 'gateframe/minimax-2.7']);
    assert.deepEqual(result.missing, ['gateframe/qwen-3.6']);
  });

  it('returns empty matched when none overlap', () => {
    const result = intersectModels(['gateframe/opus-4.7'], ['gateframe/minimax-2.7']);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.missing, ['gateframe/opus-4.7']);
  });

  it('returns all matched when declared is subset', () => {
    const result = intersectModels(
      ['gateframe/opus-4.7'],
      ['gateframe/opus-4.7', 'gateframe/qwen-3.6'],
    );
    assert.deepEqual(result.matched, ['gateframe/opus-4.7']);
    assert.deepEqual(result.missing, []);
  });
});

// ---------------------------------------------------------------------------
// Task 5: Profile activation
// ---------------------------------------------------------------------------

describe('activateProfile', () => {
  it('discovers, validates, and registers provider with literal apiKey', async () => {
    const providerCalls = [];
    const notifications = [];
    const mockPi = {
      registerProvider: (name, config) => providerCalls.push({ name, config }),
    };
    const mockFetch = async (url) => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gateframe/opus-4.7', object: 'model' },
          { id: 'gateframe/qwen-3.6', object: 'model' },
        ],
      }),
    });

    const profile = {
      apiKey: 'gf_test_key',
      baseUrl: 'https://router.gateframe.ai',
      models: ['gateframe/opus-4.7', 'gateframe/qwen-3.6'],
      enabled: true,
    };

    await activateProfile({
      name: 'coding',
      profile,
      pi: mockPi,
      env: {},
      notify: (msg, level) => notifications.push([msg, level]),
      fetchImpl: mockFetch,
    });

    assert.equal(getActiveProfile(), 'coding');
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].name, 'gateframe');
    assert.equal(providerCalls[0].config.apiKey, 'gf_test_key');
    assert.equal(providerCalls[0].config.baseUrl, 'https://router.gateframe.ai/v1');
    assert.equal(providerCalls[0].config.api, 'openai-completions');
    const modelIds = providerCalls[0].config.models.map(m => m.id);
    assert.deepEqual(modelIds, ['gateframe/opus-4.7', 'gateframe/qwen-3.6']);
  });

  it('warns about missing models but still registers with valid ones', async () => {
    const providerCalls = [];
    const notifications = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });

    await activateProfile({
      name: 'test',
      profile: {
        apiKey: 'gf_x',
        models: ['gateframe/opus-4.7', 'gateframe/missing-model'],
        enabled: true,
      },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: (msg, level) => notifications.push([msg, level]),
      fetchImpl: mockFetch,
    });

    assert.equal(providerCalls.length, 1);
    assert.ok(notifications.some(([msg]) => /missing-model/i.test(msg)));
  });

  it('does not register when no models are accessible', async () => {
    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/other', object: 'model' }] }),
    });

    await activateProfile({
      name: 'test',
      profile: {
        apiKey: 'gf_x',
        models: ['gateframe/opus-4.7'],
        enabled: true,
      },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(providerCalls.length, 0);
  });

  it('does not register on discovery auth failure', async () => {
    const providerCalls = [];
    const mockFetch = async () => ({ ok: false, status: 401 });

    await activateProfile({
      name: 'test',
      profile: { apiKey: 'gf_bad', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(providerCalls.length, 0);
  });

  it('rejects disabled profiles', async () => {
    const providerCalls = [];
    await activateProfile({
      name: 'test',
      profile: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: false },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
    });

    assert.equal(providerCalls.length, 0);
  });
});

describe('deactivateProfile', () => {
  it('clears active profile and re-registers with empty models', () => {
    const providerCalls = [];
    const mockPi = {
      registerProvider: (name, config) => providerCalls.push({ name, config }),
    };

    deactivateProfile(mockPi);

    assert.equal(getActiveProfile(), undefined);
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0].config.models, []);
  });
});

// ---------------------------------------------------------------------------
// Task 7: Startup integration
// ---------------------------------------------------------------------------

describe('startupActivateProfile', () => {
  it('falls back to single-key when profiles file is missing', async () => {
    const providerCalls = [];
    const mockFetch = async (url) => {
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'gateframe/minimax-2.7', object: 'model' }] }),
      };
    };

    const result = await startupActivateProfile({
      profilesPath: join(dir, 'nonexistent.json'),
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: { GATEFRAME_API_KEY: 'gf_test', GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000' },
      notify: (msg, level) => {},
      fetchImpl: mockFetch,
    });

    assert.equal(result.mode, 'single-key');
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].config.apiKey, 'GATEFRAME_API_KEY');
  });

  it('activates first enabled profile when profiles exist', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: { apiKey: 'gf_coding', models: ['gateframe/opus-4.7'], enabled: true },
        fast: { apiKey: 'gf_fast', models: ['gateframe/minimax-2.7'], enabled: true },
      },
    }));

    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });

    const result = await startupActivateProfile({
      profilesPath: file,
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(result.mode, 'profile');
    assert.equal(result.activeProfile, 'coding');
    assert.equal(getActiveProfile(), 'coding');
    assert.equal(providerCalls[0].config.apiKey, 'gf_coding');
  });

  it('warns when all profiles are disabled', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        staging: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: false },
      },
    }));

    const providerCalls = [];
    const notifications = [];

    const result = await startupActivateProfile({
      profilesPath: file,
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: (msg, level) => notifications.push([msg, level]),
    });

    assert.equal(result.mode, 'none');
    assert.ok(notifications.some(([msg]) => /all.*profiles.*disabled/i.test(msg)));
    assert.equal(providerCalls.length, 0);
  });

  it('falls through to next profile when first fails discovery', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        broken: { apiKey: 'gf_bad', models: ['gateframe/opus-4.7'], enabled: true },
        working: { apiKey: 'gf_good', models: ['gateframe/minimax-2.7'], enabled: true },
      },
    }));

    const providerCalls = [];
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 401 };
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'gateframe/minimax-2.7', object: 'model' }] }),
      };
    };

    const result = await startupActivateProfile({
      profilesPath: file,
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(result.mode, 'profile');
    assert.equal(result.activeProfile, 'working');
  });
});

// ---------------------------------------------------------------------------
// Task 9: Command handlers
// ---------------------------------------------------------------------------

describe('handleProfileAdd', () => {
  it('adds a new profile to the file and activates it', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({ profiles: {} }));

    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });

    const result = await handleProfileAdd({
      profilesPath: file,
      name: 'coding',
      apiKey: 'gf_new',
      baseUrl: 'https://router.gateframe.ai',
      models: ['gateframe/opus-4.7'],
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(result.success, true);
    const saved = readProfilesFile(file);
    assert.equal(saved.profiles.coding.apiKey, 'gf_new');
    assert.equal(saved.profiles.coding.enabled, true);
    assert.equal(providerCalls.length, 1);
  });

  it('rejects duplicate profile names', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: { coding: { apiKey: 'x', models: [], enabled: true } },
    }));

    const result = await handleProfileAdd({
      profilesPath: file,
      name: 'coding',
      apiKey: 'gf_new',
      models: [],
      pi: { registerProvider: () => {} },
      env: {},
      notify: () => {},
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('already exists'));
  });
});

describe('handleProfileRemove', () => {
  it('removes profile and deactivates if active', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: true },
        fast: { apiKey: 'gf_y', models: ['gateframe/minimax-2.7'], enabled: true },
      },
    }));

    // Activate coding first
    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });
    await activateProfile({
      name: 'coding',
      profile: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });
    assert.equal(getActiveProfile(), 'coding');

    const result = handleProfileRemove({
      profilesPath: file,
      name: 'coding',
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      notify: () => {},
    });

    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), undefined);
    const saved = readProfilesFile(file);
    assert.equal(saved.profiles.coding, undefined);
  });
});

describe('handleProfileEnable / handleProfileDisable', () => {
  it('enable sets enabled to true', () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: { test: { apiKey: 'gf_x', models: [], enabled: false } },
    }));

    const result = handleProfileEnable({ profilesPath: file, name: 'test' });
    assert.equal(result.success, true);
    const saved = readProfilesFile(file);
    assert.equal(saved.profiles.test.enabled, true);
  });

  it('disable sets enabled to false and deactivates if active', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: { test: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: true } },
    }));

    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });
    await activateProfile({
      name: 'test',
      profile: { apiKey: 'gf_x', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    const result = handleProfileDisable({
      profilesPath: file,
      name: 'test',
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      notify: () => {},
    });

    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), undefined);
    const saved = readProfilesFile(file);
    assert.equal(saved.profiles.test.enabled, false);
  });
});

describe('handleProfileUse', () => {
  it('switches to a named profile', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
        fast: { apiKey: 'gf_f', models: ['gateframe/minimax-2.7'], enabled: true },
      },
    }));

    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });
    await activateProfile({
      name: 'coding',
      profile: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    const mockFetch2 = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/minimax-2.7', object: 'model' }] }),
    });

    const result = await handleProfileUse({
      profilesPath: file,
      name: 'fast',
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch2,
    });

    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), 'fast');
  });
});

describe('handleInit', () => {
  it('creates profiles.json from env vars with discovered models', async () => {
    const file = join(dir, 'profiles.json');
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gateframe/opus-4.7', object: 'model' },
          { id: 'gateframe/minimax-2.7', object: 'model' },
        ],
      }),
    });

    const result = await handleInit({
      profilesPath: file,
      env: { GATEFRAME_API_KEY: 'gf_test', GATEFRAME_BASE_URL: 'https://router.gateframe.ai' },
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(result.success, true);
    const saved = readProfilesFile(file);
    assert.equal(saved.profiles.default.apiKey, 'gf_test');
    assert.deepEqual(saved.profiles.default.models, ['gateframe/opus-4.7', 'gateframe/minimax-2.7']);
  });

  it('refuses to overwrite existing file', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({ profiles: { existing: {} } }));

    const result = await handleInit({
      profilesPath: file,
      env: { GATEFRAME_API_KEY: 'gf_test' },
      notify: () => {},
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('already exists'));
  });
});

describe('handleRefresh', () => {
  it('re-reads file and re-validates active profile', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
      },
    }));

    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });

    // Activate first
    await activateProfile({
      name: 'coding',
      profile: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    // Now refresh
    const result = await handleRefresh({
      profilesPath: file,
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), 'coding');
  });

  it('deactivates if active profile was removed from file', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
      },
    }));

    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });

    await activateProfile({
      name: 'coding',
      profile: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    // Simulate another instance removing the profile
    writeFileSync(file, JSON.stringify({ profiles: {} }));

    const result = await handleRefresh({
      profilesPath: file,
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
    });

    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), undefined);
  });
});

describe('handleProfileList', () => {
  it('returns list of profiles with status', () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({
      profiles: {
        coding: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
        staging: { apiKey: 'gf_s', models: [], enabled: false },
      },
    }));

    const result = handleProfileList({ profilesPath: file });
    assert.equal(result.profiles.length, 2);
    assert.equal(result.profiles[0].name, 'coding');
    assert.equal(result.profiles[0].enabled, true);
    assert.equal(result.profiles[1].name, 'staging');
    assert.equal(result.profiles[1].enabled, false);
  });
});

describe('handleModelsList', () => {
  it('returns cached models for active profile', async () => {
    const providerCalls = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gateframe/opus-4.7', object: 'model' }] }),
    });

    await activateProfile({
      name: 'coding',
      profile: { apiKey: 'gf_c', models: ['gateframe/opus-4.7'], enabled: true },
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: {},
      notify: () => {},
      fetchImpl: mockFetch,
    });

    const result = handleModelsList();
    assert.equal(result.activeProfile, 'coding');
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].id, 'gateframe/opus-4.7');
  });
});

// ---------------------------------------------------------------------------
// Task 14: End-to-end smoke test
// ---------------------------------------------------------------------------

describe('end-to-end profile workflow', () => {
  it('add → use → disable → remove workflow', async () => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({ profiles: {} }));

    const providerCalls = [];
    const pi = { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) };
    const mockFetch = (ids) => async () => ({
      ok: true,
      json: async () => ({ data: ids.map((id) => ({ id, object: 'model' })) }),
    });

    // Add profile
    let result = await handleProfileAdd({
      profilesPath: file, name: 'coding',
      apiKey: 'gf_c', models: ['gateframe/opus-4.7'],
      pi, env: {}, notify: () => {}, fetchImpl: mockFetch(['gateframe/opus-4.7']),
    });
    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), 'coding');

    // Add second profile
    result = await handleProfileAdd({
      profilesPath: file, name: 'fast',
      apiKey: 'gf_f', models: ['gateframe/minimax-2.7'],
      pi, env: {}, notify: () => {}, fetchImpl: mockFetch(['gateframe/minimax-2.7']),
    });
    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), 'fast');

    // Switch back to coding
    result = await handleProfileUse({
      profilesPath: file, name: 'coding',
      pi, env: {}, notify: () => {}, fetchImpl: mockFetch(['gateframe/opus-4.7']),
    });
    assert.equal(result.success, true);
    assert.equal(getActiveProfile(), 'coding');

    // Disable active profile
    const disableResult = handleProfileDisable({
      profilesPath: file, name: 'coding', pi, notify: () => {},
    });
    assert.equal(disableResult.success, true);
    assert.equal(getActiveProfile(), undefined);

    // Remove it
    const removeResult = handleProfileRemove({
      profilesPath: file, name: 'coding', pi, notify: () => {},
    });
    assert.equal(removeResult.success, true);

    // Only fast remains
    const saved = readProfilesFile(file);
    assert.deepEqual(Object.keys(saved.profiles), ['fast']);
  });
});
