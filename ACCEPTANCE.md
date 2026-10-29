# cws Node v2 验收实测记录（2026-09-12）

环境：WSL2 Ubuntu（/mnt/c/Users/loliyc/Documents/Code/cws），Node v22.23.2，
codex CLI 0.154.0（npm @openai/codex）。本地验证用 scripts/mock-claude.mjs /
scripts/mock-codex.mjs 全协议 mock（免 key），真实 codex 只做无鉴权冒烟。

## 一、协议验收（mock CLI，8/8 PASS → SUMMARY_OK）

| # | 场景 | 结果 | 证据 |
|---|------|------|------|
| 1 | claude new_session+send "1+1" | OK | final.text="2" |
| 2 | claude 两会话并行 | OK | f1="18" f2="16" |
| 3 | claude Bash 写文件→ask→deny | OK | ask(tool=Bash,kind=permission)→final"工具调用被拒绝" |
| 4 | claude AskUserQuestion | OK | questions 结构完整→answers 按问题原文回填→final"你选了蓝" |
| 5 | claude stop→turn_aborted(user)→send 续聊 | OK | abort.reason=user，续轮 final 正常 |
| 6 | ping/sessions.list/错 token 401 | OK | pong 回显 echo；401 拒绝握手 |
| 7 | codex new_session(backend=codex)+send | OK | final.text="2"（JSONL→v0.2 帧映射正确） |
| 8 | codex 流式中途 stop | OK | turn_aborted(reason=user) |

## 二、真实 codex CLI 冒烟（0.154.0）

- codex exec --help 实测确认：--json、--skip-git-repo-check、--color、
  -c/--config（支持点路径）、-s/--sandbox（read-only/workspace-write/
  danger-full-access）、resume <SESSION_ID> [PROMPT] 子命令；**0.154.0 已移除
  --full-auto**（适配器 full-auto 档改为 --dangerously-bypass-approvals-and-sandbox）。
- 桥内真实起 codex exec --json：收到 thread.started(uuid)、turn.started、
  error 事件（本机无外网/未登录 → "Reconnecting... request timed out"）→
  桥正确产出 final{is_error:true, subtype:error_during_execution}。
  事件结构与 openai/codex 源码 codex-rs/exec/src/exec_events.rs 一致
  （ThreadItem 用 type 字段，snake_case：agent_message/reasoning/
  command_execution/file_change/mcp_tool_call/web_search/todo_list）。
- 结论：适配器与真实 CLI 的参数/事件协议对齐；实弹出活需渠道 key 或 CODEX_API_KEY。

## 三、WebUI / 渠道管理

- 静态服务：/ →200、/app.js →200、/style.css →200；路径穿越 /../config.json →404。
- 渠道 roundtrip：channels.list(4 渠道,含 longxia protocol=auto) →
  set_default(longxia) → save(tmptest) → delete(tmptest) → 默认回落清空 OK；
  persist 后 secrets.json 无残留 key、channels.json 正确。

## 四、重构中踩掉的坑（Node 特有，Python 版无）

1. **SIGTERM 后 exitCode 为 null**：Node 子进程被信号杀死时 exitCode===null
   且 signalCode==='SIGTERM'——所有存活判断必须同时看两者（util.procAlive），
   否则 stop 后的下一次 send 会向死进程写 stdin（EPIPE 异步触发，write 不抛错），
   turn 静默挂起。
2. **ESM import 绑定只读**：跨模块对 DEFAULT_CHANNEL 赋值在运行时抛
   "Assignment to constant variable"（node --check 不报）→ 改为 channelState 可变持有者。
3. **abort 时序**：杀进程后若先等退出再发 turn_aborted，reader 的 close 事件会抢先
   以 reason=process_exited 发帧 → abort 必须先置 aborted_sent+发帧，再后台等退出收敛。
4. **pkill -f 自匹配**：模式字符串出现在自身命令行里会杀掉自己的 shell（Python 版
   ACCEPTANCE 同款教训）→ 用 pgrep 列 PID 逐个 kill 并排除自身，
   restart 脚本内用 server[.]js 括号技巧。

## 五、未覆盖项（需生产环境/凭据）

- 真实 claude CLI 端到端：本机未安装；帧逻辑按已实测的 Python 版 1:1 移植
  （协议路径/时序/字段逐一对应），生产验证方式：把 config.json 的 claude_bin
  指向已登录机器上的 claude 跑 wsclient.mjs 即可复测。
