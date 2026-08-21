# @huawe/dsh-workflow-designer

DSH 工作流设计与运行插件 — UI 切片 1（侧栏入口 + 列表 + 新建 + 线性编排画布）。

需求基线见 [`../Plan.md`](../Plan.md)。

## 状态

切片 1（UI + localStorage MVP）。无 Host 半、无任务运行器、无 spawn。后续切片按 `Plan.md §12` 推进：

- 切片 2：底部入口 + 列表/新建/画布 ← **本切片**
- 切片 3：Host KV + 编排器 + spawn + 交接/交卷
- 切片 4：三种完成规则 + 人工门
- 切片 5：分支谓词 + 硬拦 + 历史 + 重试 + 角标

## 结构

```
packages/dsh-workflow-designer/
├── package.json          # dsh.bundle + dsh.client 声明
├── tsconfig.json
├── tsdown.config.ts      # 复刻官方 clientBundle 的 __ModuleLoader__ 闭包工厂
├── cordis.patch.yml      # 单行 insert：name: '@huawe/dsh-workflow-designer'
└── src/
    ├── index.ts          # host 半：空 apply（UI-only 切片）
    ├── invariant.ts      # 无运行时不变式（切片 1 无会话事件）
    ├── types.ts          # WorkflowDefinition / Stage / CompletionRule
    └── client/
        ├── index.ts      # apply：locale + sidebar.footer.action 注册
        ├── locales.ts    # zh + en
        ├── store.ts      # localStorage MVP store
        ├── WorkflowEntry.tsx     # 侧栏底部按钮 + portal overlay
        ├── WorkflowPanel.tsx     # 全屏壳 + 视图切换
        ├── WorkflowList.tsx      # 列表 + 搜索 + 工作区筛选
        ├── NewWorkflowDialog.tsx # 名称 + 工作区 + 说明
        ├── EditorView.tsx        # 线性阶段编辑器（goal + 完成规则）
        ├── css-modules.d.ts
        └── panel.module.css
```

## 安装与运行

### 1. 安装依赖 + 构建

```bat
cd D:\code\deepseek-harness\scratch-plugin\packages\dsh-workflow-designer
pnpm install
pnpm run build
```

`build` 会产出 `lib/index.js`、`lib/invariant.js`、`lib/client.js`、`lib/types/*.d.ts`。

### 2. 装入 profile

从仓库根目录：

```bat
dsh plugin --profile web add link:./scratch-plugin/packages/dsh-workflow-designer
```

`link:` 让 pnpm 把当前源码符号链接进 profile；后续 `pnpm run build` 即生效，无需重装。

### 3. 启动 dsh web

```bat
pnpm dsh web
```

打开浏览器后，左侧栏底部「工作流」按钮（在新会话按钮下方的 footer 区，与设置按钮并列）打开全屏面板。

## 切片 1 验收（对应 `Plan.md §10`）

- [x] 能点底部按钮打开全屏 overlay
- [x] 第一次进入：空态 + 「新建工作流」入口
- [x] 新建表单：名称必填、工作区从 sidebar 的 `useWorkspaces` 取、说明可选
- [x] 创建后进入编排：自带一个空白第一阶段
- [x] 线性画布：增删阶段、上下移动、编辑 goal / 完成规则
- [x] 保存校验：空 goal、零阶段、缺入口 → 阻止
- [x] 未保存禁止「返回列表」（按钮 disabled）
- [x] localStorage 持久化：刷新页面工作流仍在
- [x] 列表：搜索、按工作区筛选、归档、删除（带确认）

## 已知限制（切片 1 范围内）

- 持久化用 localStorage，**不**跨机器、不进 `~/.dsh`。切片 3 改成 Host KV。
- 没有 task 运行器。点「启动任务」按钮目前没接（列表卡片显示「尚未启动任务」）。
- 没有分支、谓词、并行。线性图。切片 5 加。
- 没有硬拦 `forbiddenPaths`。切片 5 加。
- 不挂 `ctx.jobs`、不调 `ctx.subagents`、不写会话日志。这些都是切片 3+ 的事。
- 信任模型 = 一人一机；无分享、无信任仪式。

## 与官方 `workflow` 工具的关系

UI 一律写「阶段工作流」；不替代官方 `@deepseek-ai/dsh-tool-workflow`。后者是模型临时脚本；本插件是人设计、人启动的多阶段计划。

## License

MIT
