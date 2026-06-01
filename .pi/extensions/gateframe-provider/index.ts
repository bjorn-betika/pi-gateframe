import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
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
  getActiveProfile,
  readProfilesFile,
  resolveBaseUrl,
  DEFAULT_PROFILES_PATH,
  DEFAULT_BASE_URL,
} from "./profiles.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_ENV_FILE = "~/.config/gateframe/conf.env";

export type NotifyLevel = "info" | "success" | "warning" | "error";
export type NotifyFn = (message: string, level?: NotifyLevel) => void;

/**
 * Expands a leading `~` or `~/` to the current user's home directory.
 * Leaves absolute and relative paths untouched otherwise.
 */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Parses a minimal subset of dotenv / POSIX-style env files:
 * - `KEY=value`
 * - `export KEY=value`
 * - single- or double-quoted values (quotes stripped, contents kept verbatim)
 * - `#` line comments and blank lines
 *
 * A missing file is NOT an error (returns empty values). A file that exists
 * but cannot be read (e.g. a directory, permission denied) IS an error.
 */
export function loadEnvFile(path: string): {
  values: Record<string, string>;
  error?: string;
} {
  const resolved = expandHome(path);
  try {
    statSync(resolved);
  } catch {
    return { values: {} };
  }

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { values: {}, error: `Failed to read env file ${resolved}: ${detail}` };
  }

  const values: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const stripped = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;

    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return { values };
}

/**
 * Applies values from an env file to the given env object, without
 * overwriting variables that are already set. Shell-exported vars always
 * win over file values. Returns which keys were applied and which were
 * skipped because they were already set.
 */