- 龙虾(ClawBrain)实弹：需要用户 key；WebUI「测试连通/拉取模型列表」已就绪，
  claude 走 /v1/messages、codex 走 /v1/chat/completions（双协议）。
- codex 真实多轮 resume：需 API 可用时复测 thread_id 续轮（逻辑已按 exec.md
  与源码实现，thread_id 落盘 sess.json）。

## 六、OpenClaw(龙虾)协议研究与对接实测(2026-09-12 追加)

- 身份确认:龙虾 = OpenClaw(github.com/openclaw/openclaw),开源自托管 AI Agent
  网关;ClawBrain(clawbrain.dev,owl- key)为托管商业版。协议全文调研见
  docs/openclaw.md(llms.txt 全量索引 + 源码逐字段核对)。
- 三个协议层:Gateway WS 协议 v4(connect/hello-ok/req-res-event/RPC 族/device
  token)、OpenAI 兼容 HTTP API(/v1/chat/completions、/v1/responses、
  /v1/models、/v1/embeddings、/tools/invoke)、CLI 后端/ACP 机制。
- **关键实测发现:codex 0.154.0 已移除 wire_api=chat**(启动即报
  "wire_api = chat is no longer supported",必须 responses)→ cws 适配器与渠道
  默认全部改为 responses;OpenClaw 的 /v1/responses 恰好对齐。
- 渠道层协议感知落地:channel.test/channel.models 按 protocol 分流
  (openai→chat completions+models/Bearer,anthropic→/v1/messages),base_url
  尾部 /v1 有无两种约定自动适配;channels CRUD 支持 wire_api/http_headers 字段;
  codex 适配器支持 TOML http_headers 下发({session_id} 占位符→会话 uuid,
  用于 x-openclaw-session-key 维持 OpenClaw 侧会话)。
- 本地 mock OpenResponses 网关验收:openai/auto 渠道测试 200、
  /v1/models 拉取 openclaw+openclaw/default、真实 codex 0.154.0 端到端
  (桥 codex 后端+openclaw 渠道→SSE→delta="2"→final.text="2",is_error=false)。
- 期间按 codex 源码(codex-api/src/sse/responses.rs)修正两处:
  (a) codex 只发 item.completed(无 started/updated)时的文本提取;
  (b) SSE 事件序列须含带 role 的 output_item.added 与 output_item.done。
- 回归:mock 验收 8/8 SUMMARY_OK(上文一~五节场景,改动后复跑通过)。


## 七、OpenClaw 后端（远程网关遥控）实测（2026-09-12 追加）

- 架构纠正：OpenClaw 从「上游渠道」改为**平级后端**（本地 claude/codex + 远程 openclaw）。
- 实现：依赖官方 @openclaw/gateway-client（Gateway WS 协议 v4），新增
  src/gateway.js（共享连接管理）+ src/openclaw-session.js（会话后端）。
  精确字段取自 @openclaw/gateway-protocol 的 protocol.schema.json（965 定义）。
- 映射：chat.send→发消息；chat 事件(deltaText/state=delta|final|aborted|error)→
  cws delta/final/turn_aborted；session.approval(pending)+approval.resolve→ask 卡片；
  sessions.patch→模型/权限；chat.history→历史；sessions.abort→停止。
- mock 网关实测（scripts/mock-openclaw-gateway.mjs，最小 v4 协议）：
  new_session(backend=openclaw)→session_ready→send "1+1"→Δ2→final="2"；
  send "用bash…"→session.approval(pending,kind=exec)→ask→allow→approval.resolve→
  Δ"工具已执行"→final。全链路 PASS。
- 回归：claude/codex mock 验收 8/8 通过（wsclient.mjs 新增 9.openclaw_basic）。


## 八、前端后端配置（claude/codex/openclaw）实测（2026-09-12 追加）

- 新增 backends.list/save/test 动作 + WebUI「后端与网关」弹窗。
- 配置层：claude_bin/codex_bin/default_backend/gateways 改为可变 + persistBackends
  （网关 token 拆到 secrets.json gateway_tokens，列表只回显尾 4 位）。
- 实测：backends.list 回显三后端；backends.test claude→2.1.269、codex→0.154.0、
  openclaw→connected 17ms（mock 网关）；backends.save 改 codex_bin+网关写回 config.json。


