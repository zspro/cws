// cws — CodebuddyTuiSession：用真 PTY 跑 `codebuddy` 的交互式 TUI。
//
// 为什么要有这条路：headless stream-json（CodebuddySession）里 ptc/minimal 的
// 嵌套审批没有宿主，REPL 内的 AskUserQuestion 永远等不到 UI（见 ACCEPTANCE.md）。
// 而 TUI 自己就是审批宿主——问卡、权限框、斜杠命令全在终端里可达。所以这里不
// 解析协议，只把 PTY 的字节流原样镜像给 WebUI（xterm.js），键盘原样写回。
//
// 协议：
//   下行 term_history {data, cols, rows}   接入时的回放快照
//   下行 term_ready   {cols, rows, pid}
//   下行 term_data    {data}               增量输出（广播给所有连接）
//   下行 term_reset   {}                   会话重启（换 agent/权限/渠道）：客户端清屏
//   下行 term_exit    {code, signal}       进程退出（下次输入会重新拉起）
//   上行 term_input   {data}               原样键盘字节
//   上行 term_resize  {cols, rows}
//   上行 term_attach                       请求回放快照
//
// 行输入仍走 startTurn：文字写进输入框 + 回车，README 里说明它等价于手敲。
import { createRequire } from 'node:module';
import process from 'node:process';
import { BaseSession } from './base-session.js';
import { CODEBUDDY_BIN, PERMISSION_MODE } from './config.js';
import { log } from './util.js';
import { _procEnv, CODEBUDDY_AGENTS, CODEBUDDY_TOOL_MODES, DEFAULT_AGENT } from './codebuddy-session.js';

const require = createRequire(import.meta.url);

/** node-pty 是可选原生依赖：装不上时只有 TUI 后端不可用，桥其余部分照常。 */
function loadPty() {
  try {
    return require('node-pty');
  } catch (e) {
    log('tui_pty_missing', { err: String(e) });
    return null;
  }
}

const SCROLLBACK_MAX = 200 * 1024; // 字符数；够 xterm 重绘两三屏，且不会爆 WS
const FLUSH_MS = 24; // 输出合帧：TUI 重绘很碎，逐块广播会把 WS 打满
const TRUST_RE = /Do you trust the files in this folder\?/;