export function applyEnvFileToProcess(
  path: string,
  env: Record<string, string | undefined>,
): { applied: string[]; skipped: string[]; error?: string } {
  const { values, error } = loadEnvFile(path);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined && env[key] !== "") {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { applied, skipped, error };
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelOverride {
  name?: string;
  /** Override which HTTP API endpoint to use for this model.
   * - `"openai-completions"`: POST /v1/chat/completions (default for most models)
   * - `"openai-responses"`:  POST /v1/responses
   */
  api?: "openai-completions" | "openai-responses";
  reasoning?: boolean;
  input?: readonly ("text" | "image")[];
  cost?: Partial<ModelCost>;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

export type ModelOverrides = Record<string, ModelOverride>;

/**
 * Built-in defaults for Gateframe-routed model ids.
 *
 * NOTE: These are conservative placeholders until Gateframe exposes model
 * metadata via `/v1/models` (see docs/feature-requests/...-gateframe-model-metadata.md).
 * Operators can override any field per id via `GATEFRAME_MODEL_OVERRIDES_PATH`.
 *
 * `cost` is intentionally zeroed by default — shipping wrong pricing is worse
 * than showing $0 until we have real values.
 */
export const KNOWN_MODEL_DEFAULTS: ModelOverrides = {
  "gateframe/opus-4.7": {
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  "gateframe/qwen-3.6": {
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  "gateframe/minimax-2.7": {
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  "gateframe/chatgpt-5.4": {
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsReasoningEffort: false,
    },
  },
  "gateframe/glm-5.1": {
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function defaultGateframeConfig(env: Record<string, string | undefined>): {
  apiKey: string | undefined;
  baseUrl: string | undefined;
} {
  const raw = env.GATEFRAME_BASE_URL;
  return {
    apiKey: env.GATEFRAME_API_KEY,
    baseUrl: raw && raw.trim() ? normalizeBaseUrl(raw) : undefined,
  };
}

function mergeOverride(base: ModelOverride | undefined, extra: ModelOverride | undefined): ModelOverride {
  if (!base && !extra) return {};
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    cost: { ...(base?.cost ?? {}), ...(extra?.cost ?? {}) },
    compat: { ...(base?.compat ?? {}), ...(extra?.compat ?? {}) },
  };
}

export function mapGateframeModel(model: { id: string }, overrides: ModelOverrides = {}) {
  const merged = mergeOverride(KNOWN_MODEL_DEFAULTS[model.id], overrides[model.id]);
  const cost: ModelCost = {
    input: merged.cost?.input ?? 0,
    output: merged.cost?.output ?? 0,
    cacheRead: merged.cost?.cacheRead ?? 0,
    cacheWrite: merged.cost?.cacheWrite ?? 0,
  };
  const result: Record<string, unknown> = {
    id: model.id,
    name: merged.name ?? model.id,
    reasoning: merged.reasoning ?? false,
    input: merged.input ?? (["text"] as const),
    cost,
    contextWindow: merged.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: merged.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  // Per-model API override. Gateframe defaults to /v1/chat/completions;
  // operators can opt specific models into /v1/responses via overrides.
  if (merged.api) {
    result.api = merged.api;
  }
  if (merged.compat && Object.keys(merged.compat).length > 0) {
    result.compat = merged.compat;
  }
  return result as {
    id: string;
    name: string;
    api?: "openai-completions" | "openai-responses";
    reasoning: boolean;
    input: readonly ("text" | "image")[];
    cost: ModelCost;
    contextWindow: number;
    maxTokens: number;
    compat?: Record<string, unknown>;
  };
}

const KNOWN_MODEL_IDS = Object.keys(KNOWN_MODEL_DEFAULTS);

export function getFallbackModels(overrides: ModelOverrides = {}) {
  return KNOWN_MODEL_IDS.map((id) => mapGateframeModel({ id }, overrides));
}

/**
 * Loads per-model overrides from the JSON file at
 * `GATEFRAME_MODEL_OVERRIDES_PATH`. Returns `{ overrides: {} }` when the env
 * var is unset. Returns `{ overrides: {}, error }` when the file is missing or
 * malformed, so the caller can surface a warning.
 */
export function loadModelOverrides(env: Record<string, string | undefined>): {
  overrides: ModelOverrides;
  error?: string;
} {
  const path = env.GATEFRAME_MODEL_OVERRIDES_PATH;
  if (!path) return { overrides: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { overrides: {}, error: `Gateframe overrides file is not a JSON object: ${path}` };
    }
    return { overrides: parsed as ModelOverrides };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { overrides: {}, error: `Failed to read Gateframe overrides at ${path}: ${detail}` };
  }
}

// Module-scoped memory of the last successfully registered model list, keyed
// by base URL, so a transient discovery failure on refresh does not collapse
// the user's model picker to the fallback set.
const lastGoodModelsByBaseUrl = new Map<string, ReturnType<typeof mapGateframeModel>[]>();

function isGateframeModel(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

export async function discoverModels({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  overrides = {},
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  overrides?: ModelOverrides;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Gateframe model discovery failed: ${response.status}`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  const models = Array.isArray(payload.data)
    ? payload.data.filter(isGateframeModel).map((m) => mapGateframeModel(m, overrides))
    : [];

  if (models.length === 0) {
    throw new Error("Gateframe model discovery returned no valid models");
  }

  return models;
}

export async function registerGateframeProvider({
  pi,
  env,
  notify = () => {},
  fetchImpl = fetch,
  discoveryTimeoutMs,
}: {
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: NotifyFn;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
}) {
  const config = defaultGateframeConfig(env);
  if (!config.apiKey) {
    notify("Set GATEFRAME_API_KEY to enable the Gateframe pi provider.", "warning");
    return;
  }
  if (!config.baseUrl) {
    notify(
      "Set GATEFRAME_BASE_URL (e.g. https://gateframe.example.com) to enable the Gateframe pi provider.",
      "warning",
    );
    return;
  }

  const { overrides, error: overridesError } = loadModelOverrides(env);
  if (overridesError) {
    notify(overridesError, "warning");
  }

  let models: ReturnType<typeof mapGateframeModel>[];
  try {
    models = await discoverModels({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetchImpl,
      timeoutMs: discoveryTimeoutMs,
      overrides,
    });
    lastGoodModelsByBaseUrl.set(config.baseUrl, models);
  } catch (error) {
    const previous = lastGoodModelsByBaseUrl.get(config.baseUrl);
    models = previous ?? getFallbackModels(overrides);
    const detail = error instanceof Error ? error.message : String(error);
    const suffix = previous ? "keeping previously discovered models" : "using fallback models";
    notify(`Gateframe model discovery failed, ${suffix}: ${detail}`, "warning");
  }

  pi.registerProvider("gateframe", {
    baseUrl: config.baseUrl,
    apiKey: "$GATEFRAME_API_KEY",
    api: "openai-completions",
    models,
  });
}

export function registerInitialGateframeProvider({
  pi,
  env,
  profilesPath = DEFAULT_PROFILES_PATH,
  notify = () => {},
}: {
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  profilesPath?: string;
  notify?: NotifyFn;
}): boolean {
  const { overrides, error: overridesError } = loadModelOverrides(env);
  if (overridesError) {
    notify(overridesError, "warning");
  }

  const { profiles, error: profilesError } = readProfilesFile(profilesPath);
  if (profilesError) {
    notify(profilesError, "warning");
  }

  const profileNames = Object.keys(profiles);
  if (profileNames.length > 0) {
    const enabledName = profileNames.find((name) => profiles[name].enabled);
    if (!enabledName) {
      notify("All Gateframe profiles are disabled.", "warning");
      return false;
    }

    const profile = profiles[enabledName];
    if (!profile.apiKey) {
      notify(`Profile "${enabledName}" is missing an API key.`, "warning");
      return false;
    }

    const models = profile.models.length > 0
      ? profile.models.map((id) => mapGateframeModel({ id }, overrides))
      : getFallbackModels(overrides);

    pi.registerProvider("gateframe", {
      baseUrl: resolveBaseUrl(profile, env),
      apiKey: profile.apiKey,
      api: "openai-completions",
      models,
    });
    return true;
  }

  const config = defaultGateframeConfig(env);
  if (!config.apiKey || !config.baseUrl) {
    return false;
  }

  pi.registerProvider("gateframe", {
    baseUrl: config.baseUrl,
    apiKey: "$GATEFRAME_API_KEY",
    api: "openai-completions",
    models: getFallbackModels(overrides),
  });
  return true;
}

/**
 * Returns the set of model IDs (based on KNOWN_MODEL_DEFAULTS and any
 * overrides) that are explicitly routed to the /v1/responses endpoint.
 * Useful for informational display and tests.
 */
export function getResponsesApiModelIds(overrides: ModelOverrides = {}): Set<string> {
  const ids = new Set<string>();
  const allIds = new Set([...Object.keys(KNOWN_MODEL_DEFAULTS), ...Object.keys(overrides)]);
  for (const id of allIds) {
    const merged = { ...KNOWN_MODEL_DEFAULTS[id], ...overrides[id] };
    if (merged.api === "openai-responses") ids.add(id);
  }
  return ids;
}

/** Test-only: clear the last-good-models memoization between tests. */
export function __resetLastGoodModelsCache() {
  lastGoodModelsByBaseUrl.clear();
}

export default function (pi: ExtensionAPI) {
  const loadConfEnv = (notify?: NotifyFn) => {
    const path = process.env.GATEFRAME_ENV_FILE || DEFAULT_ENV_FILE;
    const { applied, error } = applyEnvFileToProcess(path, process.env as Record<string, string | undefined>);
    if (error) {
      notify?.(error, "warning");
      return;
    }
    if (applied.length > 0) {
      notify?.(`Loaded ${applied.join(", ")} from ${path}`, "info");
    }
  };

  const getProfilesPath = () =>
    process.env.GATEFRAME_PROFILES_PATH || DEFAULT_PROFILES_PATH;

  const toCtxNotify = (ctx: { ui?: { notify?: (message: string, level?: string) => void } }): NotifyFn =>
    (message, level) => ctx.ui?.notify?.(message, level);

  // -----------------------------------------------------------------------
  // session_start: load env, then activate profile or fall back to single-key
  // -----------------------------------------------------------------------

  loadConfEnv();
  registerInitialGateframeProvider({
    profilesPath: getProfilesPath(),
    pi,
    env: process.env,
  });

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

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

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
        profilesPath: getProfilesPath(),
        name: selectedName,
        pi,
        env: process.env,
        notify,
      });
      if (result.success) {
        ctx.ui?.notify?.(`Switched to profile "${selectedName}".`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to switch profile.", "error");
      }
    },
  });

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
        profilesPath: getProfilesPath(),
        name,
        pi,
        env: process.env,
        notify,
      });
      if (result.success) {
        ctx.ui?.notify?.(`Switched to profile "${name}".`, "success");
      } else {
        ctx.ui?.notify?.(result.error ?? "Failed to switch profile.", "error");
      }
    },
  });

  pi.registerCommand("gateframe-profile", {
    description: "Manage Gateframe profiles: add <name>, remove <name>, edit <name>, enable <name>, disable <name>",
    getArgumentCompletions: (prefix: string) => {
      // Only suggest subcommands when no space is present — i.e. the user
      // is still on the first token. Once they've typed a subcommand and
      // a space, we stop providing completions so the name field isn't
      // overwritten.
      if (prefix.includes(" ")) return null;
      const subcommands = ["add", "remove", "edit", "enable", "disable"];
      return subcommands
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s + " ", label: s }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];
      const name = parts[1];
      const notify = toCtxNotify(ctx);
      loadConfEnv(notify);
      const profilesPath = getProfilesPath();

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
                  .filter(
                    (m): m is { id: string } =>
                      !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
                  )
                  .map((m) => m.id)
              : [];
          }
        } catch {
          ctx.ui?.notify?.("Could not discover models. Add model IDs manually.", "warning");
        }

        let models: string[];
        if (discoveredIds.length > 0) {
          const selected = await ctx.ui?.select?.("Select models:", discoveredIds);
          models = selected ? [selected] : [];
        } else {
          const modelsInput = await ctx.ui?.input?.(
            "Model IDs (comma-separated):",
            "gateframe/opus-4.7, gateframe/qwen-3.6",
          );
          models = modelsInput?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        }

        if (models.length === 0) {
          ctx.ui?.notify?.("No models selected. Profile not created.", "warning");
          return;
        }

        const result = await handleProfileAdd({
          profilesPath, name, apiKey, baseUrl, models,
          pi, env: process.env, notify,
        });
        if (result.success) {
          ctx.ui?.notify?.(`Profile "${name}" created and activated.`, "success");
        } else {
          ctx.ui?.notify?.(result.error ?? "Failed to create profile.", "error");
        }
      } else if (sub === "remove") {
        if (!name) { ctx.ui?.notify?.("Usage: /gateframe-profile remove <name>", "warning"); return; }
        const result = handleProfileRemove({ profilesPath, name, pi, notify });
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
          profilesPath, name,
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
        const result = handleProfileEnable({ profilesPath, name });
        if (result.success) {
          ctx.ui?.notify?.(`Profile "${name}" enabled.`, "success");
        } else {
          ctx.ui?.notify?.(result.error ?? "Failed to enable profile.", "error");
        }
      } else if (sub === "disable") {
        if (!name) { ctx.ui?.notify?.("Usage: /gateframe-profile disable <name>", "warning"); return; }
        const result = handleProfileDisable({ profilesPath, name, pi, notify });
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
}
