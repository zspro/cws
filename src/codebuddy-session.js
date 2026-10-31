// cc-bridge (Node) — CodebuddySession: resident `codebuddy -p` stream-json adapter.
// Verified against @tencent-ai/codebuddy-code 2.176.0 (see ACCEPTANCE.md).
// 与 ClaudeSession 同构（常驻 stream-json 进程、事件同 schema），差异：
//   1. 权限/提问通道：CLI 2.176 headless 已支持 control_request/can_use_tool（实测），
//      但 control_response 的 allow/deny 载荷与 claude 不同——codebuddy 要
//      {allowed:true, updatedInput} / {allowed:false, reason}，不是 behavior 语义。
//      AskUserQuestion 需要 start() 后先发 initialize 握手声明
//      capabilities.askUserQuestion=true，且 allow 时 updatedInput 必须带 answers，
//      否则 CLI 抛 "allowed AskUserQuestion without answers" 忽略。
//   2. 频道经环境变量下发（CODEBUDDY_BASE_URL/CODEBUDDY_API_KEY，OpenAI 兼容协议，
//      SDK 在 base_url 后拼 /chat/completions），改频道需重启进程。
//   3. 权限切换走重启（不复用 set_permission_mode 控制请求）：bypassPermissions
//      追加 -y 使 CODEBUDDY_IS_SANDBOX=1 的沙箱全放行生效。
//   4. 复活用 --resume <sid> --resume-create-missing（历史被清时同 id 重开，不失败）；
//      首启用 --session-id 固定会话 ID，init 事件回读落盘兜底。
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { BaseSession } from './base-session.js';
import { CODEBUDDY_BIN, ALLOWED_TOOLS, PERMISSION_MODE, ASK_TIMEOUT, REAP_ON_DETACH, CODEBUDDY_AUTOCOMPACT, CODEBUDDY_REPL_NESTED_TIMEOUT_MS, PORT } from './config.js';
import {
  log, briefOf, detailOf as _detailOf, spawnDetached, killProcGroup, killProcGroupForce, waitProc, procAlive,
} from './util.js';

export function _procEnv(channel, cliUuid) {
  const env = { ...process.env, IS_SANDBOX: '1', CODEBUDDY_IS_SANDBOX: '1' };
  // ptc/minimal 的嵌套审批（REPL 内 await AskUserQuestion/ExitPlanMode）在
  // stream-json 下没有可达 UI，CLI 默认等 10 分钟（6e5ms）才报错。压短成
  // 快速失败，模型会按 CLI 提示把问题写进回复正文（见 _REPL_ASK_GUIDANCE）。
  if (CODEBUDDY_REPL_NESTED_TIMEOUT_MS > 0) {
    env.CODEBUDDY_REPL_NESTED_TIMEOUT_MS = String(CODEBUDDY_REPL_NESTED_TIMEOUT_MS);
  }
  if (channel !== null) {
    // 渠道接管端点与鉴权：清掉机器默认，避免默认渠道串台
    delete env.CODEBUDDY_BASE_URL;
    delete env.CODEBUDDY_API_KEY;
    if (channel.base_url) env.CODEBUDDY_BASE_URL = channel.base_url;
    if (channel.api_key) env.CODEBUDDY_API_KEY = channel.api_key;
    const headers = channel.http_headers;
    if (headers && typeof headers === 'object') {
      // CODEBUDDY_CUSTOM_HEADERS："Name: Value" 多行；{session_id} → 会话 uuid
      const lines = [];
      for (const [h, v] of Object.entries(headers)) {
        const value = String(v).replaceAll('{session_id}', cliUuid)
          .replaceAll('\\', '\\\\').replaceAll('\n', ' ').replaceAll('\r', ' ');
        lines.push(String(h).replaceAll(':', '') + ': ' + value);
      }
      if (lines.length) env.CODEBUDDY_CUSTOM_HEADERS = lines.join('\n');
    }
  }
  return env;
}

