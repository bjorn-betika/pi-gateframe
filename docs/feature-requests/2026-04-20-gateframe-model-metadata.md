# Feature Request: Expose Model Metadata via `/v1/models`

**Status:** Proposed
**Author:** gateframe-pi-integration team
**Date:** 2026-04-20
**Target:** Gateframe OpenAPI / OpenAI-compatible model catalog

---

## Summary

Extend Gateframe's `GET /v1/models` response so each model entry includes the
metadata needed by downstream OpenAI-compatible clients — specifically
context window, output token cap, pricing, reasoning capability, and
compatibility hints. Today clients have to hard-code or guess this
metadata, which causes incorrect cost tracking, broken context-limit
handling, and degraded UX for reasoning-capable models.

## Motivation

The `gateframe-pi-integration` extension registers Gateframe as a model
provider for pi. pi's provider registration requires, for every model:

- `contextWindow` — maximum input tokens
- `maxTokens` — maximum output tokens
- `reasoning` — whether the model supports extended thinking
- `cost.{input,output,cacheRead,cacheWrite}` — USD per million tokens
- optionally `compat.thinkingFormat` — which reasoning wire format the
  upstream model uses

Gateframe's current `/v1/models` response only provides `{ id, object }`,
which forces clients into one of three bad options:

1. Hardcode values per known model id (breaks on new models, drifts from
   reality, ties client releases to Gateframe routing changes).
2. Ship placeholder defaults (incorrect cost = $0 misleads users;
   wrong context window breaks long-context workflows).
3. Ship a side-channel config file (operational burden on every user).

Exposing metadata in the API makes Gateframe the single source of
truth, eliminates client drift, and enables accurate usage/cost
reporting out of the box.

## Goals

- Any OpenAI-compatible client can register Gateframe models with
  correct metadata using only `/v1/models`.
- Pricing and limits stay in sync when Gateframe re-routes a model id
  to a different upstream.
- Reasoning-capable models are automatically recognized so clients can
  enable the correct wire format and UI.

## Non-Goals

- Changing the request/response shape of `/v1/chat/completions`.
- Exposing per-tenant or per-user pricing overrides (can come later).
- Usage/billing reporting endpoints (separate feature).

## Proposed API Changes

### `GET /v1/models`

Extend each entry in `data[]` with an optional `metadata` object.
Unknown fields MUST be ignored by clients, and missing fields MUST be
treated as "unknown" (client chooses its own fallback).

#### Example response

```json
{
  "object": "list",
  "data": [
    {
      "id": "gateframe/opus-4.7",
      "object": "model",
      "created": 1730000000,
      "owned_by": "gateframe",
      "metadata": {
        "display_name": "Opus 4.7 (via Gateframe)",
        "context_window": 200000,
        "max_output_tokens": 16384,
        "input_modalities": ["text", "image"],
        "reasoning": {
          "supported": true,
          "wire_format": "openai"
        },
        "pricing": {
          "currency": "USD",
          "unit": "per_million_tokens",
          "input": 3.00,
          "output": 15.00,
          "cache_read": 0.30,
          "cache_write": 3.75
        },
        "compat": {
          "max_tokens_field": "max_completion_tokens",
          "supports_developer_role": true,
          "supports_reasoning_effort": true
        },
        "upstream": {
          "provider": "anthropic",
          "model": "claude-opus-4-7"
        },
        "status": "available",
        "deprecation": null
      }
    }
  ]
}
```

### Field reference

All fields under `metadata` are OPTIONAL. Clients MUST tolerate their
absence.

