# coding-agent-config-kit：第一版技术设计草案

状态：v0.1 已按本文实现（六个适配器、端到端计划/提交/恢复、103 项自动化测试、macOS/Windows/Linux CI），**尚未完成真实 Agent 版本的兼容性验收**；第 9 节的适配验证任务仍需执行。本文区分**已确定的产品/安全契约**与**实现前需要验证的适配细节**。第一版使用 TypeScript，面向 Node.js 本地文件系统；平台范围为 macOS、Windows 与 POSIX（Linux 等）；上层账号切换应用是主要使用者。

## 1. 目标与边界

提供一条统一流程：用供应商凭据查询可用模型（允许自定义模型端点）→ 用 models.dev 和显式覆盖逐字段补全模型能力 → 按目标 Coding Agent 的原生格式规划直连配置 → 执行 add-on → 展示脱敏预览 → 检查冲突并安全提交。

第一版支持 Claude Code、Codex、Gemini CLI、OpenCode、Pi、DeepSeek Harness 的**用户级配置**；支持目标 Agent 通过环境变量改变配置目录的情况。是否能接入取决于供应商的实际推理协议和目标 Agent 的原生支持，不在 SDK 内实现协议转换代理。目标 Agent 的项目级配置、启动参数和环境变量可供生效性判断，但第一版不修改项目级配置。

平台支持 macOS、Windows 与 POSIX（Linux 等）。三类平台各自验收原子替换、权限、符号链接/目录联接与锁行为，不把 POSIX 的结论外推到 Windows；Windows 上 Node.js 无法完整表达 POSIX 权限位与目录同步，须有明确等价策略或书面降级说明。

上层应用保管账号、密钥和当前账号状态。SDK 不提供账号数据库、订阅登录、OAuth 令牌迁移、代理服务或跨 Agent 的统一事务。

**硬边界：单次操作只作用于一个 Coding Agent 目标**（DeepSeek Harness 还需指定一个 profile）。`resolveAndPlan()`、`apply()`、`inspectRecovery()`、`recover()` 都只接受单个目标；SDK 不提供批量规划、批量提交、跨目标协调、跨目标锁或多目标恢复。上层若要修改多个 Agent 的配置，必须逐目标调用，自行决定顺序、并发和部分失败的处理；SDK 只对单个目标内部的结果负责，不承诺多个目标之间的一致性或可回滚。某个目标的提交失败不改变其他目标已完成的提交；上层可以对其余目标继续调用，也可以对已完成的目标重跑（同一计划内容重复应用应为幂等）。

**“配置写入成功”不等于“当前运行会话切换成功”或“该 Key 可调用所选模型”。** 结果须分别报告文件变更、模型能否在目标 Agent 中被选择、默认模型是否改变、当前连接是否改变，以及其他配置层覆盖的可能性。

## 2. 第一版直连矩阵（拟实现，须以实际 Agent 版本验收）

| Agent | 拟支持的原生推理协议 | 主要写入范围 | 凭据落地（首选 → 备选） | 覆盖层（高 → 低，待版本核对） | 注册与激活关系 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Anthropic Messages 兼容 | `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下 `settings.json` 的 `env` 块与受支持字段 | `external-env`（`ANTHROPIC_AUTH_TOKEN` 由调用方启动注入）→ `agent-file`（允许；明文写入受限 `settings.json`，按敏感字段处理） | 企业 managed settings → 启动环境/CLI → 项目 `.claude/settings.local.json` → 用户 `settings.json` | 无供应商注册表，切换即改当前连接；默认模型为多槽（`ANTHROPIC_MODEL` + OPUS/SONNET/HAIKU） |
| Codex | OpenAI Responses 兼容 | `CODEX_HOME/config.toml` 的 `[model_providers.<id>]`、`model_provider`、`model`；必要时模型目录 | `env-reference`（`env_key`）→ `agent-file`（仅经验证且非官方登录位置） | CLI `-c`/profile → 项目 `.codex/config.toml` → 系统配置 → 用户 `config.toml` | 注册 provider 与选择当前 provider 分开；不改写官方 `auth.json`/keyring |
| Gemini CLI | Gemini 原生 API | `GEMINI_CLI_HOME/.gemini/settings.json` 与同目录 `.env` | `env-reference`（settings/`.env` 引用 `GEMINI_API_KEY`）→ `external-env` | 系统 settings → workspace settings → 用户 settings；启动环境变量 | 更偏当前连接；`GOOGLE_GEMINI_BASE_URL` 不是 OpenAI 协议转换器 |
| OpenCode | OpenAI Chat Completions、Responses、Anthropic 兼容 | 用户级 `opencode.json` / `opencode.jsonc`（V1 `provider` / V2 `providers`） | `env-reference`（`{env:…}` 引用，按格式版本核对）→ `external-env` | 项目 `opencode.json(c)` → 全局 XDG 目录；`OPENCODE_CONFIG`/CLI 参数（待核对） | 供应商/模型与默认模型分开；先探测已装版本与文件形状 |
| Pi | OpenAI Chat Completions、Responses、Anthropic Messages、Google Generative AI | `PI_CODING_AGENT_DIR/models.json`；内置 add-on 可修改 `settings.json` | `env-reference`（`apiKey: "$VAR"`，原生支持）→ `agent-file`（字面 `apiKey`，敏感） | CLI `--provider`/`--model` → 项目配置 → 用户 agent 目录 | 基础流程注册模型；默认模型由 add-on 负责，需检查 `enabledModels` |
| DeepSeek Harness | OpenAI Completions、Responses、Anthropic Messages | 只写指定 profile 的 `DSH_HOME/profiles/<profile>/cordis.patch.yml`；home 层不写，仅作为更高优先层检测 | `env-reference`（原生 `SECRET_…` 命名引用）→ 经验证的其它位置 | `--patch` → `DSH_HOME/cordis.patch.yml`（home 层，outranks profile）→ profile patch；profile 由 `--profile` 选择 | 仅处理明确指定的 profile；默认模型是 `agent-default-model` 具名条目 |

这里的“支持协议”要求**实际推理请求**兼容，并非模型目录接口长得像 `/models` 即可。若供应商只提供 Chat Completions 而目标为 Codex，规划时报 `UNSUPPORTED_PROTOCOL`；不将其悄悄改成 Responses。各 Agent 对自定义目录、认证优先级和配置格式的细节须以官方文档、真实版本及隔离目录实测确认。若某 Agent 只能通过改动当前连接实现直连，预览须展示这个效果；原默认模型在新连接下不可用时，应阻止不可运行的组合并提示启用默认模型 add-on 或由调用方显式处理。表中的“覆盖层”只用于生效性判断，不是 SDK 的写入范围；凭据落地方式以对应版本实际支持为准。

## 3. 公开 API 草案

下面是交互形状，不是已经发布的 TypeScript 类型或稳定字段名。

```ts
const kit = createConfigKit({
  ownerId: "my-switcher", // 上层应用的稳定 ID，不是账号 ID
  resolveCredential: async (ref) => accountStore.resolve(ref),
  addons: [
    defaultModel({
      modelId: "deepseek-4.1-flash-company",
      // 仅 Claude Code 等支持多槽默认模型的 Agent 使用；未给出的槽位沿用 modelId
      claudeCode: { slots: { opus: "deepseek-4.1-flash-company" } },
    }),
  ],
});

