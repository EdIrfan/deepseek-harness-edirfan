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

## Unit choice

接缝与 wire 类型都以**每一百万 token 美元**报价，这既是 pi-ai 目录本就使用的单位（pi-ai 自己的成本计算里是 `rates.input / 1_000_000 * usage.input`），也是价格营销时使用的单位。存每百万可避免在适配器处做有损的 `/ 1e6`，让数字在测试和诊断里保持人类可读，并与成本视图将渲染的形式一致。

## Alternatives considered

**把接缝值存为每 token 美元。** 否决。pi-ai 提供的是每百万，所以每 token 会迫使适配器做一次除法，向浮点损失精度，并产生像 `2.7e-7` 这样在测试断言或日志诊断中不可读的值。每百万可原样透传，读起来就像人类报价。

**把定价放到既有的 `LlmImageRequestPricing` 接缝上。** 否决。该接缝按测量为一次图像出现计价，为实时上下文计量表同步无 I/O 地解析；每 token 文本费率是另一回事，生命周期也不同（随模型目录解析一次，而非每请求）。让它承载两个无关消费方会造成耦合。

**在 `api-remotes` 里另建一份 `ModelCatalog` 类型，而非重导出 session-controller 的那份。** 否决。只有一处定义，在 `packages/api/session-controller/src/types.ts`，为浏览器重导出。只在一处加字段，能防止 Host 构建器与客户端渲染器漂移。

**把上下文窗口与价格渲染为两条堆叠的行。** 暂时否决。需求是「塞进每一行且不难看」；一条 12px、以 ` · ` 连接的说明行在现实取值下能容下两者。若未来新增项（额度、第三个数字）撑爆它，那就是切换到两列 meta 布局的触发点——已记录在 `plans/README.md`。

**去掉全零守卫，把 `NO_COST` 当作 `{0,0,0,0}` 定价上报。** 否决。手工声明的网关路由确实没有价格数据；显示 `$0 / $0` 会断言它是免费的。无定价则不渲染价格文本，这才是诚实的状态。

## Consequences

- 选择器立即为每条 pi-ai 目录路由（也就是随附 `dsh web` 组合服务的每条路由）显示上下文窗口与价格。手工声明的网关路由显示上下文窗口（来自其配置的或 `defaultContextWindow` 值）且无价格。
- 价格准确性受限于固定的 pi-ai 版本：费率是随包附带的一个时间点快照。成本视图文案（独立计划）因此写「est.」；选择器行把费率当作「pi-ai 附带了什么」的事实来展示。
- `INVALID_MODEL_PRICING` 是新的 `LlmError` code。`LlmError.code` 是开放字符串，无需更新任何联合类型。
- 分层定价被舍弃。超大请求的成本数字会用基础费率。当某消费方需要分层准确性时，正确做法是一个 `resolvePricing(provider, model, inputTokens)` 方法，而非静态字段。
- 实施环境中没有 `DEEPSEEK_API_KEY`（仅 OpenRouter）；选择器行的 Web e2e 以及任何带密钥的快照重录被推迟，记录在 `plans/README.md`。单元、宿主集成与 React 组件测试覆盖了管道与渲染。

## Testing

- `packages/llm/llm/tests/service.spec.ts` —— `normalizeModelInfo` 原样透传合法定价，并以 `INVALID_MODEL_PRICING` 拒绝负值、非有限与 NaN 费率。
- `packages/llm/llm-pi-ai/tests/adapter.spec.ts` —— pi-ai 目录路由（`deepseek-v4-flash`）解析出每百万定价；手工声明路由解析不出。
- `packages/api/session-controller/tests/session-models.host.spec.ts` —— `buildModelCatalog` 把 `contextWindow` 与 `pricing` 带到 wire 模型上，并在适配器两者都没解析出时都省略。
- `packages/client/ui-model-selection/tests/format.spec.ts` —— 三个格式化器，含有损与往返的边界。
- `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` —— 有值的模型渲染出 `.modelMeta` 行的上下文与价格，无值的模型则没有。
