# Gateframe pi integration

This repo contains a project-local pi extension at `.pi/extensions/gateframe-provider`.

## Setup

Export the Gateframe credentials before starting pi:

```bash
export GATEFRAME_API_KEY=gf_your_token_here
export GATEFRAME_BASE_URL=http://node1.gateframe.ai:3000
```

`GATEFRAME_BASE_URL` is optional; if omitted, the extension defaults to `http://node1.gateframe.ai:3000`.

## Usage

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

You should see `gateframe/...` models discovered from Gateframe's `/v1/models` endpoint. If discovery fails, the extension falls back to a minimal default model list so you can still try the provider.