const plan = await kit.resolveAndPlan({
  agent: "pi",
  target: {
    configDir: "/absolute/path/to/pi-agent", // 可选，优先于 launchEnvironment
    launchEnvironment: { PI_CODING_AGENT_DIR: "/absolute/path/to/pi-agent" },
    // projectDir 与 agentVersion 可选，仅辅助检查生效性和兼容性
    // configFormat 用于 V1/V2 并存的 Agent（如 OpenCode）："v1" | "v2"
    // versionProbe 默认关闭；提供 { executable: "/abs/path" } 才允许该 Agent 的白名单探测
  },
  provider: {
    id: "company-deepseek", // 目标 Agent 中稳定的具名供应商 ID
    protocol: "openai-completions",
    baseUrl: "https://api.example.com/v1", // 推理地址
    credential: {
      source: { kind: "reference", id: "account-123" },
      // 三选一：env-reference（写变量引用）| external-env（仅启动注入）| agent-file（写受限文件）
      placement: { kind: "env-reference", envVar: "COMPANY_DEEPSEEK_KEY" },
    },
  },
  models: {
    discovery: {
      endpoint: { kind: "protocol-default" }, // 或 absolute-url / relative-path
      responseFormat: "openai-model-list", // 或 anthropic-model-list / google-model-list / 自定义解析器
      credential: { kind: "use-provider" }, // 或 { kind: "reference", id } 指向独立凭据
      network: {
        allowPrivateNetwork: false,
        allowedHosts: [], // 显式允许的自部署/内网端点
        timeoutMs: 10_000,
        maxResponseBytes: 2_000_000,
        maxPages: 50,
      },
    },
    fallbackIds: ["deepseek-4.1-flash-company"],
    aliases: {
      "deepseek-4.1-flash-company": "deepseek/deepseek-4.1-flash",
    },
    metadataProvider: "deepseek", // models.dev 命名空间；缺省时只在能唯一确定时匹配
    metadataSource: "snapshot", // 默认快照；"live" 需显式开启并受网络策略约束
    overrides: {
      "deepseek-4.1-flash-company": { contextWindow: 64_000 },
    },
    metadata: "write", // 默认；另有 suggest、ignore
    sync: "incremental", // 默认；strict 默认禁用
    unknownCapabilities: "warn", // warn（默认）| block
  },
  ownership: {
    adopt: ["legacy-company"], // 接管同名未受管的供应商/模型条目
    adoptCredentialFields: ["company-deepseek.apiKey"], // 仅在预览展示脱敏变更后接管凭据字段
  },
});

// 生命周期操作可与注册同一次规划，也可单独调用（此时省略 provider）：
await kit.resolveAndPlan({
  agent: "pi",
  target: { configDir: "/absolute/path/to/pi-agent" },
  lifecycle: {
    removeProviders: ["old-provider"], // 只删除本 ownerId 持有的条目
    unsetDefaultModel: true,
  },
});

