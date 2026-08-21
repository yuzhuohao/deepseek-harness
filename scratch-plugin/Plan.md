# DSH 工作流设计与运行插件 — 需求基线

执行模型：**编排器状态机按图推进，每阶段 spawn 一个新子智能体；用户不与任何「父会话」交互。** 本文件是评审通过的基线，不是草稿。

`scratch-plugin/cordis.yml` 与 `src/my-plugin.ts` 仍是官方「第一个插件」教程文件，与本需求无关。

---

## 1. 产品一句话

在 DSH Web 增加「阶段工作流」：本机保存绑定工作区的阶段图；启动任务后，编排器按图为**每一阶段** `spawn` 一个新子智能体（不继承任何父对话），只注入本阶段目标、完成规则、上一阶段结构化交接和任务输入。时间线只活在全屏 overlay + KV 任务记录里；用户不从任何「父会话」看进度。

---

## 2. 已拍板决策

| 议题 | 决策 |
|---|---|
| 入口 | 侧栏底部按钮 + 全屏 `shell.overlay`（不改 DSH 核心） |
| 用户可见会话 | **没有父会话**。时间线只在 overlay + KV；用户进子会话走 overlay 的「打开子会话」 |
| 内部 parent Agent | 任务启动时编排器 `ctx.agents.create` 一个 `origin: 'subagent'` 的内部 Agent 作为 spawn 的 parent 与 cwd 锚点；不接 composer、不跑用户 turn、侧栏隐藏 |
| 执行 | 每阶段 spawn 子智能体；`inheritsParentContext: false`；运行中只读回放，要改 = 取消再 spawn |
| 阶段边界 | **硬拦**已归档路径的写入（§5.2 四步） |
| 交卷 | 硬契约：spawn 带 `outputSchema`，过门只认 `result.structured`（§5.4） |
| 条件谓词 | 硬契约：JSONPath 左值 + `==`/`!=`/`in`/`and`/`or`，编排器求值（§6.3） |
| 自动检查 | 编排器经 `ctx.shell` 在工作区 cwd 执行；sandbox = 编排器部署 sandbox，**与子体无关** |
| 任务后台 | 自管进程内 `Map<TaskId, …>`；**不挂** `ctx.jobs` |
| 任务存活 | 后台可观察；进程退出标 `interrupted`、不续跑；常驻部署的自动恢复 = v1.1 |
| `workflowEngine` | v1 **完全不依赖**；留作未来阶段类型扩展点，不在基线承诺 |
| 存储 | DSH 本机 domain KV；定义/任务/stageRuns 分表；任务启动时快照定义 |
| 范围 | 目标 = 完整产品；**5 个实现切片，每切独立验收** |
| 一人一机 | 无分享、无多人；不做模板市场、不做信任仪式 |

**刻意不做**

- 不替代官方 `workflow` 工具 / Ralph / Plan mode。
- 不做重启后续跑、不做跨机器同步、不做模板市场。
- 不把整张图编译成模型可改的 JS 交给 `workflowEngine`。
- 不默认 fork。阶段若需继承父对话，必须是阶段上的显式开关（v1.1）。
- 不挂 `ctx.jobs`。
- 不做「启动前再确认检查命令」的 trust 仪式（一人一机、无分享场景）。

---

## 3. 用户与主路径

**角色：** 本机使用 DSH Web 的开发者（一人一机）。

**主路径**

1. 点侧栏底部「工作流」→ 全屏 overlay（列表视图）。
2. 第一次：空态 +「新建工作流」。填名称、选工作区 → 进入编排。
3. 编排阶段（线性或分支）：每阶段写 `goal`、选完成规则；声明该阶段期望的 `taskInputs` 字段（可选）。
4. 保存定义（生成 `version`）。
5. 列表点「启动任务」→ 弹**任务输入表单**（按定义里所有阶段声明的 `taskInputs` 字段合集）→ 创建 KV 任务记录 + 内部 parent Agent → spawn 入口阶段子体。
6. overlay 切到任务详情；时间线显示当前阶段、子会话入口、待确认项。
7. 阶段过门后 spawn 下一阶段；全部终态成功 → 任务 `succeeded`。失败/取消可从指定阶段再 spawn 重试。

**次路径：** 编辑已有定义、复制、归档、看历史任务、对失败阶段重试、人工门禁通过/驳回、中途取消任务、打开某阶段子会话（关 overlay 跳过去）。

---

## 4. 信息架构

