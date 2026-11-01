// PollConn — HTTP 长轮询虚拟连接（笔端传输层弃用 WS 后的替代形态）。
// 对桥内所有代码（_wsSend / route / onWsClosed / conns 广播）伪装成 ws：
//   readyState/OPEN 常量、send(str)、_authed、_client；下行帧进内存队列，
// 由笔端 GET /p/poll 拉走（有帧立即返回，无帧挂起等 wait 秒）。
// 生命周期：/p/open 建 → poll/up 使用 → close（笔端显式、auth 拒绝、空闲
// 超时回收）→ onWsClosed 走会话 detach，与 WS 断开同一套语义。
import crypto from 'node:crypto';

const QUEUE_MAX_FRAMES = 500;      // 单连接下行积压上限（超出断开让笔端重连对账）
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
    this._waiter = null;     // { resolve, timer }
    this._reading = false;   // 防两个 poll 并发挂号
    this._closed = false;
    this._lastPoll = Date.now();
    this.createdAt = Date.now();
  }

  /** 桥内统一出口：_wsSend 只认 readyState===OPEN + send(str)。 */
  send(str) {
    if (this._closed) return;
    if (this._q.length >= QUEUE_MAX_FRAMES) {
      // 积压爆仓：清空并断开，笔端重连后 sessions.sync 增量对账（与 WS 断线同路）
      this._q.length = 0;
      this.close();
      return;
    }
    this._q.push(String(str));
    this._wake();
  }

  _wake() {
    const w = this._waiter;
    if (!w) return;
    this._waiter = null;
    if (w.timer) clearTimeout(w.timer);
    w.resolve();
  }

  /** server.js /p/poll 入口：取走全部待发帧；无帧挂起 waitS 秒。
   *  返回帧数组；连接已关闭返回 null（笔端收到 410 → 重连）。
   *  新 poll 到来时唤醒旧 waiter 让位接管投递——客户端重试产生的僵尸
   *  请求不得吞走帧（帧给到最新在飞的那个 poll）。 */
  async readFrames(waitS) {
    if (this._closed) return null;
    this._lastPoll = Date.now();
    const wait = Math.max(0, Math.min(WAIT_MAX_S, Number(waitS) || 0));
    if (!this._q.length && wait > 0) {
      if (this._waiter) {
        const old = this._waiter;
        this._waiter = null;
        if (old.timer) clearTimeout(old.timer);
        old.resolve();
      }
      this._reading = true;
      try {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this._waiter && this._waiter.resolve === resolve) this._waiter = null;
            resolve();
          }, wait * 1000);
          this._waiter = { resolve, timer };
        });
      } finally {
        this._reading = false;
      }
    }
    if (!this._q.length && this._closed) return null;
    const out = this._q.splice(0, this._q.length);
    return out;
  }

  /** 关闭：兼容 ws.close(code, reason) 签名。close 后 readFrames 把余帧
   *  交付完再回 null，笔端处理完最后一批（如 auth_rejected）再重连。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    this._wake();
  }

  get closed() { return this._closed; }

  /** 空闲回收判据：上次 poll 距今超过阈值。 */
  idleFor(ms) { return (Date.now() - this._lastPoll) > ms; }
}

export { IDLE_CLOSE_MS, WAIT_MAX_S };
