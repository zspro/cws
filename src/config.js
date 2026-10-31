// cc-bridge (Node) — 3-layer config: config.json ← channels.json ← secrets.json.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BASE, loadJsonFile, writeJsonFile, log } from './util.js';

const CONFIG_PATH = path.join(BASE, 'config.json');
const SECRETS_PATH = path.join(BASE, 'secrets.json');
const CHANNELS_PATH = path.join(BASE, 'channels.json');
export const WORKSPACES = path.join(BASE, 'workspaces');

/** Normalize a user-typed base URL (full-width chars, stray punctuation, scheme). */
export function normalizeBaseUrl(raw) {
  let base = String(raw || '').trim();
  base = base.replace(/[．。.,;；，?？!！）)]+\s*$/, '').trim();
  base = base.replace(/：/g, ':').replace(/／/g, '/').replace(/．/g, '.').replace(/。/g, '.');
  base = base.replace(/\s+/g, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base.replace(/\/+$/, '');
}

export function isValidChannelName(name) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(String(name || ''));
}

export function loadConfig() {
  const cfg = loadJsonFile(CONFIG_PATH, {});
  const secrets = loadJsonFile(SECRETS_PATH, {});
  const channels = loadJsonFile(CHANNELS_PATH, null);

  for (const key of ['token', 'one_time_tokens']) {
    if (secrets[key] !== undefined) cfg[key] = secrets[key];
  }

  if (channels !== null) {
    cfg.api_channels = channels.api_channels || [];
    if (channels.default_channel !== undefined) cfg.default_channel = channels.default_channel;
  }

  // channel api_key: inline > secrets.json api_keys[name] > env[api_key_env]
  const secretKeys = secrets.api_keys || {};
  for (const ch of cfg.api_channels || []) {
    if (!ch || typeof ch !== 'object') continue;
    if (ch.api_key) continue;
    const name = ch.name || '';
    if (secretKeys[name]) {
      ch.api_key = secretKeys[name];
      continue;
    }
    const envName = ch.api_key_env;
    if (envName && process.env[envName]) ch.api_key = process.env[envName];
  }
  return cfg;
}

// ---- mutable runtime store (persisted on channel changes) ----
const cfg = loadConfig();

export const CFG = cfg;
export const TOKEN = String(cfg.token || '');
export const ONE_TIME_TOKENS = new Set(cfg.one_time_tokens || []);
export const PORT = Number(cfg.port || 8642);

// ---- 协议 v0.3：首帧鉴权 + hello 版本交换 ----
// SERVER_VERSION 取 package.json（唯一事实源）；SERVER_CAPS 是服务端自报的
// 能力集，客户端（笔端/WebUI/QQ）凭 hello 回帧做特性 gating。
export const SERVER_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
})();
// 对外可访问的基地址（给「文件下载链接」用）：config.json 的 public_base，
// 缺省按当前 IP 站点的 8443 反代填，部署换域名时改这里即可。
export const PUBLIC_BASE = String(cfg.public_base || 'https://154.219.106.224:8443').trim();

// 项目的默认根目录：新建项目不填路径时用它拼出 <root>/<名称>。空 = 必须填完整路径。
export const PROJECTS_ROOT = String(cfg.projects_root || '').trim();