show(plan.preview);
const outcome = await kit.apply(plan);
```

另有 `inspectRecovery(target)`（只读）和 `recover(target, { mode: "auto" | "complete" | "restore-old" | "break-stale-lock" })`（显式处理未完成提交）。一次规划至少给出 `provider` 或 `lifecycle` 之一；两者同时存在时，注册与删除在同一预览中展示。这些入口都只接受单个 `target`，API 不提供任何接受目标数组、Agent 列表或批量描述符的重载；也没有跨目标锁或「全部应用」方法。计划持有仅内存的凭据材料，应提供 `dispose()` 并在规划后过期；不持久化、不跨进程传递。`resolveAndPlan()` 可发起网络请求，但对目标配置目录保持只读；发现待恢复操作时返回 `RECOVERY_REQUIRED`，不暗中修改文件。计划由创建它的 SDK 实例持有，不承诺跨进程序列化或复用；`preview` 是单独的可展示、可序列化、脱敏数据。`apply()` 不重新运行 add-on、模型发现或从网络刷新元数据；外部文件或凭据变更会使计划失效，需重新规划。

上层必须**显式选择凭据落地方式**，三选一：

- `agent-file`：SDK 把含密钥的值写入 Agent 原生文件，文件以受限权限创建/替换（POSIX `0600`，Windows 依赖用户目录 ACL），该字段按敏感字段管理。
- `env-reference`：SDK 只在原生配置里写变量名（Codex `env_key`、Pi `apiKey: "$VAR"`、DSH 的 `SECRET_…` 命名引用等），值由上层在启动目标 Agent 时注入。
- `external-env`：SDK 不写密钥或引用，完全由上层在启动环境注入；Claude Code 的 `settings.json` `env` 块不能引用变量，通常只能用这种方式。Claude Code 也允许 `agent-file`：选择它即接受明文 Key 落在 `settings.json`，预览必须标注明文与文件权限。

若该 Agent 不支持所选方式，规划失败。`target.configDir` 必须与 `launchEnvironment` 中该 Agent 的目录变量指向同一位置，不一致报 `TARGET_ENV_MISMATCH`。`env-reference` / `external-env` 指定的变量须在启动环境中存在（只检查键，不读值），否则报 `ENV_REFERENCE_UNRESOLVED`。SDK 不扫描、覆盖或迁移官方登录令牌。规划时若模型发现需要 Key，通过回调临时取得；应用时再次解析并确认仍是同一凭据版本（若上层提供版本号），否则使用仅在内存中存在的短期校验材料核对。计划、预览、管理记录及普通日志不包含明文 Key，也不保存长期密钥指纹。含密钥的原生文件以及提交恢复记录可能含明文，因此必须限制权限、避免日志泄露，并在提交完成后清理恢复记录。

`Plan.preview` 至少应包含（并带 `previewSchemaVersion`）：解析后的路径、脱敏的文件/语义改动、模型 ID 和每个能力字段的来源、models.dev 数据来源（快照 `generatedAt` / live 请求时间）、模型发现状态及完整性、被跳过的能力字段和原因、`CAPABILITY_UNKNOWN` 警告与目标 Agent 将套用的默认值、所有权/严格同步删除项、生命周期删除项、凭据落地方式与环境检查结果、覆盖层清单与逐层判定、更新前后默认模型与当前连接的变化、阻断错误及非阻断警告。`ApplyResult` 表示实际改动的文件、已提交效果、恢复结果；失败时区分 `unchanged`、`restored`、`locked`、`recovery-required`、`manual-intervention`。预览不是一个可绕过验证直接提交的补丁文件。

## 4. 模型发现、匹配和能力投影

**发现端点**与**推理端点**分离。发现器内置三种响应格式，默认路径按协议确定：

- `openai-model-list`：`GET {baseUrl}/models`（baseUrl 通常已含 `/v1`），Bearer 认证，读取 `data[].id`；响应没有分页标记，`completeness` 最多为 `unknown`。
- `anthropic-model-list`：默认 `GET https://api.anthropic.com/v1/models`（自定义 baseUrl 的拼接规则由 URL 构造器定义并测试），`x-api-key` + `anthropic-version`，支持 `has_more` / `last_id` 分页。
- `google-model-list`：默认 `GET https://generativelanguage.googleapis.com/v1beta/models`，使用 `key` 查询参数或 `x-goog-api-key`，支持 `nextPageToken` 分页。

调用方也可指定绝对 URL、或显式表示相对推理 `baseUrl` 的路径（`/v1` 等前缀的拼接规则须在 URL 构造器中定义并测试），或提供只返回规范化模型条目的解析器。发现结果返回 `available` / `unsupported` / `failed`、`completeness: "complete" | "partial" | "unknown"`、认证方式、数据时间、是否取全分页、是否使用了后备 ID；不能把“端点列出模型”表述成“该 Key 已成功推理”。`fallbackIds` 仅在发现失败或结果为空时作为候选集合写入，不与成功结果合并；其能力标 `unknown` 并提示。未发现模型且无 `fallbackIds` 时失败；用了后备 ID 要标记“未验证当前 Key 的模型可用性”。

发现请求的认证由 `discovery.credential` 决定：`use-provider` 表示同源时按协议规则使用供应商凭据（OpenAI `Authorization: Bearer`、Anthropic `x-api-key`、Google 的 `x-goog-api-key` 或 `key` 查询参数），跨源默认不传；需要跨源时必须显式给出独立的凭据来源。含凭据请求不自动跟随跨源重定向，并设置超时、响应体大小和分页上限；错误与日志不输出请求头或 Key。自部署/内网端点通过 `network.allowedHosts` 与 `allowPrivateNetwork` 显式允许；`network` 还应容纳代理与自定义 CA 的配置入口。models.dev 的公共目录请求**绝不携带供应商凭据**，并只在本地按命名空间匹配 ID。

每个模型分别保留：

```ts
interface ResolvedModel {
  requestId: string;      // Agent 给供应商发送的 ID，始终保留别名
  metadataId?: string;    // models.dev 的匹配 ID，仅用于能力查询
  displayName: string;
  capabilities: {
    contextWindow?: Sourced<number>;
    maxOutputTokens?: Sourced<number>;
    reasoning?: Sourced<boolean>;
    reasoningEfforts?: Sourced<string[]>;
    inputModalities?: Sourced<string[]>;
    toolCalling?: Sourced<boolean>;
  };
}
```

`Sourced<T>` 记录值、`user` / `provider` / `models.dev` 来源及适用的数据时间。用户显式覆盖 > 供应商明确返回 > models.dev > 未知，逐字段决定，而不是整条模型相互覆盖。别名映射以 `requestId` 为键，仅用于查元数据。models.dev 匹配按以下顺序，**跨命名空间不猜**：显式别名中的 models.dev ID（含 `vendor/` 前缀）> 调用方 `metadataProvider` 命名空间内的精确或唯一匹配 > 全库唯一候选；多个候选不唯一时标 `unresolved`，不自动选择。默认 `metadata: "write"`：只写目标 Agent 能表达且校验通过的能力。`suggest` 只在预览展示补全值，`ignore` 不使用 models.dev。models.dev 数据缺失或过期时，已有的可靠供应商字段和显式覆盖仍有效；快照须展示 `generatedAt`，live 模式默认进程内缓存且缓存过期不能静默当作实时数据；持久缓存不是必要依赖。