| Field | Type | Required? | Description |
|---|---|---|---|
| `metadata.display_name` | string | optional | Human-readable name for UIs. Falls back to `id`. |
| `metadata.context_window` | integer (tokens) | **recommended** | Maximum total tokens (input + output) the model accepts. |
| `metadata.max_output_tokens` | integer (tokens) | **recommended** | Maximum tokens the model can emit in one response. |
| `metadata.input_modalities` | `("text" \| "image" \| "audio")[]` | optional | Accepted input types. Defaults to `["text"]`. |
| `metadata.reasoning.supported` | boolean | **recommended** | Whether the model supports extended thinking / chain-of-thought output. |
| `metadata.reasoning.wire_format` | `"openai" \| "anthropic" \| "qwen" \| "qwen-chat-template" \| "zai"` | conditionally required | Required when `reasoning.supported = true`. Identifies how the upstream emits thinking content so clients pick the correct adapter. |
| `metadata.pricing.currency` | string (ISO 4217) | optional | Defaults to `"USD"`. |
| `metadata.pricing.unit` | `"per_million_tokens"` | optional | Defaults to `"per_million_tokens"`. |
| `metadata.pricing.input` | number | **recommended** | Cost per million input tokens. |
| `metadata.pricing.output` | number | **recommended** | Cost per million output tokens. |
| `metadata.pricing.cache_read` | number | optional | Cost per million cache-read tokens. Defaults to `0`. |
| `metadata.pricing.cache_write` | number | optional | Cost per million cache-write tokens. Defaults to `0`. |
| `metadata.compat.max_tokens_field` | `"max_tokens" \| "max_completion_tokens"` | optional | Which OpenAI field the upstream expects. |
| `metadata.compat.supports_developer_role` | boolean | optional | Whether the upstream accepts the `developer` role. |
| `metadata.compat.supports_reasoning_effort` | boolean | optional | Whether the upstream accepts `reasoning_effort`. |
| `metadata.compat.reasoning_effort_map` | `Record<"minimal"\|"low"\|"medium"\|"high"\|"xhigh", string>` | optional | Mapping of logical effort levels to upstream values. |
| `metadata.upstream.provider` | string | optional | Origin provider, e.g. `"anthropic"`, `"openai"`, `"qwen"`. Informational. |
| `metadata.upstream.model` | string | optional | Origin model id. Informational. |
| `metadata.status` | `"available" \| "deprecated" \| "beta" \| "preview"` | optional | Lifecycle state. |
| `metadata.deprecation` | object or null | optional | `{ "sunset_at": ISO8601, "replacement_id": string }` when deprecated. |

### Why a nested `metadata` object?

- Keeps the response OpenAI-compatible. Strict OpenAI clients ignore
  unknown top-level fields, but a nested object under a single
  `metadata` key is the least invasive extension point.
- Lets Gateframe add fields later without each field needing a separate
  top-level negotiation.
- Matches the convention used by several other OpenAI-compatible
  proxies and gateways.

## Compatibility

- **Existing clients:** No change. They see the same `{ id, object }`
  fields they see today and ignore unknown fields.
- **New clients:** Read from `metadata.*` when present; fall back to
  their own defaults when absent.
- **Gateframe upstreams:** No change to `/v1/chat/completions`. The
  metadata is a describe-only surface.

## Suggested rollout

1. Ship the schema behind a per-deployment toggle so Gateframe
   operators can stage it.
2. Populate metadata for the current five routed ids first:
   - `gateframe/opus-4.7`
   - `gateframe/qwen-3.6`
   - `gateframe/minimax-2.7`
   - `gateframe/chatgpt-5.4`
   - `gateframe/glm-5.1`
3. Document the schema in the Gateframe OpenAPI spec
   (`gateframe_betika_openapi.yaml`) so clients can generate typed
   bindings.
4. Publish a changelog entry and version bump.

## Success criteria

- `curl $BASE/v1/models` returns `metadata` for every listed model.
- Reference client (`gateframe-pi-integration`) can remove its
  hand-maintained per-model overrides table and rely solely on the
  API.
- Cost reporting in pi matches Gateframe's billing to within rounding.
- New Gateframe-routed ids automatically appear in clients with correct
  context/pricing without a client release.

## Open questions

1. Should `metadata.pricing` support tiered pricing (e.g. different
   rates above N tokens per minute)? Out of scope for v1 but worth
   reserving space.
2. Should `metadata.reasoning` expose whether reasoning output is
   billable as output tokens on this upstream? Useful for accurate
   cost but may leak upstream detail.
3. Should deprecation information be surfaced as HTTP headers
   (`Deprecation`, `Sunset`) in addition to the body?

## References

- OpenAI Models API: https://platform.openai.com/docs/api-reference/models
- pi provider config reference: `docs/custom-provider.md` (field names
  in `ProviderModelConfig`)
- Current Gateframe OpenAPI: `gateframe_betika_openapi.yaml`
- Client that needs this: `.pi/extensions/gateframe-provider/index.ts`