export class CodebuddyTuiSession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(this.launch_mode)) {
      this.launch_mode = 'default';
      this.permission_mode = 'default';
    }
    if (this.agent_mode && !CODEBUDDY_AGENTS.includes(this.agent_mode)) this.agent_mode = null;
    if (!this.agent_mode) this.agent_mode = DEFAULT_AGENT; // PTC 默认，别动
    this.backend = 'codebuddy-tui';
    this.pty = null;
    this.cols = 110;
    this.rows = 32;
    this.scroll = '';
    this._pending = '';
    this._flushTimer = null;
    this._trustAnswered = false;
    this._inputBuf = '';
    this._lastUserLine = '';
    this._spawnLock = Promise.resolve();
    this._queued = ''; // 进程还没起来时先攒键，起来后补写（否则终端打头几个字就丢）
  }

  /** 预启动：新会话建立即拉起 TUI，打开页面就能看见界面而不是黑屏。 */
  async start() {
    await this._ensureProcess();
  }

  // ---------- 进程 ----------
  _buildArgs() {
    const useResume = this.resume_flag || this.started_once;
    const args = ['--permission-mode', this.launch_mode];
    // --tool-mode 才是主 CLI 的模式开关；--agent 只对派生 teammate 生效（会被忽略）
    if (this.agent_mode && CODEBUDDY_TOOL_MODES.includes(this.agent_mode)) {
      args.push('--tool-mode', this.agent_mode);
    }
    if (this.model_name) args.push('--model', this.model_name);
    if (this.launch_mode === 'bypassPermissions') args.push('-y');
    if (useResume) args.push('--resume', this.thread_id || this.cli_uuid, '--resume-create-missing');
    else args.push('--session-id', this.cli_uuid);
    return args;
  }

  _alive() {
    return !!(this.pty && this.pty.exitCode === null && this.pty.signalCode === null);
  }

  async _ensureProcess() {
    const prev = this._spawnLock;
    let release;
    this._spawnLock = new Promise((res) => { release = res; });
    await prev;
    try {
      if (this._alive()) return;
      const pty = loadPty();
      if (!pty) throw new Error('node-pty 不可用（TUI 后端需要原生 PTY 模块）');
      const args = this._buildArgs();
      this.started_once = true;
      const env = { ..._procEnv(this.channel, this.cli_uuid),
        TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' };
      // TUI 里问卡是可达的，别再压短嵌套审批超时
      delete env.CODEBUDDY_REPL_NESTED_TIMEOUT_MS;
      // CI=1 会让 CLI 关掉交互 TUI
      delete env.CI;
      const term = pty.spawn(CODEBUDDY_BIN, args, {
        name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
      });
      // procAlive/killProcGroup 读的是 exitCode/signalCode：给 IPty 补同样的形状，
      // 让 BaseSession/bridge 的存活判断与进程组回收对 TUI 进程同样成立
      term.exitCode = null;
      term.signalCode = null;
      this.pty = term;
      this.proc = term;
      this._trustAnswered = false;
      term.onData((d) => this._onData(d));
      term.onExit(({ exitCode, signal }) => {
        term.exitCode = exitCode ?? 0;
        term.signalCode = signal ?? null;
        log('tui_exit', { session_id: this.id, code: exitCode, signal });
        this._flushPending();
        this.sendWs({ post_type: 'term_exit', session_id: this.id, code: exitCode, signal: signal ?? null })
          .catch(() => {});
      });
      await this.sendWs({
        post_type: 'term_ready', session_id: this.id, cols: this.cols, rows: this.rows, pid: term.pid,
      });
      log('tui_spawn', { session_id: this.id, pid: term.pid, agent: this.agent_mode, mode: this.launch_mode });
      if (this._queued) {
        const q = this._queued;
        this._queued = '';
        this._writePty(q);
      }
    } finally {
      release();
    }
  }

  _onData(d) {
    // 新目录首次进 TUI 会弹「信任文件夹？」——回车选中的就是第一项
    // （Trust folder only），这里替用户按一次，省得终端一直卡在提问页
    if (!this._trustAnswered && TRUST_RE.test(d)) {
      this._trustAnswered = true;
      setTimeout(() => { this._writePty('\r'); }, 400);
      log('tui_auto_trust', { session_id: this.id, cwd: this.cwd });
    }
    this.scroll += d;
    if (this.scroll.length > SCROLLBACK_MAX) this.scroll = this.scroll.slice(-SCROLLBACK_MAX);
    this._pending += d;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this._flushPending(), FLUSH_MS);
  }

  _flushPending() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._pending) return;
    const data = this._pending;
    this._pending = '';
    this.sendWs({ post_type: 'term_data', session_id: this.id, data }).catch(() => {});
  }

  _writePty(d) {
    if (!this._alive()) return false;
    try {
      this.pty.write(d);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 输入 ----------
  /** 浏览器键盘：原样写回 PTY。顺便把回车前的行记成 user 流水（侧栏标题用）。 */
  termInput(data) {
    const s = String(data || '');
    if (!s) return;
    this._trackLine(s);
    if (!this._writePty(s)) {
      this._queued += s;
      this._ensureProcess().catch(() => {});
    }
  }

  termResize(cols, rows) {
    const c = Math.max(20, Math.min(400, Math.round(Number(cols) || 0)));
    const r = Math.max(6, Math.min(200, Math.round(Number(rows) || 0)));
    if (!c || !r) return;
    this.cols = c;
    this.rows = r;
    try { this.pty && this.pty.resize(c, r); } catch { /* ignore */ }
  }

  async termSnapshot() {
    await this.sendWs({
      post_type: 'term_history', session_id: this.id,
      data: this.scroll, cols: this.cols, rows: this.rows,
    });
  }

  _trackLine(raw) {
    const s = String(raw).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); // 去 CSI（方向键/功能键）
    for (const ch of s) {
      if (ch === '\r') {
        const line = this._inputBuf.trim();
        this._inputBuf = '';
        if (line && line !== this._lastUserLine) {
          this._lastUserLine = line;
          this._logTurn('user', line.slice(0, 200));
        }
      } else if (ch === '\x7f' || ch === '\b') {
        this._inputBuf = this._inputBuf.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x1b') {
        this._inputBuf = '';
      } else if (ch >= ' ') {
        this._inputBuf = (this._inputBuf + ch).slice(-400);
      }
    }
  }

  // ---------- 轮次：终端里手敲等价，Composer 发来的文字直接写进输入框 ----------
  async startTurn(text, echo = null, images = null) {
    if (images && images.length) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'no_image_support',
        message: 'TUI 终端后端不走发图通道，请在终端里用路径引用图片', echo,
      });
      return;
    }
    const clean = String(text || '').replace(/\r?\n+/g, ' ').trim();
    if (!clean) return;
    await this._ensureProcess();
    this._writePty(clean);
    this._writePty('\r');
    this._lastUserLine = clean;
    const entry = this._logTurn('user', clean);
    if (entry) {
      await this.sendWs({ post_type: 'user_msg', session_id: this.id, mid: entry.id, text: clean });
    }
  }

  /** 终端里的 Ctrl-C 就是中断；这里复用同一动作。 */
  async abort(reason = 'user') {
    if (!this._writePty('\x03')) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'not_running', message: 'TUI 未运行' });
      return;
    }
    log('tui_interrupt', { session_id: this.id, reason });
  }

  async _askTimeout() { /* TUI 没有桥侧 ask 状态 */ }

  // ---------- 重启类切换：换参必须新起进程，--resume 续同一会话 ----------
  async _restart(reason) {
    log('tui_restart', { session_id: this.id, reason });
    if (this._alive()) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
      this.proc = null;
    }
    this.scroll = '';
    await this.sendWs({ post_type: 'term_reset', session_id: this.id });
    await this._ensureProcess();
  }

  async setPermission(mode, echo = null) {
    this.launch_mode = mode || PERMISSION_MODE;
    this.permission_mode = this.launch_mode;
    this._saveSessMeta();
    await this._restart('permission:' + this.launch_mode);
    await this.sendWs({
      post_type: 'permission_ack', session_id: this.id, mode: this.launch_mode, applied: true, echo,
    });
  }

  async setAgent(mode, echo = null) {
    const next = mode || DEFAULT_AGENT;
    if (!CODEBUDDY_AGENTS.includes(next)) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'bad_agent_mode',
        message: 'unknown agent mode: ' + next, echo,
      });
      return;
    }
    this.agent_mode = next;
    this._saveSessMeta();
    await this._restart('agent:' + next);
    await this.sendWs({ post_type: 'agent_ack', session_id: this.id, agent: next, applied: true, echo });
  }

  async setChannel(channel, model = null, echo = null, clear = false) {
    if (channel === null && model === null && !clear) {
      await this.sendWs({
        post_type: 'model_ack', session_id: this.id,
        channel: (this.channel || {}).name, model: this.model_name, applied: false, echo,
      });
      return;
    }
    if (channel === null && model && !clear && this.channel !== null) channel = { ...this.channel };
    if (channel !== null && model) channel = { ...channel, model };
    this.channel = channel;
    this.model_name = channel === null ? (model || null) : (channel.model || null);
    this._saveSessMeta();
    await this._restart('channel:' + ((channel || {}).name || ''));
    await this.sendWs({
      post_type: 'model_ack', session_id: this.id,
      channel: (channel || {}).name, model: this.model_name, applied: true, echo,
    });
  }

  async _deferSwitchMode(mode) { this.launch_mode = mode; this.permission_mode = mode; this.pending_mode = mode; }
  async _deferSwitchAgent(mode) { this.agent_mode = mode; this.pending_agent = mode; }

  // ---------- 回收 ----------
  async _killProcess() {
    const term = this.pty;
    if (!term) return;
    try { term.kill(); } catch { /* ignore */ }
    this.pty = null;
    this.proc = null;
  }
}
