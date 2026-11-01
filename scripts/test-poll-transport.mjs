#!/usr/bin/env node
// HTTP 长轮询传输层验收（/p/open /p/poll /p/up /p/close）。
// 用法: node scripts/test-poll-transport.mjs [--url http://127.0.0.1:18721]
// 依赖隔离服 + mock-openclaw-gateway（backend=openclaw 免 CLI spawn，Windows 友好）。
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:18721');
const TOKEN = 'polltest_tok';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  | ' + detail : ''));
  cond ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { body, headers, timeoutMs = 35000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(t); }
}

/** 长轮询客户端：单在飞 poll，收帧按谓词匹配；stop 等在飞收口防偷帧 */
function pollClient(pid) {
  const frames = [];
  let stopped = false;
  let done = () => {};
  const loop = async () => {
    while (!stopped) {
      const r = await http('GET', '/p/poll?wait=2', { headers: { 'x-cws-poll': pid } });
      if (r.status !== 200) { frames.push({ __gone: r.status }); break; }
      for (const f of (r.json && r.json.frames) || []) {
        try { frames.push(JSON.parse(f)); } catch { frames.push({ __raw: f }); }
      }
    }
    done();
  };
  loop();
  return {
    frames,
    async stop() { stopped = true; await new Promise((r) => { done = r; setTimeout(r, 4000); }); },
    async until(pred, ms = 8000) {
      const t0 = Date.now();
      for (;;) {
        const f = frames.find(pred);
        if (f) return f;
        if (Date.now() - t0 > ms) return null;
        await wait(40);
      }
    },
  };
}
/** 排空服务端积压帧（wait=0 反复取到空） */
async function drain(pid) {
  for (let i = 0; i < 20; i++) {
    const r = await http('GET', '/p/poll?wait=0', { headers: { 'x-cws-poll': pid } });
    if (r.status !== 200 || !((r.json || {}).frames || []).length) return;
  }
}
const up = (pid, frame) => http('POST', '/p/up', { headers: { 'x-cws-poll': pid }, body: frame });