## 九、CodeBuddy 后端（@tencent-ai/codebuddy-code）研究与对接实测（2026-10-23 追加）

### 实机调研（真 CLI 2.170.0，`npm install -g @tencent-ai/codebuddy-code`）

- bin：`codebuddy`（别名 cbc/codebuddy-code）；`codebuddy --version`→2.170.0，正常退出。
- stream-json 全套支持：`-p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose`；事件 schema 与 claude 同构（system/init、
  stream_event text_delta/thinking_delta、assistant、result；result 额外带
  usage/duration_ms/num_turns/errors）。**启动即发 init（连发两次属正常）**，
  无 claude 的 initialize 握手。
- `--session-id <uuid>` 实测支持（网页文档未列）；`--resume <id>` +
  `--resume-create-missing` 支持（transcript 被 30 天清理后同 id 重开不失败）。
  历史：`~/.codebuddy/projects/<munged-cwd>/<session-id>.jsonl`。
- `--permission-mode` 合法值：acceptEdits / bypassPermissions / default / plan /
  dontAsk / auto（适配器白名单沿用 claude 四档，未知值回落 default）。
- `--allowedTools`（camelCase，逗号分隔单值传参，避免 commander 变长参数吞选项）。
- `-y` = `--dangerously-skip-permissions`（=bypassPermissions）；
  `CODEBUDDY_IS_SANDBOX=1` 仅进程环境变量生效（shell export 无效）且需配 -y。
- **headless 无权限询问通道**（无 `--permission-prompt-tool`）：default 档下非白名单
  工具由 CLI 直接拒绝 → 无 claude 的 ask 卡片，全放行用 bypassPermissions。
- 环境变量：CODEBUDDY_BASE_URL（原样使用）、CODEBUDDY_API_KEY（-p 模式必用）、
  CODEBUDDY_CUSTOM_HEADERS（"Name: Value" 多行，{session_id} 占位符）。
  模型请求走官方 OpenAI SDK（base_url 拼 /chat/completions，Bearer）→ 只配 openai 协议渠道。
- control_request/control_response 协议存在（rewind 用）；桥对不支持的控制请求回 deny。

### 实现与验收

- `src/codebuddy-session.js`：常驻 stream-json 适配器；首启 `--session-id`，
  续轮/复活 `--resume <thread_id||cli_uuid> --resume-create-missing`；init 回读
  session_id ≠ 预置 uuid 时落 thread_id 兜底；渠道→env 注入；权限/渠道切换=重启
  进程换参（运行中改记 pending_mode，下一轮 _ensureProcess 边界重启生效）；
  abort/_killpg 与 claude 同构；图片输入放行（协议同构，真 CLI 未实弹复测）。
- `scripts/mock-codebuddy.mjs`：启动即发 init（回显 --session-id/--resume/权限档）、
  无握手、control_request→deny、工具调用直接拒绝（headless 语义）、数到→300 delta。
- wsclient 场景 10.codebuddy_basic：new_session(backend=codebuddy)→session_ready.
  backend==='codebuddy'→"1+1"→final 含 2。**10 场景全过 SUMMARY_OK**（mock 网关）。
- backends.list 回显 codebuddy_bin；backends.test codebuddy ok（真 CLI --version→2.170.0）。
- WebUI：新会话后端选项、后端面板 codebuddy_bin/默认后端/测试按钮、B 徽标、
  权限档选项、渠道过滤（anthropic 渠道禁配 codebuddy）、图片门放行；tsc+vite 构建过。

### 验收中抓出并修掉的两个 bug

1. **每轮白等 10s**：bridge 对非 claude 后端 new_session/revive 时预置
   `ready_announced=true` 并代发 session_ready（codex/openclaw 按轮拉起进程，
   该预置正确）；但 codebuddy 常驻、首启靠 init 事件 resolve ready——_announceReady
   被 ready_announced 门控挡住，_ensureProcess 每轮都吃满 10s 竞速超时。
   修法：resolve ready 提到 announce 门控之前（幂等），session_ready 仍只发一次。
   实测 proc_start→turn 从 10.00s 降到 29ms。
2. **首启参数错**：start() 先置 started_once=true 再算 _buildArgs()，首启误带
   `--resume <uuid> --resume-create-missing`，没走 `--session-id` 固定会话身份。
   修法：先算 args 再置标记（ps 验证首启 args 含 --session-id）。

