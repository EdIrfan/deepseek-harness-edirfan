# Agent Note: Model-picker metadata and cost visibility

Status: implemented

English | [中文](2026-08-30-model-picker-metadata-and-cost-visibility.zh.md)

## Problem

The Web model picker (the composer model seat and the `/model` popup) showed a model name and nothing else. A user choosing between routes on the same gateway could not see how large each context window was or what each model costs, and the "Turn usage" panel reported tokens with no dollar figure. Two facts the harness already had were being discarded on the way to the browser:

- The pi-ai adapter resolves each model's context window onto `LlmResolvedModelInfo.context.contextWindow`, but `buildModelCatalog` copied only `id`/`name`/`description`/`reasoning` into the wire model.
- pi-ai ships real per-token price rates with its installed model catalog (`Model.cost`, USD per million tokens). The adapter never copied them onto the resolved info, and `LlmResolvedModelInfo` had no field to carry a price, so no consumer — catalog, turn meter, or session rollup — could ever show cost.

## Decision

**The model-info seam carries price, and the catalog carries context window and price.** `LlmResolvedModelInfo` gains an optional `pricing: LlmModelPricing` (four USD-per-million-token rates: input, output, cache-read, cache-write). `LlmService.normalizeModelInfo` validates it at the adapter-result boundary — every rate finite and non-negative, or `INVALID_MODEL_PRICING` — and copies a detached structure onto the resolved info beside the existing `context` validation. The pi-ai adapter's `modelInfo()` projects `Model.cost` straight through (pi-ai's unit is already USD per million tokens); an all-zero cost — a hand-declared route's `NO_COST` — resolves to no pricing, because zero states no answer rather than "free". Volume tiers (`ModelCost.tiers`) are flattened to the base rates: request-size-aware pricing has no consumer yet.

`buildModelCatalog` stops dropping `resolved.context.contextWindow` and now also maps `resolved.pricing`. `ModelCatalogModel` gains `contextWindow?: number` and `pricing?: ModelPricing`, both re-exported to the browser through `@deepseek-ai/dsh-api-remotes`.

**The picker rows show both, on one compact secondary line.** `ui-model-selection` renders a `.modelMeta` line under each model name in the composer seat's model pane, joining the pieces with ` · `: `200K context · $0.14 / $0.28 /Mtok`. The `/model` popup appends the same pieces to each row's `detail` string. A model that resolved neither renders no second line. `format.ts` owns the formatters: `formatTokenCount` (`128000` becomes `128K`, `1_500_000` becomes `1.5M`), `formatPricePerMTok` (`0.14` becomes `$0.14`, `2` becomes `$2`, sub-cent to four decimals), and `formatPricePair`.

**Pricing is presentation-only and never enters a model request.** No session event is added for the picker surfaces (`packages/client/AGENTS.md`: "Nothing that is only 'how to draw' enters the session log"). The downstream per-turn and per-session cost views (separate plans) do log the rates on the existing `request/context` event, which is additive and does not move `SESSION_FORMAT_VERSION`.

**A route whose provider bills a prepaid balance reports it, and the group header shows it.** The `LlmAdapter` base gains an optional `providerAccountBalance(provider, signal)`; `LlmService.providerAccountBalance` delegates to it and answers `undefined` for an unregistered route or an adapter that does not implement it. The pi-ai adapter implements it for OpenRouter only: when the route's endpoint host is `openrouter.ai` it resolves the route key through the same `resolveApiKey` a request uses and reads `GET https://openrouter.ai/api/v1/key` (`limit_remaining` and `usage`) through the shared `readBoundedText`; any other host resolves `undefined`. `buildModelCatalog` folds a `ModelProviderGroup.account` per group behind a 60-second process cache and a 4-second per-query timeout, inside a `try/catch` that treats any failure as "no account" — the balance is decoration and the group must load without it. `ui-model-selection` renders `$12.40 left` beside the group name in the `/model` popup and composer model pane. OpenRouter's `/key` endpoint is not itself token-billed, so the lookup costs nothing.

## Unit choice

The seam and the wire type both quote **USD per one million tokens**, the unit pi-ai's catalog already uses (`rates.input / 1_000_000 * usage.input` in pi-ai's own cost math) and the unit prices are marketed in. Storing per-million avoids a lossy `/ 1e6` at the adapter, keeps the numbers human-legible in tests and diagnostics, and matches what a cost view will render.

## Alternatives considered

**Store the seam value in USD per token.** Rejected. pi-ai supplies per-million, so per-token would force a division at the adapter that loses precision to floating point and produces values like `2.7e-7` that are unreadable in a test assertion or a logged diagnostic. Per-million passes through unscaled and reads the way a human quotes a price.

**Put pricing on the existing `LlmImageRequestPricing` seam.** Rejected. That seam prices one image occurrence per measurement and is resolved synchronously without I/O for the live context meter; per-token text rates are a different concern with a different lifetime (resolved once with the model catalog, not per request). Overloading it would couple two unrelated consumers.

