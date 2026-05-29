# Gateframe Multi-Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Gateframe pi extension to support multiple named profiles, each bundling an API key, base URL, and validated model list, with commands to add/remove/edit/enable/disable/switch profiles.

**Architecture:** Add a `profiles.ts` module for profile file I/O and activation logic. The existing `index.ts` delegates to profiles on startup and registers new slash commands. Profile state is in-memory per instance; config is shared via `~/.config/gateframe/profiles.json`.

**Tech Stack:** TypeScript, pi extensions API (`registerCommand`, `registerProvider`, `ctx.ui.select/input/confirm/notify`), Node.js built-ins (`fs`, `path`, `os`, `fetch`).

**Spec:** `docs/superpowers/specs/2026-05-28-gateframe-multi-profile-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `.pi/extensions/gateframe-provider/profiles.ts` | Profile types, file read/write, validation, activation/deactivation |
| Modify | `.pi/extensions/gateframe-provider/index.ts` | Wire profile startup, register new commands, update refresh |
| Create | `tests/gateframe-profiles.test.mjs` | Unit + integration tests for profile management |
| Modify | `tests/gateframe-provider.test.mjs` | Update existing tests for modified signatures |
| Modify | `README.md` | Profile documentation |
| Modify | `.env.example` | Profile-related env notes |

---

## Task 1: Profile file I/O — tests first

**Files:**
- Create: `tests/gateframe-profiles.test.mjs`

- [ ] **Step 1: Write failing tests for profile file read/write/validate**

```js
// tests/gateframe-profiles.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readProfilesFile,
  writeProfilesFile,
  validateProfileName,
  DEFAULT_BASE_URL,
} from '../.pi/extensions/gateframe-provider/profiles.ts';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gf-profiles-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: FAIL — module `profiles.ts` does not exist yet.

- [ ] **Step 3: Commit**

```bash
git add tests/gateframe-profiles.test.mjs
git commit -m "test: add failing profile file I/O tests"
```

---

## Task 2: Profile file I/O — implementation

**Files:**
- Create: `.pi/extensions/gateframe-provider/profiles.ts`

- [ ] **Step 1: Implement profile types and file I/O**

```ts
// .pi/extensions/gateframe-provider/profiles.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_BASE_URL = "https://router.gateframe.ai";
export const DEFAULT_PROFILES_PATH = "~/.config/gateframe/profiles.json";

export interface ProfileEntry {
  apiKey: string;
  baseUrl?: string;
  models: string[];
  enabled: boolean;
}

export interface ProfilesFile {
  profiles: Record<string, ProfileEntry>;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Validates a profile name. Returns undefined if valid, or an error string if invalid.
 * Valid names: [a-zA-Z0-9_-]+, non-empty.
 */
export function validateProfileName(name: string): string | undefined {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return `Invalid profile name "${name}". Use only letters, numbers, dashes, and underscores.`;
  }
  return undefined;
}

/**
 * Reads and parses the profiles JSON file.
 * Returns `{ profiles: {} }` for a missing file.
 * Returns `{ profiles: {}, error: "..." }` for malformed JSON.
 */
export function readProfilesFile(path: string): ProfilesFile & { error?: string } {
  const resolved = expandHome(path);
  if (!existsSync(resolved)) {
    return { profiles: {} };
  }
  try {
    const raw = readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.profiles || typeof parsed.profiles !== "object") {
      return { profiles: {}, error: `Profiles file is not a valid object: ${resolved}` };
    }
    return { profiles: parsed.profiles as Record<string, ProfileEntry> };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { profiles: {}, error: `Failed to read profiles file ${resolved}: ${detail}` };
  }
}

/**
 * Writes the profiles data atomically: write to a temp file in the same
 * directory, then rename. Creates parent directories if needed.
 * Throws if the target file exists and contains malformed JSON (safety check
 * to avoid overwriting valid data with a fresh file that drops existing profiles).
 */
export function writeProfilesFile(path: string, data: ProfilesFile): void {
  const resolved = expandHome(path);

  // Safety: if file exists, verify it's valid JSON before overwriting
  if (existsSync(resolved)) {
    try {
      const raw = readFileSync(resolved, "utf8");
      JSON.parse(raw);
    } catch {
      throw new Error(
        `Refusing to overwrite malformed profiles file at ${resolved}. ` +
        `Please repair or delete it first.`,
      );
    }
  }

  const dir = dirname(resolved);
  mkdirSync(dir, { recursive: true });

  const tmpPath = resolved + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmpPath, resolved);
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add .pi/extensions/gateframe-provider/profiles.ts tests/gateframe-profiles.test.mjs
git commit -m "feat: add profile file I/O with atomic writes and validation"
```

