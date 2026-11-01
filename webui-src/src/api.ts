// api.ts —— 桥传输层：HTTP 长轮询（/p/open、/p/poll、/p/up），与笔端同一套通道。
// 帧内容解析与状态机在 store.ts；接口（connect/send/ready/destroy/everConnected）
// 与旧 WebSocket 版完全同形，store.ts 零改动。
//
// 时序：服务端单次挂起 wait=25s（上限 55），浏览器 fetch 超时 35s 必须大于它；
// up 串行 Promise 链保帧序；pid 失效（服务重启/空闲回收）→ 整会话重开。

export type Frame = Record<string, any>;

const POLL_WAIT_S = 25;
const POLL_TIMEOUT_MS = 35_000;
const OPEN_TIMEOUT_MS = 10_000;
const UP_TIMEOUT_MS = 15_000;
const RETRY_MS = 5_000;

export class Api {
  private pid: string | null = null; // /p/open 换的会话凭据（x-cws-poll 头携带）
  private echo = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort: AbortController | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private token = "";
  /** 首次 open 成功前失败（多为 token 错）时保持 false，供登录页提示 */
  everConnected = false;
  stopped = false;

  constructor(
    private onFrame: (f: Frame) => void,
    private onStatus: (connected: boolean, everConnected: boolean) => void,
  ) {}

  private async fetchJson(path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json: any }> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(path, { ...init, signal: ac.signal });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  connect(token: string) {
    this.token = token;
    this.stopped = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.teardown();
    void this.open();
  }

  /** 拆旧会话：中止在飞 poll + 尽力通知服务端（失败无妨，90s 空闲回收兜底） */
  private teardown() {
    const oldPid = this.pid;
    this.pid = null;
    if (this.pollAbort) {
      try { this.pollAbort.abort(); } catch { /* ignore */ }
      this.pollAbort = null;
    }
    if (oldPid) {
      try {
        fetch("/p/close", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cws-poll": oldPid },
          body: "{}",
          keepalive: true,
        }).catch(() => { /* ignore */ });
      } catch { /* ignore */ }
    }
  }

  private async open() {
    if (this.stopped) return;
    try {
      const r = await this.fetchJson("/p/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.token, client: "webui" }),
      }, OPEN_TIMEOUT_MS);
      if (this.stopped) return;
      if (r.status === 200 && r.json && typeof r.json.pid === "string") {
        this.pid = r.json.pid;
        this.everConnected = true;
        this.onStatus(true, true);
        void this.pollLoop();
        return;
      }
      // 401 = token 错，与旧 WS 401 同语义：断开 + 定时重试
    } catch { /* 网络错/超时 */ }
    this.onStatus(false, this.everConnected);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, RETRY_MS);
  }

  private async pollLoop() {
    for (;;) {
      if (this.stopped || !this.pid) return;
      const pid = this.pid;
      const ac = new AbortController();
      this.pollAbort = ac;
      let r: { status: number; json: any };
      try {
        r = await this.fetchJson("/p/poll?wait=" + POLL_WAIT_S, {
          headers: { "x-cws-poll": pid },
        }, POLL_TIMEOUT_MS);
      } catch {
        this.pollAbort = null;
        if (this.stopped || this.pid !== pid) return; // 主动拆线的中止不算断连
        this.onStatus(false, this.everConnected);
        this.pid = null;
        this.scheduleReconnect();
        return;
      }
      this.pollAbort = null;
      if (this.stopped || !this.pid) return;
      if (r.status === 200 && r.json && Array.isArray(r.json.frames)) {
        for (const raw of r.json.frames) {
          let frame: Frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          this.onFrame(frame);
        }
        continue;
      }
      // 410 = pid 过期（服务重启/回收）；其余非 200 同理：整会话重开
      this.onStatus(false, this.everConnected);
      this.pid = null;
      this.scheduleReconnect();
      return;
    }
  }

  get ready() {
    return this.pid !== null;
  }

  /** 发送 action；返回 echo 标签（连接未就绪时返回 null） */
  send(action: string, params: Frame = {}): string | null {
    if (!this.pid) return null;
    this.echo += 1;
    const echo = "e" + this.echo;
    const body = JSON.stringify({ action, params, echo });
    const pid = this.pid;
    this.sendChain = this.sendChain.then(async () => {
      if (this.stopped || this.pid !== pid) return;
      try {
        const r = await this.fetchJson("/p/up", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cws-poll": pid },
          body,
        }, UP_TIMEOUT_MS);
        if (this.stopped || this.pid !== pid) return;
        if (r.status !== 200) throw new Error("up " + r.status);
      } catch {
        if (this.stopped || this.pid !== pid) return;
        this.onStatus(false, this.everConnected);
        this.pid = null;
        this.scheduleReconnect();
      }
    });
    return echo;
  }

  /** 造一个 new: 前缀的 echo（创建会话后自动打开的约定，bridge 会原样回传） */
  newEcho(): string {
    this.echo += 1;
    return "new:" + this.echo;
  }

  /** 普通 echo（kx.chat 等一问一答动作的应答关联） */
  rawEcho(): string {
    this.echo += 1;
    return "q" + this.echo;
  }

  destroy() {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.teardown();
  }
}