**A second `ModelCatalog` type in `api-remotes` instead of re-exporting the session-controller one.** Rejected. There is one definition, in `packages/api/session-controller/src/types.ts`, re-exported for the browser. Adding fields in one place keeps the Host builder and the client renderer from drifting.

**Render context window and price as separate stacked lines.** Rejected for now. The request was "fit it in every row without making it ugly"; one ` · `-joined caption line at 12px holds both for realistic values. The account balance went in the group header rather than the row for the same reason. If a future per-row addition overflows the caption line, that is the trigger to move to a two-column meta layout.

**Skip the all-zero guard and report `NO_COST` as `{0,0,0,0}` pricing.** Rejected. A hand-declared gateway route genuinely has no price data; showing `$0 / $0` would assert it is free. Absent pricing renders no price text, which is the honest state.

**Put the OpenRouter balance lookup in a pi-ai-only `ctx.piAiAccounts` service instead of an `LlmAdapter` method.** Rejected. The seam is provider-agnostic even though only pi-ai's OpenRouter branch is implemented today; a Together or Fireworks balance is one more `host ===` branch in `account.ts`, not a new service. `session-controller` reaching a pi-ai-specific service would also be a layering inversion the adapter method avoids.

**Poll the balance on a timer, or push updates.** Rejected. The value refreshes when the catalog rebuilds — on every `llm/adapters-updated`, `settings/document-updated`, and `credentials/reference-updated` event, plus each menu open — which is often enough for a slow-moving prepaid balance. A timer would spend requests to keep a decoration fresh.

**Block the composer when the balance is low.** Rejected. This surface displays; it does not gate. A depleted balance fails the next request with the provider's own error, which is where that belongs.

## Consequences

- The picker immediately shows context window and price for every pi-ai catalog route (which is every route the shipped `dsh web` tree serves). Hand-declared gateway routes show a context window (from their configured or `defaultContextWindow` value) and no price.
- Price accuracy is bounded by the pinned pi-ai version: the rates are a point-in-time snapshot bundled with the package. Cost-view copy (separate plans) says "est." for this reason; the picker row shows the rate as a fact about what pi-ai shipped.
- `INVALID_MODEL_PRICING` is a new `LlmError` code. `LlmError.code` is an open string, so no union needed updating.
- Tiered pricing is dropped. A cost figure for a very large request will use the base rate. When a consumer needs tier accuracy, the fix is a `resolvePricing(provider, model, inputTokens)` method, not the static field.
- An OpenRouter route now shows its remaining credit balance in the picker group header. `buildModelCatalog` gains one bounded outbound request per OpenRouter provider per 60 seconds; the 4-second timeout and cache keep it off the catalog's critical path. Non-OpenRouter providers make no such request.
- `ACCOUNT_QUERY_FAILED` is a new `LlmError` code, raised inside `account.ts` and swallowed by `buildModelCatalog`; it does not surface to the browser.
- `DEEPSEEK_API_KEY` was unavailable in the implementing environment (OpenRouter only); web e2e for the picker rows and any keyed snapshot re-record are deferred. Unit, host-integration, and React-component tests cover the plumbing and rendering.
- The OpenRouter balance query needs a live key and network to exercise end to end; the shipped tests stub `fetch` and never assert on a real key value.
- `resetAccountCacheForTests()` is a test-only export on `catalog.ts` so a suite's second `buildModelCatalog` re-queries rather than reusing the 60-second cache.

## Testing

- `packages/llm/llm/tests/service.spec.ts` — `normalizeModelInfo` passes valid pricing through unchanged and rejects negative, non-finite, and NaN rates with `INVALID_MODEL_PRICING`; `providerAccountBalance` delegates to the adapter and answers `undefined` for an unimplemented or unregistered route.
- `packages/llm/llm-pi-ai/tests/adapter.spec.ts` — a pi-ai catalog route (`deepseek-v4-flash`) resolves per-million pricing; a hand-declared route resolves none.
- `packages/llm/llm-pi-ai/tests/account.spec.ts` — `openRouterAccountBalance` reads `limit_remaining`/`usage`, returns `undefined` for a non-OpenRouter or keyless route without calling `fetch`, and throws `ACCOUNT_QUERY_FAILED` / `ABORTED` on a 401 / abort.
- `packages/api/session-controller/tests/session-models.host.spec.ts` — `buildModelCatalog` carries `contextWindow` and `pricing` onto the wire model and omits both when the adapter resolved neither; a resolved `account` rides its group, a throwing balance query still yields a full group, and a provider with no balance query carries no `account`.
- `packages/client/ui-model-selection/tests/format.spec.ts` — the four formatters, including the lossy and round-trip edges.
- `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` — the `.modelMeta` line renders context and price for a model that has them and is absent for one that does not; the group header shows the account balance when the catalog resolved one.