---

## Task 3: Profile resolution and model intersection — tests first

**Files:**
- Modify: `tests/gateframe-profiles.test.mjs`

- [ ] **Step 1: Write failing tests for resolveBaseUrl and intersectModels**

```js
// Add to tests/gateframe-profiles.test.mjs
import {
  resolveBaseUrl,
  intersectModels,
} from '../.pi/extensions/gateframe-provider/profiles.ts';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: FAIL — `resolveBaseUrl` and `intersectModels` not exported.

- [ ] **Step 3: Commit**

```bash
git add tests/gateframe-profiles.test.mjs
git commit -m "test: add failing profile resolution and model intersection tests"
```

---

## Task 4: Profile resolution and model intersection — implementation

**Files:**
- Modify: `.pi/extensions/gateframe-provider/profiles.ts`

- [ ] **Step 1: Implement resolveBaseUrl and intersectModels**

Add these to `profiles.ts`:

```ts
import { normalizeBaseUrl, KNOWN_MODEL_DEFAULTS } from "./index.ts";

/**
 * Resolves the base URL for a profile with fallback:
 * profile baseUrl → GATEFRAME_BASE_URL env → DEFAULT_BASE_URL.
 * Result is normalized (includes /v1).
 */
export function resolveBaseUrl(
  profile: ProfileEntry,
  env: Record<string, string | undefined>,
): string {
  const raw = profile.baseUrl ?? env.GATEFRAME_BASE_URL ?? DEFAULT_BASE_URL;
  return normalizeBaseUrl(raw);
}

/**
 * Intersects declared model IDs against discovered model IDs.
 * Returns matched (in both) and missing (declared but not discovered).
 * Preserves declared order.
 */
export function intersectModels(
  declared: string[],
  discoveredIds: string[],
): { matched: string[]; missing: string[] } {
  const discoveredSet = new Set(discoveredIds);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const id of declared) {
    if (discoveredSet.has(id)) {
      matched.push(id);
    } else {
      missing.push(id);
    }
  }
  return { matched, missing };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add .pi/extensions/gateframe-provider/profiles.ts tests/gateframe-profiles.test.mjs
git commit -m "feat: add profile URL resolution and model intersection"
```

---

## Task 5: Profile activation — tests first

**Files:**
- Modify: `tests/gateframe-profiles.test.mjs`

- [ ] **Step 1: Write failing tests for activateProfile and deactivateProfile**

```js
// Add to tests/gateframe-profiles.test.mjs
import {
  activateProfile,
  deactivateProfile,
  getActiveProfile,
  getCachedModels,
  __resetProfileState,
} from '../.pi/extensions/gateframe-provider/profiles.ts';

beforeEach(() => { __resetProfileState(); });

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: FAIL — `activateProfile`/`deactivateProfile` not exported.

- [ ] **Step 3: Commit**

```bash
git add tests/gateframe-profiles.test.mjs
git commit -m "test: add failing profile activation/deactivation tests"
```

---

## Task 6: Profile activation — implementation

**Files:**
- Modify: `.pi/extensions/gateframe-provider/profiles.ts`

- [ ] **Step 1: Implement activation state and activateProfile**

Add to `profiles.ts`:

