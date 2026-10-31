# cws — 多会话 WebSocket 桥（Node.js）

把**本地 claude / codex / codebuddy CLI** 与**远程 OpenClaw 网关**统一成多会话 WebSocket 服务：
QQ 机器人、WebUI、任意客户端都能在线创建/接管会话、流式对话、审批权限、切换模型。
协议 v0.2（与 Python 版 cc-bridge 完全兼容）+ v0.3 增量，内置 WebUI。

## 协议 v0.3（2.1.0，向后兼容）

- **首帧鉴权**：连接可不带 `?token=`，升级后限时（`frame_auth_timeout_s`，默认 10s）
  等首帧 `{action:"auth", params:{token}}` → 回 `auth_ok`；期间只放行 auth/ping，
  其余 `not_authed` 拒答，超时/错 token 以 4001 断开。token 从此不进反代访问日志。
  URL `?token=`（v0.2，WebUI/QQ）原样兼容；一次性 token 两条路都认。
- **hello 版本交换**：`{action:"hello", params:{client, version, caps}}` →
  `{post_type:"hello", server:"cws", version, caps}`（SERVER_VERSION 取 package.json，
  SERVER_CAPS 在 src/config.js）。客户端凭 caps 做特性 gating。
- 验收：`node scripts/test-v03-auth.mjs`（12 项：新旧双路径/未鉴权门禁/一次性
  token 消费/静默超时断开）。

## 五后端架构（一站式遥控台）

| 后端 | 对象 | 方式 |
|---|---|---|
| `claude` | 本地 Claude Code CLI | spawn `claude -p` stream-json |
| `codex` | 本地 Codex CLI | spawn `codex exec --json`（JSONL） |
| `codebuddy` | 本地 CodeBuddy Code CLI（腾讯） | spawn `codebuddy -p` stream-json |
| `codebuddy-tui` | 同上，但跑**交互式 TUI** | `node-pty` 真终端 + 浏览器 xterm.js 镜像 |
| `openclaw` | **远程 OpenClaw 网关** | 官方 @openclaw/gateway-client（Gateway WS 协议 v4） |

上游渠道（channels.json）只是 claude/codex 各自连的模型端点（glm/kimi/任意
anthropic|openai 兼容端点），与后端解耦。旧 Python 实现保留在 `legacy-py/`。

## 快速开始

```bash
npm install
cp config.example.json config.json      # 端口/路径/限流/webui/gateways 开关
cp secrets.example.json secrets.json    # token + 渠道 key（chmod 600）
# channels.json 内置 glm/kimi 模型渠道模板，按需增删
node src/server.js
# 浏览器打开 http://<host>:8642/  → 输入 token 即可在线使用
```

claude 后端需要 `claude` CLI 已登录；codex 后端需要 `codex` CLI；codebuddy 后端
需要 `codebuddy` CLI（`npm install -g @tencent-ai/codebuddy-code`，登录或配
`CODEBUDDY_API_KEY`）；openclaw 后端需要在 config.json 里 `gateways.openclaw`
配好远程网关（url+token）。

## 配置文件（三层拆分，开源友好）