DSH 没有前端路由。「页面」= 盖住主界面的全屏 `shell.overlay`，内部自己切视图。

```
阶段工作流（全屏 overlay）
├── 工作流列表
│     新建 / 搜索 / 按工作区筛选
│     卡片：名称、工作区、阶段数、最近一次任务状态
├── 工作流详情（定义）
│     ├── 基本信息（名称、工作区、说明）
│     ├── 编排画布（阶段节点 + 边）
│     └── 阶段检查器（goal、完成规则、taskInputs 字段、分支条件）
└── 任务
      ├── 任务列表（进行中 / 历史）
      └── 任务详情
            阶段时间线、当前节点高亮、子会话入口、人工待办、交接/交卷、重试/取消
```

侧栏底部按钮：未打开则打开列表；已打开则关闭。进行中 / 待确认数量在按钮上可见（角标）。

---

## 5. 执行模型

### 5.1 编排器状态机

```
KV 任务记录  ←→  Host 编排器（状态机，进程内）
                    │
                    ├── 内部 parent Agent（origin: 'subagent'，侧栏隐藏，不接 composer）
                    │       ↑ cwd 锚点 / spawn 系谱 / preset 拼接
                    │
                    └── 阶段 N → spawn 子 Agent（新会话、无父对话）
                          输入：goal + 完成规则 + 上一阶段交接包 + taskInputs（首阶段）
                          输出：result.structured（交卷）+ 工作区产物
                          过门：编排器求值完成规则 + 谓词，再 spawn 下一阶段
                    │
                    └── 进程内 Map<TaskId, { parentAgent, run?: SubagentRun, abort }>
```

- **编排器不是模型。** 走哪条边、是否过门、是否重试，由插件状态机决定。
- **干活的是子智能体。** 默认 `spawn`：看不到任何父/兄弟阶段对话。
- **用户不与任何「父会话」交互。** 用户备注只写在 overlay，进入**下一次** spawn 的 prompt。

### 5.2 阶段边界与硬拦（四步）

「硬拦已归档路径写入」由下列四步共同保证，单步都不够：

1. **`forbiddenPaths` 是任务运行时累积**，不是定义字段。任务启动时初始化为 `[]`；每阶段过门后把该阶段的 `changedPaths` 并入。复制定义到新工作区 = 全新任务，`forbiddenPaths = []`。
2. **spawn 时 `toolFilter.deny` 无路径约束的写工具**（裸 `bash` / `pwsh` / 未包装的 `write` / `str_replace`），强制子体只能用编排器提供的**带路径检查的写工具**。阶段若显式声明需要 shell（`allowShell: true`），失去对该阶段的硬拦，§11 风险明示。
3. **编排器提供的写工具**（Host 侧全局注册，子体经 `toolFilter.allow` 唯一可写通道）在执行前校验目标路径是否落在 `forbiddenPaths` 前缀下；命中 = 拒绝执行并把违规写进任务详情。
4. **阶段结束做工作区 diff**（编排器在阶段开始/结束各快照一次）：与 `result.structured.changedPaths` 不一致，或 diff 碰到 `forbiddenPaths` → 阶段 `failed`，并列出违规路径。diff 是第二道，不是唯一一道。

硬拦覆盖不到的：子体用允许的写工具写了非 forbidden 但未声明 的路径——这是 `changedPaths` 不一致，按 §5.4 判交卷不完整，不过门。

### 5.3 阶段交接包

每阶段过门后，编排器向下一阶段 spawn 注入固定 JSON（可另附短摘要文本）：

| 字段 | 用途 |
|---|---|
| `workflowName` / `stageTitle` | 定位 |
| `goal` / `completion` | 本阶段指令（下一阶段只作只读背景） |
| `changedPaths[]` | 相对工作区的改动文件（编排器 diff，不来自模型声明） |
| `artifacts[]` | 关键产出路径与一句话说明 |
| `checks[]` | 命令、退出码、摘要（自动检查阶段必填） |
| `decisions[]` | 本阶段锁定的约定（包管理器、命名、禁止项） |
| `risks[]` / `unresolved[]` | 未决问题 |
| `humanReview` | 通过/驳回及意见（若有） |
| `forbiddenPaths[]` | 下一阶段不得改的已归档路径（任务运行时累积） |
| `taskInputs` | 任务启动表单的值（首阶段必填，后续阶段只读背景） |

