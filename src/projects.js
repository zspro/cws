// projects.js — 项目（工作目录）注册表：一个目录挂多个会话，各自 sid、共享 cwd。
// 存 BASE/projects.json：{ projects: [{id, name, path, created}] }。
// 会话数据（turnlog.jsonl / sess.json）仍留在 workspaces/<sid>/，这里只管
// 「CLI 在哪个目录干活」——所以同一项目下的会话历史互不污染。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, log } from './util.js';

const FILE = path.join(BASE, 'projects.json');
// 项目路径一律按 POSIX 处理（服务端是 Linux；本地 Windows 调试时行为也一致）
const PP = path.posix;
const BAD_PREFIX = ['/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/lib', '/usr', '/etc'];

function readAll() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(d.projects) ? d.projects.filter((p) => p && p.id && p.path) : [];
  } catch { return []; }
}

function writeAll(list) {
  try { fs.writeFileSync(FILE, JSON.stringify({ projects: list }, null, 2)); } catch (e) { log('project_save_err', { err: String(e) }); }
}

export function listProjects() { return readAll(); }

export function projectById(id) {
  const s = String(id || '');
  return s ? (readAll().find((p) => p.id === s) || null) : null;
}

/** 校验并规范化项目路径：绝对路径、不含 ..、不是系统目录；返回 {path} 或 {error} */
export function checkProjectPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: '路径不能为空' };
  if (!PP.isAbsolute(s)) return { error: '必须是绝对路径（以 / 开头）' };
  if (s.split('/').some((seg) => seg === '..')) return { error: '路径不能包含 ..' };
  let norm = PP.normalize(s);
  while (norm.length > 1 && norm.endsWith('/')) norm = norm.slice(0, -1);
  if (!norm || norm === '/') return { error: '不能直接用根目录' };
  for (const bad of BAD_PREFIX) {
    if (norm === bad || norm.startsWith(bad + '/')) return { error: '系统目录不能作为项目：' + bad };
  }
  return { path: norm };
}

export function createProject({ name, path: rawPath, create = true } = {}) {
  const chk = checkProjectPath(rawPath);
  if (chk.error) return { error: chk.error };
  const norm = chk.path;
  const all = readAll();
  if (all.some((p) => p.path === norm)) return { error: '这个目录已经是项目了' };
  if (create) {
    try { fs.mkdirSync(norm, { recursive: true }); }
    catch (e) { return { error: '创建目录失败：' + String((e && e.message) || e) }; }
  }
  if (!fs.existsSync(norm)) return { error: '目录不存在' };
  const p = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || '').trim() || PP.basename(norm),
    path: norm,
    created: Date.now() / 1000,
  };
  all.push(p);
  writeAll(all);
  log('project_create', { id: p.id, path: p.path });
  return { project: p };
}

export function updateProject(id, { name, path: rawPath, create = true } = {}) {
  const all = readAll();
  const p = all.find((x) => x.id === String(id || ''));
  if (!p) return { error: '项目不存在' };
  if (rawPath !== undefined && rawPath !== null && String(rawPath).trim()) {
    const chk = checkProjectPath(rawPath);
    if (chk.error) return { error: chk.error };
    if (all.some((x) => x.id !== p.id && x.path === chk.path)) return { error: '这个目录已经被别的项目占用' };
    if (create) {
      try { fs.mkdirSync(chk.path, { recursive: true }); }
      catch (e) { return { error: '创建目录失败：' + String((e && e.message) || e) }; }
    }
    if (!fs.existsSync(chk.path)) return { error: '目录不存在' };
    p.path = chk.path;
  }
  if (name !== undefined && name !== null && String(name).trim()) p.name = String(name).trim();
  writeAll(all);
  log('project_update', { id: p.id });
  return { project: p };
}

export function deleteProject(id) {
  const all = readAll();
  const i = all.findIndex((x) => x.id === String(id || ''));
  if (i < 0) return { error: '项目不存在' };
  const [p] = all.splice(i, 1);
  writeAll(all);
  log('project_delete', { id: p.id });
  return { project: p };
}
