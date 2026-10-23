#!/usr/bin/env node
// mock codebuddy CLI: speaks the codebuddy stream-json protocol for acceptance tests.
// 与 mock-claude 的差异（对齐真 CLI 2.170.0 实测行为）：
//   1. 启动即发 system/init（无 initialize 握手），--session-id/--resume 的 ID 原样回显；
//   2. headless 无权限询问通道：工具调用直接 deny（assistant tool_use 帧 + 拒绝 result），
//      不发 control_request/can_use_tool；
//   3. 权限模式从 --permission-mode 参数读入并在 init.permissionMode 回显。
import readline from 'node:readline';
import process from 'node:process';

// ---- argv: --session-id <id> | --resume <id> | --permission-mode <mode> ----
const argv = process.argv.slice(2);
let argSid = null;
let resumeSid = null;
let permMode = 'default';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--session-id') argSid = argv[i + 1] || null;
  else if (argv[i] === '--resume' || argv[i] === '-r') resumeSid = argv[i + 1] || null;
  else if (argv[i] === '--permission-mode') permMode = argv[i + 1] || 'default';
}
const sid = resumeSid || argSid || ('mock-cbc-' + Math.random().toString(16).slice(2, 10));

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function resultFrame(text, extra = {}) {
  out({
    type: 'result', subtype: extra.is_error ? 'error_during_execution' : 'success',
    result: text, session_id: sid,
    usage: { input_tokens: 10, output_tokens: text.length, cache_read_input_tokens: 0 },
    total_cost_usd: 0.0001, duration_ms: 120, num_turns: 1,
    is_error: !!extra.is_error, ...extra,
  });
}
function delta(text) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }, session_id: sid });
}
function assistantFrame(blocks) {
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', model: 'mock-codebuddy', content: blocks } });
}

// 启动即发 init（真 CLI 行为；启动早期连发两次也属正常，桥端幂等）
out({ type: 'system', subtype: 'init', uuid: sid, session_id: sid, model: 'mock-codebuddy', permissionMode: permMode });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (obj.type === 'control_request') {
    // 桥对不支持的控制请求回 deny；mock 同样礼貌回绝，保持协议闭环
    out({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: { behavior: 'deny', message: 'mock: unsupported' } } });
    return;
  }
  if (obj.type !== 'user') return;
  const text = (obj.message.content || []).map((b) => b.text || '').join('');

  if (text.includes('数到') || text.includes('数数')) {
    (async () => {
      for (let i = 1; i <= 300; i++) {
        delta(String(i) + '\n');
        await new Promise((r) => setTimeout(r, 30));
      }
      resultFrame('数完了');
    })();
    return;
  }
  if (text.includes('tool')) {
    // headless 默认权限：工具调用被 CLI 直接拒绝（无 ask 卡片路径）
    delta('需要执行命令。');
    assistantFrame([{ type: 'text', text: '需要执行命令。' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'printf hi > p4test.txt' } }]);
    resultFrame('工具调用被拒绝（headless 默认拒绝）');
    return;
  }
  const m = text.match(/(\d+)\s*\+\s*(\d+)/);
  const n = m ? String(Number(m[1]) + Number(m[2])) : 'mock-codebuddy 收到：' + text.slice(0, 30);
  delta(n);
  assistantFrame([{ type: 'text', text: n }]);
  resultFrame(n);
});
rl.on('close', () => process.exit(0));
