#!/usr/bin/env node
// v0.3 协议验收：首帧鉴权 + hello + v0.2 兼容（token 出 URL）。
// 用法: node scripts/test-v03-auth.mjs [--url ws://127.0.0.1:18642/ws]
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = arg('url', 'ws://127.0.0.1:18642/ws');
const TOKEN = 'testtok_v03_123';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  | ' + detail : ''));
  cond ? pass++ : fail++;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 收帧直到满足谓词或超时
function collector(ws) {
  const frames = [];
  let closed = null; // {code, reason}
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
  return {
    frames,
    // closed 是闭包变量：对象属性固化 null 会让 waitClose 永远等不到，必须走 getter
    get closed() { return closed; },
    async until(pred, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const f = frames.find(pred);
        if (f) return f;
        if (this.closed) return null;
        if (Date.now() - t0 > ms) return null;
        await wait(50);
      }
    },
    // 轮询等连接关闭（frames 可能一直为空，find 不会调用谓词，必须独立等待）
    async waitClose(ms = 4000) {
      const t0 = Date.now();
      while (!this.closed && Date.now() - t0 < ms) await wait(50);
      return this.closed;
    },
  };
}

function open(url = URL_) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [], { handshakeTimeout: 4000 });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// ---- A. v0.3 主路径：无 token 连接 → 未鉴权门禁 → auth 成功 → hello ----
{
  const ws = await open();
  const c = collector(ws);
  ws.send(JSON.stringify({ action: 'hello', params: {}, echo: 'h0' }));
  const notAuthed = await c.until((f) => f.echo === 'h0');
  ok('A1 未鉴权 hello 被拒（not_authed）', notAuthed && notAuthed.post_type === 'error' && notAuthed.code === 'not_authed',
     notAuthed && JSON.stringify(notAuthed).slice(0, 80));

  ws.send(JSON.stringify({ action: 'auth', params: { token: 'WRONG' }, echo: 'a1' }));
  const rej = await c.until((f) => f.echo === 'a1');
  ok('A2 错 token → auth_rejected', rej && rej.code === 'auth_rejected', rej && JSON.stringify(rej).slice(0, 80));
  const closedA = await c.waitClose(3000);
  ok('A3 错 token 后连接被断（4001）', closedA && closedA.code === 4001, JSON.stringify(closedA));
  ws.terminate ? ws.terminate() : null;
}

{
  const ws = await open();
  const c = collector(ws);
  ws.send(JSON.stringify({ action: 'ping', params: {}, echo: 'p0' }));
  const pong0 = await c.until((f) => f.echo === 'p0');
  ok('A4 未鉴权 ping 仍回 pong（保心跳）', pong0 && pong0.post_type === 'pong', pong0 && JSON.stringify(pong0).slice(0, 60));

  ws.send(JSON.stringify({ action: 'auth', params: { token: TOKEN }, echo: 'a2' }));
  const authOk = await c.until((f) => f.echo === 'a2');
  ok('A5 对 token → auth_ok', authOk && authOk.post_type === 'auth_ok', authOk && JSON.stringify(authOk).slice(0, 60));

  ws.send(JSON.stringify({ action: 'hello', params: { client: 'cc-remote', version: '1.2.0', caps: ['frame_auth'] }, echo: 'h1' }));
  const hello = await c.until((f) => f.echo === 'h1');
  ok('A6 hello 回版本与能力', hello && hello.post_type === 'hello' && hello.server === 'cws'
     && typeof hello.version === 'string' && hello.version !== '' && Array.isArray(hello.caps) && hello.caps.includes('frame_auth'),
     hello && (hello.server + ' ' + hello.version + ' caps=' + JSON.stringify(hello.caps)));

  ws.send(JSON.stringify({ action: 'ping', params: {}, echo: 'p1' }));
  const pong1 = await c.until((f) => f.echo === 'p1');
  ok('A7 鉴权后 ping 正常', pong1 && pong1.post_type === 'pong');
  ws.close();
}

// ---- B. v0.2 兼容：URL ?token= 直连（WebUI/QQ/旧笔端路径不受影响） ----
{
  const ws = await open(URL_ + '?token=' + encodeURIComponent(TOKEN));
  const c = collector(ws);
  ws.send(JSON.stringify({ action: 'ping', params: {}, echo: 'lp1' }));
  const pong = await c.until((f) => f.echo === 'lp1');
  ok('B1 URL token 直连即用（无需 auth 帧）', pong && pong.post_type === 'pong');
  ws.close();
}
{
  const ws = await open(URL_ + '?token=WRONG').catch((e) => { throw e; }).catch(() => null);
  ok('B2 错 URL token 升级期 401（连不上）', ws === null);
}

// ---- C. 一次性 token 走首帧也能消费 ----
{
  const ws = await open();
  const c = collector(ws);
  ws.send(JSON.stringify({ action: 'auth', params: { token: 'otp_once_abc' }, echo: 'a3' }));
  const authOk = await c.until((f) => f.echo === 'a3');
  ok('C1 一次性 token 首帧鉴权成功', authOk && authOk.post_type === 'auth_ok');
  ws.close();
  const ws2 = await open();
  const c2 = collector(ws2);
  ws2.send(JSON.stringify({ action: 'auth', params: { token: 'otp_once_abc' }, echo: 'a4' }));
  const rej2 = await c2.until((f) => f.echo === 'a4');
  ok('C2 同一一次性 token 二次被拒（已消费）', rej2 && rej2.code === 'auth_rejected');
  ws2.close();
}

// ---- D. 静默连接超时断开（frame_auth_timeout_s=3）----
{
  const ws = await open();
  const c = collector(ws);
  const closedD = await c.waitClose(6000);
  ok('D1 无任何帧的连接在窗口后被断（4001 auth timeout）',
     !!closedD && closedD.code === 4001, closedD ? JSON.stringify(closedD) : 'not closed');
}

console.log(`\nSUMMARY: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
