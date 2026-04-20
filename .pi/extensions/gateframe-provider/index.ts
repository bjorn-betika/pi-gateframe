import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_BASE_URL = "http://node1.gateframe.ai:3000";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export type NotifyLevel = "info" | "success" | "warning" | "error";
export type NotifyFn = (message: string, level?: NotifyLevel) => void;

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelOverride {
  name?: string;
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

export function defaultGateframeConfig(env: Record<string, string | undefined>) {
  return {
    apiKey: env.GATEFRAME_API_KEY,
    baseUrl: normalizeBaseUrl(env.GATEFRAME_BASE_URL || DEFAULT_BASE_URL),
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
  if (merged.compat && Object.keys(merged.compat).length > 0) {
    result.compat = merged.compat;
  }
  return result as {
    id: string;
    name: string;
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
    apiKey: "GATEFRAME_API_KEY",
    api: "openai-completions",
    models,
  });
}

/** Test-only: clear the last-good-models memoization between tests. */
export function __resetLastGoodModelsCache() {
  lastGoodModelsByBaseUrl.clear();
}

export default function (pi: ExtensionAPI) {
  const refreshProvider = async (notify?: NotifyFn) => {
    await registerGateframeProvider({
      pi,
      env: process.env,
      notify,
    });
  };

  const toCtxNotify = (ctx: { ui?: { notify?: (message: string, level?: string) => void } }): NotifyFn =>
    (message, level) => ctx.ui?.notify?.(message, level);

  pi.on("session_start", async (_event, ctx) => {
    await refreshProvider(toCtxNotify(ctx));
  });

  pi.registerCommand("gateframe-refresh", {
    description: "Refresh Gateframe model discovery",
    handler: async (_args, ctx) => {
      await refreshProvider(toCtxNotify(ctx));
      ctx.ui?.notify?.("Gateframe models refreshed.", "success");
    },
  });
}