// ---- P1/P2/P3 开连接与凭据 ----
{
  const bad = await http('POST', '/p/open', { body: { token: 'WRONG' } });
  ok('P1 错 token /p/open 401', bad.status === 401, 'status=' + bad.status);

  const good = await http('POST', '/p/open', { body: { token: TOKEN, client: 'cc-remote', version: '1.6.1' } });
  ok('P2 对 token 换 pid（32hex）', good.status === 200 && /^[0-9a-f]{32}$/.test((good.json || {}).pid || ''),
     JSON.stringify(good.json));
  const pid = good.json.pid;

  const gone = await http('GET', '/p/poll?wait=0', { headers: { 'x-cws-poll': 'deadbeef'.repeat(4) } });
  ok('P3 坏 pid poll 410', gone.status === 410, 'status=' + gone.status);

  // ---- P4~P6 鉴权/ hello/ping 走 poll ----
  const c = pollClient(pid);
  await up(pid, { action: 'auth', params: { token: TOKEN }, echo: 'a1' });
  const authOk = await c.until((f) => f.echo === 'a1');
  ok('P4 auth 帧走 poll 回 auth_ok', authOk && authOk.post_type === 'auth_ok', authOk && JSON.stringify(authOk).slice(0, 60));

  await up(pid, { action: 'hello', params: { client: 'cc-remote', version: '1.6.1', caps: ['frame_auth'] }, echo: 'h1' });
  const hello = await c.until((f) => f.echo === 'h1');
  ok('P5 hello 走 poll 回版本能力', hello && hello.post_type === 'hello' && hello.server === 'cws' && Array.isArray(hello.caps),
     hello && (hello.server + ' ' + hello.version));

  await up(pid, { action: 'ping', params: {}, echo: 'p1' });
  const pong = await c.until((f) => f.echo === 'p1');
  ok('P6 ping/pong 走 poll', pong && pong.post_type === 'pong');

  // ---- P7/P8 openclaw 会话全链路（PollConn 接管 + 帧双向）----
  const ns = await up(pid, { action: 'new_session', params: { backend: 'openclaw' }, echo: 'ns1' });
  const nsReply = await c.until((f) => f.echo === 'ns1');
  const sid = nsReply && nsReply.session_id;
  ok('P7 new_session 回 session_id', !!sid, nsReply && JSON.stringify(nsReply).slice(0, 120));
  const ready = await c.until((f) => f.post_type === 'session_ready' && f.session_id === sid);
  ok('P7b session_ready 广播到 poll', !!ready, ready && JSON.stringify(ready).slice(0, 140));

  const t0 = Date.now();
  await up(pid, { action: 'send', params: { session_id: sid, text: '1+1', stream: true }, echo: 's1' });
  const final = await c.until((f) => f.post_type === 'final' && f.session_id === sid, 15000);
  ok('P8 send→final 全链路（openclaw mock）', final && String(final.text).includes('2'),
     final && ('final=' + String(final.text).slice(0, 40) + ' ' + (Date.now() - t0) + 'ms'));

  // ---- P9 空转长等待（wait=2 空回）与即时性 ----
  await c.stop();
  await drain(pid);
  const tIdle = Date.now();
  const idle = await http('GET', '/p/poll?wait=2', { headers: { 'x-cws-poll': pid } });
  const idleMs = Date.now() - tIdle;
  ok('P9 空转 poll wait=2 约 2s 返回空帧', idle.status === 200 && Array.isArray(idle.json.frames)
     && idle.json.frames.length === 0 && idleMs >= 1800 && idleMs < 3500, idleMs + 'ms');

  await up(pid, { action: 'ping', params: {}, echo: 'p2' });
  const tLat = Date.now();
  const instant = await http('GET', '/p/poll?wait=5', { headers: { 'x-cws-poll': pid } });
  const latMs = Date.now() - tLat;
  const hasPong = (instant.json.frames || []).some((s) => s.includes('"p2"'));
  ok('P10 有帧即时返回（<1.5s）', instant.status === 200 && hasPong && latMs < 1500, latMs + 'ms hasPong=' + hasPong);

  // ---- P11 显式 close → 410 → 重开 → 会话还在 ----
  const cl = await http('POST', '/p/close', { headers: { 'x-cws-poll': pid }, body: '{}' });
  ok('P11a /p/close ok', cl.status === 200 && cl.json.ok === true);
  const after = await http('GET', '/p/poll?wait=0', { headers: { 'x-cws-poll': pid } });
  ok('P11b close 后 poll 410', after.status === 410, 'status=' + after.status);

  const reopen = await http('POST', '/p/open', { body: { token: TOKEN, client: 'cc-remote' } });
  const pid2 = reopen.json.pid;
  const c2 = pollClient(pid2);
  await up(pid2, { action: 'auth', params: { token: TOKEN }, echo: 'a2' });
  await c2.until((f) => f.echo === 'a2');
  await up(pid2, { action: 'sessions.list', params: {}, echo: 'sl1' });
  const sl = await c2.until((f) => f.echo === 'sl1');
  const sessArr = sl && (sl.sessions || sl.list || []);
  const found = Array.isArray(sessArr) && sessArr.some((s) => s.id === sid || s.session_id === sid);
  ok('P11c 重开后 sessions.list 可见原会话', found, sl && JSON.stringify(sl).slice(0, 160));
  c2.stop();
}

// ---- P12 WS 回归：/ws 路径不受影响（WebUI/旧笔端） ----
{
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(TOKEN), [], { handshakeTimeout: 4000 });
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ action: 'ping', params: {}, echo: 'ws1' }));
  const t0 = Date.now();
  let pong = null;
  while (Date.now() - t0 < 3000 && !pong) {
    pong = frames.find((f) => f.echo === 'ws1' && f.post_type === 'pong') || null;
    if (!pong) await wait(40);
  }
  ok('P12 WS 路径回归（URL token + pong）', !!pong);
  ws.close();
}

console.log('\n' + (fail === 0 ? 'SUMMARY_OK' : 'SUMMARY_FAIL') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
