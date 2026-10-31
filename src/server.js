// cc-bridge (Node) — entry: HTTP static WebUI + /ws upgrade + graceful shutdown.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Bridge } from './bridge.js';
import {
  TOKEN, ONE_TIME_TOKENS, PORT, WEBUI_CFG, persistOneTimeTokens, gatewayByName,
} from './config.js';
import { BASE, log, safeEqual, isValidSid } from './util.js';

const bridge = new Bridge();
const wss = new WebSocketServer({ noServer: true });

/**
 * OpenClaw 媒体代理：/oc-media/<gw>/<direction>/<sess>/<id>/<size>?sig=…
 * 网关 /api/chat/media/ 要 Bearer token 且端口不出公网，笔端直连够不到——
 * openclaw-session 把图片块改写成带 HMAC 签名的本端相对 URL，这里验签后
 * 用网关 token 取回。sig = HMAC-SHA256(桥token, gw + '\n' + path) 前 16 hex；
 * 路径白名单死守，只放行媒体形态，变形一律 403。
 */
const OC_MEDIA_RE = /^[a-z]+\/[A-Za-z0-9%_.\-]+\/[A-Za-z0-9%_.\-]+\/[A-Za-z0-9_\-]+$/;
async function serveOcMedia(req, res, urlPath, query) {
  const m = urlPath.match(/^\/oc-media\/([^/]+)\/(.+)$/);
  if (!m) { res.writeHead(404).end('not found'); return; }
  const gwName = decodeURIComponent(m[1]);
  const rest = m[2];
  if (!OC_MEDIA_RE.test(rest)) { res.writeHead(403).end('forbidden'); return; }
  const expect = crypto.createHmac('sha256', TOKEN).update(m[1] + '\n' + rest).digest('hex').slice(0, 16);
  if (!safeEqual(String(query.get('sig') || ''), expect)) { res.writeHead(403).end('forbidden'); return; }
  const gw = gatewayByName(gwName);
  if (!gw || !gw.url) { res.writeHead(404).end('unknown gateway'); return; }
  const upstream = String(gw.url).replace(/^ws/i, 'http') + '/api/chat/media/' + rest;
  try {
    const r = await fetch(upstream, { headers: { authorization: 'Bearer ' + String(gw.token || '') } });
    if (!r.ok) { res.writeHead(r.status).end('upstream ' + r.status); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'content-type': r.headers.get('content-type') || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'private, max-age=86400',
    });
    res.end(buf);
  } catch (e) {
    log('oc_media_err', { err: String(e) });
    if (!res.headersSent) res.writeHead(502);
    res.end('bad gateway');
  }
}

function serveStatic(req, res) {
  const webuiRoot = path.resolve(BASE, WEBUI_CFG.dir);
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.resolve(webuiRoot, '.' + urlPath);
  if (!filePath.startsWith(webuiRoot + path.sep) && filePath !== webuiRoot) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// 共享文件：workspaces/<sid>/shared/<file>，token 走 query（浏览器直接点链接）
const SHARED_MIME = {
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.zip': 'application/zip', '.html': 'text/html; charset=utf-8',
};
function serveSharedFile(req, res, rawPath) {
  try {
  const url = new URL(req.url || '/', 'http://bridge.local');
  const t = url.searchParams.get('t') || '';
  if (!t || !safeEqual(t, TOKEN)) { res.writeHead(403).end('forbidden'); return; }
  const m = rawPath.match(/^\/f\/([A-Za-z0-9_-]{1,64})\/([^/]{1,200})$/);
  if (!m) { res.writeHead(404).end('not found'); return; }
  const sid = m[1];
  const name = decodeURIComponent(m[2]);
  if (!isValidSid(sid) || name.indexOf('..') >= 0 || name.indexOf('/') >= 0) {
    res.writeHead(403).end('forbidden'); return;
  }
  const filePath = path.join(BASE, 'workspaces', sid, 'shared', name);
  if (!fs.existsSync(filePath)) { res.writeHead(404).end('not found'); return; }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'content-type': SHARED_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'content-disposition': 'attachment; filename*=UTF-8\'\' ' + encodeURIComponent(name.replace(/^[0-9a-f]{12}-/, '')),
  });
  fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    log('shared_file_err', { path: rawPath, err: String(e) });
    try { if (!res.headersSent) res.writeHead(500).end('error'); } catch { /* ignore */ }
  }
}

