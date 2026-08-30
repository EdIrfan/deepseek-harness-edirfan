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

**Pricing is presentation-only and never enters a model request.** No session event is added for the picker surfaces (`packages/client/AGENTS.md`: "Nothing that is only 'how to draw' enters the session log").

**The per-turn cost line reconstructs from the log.** `PreparedLlmCall` gains a detached `pricing` (populated in `LlmService.prepareCall` from `modelInfo.pricing`), and the agent loop writes it onto the existing `request/context` event as `RequestContextPricing`, beside `contextWindow`, re-logging on a rate change through a `pricingEqual` check. This field is additive and non-semantic for existing readers, so `SESSION_FORMAT_VERSION` stays `0` and a log written before it simply yields no estimate. token-meter's `deriveTurnTokenUsage` now collects a per-route price map from the turn's `request/context` events and, in `aggregateAttempts`, sums a `costUsd` through the new pure `costOf(buckets, rates)` (`pricing.ts`): `Σ (uncachedInput·inRate + cacheRead·crRate + cacheWrite·cwRate + output·outRate) / 1e6`, per attempt under its own route's rates. `costUsd` is present only when every billed attempt has a route AND that route logged rates; cache buckets a provider did not report are priced as zero, matching every other token-meter fold. `TurnUsageDisclosure` renders one `Cost — ≈ $0.0012 (est.)` row after Total; the `(est.)` is always shown. **This costs zero model tokens** — the token counts are provider-reported and already in the log, and the rates are static catalog metadata.

**The whole task's spend rolls up by model in the stats strip.** token-meter's durable `tokenUsage` session projection (`stateVersion` 2 → 3, a pre-release re-fold) keeps, alongside the flat `totals` that count-only consumers still read, a per-route accumulation: each `request/context` sets the route the next usage sample is attributed to and stamps that route with any rates it carried, and each usage sample adds to both `totals` and its route's buckets. The wire view derives `byRoute` (per-provider/model spend, each with its own `costUsd` when the route logged rates) and a whole-session `costUsd`, present only when every route that billed tokens has rates and nothing landed unattributed. `ui-chat`'s `StatsLine` appends one `≈ $X (est.)` group after the token counts when the session `costUsd` resolved. A dedicated `/cost` command that renders the full `byRoute` table is deferred — the strip group plus the projection data cover "what did this task cost".

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

**Deliver the turn's price rates to the client through a new RPC or a shared `modelPricing` client service instead of the `request/context` event.** Rejected. The event is already folded by token-meter's projections and read by the client for `contextWindow`; adding `pricing` there is one field on an existing carrier. A new cross-package client service (which feature plugins may not import from each other) or an RPC would be heavier for a value that is per-request and belongs in the reconstructable log anyway.

**Require every attempt to report cache buckets before showing `costUsd`.** Rejected. A non-caching model legitimately reports no cache buckets; requiring them would suppress the estimate for the common case. Absent buckets are priced as zero, consistent with `usage-projection.ts`'s `usage.cacheReadTokens ?? 0`. The `(est.)` label and the README carry the caveat.

**Add a sibling `tokenSpend` projection instead of extending `tokenUsage`.** Rejected. The per-route buckets are the same numbers `tokenUsage` already folds, keyed differently; a second projection would re-fold every usage event to accumulate a parallel copy, and `StatsLine` would need a second `useProjection` hook. Extending the state (and re-folding once on the `stateVersion` bump, which pre-release policy allows) keeps one fold and one hook.

**Attribute per-route spend by `assistant/message.source` rather than a `currentRoute` set from `request/context`.** Rejected for consistency with the per-turn fold (plan 004), which already threads `request/context`. `source` is also absent on a chunk-only usage sample from an attempt that errored before finalizing, so it would leave those tokens unattributed more often.

## Consequences

- The picker immediately shows context window and price for every pi-ai catalog route (which is every route the shipped `dsh web` tree serves). Hand-declared gateway routes show a context window (from their configured or `defaultContextWindow` value) and no price.
- Price accuracy is bounded by the pinned pi-ai version: the rates are a point-in-time snapshot bundled with the package. Cost-view copy (separate plans) says "est." for this reason; the picker row shows the rate as a fact about what pi-ai shipped.
- `INVALID_MODEL_PRICING` is a new `LlmError` code. `LlmError.code` is an open string, so no union needed updating.
- Tiered pricing is dropped. A cost figure for a very large request will use the base rate. When a consumer needs tier accuracy, the fix is a `resolvePricing(provider, model, inputTokens)` method, not the static field.
- An OpenRouter route now shows its remaining credit balance in the picker group header. `buildModelCatalog` gains one bounded outbound request per OpenRouter provider per 60 seconds; the 4-second timeout and cache keep it off the catalog's critical path. Non-OpenRouter providers make no such request.
- `ACCOUNT_QUERY_FAILED` is a new `LlmError` code, raised inside `account.ts` and swallowed by `buildModelCatalog`; it does not surface to the browser.
- The "Turn usage" panel now shows an estimated dollar cost when the turn's route logged rates. `request/context` payloads gain an optional `pricing` object; recorded keyless snapshots and both SDKs' expected outputs that include a `request/context` event must be re-recorded. That re-record needs `DEEPSEEK_API_KEY` and is deferred; until it runs, `pnpm run test:snapshot` and `pnpm run test:expected` will show a diff on affected fixtures on this fork.
- `deriveTurnTokenUsage` now reads `request/context` events from its input slice (it previously ignored them). A caller that filters them out loses the cost estimate but nothing else.
- The durable `tokenUsage` projection's `stateVersion` goes 2 → 3. Pre-release policy re-folds it; there is no migration. Its wire view gains optional `costUsd` and `byRoute` — SDK expected outputs that assert the `tokenUsage` view need the same keyed re-record as the `request/context` change.
- A `/cost` command is deferred; `plans/005-session-cost-rollup.md` (in the session scratchpad, not the repo) has the spec if it is wanted later.
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
- `packages/llm/token-meter/tests/pricing.spec.ts` — `costOf` bucket arithmetic, including all-zero rates and buckets.
- `packages/llm/token-meter/tests/turn-usage.spec.ts` — a single-route turn priced from its logged rates, `costUsd` omitted when the route logged none, and per-route summing across two steps on differently priced routes.
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` — `request/context` carries `pricing` when the adapter resolved it and re-logs on a rate change.
- `packages/client/ui-chat/tests/turn-usage-disclosure.client.spec.tsx` — the `Cost` row renders with `(est.)` only when `costUsd` is present.
- `packages/llm/token-meter/tests/token-usage-projection.spec.ts` — the session projection derives `costUsd` and `byRoute` from logged rates, keeps `totals` unchanged, and omits the session `costUsd` while still listing a route that logged none.
- `packages/client/ui-chat/tests/chat-stats.client.spec.tsx` — `StatsLine` appends the estimated-cost group only when the projection resolved a `costUsd`.