### 未覆盖项

- 图片输入：桥与 WebUI 已放行（协议与 claude 同构），真 CLI 未实弹复测。
- dontAsk/auto 权限档未映射（CLI 支持，桥白名单沿用 claude 四档）。


## v0.3 首帧鉴权 + hello（2026-10-25，ab482be）

环境：Windows Node v24，本地起服（端口 18642，frame_auth_timeout_s=3），
`node scripts/test-v03-auth.mjs` 12/12 PASS：未鉴权 hello 拒（not_authed）、
错 token auth_rejected + 4001 断、未鉴权 ping 仍 pong、对 token auth_ok、
hello 回版本能力（cws 2.1.0 caps×4）、URL token 直连即用、错 URL token 升级期
401、一次性 token 首帧消费 + 二次拒、静默连接窗口后 4001 断。
生产（pstore-new）部署后无 token 探测：连接保持 → 10s 后 close 4001 auth timeout；
错 URL token 401；webui 200。WebUI/QQ 的 URL token 路径未改动。

## CodeBuddy 上下文压缩适配（2026-10-25）

CLI 2.175 的 stream-json 协议里，压缩相关事件共三个（见
`dist-server/types/node/cli/stream-json-protocol.d.ts`）：

- `system/compact_boundary`：压缩完成，带 `compact_metadata{trigger: manual|auto, pre_tokens}`；
- `system/status`：`status: 'compacting' | null`，压缩开始/结束；
- `system/keepalive`：轮内周期性存活帧（事件循环还在转才会发）。

桥原先只识别 `system/init`，其余 subtype 全部丢弃 → 压缩对客户端不可见；
压缩期间没有正文输出，长压缩还可能被轮内空闲计时器误判。

### 实现

- `src/codebuddy-session.js`
  - `compact_boundary` → 落一条 sys 流水「上下文已压缩（自动/手动，压缩前 N tokens）」
    （重连 history 可回放）+ 广播 `compact` 帧（`text/trigger/pre_tokens/mid`）。
  - `status` → 广播 `compacting` 帧（`compacting: true|false`），并给轮内空闲计时器续期。
  - `keepalive` → 刷新 `last_activity`（任何 stdout 行本就续期，此处显式语义化）。
- `src/base-session.js`：`STREAM_POST_TYPES` 增加 `compact / compacting`（多端广播）。
- WebUI：`store.ts` 处理 `compact`（sys 行，按 mid 去重）/`compacting`（`info.compacting`）；
  `ChatHead` 顶栏显示「压缩中」；`final`/`turn_aborted`/`session_ready` 复位标志。
- README 桥→客户端 post_type 列表补两个帧。

### 验收（隔离测试服 :18643，mock-codebuddy）

- `scripts/mock-codebuddy.mjs` 增压缩序列（status→boundary→status→result）。
- wsclient 场景 `11.codebuddy_compact` PASS：
  `compacting:true` → `compact`（trigger=manual, pre_tokens=123456,
  text=「上下文已压缩（手动，压缩前 123456 tokens）」）→ `compacting:false` → `final`。
- `10.codebuddy_basic` 回归 PASS；turnlog 核对到 `role:"sys"` 压缩条目。
- `npm run build:webui`（tsc + vite）通过，产物含「压缩中」。

### 未覆盖

- 真 CLI 的自动压缩未实弹（需把上下文撑满），仅按协议类型定义 + mock 校验；
  真机首次触发时看 `cbc_compact` 日志与 WebUI 的 sys 行即可确认。
- 手动压缩未做按钮：会话里发 `/compact` 即走 CLI 内置命令（未在桥内验证，理论可达）。
- `system/mcp_status`、`task_*`、`topic`、`ai-title`、`result.modelUsage`/`_meta` 上下文用量
  仍未消费，需要时再补。

## CodeBuddy can_use_tool / AskUserQuestion 适配（2026-10-28）

CLI 2.176.0 实测推翻「headless 不产 can_use_tool」旧结论（2.170 时的行为）：

- `control_request/{subtype:"can_use_tool"}` 已在 `-p --input-format stream-json`
  下出现（非白名单工具、AskUserQuestion 都走它），无需 `--permission-prompt-tool`。