```ts
import { mapGateframeModel, type ModelOverrides } from "./index.ts";

// Per-instance in-memory state
let activeProfile: string | undefined;
const cachedModels = new Map<string, ReturnType<typeof mapGateframeModel>[]>();

export function getActiveProfile(): string | undefined {
  return activeProfile;
}

export function getCachedModels(): Map<string, ReturnType<typeof mapGateframeModel>[]> {
  return cachedModels;
}

/** Test-only: reset all in-memory profile state. */
export function __resetProfileState(): void {
  activeProfile = undefined;
  cachedModels.clear();
}

export async function activateProfile({
  name,
  profile,
  pi,
  env,
  notify = () => {},
  fetchImpl = fetch,
  discoveryTimeoutMs = 10_000,
  overrides = {},
}: {
  name: string;
  profile: ProfileEntry;
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
  overrides?: ModelOverrides;
}): Promise<boolean> {
  if (!profile.enabled) {
    notify(`Profile "${name}" is disabled.`, "warning");
    return false;
  }

  const baseUrl = resolveBaseUrl(profile, env);

  // Discover models
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), discoveryTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notify(`Could not reach Gateframe at ${baseUrl}: ${detail}`, "warning");
    return false;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    notify(`Authentication failed for profile "${name}" (HTTP ${response.status}).`, "warning");
    return false;
  }

  const payload = (await response.json()) as { data?: unknown[] };
  const discoveredIds: string[] = Array.isArray(payload.data)
    ? payload.data
        .filter((m): m is { id: string } => !!m && typeof m === "object" && typeof (m as any).id === "string")
        .map((m) => m.id)
    : [];

  // Intersect declared models against discovered
  const { matched, missing } = intersectModels(profile.models, discoveredIds);

  if (missing.length > 0) {
    notify(`Models not accessible for profile "${name}": ${missing.join(", ")}`, "warning");
  }

  if (matched.length === 0) {
    notify(`No accessible models for profile "${name}". Provider not registered.`, "warning");
    return false;
  }

  // Map matched models to pi model definitions
  const models = matched.map((id) => mapGateframeModel({ id }, overrides));

  // Register provider with literal apiKey
  pi.registerProvider("gateframe", {
    baseUrl,
    apiKey: profile.apiKey,
    api: "openai-completions",
    models,
  });

  activeProfile = name;
  cachedModels.set(name, models);
  return true;
}

/**
 * Deactivates the current profile: clears in-memory state and re-registers
 * the provider with an empty model list (effectively removing it from /model).
 */
export function deactivateProfile(
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void },
  notify?: (message: string, level?: string) => void,
): void {
  activeProfile = undefined;
  pi.registerProvider("gateframe", {
    baseUrl: DEFAULT_BASE_URL + "/v1",
    apiKey: "",
    api: "openai-completions",
    models: [],
  });
  notify?.("Gateframe provider deactivated.", "info");
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add .pi/extensions/gateframe-provider/profiles.ts tests/gateframe-profiles.test.mjs
git commit -m "feat: add profile activation and deactivation"
```

---

## Task 7: Startup integration — tests first

**Files:**
- Modify: `tests/gateframe-profiles.test.mjs`

- [ ] **Step 1: Write failing test for startup profile selection**

```js
// Add to tests/gateframe-profiles.test.mjs
import { startupActivateProfile } from '../.pi/extensions/gateframe-provider/profiles.ts';

describe('startupActivateProfile', () => {
  it('falls back to single-key when profiles file is missing', async () => {
    const providerCalls = [];
    const notifications = [];
    const mockFetch = async (url) => {
      // Should call /v1/models for single-key discovery
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'gateframe/minimax-2.7', object: 'model' }] }),
      };
    };

    const result = await startupActivateProfile({
      profilesPath: join(dir, 'nonexistent.json'),
      pi: { registerProvider: (n, c) => providerCalls.push({ name: n, config: c }) },
      env: { GATEFRAME_API_KEY: 'gf_test', GATEFRAME_BASE_URL: 'http://node1.gateframe.ai:3000' },
      notify: (msg, level) => notifications.push([msg, level]),
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
    assert.ok(notifications.some(([msg]) => /all profiles.*disabled/i.test(msg)));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: FAIL — `startupActivateProfile` not exported.

- [ ] **Step 3: Commit**

```bash
git add tests/gateframe-profiles.test.mjs
git commit -m "test: add failing startup profile activation tests"
```

---

## Task 8: Startup integration — implementation

**Files:**
- Modify: `.pi/extensions/gateframe-provider/profiles.ts`

- [ ] **Step 1: Implement startupActivateProfile**

Add to `profiles.ts`:

```ts
import {
  registerGateframeProvider,
  getFallbackModels,
} from "./index.ts";

export type StartupResult =
  | { mode: "single-key"; activeProfile: undefined }
  | { mode: "profile"; activeProfile: string }
  | { mode: "none"; activeProfile: undefined };

/**
 * Called on session_start. Determines which profile to activate:
 * 1. No profiles file or empty → fall back to single-key behavior.
 * 2. Has enabled profiles → activate the first enabled one.
 * 3. All profiles disabled → warn, do not register.
 * 4. First profile fails discovery → try next enabled profile.
 */