export const CODEBUDDY_AGENTS = ['cli', 'ptc', 'minimal', 'create', 'multitask'];
// CLI 真正认的开关是 --tool-mode（commander 校验的合法值只有这四个）；
// --agent 是派生 teammate 的参数，主 CLI 静默忽略——早先传 --agent 等于没切模式。
export const CODEBUDDY_TOOL_MODES = ['cli', 'ptc', 'minimal', 'create'];
// 未显式选择时的默认 agent 模式（PTC：省 token 的 code-mode）。
// 注：ptc 下 AskUserQuestion 只能写在 REPL 里，CLI 会走嵌套审批（headless 无宿主）；
// 问卡改走 MCP 工具 mcp.cwsask.ask_user（src/mcp-ask.js）：在 REPL 里是普通工具调用，
// 答案是真正的 tool_result，模型不会怀疑来源。直接调 AskUserQuestion 会被当场拒绝（0s），
// 不再「改写代码塞答案」——CLI 会把 updatedInput 当成模型自己写的入参存进 transcript，
// 模型回头看到答案字面量就认定是自己伪造的，实测整轮翻车。
export const DEFAULT_AGENT = 'ptc';
// 追加系统提示：需要用户决策时用 MCP 问卡工具（ptc/minimal 才挂），
// 拿不到就问正文；不要用 REPL 里的 AskUserQuestion / ExitPlanMode。
// REPL_NESTED_TIMEOUT_MS 保留作兜底（万一有漏网路径）。
const _REPL_ASK_GUIDANCE =
  '【问用户的方式】本会话是无界面的 stream-json 客户端。需要用户做选择时，' +
  '调用 MCP 工具 ask_user（REPL 里写作 mcp.cwsask.ask_user({question, options})，' +
  '工具全名 mcp__cwsask__ask_user），它会弹出真正的选项卡片并把用户的选择作为工具结果返回。' +
  '不要调用 REPL 里的 AskUserQuestion 或 ExitPlanMode（没有嵌套审批宿主，会被直接拒绝）。' +
  '如果 ask_user 不可用，就把问题和选项写进回复正文、结束本轮等用户回复。';

// 文件下载卡片的渲染约定：客户端只认「单独成行、原样的 /f/ 链接」。
// 写进代码块/加反引号/加粗都会退化成纯文本，用户点不了。
const _FILE_LINK_GUIDANCE =
  '【发文件给用户】要交付文件时调用 MCP 工具 share_file（REPL 里 mcp.cwsask.share_file({path})），' +
  '不要用代码块贴文件内容。发布成功后，把返回的下载链接单独占一行、原样写进回复正文：' +
  '不要放进代码围栏、不要加反引号、不要加粗、不要和别的字挤在同一行——' +
  '客户端靠这一行渲染成可点的文件下载卡片，格式错了用户就点不到。';

const _PTC_ASK_DENY =
  '本会话不能这样问用户：REPL 里的 AskUserQuestion / ExitPlanMode 没有审批宿主，' +
  '调用会一直挂着。请改用 MCP 工具 ask_user（REPL 里 mcp.cwsask.ask_user({question, options})），' +
  '拿不到就立刻把问题写进回复正文并结束本轮，不要重试同一个调用。';