- 载荷与 claude 不同：control_response 的 response 要
  `{allowed:true, updatedInput}` / `{allowed:false, reason}`，不是 behavior 语义
  （回 behavior 会被当成 deny，报 "Permission denied by SDK"）。
- AskUserQuestion 须在启动后先发 `initialize` 控制请求声明
  `request.capabilities.askUserQuestion=true`，否则 headless 工具列表里没有该工具；
  allow 时 `updatedInput.answers`（键=问题文本）缺省会被 CLI 忽略并抛错。
- `ptc`/`minimal` agent 下 AskUserQuestion 经 REPL 沙箱代理，headless 中 CLI 内部
  超时自动降级为文本提问（CLI 侧限制）；`cli` agent 下直发，
  can_use_tool(tool_name=AskUserQuestion) → 带 answers 的 allow → 正常闭环。

### 实现

- `src/codebuddy-session.js`：start() 后发 initialize 握手；
  `_handleControlRequest` → ask 卡片（kind=question/permission，同 claude 帧格式）；
  `_askTimeout`/`askReply` 用 codebuddy 载荷（allow 无 updatedInput 时回填原 input）；
  reader close 时 `_expireAllAsks()`；control_response ack 亦解除 ready 等待。
- `scripts/mock-codebuddy.mjs`：对齐 2.176（initialize ack + can_use_tool +
  allowed 载荷；未声明能力时 AskUserQuestion 模拟文本降级）。
- `wsclient.mjs`：新场景 `12.codebuddy_ask`（question 卡 → answers → final）。

### 验收

- mock 隔离服 :18645：`10.codebuddy_basic` / `11.codebuddy_compact` 回归 PASS，
  `12.codebuddy_ask` PASS；另验 Bash 权限卡的 deny（`工具调用被拒绝：denied by user`）、
  allow 无 updatedInput（回填原 input 放行）、不回复 20s 超时
  （`ask timeout, denied by bridge`）三条路径均 PASS。
- 真 CLI 2.176.0（隔离服 :18646，机器默认登录态）：
  - default/ptc：Bash(REPL) 权限卡 allow+updatedInput → 执行成功，final「输出为：hello」；
  - cli agent：AskUserQuestion question 卡 → allow+answers → final「你选择了喜欢狗」；
  - ptc 下 REPL 内 AskUserQuestion 超时降级为文本（符合预期，CLI 限制）。

### 未覆盖

- QQ（onebot 插件）侧 ask 卡片渲染本就未实现，与后端无关。
- `allow_always`（记住选择）未接；桥只有 allow/deny 两态，与 claude 后端一致。

## 静默超时自动重发（2026-10-28）

### 现象与根因

`turn_timeout`（对话空闲预算 300s）仍在高频触发（10-28 一天 9 次），日志均
`idle_s:300`。抽 `mvnmxifrvj` 14:12 的轮次对账：

- 桥侧：`cbc_turn_start` 后 300s 整 `turn_timeout`，期间零 stdout；
- CLI transcript（`~/.codebuddy/projects/<cwd>/<sid>.jsonl`）：该轮**一条记录都没有**
  （连 user 消息都没落盘）→ 上游 API 请求挂死、首个 token 都没回来；
- 同一文本 14:25 重发，167s 正常完成（24.3 万 out_tokens）。

结论：空闲判定本身行为正确，卡的是渠道上游偶发挂起；缺的是挂死后的自愈。

### 实现

- `src/base-session.js`
  - `_markTurnSeen()`：本轮见过实质输出；`_turn_seen` 在 `_writeTurn` 前清零。
  - `_turnTimeout()`：整轮零输出且未重发过 → `turn_timeout_retry` 日志 +
    `abort('timeout')` + 落一条 sys 流水「本轮 Ns 无任何响应（疑似上游挂起），已自动重发」
    + 原样重发（`startTurn(..., {isRetry:true})`，`_turn_retries` 不清零，最多 1 次）。
    有输出的卡死照旧只 abort，不重发（防工具副作用重复）。
  - `STREAM_POST_TYPES` 增 `sys`（广播帧，带 mid 供前端去重）。
- 各后端 `_dispatch` 按帧类型调 `_markTurnSeen()`：`init` / `control_response`
  是握手噪声不算（实测 initialize ack 会晚于轮次开始到达，把 `_turn_seen` 污染成
  true 导致重发不触发——首版踩过）；`keepalive` / `control_request`（权限卡）
  算实质输出。