export async function startupActivateProfile({
  profilesPath,
  pi,
  env,
  notify = () => {},
  fetchImpl = fetch,
  overrides = {},
}: {
  profilesPath: string;
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
  overrides?: ModelOverrides;
}): Promise<StartupResult> {
  const { profiles, error } = readProfilesFile(profilesPath);

  if (error) {
    notify(error, "warning");
  }

  const profileNames = Object.keys(profiles);

  // No profiles file or empty → single-key fallback
  if (profileNames.length === 0) {
    await registerGateframeProvider({ pi, env, notify, fetchImpl });
    const hasKey = !!env.GATEFRAME_API_KEY;
    return { mode: hasKey ? "single-key" : "none", activeProfile: undefined };
  }

  // Find enabled profiles
  const enabled = profileNames.filter((name) => profiles[name].enabled);
  if (enabled.length === 0) {
    notify("All Gateframe profiles are disabled.", "warning");
    return { mode: "none", activeProfile: undefined };
  }

  // Try each enabled profile in order
  for (const name of enabled) {
    const success = await activateProfile({
      name,
      profile: profiles[name],
      pi,
      env,
      notify,
      fetchImpl,
      overrides,
    });
    if (success) {
      return { mode: "profile", activeProfile: name };
    }
  }

  notify("All Gateframe profiles failed to activate.", "warning");
  return { mode: "none", activeProfile: undefined };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add .pi/extensions/gateframe-provider/profiles.ts tests/gateframe-profiles.test.mjs
git commit -m "feat: add startup profile activation with fallback chain"
```

---

## Task 9: Command handlers — tests first

**Files:**
- Modify: `tests/gateframe-profiles.test.mjs`

- [ ] **Step 1: Write failing tests for command handler logic**

Test the pure logic functions (not the pi command wrappers — those are thin):

```js
// Add to tests/gateframe-profiles.test.mjs
import {
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
} from '../.pi/extensions/gateframe-provider/profiles.ts';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: FAIL — command handlers not exported.

- [ ] **Step 3: Commit**

```bash
git add tests/gateframe-profiles.test.mjs
git commit -m "test: add failing command handler tests"
```

---

## Task 10: Command handlers — implementation

**Files:**
- Modify: `.pi/extensions/gateframe-provider/profiles.ts`

- [ ] **Step 1: Implement all command handler functions**

Add to `profiles.ts`:

```ts
/** Result type for command handlers. */
export interface CommandResult {
  success: boolean;
  error?: string;
}

export async function handleProfileAdd({
  profilesPath, name, apiKey, baseUrl, models,
  pi, env, notify, fetchImpl, overrides,
}: {
  profilesPath: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
  overrides?: ModelOverrides;
}): Promise<CommandResult> {
  const nameError = validateProfileName(name);
  if (nameError) return { success: false, error: nameError };

  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };
  if (profiles[name]) return { success: false, error: `Profile "${name}" already exists. Use edit to modify.` };

  profiles[name] = { apiKey, baseUrl, models, enabled: true };
  writeProfilesFile(profilesPath, { profiles });

  await activateProfile({ name, profile: profiles[name], pi, env, notify, fetchImpl, overrides });
  return { success: true };
}

export function handleProfileRemove({
  profilesPath, name, pi, notify,
}: {
  profilesPath: string;
  name: string;
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  notify?: (message: string, level?: string) => void;
}): CommandResult {
  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };
  if (!profiles[name]) return { success: false, error: `Profile "${name}" not found.` };

  const wasActive = activeProfile === name;
  delete profiles[name];
  writeProfilesFile(profilesPath, { profiles });

  if (wasActive) {
    deactivateProfile(pi, notify);
  }
  return { success: true };
}

export async function handleProfileEdit({
  profilesPath, name, apiKey, baseUrl, models,
  pi, env, notify, fetchImpl, overrides,
}: {
  profilesPath: string;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
  overrides?: ModelOverrides;
}): Promise<CommandResult> {
  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };
  if (!profiles[name]) return { success: false, error: `Profile "${name}" not found.` };

  if (apiKey !== undefined) profiles[name].apiKey = apiKey;
  if (baseUrl !== undefined) profiles[name].baseUrl = baseUrl;
  if (models !== undefined) profiles[name].models = models;
  writeProfilesFile(profilesPath, { profiles });

  if (activeProfile === name && profiles[name].enabled) {
    await activateProfile({ name, profile: profiles[name], pi, env, notify, fetchImpl, overrides });
  }
  return { success: true };
}

export function handleProfileEnable({ profilesPath, name }: {
  profilesPath: string;
  name: string;
}): CommandResult {
  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };
  if (!profiles[name]) return { success: false, error: `Profile "${name}" not found.` };

  profiles[name].enabled = true;
  writeProfilesFile(profilesPath, { profiles });
  return { success: true };
}

export function handleProfileDisable({
  profilesPath, name, pi, notify,
}: {
  profilesPath: string;
  name: string;
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  notify?: (message: string, level?: string) => void;
}): CommandResult {
  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };
  if (!profiles[name]) return { success: false, error: `Profile "${name}" not found.` };

  const wasActive = activeProfile === name;
  profiles[name].enabled = false;
  writeProfilesFile(profilesPath, { profiles });

  if (wasActive) {
    deactivateProfile(pi, notify);
  }
  return { success: true };
}

export async function handleProfileUse({
  profilesPath, name, pi, env, notify, fetchImpl, overrides,
}: {
  profilesPath: string;
  name: string;
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
  overrides?: ModelOverrides;
}): Promise<CommandResult> {
  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };
  if (!profiles[name]) return { success: false, error: `Profile "${name}" not found.` };
  if (!profiles[name].enabled) return { success: false, error: `Profile "${name}" is disabled.` };

  const success = await activateProfile({ name, profile: profiles[name], pi, env, notify, fetchImpl, overrides });
  return { success, error: success ? undefined : `Failed to activate profile "${name}".` };
}

export function handleProfileList({ profilesPath }: { profilesPath: string }): {
  profiles: Array<{ name: string; enabled: boolean; modelCount: number; baseUrl?: string }>;
  error?: string;
} {
  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { profiles: [], error };

  return {
    profiles: Object.entries(profiles).map(([name, p]) => ({
      name,
      enabled: p.enabled,
      modelCount: p.models.length,
      baseUrl: p.baseUrl,
    })),
  };
}

export function handleModelsList(): {
  activeProfile: string | undefined;
  models: ReturnType<typeof mapGateframeModel>[];
} {
  if (!activeProfile) return { activeProfile: undefined, models: [] };
  return { activeProfile, models: cachedModels.get(activeProfile) ?? [] };
}

export async function handleInit({
  profilesPath, env, notify, fetchImpl,
}: {
  profilesPath: string;
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CommandResult> {
  const resolved = expandHome(profilesPath);
  if (existsSync(resolved)) {
    return { success: false, error: `Profiles file already exists at ${resolved}. Delete it first or use profile commands.` };
  }

  const apiKey = env.GATEFRAME_API_KEY;
  if (!apiKey) return { success: false, error: "GATEFRAME_API_KEY is not set." };

  const baseUrl = env.GATEFRAME_BASE_URL ?? DEFAULT_BASE_URL;
  const normalizedBase = normalizeBaseUrl(baseUrl);

  // Discover models
  let discoveredIds: string[] = [];
  try {
    const response = await (fetchImpl ?? fetch)(`${normalizedBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: unknown[] };
      discoveredIds = Array.isArray(payload.data)
        ? payload.data
            .filter((m): m is { id: string } => !!m && typeof m === "object" && typeof (m as any).id === "string")
            .map((m) => m.id)
        : [];
    }
  } catch {
    // Fall through to fallback
  }

  // If discovery failed, use fallback model IDs
  const modelIds = discoveredIds.length > 0 ? discoveredIds : Object.keys(KNOWN_MODEL_DEFAULTS);

  const profiles: Record<string, ProfileEntry> = {
    default: { apiKey, baseUrl, models: modelIds, enabled: true },
  };
  writeProfilesFile(profilesPath, { profiles });
  return { success: true };
}

