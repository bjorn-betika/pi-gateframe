import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_BASE_URL = "http://node1.gateframe.ai:3000";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3);
  return trimmed;
}

export function defaultGateframeConfig(env: Record<string, string | undefined>) {
  return {
    apiKey: env.GATEFRAME_API_KEY,
    baseUrl: normalizeBaseUrl(env.GATEFRAME_BASE_URL || DEFAULT_BASE_URL),
  };
}

export function mapGateframeModel(model: { id: string; object?: string }) {
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

export function getFallbackModels() {
  return [mapGateframeModel({ id: "gateframe/minimax-2.7", object: "model" })];
}

function isGateframeModel(value: unknown): value is { id: string; object?: string } {
  return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

export async function discoverModels({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}) {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/v1/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

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
}: {
  pi: { registerProvider: (name: string, config: Record<string, unknown>) => void };
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const config = defaultGateframeConfig(env);
  if (!config.apiKey) {
    notify("Set GATEFRAME_API_KEY to enable the Gateframe pi provider.", "warning");
    return;
  }

  let models;
  try {
    models = await discoverModels({ baseUrl: config.baseUrl, apiKey: config.apiKey, fetchImpl });
  } catch (error) {
    models = getFallbackModels();
    notify(
      `Gateframe model discovery failed, using fallback models: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }

  pi.registerProvider("gateframe", {
    baseUrl: config.baseUrl,
    apiKey: "GATEFRAME_API_KEY",
    authHeader: true,
    api: "openai-completions",
    models,
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await registerGateframeProvider({
      pi,
      env: process.env,
      notify: (message, level) => ctx.ui?.notify?.(message, level as never),
    });
  });
}
