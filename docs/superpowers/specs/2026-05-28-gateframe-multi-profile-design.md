# Gateframe Multi-Profile Extension Design

**Date:** 2026-05-28
**Project:** `gateframe-pi-integration`
**Status:** Approved

## Goal

Extend the Gateframe pi extension to support multiple named profiles, where each profile bundles an API key, base URL, and a validated model list. Users can switch between profiles to use different budgets/quota pools, with model availability validated against Gateframe's discovery endpoint.

## Motivation

Gateframe API keys map to different budgets, rate limits, and spend caps. Users who work across multiple projects or need to isolate spend need to switch between keys. Currently the extension supports a single key, requiring env var changes and a pi restart to switch.

Additionally, different keys have access to different models (managed server-side by Gateframe). A profile should declare which models it expects, and the extension validates availability on activation.

## Architecture

### Approach: Re-register on switch (Approach A)

Each profile switch tears down the current `gateframe` provider and re-registers it with the new profile's key and validated models. Discovery runs on every switch.

- **Pros:** Clean, simple, pi always sees exactly one provider with correct auth and models. No stale state.
- **Cons:** Brief interruption during switch (discovery call). If the key has no model access, zero models until resolved.
- **Complexity:** Low. Reuses existing `registerGateframeProvider` logic.

### Multi-instance support

Each pi instance is a separate process with its own in-memory state:

| Concern | How it's handled |
|---------|-----------------|
| Shared config | All instances read from the same `~/.config/gateframe/profiles.json` |
| Active profile | Stored in-memory per instance. Instance A on `coding`, instance B on `fast` — no conflict. |
| Switching | `/gateframe-use coding` in instance A does not affect instance B |
| Editing profiles | Adding/removing/editing profiles writes to the shared file. Other instances pick up changes on next switch or `/gateframe-refresh`. |

Config file changes are **not** auto-detected. Users run `/gateframe-refresh` to pick up edits made by another instance or external editor.

## Data Model

### Profiles config file

`~/.config/gateframe/profiles.json`:

```json
{
  "profiles": {
    "coding": {
      "apiKey": "gf_abc",
      "baseUrl": "https://router.gateframe.ai",
      "models": ["gateframe/opus-4.7", "gateframe/qwen-3.6"],
      "enabled": true
    },
    "fast": {
      "apiKey": "gf_xyz",
      "baseUrl": "https://router.gateframe.ai",
      "models": ["gateframe/minimax-2.7"],
      "enabled": true
    },
    "staging": {
      "apiKey": "gf_old",
      "baseUrl": "https://staging.gateframe.ai",
      "models": ["gateframe/opus-4.7"],
      "enabled": false
    }
  }
}
```

### Field rules

- `apiKey` (required): The Gateframe inference bearer token for this profile.
- `baseUrl` (optional): Per-profile base URL. Falls back to the global `GATEFRAME_BASE_URL` env var, then to `https://router.gateframe.ai`.
- `models` (required): Array of public Gateframe model identifiers this profile expects to use. Validated against `/v1/models` on activation.
- `enabled` (required): Boolean. `false` profiles exist in the file but cannot be activated or appear in the picker.

### Active profile

There is **no `active` field in the file**. The active profile is stored in-memory per pi instance. This allows multiple instances to have different active profiles simultaneously.

### Startup behavior

On `session_start`, the extension determines which profile to activate:

1. If `profiles.json` does not exist or contains no profiles → fall back to single-key behavior (current behavior using `GATEFRAME_API_KEY` + `GATEFRAME_BASE_URL`).
2. If `profiles.json` contains one or more enabled profiles → auto-activate the **first enabled profile** (in file declaration order). Run the standard activation flow (discovery + validation + provider registration).
3. If `profiles.json` exists but all profiles are disabled → warn "all profiles are disabled" and do not register a provider.
4. If the auto-activated profile's discovery fails → warn and fall back to the next enabled profile. If all fail, warn and leave the provider unregistered.

### In-memory per-instance state

- `activeProfile: string | undefined` — name of the currently active profile.
- `cachedModels: Map<string, ProfileModel[]>` — last successfully discovered-and-validated models per profile name. Used as fallback when discovery fails on refresh (same behavior as the existing `lastGoodModelsByBaseUrl` cache). Updated (not cleared) on successful `/gateframe-refresh` — the old cache entry is replaced only after new models are successfully discovered.