export async function handleRefresh({
  profilesPath, pi, env, notify, fetchImpl, overrides,
}: {
  profilesPath: string;
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
  overrides?: ModelOverrides;
}): Promise<CommandResult> {
  const current = activeProfile;
  if (!current) {
    // No active profile — try startup activation
    const result = await startupActivateProfile({ profilesPath, pi, env, notify, fetchImpl, overrides });
    return { success: result.mode !== "none" || result.mode === "none", error: undefined };
  }

  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };

  if (!profiles[current]) {
    deactivateProfile(pi, notify);
    notify?.(`Active profile "${current}" was removed.`, "warning");
    return { success: true };
  }

  if (!profiles[current].enabled) {
    deactivateProfile(pi, notify);
    notify?.(`Active profile "${current}" was disabled.`, "warning");
    return { success: true };
  }

  const success = await activateProfile({
    name: current,
    profile: profiles[current],
    pi, env, notify, fetchImpl, overrides,
  });
  return { success, error: success ? undefined : `Failed to refresh profile "${current}".` };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/gateframe-profiles.test.mjs`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add .pi/extensions/gateframe-provider/profiles.ts tests/gateframe-profiles.test.mjs
git commit -m "feat: add profile command handlers"
```

---

## Task 11: Wire commands into index.ts