**models.dev 数据默认取自官方包的快照**：`@opencode-ai/models/snapshot`（MIT，ESM-only，`engines.node >= 18`）导出 `providers`、`models` 与 `generatedAt`，不发起网络请求，也不携带供应商凭据。快照随依赖版本发布，通常最多落后实时 API 约 24 小时；预览必须标明“快照”并展示 `generatedAt`，不得当作实时数据。**live 模式保留，但只能由调用方显式开启**；快照过期不会自动触发联网，`generatedAt` 只用于展示与告警。调用方显式设置 `metadataSource: "live"` 时，SDK 才用 `Models.make({ baseUrl, fetch, headers })` 调 `catalog()` 取实时数据（错误统一为 `ModelsDevError`：`Transport` / `UnexpectedStatus` / `MalformedResponse`），失败可回退快照但必须标明回退与时间。代理、测试桩与超时通过 `fetch` 或 `signal` 注入。匹配与能力投影仍由本 SDK 完成。依赖固定到已验证版本并写入锁文件；快照入口解包后数 MB，安装体积敏感时另行评估。

**费用字段例外**：models.dev 价格可供展示，但默认不写入 Agent 的费用字段；仅在供应商明确返回价格或调用方显式覆盖时写入。原厂公开价格不必然等于自部署或转售价格。

**能力不等于请求参数**：`reasoning: true` 不足以推出 `low/high` 档位，更不能推断某个兼容端点接受哪种 thinking 请求体。模型的能力字段可以按默认策略投影；请求协议特有的兼容参数，只有适配器有明确规则或上层显式提供时才写入。不支持的模态/字段标为 `not-projectable`，不能偷偷强塞 Agent 配置。来源未知的必填字段返回 `REQUIRED_MODEL_FIELD_MISSING`，不凭空编造数值。

**Pi 的默认值陷阱（已核对官方文档）**：`contextWindow` 默认 128000、`maxTokens` 默认 16384，Pi 不会因缺字段而报错。来源未知时 SDK 不写这两个字段，但必须发出 `CAPABILITY_UNKNOWN` 警告，并在预览列出即将生效的 Agent 默认值；`unknownCapabilities: "block"` 可升级为阻断，调用方也可用显式覆盖消解。另：`cost` 的 `input`/`output`/`cacheRead`/`cacheWrite` 必须同时齐全，费用整块写入或整块省略；`input` 只接受 `text`/`image`，models.dev 的 `pdf`/`audio` 标 `not-projectable`；`apiKey` 支持字面值、`"$VAR"` 与 `"!command"`，接管已有条目时按形式比较，不能把 `!command` 静默改成字面值；第一版不写 `modelOverrides`（它修改的是内置模型），只写 `providers.<id>.models`。

显式数值覆盖不受 models.dev 所谓“上限”约束：自部署模型可能拥有不同能力。只对可证明无效的输入和目标格式进行阻断校验（例如非有限整数、负值、不合法模型 ID、目标 Agent 不支持的协议）；来源不一致、上下文窗口扩大等发警告。不能简单规定 `maxOutputTokens > contextWindow` 即错误：模型类别和目标字段语义不同。已知不支持的协议请求参数不得生成。

默认同步为 `incremental`：只增改本次指定供应商的模型，不因发现列表缺项而删模型。**`strict` 默认禁用**，必须由调用方显式选择，且同时满足：发现器 `completeness === "complete"`（`openai-model-list` 无法证明完整性，因此不能用于 strict）、未使用 `fallbackIds`、自定义解析器已声明并能证明完整性。删除范围只限当前 `ownerId` 已管理的模型，删除项进入预览，`apply()` 还需 `confirmDeletions: true` 才执行。任何一项不满足都报 `STRICT_SYNC_UNPROVEN` 或降级为 `incremental` 并警告，不静默删除。

## 5. Add-on 与适配器边界

内置 `defaultModel()` 是第一个 add-on，参数为 `{ modelId, claudeCode?: { slots?: { opus?, sonnet?, haiku? } } }`。基础操作不承诺改默认模型，但**连接本身**在部分 Agent 上无法只注册不激活；预览须明确报告。

- **Claude Code**：默认把 `ANTHROPIC_MODEL` 与 `ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL` 全部设为同一个模型；`claudeCode.slots` 可单独覆盖任一档，未给出的槽位沿用 `modelId`。首版只处理这四个字段；`ANTHROPIC_SMALL_FAST_MODEL`、`ANTHROPIC_REASONING_MODEL` 等历史变量按 `UNSUPPORTED_INTENT` 处理，不写。目标版本不支持某槽位时同样返回 `UNSUPPORTED_INTENT`，不静默忽略。
- **Pi**：处理 `settings.json` 中默认模型与 `enabledModels` 的相互约束；写入前检查 `enabledModels` 是否会把新默认模型排除。
- 其他 Agent 使用各自语义，不通过统一 JSON 路径假装字段等价。

Add-on 的输入为目标 Agent、适配器声明的能力（支持的槽位、字段白名单）、规范化模型及其来源、有限且脱敏的配置视图；输出是诊断、校验和适配器支持的**具名语义意图**（`setDefaultModel`、`removeProvider`、`removeModel`、`unsetDefaultModel` 等，可随适配器能力逐步增加），不是任意磁盘路径或原生文件的 JSON/TOML/YAML 路径。具体补丁由适配器规划，所有改动经过 SDK 的所有权检查、冲突检查、脱敏预览与统一提交。生命周期意图只能作用于 `ownerId` 持有的条目，未持有时报 `OWNERSHIP_CONFLICT` 并给出 `adopt` 选项。自定义 add-on 可以增加行为；基础的别名、能力取值和模型同步策略仍由显式参数控制。两个 add-on 修改同一语义目标时默认 `ADDON_CONFLICT`，只有调用方明确指定替换/优先级关系才能继续。对没有适配器实现的语义意图返回 `UNSUPPORTED_INTENT`，不静默忽略。

