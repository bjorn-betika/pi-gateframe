# Gateframe pi integration

This repo is a **Pi package** that registers Gateframe as an OpenAI-compatible
model provider for [pi](https://github.com/badlogic/pi-mono).

## Requirements

- Node.js **22.6+** (the extension is written in TypeScript and relies on
  Node's built-in type stripping).
- pi installed globally (or on your `PATH`).
- A Gateframe API key.

## Installing the package

### Local install for testing

The simplest way to make the extension follow you across directories is to
install this repo once as a **global Pi package**:

```bash
git clone git@github.com:bjorn-betika/pi-gateframe.git
cd pi-gateframe
pi install $(pwd)
```

After that, start `pi` from **any folder** and the Gateframe package should
still load, because `pi install` writes to your global Pi settings by
default.

### Install from git with pi

Once this repo is pushed to GitHub, users can install it globally with:

```bash
pi install git:github.com/bjorn-betika/pi-gateframe
```

Or via HTTPS:

```bash
pi install https://github.com/bjorn-betika/pi-gateframe
```

Pi will clone the repo, read the root `package.json`, and load the
extension from `./extensions`.

### Manual project-local use

If you do not want to use `pi install`, starting pi from this repo still
works because the implementation remains available under
`.pi/extensions/gateframe-provider/` for local development.

You can also install an explicit local path:

```bash
pi install /absolute/path/to/package
```

## Configuration

### 1. Provide credentials

Both `GATEFRAME_API_KEY` and `GATEFRAME_BASE_URL` are **required**. The
extension refuses to register if either is missing and prints a warning
inside pi.

The extension automatically reads `~/.config/gateframe/conf.env` at
startup, so you do not need to `source` anything by hand. Example file:

```bash
mkdir -p ~/.config/gateframe
cat > ~/.config/gateframe/conf.env <<'EOF'
export GATEFRAME_API_KEY=gf_your_token_here
export GATEFRAME_BASE_URL=https://your-gateframe-host
EOF
chmod 600 ~/.config/gateframe/conf.env
```

Rules:

- Supports `KEY=value` and `export KEY=value` lines, single/double quotes,
  and `#` comments.
- **Shell-exported variables always win** over the file. If you already
  have `GATEFRAME_API_KEY` in your shell, that value is used.
- Override the file location by setting `GATEFRAME_ENV_FILE` to another
  path.
- `GATEFRAME_BASE_URL` is normalized to include `/v1` automatically —
  `https://host` and `https://host/v1` are equivalent.

> **Security note:** Prefer `https://`. The extension does not reject
> `http://` URLs, but plain HTTP will send your API key in clear text.

### 2. Start pi

```bash
pi
```

If pi was already running, reload resources:

```text
/reload
```

Then open the model picker:

```text
/model
```

You should see `gateframe/...` models discovered from Gateframe's
`/v1/models` endpoint.

## Fallback behavior

The extension tries hard not to leave you without models:

1. **First run, discovery succeeds:** registers every model returned by
   `GET /v1/models`.
2. **First run, discovery fails:** registers a static fallback list of
   known Gateframe ids (`opus-4.7`, `qwen-3.6`, `minimax-2.7`, `chatgpt-5.4`,
   `glm-5.1`) so you can still use the provider.
3. **Refresh after a previous success, discovery fails:** **keeps** the
   previously discovered model list and prints a warning. A transient
   network blip will not collapse your model picker.

Discovery has a 10-second timeout so a hung Gateframe node will not hang
`session_start`.

## Refreshing discovered models

If you want to force a new model discovery call without restarting pi:

```text
/gateframe-refresh
```

## Multi-profile support

Gateframe API keys map to different budgets, rate limits, and spend caps.
The extension supports **named profiles** so you can switch between keys
without restarting pi.

### How it works

Each profile bundles:

- An **API key** (determines your budget/quota)
- An optional **base URL** (defaults to `https://router.gateframe.ai`)
- A list of **model IDs** you want to use with that key

On activation, the extension calls `/v1/models` to validate your declared
models against what the key actually has access to. Models not accessible
with that key are excluded with a warning.

### Profile config file

Profiles are stored in `~/.config/gateframe/profiles.json`:

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
      "models": ["gateframe/minimax-2.7"],
      "enabled": true
    }
  }
}
```

- `baseUrl` is optional per profile (falls back to `GATEFRAME_BASE_URL`
  or `https://router.gateframe.ai`).
- `enabled: false` profiles exist in the file but can't be activated.
- The **active profile is in-memory** per pi instance — multiple pi
  instances can have different active profiles simultaneously.

### Switching profiles

```text
/gateframe-profiles          # Interactive picker
/gateframe-use coding        # Quick switch by name
```

### Managing profiles