| 文件 | 内容 | 是否提交 |
|---|---|---|
| `config.json` | 端口/CLI 路径/默认后端/限流/超时/webui/**gateways** | 可提交(模板) |
| `channels.json` | 渠道列表（name/label/base_url/protocol/wire_api/model/api_key_env），不含 key | 可提交 |
| `secrets.json` | `token` / `one_time_tokens` / 渠道 `api_keys` | gitignore，0600 |

加载顺序 config ← channels ← secrets；渠道 key 优先级：内联 > secrets.api_keys[name] >
环境变量(api_key_env)。运行期渠道增删改与一次性 token 消费自动写回磁盘。

### 渠道 protocol 字段

| 值 | 用途 |
|---|---|
| `anthropic` | claude 后端（/v1/messages） |
| `openai` | codex 后端（/v1/responses 或 /v1/chat/completions，由 wire_api 决定） |
| `auto` | 双协议，自动探测 |

## 遥控远程 OpenClaw（openclaw 后端）

龙虾 = [OpenClaw](https://github.com/openclaw/openclaw)：开源 AI Agent 网关（IM 渠道 →
编程 Agent）。cws 把它当作**平级后端**：用官方 `@openclaw/gateway-client` 走
Gateway WS 协议 v4 直连远程网关，遥控其会话。

config.json 配置远程网关：

```json
{ "gateways": { "openclaw": { "url": "ws://YOUR_GATEWAY:18789", "token": "OPENCLAW_GATEWAY_TOKEN", "agent": "main" } } }
```

WebUI 新建会话选后端「openclaw」：发送 → 网关 `chat.send` + `chat` 流式事件（delta/
final）→ cws delta/final；远程执行审批 → `session.approval` 事件 → ask 卡片 →
`approval.resolve` 决议；模型/权限切换 → `sessions.patch`；历史 → `chat.history`。
协议细节与实测见 [docs/openclaw.md](docs/openclaw.md)。

## Codex 后端适配要点

- 每轮启动一次 `codex exec --json --skip-git-repo-check`（首轮）/
  `codex exec resume <thread_id>`（续轮），解析 JSONL 事件映射为 v0.2 帧。
- thread_id 随会话落盘 sess.json，桥重启后续轮仍可 resume。
- 渠道经 `-c model_provider=…`/`-c model_providers.<名>.{name,base_url,env_key,wire_api}`
  下发，密钥经渠道 env_key 环境变量注入子进程。
- **codex ≥0.135 只支持 wire_api=responses**（chat 已移除），适配器默认 responses。
- 权限等级 = sandbox 级别：read-only / workspace-write / danger-full-access / full-auto。

## CodeBuddy 后端适配要点

- `npm install -g @tencent-ai/codebuddy-code` 后二进制为 `codebuddy`（别名 cbc），
  路径可在 config.json `codebuddy_bin` / WebUI「后端与网关」改。
- 常驻进程 `codebuddy -p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --permission-mode <档> --allowedTools <白名单>`；
  事件 schema 与 claude stream-json 同构（system/init、stream_event、assistant、result）。
- 首启用 `--session-id <uuid>` 固定会话身份；复活用 `--resume <id> --resume-create-missing`
  （transcript 被清理时同 id 重开，续轮不失败）。
- **权限/提问通道**（CLI ≥2.176 实测）：启动即发 `initialize` 控制请求声明
  `capabilities.askUserQuestion`；default 档下非白名单工具触发
  `control_request/can_use_tool` → ask 卡片（与 claude 同协议，载荷不同：
  codebuddy 用 `{allowed,updatedInput}` / `{allowed:false,reason}`，不用 behavior）。
  AskUserQuestion 在 `cli` agent 下走 kind=question 的提问卡片（allow 需带
  `answers`）；`ptc`/`minimal` 下该工具经 REPL 沙箱代理，而 REPL 嵌套审批的宿主
  是交互 TUI（headless 客户端没有），结构化问卡不可达——默认 agent 为 `ptc`，
  用追加系统提示 + 15s 嵌套超时降级为正文提问；需要问卡请切标准模式（cli）。bypassPermissions 照旧全放行（自动追加 `-y`，并注入
  `CODEBUDDY_IS_SANDBOX=1` 沙箱全放行）。
  权限/渠道切换 = 重启进程换参（支持运行中改，下一轮边界生效）。
- **agent 模式开关是 `--tool-mode <cli|ptc|minimal|create>`**。`--agent` 只对派生
  teammate 生效，主 CLI 静默忽略——传 `--agent` 等于没切模式（2.179 实测）。
- 渠道协议须为 **openai**（SDK 在 base_url 后拼 `/chat/completions`，Bearer 鉴权）：
  base_url→`CODEBUDDY_BASE_URL`、api_key→`CODEBUDDY_API_KEY`、
  http_headers→`CODEBUDDY_CUSTOM_HEADERS`（`{session_id}` 占位符可用）。
- 权限档与 claude 同名：default / acceptEdits / plan / bypassPermissions。
- 发图支持（user 消息 image content 块，协议与 claude 同构；真 CLI 待实弹复测）。

## CodeBuddy TUI 后端（codebuddy-tui）

headless 的 `codebuddy` 后端在 ptc/minimal 下够不着 REPL 嵌套审批（宿主是交互
TUI，见 ACCEPTANCE.md）；`codebuddy-tui` 直接把真 TUI 跑在 PTY 里，浏览器用
xterm.js 镜像同一块屏幕，键盘原样写回——问卡、权限框、斜杠命令全部照 TUI 原生
工作，不依赖任何协议逆向。

- 依赖 `node-pty`（可选原生模块，装不上只影响本后端，桥其余功能照常）。
- 会话建立即预启动进程（打开页面就有画面），新目录首次运行的「信任文件夹？」
  提问由桥自动回车选「Trust folder only」。
- 输入：WebUI 底部输入框 → 文字写进 TUI 输入框 + 回车（等价手敲，会记入会话
  标题）；中断 = Ctrl-C。终端面板里也能直接敲任何键（含斜杠命令）。
- 换权限/agent 模式/渠道 = 重启 PTY，用 `--resume <id>` 续同一会话，客户端收到
  `term_reset` 清屏后接新 `term_ready`。
- 输出按 24ms 合帧广播，回放快照保留最近 200K 字符；进程退出发 `term_exit`，
  下次输入自动重新拉起。
- 发图不走该后端（TUI 没有图片入参），请在终端里用文件路径引用。

## WebUI

- **登录**：token（支持一次性 token 消费、`?token=` 直达、`?sid=` 直达会话）。
- **会话**：新建（选后端/渠道/模型/权限）、列表、接管切换、删除；多端实时同步
  （history + user_msg/cc_msg/tool_activity/delta 流 + 水位增量补推）。
- **审批**：claude 权限请求卡片、AskUserQuestion 选项卡片、openclaw 执行审批卡片。
- **后端配置**：侧栏「后端与网关」里改 claude/codex 路径、默认后端、OpenClaw 网关
  （增删改 + 连通测试），保存即写回 config.json/secrets.json。
- **统一管理上游模型**：渠道增删改、设默认、连通测试（延迟）、拉取上游模型列表、
  每会话渠道/模型热切换。

## 帧协议（v0.2 + 扩展）

客户端→桥：`ping / new_session / sessions.sync / send / stop / drop_session /
sessions.list / ask_reply / set_permission / set_model / channels.list / channels.save /
channels.delete / channels.set_default / channel.test / channel.models /
term_input / term_resize / term_attach`（均带 echo 回传）。

桥→客户端 post_type：`session_ready / session_queued / send_ack / stop_ack /
user_msg / cc_msg / delta / thinking / tool_activity / ask / ask_replied / final /
turn_aborted / session_closed / compact / compacting / sys / history / sessions / sync_done /
pong / error / channels / channels_saved / channels_deleted / channels_default /
channel_test / channel_models / permission_ack / model_ack /
term_ready / term_history / term_data / term_reset / term_exit`。

终端帧（仅 `codebuddy-tui`）：`term_input{data}` 原样键盘字节、`term_resize{cols,rows}`、
`term_attach` 请求快照；下行 `term_ready{cols,rows,pid}`、`term_history{data}`、
`term_data{data}`、`term_reset`（清屏）、`term_exit{code,signal}`。四类输出帧都在
`STREAM_POST_TYPES` 里，多端连接同步镜像。

扩展字段：new_session 参数加
`backend: "claude"|"codex"|"codebuddy"|"codebuddy-tui"|"openclaw"` 与
`gateway`/`remote_key`/`agent`；session_ready / sessions.list 带 `backend`。旧客户端零改动。

## 部署（systemd）

```bash
sudo cp cws.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cws
# 端口 0.0.0.0:8642，UFW 放行 8642/tcp；热重启 ./restart_bridge.sh [delay]
```

## 开发与验收

- `node wsclient.mjs --url ws://127.0.0.1:8642/ws --scenario all` — 10 场景验收客户端
  （claude 基本/并行/权限拒绝/提问/中断续聊/杂项 + codex 基本/中断 + openclaw 基本
  + codebuddy 基本）。
- `scripts/mock-claude.mjs` / `scripts/mock-codex.mjs` / `scripts/mock-openclaw-gateway.mjs`
  / `scripts/mock-codebuddy.mjs` — 免 key 的全协议 mock，离线跑通四后端全链路。
- 实弹切换：claude_bin/codex_bin/codebuddy_bin 指向真实 CLI，gateways.openclaw 指向真实网关。

## 安全

- token 只走 query 或 WebUI 登录框；日志/访问日志永不打印 token 与消息正文。
- 每会话独立工作目录 `workspaces/<sid>/`；本地 CLI 以独立进程组运行（stop 只杀自己）。
- secrets.json 0600；从环境变量解析的 key 永不落盘。
- WebUI 静态服务带路径穿越防护（403/404）。

