// cc-bridge (Node) — BaseSession: shared state for claude/codex backends.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  WORKSPACES, PERMISSION_MODE, DEFAULT_BACKEND, TURN_TIMEOUT, TOOL_IDLE_TIMEOUT, ASK_TIMEOUT, channelByName,
} from './config.js';
import { uuid5, UUID_NAMESPACE_URL, now, loadJsonFile, log } from './util.js';

/** Frames broadcast to every authenticated connection (QQ multi-client model). */
export const STREAM_POST_TYPES = new Set([
  'delta', 'thinking', 'tool_activity', 'final', 'cc_msg', 'user_msg',
  'turn_aborted', 'ask', 'ask_replied', 'session_closed', 'compact', 'compacting', 'sys',
  // TUI 终端后端：输出是原始字节流，多端镜像必须广播（term_reset/term_ready 同）
  'term_data', 'term_reset', 'term_ready', 'term_exit',
]);

/** 发图清洗：最多 3 张、media_type 白名单、纯 base64（容忍 data: 前缀）、
 *  单张编码串 ≤6MB。非法项静默丢弃，坏帧当没带图处理。 */
function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const im of images.slice(0, 3)) {
    if (!im || typeof im !== 'object') continue;
    const mt = String(im.media_type || '');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mt)) continue;
    const data = String(im.data || '').replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 16) continue;
    if (data.length > 6 * 1024 * 1024) continue;
    out.push({ media_type: mt, data });
  }
  return out;
}

