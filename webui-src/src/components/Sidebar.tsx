// Sidebar.tsx —— 项目 → 会话两级侧栏（一个工作目录可挂多个会话）
import { BACKEND_LETTER, store, useStore } from "../store";
import type { Project, SessionState } from "../types";
import { IconGear, IconNote, IconStack, IconSync, IconTrash, IconWatch } from "../icons";

function sortedSessions(map: Map<string, SessionState>): SessionState[] {
  return Array.from(map.values()).sort((a, b) =>
    (b.info.last_msg_ts || b.info.created_at || 0) - (a.info.last_msg_ts || a.info.created_at || 0));
}

function SessRow({ s, cur, onNavigate }: { s: SessionState; cur: string | null; onNavigate?: () => void }) {
  const { info } = s;
  const letter = BACKEND_LETTER[info.backend] || "C";
  const title = info.remark || info.title || "会话 " + info.session_id.slice(0, 12);
  return (
    <div className={"sess-item" + (info.session_id === cur ? " active" : "")} onClick={() => { store.openChat(info.session_id); onNavigate?.(); }}>
      <div className="sess-top">
        <span className={"be-dot be-" + info.backend}>{letter}</span>
        <span className="sess-title">{info.remark ? <IconNote size={12} className="sess-note" /> : null}{title}</span>
        <span className="sess-badges">
          {info.queued ? <span className="badge queued">排队 #{info.queue_position ?? "…"}</span> : info.turn_active ? <span className="badge running">运行中</span> : null}
        </span>
        <span className="sess-ops" onClick={(e) => e.stopPropagation()}>
          <button title="备注" onClick={() => store.setModal({ kind: "remark", sid: info.session_id })}><IconNote size={14} /></button>
          <button title="删除会话" onClick={() => { if (confirm("删除会话 " + info.session_id + "？（服务端记录清除）")) store.dropSession(info.session_id); }}><IconTrash size={14} /></button>
        </span>
      </div>
      <div className="sess-sub">{info.model || info.channel || info.backend}{info.closed ? " · 已关闭" : info.lazy ? " · 待唤醒" : ""}</div>
    </div>
  );
}

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const st = useStore();
  const items = sortedSessions(st.sessions);
  const projects: Project[] = st.projects || [];
  const ids = new Set(projects.map((p) => p.id));
  const groups = projects.map((p) => ({ project: p, list: items.filter((s) => s.info.project === p.id) }));
  const loose = items.filter((s) => !s.info.project || !ids.has(s.info.project));
  return (
    <div className="sidebar">
      <div className="side-pad">
        <button className={"kx-pin" + (st.view === "kx" ? " active" : "")} onClick={() => { store.setView("kx"); onNavigate?.(); }} title="卡西">
          <span className="kx-pin-ico"><IconWatch size={16} /></span>
          <span className="kx-pin-text"><span className="kx-pin-title">卡西</span><span className="kx-pin-sub">桥管理助手 · 自动运维</span></span>
        </button>
        <button className="new-btn full" onClick={() => store.setModal({ kind: "project" })}>＋ 新建项目</button>
      </div>
      <div className="sess-list">
        <div className="proj-title">项目</div>
        {groups.map(({ project, list }) => (
          <div className="proj-group" key={project.id}>
            <div className="proj-head">
              <span className="proj-ico">▾</span>
              <span className="proj-name" title={project.path}>{project.name}</span>
              <span className="proj-count">{list.length || ""}</span>
              <span className="sess-ops" onClick={(e) => e.stopPropagation()}>
                <button title="项目设置" onClick={() => store.setModal({ kind: "project", project })}>···</button>
              </span>
            </div>
            <div className="sess-item new-task" onClick={() => { store.setNewProject(project.id); store.setModal("new"); onNavigate?.(); }}>
              <div className="sess-top"><span className="sess-title">新建任务</span></div>
            </div>
            {list.map((s) => <SessRow key={s.info.session_id} s={s} cur={st.current} onNavigate={onNavigate} />)}
          </div>
        ))}
        {!groups.length && <div className="sess-empty">还没有项目 · 点上面「＋ 新建项目」</div>}
        {loose.length > 0 && (
          <div className="proj-group">
            <div className="proj-head"><span className="proj-ico">·</span><span className="proj-name">未分类</span></div>
            {loose.map((s) => <SessRow key={s.info.session_id} s={s} cur={st.current} onNavigate={onNavigate} />)}
          </div>
        )}
      </div>
      <div className="side-bottom">
        <button onClick={() => { store.send("backends.list"); store.setModal("backends"); }}><IconStack size={15} /> 后端与网关</button>
        <button onClick={() => { store.send("channels.list"); store.setModal("channels"); }}><IconGear size={15} /> 上游渠道与模型</button>
        <button onClick={() => { store.checkUpdate(); store.setModal("update"); }}><IconSync size={15} /> 系统更新
          {st.update.behind > 0 ? <span className="side-dot" title={"落后 " + st.update.behind + " 个提交"} /> : null}
        </button>
      </div>
    </div>
  );
}