**保存时强制校验**：`decisions[]` 与 `taskInputs` 不得内联密钥；只允许 credentials reference 形式（与 `packages/credentials/` 一致）。扫描疑似密钥字符串，命中 = 拒绝保存并指到字段。

### 5.4 子体交卷（硬契约）

子体结束前必须返回 `result.structured`，由 spawn 的 `outputSchema` 强制。**否决**从最后一条 assistant 消息抠 JSON；**否决**单独的 `workflow_submit` 工具（one-shot 没有中途交卷，结构化结果就是交卷）。

schema 必填字段：

```jsonc
{
  "status": "complete" | "blocked" | "failed",
  "summary": "string",
  "changedPaths": ["rel/path"],
  "decisions": [{ "key": "pkgmgr", "value": "pnpm" }],
  "unresolved": ["string"]
}
```

- `status: complete` + 字段齐全 + 与 diff 一致 → 过门。
- `status: blocked` → 任务 `waiting_human`（人决策）；人通过 = 过门；人驳回 = 该阶段再 spawn（注入上次 structured + 驳回意见）。
- `status: failed` 或缺字段或与 diff 不一致 → 按 `onFailure`（重试 / 停 / 失败边），**不**进入下一阶段。
- 人工确认：先收 structured，任务进 `waiting_human`；通过后才把 structured 写入交接包并过门。

### 5.5 子体句柄生命周期

进程内维护 `Map<TaskId, { parentAgent: Agent, run?: SubagentRun, abort: AbortController }>`：

- 启动任务 → `ctx.agents.create({ origin: 'subagent', workspaceId })` 建内部 parent；建 KV 任务记录（`status: running`）。
- spawn 阶段 → `ctx.subagents.start('spawn', { parent, prompt, outputSchema, toolFilter, signal })`，句柄进 Map。
- 取消任务 → `abort.abort()` + `run.dispose()`，KV 标 `cancelled`。
- 阶段过门 → 当前 `run.dispose()`（one-shot 已 settle 也要 dispose 释放资源），spawn 下一阶段。
- 插件 `dispose()` → 遍历 Map，所有 running `run.dispose()`，KV 标 `interrupted`。
- 进程硬退 → 下次启动扫描 KV 中仍为 `running`/`waiting_human` 的任务，回填 `interrupted`（**不**续跑）。

子会话挂在内部 parent 下，`origin: 'subagent'`，侧栏按 DSH 惯例隐藏；从 overlay 任务详情的「打开子会话」进入（关 overlay，走现有 subagent 入口）。运行中子会话只读回放；改产出 = 取消当前 spawn 再 spawn（注入上次 structured + 新意见）。

### 5.6 内部 parent Agent

- `ctx.agents.create` 时 `meta.origin: 'subagent'`，`workspaceId` = 任务工作区。
- **不接 composer**：没有用户 turn 进入它的 agent-loop。
- **不跑模型 turn**：它只是 spawn 的 parent 与 cwd 锚点。
- 它的 Session 不出现在侧栏（ui-workspace 隐藏 `origin: 'subagent'`）。
- 任务结束 = 内部 parent 被 dispose；其 Session 日志保留作为审计轨迹，但用户不读它。
- 子体的 `parentSession` header 指向这个内部 Agent 的 Session——这是 DSH 系谱要求，不是产品上的「父会话」。

### 5.7 与官方 `workflowEngine` 的关系

v1 **完全不依赖** `ctx.workflowEngine`。图的推进在 Host 编排器里，否则模型能改边、跳过门禁。`workflowEngine` 留作未来「某阶段内扇出子 agent」的阶段类型扩展点，**不在基线承诺**。官方 `workflow` 工具仍是模型临时脚本，与本产品并存；UI 一律写「阶段工作流」避免名词混。

---

## 6. 领域模型

### 6.1 工作流（定义，可反复启动）

| 字段 | 说明 |
|---|---|
| `id` | 本机唯一 |
| `name` | 列表展示 |
| `description` | 可选，可进系统提示 |
| `workspaceId` | 创建时选定，**创建后不可改**（改 = 复制新定义） |
| `graph` | 阶段节点 + 边（独立表，按 `definitionId` 关联） |
| `entryNodeId` | 起始阶段 |
| `version` | 每次保存递增 |
| `schemaVersion` | KV schema 版本；冷加载校验，不匹配拒读，不自动迁 |
| `createdAt` / `updatedAt` | |
| `archived` | 归档后不出现在默认列表，历史任务仍可看 |

