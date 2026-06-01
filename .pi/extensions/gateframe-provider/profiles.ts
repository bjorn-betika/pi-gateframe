import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import { normalizeBaseUrl, mapGateframeModel, KNOWN_MODEL_DEFAULTS } from "./index.ts";
import type { ModelOverrides } from "./index.ts";

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

/**
 * Expands a leading `~` or `~/` to the current user's home directory.
 * Leaves absolute and relative paths untouched otherwise.
 */
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

// ---------------------------------------------------------------------------
// Per-instance in-memory state
// ---------------------------------------------------------------------------

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

/**
 * Activates a profile: discovers models from Gateframe, validates declared
 * models against discovery, and re-registers the pi provider with the
 * profile's literal API key and validated models.
 *
 * Returns true if the provider was successfully registered.
 */
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
        .filter(
          (m): m is { id: string } =>
            !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
        )
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

  // Map matched models to pi model definitions. The provider-level `api`
  // field below is the default unless a model has an explicit override.
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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

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
    // Import dynamically to avoid circular dep at module load time
    const { registerGateframeProvider } = await import("./index.ts");
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

// ---------------------------------------------------------------------------
// Command result type
// ---------------------------------------------------------------------------

export interface CommandResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export async function handleProfileAdd({
  profilesPath, name, apiKey, baseUrl, models,
  pi, env, notify = () => {}, fetchImpl = fetch, overrides = {},
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
  profilesPath, name, pi, notify = () => {},
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
  pi, env, notify = () => {}, fetchImpl = fetch, overrides = {},
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
  profilesPath, name, pi, notify = () => {},
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
  profilesPath, name, pi, env, notify = () => {}, fetchImpl = fetch, overrides = {},
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

  const success = await activateProfile({
    name, profile: profiles[name], pi, env, notify, fetchImpl, overrides,
  });
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
  profilesPath, env, notify = () => {}, fetchImpl = fetch,
}: {
  profilesPath: string;
  env: Record<string, string | undefined>;
  notify?: (message: string, level?: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CommandResult> {
  const resolved = expandHome(profilesPath);
  if (existsSync(resolved)) {
    return {
      success: false,
      error: `Profiles file already exists at ${resolved}. Delete it first or use profile commands.`,
    };
  }

  const apiKey = env.GATEFRAME_API_KEY;
  if (!apiKey) return { success: false, error: "GATEFRAME_API_KEY is not set." };

  const baseUrl = env.GATEFRAME_BASE_URL ?? DEFAULT_BASE_URL;
  const normalizedBase = normalizeBaseUrl(baseUrl);

  // Discover models
  let discoveredIds: string[] = [];
  try {
    const response = await fetchImpl(`${normalizedBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: unknown[] };
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
  profilesPath, pi, env, notify = () => {}, fetchImpl = fetch, overrides = {},
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
    await startupActivateProfile({ profilesPath, pi, env, notify, fetchImpl, overrides });
    return { success: true };
  }

  const { profiles, error } = readProfilesFile(profilesPath);
  if (error) return { success: false, error };

  if (!profiles[current]) {
    deactivateProfile(pi, notify);
    notify(`Active profile "${current}" was removed.`, "warning");
    return { success: true };
  }

  if (!profiles[current].enabled) {
    deactivateProfile(pi, notify);
    notify(`Active profile "${current}" was disabled.`, "warning");
    return { success: true };
  }

  const success = await activateProfile({
    name: current,
    profile: profiles[current],
    pi, env, notify, fetchImpl, overrides,
  });
  return { success, error: success ? undefined : `Failed to refresh profile "${current}".` };
}
