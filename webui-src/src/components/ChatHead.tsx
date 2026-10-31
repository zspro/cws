// ChatHead.tsx —— 单排顶栏：汉堡 / 品牌 / 标题 / 停止·齿轮·删除 / 新建。
// 卡西管理台视图时标题固定为"卡西"；会话视图同旧（设置卡收在齿轮里）。
import { useEffect, useState } from "react";
import { AGENT_OPTIONS, PERM_OPTIONS, store, useStore } from "../store";
import { IconBridge, IconGear, IconMenu, IconPlus, IconStop, IconTerminal, IconTrash, IconWatch } from "../icons";

export default function ChatHead({ onNav }: { onNav: () => void }) {
  const st = useStore();
  const inKx = st.view === "kx";
  const s = st.current ? st.sessions.get(st.current) : null;
  const info = s?.info;
  const [model, setModel] = useState("");
  const [setOpen, setSetOpen] = useState(false);
  const cb = info?.backend === "codebuddy" || info?.backend === "codebuddy-tui";
  const codebuddyModels = cb ? (st.backends?.models?.codebuddy || []) : [];

  useEffect(() => { setModel(info?.model || ""); }, [st.current, info?.model]);
  useEffect(() => { if (inKx) setSetOpen(false); }, [inKx]);

  const meta = info
    ? (info.model || "默认模型")
      + (info.queued ? ` · 排队 #${info.queue_position ?? "…"}` : info.compacting ? " · 压缩中" : info.turn_active ? " · 运行中" : "")
    : "";

  return (
    <>
      <div className="topbar">
        <button className="hamburger" onClick={onNav}><IconMenu size={17} /></button>
        <div className="brand">
          <span className="brand-mark"><IconBridge size={17} /></span>
          {!info && !inKx && <span className="brand-word">cws</span>}
          <span className={"dot" + (st.connected ? " on" : "")} title={st.connected ? "已连接" : "重连中…"} />
        </div>
        {inKx ? (
          <div className="tb-title" title="卡西 · 桥的自动管理助手">
            <span className="ch-remark kx">卡西</span>
            <span className="tb-text">桥管理助手 · 会话 / 渠道 / 更新</span>
          </div>
        ) : info ? (
          <>
            <div className="tb-title" title={meta || undefined}>
              {info.remark ? <span className="ch-remark">{"#" + info.remark}</span> : null}
              <span className="tb-text">{info.title || "会话 " + info.session_id.slice(0, 12)}</span>
            </div>
            <div className="tb-sess">
              {info.turn_active && (
                <button className="stop-btn" onClick={() => store.stop()}>
                  <IconStop size={13} /> 停止
                </button>
              )}
              {(() => {
                // 只列模型：渠道由服务端按 model 反查（协议不兼容的渠道服务端已经滤掉）
                const seen = new Set<string>();
                const opts: { model: string; label?: string }[] = [];
                for (const m of (st.models || [])) {
                  if (!m.model || seen.has(m.model)) continue;
                  seen.add(m.model);
                  opts.push({ model: m.model, label: m.label !== m.channel ? m.label : undefined });
                }
                // 老服务端没有 models.list：退回渠道里配的模型，别让下拉空掉
                for (const c of store.channelsForBackend(info.backend)) {
                  const m = c.model || "";
                  if (!m || seen.has(m)) continue;
                  seen.add(m);
                  opts.push({ model: m, label: c.label });
                }
                for (const m of (((st.backends?.models as Record<string, string[]> | undefined)?.[info.backend]) || [])) {
                  if (!m || seen.has(m)) continue;
                  seen.add(m);
                  opts.push({ model: m });
                }
                if (info.model && !seen.has(info.model)) opts.push({ model: info.model });
                if (!opts.length) return null;
                return (
                  <select
                    className="model-chip"
                    title="当前会话的模型（只影响这个会话）"
                    value={info.model || ""}
                    onChange={(e) => store.applyModel(info.session_id, "", e.target.value)}
                  >
                    <option value="">默认模型</option>
                    {opts.map((o) => (
                      <option key={o.model} value={o.model}>{o.label ? o.model + " · " + o.label : o.model}</option>
                    ))}
                  </select>
                );
              })()}
              {(info.backend === "codebuddy" || info.backend === "codebuddy-tui") && (
                <button
                  className={"ghost ch-icon" + (info.backend === "codebuddy-tui" ? " on" : "")}
                  title={info.backend === "codebuddy-tui"
                    ? "当前是终端模式 · 点一下切回对话视图"
                    : "切到终端模式 · 问卡 / 权限框 / 斜杠命令都在终端里"}
                  onClick={() => store.switchBackend(
                    info.session_id,
                    info.backend === "codebuddy-tui" ? "codebuddy" : "codebuddy-tui",
                  )}
                >
                  <IconTerminal size={15} />
                </button>
              )}
              <button
                className={"ghost ch-icon" + (setOpen ? " on" : "")}
                title={"会话设置 · " + meta}
                onClick={() => setSetOpen((v) => !v)}
              >
                <IconGear size={15} />
              </button>
              <button
                className="ghost ch-icon"
                title="删除会话"
                onClick={() => {
                  if (confirm("删除会话 " + info.session_id + "？（服务端记录清除）")) {
                    store.dropSession(info.session_id);
                  }
                }}
              >
                <IconTrash size={15} />
              </button>
            </div>
          </>
        ) : null}
        <div className="actions">
          {inKx ? (
            <button className="ghost" title="返回会话聊天" onClick={() => store.setView("chat")}><IconWatch size={14} /> 回会话</button>
          ) : null}
          <button className="ghost" onClick={() => store.setModal("new")}><IconPlus size={14} /> 新建</button>
        </div>
      </div>
      {setOpen && s && info && !inKx ? (
        <div className="session-set">
          <div className="ch-meta set-meta">{meta}</div>
          <div className="set-grid">
            <div className="set-field">
              <span className="set-label">权限模式</span>
              <select
                className="ctrl"
                title="权限等级"
                value={info.permission_mode}
                onChange={(e) => store.setPermission(info.session_id, e.target.value)}
              >
                {(PERM_OPTIONS[info.backend] || PERM_OPTIONS.claude).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {cb && (
              <div className="set-field">
                <span className="set-label">Agent 模式</span>
                <select
                  className="ctrl"
                  title="Agent 模式"
                  value={info.agent_mode || "ptc"}
                  onChange={(e) => store.applyAgent(info.session_id, e.target.value)}
                >
                  {AGENT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            )}
            <div className="set-field model">
              <span className="set-label">模型</span>
              <div className="set-row">
                <input
                  className="ctrl ch-model"
                  placeholder={cb && codebuddyModels.length ? "选择或输入模型" : "模型"}
                  title={model || "模型"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") store.applyModel(info.session_id, "", model); }}
                  list="codebuddy-models-head"
                />
                <button className="ghost" onClick={() => store.applyModel(info.session_id, "", model)}>应用</button>
                {cb && codebuddyModels.length > 0 && (
                  <datalist id="codebuddy-models-head">
                    {codebuddyModels.map((m) => <option key={m} value={m} />)}
                  </datalist>
                )}
              </div>
            </div>
          </div>
          <div className="set-hint">权限改动即时下发；选模型即生效：渠道由服务端按模型自动匹配，只影响当前会话。</div>
        </div>
      ) : null}
    </>
  );
}
