// cc-bridge (Node) — CodebuddySession: resident `codebuddy -p` stream-json adapter.
// Verified against @tencent-ai/codebuddy-code 2.170.0 (see ACCEPTANCE.md).
// 与 ClaudeSession 同构（常驻 stream-json 进程、事件同 schema），差异：
//   1. 无 --permission-prompt-tool stdio：headless 不产 can_use_tool，无 ask 卡片；
//      default 模式下非 allowlist 工具由 CLI 直接拒绝，全放行用 bypassPermissions。
//   2. 频道经环境变量下发（CODEBUDDY_BASE_URL/CODEBUDDY_API_KEY，OpenAI 兼容协议，
//      SDK 在 base_url 后拼 /chat/completions），改频道需重启进程。
//   3. 权限切换走重启（不复用 set_permission_mode 控制请求）：bypassPermissions
//      追加 -y 使 CODEBUDDY_IS_SANDBOX=1 的沙箱全放行生效。
//   4. 复活用 --resume <sid> --resume-create-missing（历史被清时同 id 重开，不失败）；
//      首启用 --session-id 固定会话 ID，init 事件回读落盘兜底。
import process from 'node:process';
import readline from 'node:readline';
import { BaseSession } from './base-session.js';
import { CODEBUDDY_BIN, ALLOWED_TOOLS, PERMISSION_MODE, REAP_ON_DETACH } from './config.js';
import {
  log, briefOf, spawnDetached, killProcGroup, killProcGroupForce, waitProc, procAlive,
} from './util.js';

function _procEnv(channel, cliUuid) {
  const env = { ...process.env, IS_SANDBOX: '1', CODEBUDDY_IS_SANDBOX: '1' };
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

export class CodebuddySession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    // codebuddy 权限档与 claude 同名同义（default/acceptEdits/plan/bypassPermissions
    // 均为 CLI 合法值），无需翻译；只挡掉未知值
    if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(this.launch_mode)) {
      this.launch_mode = 'default';
      this.permission_mode = 'default';
    }
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

  _buildArgs() {
    const useResume = this.resume_flag || this.started_once;
    const args = [
      CODEBUDDY_BIN, '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', this.launch_mode,
      // 单个逗号串，避免 commander 变长参数吞掉后续选项
      '--allowedTools', ALLOWED_TOOLS,
    ];
    if (this.launch_mode === 'bypassPermissions') {
      // -y = bypassPermissions；CODEBUDDY_IS_SANDBOX=1 全放行依赖 -y 存在
      args.push('-y');
    }
    if (this.model_name) args.push('--model', this.model_name);
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
    // 上一轮运行中切换的权限（pending_mode）：本轮边界重启进程换参生效
    if (this.pending_mode && procAlive(this.proc)) {
      this._killpg();
      await waitProc(this.proc, 5000);
      killProcGroupForce(this.proc);
      this.ready_announced = false;
      await this.start();
      await Promise.race([this.ready.promise, new Promise((res) => setTimeout(res, 10000))]);
      this.permission_mode = this.launch_mode;
      this.pending_mode = null;
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
      this.bridge.notifyCapacityChange();
    });
    this.readerTask = rl;
  }

  async _dispatch(obj) {
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
      }
    } else if (t === 'stream_event') {
      const ev = obj.event || {};
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) {
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
          this.text_buf.push(b.text);
        } else if (b.type === 'tool_use') {
          this.last_activity = Date.now() / 1000;
          const sealed = this._flushTextLog();
          if (sealed) {
            await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
          }
          const brief = briefOf(b.input || {});
          const tEntry = this._logTurn('tool', `${b.name}：${brief}`);
          await this.sendWs({
            post_type: 'tool_activity', session_id: this.id,
            tool: b.name, brief, mid: (tEntry || {}).id,
          });
        }
      }
    } else if (t === 'control_request') {
      // headless 无权限通道：rewind 等控制请求一律拒绝，保持协议应答闭环
      try {
        await this._writeLine({
          type: 'control_response',
          response: {
            subtype: 'success', request_id: obj.request_id,
            response: { behavior: 'deny', message: 'unsupported control request' },
          },
        });
      } catch { /* process gone */ }
    } else if (t === 'result') {
      await this._handleResult(obj);
    }
    // 'user' 帧（tool_result 回传）忽略
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
      backend: this.backend,
      echo: this.pending_echo,
    });
    this.pending_echo = null;
    log('session_ready', { session_id: this.id, backend: 'codebuddy' });
  }

  async _handleResult(obj) {
    this.turn_active = false;
    this._cancelTurnTimer();
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
