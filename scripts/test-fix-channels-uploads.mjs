#!/usr/bin/env node
// 渠道密钥不回传 / 编辑保留字段 / 附件落盘 / /p/up 大帧与即时回包 的回归验收。
// 用法: node scripts/test-fix-channels-uploads.mjs [--url http://127.0.0.1:18721] [--base <隔离服目录>]
// 依赖隔离服 + mock-openclaw-gateway（与 test-poll-transport.mjs 同一套环境）。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:18721');
const SRV_DIR = arg('base', process.cwd());
const TOKEN = 'polltest_tok';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  | ' + detail : ''));
  cond ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, p, { body, headers, timeoutMs = 35000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + p, {
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

const open = await http('POST', '/p/open', { body: { token: TOKEN, client: 'fixtest' } });
const pid = open.json.pid;
const H = { 'x-cws-poll': pid };
const frames = [];
let stopped = false;
(async () => {
  while (!stopped) {
    const r = await http('GET', '/p/poll?wait=2', { headers: H });
    if (r.status !== 200) break;
    for (const f of r.json.frames || []) { try { frames.push(JSON.parse(f)); } catch { /* skip */ } }
  }
})();
const until = async (pred, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const f = frames.find(pred);
    if (f) return f;
    if (Date.now() - t0 > ms) return null;
    await wait(40);
  }
};
const up = (frame) => http('POST', '/p/up', { headers: H, body: frame });

// ---- C1~C3 渠道：快照不含明文 key，编辑不带 protocol 时沿用旧值 ----
await up({ action: 'channels.save', params: { name: 'fixch', label: 'Fix', base_url: 'https://example.invalid/v1', protocol: 'openai', wire_api: 'chat', api_key: 'sk-test-SECRET-9876', model: 'm1' }, echo: 'cs1' });
await until((f) => f.echo === 'cs1');
await up({ action: 'channels.list', params: {}, echo: 'cl1' });
const list1 = await until((f) => f.echo === 'cl1');
const ch1 = list1 && (list1.channels || []).find((c) => c.name === 'fixch');
ok('C1 channels 快照无 api_key 字段', ch1 && !('api_key' in ch1), ch1 && JSON.stringify(ch1));
ok('C2 只给 key_tail 末 4 位', ch1 && ch1.key_tail === '9876' && !JSON.stringify(list1).includes('SECRET'));

// 笔端编辑表单形状：不带 protocol / wire_api / api_key
await up({ action: 'channels.save', params: { name: 'fixch', label: 'Fix2', base_url: 'https://example.invalid/v1', api_key: '', model: 'm2' }, echo: 'cs2' });
await until((f) => f.echo === 'cs2');
await up({ action: 'channels.list', params: {}, echo: 'cl2' });
const list2 = await until((f) => f.echo === 'cl2');
const ch2 = list2 && (list2.channels || []).find((c) => c.name === 'fixch');
ok('C3 编辑不带 protocol → 保留 openai/chat，key 保留', ch2 && ch2.protocol === 'openai' && ch2.wire_api === 'chat' && ch2.key_tail === '9876' && ch2.model === 'm2',
   ch2 && JSON.stringify(ch2));
await up({ action: 'channels.delete', params: { channel: 'fixch' }, echo: 'cd1' });
await until((f) => f.echo === 'cd1');

// ---- U1~U4 附件：落盘、路径进模型文本、user_msg 带 files、占位与笔端一致 ----
await up({ action: 'new_session', params: { backend: 'openclaw' }, echo: 'ns1' });
const ns = await until((f) => f.echo === 'ns1');
const sid = ns && ns.session_id;
await until((f) => f.post_type === 'session_ready' && f.session_id === sid);
const content = 'hello attachment ' + Date.now();
await up({ action: 'send', params: { session_id: sid, text: 'look', files: [
  { name: '../../evil/a.txt', media_type: 'application/octet-stream', data: Buffer.from(content).toString('base64') },
] }, echo: 's1' });
const um = await until((f) => f.post_type === 'user_msg' && f.session_id === sid);
ok('U1 user_msg 占位文本与笔端预拼一致', um && um.text === 'look\n[附件 ×1]', um && JSON.stringify(um.text));
ok('U2 user_msg 带 files 名单（名字去掉路径）', um && Array.isArray(um.files) && um.files[0].name === 'a.txt', um && JSON.stringify(um.files));
const upDir = path.join(SRV_DIR, 'workspaces', sid, 'uploads');
const saved = fs.existsSync(upDir) ? fs.readdirSync(upDir) : [];
ok('U3 附件落到会话 uploads/ 且内容正确', saved.length === 1 && fs.readFileSync(path.join(upDir, saved[0]), 'utf8') === content, saved.join(','));
const fin = await until((f) => f.post_type === 'final' && f.session_id === sid, 15000);
ok('U4 模型收到的文本含附件路径', fin && String(fin.text).includes('look') && String(fin.text).includes('[用户上传的附件'), fin && String(fin.text).slice(0, 60));

// ---- P1/P2 /p/up：>1MB 帧不再被拒；大帧回包即时 ----
const big = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64'); // 3MB → base64 4MB
const t0 = Date.now();
const rBig = await up({ action: 'send', params: { session_id: sid, text: 'big', files: [{ name: 'big.bin', data: big }] }, echo: 's2' });
ok('P1 4MB 上行帧 200（旧上限 1MB 会被拒）', rBig.status === 200, 'status=' + rBig.status + ' ' + (Date.now() - t0) + 'ms');
const um2 = await until((f) => f.post_type === 'user_msg' && f.session_id === sid && f.text === 'big\n[附件 ×1]', 15000);
ok('P2 大附件轮正常受理', !!um2);
const rHuge = await http('POST', '/p/up', { headers: H, body: '"' + 'x'.repeat(81 * 1024 * 1024) + '"', timeoutMs: 60000 }).catch((e) => ({ status: 'err:' + e.name }));
ok('P3 超 80MB 回 413 或被断开，不拖垮连接', rHuge.status === 413 || String(rHuge.status).startsWith('err'), 'status=' + rHuge.status);
await up({ action: 'ping', params: {}, echo: 'pg' });
ok('P4 之后连接仍可用（ping/pong）', !!(await until((f) => f.echo === 'pg')));

stopped = true;
await wait(2500);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
