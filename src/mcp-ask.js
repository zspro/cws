#!/usr/bin/env node
// mcp-ask.js — cws 的 MCP 问卡工具（stdio JSON-RPC，最小实现）。
// 为什么要有它：codebuddy 的 ptc/minimal 模式里 AskUserQuestion 只能写在 REPL 单元里，
// CLI 会走嵌套审批（headless 没有宿主）→ 等 15s 超时。而 REPL 里调用 MCP 工具是正常
// 工具调用，结果作为真正的工具返回值回到模型——不会像「改写代码塞答案」那样让模型
// 以为答案是自己编的（真机实测：模型会拒绝采信，整轮翻车）。
// 桥端 spawn CLI 时用 --mcp-config 挂上本文件，env 带：
//   CWS_ASK_URL     桥端 HTTP 端点 http://127.0.0.1:<port>/mcp-ask
//   CWS_ASK_SECRET  进程启动时随机生成的共享密钥（x-cws-ask 头）
//   CWS_ASK_SESSION 会话 id（桥端据此找到 session 发 ask 帧）
import process from 'node:process';

const NL = String.fromCharCode(10);
const URL_ = process.env.CWS_ASK_URL || '';
const SECRET = process.env.CWS_ASK_SECRET || '';
const SESSION = process.env.CWS_ASK_SESSION || '';
const PEN_URL = URL_.replace(/\/mcp-ask$/, '/mcp-pen');

const TOOL = {
  name: 'ask_user',
  description: 'Ask the human user a question with a few options and wait for their real choice. ' +
    'Use this instead of AskUserQuestion in this session: there is no nested approval UI, so ' +
    'AskUserQuestion hangs. Returns the option the user actually picked.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user.' },
      options: {
        type: 'array',
        description: 'Answer choices, 2-4 items.',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label'],
        },
      },
      multiSelect: { type: 'boolean', description: 'Allow picking several options.' },
    },
    required: ['question', 'options'],
  },
};

const TOOL_SEND = {
  name: 'send_file',
  description: 'Write a file onto the dictionary pen. Path must be absolute under /userdisk/ ' +
    '(e.g. /userdisk/Documents/notes.md). Use this to hand documents, notes or images to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute path under /userdisk/' },
      content: { type: 'string', description: 'file content (text, or base64 when encoding=base64)' },
      encoding: { type: 'string', enum: ['text', 'base64'], description: 'default text' },
    },
    required: ['path', 'content'],
  },
};

async function callSendFile(args) {
  const target = String(args.path || '').trim();
  if (!target.startsWith('/userdisk/')) return textOf('path 必须以 /userdisk/ 开头', true);
  const encoding = args.encoding === 'base64' ? 'base64' : 'text';
  const body = { session_id: SESSION, path: target, encoding };
  if (encoding === 'base64') body.data = String(args.content || '');
  else body.content = String(args.content || '');
  if (!PEN_URL || !SECRET) return textOf('投文件通道未配置（缺 CWS_ASK_* 环境变量）', true);
  let r;
  try {
    r = await fetch(PEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cws-ask': SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    return textOf('投文件请求失败：' + String((e && e.message) || e), true);
  }
  const out = await r.json().catch(() => null);
  if (!r.ok || !out || !out.ok) {
    return textOf('投文件失败：' + ((out && out.error) || ('HTTP ' + r.status)), true);
  }
  return textOf('已写入词典笔：' + target + '（' + (out.bytes || 0) + ' 字节）');
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + NL); }

function textOf(s, isError) {
  return { content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) };
}

async function callAsk(args) {
  const options = (Array.isArray(args.options) ? args.options : []).map((o) => (
    typeof o === 'string'
      ? { label: o }
      : { label: String((o && o.label) || ''), description: o && o.description ? String(o.description) : '' }
  )).filter((o) => o.label);
  if (!args.question || !options.length) return textOf('参数不合法：question 和 options 必填', true);
  if (!URL_ || !SECRET || !SESSION) {
    return textOf('问卡通道未配置（缺 CWS_ASK_* 环境变量）：请把问题写进回复正文。', true);
  }
  let r;
  try {
    r = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cws-ask': SECRET },
      body: JSON.stringify({
        session_id: SESSION,
        question: String(args.question),
        options,
        multiSelect: !!args.multiSelect,
      }),
      signal: AbortSignal.timeout(150000),
    });
  } catch (e) {
    return textOf('问卡请求失败：' + String((e && e.message) || e) + '。请把问题写进回复正文。', true);
  }
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || !body.ok) {
    return textOf('问卡失败：' + ((body && body.error) || ('HTTP ' + r.status)) + '。请把问题写进回复正文。', true);
  }
  if (body.behavior !== 'allow') {
    return textOf(body.behavior === 'timeout'
      ? '用户没有在时限内回答。请把问题写进回复正文再问一次。'
      : '用户拒绝了这次提问。');
  }
  const answer = String(body.answer || '');
  return textOf('用户选择：' + answer + (body.answers ? '（完整答复：' + JSON.stringify(body.answers) + '）' : ''));
}

function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cws-ask', version: '1.0.0' },
    } });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: [TOOL, TOOL_SEND] } }); return; }
  if (method === 'tools/call') {
    if (params.name === 'ask_user') {
      callAsk(params.arguments || {}).then((result) => send({ jsonrpc: '2.0', id, result }));
      return;
    }
    if (params.name === 'send_file') {
      callSendFile(params.arguments || {}).then((result) => send({ jsonrpc: '2.0', id, result }));
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + params.name } });
    return;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});