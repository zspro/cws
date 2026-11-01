#!/usr/bin/env node
// 笔端 rcpoll.js 客户端逻辑验收：用 Node fetch 仿真笔端 Fetch 模块
// （status/ok/_body 同形），对隔离服跑完整事件序列：
// open→auth_ok→hello→pong→close；并验证 404 回退回调与 401→close(4001)。
// 用法: node scripts/test-rcpoll-client.mjs [--url http://127.0.0.1:18721]
import { rcCreatePollClient } from '../src/rcpoll.js';

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

// 笔端 Fetch 模块仿真：fetch(url, opts) → {status, ok, _body}，reject=网络错
const fetchMod = {
  fetch: function (url, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), (opts.timeout || 10) * 1000);
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      signal: ac.signal,
    }).then(async (res) => {      clearTimeout(t);
      const body = await res.text();
      return { status: res.status, ok: res.ok, _body: body, text: () => body };
    }, (e) => { clearTimeout(t); throw e; });
  },
};

/** 收集事件直到谓词/超时 */
function makeClient(url, opts) {
  const events = [];
  const c = rcCreatePollClient(url, {
    fetchMod,
    token: TOKEN,
    client: 'cc-remote',
    version: '1.6.1',
    ...opts,
  });
  c.setEventCallback((evts) => { for (const e of evts) events.push(e); });
  c.open();
  return {
    c, events,
    async until(pred, ms = 8000) {
      const t0 = Date.now();
      for (;;) {
        const f = events.find(pred);
        if (f) return f;
        if (Date.now() - t0 > ms) return null;
        await wait(30);
      }
    },
  };
}
const wsBase = BASE.replace(/^http/, 'ws');

// ---- R1 主路径：open→auth→hello→ping/pong 全走事件接口 ----
{
  const { c, events, until } = makeClient(wsBase);
  const openEv = await until((e) => e.type === 'open', 6000);
  ok('R1 open 事件（换 pid 成功）', !!openEv && typeof c.getReadyState() === 'number');

  c.send(JSON.stringify({ action: 'auth', params: { token: TOKEN }, echo: 'ra1' }));
  const authOk = await until((e) => e.type === 'message' && e.data.includes('"ra1"'));
  ok('R2 auth 帧回 auth_ok（message 事件 data=原始 JSON）',
     !!authOk && JSON.parse(authOk.data).post_type === 'auth_ok');

  c.send(JSON.stringify({ action: 'hello', params: { client: 'cc-remote', version: '1.6.1' }, echo: 'rh1' }));
  const hello = await until((e) => e.type === 'message' && e.data.includes('"rh1"'));
  ok('R3 hello 回帧带 caps', !!hello && JSON.parse(hello.data).post_type === 'hello');

  c.send(JSON.stringify({ action: 'ping', params: {}, echo: 'rp1' }));
  const pong = await until((e) => e.type === 'message' && e.data.includes('"rp1"'));
  ok('R4 ping/pong 走事件接口', !!pong);
  ok('R5 readyState=1', c.getReadyState() === 1);

  c.close();
  const closeEv = await until((e) => e.type === 'close');
  ok('R6 close 事件（code=1000）', !!closeEv && closeEv.code === 1000, closeEv && ('code=' + closeEv.code));
  ok('R7 close 后 readyState=3', c.getReadyState() === 3);
}

// ---- R8 老服务端（无 /p/open）→ onUnsupported 回调 + close(1006) ----
{
  let unsupported = false;
  const { events, until } = makeClient('ws://127.0.0.1:1/ws', {
    onUnsupported: () => { unsupported = true; },
  });
  const closeEv = await until((e) => e.type === 'close', 6000);
  ok('R8 连不上老端口 → error+close(1006)', !unsupported && !!closeEv && closeEv.code === 1006,
     closeEv && ('code=' + closeEv.code));
}

// ---- R9 错 token → close(4001)（rccws 按 auth_error 处理不重连） ----
{
  const events = [];
  const c = rcCreatePollClient(wsBase, { fetchMod, token: 'WRONG', client: 'cc-remote' });
  c.setEventCallback((evts) => { for (const e of evts) events.push(e); });
  c.open();
  const t0 = Date.now();
  let closeEv = null;
  while (Date.now() - t0 < 6000) {
    closeEv = events.find((e) => e.type === 'close') || null;
    if (closeEv) break;
    await wait(30);
  }
  ok('R9 错 token → close(4001)', !!closeEv && closeEv.code === 4001, closeEv && ('code=' + closeEv.code));
}

console.log('\n' + (fail === 0 ? 'SUMMARY_OK' : 'SUMMARY_FAIL') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
