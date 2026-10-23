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