### 6.2 阶段（节点）

| 字段 | 说明 |
|---|---|
| `id` / `title` | |
| `goal` | 给子智能体的主指令 |
| `completion` | 完成规则，三选一 |
| `onSuccess` | 出边（默认一条；分支见 §6.3） |
| `onFailure` | `stop` / `failEdge` / `retry:N` |
| `taskInputs[]` | 该阶段期望的任务输入字段（仅首阶段有效；其它阶段只读背景） |
| `sandbox` | 阶段预设：`read-only` / `workspace-write` / `danger-full-access`；默认 `workspace-write` |
| `allowShell` | 是否允许裸 bash/pwsh（true = 失去硬拦，§11 风险） |
| `model` / `persona` | 可选；不配则继承部署默认 |
| `timeout` / `maxTurns` | 默认 60s / 20 |

**完成规则（每阶段自选）**

1. **自声完成** — 子体按 schema 返回 `result.structured`；编排器校验后过门。
2. **人工确认** — 先收 structured，任务进 `waiting_human`；通过 = 过门，驳回 = 该阶段再 spawn（带意见）。
3. **自动检查** — 子体交卷后，编排器经 `ctx.shell` 在工作区 cwd 跑检查；通过才过门。一期检查器：文件存在/内容匹配；命令退出码 0。失败按 `onFailure`；详情展示 stdout/stderr 摘要。

**子体权限**：spawn 时 `approvalPolicy: 'never'`（DSH delegation 固化）；`sandbox_permissions` 升级在子体内禁用，要走升级只能改阶段 `sandbox` 预设再 spawn。

### 6.3 边、分支与条件谓词

- **默认：** 线性 `A → B → C`。
- **条件分支：** 节点多条出边，每条带谓词。**必须**有一条 `else` 边或「不匹配则失败」，禁止静默卡住。
- **汇合：** XOR 汇合（任一入边到达即进入，不等所有前置）。并行汇合 = v1.1。
- **并行：** 节点扇出多个并行阶段 = v1.1，需求保留语义：全部成功才走汇合。
- **环：** 图上的边循环禁止；节点内 `attempts++` 重做**不算**环（用「驳回后重做本阶段」表达循环）。

**条件谓词 DSL（硬契约）**

语法：JSONPath 左值 + 比较运算符 + 布尔组合：

```
predicate := comparison | predicate 'and' comparison | predicate 'or' comparison
comparison := jsonpath operator value
operator := '==' | '!=' | 'in'
jsonpath := '$.field' | '$.checks[0].exitCode' | '$.decisions[?(@.key=="pkgmgr")].value'
```

左值只允许交接 schema 上的字段：`$.status`、`$.checks[].exitCode`、`$.decisions[?(@.key=="…")].value`。

三个典型分支：

```
1. status == "complete"                       # 单条件
2. $.checks[0].exitCode == 0                  # 自动检查通过
3. $.decisions[?(@.key=="pkgmgr")].value == "pnpm"  # 决策值匹配，else 走另一边
```

编排器求值；**不**再问模型选边（否则破坏「编排器不靠模型改图」）。

**保存时校验**：有且仅有一个入口；无死节点（或警告）；无环；条件边有 `else`。

### 6.4 任务（一次运行）

| 字段 | 说明 |
|---|---|
| `id` | |
| `workflowId` + `definitionSnapshot` | 快照 = `{ workflowId, version, contentHash }`；整图另表，按 `taskId` 关联 |
| `parentAgentId` | 内部 parent Agent 的 Session id（实现字段，产品不展示） |
| `taskInputs` | 启动表单的值（首阶段交接包注入） |
| `status` | `running` / `waiting_human` / `succeeded` / `failed` / `cancelled` / `interrupted` |
| `currentNodeId` | |
| `forbiddenPaths[]` | 任务运行时累积，初始 `[]` |
| `startedAt` / `endedAt` | |

`stageRuns` 独立表（每条独立上限；检查输出可截断）：

| 字段 | 说明 |
|---|---|
| `taskId` / `nodeId` / `attempt` | |
| `childSessionId` / `childRunId` | |
| `startedAt` / `endedAt` | |
| `structured` | 子体交卷（不进任何会话日志） |
| `checks[]` | 检查命令、退出码、摘要 |
| `humanReview` | 通过/驳回及意见 |
| `diff` | 工作区 diff 摘要 |

**与会话关系**

