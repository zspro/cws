// PollConn — HTTP 长轮询虚拟连接（笔端传输层弃用 WS 后的替代形态）。
// 对桥内所有代码（_wsSend / route / onWsClosed / conns 广播）伪装成 ws：
//   readyState/OPEN 常量、send(str)、_authed、_client；下行帧进内存队列，
// 由笔端 GET /p/poll 拉走（有帧立即返回，无帧挂起等 wait 秒）。
// 生命周期：/p/open 建 → poll/up 使用 → close（笔端显式、auth 拒绝、空闲
// 超时回收）→ onWsClosed 走会话 detach，与 WS 断开同一套语义。
import crypto from 'node:crypto';

const QUEUE_MAX_FRAMES = 500;      // 单连接下行积压上限（超出断开让笔端重连对账）
// 挂起中被新帧唤醒后再攒这么久才回包：流式 delta 每条一帧，不攒的话一条一个
// HTTP 往返（实测流式期间 poll 从每分钟个位数涨到近 800 次）
const COALESCE_MS = 40;
const WAIT_MAX_S = 55;             // 单次 poll 最长挂起秒数
const IDLE_CLOSE_MS = 90_000;      // 连续 90s 没有 poll 视为笔端消失

export class PollConn {
  constructor(info = {}) {
    this.id = crypto.randomBytes(16).toString('hex');
    this.isPoll = true;
    this.OPEN = 1;
    this.readyState = 1; // 恒 OPEN：_wsSend 与 _promoteQueue 都按此判断
    this._authed = true; // /p/open 已验 token，route 的首帧鉴权门直接放行
    this._client = {
      client: info.client || 'pen-poll',
      transport: 'poll',
      version: info.version || '',
    };
    this._q = [];            // 待取下行帧（JSON 字符串）
    this._seq = 0;           // 已入队帧的最大序号（_q 尾）
    this._sent = [];         // 已下发未确认的帧 {seq, s}：客户端带 ack 时才保留
    this._waiter = null;     // { resolve, timer }
    this._reading = false;   // 防两个 poll 并发挂号
    this._closed = false;
    this._lastPoll = Date.now();
    this.createdAt = Date.now();
  }

  /** 桥内统一出口：_wsSend 只认 readyState===OPEN + send(str)。 */
  send(str) {
    if (this._closed) return;
    if (this._q.length + this._sent.length >= QUEUE_MAX_FRAMES) {
      // 积压爆仓：清空并断开，笔端重连后 sessions.sync 增量对账（与 WS 断线同路）
      this._q.length = 0;
      this._sent.length = 0;
      this.close();
      return;
    }
    this._seq += 1;
    this._q.push({ seq: this._seq, s: String(str) });
    this._wake('frame');
  }

  _wake(reason) {
    const w = this._waiter;
    if (!w) return;
    this._waiter = null;
    if (w.timer) clearTimeout(w.timer);
    w.resolve(reason);
  }

  /** server.js /p/poll 入口：取走全部待发帧；无帧挂起 waitS 秒。
   *  返回帧数组；连接已关闭返回 null（笔端收到 410 → 重连）。
   *  新 poll 到来时唤醒旧 waiter 让位接管投递——客户端重试产生的僵尸
   *  请求不得吞走帧（帧给到最新在飞的那个 poll）。 */
  //  ack（可选，新客户端带）：客户端已处理的最大序号。带 ack 时帧下发后先留在
  //  _sent，直到后续 poll 的 ack 覆盖才删——上一个响应在路上丢了，下一次 poll
  //  会重发；客户端按序号去重。不带 ack 的老客户端维持取走即删。
  async readFrames(waitS, ack) {
    if (this._closed) return null;
    this._lastPoll = Date.now();
    const ackMode = ack !== undefined && ack !== null && ack !== '';
    if (ackMode) this._ack(ack);
    const wait = Math.max(0, Math.min(WAIT_MAX_S, Number(waitS) || 0));
    // 有未确认的帧（上次响应丢失）立即重发，不挂起
    if (!this._q.length && !(ackMode && this._sent.length) && wait > 0) {
      if (this._waiter) {
        const old = this._waiter;
        this._waiter = null;
        if (old.timer) clearTimeout(old.timer);
        old.resolve('takeover');
      }
      this._reading = true;
      let woke = '';
      try {
        woke = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this._waiter && this._waiter.resolve === resolve) this._waiter = null;
            resolve('timeout');
          }, wait * 1000);
          this._waiter = { resolve, timer };
        });
      } finally {
        this._reading = false;
      }
      // 被新帧唤醒：短暂再攒一批。被新 poll 接管（takeover）或连接关闭则立即返回
      if (woke === 'frame' && !this._closed) {
        await new Promise((r) => setTimeout(r, COALESCE_MS));
      }
    }
    if (!this._q.length && this._closed) return null;
    const out = this._q.splice(0, this._q.length);
    // first = frames[0] 的序号（序号连续），客户端据此按序号去重
    if (ackMode) {
      this._sent.push(...out);
      return { frames: this._sent.map((f) => f.s), first: this._sent.length ? this._sent[0].seq : this._seq + 1 };
    }
    return { frames: out.map((f) => f.s), first: out.length ? out[0].seq : this._seq + 1 };
  }

  /** 客户端确认已处理到 ack 号：之前的帧不再重发。 */
  _ack(ack) {
    const n = Number(ack);
    if (!Number.isFinite(n)) return;
    let i = 0;
    while (i < this._sent.length && this._sent[i].seq <= n) i++;
    if (i) this._sent.splice(0, i);
  }

  /** 关闭：兼容 ws.close(code, reason) 签名。close 后 readFrames 把余帧
   *  交付完再回 null，笔端处理完最后一批（如 auth_rejected）再重连。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    this._wake('close');
    // 任何关闭路径（含积压爆仓）都通知桥做 detach，相当于 WS 的 close 事件
    if (this.onClose) queueMicrotask(() => this.onClose(this));
  }

  get closed() { return this._closed; }

  /** 空闲回收判据：上次 poll 距今超过阈值。 */
  idleFor(ms) { return (Date.now() - this._lastPoll) > ms; }
}

export { IDLE_CLOSE_MS, WAIT_MAX_S };