export const SERVER_CAPS = ['frame_auth', 'hello', 'backends', 'remark', 'projects', 'models'];
// 无 token 升级进来（v0.3 路径）的连接，等首帧 auth 的窗口；超时未鉴权即断。
// URL ?token= 鉴权（v0.2，WebUI/QQ 在用）不受影响。
export const FRAME_AUTH_TIMEOUT_S = Number(cfg.frame_auth_timeout_s ?? 10);
export let CLAUDE_BIN = cfg.claude_bin || '/usr/local/bin/claude';
export let CODEX_BIN = cfg.codex_bin || 'codex';
export let CODEBUDDY_BIN = cfg.codebuddy_bin || 'codebuddy';
export let DEFAULT_BACKEND = ['openclaw', 'codex', 'codebuddy', 'claude'].includes(cfg.default_backend) ? cfg.default_backend : 'claude';
export const MAX_ACTIVE = Number(cfg.max_active_sessions ?? 3);
export const QUEUE_MAX = Number(cfg.queue_max ?? 5);
// 轮内空闲超时（不是整轮墙钟）：后端 stdout 持续有输出（delta/tool/thinking）就续期，
// 连续 N 秒毫无动静才 abort。长任务只要在推进就不会被截断；<=0 关闭。
export const TURN_TIMEOUT = Number(cfg.turn_timeout ?? 300);
// 工具执行期的空闲预算：docker build/npm install/curl 等长工具可能数分钟不产生
// 任何 stdout 事件（CLI 在工具执行期间不发 keepalive），300s 对话预算会误杀。
// 模型恢复输出（正文/下一批工具）后回到 TURN_TIMEOUT。<=0 跟随 TURN_TIMEOUT。
export const TOOL_IDLE_TIMEOUT = Number(cfg.tool_idle_timeout ?? 900);
export const ASK_TIMEOUT = Number(cfg.ask_timeout ?? 120);
export const MIN_TURN_INTERVAL = Number(cfg.min_turn_interval ?? 2);
export const IDLE_TIMEOUT = Number(cfg.idle_timeout_s ?? 1800);
// WS 断开（app 切后台）是否立刻回收会话进程：默认否——进程留到 idle_timeout 统一 reap，
// 否则会话里挂的后台任务（等待器等）随进程组一起死，用户体验是"老被截断"
export const REAP_ON_DETACH = cfg.reap_on_detach === true;

// 可拆卸插件配置：config.json plugins.<name>（非密配置 + enabled 开关），
// secrets.json plugins.<name>（密钥等敏感字段，按名合并盖过 config.json）。
// 停用 = 删条目或 enabled:false；替换 = 换 src/plugins/<name>/index.js（目录形态，
// 单文件 <name>.js 仍支持）——bridge 代码零改动。契约 v2 见 bridge.js
// _loadPlugins/_pluginCtx 注释与 src/plugins/onebot/README.md。
export const PLUGINS = {};
{
  const secrets = loadJsonFile(SECRETS_PATH, {});
  for (const [name, pc] of Object.entries(cfg.plugins || {})) {
    if (pc && typeof pc === 'object') PLUGINS[name] = { ...pc };
  }
  for (const [name, pc] of Object.entries(secrets.plugins || {})) {
    if (pc && typeof pc === 'object') PLUGINS[name] = { ...(PLUGINS[name] || {}), ...pc };
  }
}
// Workspace 磁盘保留期（秒）：注册表外的目录超过该时长才会被 sweep 删除；<=0 关闭清扫
export const WS_RETENTION_S = Number(cfg.ws_retention_s ?? 7 * 86400);
export const ALLOWED_TOOLS = cfg.allowed_tools || 'Read,Grep,Glob,Write,Edit,Bash,AskUserQuestion';
export const PERMISSION_MODE = cfg.permission_mode || 'default';
// codebuddy 自动压缩阈值（--autocompact）：自定义渠道下 CLI 不知道模型窗口，
// 'auto' 永不触发，transcript 超窗后上游静默截断开头（表现为"忘记早前约定"）。
// 显式给 token 阈值（CLI 端 clamp 100k-1M）强制压缩；'auto' 透传；0/'' 关闭。
export const CODEBUDDY_AUTOCOMPACT = String(cfg.codebuddy_autocompact ?? 150000);
// ptc/minimal 模式下 AskUserQuestion 只能嵌在 REPL 里调（CLI 系统提示强制），
// 而 stream-json 客户端没有嵌套审批 UI，CLI 默认挂死 10 分钟（6e5ms）才放弃。
// 桥侧把它压短，嵌套 ask 快速失败后模型会按 CLI 提示把问题写进回复正文。
export const CODEBUDDY_REPL_NESTED_TIMEOUT_MS = Number(cfg.codebuddy_repl_nested_timeout_ms ?? 15000);
export const WEBUI_CFG = {
  enabled: (cfg.webui && cfg.webui.enabled) !== false,
  dir: (cfg.webui && cfg.webui.dir) || 'webui',
};