```text
/gateframe-profile add <name>     # Interactive: enter key, URL, models
/gateframe-profile remove <name>  # Delete profile
/gateframe-profile edit <name>    # Update key, URL, or models
/gateframe-profile enable <name>  # Make profile available
/gateframe-profile disable <name> # Disable (deactivates if active)
```

### Other profile commands

```text
/gateframe-models            # Show active profile and its models
/gateframe-init              # Create profiles.json from current env vars
/gateframe-refresh           # Re-read profiles file and re-validate
```

### Startup behavior

1. If `profiles.json` exists with enabled profiles → first enabled profile
   is activated automatically.
2. If `profiles.json` is missing or empty → falls back to single-key mode
   using `GATEFRAME_API_KEY` and `GATEFRAME_BASE_URL` (same as before).
3. If all profiles are disabled → warns and does not register a provider.

### Migrating from single-key

If you're already using `GATEFRAME_API_KEY` and `GATEFRAME_BASE_URL`, run:

```text
/gateframe-init
```

This creates a `default` profile from your current env vars and discovers
all models accessible with your key.

### Multi-instance behavior

Each pi process has its own in-memory state:

| Concern | Behavior |
|---------|----------|
| Shared config | All instances read `~/.config/gateframe/profiles.json` |
| Active profile | In-memory per instance |
| Switching | `/gateframe-use` in one instance does not affect others |
| Config edits | Pick up changes with `/gateframe-refresh` |

### Security

Profile API keys are stored in plaintext JSON. Set file permissions:

```bash
chmod 600 ~/.config/gateframe/profiles.json
```

Override the file location with `GATEFRAME_PROFILES_PATH` if needed.

## Overriding model metadata

Pi needs per-model metadata (context window, max output tokens,
reasoning capability, cost) that Gateframe's current `/v1/models` response
does not expose. The extension ships a conservative defaults table and
lets you override any field per model id via a JSON file.

### Default values

Defaults for the five known Gateframe ids live in
`.pi/extensions/gateframe-provider/index.ts` (`KNOWN_MODEL_DEFAULTS`).
**All costs default to $0** — pi's usage panel will show $0 until you
provide real values. Unknown ids fall through to safe defaults
(`reasoning: false`, `contextWindow: 128000`, `maxTokens: 8192`, `cost: 0`).

### Runtime overrides

Point `GATEFRAME_MODEL_OVERRIDES_PATH` at a JSON file:

```bash
export GATEFRAME_MODEL_OVERRIDES_PATH=~/.config/gateframe/model-overrides.json
```

See
[`.pi/extensions/gateframe-provider/gateframe-model-overrides.example.json`](./.pi/extensions/gateframe-provider/gateframe-model-overrides.example.json)
for the schema. Override values win over the built-in defaults; omitted
fields fall through. A malformed file is ignored with a warning so a
typo cannot disable the provider.

For OpenAI-compatible role quirks, use the `compat` object. For example,
`"supportsDeveloperRole": false` makes pi send its system prompt as
`"role": "system"` instead of `"role": "developer"`. Pi does not expose a
provider setting that turns the system prompt into `"role": "user"`.

### Long-term plan

We have filed a feature request with Gateframe to expose this metadata
directly in `/v1/models` — see
[`docs/feature-requests/2026-04-20-gateframe-model-metadata.md`](./docs/feature-requests/2026-04-20-gateframe-model-metadata.md).
Once that ships, the overrides file becomes optional for most users.

## Running the tests

```bash
npm test
```

## Troubleshooting

- **`Set GATEFRAME_API_KEY ...` or `Set GATEFRAME_BASE_URL ...` warning on
  startup:** the env var is not visible to pi. Confirm with
  `printenv GATEFRAME_API_KEY` in the same shell you launch pi from.
  If you're using profiles, check that `~/.config/gateframe/profiles.json`
  exists and has at least one enabled profile.
- **`Gateframe model discovery failed` warning:** the extension fell back
  to the static list (first run) or kept your previous list (later runs).
  Check that `GATEFRAME_BASE_URL` is reachable and that your API key has
  access to `/v1/models`.
- **`Models not accessible for profile "..."` warning:** your profile
  declares model IDs that the key doesn't have access to. Run
  `/gateframe-profiles` to switch to a different profile, or
  `/gateframe-profile edit <name>` to update the model list.
- **`Authentication failed for profile "..."` warning:** the profile's API
  key is invalid or expired. Update it with `/gateframe-profile edit <name>`.
- **`All Gateframe profiles are disabled` warning:** all profiles in
  `profiles.json` have `"enabled": false`. Enable at least one with
  `/gateframe-profile enable <name>`.
- **Picker shows models but chat returns 404:** your `GATEFRAME_BASE_URL`
  is probably pointing at the wrong host or port. The extension
  automatically appends `/v1`, so do **not** add it yourself a second
  time.
