import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_BASE_URL = "http://node1.gateframe.ai:3000";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export type NotifyLevel = "info" | "success" | "warning" | "error";
export type NotifyFn = (message: string, level?: NotifyLevel) => void;

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

export function mapGateframeModel(model: { id: string }) {
  return {
    id: model.id,
    name: model.id,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

const KNOWN_MODEL_IDS = [
  "gateframe/opus-4.7",
  "gateframe/qwen-3.6",
  "gateframe/minimax-2.7",
  "gateframe/chatgpt-5.4",
  "gateframe/glm-5.1",
];

export function getFallbackModels() {
  return KNOWN_MODEL_IDS.map((id) => mapGateframeModel({ id }));
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
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  const models = Array.isArray(payload.data) ? payload.data.filter(isGateframeModel).map(mapGateframeModel) : [];

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

  let models: ReturnType<typeof mapGateframeModel>[];
  try {
    models = await discoverModels({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetchImpl,
      timeoutMs: discoveryTimeoutMs,
    });
    lastGoodModelsByBaseUrl.set(config.baseUrl, models);
  } catch (error) {
    const previous = lastGoodModelsByBaseUrl.get(config.baseUrl);
    models = previous ?? getFallbackModels();
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