- 启动 = 建 KV 任务记录 + 内部 parent Agent + spawn 入口阶段。
- **没有用户可见父会话。** 用户从 overlay 任务详情进子会话。
- 同一工作流同时只一个 `running` 任务（同工作区文件互踩防护）。要并行 = 复制定义到不同工作区。
- 内部 parent Agent 被删 / 工作区没了：任务 `interrupted`；重试前检查工作区，没了 = 阻止并提示重新关联。

**后台可观察**

- 关 overlay、去别的会话，任务继续（进程内 Map 持有句柄）。
- 列表显示进行中；`waiting_human` 角标计数。
- DSH 进程退出 → KV 任务回填 `interrupted`，**不**续跑。用户可从指定阶段再 spawn 重试（`forbiddenPaths` 保留，快照不变）。

**重试**

- 从指定阶段重试：保留该阶段之前 `stageRuns`，从该节点用**同一份快照**再 spawn。
- XOR 汇合点重试 = 重跑实际走过的入边阶段。
- 用最新定义重跑 = 新任务，从入口开始。
- 单阶段内自动重试 = 仅当 `onFailure: retry:N`。

---

## 7. 功能清单（名 + 链回 §6）

- 入口与壳：侧栏底按钮、全屏 overlay、角标（§4）
- 工作流列表：新建/打开/复制/归档/删除、搜索、按工作区筛选（§6.1）
- 新建：名称 + 工作区（现有 picker）+ 说明 → 自带空白第一阶段（§6.1）
- 编排：画布增删改、检查器编辑 goal/规则/谓词、保存校验（§6.2、§6.3）
- 启动任务：弹 `taskInputs` 表单、检查工作区、跳任务详情（§6.4）
- 运行期：spawn 子体、解析 structured、跑检查、求值谓词、取消（§5）
- 任务列表与详情：进行中/历史、时间线、打开子会话、重试/取消（§6.4）
- 内置 3 个示例工作流：线性 3 阶段、带分支、带人工门（无市场）

---

## 8. 与 DSH 现有能力怎么接

| 能力 | 用法 |
|---|---|
| Workspace | 创建时绑定；内部 parent 与子会话 cwd = 工作区路径 |
| `ctx.agents.create` | 建内部 parent Agent（`origin: 'subagent'`） |
| `ctx.subagents.start` | spawn 子体；带 `outputSchema` + `toolFilter`；`inheritsParentContext: false` |
| `ctx.shell` | 编排器跑自动检查命令；sandbox = 编排器部署 sandbox |
| Goal | **不复用**。Goal 是单目标、进程内、恢复即卸武装；本产品自管阶段状态 |
| Jobs | **不挂** `ctx.jobs`；自管进程内 Map（§5.5） |
| `workflowEngine` | v1 **完全不用**；留作未来阶段类型扩展点 |
| `storageDomain` | 定义/任务/stageRuns 分表 |
| 会话日志 | 只追加 `ignorable` 观察事件（任务开始/阶段过门/结束），**不含 structured 正文** |
| 子会话 UI | 走现有 subagent 入口；`origin: 'subagent'` 侧栏隐藏 |
| UI 插槽 | `sidebar.footer.action` + `shell.overlay` |
| `toolFilter` | 按**工具名** allow/deny（不能按路径）；用于禁裸 shell、限定写工具通道（§5.2 步 2） |

插件形态：一个 out-of-tree bundle = Host（KV + 编排器 + 写工具包装 + remote）+ Client（按钮 + 全屏页）。`dsh plugin --profile web add …` 安装。

---

## 9. 非功能

- 定义与任务只在本机；不上传。
- goal / 交接 / 交卷 / `taskInputs` 不得含密钥（§5.3 保存时强制）。
- 全屏页不毁掉侧栏会话列表；关掉回到原来的会话。
- 编排器崩溃或插件卸载：所有 running `run.dispose()`，KV 标 `interrupted`，不留幽灵。
- 图规模：≤30 阶段；并发任务 ≤3（跨工作流）；每阶段默认 `maxTurns` 20。
- 工作区产物不随任务失败回滚（diff 仅用于检测与禁用）。
- DSH Web 进程退出 = 任务中断的边界定义；常驻部署的自动恢复 = v1.1。
- 通知：按钮角标 + tab title 计数 + favicon badge；不做 OS 通知。
- Windows：检查命令 `pwsh`；POSIX：`bash`；库存相对路径用 `/`。

---

## 10. 验收

### 切片级验收

