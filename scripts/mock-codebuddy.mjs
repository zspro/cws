#!/usr/bin/env node
// mock codebuddy CLI: speaks the codebuddy stream-json protocol for acceptance tests.
// 与 mock-claude 的差异（对齐真 CLI 2.176.0 实测行为）：
//   1. 启动即发 system/init；--session-id/--resume 的 ID 原样回显；
//   2. 收到 initialize 控制请求回 ack（真 CLI 行为），随后工具调用发
//      control_request/can_use_tool（载荷 {allowed,updatedInput} / {allowed:false,reason}），
//      AskUserQuestion 未收到 initialize 声明 capabilities 时模拟「工具不存在」直接文本作答；
//   3. 权限模式从 --permission-mode 参数读入并在 init.permissionMode 回显。
import readline from 'node:readline';
import fs from 'node:fs';
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

let askCapable = false; // initialize 握手声明 capabilities.askUserQuestion 后为 true
let permSeq = 0;
const pendingPerm = new Map(); // request_id -> {tool_name, input}

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
// can_use_tool 询问通道：发 control_request，等 control_response 再继续
function canUseTool(toolName, input) {
  return new Promise((resolve) => {
    const requestId = `perm_${Date.now()}_${++permSeq}`;
    pendingPerm.set(requestId, { resolve });
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, input } });
  });
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
    if (obj.request && obj.request.subtype === 'initialize') {
      const caps = obj.request.capabilities || {};
      askCapable = caps.askUserQuestion === true;
      out({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: { commands: [] } } });
      return;
    }
    // 桥对不支持的控制请求回 deny；mock 同样礼貌回绝，保持协议闭环
    out({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: { allowed: false, reason: 'mock: unsupported' } } });
    return;
  }
  if (obj.type === 'control_response') {
    const resp = (obj.response || {}).response || {};
    const pend = pendingPerm.get(obj.response.request_id);
    if (pend) {
      pendingPerm.delete(obj.response.request_id);
      pend.resolve(resp);
    }
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
  if (text.includes('问我') || text.includes('AskUserQuestion')) {
    if (!askCapable) {
      // 未声明 askUserQuestion 能力（桥没做 initialize 握手）：工具不存在，文本作答
      const reply = '（无 AskUserQuestion 工具，只能文本提问）';
      delta(reply);
      assistantFrame([{ type: 'text', text: reply }]);
      resultFrame(reply);
      return;
    }
    const questions = [{ question: '你最喜欢哪个颜色？', header: '颜色', multiSelect: false,
      options: [{ label: '红', description: '红色' }, { label: '蓝', description: '蓝色' }, { label: '绿', description: '绿色' }] }];
    delta('让我问一下。');
    assistantFrame([{ type: 'text', text: '让我问一下。' }]);
    const resp = await canUseTool('AskUserQuestion', { questions });
    if (resp.allowed) {
      const answers = (resp.updatedInput || {}).answers || {};
      const picked = answers['你最喜欢哪个颜色？'] || '(未答)';
      const reply = `你选了：${picked}`;
      assistantFrame([{ type: 'text', text: reply }]);
      resultFrame(reply);
    } else {
      const reply = '问题被拒绝：' + (resp.reason || '(no reason)');
      assistantFrame([{ type: 'text', text: reply }]);
      resultFrame(reply);
    }
    return;
  }
  if (text.includes('tool')) {
    // 默认权限档：非 allowlist 工具走 can_use_tool 询问通道（真 CLI 2.176 实测行为）
    delta('需要执行命令。');
    assistantFrame([{ type: 'text', text: '需要执行命令。' }]);
    const resp = await canUseTool('Bash', { command: 'printf hi > p4test.txt' });
    if (resp.allowed) {
      resultFrame('工具已放行执行');
    } else {
      resultFrame('工具调用被拒绝：' + (resp.reason || '(no reason)'));
    }
    return;
  }
  if (text.includes('压缩')) {
    // 手动压缩序列（对齐 CLI 2.175 stream-json：status → compact_boundary → status）
    out({ type: 'system', subtype: 'status', status: 'compacting', uuid: sid, session_id: sid });
    await new Promise((r) => setTimeout(r, 50));
    out({ type: 'system', subtype: 'compact_boundary', uuid: sid, session_id: sid, compact_metadata: { trigger: 'manual', pre_tokens: 123456 } });
    out({ type: 'system', subtype: 'status', status: null, uuid: sid, session_id: sid });
    resultFrame('压缩完成');
    return;
  }
  if (text.includes('沉默')) {
    // 完全静默 5s（无 keepalive 无 delta），模拟上游请求挂死——配合
    // turn_timeout=2 的隔离服验证「静默超时自动重发」链路
    await new Promise((r) => setTimeout(r, 5000));
    resultFrame('沉默结束');
    return;
  }
  if (text.includes('重试成功')) {
    // 模拟「首次挂死、重发即成功」：桥的重发是新进程，用 cwd 标记文件跨进程记次
    const marker = 'retry-probe.marker';
    if (fs.existsSync(marker)) {
      fs.rmSync(marker);
      delta('重试成功');
      assistantFrame([{ type: 'text', text: '重试成功' }]);
      resultFrame('重试成功');
    } else {
      fs.writeFileSync(marker, '1');
      await new Promise((r) => setTimeout(r, 5000));
      resultFrame('不该看到这条');
    }
    return;
  }
  const m = text.match(/(\d+)\s*\+\s*(\d+)/);
  const n = m ? String(Number(m[1]) + Number(m[2])) : 'mock-codebuddy 收到：' + text.slice(0, 30);
  delta(n);
  assistantFrame([{ type: 'text', text: n }]);
  resultFrame(n);
});
rl.on('close', () => process.exit(0));
