# Agent Note: Model-picker metadata and cost visibility

Status: implemented

[English](2026-08-30-model-picker-metadata-and-cost-visibility.md) | 中文

## Problem

Web 模型选择器（composer 模型位与 `/model` 弹窗）只显示模型名称，别无其他。用户在同一网关的多条路由之间选择时，看不到各自的上下文窗口有多大、各个模型的价格是多少；「本轮用量」面板也只报告 token，没有金额。有两项 harness 本已掌握的事实在通往浏览器的路上被丢弃：

- pi-ai 适配器会把每个模型的上下文窗口解析到 `LlmResolvedModelInfo.context.contextWindow`，但 `buildModelCatalog` 只把 `id`/`name`/`description`/`reasoning` 复制进 wire 模型。
- pi-ai 随其内置模型目录附带真实的每 token 价格（`Model.cost`，单位是每百万 token 美元）。适配器从未把它们复制到已解析信息上，`LlmResolvedModelInfo` 也没有承载价格的字段，因此没有任何消费方——目录、轮次计量或会话汇总——能显示成本。

## Decision

**模型信息接缝携带价格，目录携带上下文窗口与价格。** `LlmResolvedModelInfo` 新增可选的 `pricing: LlmModelPricing`（四项每百万 token 美元费率：input、output、cache-read、cache-write）。`LlmService.normalizeModelInfo` 在适配器结果边界校验它——每项费率有限且非负，否则 `INVALID_MODEL_PRICING`——并在既有的 `context` 校验旁把一份分离的结构复制到已解析信息上。pi-ai 适配器的 `modelInfo()` 直接透传 `Model.cost`（pi-ai 的单位本就是每百万 token 美元）；全零成本——即手工声明路由的 `NO_COST`——解析为无定价，因为零表示「没有答案」而非「免费」。价格分层（`ModelCost.tiers`）被压平为基础费率：随请求规模变化的定价尚无消费方。

`buildModelCatalog` 不再丢弃 `resolved.context.contextWindow`，现在也映射 `resolved.pricing`。`ModelCatalogModel` 新增 `contextWindow?: number` 与 `pricing?: ModelPricing`，两者都通过 `@deepseek-ai/dsh-api-remotes` 重导出给浏览器。

**选择器行在一条紧凑的次要文本行上同时显示两者。** `ui-model-selection` 在 composer 位模型面板的每个模型名下渲染一行 `.modelMeta`，各部分以 ` · ` 连接：`200K context · $0.14 / $0.28 /Mtok`。`/model` 弹窗把相同的部分追加到每行的 `detail` 字符串。两者都没解析出的模型不渲染第二行。`format.ts` 拥有格式化器：`formatTokenCount`（`128000` 变为 `128K`，`1_500_000` 变为 `1.5M`）、`formatPricePerMTok`（`0.14` 变为 `$0.14`，`2` 变为 `$2`，不足一分保留到四位小数）与 `formatPricePair`。

**定价仅用于呈现，绝不进入模型请求。** 选择器面这些界面不新增 session 事件（`packages/client/AGENTS.md`：「只关乎『如何绘制』的东西不进入 session 日志」）。下游的每轮与每会话成本视图（独立计划）确实会把费率记录在既有的 `request/context` 事件上，那是增量式的，不移动 `SESSION_FORMAT_VERSION`。

**预付余额计费的提供方路由会上报余额，分组标题显示它。** `LlmAdapter` 基类新增可选的 `providerAccountBalance(provider, signal)`；`LlmService.providerAccountBalance` 委托给它，对未注册路由或未实现该查询的适配器回答 `undefined`。pi-ai 适配器只为 OpenRouter 实现：当路由端点 host 为 `openrouter.ai` 时，通过与请求相同的 `resolveApiKey` 解析路由密钥，并经共享的 `readBoundedText` 读取 `GET https://openrouter.ai/api/v1/key`（`limit_remaining` 与 `usage`）；其他 host 一律解析为 `undefined`。`buildModelCatalog` 在 60 秒进程缓存与每次 4 秒超时之下按分组折叠出一个 `ModelProviderGroup.account`，包在 `try/catch` 里——任何失败都当作「无 account」，因为余额只是装饰，分组必须能在没有它时加载。`ui-model-selection` 在 `/model` 弹窗与 composer 模型面板里于分组名旁渲染 `$12.40 left`。OpenRouter 的 `/key` 端点本身不按 token 计费，所以这次查询零成本。

## Unit choice

接缝与 wire 类型都以**每一百万 token 美元**报价，这既是 pi-ai 目录本就使用的单位（pi-ai 自己的成本计算里是 `rates.input / 1_000_000 * usage.input`），也是价格营销时使用的单位。存每百万可避免在适配器处做有损的 `/ 1e6`，让数字在测试和诊断里保持人类可读，并与成本视图将渲染的形式一致。

## Alternatives considered

**把接缝值存为每 token 美元。** 否决。pi-ai 提供的是每百万，所以每 token 会迫使适配器做一次除法，向浮点损失精度，并产生像 `2.7e-7` 这样在测试断言或日志诊断中不可读的值。每百万可原样透传，读起来就像人类报价。

**把定价放到既有的 `LlmImageRequestPricing` 接缝上。** 否决。该接缝按测量为一次图像出现计价，为实时上下文计量表同步无 I/O 地解析；每 token 文本费率是另一回事，生命周期也不同（随模型目录解析一次，而非每请求）。让它承载两个无关消费方会造成耦合。