TS/JS add-on 是调用方加载的代码，SDK 只能约束**经自己提交的改动**，不能阻止它自己使用 Node 文件系统或网络 API。首版无需建立通用运行时沙箱。新增 Coding Agent 由内部适配器契约扩展：路径解析、格式识别、协议矩阵、语义意图投影、文件边界、生效性判断和测试夹具；待首批适配器稳定后再决定是否公开第三方适配器 SPI。

## 6. 配置目录、生效性与所有权

路径优先级：调用方传入的绝对 `configDir` > 调用方传入的**目标 Agent 启动环境**中该 Agent 对应的目录变量 > 该 Agent 的默认用户目录；SDK 进程自己的 `process.env` 不能冒充目标 Agent 的启动环境。DeepSeek Harness 另要求显式 profile。解析后的实际文件路径进入预览。若 `configDir` 与启动环境变量指向不同目录，规划阶段报 `TARGET_ENV_MISMATCH`，不写入。需要识别 symlink、目录联接、目录别名、非普通文件及敏感文件权限；目标文件默认拒绝符号链接，`realpath` 解析后仍须落在允许范围内，并用 `lstat` 比较类型/大小。Node 不暴露 `openat`/`O_NOFOLLOW`，规划与提交之间的 TOCTOU 窗口须在安全文档写明并尽量减少。创建目录时仅在目标 Agent 允许且用户已指定目标的情况下进行。

只修改 SDK 管理的字段并保留无关字段、注释及用户添加的模型；不能保真的 JSONC/TOML/YAML 内容或未知结构应拒绝修改，不做整文件“格式化修复”。**OpenCode 格式识别不能只看版本**：V1 与 V2 读取同一个 `opencode.json(c)`，V1 遇到 `providers` 键直接报错，V2 把 `provider` 标为 deprecated，且两个版本可能并存。识别顺序为：调用方显式 `configFormat: "v1" | "v2"` > 调用方提供的 `agentVersion`（或调用方显式提供 `versionProbe.executable` 后的白名单探测；默认关闭）> 文件形状证据。三者冲突、或检测到两个版本并存且无法确定读取方时，报 `TARGET_VERSION_CONFLICT`，不写入；仅预览时允许标 `unknown`。已知不兼容的格式阻止应用；仅未知可执行版本不自动等于不安全。适配器应声明已验证的版本/格式范围，未验证情况在预览可见，并按具体不能保真的结构而非版本猜测阻断。

对具名供应商和模型，`ownerId` 是上层应用的稳定 ID。SDK 在目标配置目录保存私有管理记录，包含 schema 版本、拥有的条目与**非敏感字段**的最后受管状态或校验信息；不把 SDK 私有字段塞进 Agent 原生文件。首次遇到同名但未受管的条目默认 `OWNERSHIP_CONFLICT`，显式 `adopt` 才能接管，并在预览逐字段列出。管理记录丢失或不一致时不凭名字猜所有权。外部修改受管字段时默认报冲突；外部添加的字段和模型保持原样。

**敏感字段不能靠持久化 Key 哈希检测外部修改。** 对需要替换的旧凭据，优先由上层提供上一账号的凭据引用/版本，以便规划时在内存核对目标文件。无法证明旧值属于本应用时，必须显式请求接管该凭据字段并展示脱敏变更；管理记录不保存明文 Key 或长期可识别的 Key 指纹。共享的当前路由及默认模型字段不凭名字获得所有权，每次按计划读取的旧值做比较；应用前任何文件变化都重新规划。多应用管理同一个目标目录时，SDK 锁提供相互协调，但不保证与不遵守锁的 Agent 进程串行。锁的作用域是**单个目标**：一次操作只锁该目标的文件与私有管理记录，不同目标的提交不共享锁，也不存在跨目标的加锁顺序或死锁规避。

配置文件可能被项目层、系统层、启动参数或运行中的会话选择覆盖。预览给出 `confirmed` / `may-be-overridden` / `unknown` 的**静态配置生效性**与理由；只有拿到足够的配置层信息才可能称为 `confirmed`，它也不证明端点能完成一次推理。缺少项目环境信息时不阻止正常规划，但须标 `unknown`。**“立即生效”只描述新会话**：运行中会话是否重新读取配置须按 Agent 验证，未验证时报告为“未知”，不得声称当前会话已切换。

### 生效性层