## Backward Compatibility

- If `profiles.json` does not exist, the extension works exactly as today: single key from `GATEFRAME_API_KEY` + `GATEFRAME_BASE_URL` + `~/.config/gateframe/conf.env`.
- If `profiles.json` exists but contains no profiles (`"profiles": {}`), falls back to single-key behavior.
- Existing users are not forced to migrate.
- `GATEFRAME_MODEL_OVERRIDES_PATH` continues to work across all profiles for metadata overrides (context window, max tokens, reasoning, cost).

## Commands

| Command | Behavior |
|---------|----------|
| `/gateframe-profiles` | Interactive picker showing enabled profiles with model count and base URL. Selecting one activates it. |
| `/gateframe-use <name>` | Quick-switch by name. Validates models via discovery, re-registers provider. |
| `/gateframe-profile add <name>` | Prompts for API key, base URL (optional), and model IDs. Writes to file and activates. |
| `/gateframe-profile remove <name>` | Deletes profile from file. If it was the active profile, deactivates the provider. |
| `/gateframe-profile edit <name>` | Opens interactive edit: update key, base URL, or models. Writes to file; if active, re-registers. |
| `/gateframe-profile enable <name>` | Sets `enabled: true` in file. Makes it available in picker. |
| `/gateframe-profile disable <name>` | Sets `enabled: false` in file. If currently active, deactivates the provider. |
| `/gateframe-refresh` | Re-reads profiles file from disk, then re-validates and re-registers the active profile's models. Also picks up config edits made by other instances. |
| `/gateframe-models` | Shows the currently active profile's validated model list from in-memory state (what is in `/model` right now). Does not re-read the profiles file or re-run discovery. |
| `/gateframe-init` | Reads the current `GATEFRAME_API_KEY` and `GATEFRAME_BASE_URL` (from env or `conf.env`), calls `/v1/models` to discover all accessible models, and creates a `default` profile containing the key, base URL, and all discovered model IDs. If discovery fails, uses the static fallback model list. Refuses to overwrite an existing `profiles.json`. |

### Activation flow

Used by `/gateframe-use`, `/gateframe-profile add`, and the `/gateframe-profiles` picker:

1. Read profiles file from disk.
2. Find the target profile by name.
3. Reject if `enabled: false`.
4. Resolve `baseUrl`: profile value → `GATEFRAME_BASE_URL` env var → `https://router.gateframe.ai`.
5. Normalize base URL via `normalizeBaseUrl()` (ensures `/v1` suffix, strips trailing slashes). The normalized value is used as the provider's `baseUrl` for pi registration.
6. Call `GET {normalizedBaseUrl}/models` with `Authorization: Bearer {apiKey}`. Note: the `/v1` is already part of `normalizedBaseUrl`, so the full discovery path is `{normalizedBaseUrl}/models` (e.g. `https://router.gateframe.ai/v1/models`). Pi's provider will append `/chat/completions` to the same base.
7. Intersect declared `models` against the `data[].id` values in the discovery response.
7a. Pass the profile's **literal `apiKey` value** to pi's provider registration (not an env var reference). The current implementation uses `apiKey: "GATEFRAME_API_KEY"` which references the env var name; profile mode must pass the actual key string so that pi's HTTP requests to `/v1/chat/completions` use the correct profile's credentials.
8. Warn about any declared models that were not in the discovery response.
9. If at least one valid model remains → re-register provider with those models and the profile's literal `apiKey` (replaces existing `gateframe` provider). Pi uses this key for all subsequent chat completion requests under this profile.
10. If zero valid models → warn "no accessible models for profile X" and do not register.
11. New profiles created via `add` are written with `enabled: true`.
12. Write commands (`add`, `remove`, `edit`, `enable`, `disable`, `init`) refuse to write if `profiles.json` is malformed JSON — warn the user to repair the file rather than risk overwriting with a new file that drops existing profiles.

### Deactivation flow

Used by `/gateframe-profile disable` (when active) and `/gateframe-profile remove` (when active):

1. Clear `activeProfile` from memory.
2. Unregister the `gateframe` provider (or re-register with an empty model list if pi does not support unregister).
3. Notify user.

## File Operations