const server = http.createServer((req, res) => {
  // access log: never log query strings (tokens live there)
  let rawPath = (req.url || '/').split('?')[0];
  // 前缀化部署的媒体路由：LoliAPP rccws 从 rcWsUrl(wss://host/cws-ws/ws) 推导出
  // 带 /cws-ws 前缀的图片地址。nginx 对 /cws-ws/oc-media/ 用无 URI 部分的
  // proxy_pass 原样透传（%3A 一字不动），这里在原始编码形态上剥前缀再验签——
  // 白名单正则与 HMAC 都按编码后的路径算，任何解码都会 403。
  if (rawPath.startsWith('/cws-ws/oc-media/')) rawPath = rawPath.slice('/cws-ws'.length);
  log('http', { method: req.method, path: rawPath });
  if (rawPath.startsWith('/oc-media/')) {
    const query = new URL(req.url || '/', 'http://bridge.local').searchParams;
    serveOcMedia(req, res, rawPath, query);
    return;
  }
  // 共享文件下载：/f/<sid>/<file>?t=<token>（AI 用 MCP share_file 生成链接）
  if (rawPath.startsWith('/f/')) {
    serveSharedFile(req, res, rawPath);
    return;
  }
  // MCP 问卡的桥端入口（cws 自家 MCP 服务 → 这里 → ask 帧 → 前端）
  if (rawPath === '/mcp-ask') {
    bridge.handleMcpAsk(req, res);
    return;
  }
  if (rawPath === '/mcp-pen') {
    bridge.handleMcpPen(req, res);
    return;
  }
  if (rawPath === '/mcp-file') {
    bridge.handleMcpFile(req, res);
    return;
  }
  // 插件 HTTP 路径注册表（契约 v2）：先于静态服务命中，前缀匹配交给插件
  for (const [prefix, handler] of bridge.httpHandlers) {
    if (rawPath === prefix || rawPath.startsWith(prefix)) {
      handler(req, res);
      return;
    }
  }
  if (WEBUI_CFG.enabled) {
    serveStatic(req, res);
  } else {
    res.writeHead(404).end('not found');
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://bridge.local');
  // 插件 WS 路径注册表（契约 v2）：在 /ws 之前按前缀匹配，命中即交给插件
  // 全权处理（鉴权插件自理，与桥 token 隔离）。/cws-ws 前缀化部署时 nginx
  // 可能原样透传，剥前缀再匹配一次（与上方 oc-media 同手法）。
  const paths = [url.pathname];
  if (url.pathname.startsWith('/cws-ws/')) paths.push(url.pathname.slice('/cws-ws'.length));
  for (const p of paths) {
    for (const [prefix, handler] of bridge.upgradeHandlers) {
      if (p === prefix || p.startsWith(prefix)) {
        handler(req, socket, head);
        return;
      }
    }
  }
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token') || '';
  let authorized = false;
  if (token !== '') {
    // v0.2 路径（WebUI/QQ/旧笔端）：URL ?token= 升级期鉴权。
    // 带 token 但错误 → 直接 401，不给帧内试探的余地
    authorized = safeEqual(token, TOKEN);
    if (!authorized && ONE_TIME_TOKENS.has(token)) {
      ONE_TIME_TOKENS.delete(token);
      persistOneTimeTokens();
      authorized = true;
      log('otp_consumed', {});
    }
    if (!authorized) {
      log('auth_fail', {});
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  // v0.3 路径：无 token 升级，连接进来后限时等首帧 auth（bridge.startFrameAuth）。
  // token 不再出现在 URL → 不进 Cloudflare/nginx 访问日志
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!authorized) bridge.startFrameAuth(ws);
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => bridge.handleConn(ws));

server.listen(PORT, '0.0.0.0', () => {
  log('start', {
    port: PORT, max_active: bridge.maxActive, webui: WEBUI_CFG.enabled,
    claude_bin_present: false, // informational only
  });
});

async function shutdown(sig) {
  log('shutdown', { signal: sig });
  await bridge.shutdown();
  wss.clients.forEach((c) => c.terminate());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
