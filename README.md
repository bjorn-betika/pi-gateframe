# Gateframe pi integration

This repo ships a project-local pi extension at `.pi/extensions/gateframe-provider`
that registers Gateframe as an OpenAI-compatible model provider for
[pi](https://github.com/badlogic/pi-mono).

## Requirements

- Node.js **22.6+** (the extension is written in TypeScript and relies on
  Node's built-in type stripping).
- pi installed globally (or on your `PATH`).
- A Gateframe API key.

## Setup

### 1. Set environment variables

Both variables are **required**. The extension refuses to register if either
is unset and prints a warning inside pi.

```bash
export GATEFRAME_API_KEY=gf_your_token_here
export GATEFRAME_BASE_URL=https://your-gateframe-host
```

`GATEFRAME_BASE_URL` is normalized to include `/v1` automatically — setting
`https://host` and `https://host/v1` are equivalent.

> **Security note:** Prefer `https://`. The extension does not reject
> `http://` URLs, but plain HTTP will send your API key in clear text.

### 2. Use a persistent config file (recommended)

Keep secrets out of your shell rc files:

```bash
mkdir -p ~/.config/gateframe
cat > ~/.config/gateframe/conf.env <<'EOF'
export GATEFRAME_API_KEY=gf_your_token_here
export GATEFRAME_BASE_URL=https://your-gateframe-host
EOF
chmod 600 ~/.config/gateframe/conf.env
```

Then launch pi with:

```bash
source ~/.config/gateframe/conf.env && pi
```

### 3. Start pi

Start pi from this repository so it auto-discovers the extension:

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
- **`Gateframe model discovery failed` warning:** the extension fell back
  to the static list (first run) or kept your previous list (later runs).
  Check that `GATEFRAME_BASE_URL` is reachable and that your API key has
  access to `/v1/models`.
- **Picker shows models but chat returns 404:** your `GATEFRAME_BASE_URL`
  is probably pointing at the wrong host or port. The extension
  automatically appends `/v1`, so do **not** add it yourself a second
  time.