// 远程网关（OpenClaw 等）：name -> { url, token, agent }
export let GATEWAYS = cfg.gateways || {};
// 网关 token：内联 > secrets.json gateway_tokens[name] > 环境变量
{
  const secrets = loadJsonFile(SECRETS_PATH, {});
  const gt = secrets.gateway_tokens || {};
  for (const [name, g] of Object.entries(GATEWAYS)) {
    if (!g || typeof g !== 'object' || g.token) continue;
    if (gt[name]) g.token = gt[name];
    else {
      const env = process.env['CWS_GATEWAY_TOKEN_' + String(name).toUpperCase()];
      if (env) g.token = env;
    }
  }
}
export function gatewayByName(name) {
  return GATEWAYS[name] || null;
}

// setter（ESM import 绑定只读，跨模块修改经这些函数）
export function setClaudeBin(v) { CLAUDE_BIN = v; }
export function setCodexBin(v) { CODEX_BIN = v; }
export function setCodebuddyBin(v) { CODEBUDDY_BIN = v; }
export function setDefaultBackend(v) { if (['openclaw', 'codex', 'codebuddy', 'claude'].includes(v)) DEFAULT_BACKEND = v; }
export function setGateways(next) {
  for (const k of Object.keys(GATEWAYS)) delete GATEWAYS[k];
  Object.assign(GATEWAYS, next);
}

/** 持久化后端配置（claude/codex/codebuddy 路径 + 默认后端 + 网关）到 config.json/secrets.json。 */
export function persistBackends() {
  try {
    const cfgFile = loadJsonFile(CONFIG_PATH, {});
    cfgFile.claude_bin = CLAUDE_BIN;
    cfgFile.codex_bin = CODEX_BIN;
    cfgFile.codebuddy_bin = CODEBUDDY_BIN;
    cfgFile.default_backend = DEFAULT_BACKEND;
    const gOut = {};
    const tokens = {};
    for (const [name, g] of Object.entries(GATEWAYS)) {
      if (!g || typeof g !== 'object') continue;
      gOut[name] = { url: g.url || '', agent: g.agent || 'main' };
      if (g.token) tokens[name] = g.token;
    }
    cfgFile.gateways = gOut;
    writeJsonFile(CONFIG_PATH, cfgFile);
    const s = loadJsonFile(SECRETS_PATH, {});
    s.gateway_tokens = tokens;
    writeJsonFile(SECRETS_PATH, s, 0o600);
  } catch (e) {
    log('persist_backends_err', { err: String(e) });
  }
}

export let API_CHANNELS = Array.isArray(cfg.api_channels) ? cfg.api_channels : [];
// mutable default-channel holder (ESM import bindings are read-only; mutate state, not bindings)
export const channelState = { defaultChannel: cfg.default_channel || '' };
export function setDefaultChannel(name) {
  channelState.defaultChannel = name;
}

export function channelByName(name) {
  if (!name) return null;
  for (const ch of API_CHANNELS) {
    if (ch && typeof ch === 'object' && ch.name === name) return ch;
  }
  return null;
}

export function persistOneTimeTokens() {
  try {
    const c = loadJsonFile(SECRETS_PATH, {});
    c.one_time_tokens = [...ONE_TIME_TOKENS].sort();
    writeJsonFile(SECRETS_PATH, c, 0o600);
  } catch (e) {
    log('persist_otp_err', { err: String(e) });
  }
}

export function persistChannels() {
  try {
    const secretKeys = {};
    const channelsOut = [];
    for (const ch of API_CHANNELS) {
      if (!ch || typeof ch !== 'object') continue;
      const entry = { ...ch };
      delete entry.api_key;
      if (ch.api_key && !ch.api_key_env) secretKeys[ch.name || ''] = ch.api_key;
      channelsOut.push(entry);
    }
    const c = { api_channels: channelsOut, default_channel: channelState.defaultChannel };
    writeJsonFile(CHANNELS_PATH, c);
    const s = loadJsonFile(SECRETS_PATH, {});
    s.api_keys = secretKeys;
    writeJsonFile(SECRETS_PATH, s, 0o600);
    if (!fs.existsSync(SECRETS_PATH)) fs.chmodSync(SECRETS_PATH, 0o600);
  } catch (e) {
    log('persist_channels_err', { err: String(e) });
  }
}