**Files:**
- Modify: `.pi/extensions/gateframe-provider/index.ts`

- [ ] **Step 1: Update session_start to use startupActivateProfile**

Replace the `session_start` handler in `index.ts`:

```ts
import {
  readProfilesFile,
  startupActivateProfile,
  activateProfile,
  deactivateProfile,
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
  getActiveProfile,
  getCachedModels,
  DEFAULT_PROFILES_PATH,
  DEFAULT_BASE_URL,
} from "./profiles.ts";
// Note: remove the local `expandHome` function from index.ts — it is now
// imported from profiles.ts via the barrel export. Delete lines 19-23.

// Inside the default export function, replace session_start handler.
// Note: compute profilesPath via a helper so all handlers get the latest value
// after loadConfEnv() runs. Do not cache it at module scope.
const getProfilesPath = () =>
  process.env.GATEFRAME_PROFILES_PATH || DEFAULT_PROFILES_PATH;

pi.on("session_start", async (_event, ctx) => {
  const notify = toCtxNotify(ctx);
  loadConfEnv(notify);
  await startupActivateProfile({
    profilesPath: getProfilesPath(),
    pi,
    env: process.env,
    notify,
  });
});
```

- [ ] **Step 2: Update /gateframe-refresh command**

Replace the existing `gateframe-refresh` handler:

```ts
pi.registerCommand("gateframe-refresh", {
  description: "Refresh Gateframe models (re-reads profiles file and re-validates active profile)",
  handler: async (_args, ctx) => {
    const notify = toCtxNotify(ctx);
    loadConfEnv(notify);
    const result = await handleRefresh({
      profilesPath: getProfilesPath(),
      pi,
      env: process.env,
      notify,
    });
    if (result.success) {
      ctx.ui?.notify?.("Gateframe models refreshed.", "success");
    } else {
      ctx.ui?.notify?.(result.error ?? "Refresh failed.", "error");
    }
  },
});
```

- [ ] **Step 3: Register /gateframe-profiles command (interactive picker)**

```ts
pi.registerCommand("gateframe-profiles", {
  description: "Switch to a Gateframe profile (interactive picker)",
  handler: async (_args, ctx) => {
    const notify = toCtxNotify(ctx);
    loadConfEnv(notify);
    const { profiles } = handleProfileList({ profilesPath: getProfilesPath() });
    const enabled = profiles.filter((p) => p.enabled);

    if (enabled.length === 0) {
      ctx.ui?.notify?.("No enabled Gateframe profiles.", "warning");
      return;
    }

    const active = getActiveProfile();
    const labels = enabled.map((p) => {
      const marker = p.name === active ? " (active)" : "";
      return `${p.name}${marker} — ${p.modelCount} models`;
    });

    const choice = await ctx.ui?.select?.("Select a Gateframe profile:", labels);
    if (!choice) return;

    const selectedName = enabled.find((p) => choice.startsWith(p.name))?.name;
    if (!selectedName) return;

    const result = await handleProfileUse({
      profilesPath: getProfilesPath(), name: selectedName, pi, env: process.env, notify,
    });
    if (result.success) {
      ctx.ui?.notify?.(`Switched to profile "${selectedName}".`, "success");
    } else {
      ctx.ui?.notify?.(result.error ?? "Failed to switch profile.", "error");
    }
  },
});
```

- [ ] **Step 4: Register /gateframe-use command**

```ts
pi.registerCommand("gateframe-use", {
  description: "Switch to a named Gateframe profile: /gateframe-use <name>",
  handler: async (args, ctx) => {
    const name = args.trim();
    if (!name) {
      ctx.ui?.notify?.("Usage: /gateframe-use <profile-name>", "warning");
      return;
    }
    const notify = toCtxNotify(ctx);
    loadConfEnv(notify);
    const result = await handleProfileUse({
      profilesPath: getProfilesPath(), name, pi, env: process.env, notify,
    });
    if (result.success) {
      ctx.ui?.notify?.(`Switched to profile "${name}".`, "success");
    } else {
      ctx.ui?.notify?.(result.error ?? "Failed to switch profile.", "error");
    }
  },
});
```

- [ ] **Step 5: Register /gateframe-profile add command (interactive)**

