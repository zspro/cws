#!/usr/bin/env node
// 长轮询 ack 重发 / 帧合并 / 未鉴权不收广播 / 排队项跨连接存活 的回归验收。
// 用法: node scripts/test-fix-transport2.mjs [--url http://127.0.0.1:18721] [--qurl http://127.0.0.1:18722]
//   --url  常规隔离服（+ mock-openclaw-gateway）
//   --qurl max_active_sessions=0 的隔离服（新建会话必排队），不给则跳过 Q 组
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:18721');
const QBASE = arg('qurl', '');
const TOKEN = 'polltest_tok';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  | ' + detail : ''));
  cond ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(base, method, p, { body, headers } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const openPid = async (base) => (await http(base, 'POST', '/p/open', { body: { token: TOKEN, client: 'fix2' } })).json.pid;
const up = (base, pid, frame) => http(base, 'POST', '/p/up', { headers: { 'x-cws-poll': pid }, body: frame });
const poll = (base, pid, q) => http(base, 'GET', '/p/poll?' + q, { headers: { 'x-cws-poll': pid } });
const echoes = (r) => (r.json.frames || []).map((s) => { try { return JSON.parse(s).echo; } catch { return null; } });

// ---- A1~A3 ack：未确认帧重发，确认后不再出现；不带 ack 的老客户端取走即删 ----
{
  const pid = await openPid(BASE);
  await up(BASE, pid, { action: 'ping', params: {}, echo: 'k1' });
  await wait(100);
  const r1 = await poll(BASE, pid, 'wait=0&ack=0');
  ok('A1 带 ack 的 poll 回 first 序号', typeof r1.json.first === 'number' && echoes(r1).includes('k1'), JSON.stringify(r1.json).slice(0, 80));
  // 模拟响应丢失：不推进 ack，再取一次应重发
  const r2 = await poll(BASE, pid, 'wait=0&ack=0');
  ok('A2 ack 未推进 → 同一帧重发', echoes(r2).includes('k1') && r2.json.first === r1.json.first);
  const last = r1.json.first + r1.json.frames.length - 1;
  const r3 = await poll(BASE, pid, 'wait=0&ack=' + last);
  ok('A3 ack 覆盖后不再重发', !echoes(r3).includes('k1'), JSON.stringify(r3.json));

  const pidOld = await openPid(BASE);
  await up(BASE, pidOld, { action: 'ping', params: {}, echo: 'o1' });
  await wait(100);
  const o1 = await poll(BASE, pidOld, 'wait=0');
  const o2 = await poll(BASE, pidOld, 'wait=0');
  ok('A4 老客户端（无 ack）取走即删', echoes(o1).includes('o1') && !echoes(o2).includes('o1'));
}

// ---- M1 帧合并：挂起中连续到达的多帧一次回完 ----
{
  const pid = await openPid(BASE);
  const pending = poll(BASE, pid, 'wait=5&ack=0');
  await wait(200);
  up(BASE, pid, { action: 'ping', params: {}, echo: 'm1' });
  up(BASE, pid, { action: 'ping', params: {}, echo: 'm2' });
  up(BASE, pid, { action: 'ping', params: {}, echo: 'm3' });
  const r = await pending;
  const got = echoes(r);
  ok('M1 挂起期间 3 帧合并成一次响应', ['m1', 'm2', 'm3'].every((e) => got.includes(e)), JSON.stringify(got));
}

// ---- U1 未鉴权 WS（v0.3 无 token 升级）收不到会话广播 ----
{
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws';
  const sniff = new WebSocket(wsUrl);
  const leaked = [];
  sniff.on('message', (d) => { try { leaked.push(JSON.parse(d.toString())); } catch { /* skip */ } });
  await new Promise((r) => sniff.on('open', r));
  const pid = await openPid(BASE);
  await up(BASE, pid, { action: 'new_session', params: { backend: 'openclaw' }, echo: 'ns' });
  let sid = null;
  for (let i = 0; i < 50 && !sid; i++) {
    const r = await poll(BASE, pid, 'wait=1');
    for (const s of r.json.frames || []) { const f = JSON.parse(s); if (f.echo === 'ns' && f.session_id) sid = f.session_id; }
  }
  await up(BASE, pid, { action: 'send', params: { session_id: sid, text: '2+3' }, echo: 's' });
  await wait(2500);
  const streamed = leaked.filter((f) => ['user_msg', 'delta', 'final', 'cc_msg'].includes(f.post_type));
  ok('U1 未鉴权连接收不到 user_msg/delta/final', sid && streamed.length === 0, 'leaked=' + streamed.map((f) => f.post_type).join(','));
  sniff.close();
}

// ---- Q1~Q2 排队：重发同 sid 回 session_queued（不再报 exists）；断线后排队项还在 ----
if (QBASE) {
  const pidA = await openPid(QBASE);
  await up(QBASE, pidA, { action: 'new_session', params: { session_id: 'qtest01', backend: 'openclaw' }, echo: 'q1' });
  await wait(200);
  const a1 = await poll(QBASE, pidA, 'wait=0');
  const queued1 = (a1.json.frames || []).map((s) => JSON.parse(s)).find((f) => f.echo === 'q1');
  ok('Q0 满员时新建会话排队', queued1 && queued1.post_type === 'session_queued', queued1 && JSON.stringify(queued1));
  await up(QBASE, pidA, { action: 'new_session', params: { session_id: 'qtest01', backend: 'openclaw' }, echo: 'q2' });
  await wait(200);
  const a2 = await poll(QBASE, pidA, 'wait=0');
  const re = (a2.json.frames || []).map((s) => JSON.parse(s)).find((f) => f.echo === 'q2');
  ok('Q1 重发同 sid 回 session_queued 而非 exists', re && re.post_type === 'session_queued', re && JSON.stringify(re));

  await http(QBASE, 'POST', '/p/close', { headers: { 'x-cws-poll': pidA }, body: {} });
  await wait(200);
  const pidB = await openPid(QBASE);
  await up(QBASE, pidB, { action: 'new_session', params: { session_id: 'qtest01', backend: 'openclaw' }, echo: 'q3' });
  await wait(200);
  const b1 = await poll(QBASE, pidB, 'wait=0');
  const re2 = (b1.json.frames || []).map((s) => JSON.parse(s)).find((f) => f.echo === 'q3');
  ok('Q2 原连接关闭后排队项仍在，新连接接管', re2 && re2.post_type === 'session_queued' && re2.position === 1, re2 && JSON.stringify(re2));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