- WebUI：`store.ts` 处理 `sys` 帧（sys 行，mid 去重）；README 帧列表补全。
- `scripts/mock-codebuddy.mjs`：`沉默`（5s 全静默）与 `重试成功`（cwd 标记文件
  跨进程记次，首次挂死、重发即成功）两条探针。

### 验收（隔离服 :18647，turn_timeout=2）

- 挂死一次 + 重发成功：`user_msg → turn_aborted → sys「已自动重发」→ user_msg →
  delta → final:重试成功`，服务端日志 `turn_timeout_retry attempt:1` — PASS。
- 两次都挂死：第二次超时不再重发（retries 上限），`turn_aborted ×2`、无 final — PASS。
- 回归（:18648，正常配置）：`10.codebuddy_basic` / `11.codebuddy_compact` /
  `12.codebuddy_ask` 全 PASS；tsc + vite 构建过。

### 未覆盖

- 渠道上游为什么挂死（deepseek-v4.1-flash 端点偶发无首 token）——桥侧只能自愈，
  根因在渠道侧；若某渠道频繁触发，换渠道或在渠道侧加超时。
- 重发仅 1 次；连续挂两次说明上游大面积故障，交给人工。

## ptc/minimal 模式「问用户」适配（2026-10-29）

### 现象与根因（真 CLI 2.176 实测）

ptc 会话里模型把 AskUserQuestion 写进 REPL code 调（transcript 实锤：
`REPL：{"code":"const r = await AskUserQuestion({...})"}`），桥侧收不到任何
ask 通道帧，用户侧无问卡；CLI 内部挂等到嵌套审批超时（生产观测 ~380s 后
用户手动打字才继续）。

逆向 CLI bundle + 实测确认三层：

1. ptc/minimal 的对话层工具目录硬编码只有 REPL，AskUserQuestion 被归为
   「REPL 内部协调工具」，CLI 系统提示明令「never at the conversation layer」
   （即使 --append-system-prompt 让模型想直接调，catalog 里也没有该工具）；
2. REPL 嵌套审批在 stream-json 客户端不可达：`shouldAvoidNestedUi` 只豁免
   纯 --print 模式；无宿主 canUseTool 时走 `waitForNestedDecision`，
   默认 10 分钟（`lY=6e5`）后报 lJ「approval UI may not be reachable from
   this client」——CLI 作者留的唯一逃生门是 env
   `CODEBUDDY_REPL_NESTED_TIMEOUT_MS`；
3. 桥已声明的 initialize `capabilities.askUserQuestion`（7e6fa45）只对
   cli 模式对话层 ask 有效（can_use_tool 通道），对 REPL 嵌套无影响。

参数非法的嵌套调用会快速报错（validate 分支），合法参数才挂等——解释了
为何偶发且难复现。

### 实现

- `src/config.js`：新增 `codebuddy_repl_nested_timeout_ms`（默认 15000）。
- `src/codebuddy-session.js`
  - `_procEnv` 注入 `CODEBUDDY_REPL_NESTED_TIMEOUT_MS`：模型执意嵌套时
    15s 快速失败（实测 15.1s），CLI 错误文案自带恢复指引「put the question
    in your reply instead」，模型下一跳即改写正文提问；
  - ptc/minimal 启动参数追加 `--append-system-prompt`：引导模型需要用户
    决策时直接在回复正文列 A/B/C 选项结束本轮，不在 REPL 内调 ask
    （实测模型 100% 服从，轮次正常结束）。

### 验收（真 CLI + mock 隔离服）

- 引导生效：ptc + guidance → 模型正文提问「A 还是 B?」等回复，轮次 success，
  零嵌套调用 — PASS。
- 兜底生效：强令嵌套 → 15s 超时返回 lJ 错误，模型复述错误并承诺改正 — PASS。
- 回归（:18649）：`10.basic` / `11.compact` / `12.ask` 全 PASS
  （12 走 can_use_tool 直连通道，cli 模式不受影响）。
- `_buildArgs` 单测：`--append-system-prompt` 存在、agent=ptc。

### 未覆盖

- 结构化问卡（kind=question）在 ptc 模式不可达是 CLI 架构限制，等 CLI
  把嵌套审批接到 stream-json 控制通道后可撤掉 guidance；
- ExitPlanMode 嵌套同样受益于短超时（同一 isProductInteractionTool 通道），
  未单独实测。