```ts
pi.registerCommand("gateframe-profile", {
  description: "Manage Gateframe profiles: add <name>, remove <name>, edit <name>, enable <name>, disable <name>",
  getArgumentCompletions: (prefix) => {
    const subcommands = ["add", "remove", "edit", "enable", "disable"];
    return subcommands
      .filter((s) => s.startsWith(prefix.split(" ")[0] ?? ""))
      .map((s) => ({ label: s }));
  },
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0];
    const name = parts[1];
    const notify = toCtxNotify(ctx);
    loadConfEnv(notify);

    if (sub === "add") {
      if (!name) {
        ctx.ui?.notify?.("Usage: /gateframe-profile add <name>", "warning");
        return;
      }

      const apiKey = await ctx.ui?.input?.("API key:", "gf_...");
      if (!apiKey) return;

      const baseUrlInput = await ctx.ui?.input?.("Base URL (leave empty for default):", "https://router.gateframe.ai");
      const baseUrl = baseUrlInput?.trim() || undefined;

      // Discover available models for this key
      const resolvedBase = normalizeBaseUrl(baseUrl ?? process.env.GATEFRAME_BASE_URL ?? DEFAULT_BASE_URL);
      let discoveredIds: string[] = [];
      try {
        const resp = await fetch(`${resolvedBase}/models`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        });
        if (resp.ok) {
          const payload = (await resp.json()) as { data?: unknown[] };
          discoveredIds = Array.isArray(payload.data)
            ? payload.data
                .filter((m): m is { id: string } => !!m && typeof m === "object" && typeof (m as any).id === "string")
                .map((m) => m.id)
            : [];
        }
      } catch {
        ctx.ui?.notify?.("Could not discover models. Add model IDs manually.", "warning");
      }

      let models: string[];
      if (discoveredIds.length > 0) {
        // Multi-select: show all discovered models, let user pick
        ctx.ui?.notify?.("Select models for this profile:", "info");
        const selected = await ctx.ui?.select?.(
          "Select models:",
          discoveredIds,
        );
        models = selected ? [selected] : [];
      } else {
        const modelsInput = await ctx.ui?.input?.("Model IDs (comma-separated):", "gateframe/opus-4.7, gateframe/qwen-3.6");
        models = modelsInput?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      }

      if (models.length === 0) {
        ctx.ui?.notify?.("No models selected. Profile not created.", "warning");
        return;
      }

      const result = await handleProfileAdd({
        profilesPath: getProfilesPath(), name, apiKey, baseUrl, models,
        pi, env: process.env, notify,
      });
      if (result.success) {
        ctx.ui?.notify?.(`Profile "${name}" created and activated.`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to create profile.", "error");
      }
    } else if (sub === "remove") {
      if (!name) { ctx.ui?.notify?.("Usage: /gateframe-profile remove <name>", "warning"); return; }
      const result = handleProfileRemove({ profilesPath: getProfilesPath(), name, pi, notify });
      if (result.success) {
        ctx.ui?.notify?.(`Profile "${name}" removed.`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to remove profile.", "error");
      }
    } else if (sub === "edit") {
      if (!name) { ctx.ui?.notify?.("Usage: /gateframe-profile edit <name>", "warning"); return; }

      const { profiles } = readProfilesFile(profilesPath);
      const existing = profiles[name];
      if (!existing) {
        ctx.ui?.notify?.(`Profile "${name}" not found.`, "error");
        return;
      }

      const apiKey = await ctx.ui?.input?.("API key (leave empty to keep current):", existing.apiKey);
      const baseUrlInput = await ctx.ui?.input?.("Base URL (leave empty to keep current):", existing.baseUrl ?? "");
      const modelsInput = await ctx.ui?.input?.("Models (comma-separated, leave empty to keep current):", existing.models.join(", "));

      const result = await handleProfileEdit({
        profilesPath: getProfilesPath(), name,
        apiKey: apiKey?.trim() || undefined,
        baseUrl: baseUrlInput?.trim() || undefined,
        models: modelsInput?.trim() ? modelsInput.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        pi, env: process.env, notify,
      });
      if (result.success) {
        ctx.ui?.notify?.(`Profile "${name}" updated.`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to update profile.", "error");
      }
    } else if (sub === "enable") {
      if (!name) { ctx.ui?.notify?.("Usage: /gateframe-profile enable <name>", "warning"); return; }
      const result = handleProfileEnable({ profilesPath: getProfilesPath(), name });
      if (result.success) {
        ctx.ui?.notify?.(`Profile "${name}" enabled.`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to enable profile.", "error");
      }
    } else if (sub === "disable") {
      if (!name) { ctx.ui?.notify?.("Usage: /gateframe-profile disable <name>", "warning"); return; }
      const result = handleProfileDisable({ profilesPath: getProfilesPath(), name, pi, notify });
      if (result.success) {
        ctx.ui?.notify?.(`Profile "${name}" disabled.`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to disable profile.", "error");
      }
    } else {
      ctx.ui?.notify?.("Usage: /gateframe-profile <add|remove|edit|enable|disable> <name>", "warning");
    }
  },
});
```