**在 `api-remotes` 里另建一份 `ModelCatalog` 类型，而非重导出 session-controller 的那份。** 否决。只有一处定义，在 `packages/api/session-controller/src/types.ts`，为浏览器重导出。只在一处加字段，能防止 Host 构建器与客户端渲染器漂移。

**把上下文窗口与价格渲染为两条堆叠的行。** 暂时否决。需求是「塞进每一行且不难看」；一条 12px、以 ` · ` 连接的说明行在现实取值下能容下两者。账户余额出于同样原因放进分组标题而非行内。若未来行内新增项撑爆说明行，那就是切换到两列 meta 布局的触发点。

**去掉全零守卫，把 `NO_COST` 当作 `{0,0,0,0}` 定价上报。** 否决。手工声明的网关路由确实没有价格数据；显示 `$0 / $0` 会断言它是免费的。无定价则不渲染价格文本，这才是诚实的状态。

**把 OpenRouter 余额查询放进 pi-ai 专属的 `ctx.piAiAccounts` 服务，而非 `LlmAdapter` 方法。** 否决。接缝是提供方无关的，即便今天只实现了 pi-ai 的 OpenRouter 分支；Together 或 Fireworks 的余额只是 `account.ts` 里多一个 `host ===` 分支，而非新服务。`session-controller` 去够 pi-ai 专属服务也会是适配器方法所避免的分层倒置。

**用定时器轮询余额，或推送更新。** 否决。目录重建时值就会刷新——每次 `llm/adapters-updated`、`settings/document-updated` 与 `credentials/reference-updated` 事件，加上每次菜单打开——对缓慢变动的预付余额已足够频繁。定时器会花费请求去让一个装饰保持新鲜。

**余额低时阻塞 composer。** 否决。这个界面只做展示，不做闸门。余额耗尽会让下一个请求以提供方自己的错误失败，那才是它该归属的地方。

## Consequences

- 选择器立即为每条 pi-ai 目录路由（也就是随附 `dsh web` 组合服务的每条路由）显示上下文窗口与价格。手工声明的网关路由显示上下文窗口（来自其配置的或 `defaultContextWindow` 值）且无价格。
- 价格准确性受限于固定的 pi-ai 版本：费率是随包附带的一个时间点快照。成本视图文案（独立计划）因此写「est.」；选择器行把费率当作「pi-ai 附带了什么」的事实来展示。
- `INVALID_MODEL_PRICING` 是新的 `LlmError` code。`LlmError.code` 是开放字符串，无需更新任何联合类型。
- 分层定价被舍弃。超大请求的成本数字会用基础费率。当某消费方需要分层准确性时，正确做法是一个 `resolvePricing(provider, model, inputTokens)` 方法，而非静态字段。
- OpenRouter 路由现在在选择器分组标题显示其剩余额度余额。`buildModelCatalog` 每个 OpenRouter 提供方每 60 秒新增一次有界外发请求；4 秒超时与缓存让它不进入目录的关键路径。非 OpenRouter 提供方不发这类请求。
- `ACCOUNT_QUERY_FAILED` 是新的 `LlmError` code，在 `account.ts` 内抛出、被 `buildModelCatalog` 吞掉；不会浮现到浏览器。
- 实施环境中没有 `DEEPSEEK_API_KEY`（仅 OpenRouter）；选择器行的 Web e2e 以及任何带密钥的快照重录被推迟。单元、宿主集成与 React 组件测试覆盖了管道与渲染。
- OpenRouter 余额查询需要真实密钥与网络才能端到端演练；随附测试对 `fetch` 打桩，绝不断言真实密钥值。
- `resetAccountCacheForTests()` 是 `catalog.ts` 上仅供测试的导出，让一个测试套件第二次 `buildModelCatalog` 重新查询而非复用 60 秒缓存。

## Testing

- `packages/llm/llm/tests/service.spec.ts` —— `normalizeModelInfo` 原样透传合法定价，并以 `INVALID_MODEL_PRICING` 拒绝负值、非有限与 NaN 费率；`providerAccountBalance` 委托给适配器，并对未实现或未注册的路由回答 `undefined`。
- `packages/llm/llm-pi-ai/tests/adapter.spec.ts` —— pi-ai 目录路由（`deepseek-v4-flash`）解析出每百万定价；手工声明路由解析不出。
- `packages/llm/llm-pi-ai/tests/account.spec.ts` —— `openRouterAccountBalance` 读取 `limit_remaining`/`usage`，对非 OpenRouter 或无密钥路由不调用 `fetch` 即返回 `undefined`，并在 401 / 中止时抛出 `ACCOUNT_QUERY_FAILED` / `ABORTED`。
- `packages/api/session-controller/tests/session-models.host.spec.ts` —— `buildModelCatalog` 把 `contextWindow` 与 `pricing` 带到 wire 模型上，并在适配器两者都没解析出时都省略；已解析的 `account` 随其分组，抛错的余额查询仍产出完整分组，没有余额查询的提供方不带 `account`。
- `packages/client/ui-model-selection/tests/format.spec.ts` —— 四个格式化器，含有损与往返的边界。
- `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` —— 有值的模型渲染出 `.modelMeta` 行的上下文与价格，无值的模型则没有；目录解析出余额时分组标题显示账户余额。