export class CodebuddySession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    // codebuddy 权限档与 claude 同名同义（default/acceptEdits/plan/bypassPermissions
    // 均为 CLI 合法值），无需翻译；只挡掉未知值
    if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(this.launch_mode)) {
      this.launch_mode = 'default';
      this.permission_mode = 'default';
    }
    // agent 模式合法值 = CLI 内置产品 agent（dist isBuiltinAgentModeName）；
    // 未知名 CLI 静默回落默认，这里直接挡掉；未选则用 DEFAULT_AGENT
    if (this.agent_mode && !CODEBUDDY_AGENTS.includes(this.agent_mode)) {
      this.agent_mode = null;
    }
    if (!this.agent_mode) this.agent_mode = DEFAULT_AGENT;
    this.pending_agent = null;
    this.readerTask = null;
    this._spawnLock = Promise.resolve();
    this.ready = this._makeReady();
    // SIGTERM 已发、进程尚未退出（procAlive 仍为 true 的垂死窗口），
    // 同 ClaudeSession：start 见位先等死透再拉新。
    this.dying = false;
  }

  _makeReady() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve, done: false };
  }

  /** --mcp-config：把自家 MCP 问卡服务挂进 CLI（密钥按进程随机，只走回环） */
  _mcpAskConfig() {
    const secret = this.bridge && this.bridge.mcpAskSecret;
    if (!secret) return null;
    let script;
    try { script = fileURLToPath(new URL('./mcp-ask.js', import.meta.url)); } catch { return null; }
    return JSON.stringify({
      mcpServers: {
        cwsask: {
          command: process.execPath,
          args: [script],
          env: {
            CWS_ASK_URL: 'http://127.0.0.1:' + PORT + '/mcp-ask',
            CWS_ASK_SECRET: secret,
            CWS_ASK_SESSION: this.id,
          },
        },
      },
    });
  }

  _buildArgs() {
    const useResume = this.resume_flag || this.started_once;
    const args = [
      CODEBUDDY_BIN, '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', this.launch_mode,
      // 单个逗号串，避免 commander 变长参数吞掉后续选项。
      // ptc/minimal 的唯一直连工具是 REPL（其余走 REPL 沙箱内），
      // 不进 allowlist 的话 default 权限档下会被 CLI 直接拒绝
      '--allowedTools', (this.agent_mode === 'ptc' || this.agent_mode === 'minimal')
        ? ALLOWED_TOOLS + ',REPL,mcp__cwsask__ask_user,mcp__cwsask__share_file'
        : ALLOWED_TOOLS + ',mcp__cwsask__ask_user,mcp__cwsask__share_file',
    ];
    if (this.launch_mode === 'bypassPermissions') {
      // -y = bypassPermissions；CODEBUDDY_IS_SANDBOX=1 全放行依赖 -y 存在
      args.push('-y');
    }
    if (this.model_name) args.push('--model', this.model_name);
    if (this.agent_mode && CODEBUDDY_TOOL_MODES.includes(this.agent_mode)) {
      args.push('--tool-mode', this.agent_mode);
    }
    // 自家 MCP：ask_user（问卡）+ send_file（往笔上投文件）。cli 模式下问卡本来就有
    // 原生通道，但 send_file 一样有用，所以所有 codebuddy 模式都挂。
    const mcpCfg = this._mcpAskConfig();
    if (mcpCfg) args.push('--mcp-config', mcpCfg);
    // 系统提示合并成一次传（多次 --append-system-prompt 只保留最后一个）
    const guides = [];
    if (this.agent_mode === 'ptc' || this.agent_mode === 'minimal') {
      // REPL 里的 AskUserQuestion 走不通（嵌套审批无宿主）→ 指路 ask_user
      guides.push(_REPL_ASK_GUIDANCE);
    }
    guides.push(_FILE_LINK_GUIDANCE);
    if (guides.length) args.push('--append-system-prompt', guides.join(String.fromCharCode(10, 10)));
    // 超长会话防静默截断： nearing 阈值时 CLI 自动压缩（compact_boundary 事件
    // 由 _onCompact 落盘广播）。'auto' 在自定义渠道下不触发，必须显式给阈值
    if (CODEBUDDY_AUTOCOMPACT && CODEBUDDY_AUTOCOMPACT !== '0') {
      args.push('--autocompact', CODEBUDDY_AUTOCOMPACT);
    }
    if (useResume) {
      // --resume-create-missing：transcript 被 30 天清理/重装后同 id 重开，续轮不失败
      args.push('--resume', this.thread_id || this.cli_uuid, '--resume-create-missing');
    } else {
      args.push('--session-id', this.cli_uuid);
    }
    return args;
  }

  async start() {
    const prev = this._spawnLock;
    let release;
    this._spawnLock = new Promise((res) => { release = res; });
    await prev;
    try {
      if (procAlive(this.proc)) return;
      // 先算启动参数（此时 started_once 仍为 false → 首启用 --session-id 固定身份），
      // 再置 started_once：顺序反了会让首启误走 --resume
      const args = this._buildArgs();
      this.started_once = true;
      this.aborted_sent = false;
      this.ready = this._makeReady();
      this.proc = spawnDetached(CODEBUDDY_BIN, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: _procEnv(this.channel, this.cli_uuid),
      });
      this.dying = false;
      // 吞掉进程死后 stdin 的异步 EPIPE（Node 对 write 的 error 走异步事件）
      this.proc.stdin.on('error', () => {});
      this._startReader();
      // SDK 握手：声明 askUserQuestion 能力，AskUserQuestion 工具才会进 headless
      // 工具列表并走 can_use_tool 询问通道（实测 2.176：不声明则模型侧无此工具）
      try {
        await this._writeLine({
          type: 'control_request',
          request_id: 'init-' + crypto.randomBytes(4).toString('hex'),
          request: { subtype: 'initialize', hooks: {}, capabilities: { askUserQuestion: true } },
        });
      } catch (e) {
        log('cbc_handshake_err', { session_id: this.id, err: String(e) });
      }
      log('cbc_proc_start', { session_id: this.id, pid: this.proc.pid, resume: this.resume_flag });
    } finally {
      release();
    }
  }

  async _ensureProcess() {
    if (this.dying) {
      // 前一次 stop 的 SIGTERM 还在路上：等死透，超时补 SIGKILL，再拉新进程
      await waitProc(this.proc, 3000);
      killProcGroupForce(this.proc);
      await waitProc(this.proc, 1000);
      this.dying = false;
    }
    if (!procAlive(this.proc)) {
      await this.start();
    }
    // init 事件到达即算 ready（真 CLI 启动即发 init，无需握手）
    await Promise.race([this.ready.promise, new Promise((res) => setTimeout(res, 10000))]);
    // 上一轮运行中切换的权限/agent（pending_mode/pending_agent）：本轮边界
    // 重启进程换参生效
    if ((this.pending_mode || this.pending_agent) && procAlive(this.proc)) {
      this._killpg();
      await waitProc(this.proc, 5000);
      killProcGroupForce(this.proc);
      this.ready_announced = false;
      await this.start();
      await Promise.race([this.ready.promise, new Promise((res) => setTimeout(res, 10000))]);
      this.permission_mode = this.launch_mode;
      this.pending_mode = null;
      this.pending_agent = null;
    }
  }

  async _writeTurn(text, echo, images) {
    // user 消息 content 块数组：文字块 + 图片块（协议与 claude stream-json 同构）
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const im of images || []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
    }
    await this._writeLine({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.cli_uuid,
    });
    log('cbc_turn_start', { session_id: this.id, images: (images || []).length });
  }

  async _writeLine(obj) {
    if (!(procAlive(this.proc) && !this.proc.stdin.destroyed)) {
      throw new Error('process_dead');
    }
    const line = JSON.stringify(obj) + '\n';
    this.proc.stdin.write(line);
  }

  // ---------- stdout reader ----------
  _startReader() {
    const proc = this.proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      this._touchTurnTimer();
      this._dispatch(obj).catch((e) => {
        log('cbc_dispatch_err', { session_id: this.id, err: String(e) });
      });
    });
    rl.on('close', async () => {
      const code = proc.exitCode;
      log('cbc_proc_exit', { session_id: this.id, code });
      if (this.turn_active && !this.aborted_sent) {
        this.turn_active = false;
        this._cancelTurnTimer();
        await this.sendWs({
          post_type: 'turn_aborted', session_id: this.id,
          reason: 'process_exited', echo: this.turn_echo,
        });
      }
      await this._expireAllAsks();
      this.bridge.notifyCapacityChange();
    });
    this.readerTask = rl;
  }

  async _dispatch(obj) {
    // 静默重发判定：init / control_response 是握手噪声，不算实质输出
    if (obj.type !== 'control_response' && !(obj.type === 'system' && obj.subtype === 'init')) {
      this._markTurnSeen();
    }
    // 子代理帧（parent_tool_use_id 非空）：转成「子代理」工具卡（可展开看明细），
    // 但不进主对话流——正文不进 text_buf（final 不复读子代理）、delta 不广播、
    // 不封口主 Agent 卡（sub:true）。turnlog 同步落盘（重连回放可见）。
    if (obj.parent_tool_use_id) {
      this._touchTurnTimer();
      this.last_activity = Date.now() / 1000;
      if (obj.type === 'assistant') {
        for (const b of (obj.message && obj.message.content) || []) {
          if (b.type === 'text' && b.text) {
            await this._sendSubActivity('子代理', String(b.text).split('\n')[0], String(b.text));
          } else if (b.type === 'tool_use') {
            await this._sendSubActivity('子代理·' + b.name, briefOf(b.input || {}), _detailOf(b.input));
          }
        }
      }
      return;
    }
    const t = obj.type;
    if (t === 'system') {
      if (obj.subtype === 'init') {
        // --session-id 预置 ID 之外的回读（未来版本忽略预置时兜底续轮）
        const sid = String(obj.session_id || '');
        if (sid && sid !== this.cli_uuid && this.thread_id !== sid) {
          this.thread_id = sid;
          this._saveSessMeta();
        }
        await this._announceReady(obj.model);
      } else if (obj.subtype === 'compact_boundary') {
        await this._onCompact(obj);
      } else if (obj.subtype === 'status') {
        await this._onStatus(obj);
      } else if (obj.subtype === 'keepalive') {
        // 长工具/长推理期间 CLI 定期发存活帧：算活动，别让轮内空闲计时器误杀
        this.last_activity = Date.now() / 1000;
      }
    } else if (t === 'stream_event') {
      const ev = obj.event || {};
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) {
          this._toolPhaseEnd();
          // 只广播不落 buf：完整 assistant 帧随后到来，避免双写
          await this.sendWs({ post_type: 'delta', session_id: this.id, text: d.text });
        } else if (d.type === 'thinking_delta' && d.thinking) {
          this.last_activity = Date.now() / 1000;
          this.thinking_chars += d.thinking.length;
          await this.sendWs({
            post_type: 'thinking', session_id: this.id,
            tokens: Math.max(1, Math.round(this.thinking_chars / 4)),
          });
        }
      }
    } else if (t === 'assistant') {
      const blocks = (obj.message && obj.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          this._toolPhaseEnd();
          this.text_buf.push(b.text);
        } else if (b.type === 'tool_use') {
          this.last_activity = Date.now() / 1000;
          this._toolPhaseStart();
          const sealed = this._flushTextLog();
          if (sealed) {
            await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
          }
          const brief = briefOf(b.input || {});
          const detail = _detailOf(b.input);
          const tEntry = this._logTurn('tool', `${b.name}：${brief}`, { detail });
          await this.sendWs({
            post_type: 'tool_activity', session_id: this.id,
            tool: b.name, brief, mid: (tEntry || {}).id, detail,
          });
        }
      }
    } else if (t === 'control_response') {
      // initialize 握手的 ack：也解除 ready 等待（system/init 未到时提前放行首写）
      if (!this.ready.done) {
        this.ready.done = true;
        this.ready.resolve();
      }
      this.last_activity = Date.now() / 1000;
    } else if (t === 'control_request') {
      await this._handleControlRequest(obj);
    } else if (t === 'result') {
      await this._handleResult(obj);
    }
    // 'user' 帧（tool_result 回传）忽略
  }

  /** 子代理活动卡：turnlog 落盘 + 广播（sub:true，WebUI 不封口现有运行卡） */
  async _sendSubActivity(name, brief, detail) {
    brief = String(brief || '').slice(0, 120);
    detail = String(detail || '').slice(0, 4008);
    const entry = this._logTurn('tool', `${name}：${brief}`, { detail, sub: true });
    await this.sendWs({
      post_type: 'tool_activity', session_id: this.id,
      tool: name, brief, mid: (entry || {}).id, detail, sub: true,
    });
  }

  // ---------- permission / ask（can_use_tool，载荷与 claude 不同：allowed/updatedInput/reason） ----------
  async _handleControlRequest(obj) {
    const requestId = obj.request_id;
    const req = obj.request || {};
    if (req.subtype === 'can_use_tool') {
      const sealed = this._flushTextLog();
      if (sealed) {
        await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
      }
      const toolName = req.tool_name;
      // REPL 单元里调 AskUserQuestion/ExitPlanMode：CLI 会走嵌套审批，headless 没有宿主，
      // 只能等 15s 超时（模型还会连着重试）。当场拒绝并指路 MCP 问卡，0s 失败。
      const replCode = toolName === 'REPL' && req.input && typeof req.input.code === 'string'
        ? req.input.code : '';
      if (replCode && (/AskUserQuestion|ExitPlanMode/).test(replCode)) {
        log('cbc_ptc_ask_deny', { session_id: this.id });
        try {
          await this._writeLine({
            type: 'control_response',
            response: {
              subtype: 'success', request_id: requestId,
              response: { allowed: false, reason: _PTC_ASK_DENY },
            },
          });
        } catch { /* process gone */ }
        return;
      }
      // 宿主侧工具不弹权限卡：自家 MCP（cwsask: ask_user / share_file）+ CLI 的
      // 工具检索/延迟执行中间层（ToolSearch / DeferExecuteTool）——它们只是去调
      // 我们自己的工具，弹卡纯粹是噪声（实测用户得手点「允许」才能继续）
      const hostTool = toolName && (
        String(toolName).indexOf('cwsask') >= 0
        || toolName === 'ToolSearch' || toolName === 'DeferExecuteTool'
      );
      if (hostTool) {
        try {
          await this._writeLine({
            type: 'control_response',
            response: {
              subtype: 'success', request_id: requestId,
              response: { allowed: true, updatedInput: req.input || {} },
            },
          });
        } catch { /* process gone */ }
        return;
      }
      // REPL 单元已进 --allowedTools，但单元格里调用 MCP 工具时 CLI 会再问一次权限。
      // 笔上没法审代码，这张「权限请求 · REPL」卡纯噪声 → 直接放行（只对 ptc/minimal）。
      if (toolName === 'REPL' && (this.agent_mode === 'ptc' || this.agent_mode === 'minimal')) {
        try {
          await this._writeLine({
            type: 'control_response',
            response: {
              subtype: 'success', request_id: requestId,
              response: { allowed: true, updatedInput: req.input || {} },
            },
          });
        } catch { /* process gone */ }
        return;
      }
      const askId = crypto.randomBytes(16).toString('hex');
      const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
      const askFrame = {
        post_type: 'ask', session_id: this.id, ask_id: askId, kind,
        tool_name: toolName, input: req.input || {},
      };
      // input 留档：allow 未带 updatedInput 时回填原 input（CLI 允许 updatedInput
      // 缺省执行原参数，但回填更稳，且 AskUserQuestion 必须有 answers 才放行）
      const entry = {
        request_id: requestId, tool_name: toolName, input: req.input || {}, ask_frame: askFrame,
      };
      entry.timer = setTimeout(() => { this._askTimeout(askId).catch(() => {}); }, ASK_TIMEOUT * 1000);
      this.pending_asks.set(askId, entry);
      this.last_activity = Date.now() / 1000;
      await this.sendWs(askFrame);
      log('cbc_ask', { session_id: this.id, tool: toolName, kind });
    } else {
      // rewind 等其他控制请求一律拒绝，保持协议应答闭环
      try {
        await this._writeLine({
          type: 'control_response',
          response: {
            subtype: 'success', request_id: requestId,
            response: { allowed: false, reason: 'unsupported control request' },
          },
        });
      } catch { /* process gone */ }
    }
  }

  async _askTimeout(askId) {
    const entry = this.pending_asks.get(askId);
    if (!entry) return;
    this.pending_asks.delete(askId);
    // MCP 问卡没有 CLI 侧的控制请求：只 resolve 超时，别写 control_response
    if (entry.mcp) {
      entry.mcp.resolve({ behavior: 'timeout' });
      return;
    }
    log('cbc_ask_timeout', { session_id: this.id, tool: (entry.ask_frame || {}).tool_name });
    try {
      await this._writeLine({
        type: 'control_response',
        response: {
          subtype: 'success', request_id: entry.request_id,
          response: { allowed: false, reason: 'ask timeout, denied by bridge' },
        },
      });
    } catch { /* process gone */ }
    await this.sendWs({
      post_type: 'error', session_id: this.id, code: 'ask_timeout', ask_id: askId,
    });
  }

  async askReply(askId, behavior, message = null, updatedInput = null, echo = null) {
    const entry = this.pending_asks.get(askId);
    if (!entry) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'unknown_ask', ask_id: askId, echo,
      });
      return;
    }
    this.pending_asks.delete(askId);
    if (entry.timer) clearTimeout(entry.timer);
    // MCP 问卡：不回落给 CLI，直接把用户选择 resolve 给 MCP 子进程（工具返回值）
    if (entry.mcp) {
      const answers = updatedInput && typeof updatedInput.answers === 'object' && updatedInput.answers
        ? updatedInput.answers : {};
      const q = entry.mcp.question || '';
      const answer = behavior === 'allow'
        ? (answers[q] !== undefined ? answers[q] : Object.values(answers)[0] || '')
        : '';
      entry.mcp.resolve({
        behavior,
        answer: Array.isArray(answer) ? answer.join(' / ') : String(answer || ''),
        answers: behavior === 'allow' ? answers : undefined,
      });
      await this.sendWs({
        post_type: 'ask_replied', session_id: this.id, ask_id: askId, behavior, echo,
      });
      log('mcp_ask_replied', { session_id: this.id, behavior });
      return;
    }
    let resp;
    if (behavior === 'allow') {
      resp = {
        allowed: true,
        updatedInput: updatedInput !== null && updatedInput !== undefined ? updatedInput : (entry.input || {}),
      };
    } else {
      resp = { allowed: false, reason: message || 'denied by user' };
    }
    try {
      await this._writeLine({
        type: 'control_response',
        response: { subtype: 'success', request_id: entry.request_id, response: resp },
      });
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'ask_reply_failed', message: String(e), echo,
      });
      return;
    }
    await this.sendWs({
      post_type: 'ask_replied', session_id: this.id, ask_id: askId, behavior, echo,
    });
  }

  // ---------- 上下文压缩（CLI 2.175+ 自动/手动压缩） ----------
  // compact_boundary：压缩结束的一次性事实，落 sys 流水（重连可回放）+ 广播在线端。
  async _onCompact(obj) {
    const md = obj.compact_metadata || {};
    const trigger = md.trigger === 'manual' ? 'manual' : 'auto';
    const pre = Number(md.pre_tokens) || 0;
    const text = `上下文已压缩（${trigger === 'manual' ? '手动' : '自动'}${pre ? `，压缩前 ${pre} tokens` : ''}）`;
    this.last_activity = Date.now() / 1000;
    this._touchTurnTimer();
    const entry = this._logTurn('sys', text);
    await this.sendWs({
      post_type: 'compact', session_id: this.id, mid: (entry || {}).id,
      text, trigger, pre_tokens: pre,
    });
    log('cbc_compact', { session_id: this.id, trigger, pre_tokens: pre });
  }

  // status.compacting / null：压缩进行中的瞬时状态（可能持续数分钟且无正文输出，
  // 一并续期空闲计时器，避免压缩被当成卡死）。
  async _onStatus(obj) {
    if (!('status' in obj)) return;
    const compacting = obj.status === 'compacting';
    this.last_activity = Date.now() / 1000;
    this._touchTurnTimer();
    await this.sendWs({ post_type: 'compacting', session_id: this.id, compacting });
  }

  async _announceReady(model) {
    // bridge 对非 claude 后端在 new_session/revive 时已预置 ready_announced=true
    // 并代发过 session_ready（model:null）。常驻进程的 ready 等待必须在此解除——
    // 否则 _ensureProcess 每轮都白等 10s 竞速超时。resolve 幂等，先于 announce 门控。
    if (!this.ready.done) {
      this.ready.done = true;
      this.ready.resolve();
    }
    if (this.ready_announced) {
      if (model) this.model_name = model;
      return;
    }
    this.ready_announced = true;
    this.last_activity = Date.now() / 1000;
    if (model) this.model_name = model;
    await this.sendWs({
      post_type: 'session_ready', session_id: this.id,
      model: this.model_name,
      channel: (this.channel || {}).name,
      permission_mode: this.permission_mode,
      agent_mode: this.agent_mode || null,
      backend: this.backend,
      echo: this.pending_echo,
    });
    this.pending_echo = null;
    log('session_ready', { session_id: this.id, backend: 'codebuddy' });
  }

  async _handleResult(obj) {
    this.turn_active = false;
    this._cancelTurnTimer();
    this._toolPhaseEnd();
    this.last_activity = Date.now() / 1000;
    const usage = obj.usage || {};
    const finalText = obj.result || this.text_buf.join('');
    const sealed = this._flushTextLog();
    let finalMid = (sealed || {}).id;
    // 无 delta 但 result 带全文的轮次：落盘否则回放丢失
    if (!sealed && finalText && finalText.trim()) {
      finalMid = (this._logTurn('cc', finalText) || {}).id;
    }
    await this.sendWs({
      post_type: 'final', session_id: this.id,
      text: finalText,
      mid: finalMid,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        reasoning_tokens: usage.reasoning_tokens,
      },
      cost_usd: obj.total_cost_usd,
      duration_ms: obj.duration_ms,
      num_turns: obj.num_turns,
      is_error: !!obj.is_error,
      subtype: obj.subtype,
      echo: this.turn_echo,
    });
    if (REAP_ON_DETACH && this.detached) this._killpg();
    log('cbc_turn_end', {
      session_id: this.id, dur_ms: obj.duration_ms,
      out_tokens: usage.output_tokens, is_error: obj.is_error,
    });
  }

  // ---------- permission / channel：重启生效（resident 进程换参必须重启） ----------
  async setPermission(mode, echo = null) {
    if (!mode) mode = PERMISSION_MODE;
    this.launch_mode = mode;
    this._saveSessMeta();
    if (this.turn_active) {
      // 运行中：记 pending，下一轮 _ensureProcess 边界重启生效
      this.pending_mode = mode;
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'busy',
        message: 'cannot switch permission during turn', echo,
      });
      return;
    }
    if (!procAlive(this.proc)) {
      this.permission_mode = mode;
      await this.sendWs({ post_type: 'permission_ack', session_id: this.id, mode, applied: false, echo });
      return;
    }
    log('cbc_permission_restart', { session_id: this.id, mode });
    this._killpg();
    await waitProc(this.proc, 5000);
    killProcGroupForce(this.proc);
    try {
      await this.start();
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'set_permission_failed', message: String(e), echo,
      });
      return;
    }
    this.permission_mode = mode;
    this.ready_announced = false;
    await this.sendWs({ post_type: 'permission_ack', session_id: this.id, mode, applied: true, echo });
  }

  async _deferSwitchMode(mode) {
    // 接管路径（proc 存活）的延迟切换：本轮边界重启生效
    this.pending_mode = mode;
  }

  async _deferSwitchAgent(mode) {
    // 同上：agent 模式的延迟切换
    this.pending_agent = mode;
  }

  // ---------- agent 模式：与权限同构，重启生效（常驻进程换参必须重启） ----------
  async setAgent(mode, echo = null) {
    this.agent_mode = mode || null;
    if (!this.agent_mode) this.agent_mode = DEFAULT_AGENT;
    if (this.agent_mode && !CODEBUDDY_AGENTS.includes(this.agent_mode)) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'bad_agent_mode',
        message: 'unknown agent mode: ' + this.agent_mode, echo,
      });
      return;
    }
    this._saveSessMeta();
    if (this.turn_active) {
      // 运行中：记 pending，下一轮 _ensureProcess 边界重启生效
      this.pending_agent = mode;
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'busy',
        message: 'cannot switch agent during turn', echo,
      });
      return;
    }
    if (!procAlive(this.proc)) {
      await this.sendWs({ post_type: 'agent_ack', session_id: this.id, agent: mode, applied: false, echo });
      return;
    }
    log('cbc_agent_restart', { session_id: this.id, agent: mode });
    this._killpg();
    await waitProc(this.proc, 5000);
    killProcGroupForce(this.proc);
    try {
      await this.start();
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'set_agent_failed', message: String(e), echo,
      });
      return;
    }
    this.ready_announced = false;
    await this.sendWs({ post_type: 'agent_ack', session_id: this.id, agent: mode, applied: true, echo });
  }

  async setChannel(channel, model = null, echo = null, clear = false) {
    if (channel === null && model === null && !clear) {
      await this.sendWs({
        post_type: 'model_ack', session_id: this.id,
        channel: (this.channel || {}).name, model: this.model_name, applied: false, echo,
      });
      return;
    }
    if (channel === null && model && !clear && this.channel !== null) {
      channel = { ...this.channel };
    }
    if (channel !== null && model) {
      channel = { ...channel, model };
    }
    this.channel = channel;
    if (channel === null) {
      this.model_name = model || null;
    } else {
      this.model_name = channel.model || null;
    }
    this._saveSessMeta();
    const chanName = (channel || {}).name;
    if (this.turn_active) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'busy',
        message: 'cannot switch model during turn', echo,
      });
      return;
    }
    if (!procAlive(this.proc)) {
      await this.sendWs({
        post_type: 'model_ack', session_id: this.id,
        channel: chanName, model: this.model_name, applied: false, echo,
      });
      return;
    }
    log('cbc_channel_restart', { session_id: this.id, channel: chanName, model: this.model_name });
    this._killpg();
    await waitProc(this.proc, 5000);
    killProcGroupForce(this.proc);
    try {
      await this.start();
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'set_channel_failed', message: String(e), echo,
      });
      return;
    }
    this.ready_announced = false;
    await this.sendWs({
      post_type: 'model_ack', session_id: this.id,
      channel: chanName, model: this.model_name, applied: true, echo,
    });
  }

  // ---------- stop / teardown ----------
  async abort(reason = 'user') {
    if (!this.turn_active) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'not_running', message: 'no active turn',
      });
      return;
    }
    this._killpg();
    if (!this.aborted_sent) {
      this.aborted_sent = true;
      this.turn_active = false;
      this._cancelTurnTimer();
      const sealed = this._flushTextLog();
      if (sealed) {
        await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
      }
      await this.sendWs({
        post_type: 'turn_aborted', session_id: this.id, reason, echo: this.turn_echo,
      });
    }
    // SIGTERM 后优雅退出可能 >2s：超时补 SIGKILL，防下一发 send 写进垂死进程
    await waitProc(this.proc, 2000);
    if (killProcGroupForce(this.proc)) {
      await waitProc(this.proc, 1000);
    }
  }

  _killpg() {
    if (killProcGroup(this.proc)) this.dying = true;
  }

  async _killProcess() {
    if (procAlive(this.proc)) {
      this._killpg();
      await waitProc(this.proc, 5000);
      killProcGroupForce(this.proc);
    }
  }
}