- [ ] **Step 6: Register /gateframe-models command**

```ts
pi.registerCommand("gateframe-models", {
  description: "Show currently active Gateframe profile and its validated models",
  handler: async (_args, ctx) => {
    const { activeProfile: active, models } = handleModelsList();
    if (!active) {
      ctx.ui?.notify?.("No active Gateframe profile.", "info");
      return;
    }
    const lines = [
      `Active profile: ${active}`,
      `Models:`,
      ...models.map((m) => `  - ${m.id}`),
    ];
    ctx.ui?.notify?.(lines.join("\n"), "info");
  },
});
```

- [ ] **Step 7: Register /gateframe-init command**

```ts
pi.registerCommand("gateframe-init", {
  description: "Create profiles.json from current GATEFRAME_API_KEY and GATEFRAME_BASE_URL",
  handler: async (_args, ctx) => {
    const notify = toCtxNotify(ctx);
    loadConfEnv(notify);
    const result = await handleInit({
      profilesPath: getProfilesPath(),
      env: process.env,
      notify,
    });
    if (result.success) {
      ctx.ui?.notify?.(`Profiles file created at ${getProfilesPath()}.`, "success");
    } else {
      ctx.ui?.notify?.(result.error ?? "Failed to initialize profiles.", "error");
    }
  },
});
```

- [ ] **Step 8: Run all tests to verify nothing is broken**

Run: `npm test`
Expected: All tests PASS (both old and new).

- [ ] **Step 9: Commit**

```bash
git add .pi/extensions/gateframe-provider/index.ts
git commit -m "feat: wire profile commands into pi extension"
```

---

## Task 12: Export profiles from the extension barrel

**Files:**
- Modify: `extensions/gateframe-provider.ts`

- [ ] **Step 1: Update barrel export**

Add profiles re-export to `extensions/gateframe-provider.ts`:

```ts
export { default } from "../.pi/extensions/gateframe-provider/index.ts";
export * from "../.pi/extensions/gateframe-provider/index.ts";
export * from "../.pi/extensions/gateframe-provider/profiles.ts";
```

- [ ] **Step 2: Run tests to verify imports still work**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/gateframe-provider.ts
git commit -m "feat: export profiles module from barrel"
```

---

## Task 13: Update README and .env.example

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Add profiles section to README**

Add a new section after "Configuration" covering:
- What profiles are and why they exist
- `~/.config/gateframe/profiles.json` file format
- All profile commands with examples
- Multi-instance behavior explanation
- Migration from single-key: `/gateframe-init`

- [ ] **Step 2: Update .env.example**

Add:
```
# Optional. Path to the profiles config file.
# If unset, defaults to ~/.config/gateframe/profiles.json.
# When the file exists, profile mode takes over and GATEFRAME_API_KEY /
# GATEFRAME_BASE_URL are only used as fallbacks.
# GATEFRAME_PROFILES_PATH=/path/to/profiles.json
```

- [ ] **Step 3: Update existing README references**

Update troubleshooting section to mention profile commands.
Update the "Picker shows models but chat returns 404" entry to mention profiles.

- [ ] **Step 4: Run documentation tests**

Run: `npm test`
Expected: All tests PASS (doc tests still pass).

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example
git commit -m "docs: add multi-profile documentation to README and env example"
```

---

## Task 14: Final integration test and cleanup

**Files:**
- Modify: `tests/gateframe-profiles.test.mjs`
- Modify: `tests/gateframe-provider.test.mjs` (if any tests need updating)

- [ ] **Step 1: Add end-to-end smoke test**

```js
// Add to tests/gateframe-profiles.test.mjs
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
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/gateframe-profiles.test.mjs tests/gateframe-provider.test.mjs
git commit -m "test: add end-to-end profile workflow smoke test"
```

- [ ] **Step 4: Final commit — all changes**

```bash
git add -A
git commit -m "feat: add multi-profile support for Gateframe pi integration"
```