export class BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    this.bridge = bridge;
    this.id = sid;
    // CLI requires a valid UUID for session ids; external id is free-form
    this.cli_uuid = uuid5(UUID_NAMESPACE_URL, 'cc-bridge:' + sid);
    this.ws = ws;
    this.pending_echo = null;
    // 会话数据目录（turnlog.jsonl / sess.json）始终按 sid 隔离——同一项目下
    // 多个会话共用 cwd 干活，但各自的流水互不污染。cwd 在下面 meta 读完后再定。
    this.data_dir = path.join(WORKSPACES, sid);
    this.cwd = this.data_dir;
    fs.mkdirSync(this.data_dir, { recursive: true });
    this.proc = null;
    this.turn_active = false;
    this.turn_echo = null;
    this.turn_timer = null;
    this.aborted_sent = false;
    this.started_once = false;
    this.resume_flag = !!opts.resume;
    this.ready_announced = false;
    this.text_buf = [];
    this.pending_asks = new Map(); // ask_id -> {request_id, tool_name, ask_frame, timer}
    this.created_at = now();
    const meta = this._loadSessMeta();
    // 项目（工作目录）：opts 优先 > sess.json 记录；cwd 指向项目目录，失败退回 data_dir
    this.project_id = opts.project || meta.project || '';
    const wantCwd = opts.cwd || meta.cwd || '';
    if (wantCwd && path.isAbsolute(wantCwd)) {
      try {
        fs.mkdirSync(wantCwd, { recursive: true });
        this.cwd = wantCwd;
      } catch { /* 目录建不出来：退回会话目录，别让整个会话起不来 */ }
    }
    // permission level: launch_mode = process start param; permission_mode = live value
    this.launch_mode = opts.permissionMode || meta.permission_mode || PERMISSION_MODE;
    this.permission_mode = this.launch_mode;
    // channel/model identity: None = inherit machine default
    let channel = opts.channel ?? null;
    if (!channel && meta.channel) {
      const ch = channelByName(meta.channel);
      if (ch) channel = ch;
    }
    this.channel = channel;
    this.model_name = opts.model || (channel && channel.model) || meta.model || null;
    // agent 模式（codebuddy --agent）：null = 未显式选择，由后端给默认值
    this.agent_mode = opts.agentMode || meta.agent_mode || null;
    this.backend = opts.backend || meta.backend || DEFAULT_BACKEND;
    this.thread_id = meta.thread_id || null; // codex exec resume id
    // 会话备注（客户端手填）：跨设备共享的落点在 sess.json，不进 turnlog
    this.remark = String(meta.remark || '').slice(0, 60);
    this.pending_mode = null; // deferred permission switch before next send
    this.last_activity = now();
    this.last_turn_at = null;
    this.closed = false;
    // offline accumulation: turn products land in turn_log, replayed on reconnect
    this.detached = false;
    this.turn_log = []; // [{id, ts, role: user|cc|tool|sys, text}]
    this.TURN_LOG_MAX = 200;
    this._msg_seq = 0;
    this._disk_log_count = 0;
    this._loadTurnDisk();
    this.thinking_chars = 0; // server-side dedup thinking count
    // 只在文件不存在时写（新会话身份落盘）：这里虚分派会跑到子类覆盖版，
    // 而派生字段（openclaw 的 gatewayName/remoteKey）还没初始化——无条件写
    // 会把盘上 meta 抹成半初始化状态（remote_key 清空事故）
    if (!fs.existsSync(this._sessMetaPath())) this._saveSessMeta();
  }

  // ---------- turn_log persistence ----------
  _turnlogPath() {
    return path.join(this.data_dir, 'turnlog.jsonl');
  }

  _sessMetaPath() {
    return path.join(this.data_dir, 'sess.json');
  }

  _logTurn(role, text, extra = null) {
    if (!['user', 'cc', 'tool', 'sys'].includes(role)) return null;
    this._msg_seq += 1;
    const entry = { id: `${this.id}-${this._msg_seq}`, ts: now(), role, text };
    // extra：附加字段（如工具卡的 detail/sub），随 entry 落盘与回放
    if (extra && typeof extra === 'object') Object.assign(entry, extra);
    this.turn_log.push(entry);
    if (this.turn_log.length > this.TURN_LOG_MAX) {
      this.turn_log = this.turn_log.slice(-this.TURN_LOG_MAX);
    }
    this._logTurnDisk(entry);
    return entry;
  }

  _logTurnDisk(entry) {
    try {
      fs.appendFileSync(this._turnlogPath(), JSON.stringify(entry) + '\n');
      this._disk_log_count += 1;
      if (this._disk_log_count > this.TURN_LOG_MAX * 2) this._compactTurnDisk();
    } catch { /* disk is best-effort */ }
  }

  _compactTurnDisk() {
    try {
      const lines = fs.readFileSync(this._turnlogPath(), 'utf8').split('\n').filter((l) => l.trim());
      const keep = lines.slice(-this.TURN_LOG_MAX);
      fs.writeFileSync(this._turnlogPath(), keep.map((l) => l + '\n').join(''));
      this._disk_log_count = keep.length;
    } catch { /* ignore */ }
  }

  _loadTurnDisk() {
    try {
      if (!fs.existsSync(this._turnlogPath())) return;
      const lines = fs.readFileSync(this._turnlogPath(), 'utf8').split('\n').filter((l) => l.trim());
      const out = [];
      let maxSeq = 0;
      let backfilled = 0;
      for (const line of lines.slice(-this.TURN_LOG_MAX)) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== 'object' || !['user', 'cc', 'tool', 'sys'].includes(obj.role)) continue;
        const ts = Number(obj.ts) || 0;
        const entry = { ts, role: obj.role, text: String(obj.text || '') };
        const mid = String(obj.id || '');
        if (mid.startsWith(this.id + '-')) {
          entry.id = mid;
          const n = Number(mid.split('-').pop());
          if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
        } else {
          backfilled += 1;
        }
        out.push(entry);
      }
      // backfill ids after maxSeq (never reuse existing numbers)
      let seq = maxSeq;
      for (const e of out) {
        if (!e.id) {
          seq += 1;
          e.id = `${this.id}-${seq}`;
        }
      }
      this._msg_seq = Math.max(this._msg_seq, maxSeq, seq);
      this.turn_log = out;
      this._disk_log_count = lines.length;
      if (backfilled) this._rewriteTurnDisk(out);
    } catch { /* ignore */ }
  }

  _rewriteTurnDisk(entries) {
    try {
      fs.writeFileSync(this._turnlogPath(), entries.map((e) => JSON.stringify(e) + '\n').join(''));
      this._disk_log_count = entries.length;
    } catch { /* ignore */ }
  }

  forgetTurnlog() {
    for (const p of [this._turnlogPath(), this._sessMetaPath()]) {
      try {
        fs.rmSync(p, { force: true });
      } catch { /* ignore */ }
    }
  }

  _loadSessMeta() {
    return loadJsonFile(this._sessMetaPath(), {});
  }

  _saveSessMeta() {
    try {
      fs.writeFileSync(
        this._sessMetaPath(),
        JSON.stringify({
          permission_mode: this.launch_mode,
          channel: (this.channel && this.channel.name) || '',
          model: this.model_name || '',
          agent_mode: this.agent_mode || '',
          backend: this.backend,
          thread_id: this.thread_id || '',
          remark: this.remark || '',
          project: this.project_id || '',
          cwd: this.cwd === this.data_dir ? '' : this.cwd,
        }),
      );
    } catch { /* ignore */ }
  }

  _replayMessages() {
    // dedupe adjacent identical cc entries (historic double-log of result text)
    const out = [];
    let prev = null;
    for (const e of this.turn_log) {
      if (e.role === 'cc' && prev === 'cc:' + e.text) continue;
      prev = e.role === 'cc' ? 'cc:' + e.text : null;
      out.push(e);
    }
    return out;
  }

  turnTitle() {
    for (let i = this.turn_log.length - 1; i >= 0; i--) {
      const e = this.turn_log[i];
      if (e && e.role === 'user') {
        const text = String(e.text || '').trim();
        if (text) return text.split('\n')[0].trim().slice(0, 24);
      }
    }
    return '';
  }

  _flushTextLog() {
    if (!this.text_buf.length) return null;
    const joined = this.text_buf.join('');
    this.text_buf = [];
    let entry = null;
    if (joined.trim()) entry = this._logTurn('cc', joined);
    return entry;
  }

  _replayAfter(mark) {
    let entries = this.turn_log;
    if (mark) {
      let hit = false;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].id === String(mark)) {
          entries = entries.slice(i + 1);
          hit = true;
          break;
        }
      }
      if (!hit) {
        const mts = Number(mark);
        if (mts > 0) entries = entries.filter((e) => (e.ts || 0) > mts + 1e-6);
      }
    }
    const out = [];
    let prev = null;
    for (const e of entries) {
      if (e.role === 'cc' && prev === 'cc:' + e.text) continue;
      prev = e.role === 'cc' ? 'cc:' + e.text : null;
      out.push(e);
    }
    return out;
  }

  // ---------- timers ----------
  // TURN_TIMEOUT 是「轮内空闲」预算，不是整轮墙钟：后端 stdout 每有输出就
  // _touchTurnTimer() 续期，连续 N 秒毫无动静才算卡死。原先只在 startTurn 上
  // 一次发条，长任务（构建/部署）干得正欢也会到点被 killpg 截断。
  // _idle_budget 当前生效的空闲预算：对话期 = TURN_TIMEOUT，工具执行期切换到
  // 更宽的 TOOL_IDLE_TIMEOUT（长工具静默数分钟是常态）。
  _idle_budget = TURN_TIMEOUT;

  _armTurnTimer(budget = this._idle_budget) {
    if (TURN_TIMEOUT <= 0) return; // <=0 = unlimited
    this._cancelTurnTimer();
    this._turn_touch_at = Date.now();
    this.turn_timer = setTimeout(() => {
      this._turnTimeout().catch(() => {});
    }, budget * 1000);
  }

  /** 活动续期：节流 1s，避免流式输出每行都重建定时器。 */
  _touchTurnTimer() {
    if (!this.turn_active || TURN_TIMEOUT <= 0) return;
    const t = Date.now();
    if (this._turn_touch_at && t - this._turn_touch_at < 1000) return;
    this._armTurnTimer();
  }

  /** 本轮见过实质输出（模型/工具/存活帧）。握手噪声（init、control_response）
   *  不算——它们可能在上游挂死时照样到达。各后端在 _dispatch 里按帧类型调用。 */
  _markTurnSeen() {
    this._turn_seen = true;
  }

  /** 工具执行开始：切到工具空闲预算（tool_use 后直到模型再说话）。
   *  docker/npm/curl 等长工具执行期间 CLI 不产任何 stdout 事件，
   *  对话预算会误杀；<=0 时跟随 TURN_TIMEOUT。 */
  _toolPhaseStart() {
    this._idle_budget = TOOL_IDLE_TIMEOUT > 0 ? TOOL_IDLE_TIMEOUT : TURN_TIMEOUT;
    if (this.turn_active) this._armTurnTimer();
  }

  /** 模型恢复输出（正文块 / delta）：回到对话空闲预算。 */
  _toolPhaseEnd() {
    if (this._idle_budget === TURN_TIMEOUT) return;
    this._idle_budget = TURN_TIMEOUT;
    if (this.turn_active) this._armTurnTimer();
  }

  _cancelTurnTimer() {
    if (this.turn_timer) {
      clearTimeout(this.turn_timer);
      this.turn_timer = null;
    }
  }

  async _turnTimeout() {
    if (!this.turn_active) return;
    // 整轮零输出 = 上游请求挂死（实测：CLI transcript 里连记录都不落，同消息
    // 重发立刻成功）。abort 掉原样重发一次；有输出的卡死照旧只 abort。
    if (!this._turn_seen && this._last_turn && (this._turn_retries || 0) < 1) {
      this._turn_retries = (this._turn_retries || 0) + 1;
      log('turn_timeout_retry', { session_id: this.id, attempt: this._turn_retries, idle_s: this._idle_budget });
      const lt = this._last_turn;
      await this.abort('timeout');
      const entry = this._logTurn('sys', `本轮 ${this._idle_budget}s 无任何响应（疑似上游挂起），已自动重发`);
      if (entry) {
        await this.sendWs({ post_type: 'sys', session_id: this.id, mid: entry.id, text: entry.text });
      }
      await this.startTurn(lt.text, lt.echo, lt.images, { isRetry: true });
      return;
    }
    log('turn_timeout', { session_id: this.id, idle_s: this._idle_budget });
    await this.abort('timeout');
  }

  // ---------- ws send (broadcast vs reply semantics) ----------
  async sendWs(obj) {
    const t = obj.post_type;
    const broadcast = STREAM_POST_TYPES.has(t) || (t === 'error' && !obj.echo);
    const data = JSON.stringify(obj);
    if (broadcast) {
      for (const c of this.bridge.conns) {
        if (c.readyState === c.OPEN) {
          try {
            c.send(data);
          } catch { /* ignore */ }
        }
      }
    } else if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(data);
      } catch { /* ignore */ }
    }
  }

  // ---------- teardown (backend-specific bits below) ----------
  async close(reason = 'dropped', notify = true, echo = null) {
    if (this.closed) return;
    this.closed = true;
    this._cancelTurnTimer();
    await this._killProcess();
    await this._expireAllAsks();
    if (notify) {
      await this.sendWs({ post_type: 'session_closed', session_id: this.id, reason, echo });
    }
    log('session_closed', { session_id: this.id, reason });
  }

  async _killProcess() { /* overridden */ }
  async _expireAllAsks() {
    for (const askId of [...this.pending_asks.keys()]) {
      await this._askTimeout(askId);
    }
  }
  async _askTimeout() { /* overridden by claude */ }

  // ---------- MCP 问卡（ptc/minimal 用 mcp.cwsask.ask_user 调用） ----------
  // 走标准 ask 帧（笔/WebUI 还是同一张卡），但答复不回落给 CLI，而是 resolve 给
  // MCP 子进程——工具返回值由 CLI 自己拼，模型看到的是正经 tool_result。
  // 为什么不用「改写 REPL 代码塞答案」：CLI 会把 updatedInput 当成模型自己写的
  // 入参存进 transcript，模型回头看见答案字面量会认定是自己伪造的，直接翻车。
  askViaMcp(question, options, multiSelect = false) {
    return new Promise((resolve) => {
      const askId = crypto.randomBytes(16).toString('hex');
      const labels = (Array.isArray(options) ? options : [])
        .map((o) => (typeof o === 'string'
          ? { label: String(o) }
          : { label: String((o && o.label) || ''), description: o && o.description ? String(o.description) : '' }))
        .filter((o) => o.label);
      const questions = [{ question: String(question || ''), header: '', options: labels, multiSelect: !!multiSelect }];
      const askFrame = {
        post_type: 'ask', session_id: this.id, ask_id: askId, kind: 'question',
        tool_name: 'AskUserQuestion', input: { questions },
      };
      const entry = {
        request_id: null, tool_name: 'AskUserQuestion', input: askFrame.input,
        ask_frame: askFrame, mcp: { resolve, question: questions[0].question },
      };
      entry.timer = setTimeout(() => {
        if (this.pending_asks.get(askId) !== entry) return;
        this.pending_asks.delete(askId);
        resolve({ behavior: 'timeout' });
      }, ASK_TIMEOUT * 1000);
      this.pending_asks.set(askId, entry);
      this.last_activity = Date.now() / 1000;
      this.sendWs(askFrame).catch(() => {});
      log('mcp_ask', { session_id: this.id, options: labels.length });
    });
  }

  // ---------- turn entry (backend-specific: startTurn/abort) ----------
  async startTurn(text, echo, images, opts = {}) {
    if (this.turn_active) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'busy', message: 'turn in progress', echo });
      return;
    }
    const imgs = sanitizeImages(images);
    if (imgs.length && !['claude', 'codebuddy'].includes(this.backend)) {
      // codex 走 argv、openclaw chat.send 只收文本——都没有图片通道，明确拒绝；
      // claude/codebuddy 的 stream-json user 消息原生支持 image content 块
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'no_image_support',
        message: '该后端暂不支持发图（仅 Claude / CodeBuddy 支持）', echo });
      return;
    }
    await this._ensureProcess();
    this.text_buf = [];
    this.thinking_chars = 0;
    this.turn_active = true;
    this.aborted_sent = false;
    this.turn_echo = echo;
    // 静默超时自动重发的状态：本轮已见到的输出行数 / 已重发次数
    this._last_turn = { text, images: imgs, echo };
    if (!opts.isRetry) this._turn_retries = 0;
    this.last_activity = now();
    this.last_turn_at = this.last_activity;
    // base64 不进 turnlog（爆盘 + 回放拉历史会淹 WS）：落盘/回显用占位文本，
    // 真图片数据只随本轮 user_msg 帧推给在线客户端
    const shown = imgs.length
      ? (text ? text + '\n[图片 ×' + imgs.length + ']' : '[图片 ×' + imgs.length + ']')
      : text;
    const uEntry = this._logTurn('user', shown);
    if (uEntry) {
      const uFrame = { post_type: 'user_msg', session_id: this.id, mid: uEntry.id, text: shown };
      if (imgs.length) uFrame.images = imgs;
      await this.sendWs(uFrame);
    }
    this._idle_budget = TURN_TIMEOUT; // 上一轮可能死于工具期，预算先归位
    this._armTurnTimer();
    await this.bridge.turnGate();
    // 输出水位清零点：_ensureProcess 期间的 init/握手指令不算本轮输出，
    // 此后到 _writeTurn 前到达的任何 stdout 行才证明「上游活了」
    this._turn_seen = false;
    try {
      await this._writeTurn(text, echo, imgs);
    } catch (e) {
      // 写轮失败（openclaw chat.send 被拒/superseded 等）：不留僵尸 turn_active
      this.turn_active = false;
      this._cancelTurnTimer();
      log('turn_send_err', { session_id: this.id, err: String(e) });
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'send_failed', message: String(e), echo });
    }
  }

  async _ensureProcess() { /* overridden */ }
  async _writeTurn(text, echo) { /* overridden */ }
  async abort(reason = 'user') { /* overridden */ }
}