### Read behavior

The profiles file is read from disk on:
- Extension startup (`session_start`).
- Any command execution (`use`, `add`, `remove`, `edit`, `enable`, `disable`, `refresh`, `profiles`, `models`, `init`).

### Write behavior

The profiles file is written on:
- `add`, `remove`, `edit`, `enable`, `disable`.

Writes are atomic: write to a temp file in the same directory, then rename. This prevents partial writes from corrupting the file when multiple instances or editors are operating concurrently.

### Directory creation

If `~/.config/gateframe/` does not exist, the extension creates it when writing the profiles file.

## Migration

A convenience command is provided for users migrating from single-key setup:

- `/gateframe-init` — reads the current `GATEFRAME_API_KEY` and `GATEFRAME_BASE_URL` (from env or `conf.env`) and creates a `default` profile in `profiles.json`. Does not overwrite an existing file.

## Edge Cases & Error Handling

| Scenario | Behavior |
|----------|----------|
| Profile's API key is invalid/expired | Discovery returns 401/403 → warn "authentication failed for profile X", do not register provider. |
| All declared models fail discovery | Warn "no accessible models for profile X", do not register provider. |
| Some declared models fail discovery | Warn "models not accessible: [list]", register provider with the models that worked. |
| Profiles file is malformed JSON | Warn "profiles file is malformed", fall back to current in-memory state (if any) or single-key behavior. |
| Active profile is disabled/removed by another instance | Not detected until next action in this instance. User runs `/gateframe-refresh` to pick up the change. |
| `baseUrl` unreachable on initial activation | Discovery timeout (10s) → warn "could not reach Gateframe at {url}", do not register. |
| `baseUrl` unreachable on `/gateframe-refresh` | Discovery timeout → warn, keep the current provider registered with the existing cached models. Do not unregister. |
| Active profile was removed from file by another instance | `/gateframe-refresh` detects the active profile is missing → deactivate provider, warn "active profile was removed". Do not auto-switch to another profile. |
| Active profile was disabled by another instance | `/gateframe-refresh` detects `enabled: false` → deactivate provider, warn "active profile was disabled". Do not auto-switch to another profile. |
| No profiles file, no env vars | Same as today: warn about missing `GATEFRAME_API_KEY` and `GATEFRAME_BASE_URL`. |
| Profile name contains special characters | Reject names that are not `[a-zA-Z0-9_-]+`. |
| Duplicate profile name on `add` | Reject with "profile already exists". Use `edit` to modify. |

## Testing

### Unit tests

- Profile file read: valid JSON, malformed JSON, missing file, empty profiles.
- Profile file write: atomic write, directory creation.
- Model intersection: full match, partial match, zero match.
- Command handlers with mocked `pi.registerProvider`: `use`, `add`, `remove`, `edit`, `enable`, `disable`.
- Base URL resolution: profile value wins, env fallback, default fallback, normalization.

### Integration smoke test

- Create a temp profiles file with two profiles.
- Add a profile via command, assert file updated and provider registered.
- Switch profiles via command, assert provider re-registered with different models.
- Remove active profile, assert provider deactivated.
- Disable active profile, assert provider deactivated.
- `/gateframe-init` creates profiles file from env vars; refuses to overwrite existing file.

### Backward compatibility test

- No profiles file present → existing single-key behavior works unchanged.
- Empty profiles file (`"profiles": {}`) → falls back to single-key behavior.
- `GATEFRAME_MODEL_OVERRIDES_PATH` applies to all profiles.

## Future: Intent-Based Auto-Configuration

This design does not implement automatic workflow selection based on prompt intent. The data model supports it: a future feature could inspect the user's prompt and recommend (or auto-switch to) the best profile based on rules like "coding prompts use `coding` profile, quick questions use `fast` profile." This is explicitly out of scope for this iteration.

## Non-Goals

- **Server-side model routing logic**: Gateframe controls which models a key can access. The extension only validates and reports.
- **Real-time sync between instances**: Config changes are picked up on explicit refresh, not via file watching.
- **Cost tracking per profile**: pi's built-in usage panel tracks spend. Profile-level budgeting is managed by Gateframe.
- **Encrypted credential storage**: API keys are stored in plaintext JSON (same security level as the existing `conf.env`). Users should set file permissions to `600`.