| Agent | SDK 写入层 | 更高优先层（须检测） |
| --- | --- | --- |
| Claude Code | 用户 `settings.json` | 企业 managed settings、启动环境/CLI 参数、项目 `.claude/settings.local.json` |
| Codex | 用户 `$CODEX_HOME/config.toml` | CLI `-c`、profile 选择、项目 `.codex/config.toml`、系统级配置 |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini/settings.json` | 系统 settings、workspace settings、启动环境变量、项目 `.env` |
| OpenCode | 用户级 `opencode.json(c)` | 项目 `opencode.json(c)`、`OPENCODE_CONFIG`、CLI 参数 |
| Pi | `$PI_CODING_AGENT_DIR/models.json` 与 `settings.json` | CLI `--provider`/`--model`、项目配置、启动环境变量 |
| DSH | 指定 profile 的 `cordis.patch.yml`（只写 profile 层） | `--patch`、`$DSH_HOME/cordis.patch.yml`（home 层优先于 profile 层） |

判定规则：`confirmed` 仅当所有更高优先层都已检查且确认不覆盖；检测到更高层但无法判断其内容 → `may-be-overridden`；缺少项目或系统层信息 → `unknown`。企业/系统层读取失败不得默认 `confirmed`。具体路径与优先级以对应 Agent 版本核对为准。

### 平台差异

- 路径与文件名：Windows 大小写不敏感，存在保留字符与 `MAX_PATH`；比较路径身份前先规范化，不比较原始字符串。
- 权限：POSIX 用文件模式（敏感文件创建即 `0600`，目录 `0700`）；Windows 无 POSIX 权限位，Node 只能有限映射。首版不调用 `icacls` 或原生 ACL API，密钥文件依赖用户目录继承 ACL；同用户进程可读的残余风险须写入安全文档。
- 符号链接/联接：两类平台都用 `lstat` 识别；目标文件默认拒绝链接，只有解析后仍在允许范围且调用方显式允许时才继续。
- 原子替换与持久性：POSIX 用同目录 `rename` + 文件/目录 `fsync`（macOS 需 `F_FULLFSYNC`，Node 未直接暴露）；Windows 的替换语义与目录同步不同，须单独实现并验收，不能据 POSIX 结果宣称持久化。
- 锁：Windows 的独占打开、崩溃后句柄释放与删除行为与 POSIX 不同，陈旧锁判定须分平台验证。

### 版本探测（默认关闭）

默认不执行任何外部命令。`target.versionProbe` 只在调用方提供**绝对可执行路径**时启用；SDK 不查 `PATH`、不经 shell，只允许该 Agent 的白名单命令，超时 2 秒、输出上限 4 KB、空 stdin、最小过滤环境。失败只把版本标为 `unknown`，不阻断规划。

| Agent | 允许的调用 |
| --- | --- |
| Claude Code | `<executable> --version`（默认二进制 `claude`） |
| Codex | `<executable> --version`（默认二进制 `codex`） |
| Gemini CLI | `<executable> --version`（默认二进制 `gemini`） |
| OpenCode | `<executable> --version`（默认二进制 `opencode`） |
| Pi | `<executable> --version`（默认二进制 `pi`） |
| DeepSeek Harness | `<executable> --version`（默认二进制 `dsh`） |

白名单只接受 `--version` 单个参数；`-v`、子命令和组合参数一律拒绝。解析失败或输出超限时不采信。DSH 的 `--version` 已在安装包中确认；其余命令以对应版本实测为准。

## 7. 提交、恢复与错误

一次操作的顺序：

1. `resolveAndPlan()` 读取目标文件和管理记录、记录原始字节/存在状态指纹；在内存完成网络发现、能力投影、add-on 意图和全部文件新内容，生成脱敏预览。规划不得修改目标配置目录。
2. `apply()` 按「锁协议」取得单目标锁，重读所有文件，检查指纹/所有权；确认凭据版本与规划一致；检查路径身份、symlink 和权限；有冲突就不写并要求重新规划。
3. 写入前先原子写入「恢复记录」；逐文件用 `O_CREAT|O_EXCL` 创建同目录临时文件、创建时即为目标权限（不是 chmod 后补）、写入后 `fsync`、再 `rename` 替换；失败路径删除临时文件；管理记录最后提交。具体操作系统上的断电持久性需实测，不能只因 `rename` 成功就宣称已持久化。
4. 普通异常时只对仍等于本次预期写入版本的文件恢复旧版；若外部已写成第三种内容，停止覆盖并报告 `manual-intervention`。进程/机器中断后的下次调用先识别恢复记录，`inspectRecovery()` 展示状态，`recover()` 在匹配旧版或本次新版本时恢复/完成；遇到第三方变更不自动覆盖。

### 锁协议（单目标）

在目标目录写 `.coding-agent-config-kit/lock`，以 `O_CREAT|O_EXCL`（Windows 为独占打开）原子创建，内容为 `{transactionId, pid, hostname, startedAt}`；创建后立即重读并校验内容，防止抢占竞态。同一目标的并发调用在本进程内排队等待（默认上限 5 秒，可配）；不同目标之间允许并发，锁、指纹与恢复记录互不共享。等待超时返回 `LOCK_TIMEOUT`，错误与 `inspectRecovery()` 给出持有者 `pid`/`hostname`、锁年龄与文件路径。

**默认不自动接管陈旧锁**：即使 `hostname` 不同或进程已不存在、且年龄超过阈值（默认 10 分钟），SDK 也只报告而不删除。只有调用方显式 `recover(target, { mode: "break-stale-lock" })`，并重新校验持有者不存活、年龄超阈值后，才移除锁并记录该动作。持锁期间的删除必须先确认内容仍是自己的 `transactionId`，不做盲 `unlink`。锁行为参考 `proper-lockfile` 的 stale/retry 思路，但不引入其运行时依赖。

### 恢复记录（WAL）

每个目标最多一条 `.coding-agent-config-kit/recovery.json`，在任何目标文件被写入前原子写入，状态机为 `prepared → committing → committed`。记录含 schema 版本、`transactionId`、目标身份、每个文件的期望旧/新内容哈希，以及恢复所需的旧内容或受限权限备份文件路径。恢复逐文件比较实际内容：等于旧版 → 跳过；等于新版 → 依据 `mode` 完成或回滚；第三种内容 → 停止并报 `manual-intervention`。提交成功后删除记录；记录超过 TTL（默认 1 小时，可配）且状态不明时不得自动回滚，`inspectRecovery()` 只报告并要求人工裁决；人工确认放弃恢复后同样删除记录。`recover(target, { mode })` 中 `auto` 按内容匹配，`complete` / `restore-old` 用于人工选择方向。

单文件替换的原子性不推出多文件事务原子性；跨文件提交与跨 Agent 提交均不作此保证；一次 `apply()` 只涉及一个目标，不把多个 Agent 合并进同一提交或同一恢复记录。DeepSeek Harness 的原生锁协议与多 profile 路径别名须在适配器中明确处理。恢复记录可能包含旧密钥：受限权限（`0600`）、短生命周期、无日志输出、成功后清理；含密钥的临时文件按同等敏感级别处理，失败路径必须删除。恢复记录、原生配置与备份中是否存在 Key 应写入安全文档；无法保证上层备份工具不会复制这些文件。

### 错误

稳定错误码先覆盖：`UNSUPPORTED_PROTOCOL`、`UNSUPPORTED_INTENT`、`MODEL_DISCOVERY_FAILED`、`REQUIRED_MODEL_FIELD_MISSING`、`CAPABILITY_UNKNOWN`、`STRICT_SYNC_UNPROVEN`、`OWNERSHIP_CONFLICT`、`ADDON_CONFLICT`、`CONFIG_CHANGED`、`RECOVERY_REQUIRED`、`LOCK_TIMEOUT`、`UNSAFE_TARGET`、`TARGET_VERSION_CONFLICT`、`TARGET_ENV_MISMATCH`、`ENV_REFERENCE_UNRESOLVED`、`CREDENTIAL_UNAVAILABLE`、`CREDENTIAL_MISMATCH`、`NETWORK_POLICY_DENIED`、`UNPARSEABLE_CONFIG`。错误对象至少含 `code`、`agent`、`phase`、`retryable`、`replanRequired` 与脱敏的路径/字段；不把响应体、认证头或密钥拼入异常消息。底层 IO/解析/网络错误再附脱敏原因；恢复失败须明确当前实际状态。

## 8. 实施次序与验收

先用 **Pi 纵向用例** 验证公共模型流水线和安全提交，再扩到其余五个适配器；不是先实现六套各自独立的账号切换器。

| 阶段 | 交付与验收重点 |
| --- | --- |
| 核心 | TypeScript 类型、三种内置发现格式的固定 fixture、默认 `@opencode-ai/models/snapshot` 与 `generatedAt` 标注、live 模式仅显式开启且快照过期不自动联网、models.dev 命名空间匹配与缓存、字段来源、受控 add-on 意图、脱敏预览；覆盖 `CAPABILITY_UNKNOWN`、`UNSUPPORTED_INTENT`、strict 默认禁用 |
| Pi | 隔离的 `PI_CODING_AGENT_DIR`：自定义 `/models` 返回别名 → 查元数据 → 保留请求 ID → 写供应商和模型；默认模型 add-on 检查 `enabledModels`；未知能力走警告并展示 Agent 默认值；费用整块写入/省略；`apiKey` 三种形式；不写 `modelOverrides` |
| Claude Code | 多槽默认模型（四字段全同，或单槽覆盖）；旧变量返回 `UNSUPPORTED_INTENT`；`external-env` 启动注入与 `agent-file` 明文落盘两种路径及文件权限；managed settings 检测；`settings.json` 不能引用变量时拒绝 `env-reference` |
| 安全提交 | 同目标排队与 `LOCK_TIMEOUT`；陈旧锁不自动接管、仅显式 `break-stale-lock`；恢复记录三态与 1 小时 TTL；临时文件创建即 `0600` 且失败清理；文件/管理记录冲突；同名条目不接管；凭据版本变更；外部第三种内容不自动覆盖 |
| 版本探测 | 默认关闭；仅绝对路径 + `<exe> --version`；无 shell、2 秒超时、4 KB 输出上限；失败降级 `unknown` |
| 平台 | macOS、Windows、Linux 分别验证原子替换、`fsync`/持久性、权限或 ACL、symlink/联接、锁；Windows 不调用系统 ACL API 的残余风险须记录；单平台结果不得冒充全平台 |
| 其余 Agent | 每个目标分别用真实版本及隔离 HOME/目录测试协议矩阵、字段投影、凭据方式、目录覆盖、当前连接副作用和项目/启动环境覆盖提示；OpenCode 双版本冲突、DSH home 层、Codex `env_key` 组合与 Gemini 认证状态各有用例；补齐不可保真配置的拒绝用例 |
| 单目标边界 | 传入多个目标或期望批量事务必须被拒绝；同一进程依次操作两个不同目标时，锁、指纹与恢复记录不得互相干扰 |

Pi 最小验收覆盖：ID-only `/models` 和完整能力响应、跨源自定义目录的凭据约束、分页不完整、models.dev 无匹配/过期、显式能力覆盖、费用不默认写、添加默认模型、二次应用幂等、严格同步只删本应用持有模型、规划后外部编辑冲突、进程中断恢复与锁超时。平台验收按上表执行，不能将单平台单测冒充全平台验收。

## 9. 实施前待核对的具体问题

以下为**适配验证任务**，不改变已定产品边界。已在 2026-11 初步核对（以公开文档与本机安装为据，仍须按固定版本实测）：Codex 现行版本已移除 `wire_api = "chat"`，仅支持 Responses；Gemini CLI 存在 `GEMINI_CLI_HOME` 并在其下创建 `.gemini`；Pi `models.json` 的字段与默认值与本文一致；OpenCode V1/V2 共用同一文件且 `providers` 键会让 V1 报错；DSH 的 home 层优先于 profile 层。

- 固定首批测试的 Agent 版本，逐项核对原生配置 schema、目录变量、环境/项目级优先级、凭据存储与默认模型选择；记录真实启动后的行为。
- Claude Code：核对企业 managed settings 的平台路径与优先级、`settings.json` 的 `env` 能否引用变量（预期不能）、四字段（`ANTHROPIC_MODEL` + 三档）的读取与覆盖关系、`agent-file` 明文文件的实际权限，以及 Bedrock/Vertex/Foundry 认证模式是否进入矩阵。
- Codex：核对 `env_key` 与 `requires_openai_auth`、`http_headers` 的组合，系统/项目配置路径，以及 `model_providers` 是否需要模型目录文件。
- Gemini CLI：核对不同认证状态（API Key / Google 登录 / Vertex）下自定义 base URL 是否真正生效、`.env` 加载优先级、`advanced.ignoreLocalEnv` 的影响。
- OpenCode：核对 V1/V2 并存的读取行为；版本探测默认关闭，确认 `opencode --version` 的输出格式（白名单已定）；确认 `{env:…}` 引用的具体语法。
- DSH：核对 profile 层写入的字段与注释保留、home 层的检测方式、原生秘密命名引用的准确形式、`agent-default-model` 条目的字段、原生锁协议与多 profile 路径别名。
- models.dev：锁定 `@opencode-ai/models` 版本；核对 snapshot 的 `providers`/`models` 形状与 `generatedAt`、live 模式回退路径、`ModelsDevError` 分类；确认许可证与再分发条款。验收须覆盖：live 仅显式开启、失败回退快照、回退标注、缓存与“快照过期不自动联网”。
- 确定各 Agent 的能力字段投影白名单，尤其 reasoning effort、输入模态、context/output 上限；只在对应版本行为得到确认后标记为可写入。
- 用文件级故障注入和真实 Agent 启动验证计划/应用结果，不仅比较生成文件的文本。
- 平台矩阵：在 macOS、Windows、Linux 上分别验证锁、原子替换、权限/ACL 与 symlink 行为，并记录每平台的已知限制。

## 10. 发布与版本化（拟）

- 包名 `coding-agent-config-kit`（不加 scope；2026-11-16 查询 npm registry 未被占用，发布前需再次确认）。若后续以组织身份发布，改用 `@scope/coding-agent-config-kit`，并在 1.0 前完成迁移。许可证 MIT；TypeScript 类型随包发布。
- Node.js `>= 20`。`@opencode-ai/models` 为 ESM-only，本包以 ESM 为首选入口；CJS 构建通过打包内联或动态 `import()` 兼容，不依赖 `require(esm)`。
- `previewSchemaVersion` 必填，起始值 `1`，随预览结构变更递增；错误码集合稳定。
- 0.x 阶段允许新增字段与错误码，不移除或改变既有语义；1.0 后再承诺严格 semver 兼容。
- 依赖固定到已验证版本并提交锁文件；升级 `@opencode-ai/models` 或 Agent 适配器时重跑对应夹具与平台验收。

## 参考资料

- [magpie](https://github.com/yetone/magpie)：模型能力来源与逐 Key 可见列表的处理；[模型规格实现](https://github.com/yetone/magpie/blob/main/internal/provider/modelspec.go)、[OpenCode 适配](https://github.com/yetone/magpie/blob/main/internal/agent/opencode_providers.go)。其代理/账号管理不进入本 SDK 第一版。
- [cc-switch](https://github.com/farion1231/cc-switch)：[Pi 原生文件适配](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/pi_config/mod.rs)、[DeepSeek Harness profile 与锁](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/dsh_config.rs)、[Codex 配置操作](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/codex_direct.rs)。这些是实现参考，不等于 SDK 已通过同样的可靠性验证。
- [Pi 模型配置](https://docs.pi.dev/latest/models-configuration)、[OpenCode Providers](https://opencode.ai/docs/providers/)、[OpenCode Models](https://opencode.ai/docs/models)、[Gemini CLI 配置](https://geminicli.com/docs/reference/configuration/)、[Claude Code Settings](https://code.claude.com/docs/en/settings)、[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[models.dev](https://models.dev/)。
- [@opencode-ai/models](https://www.npmjs.com/package/@opencode-ai/models)（[源码](https://github.com/anomalyco/models.dev/tree/main/packages/sdk)）：models.dev 官方类型化客户端；提供 `providers()` / `models()` / `catalog()` 与约 24 小时滞后的离线快照；MIT、ESM-only。
- 锁与原子写参考实现：[proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)（stale/retry/独占）、[write-file-atomic](https://github.com/npm/write-file-atomic)（同目录临时文件 + fsync + rename）、[atomically](https://github.com/fabiospampinato/atomically)。借鉴协议而非引入运行时依赖。

## 修订记录

- 2026-11-16（初稿）：补充单目标硬边界与平台范围；凭据落地改为三态并校验目标环境；增加每 Agent 生效性层与平台差异；发现器补三种内置格式与命名空间匹配；`strict` 默认禁用；Pi 默认值/费用/`apiKey` 形式细化；Claude Code 多槽默认模型；新增生命周期意图与 `adoptCredentialFields`；新增锁协议、恢复记录（WAL）与错误码。
- 2026-11-16（决定稿）：Claude Code 只处理四字段，旧变量按 `UNSUPPORTED_INTENT`；允许 Claude 使用 `agent-file`；DSH 默认只写 profile 层；版本探测默认关闭；恢复记录 TTL 缩为 1 小时；陈旧锁不自动接管、仅显式 `break-stale-lock`；同目标排队、不同目标可并发；发布基线定为 Node 20+ 与 ESM 优先；models.dev 改用官方 `@opencode-ai/models`；Windows 不调用系统 ACL API。
- 2026-11-16（定稿）：models.dev 默认使用包内快照（`generatedAt` 标注，live 显式开启）；补版本探测白名单与执行约束；包名定为不带 scope 的 `coding-agent-config-kit`，MIT；`previewSchemaVersion` 起始值 1。
- 2026-11-16（补记）：保留 live 模式但仅允许显式开启，快照过期不自动联网；预览与验收补充 models.dev 数据来源标注。
- 2026-11-16（实现完成 v0.1）：六个适配器与公共编排落地；103 项测试与三平台 CI 通过；仍待真实 Agent 版本验收。