- **切片 1（KV + 状态机骨架）**：定义能存能读；`schemaVersion` 校验生效（旧版拒读）；任务记录状态机空跑（无 spawn）能从 `running` 走到 `interrupted`。
- **切片 2（UI 列表/画布）**：能建能存能列；线性画布可编辑；未保存禁止启动；空 `goal` 阻止启动。
- **切片 3（编排器 + spawn + 交接/交卷）**：3 阶段线性工作流能从头跑完；阶段 2 子会话日志里没有阶段 1 对话；缺字段的 structured 不过门。
- **切片 4（完成规则 + 人工门）**：三种完成规则各至少一个阶段的工作流跑通；人工驳回后同阶段再 spawn 且带上意见。
- **切片 5（分支、历史、重试、角标）**：带 `else` 的分支按谓词走对边；从指定阶段重试保留之前 `stageRuns`；按钮角标与 `waiting_human` 计数正确。

### 完整产品验收

1. 新用户只点底部按钮，不靠文档建一条 3 阶段线性工作流并启动。
2. 三种完成规则各至少有一个阶段的工作流能从头跑完。
3. 带 `else` 的分支按谓词走对边。
4. 人工门禁不点通过不会进入下一阶段；驳回后同阶段再 spawn 且带上意见。
5. 关掉全屏页任务仍跑；详情数字正确。
6. 杀掉 DSH 再开，任务为 `interrupted`，可从该阶段重试。
7. 运行中改定义不影响已开任务；新任务用新图。
8. 任务详情能打开当前子会话；子会话运行中只读，要改 = 再 spawn。
9. 阶段 2 的子会话日志里没有阶段 1 的对话，只有交接包。
10. 缺字段的 structured 不能过门。
11. 驳回后新 spawn 看得到意见，且仍是新会话。
12. 取消任务后当前子体停；工作区不回滚。
13. 已归档路径出现在下一阶段 `forbiddenPaths`，子体用允许的写工具写它 = 被拒；用裸 shell 写 = 阶段 `failed`（diff 命中）。

---

## 11. 风险

- **交接质量决定一切。** 子体冷启动丢语境 = 整条链路质量塌。§5.3 是硬约束，但工具不能强迫作者写好；需要示例 + 保存时检查「依赖隐式共识却没写进 `decisions`」。
- **`allowShell: true` 的阶段失去硬拦。** 裸 shell 能写任意路径，§5.2 步 2/3 失效；只能靠 diff 事后判 `failed`。需要 shell 的阶段要在 UI 明示「此阶段不保证已归档路径不被改」。
- **重启不续跑 + 长任务。** 用户预期可能是「开了就跑完」。UI 与文档要明示：关 DSH = 任务中断，需手动重试。
- **每阶段新上下文的成本。** 3 阶段 ≈ 3 次冷启动，长工作流费用可观。限额是个人使用维度的安全网。
- **与官方 `workflow` 工具的名词混。** UI 一律写「阶段工作流」；文档明确不替代官方 `workflow` 工具。
- **内部 parent Agent 的审计价值低。** 它不跑用户 turn，Session 日志基本是 spawn 记录；用户不读它，但保留作为系谱证据。

---

## 12. 实现切片

1. Host：KV 定义/任务/stageRuns 分表 + `schemaVersion` + 空状态机 + 进程退出回填 `interrupted`
2. Client：底部入口 + 列表/新建/线性画布 + 草稿（未保存不升版本）
3. 编排器：内部 parent Agent + spawn + `outputSchema` 交卷 + 交接包 + 进程内 Map 句柄 + 任务详情时间线
4. 三种完成规则 + 人工门 + 自动检查（`ctx.shell` + 编排器 sandbox）
5. 分支谓词 + 硬拦四步（写工具包装 + `toolFilter` + diff）+ 历史任务 + 重试 + 角标

每切验收见 §10。切片 1 即可按分表 + `schemaVersion` 开工，不会被切片 3 推翻。

---

## 13. 默认项（可改，不挡本基线）

1. **并行阶段：** 需求保留，实现 v1.1。v1 先做顺序 + 分支。
2. **删除工作流：** 有历史则先归档。
3. **fork 继承：** v1.1，作为阶段显式开关。
4. **常驻部署自动恢复：** v1.1。

---

下一步：按本基线拆 Host/Client 插件技术设计（包名、remote、`ignorable` 会话事件、KV schema 版本、写工具包装的实现）。
