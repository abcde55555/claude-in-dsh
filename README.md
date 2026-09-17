# claude-in-dsh

> ## ⚠️ 这是 fork，不是上游
>
> 本仓库是 **[GeekRicardo/claude-in-dsh](https://github.com/GeekRicardo/claude-in-dsh)** 的 fork。
> 起点是**修复与 DSH `0.1.5-rc.1` 的不兼容**（上游 1.8.0 在 DSH 0.1.5 上无法工作），
> 此后又陆续加了：
>
> - **Codex 引擎** —— 第三个引擎，本机 `codex` CLI 驱动，每轮一次 `codex exec` / `exec resume`
> - **模型目录设置页** —— 增删改模型、隐藏内置项、按引擎分别设默认值
> - **引擎注册表** —— 改引擎显示名、标「本地 / 远程」
> - 若干修复：`assistant/message` 的 stream 契约（写错会永久写坏会话）、按引擎分开的模型默认值、下拉菜单定位
> - `scripts/dev-restart-dsh.sh` —— 手起 profile 的重启，会先等在跑的轮次结束
>
> 上游最后提交 2026-08-27（`62e3805b`）。两边功能已经分叉，**不要默认以上游为准**。
>
> ### 装本 fork
>
> ```sh
> dsh plugin --profile <name> add github:abcde55555/claude-in-dsh
> ```
>
> `lib/` 已随仓库提交（与上游做法一致），**无需构建步骤**。
>
> ### 修了什么（4 处，共 19 个改动点）
>
> | # | 问题 | 修法 | 处数 |
> |---|---|---|---|
> | 1 | `session.events` 属性在 DSH 0.1.5 已被移除 | → `session.snapshotEvents()` | 15 |
> | 2 | `tool/code-dispatch(-start)` 已改名 | → `tool/ptc-dispatch(-start)` | 2 |
> | 3 | `assistant/chunk` 事件类型已移除 | 不再写事件，改为**内嵌压缩进 `assistant/message.stream`** | 重构 |
> | 4 | `assistant/message` 禁止带 `sourceEventSeqs` | 去掉，改传 `stream: records` | 1 |
>
> **3 和 4 是同一个架构变更**：DSH 0.1.5 把流式数据从「N 个独立 chunk 事件」改成了**压缩记录内嵌**。
> 新契约（`@deepseek-ai/dsh-llm` 的 `AssistantStreamRecord`）：
>
> ```ts
> type AssistantStreamRecord =
>   | { type:'text-chunks';      time0; index; dt:number[]; texts:string[] }
>   | { type:'reasoning-chunks'; time0; index; dt:number[]; texts:string[] }
>   | { type:'tool-call-chunks'; time0; index; dt:number[]; id; name?; args:string[] }
>   | { type:'chunk'; time; chunk:StreamChunk }
> ```
>
> 压缩规则：三种 delta 按 `(type, index)` 打包成 run，`time0` 是首个 chunk 的时间，
> `dt[i]` 是相对前一个的增量时间；其余 chunk 原样存成 `{type:'chunk'}`。
> 官方对应实现是 `AssistantStreamAccumulator`；本 fork 按它的语义内联实现（插件是零 import 设计）。
>
> 改动落在 `src/host.dynamic.js`（引擎本体）+ `src/tests-host.dynamic.js`（测试工具），
> `lib/` 由 `pnpm build` 重新生成。
>
> ---

> ### 自定义模型（本 fork 新增）
>
> Claude 引擎模式下模型座默认只列 7 个 Claude 模型。但如果 `claude` CLI 走自建网关
> （`ANTHROPIC_BASE_URL`），`--model` 的值是**原样透传**的——任何网关认识的模型名都能用。
>
> 在 dsh 的设置页里（侧边栏「设置」→「模型目录」）就能增删改这些模型、隐藏不用的
> 内置项、分别设两个引擎的默认模型，改完立即生效，不用重启。也可以直接写
> `~/.cache/ccmode/models.json`：
>
> ```json
> {
>   "defaultModel": "deepseek-v4.1-flash",
>   "defaultCodexModel": "",
>   "hidden": ["claude-opus-4-5"],
>   "models": [
>     { "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "reasoning": true },
>     { "id": "kimi-k2.7-code",      "name": "Kimi K2.7 Code",      "reasoning": true }
>   ]
> }
> ```
>
> - `defaultModel` —— Claude 与 DSH 共用的默认模型；`defaultCodexModel` —— Codex
>   自己的那一份，空串＝跟随 codex 的 `config.toml`。两者**必须分开**，共用会在
>   一边设默认时改掉另一边。
> - `hidden` 里的 id 不再出现在任何引擎的模型座里（内置模型不能删，只能隐藏）。
> - 简写仍然读得懂：整个文件是数组时就是纯 `models`，对象里也可以只写
>   `defaultModel`。同 id 以内置为准；文件缺失或 JSON 非法时静默回退。
>
> ---

把 **DeepSeek Harness (dsh web)** 的一个会话交给**本机 Claude Code CLI** 驱动。所有 agent 工作都发生在本机 `claude` 里；dsh web 只负责接收流并用它**原生的**会话渲染展示 —— 转录、工具卡片、审批、命令面板，没有任何自绘的对话 UI。

## 功能

- **引擎选择器**：输入框里一个和模型选择器同款的下拉（`DSH | Claude Code | Codex`），按会话切换。三个引擎严格互斥 —— 一个会话跑过谁，就永远属于谁（从会话日志推断，重启不丢）。名字可以改，各带一个来源标记（本地 / 远程），见下面的「引擎注册表」。
- **引擎注册表**：设置页里（侧边栏「设置」→「引擎」）改三个引擎的显示名和来源标记，存在 `~/.cache/ccmode/agents.json`。改完引擎座、模型座分组标题、会话徽章 tooltip 一起改口。**只改显示**：能被执行的引擎仍然只有那三个，源头与执行方式都没变。
- **Codex 引擎**：本机 `codex` CLI 驱动，dsh 只负责渲染。和 Claude 那条路不同，它没有常驻进程：每一轮是一次 `codex exec`（首发）或 `codex exec resume <thread>`（之后每一轮），对话存在 Codex 自己的 thread store 里，插件只持久化 thread id。工具调用渲染成 dsh 原生卡片，出错时转录里看得到、会话不锁（换个能用的模型即可在同一 thread 续接）。注意两点：Codex 每轮重发完整历史（没有 token 级增量，成本明显高于 Claude 那条），且它的 provider 不认 `claude-*` 模型（必然 401，所以模型清单按引擎过滤）。
- **Codex 的图片**：粘贴的图片走 `codex exec -i <FILE>`（`exec` 与 `resume` 都认），转录里按 dsh 原生附件显示。临时文件在轮末删掉。
- **Codex 的「插话」**：跑轮次时 Ctrl/Cmd+Enter 的那条消息**不会折进当前轮**（Codex 一轮就是一个进程，没有 stdin 可写），而是**排进 inbox、跟下一轮一起送出去**。实测：插话 + 之后正常发的下一条会同时出现在下一轮的输入里，模型对两条都作答。所以「插话」在 Codex 会话里的效果等于「抢先排在队首」，不是「中途打断」。
- **原生渲染**：Claude 的流被写成 dsh 自己的持久会话事件（`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`…），所以持久化、投影、主题、其他插件（如 dsh-better-tool-ui 的工具行）全部照常工作。子 agent（Agent 工具）渲染为嵌套子调用。
- **权限档替换**：切到 Claude 后，dsh 的访问模式选择器被 Claude 的权限档（manual / acceptEdits / auto / bypassPermissions / plan）替换；权限请求（`can_use_tool`）桥接到 dsh 原生审批 UI（若你配置了 Claude 的 PermissionRequest hook，则完全遵循你的 hook）。
- **提问桥接**：Claude 的 `AskUserQuestion` 不当权限问题处理，而是交给 dsh 的提问服务——你看到的是 dsh 自己那张提问卡片（选项 / 多选 / "其他"自由文本），答案原样回到 Claude。提问一律问人，不受权限档影响。
- **计划审核桥接**：Claude 的 `ExitPlanMode` 用 dsh 自己的计划审核卡片审（和 dsh 的 `exit_plan_mode` 同一套 id/标签/intent）；批准即退出计划模式并把权限档落回监督档，选择继续规划则把你的反馈原样送回模型。
- **模型 / effort**：模型座换成 Claude 的模型清单 + reasoning effort；运行中切模型走 `set_model` 控制请求（不重启进程），重连后自动补发。
- **模型目录设置**：dsh 设置页里（侧边栏「设置」→「模型目录」）增删改自定义模型、隐藏不用的、分别设两个引擎的默认模型；写入是原子的，改完立即生效。
- **命令面板**：Claude 的斜杠命令并入 dsh 面板（只在 Claude 会话出现）；与 dsh 撞名的保留前缀加 `-claude` 后缀并标注归属。`/mcp` `/context` `/usage` 这类**一次性命令**带外执行 —— 不起轮次、不进转录，结果开在独立面板里（`/mcp` 按 TUI 样式画出服务器分组列表）。
- **进程与会话托管**：Claude 进程由独立 broker（`setsid`）持有 —— 插件热更新、dsh 重启都不会中断正在跑的轮次，重连后从字节偏移续读流。会话记录写进 `~/.claude`，终端里 `claude --resume` 能看到、也能继续。
- **只有真人发言才唤醒 Claude**：dsh 插件系统注入的通知消息（Cordis 运行器等）不会替你烧一轮订阅额度，内容攒到你下次发言时一并带上。
- **订阅用量**：官方订阅时输入框下方显示 5h/7d 用量与刷新倒计时（同 id 覆盖 dsh-balance 的座位，切回 DSH 自动还原）。
- **导入对话**：工作区 ⋯ 菜单 →「导入 Claude Code 对话」，列出该目录下的本机 Claude 会话，预览（dsh 原生工具卡片样式）后一键接着聊。
- **插话与排队**：跑轮次时 Ctrl/Cmd+Enter 插话直接折进 Claude 当前轮；普通 Enter 沿用 dsh 排队语义。
- **粘贴图片**：Claude 会话里粘贴的图片存成 dsh 原生附件（转录里直接显示），并以 stream-json image block 随下一条消息送给 Claude —— 不再被「当前模型不支持图片」挡下。
- **断档补播**：dsh 自己重启期间 Claude 完成的输出，会在下次打开或下一轮开始前补播进转录（不调用模型）。

## 前置

- Node.js ≥ 20、pnpm、已启动过一次的 dsh web（存在 `~/.dsh/profiles/web`）
- 本机已安装并登录 [Claude Code](https://code.claude.com) CLI（2.1.x）

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/abcde55555/claude-in-dsh/main/install.sh | bash
```

本地开发（用工作区目录而不是 GitHub 快照）：

```bash
bash install.sh --link /path/to/claude-in-dsh --restart
```

装完重启 dsh web（pm2：`pm2 restart dsh-web`）并硬刷新页面。

## 维护

改代码只改 `src/`，然后 `pnpm build`（或 `pnpm test`，会先 build，再跑 bundle 冒烟测试、最后跑 `src/client-rig.mjs` 客户端台架）。

重启 dsh 用 `bash scripts/safe-restart.sh`：它先确认没有进行中的 Claude 轮次再重启。直接 `pm2 restart` 会打断正在跑的轮次，在那个对话里留下 `TOOL_OUTCOME_UNKNOWN` 红卡（内容随后会被补播，但轮次已断）。

手起的 profile（非 pm2）用 `bash scripts/dev-restart-dsh.sh`，它同样会先等在跑的轮次结束再停（`--force` 可跳过）。它的环境变量从 `~/.config/cid/env`（可选，`CID_ENV_FILE` 可覆盖）或正在跑的进程里读，所以进程起不来时也还能重启。

**部署到 `~/.dsh/profiles/<profile>/node_modules/claude-in-dsh/` 时，`lib/*` 和 `package.json`、`dsh.plugin.json` 都要拷** —— 只拷 `lib/*` 会让 manifest 停在 pnpm 安装时的版本（插件是 `github:` 依赖，装的是副本，不是软链）。

## 结构

```
src/                开发与测试所用的动态包源码（dsh-cordis-mcp 沙盒形态）
  host.dynamic.js   宿主半：pre-step 接管、转录投影、broker 运行层、审批桥、RPC
  client.dynamic.js 客户端半：composer 座位、工具行、命令、面板（全部复用 dsh 类名）
  broker.mjs        进程 broker（宿主运行时会把同一份源码写到 /tmp/ccmode）
  client-rig.mjs    离线渲染台架
scripts/build.mjs   从 src 生成 lib（正式 bundle 容器包装，引擎体逐字节一致）
scripts/safe-restart.sh  确认没有进行中的轮次后再重启 dsh-web
lib/                生成产物：index.js（host, ESM）、client.js（ModuleLoader bundle）
```

## 运行时落点

- broker 与进程：`/tmp/ccmode/<sessionId>/`（fifo `in`、追加日志 `out.log`、`meta.json`）
- 每会话持久设置（权限档/模型/effort/Claude 会话 id）：`~/.cache/ccmode/state.json`
- 模型目录（自定义模型 / 隐藏项 / 两个引擎的默认模型）：`~/.cache/ccmode/models.json`
- 引擎注册表（显示名 / 来源标记）：`~/.cache/ccmode/agents.json`
- RPC：同源 `POST /claude-in-dsh/rpc`（仅回环 + 同源，供本插件 client 半使用）

## License

MIT
