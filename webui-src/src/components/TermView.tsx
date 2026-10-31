// TermView.tsx —— codebuddy TUI 后端的浏览器终端。
// 桥端用 PTY 跑 `codebuddy`，把字节流原样镜像过来；键盘原样写回去。
// 为什么不做成聊天气泡：TUI 自己就是审批宿主（问卡 / 权限框 / 斜杠命令都在
// 终端里），任何"解析 TUI 输出再渲染成卡片"的做法都会立刻和 CLI 改版脱节。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onTerm, store, useStore } from "../store";

export default function TermView({ sid }: { sid: string }) {
  const st = useStore();
  const info = st.sessions.get(sid)?.info;
  const boxRef = useRef<HTMLDivElement>(null);
  // 真 CLI 首屏要 4s 左右（后台起进程 + 信任提示），先盖一层提示，别让用户看黑屏
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: "#12161c",
        foreground: "#d7dee8",
        cursor: "#40b894",
        selectionBackground: "#2c3a4a",
        black: "#1b1f26", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#d7dee8",
        brightBlack: "#5c6370", brightRed: "#ef6d7a", brightGreen: "#a9d67f",
        brightYellow: "#f0cd8a", brightBlue: "#7cc0f5", brightMagenta: "#d79be6",
        brightCyan: "#6fd3de", brightWhite: "#f2f5f9",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const fitNow = () => {
      try { fit.fit(); } catch { /* 容器还没布局好 */ }
    };
    fitNow();

    const off = onTerm(sid, (ev) => {
      if (ev.kind === "history") {
        term.reset();
        if (ev.data) { term.write(ev.data); setBooting(false); }
      } else if (ev.kind === "data") {
        if (ev.data) { term.write(ev.data); setBooting(false); }
      } else if (ev.kind === "reset") {
        term.reset();
        setBooting(true);
      } else if (ev.kind === "exit") {
        term.write("\r\n\x1b[2m[进程已退出" + (ev.code ? " code=" + ev.code : "") + "，继续输入会自动重启]\x1b[0m\r\n");
      }
    });

    const dataSub = term.onData((d) => store.termInput(sid, d));
    const resizeSub = term.onResize(({ cols, rows }) => store.termResize(sid, cols, rows));

    // 先告诉服务端尺寸再要快照：回放的字节按当前窗口宽度排版
    store.termAttach(sid, term.cols, term.rows);
    term.focus();

    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; fitNow(); });
    });
    ro.observe(el);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      off();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
    };
  }, [sid]);

  return (
    <div className="term-wrap">
      <div className="term-bar">
        <span className="term-tag">TUI</span>
        <span className="term-meta">
          {info?.agent_mode || "ptc"} · {info?.permission_mode || "default"}
          {info?.model ? " · " + info.model : ""}
          {info?.channel ? " · " + info.channel : ""}
        </span>
        <span className="term-hint">键盘直接操作终端 · Ctrl-C 中断当前轮</span>
      </div>
      <div className="term-box" ref={boxRef} />
      {booting && <div className="term-boot">终端启动中…</div>}
    </div>
  );
}
