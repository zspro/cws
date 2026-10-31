/** ToolDetail.tsx —— 工具调用详情渲染：按工具语义把 detail 变成
 *  「终端命令 + 输出」「代码高亮」「编辑 diff」，而不是一大坨 JSON。
 *  detail 来自服务端 tool_activity（util.detailOf）：Bash 是命令行字符串、
 *  REPL/Write 是代码字符串、其余是 input 的 JSON。 */
import type { ReactNode } from "react";

type Lang = "js" | "sh" | "text";

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|import|from|export|class|new|await|async|try|catch|throw|typeof|interface|type|extends|this|true|false|null|undefined|def|echo|cd|mkdir|rm|npm|git|node)\b)/g;

/** 极简高亮：注释 / 字符串 / 数字 / 关键字四类，够读代码就行 */
function highlight(code: string, lang: Lang): ReactNode[] {
  if (lang === "text") return [code];
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? "tok-cm" : m[2] ? "tok-str" : m[3] ? "tok-num" : "tok-kw";
    out.push(<span key={out.length} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function tryJson(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function asStr(v: unknown): string { return typeof v === "string" ? v : ""; }

/** 详情摘要（折叠状态也要显示，如 +12 −3） */
export function detailSummary(name: string, detail?: string): string {
  if (!detail) return "";
  const o = tryJson(detail);
  const n = name.toLowerCase();
  if (o && (n.includes("edit") || o.old_string !== undefined || o.new_string !== undefined)) {
    const minus = asStr(o.old_string).split("\n").filter((x) => x !== "").length;
    const plus = asStr(o.new_string).split("\n").filter((x) => x !== "").length;
    return "+" + plus + " −" + minus;
  }
  if (o && n.includes("write") && asStr(o.content)) {
    return asStr(o.content).split("\n").length + " 行";
  }
  return "";
}

function DiffView({ code, sign }: { code: string; sign: "-" | "+" }) {
  return (
    <div className="td-diff-line">
      {code.split("\n").map((ln, i) => (
        <div key={i} className={sign === "-" ? "td-del" : "td-add"}>
          <span className="td-sign">{sign}</span>
          <span className="td-code">{ln || " "}</span>
        </div>
      ))}
    </div>
  );
}

export default function ToolDetail({ name, detail }: { name: string; detail: string }) {
  const n = name.toLowerCase();
  const o = tryJson(detail);

  // 编辑类：old_string / new_string → 红绿 diff
  if (o && (o.old_string !== undefined || o.new_string !== undefined)) {
    const file = asStr(o.file_path) || asStr(o.path) || "";
    return (
      <div className="td-wrap">
        {file ? <div className="td-head">{file}</div> : null}
        <DiffView code={asStr(o.old_string)} sign="-" />
        <DiffView code={asStr(o.new_string)} sign="+" />
      </div>
    );
  }

  // 写文件：内容高亮
  if (o && n.includes("write") && asStr(o.content)) {
    const file = asStr(o.file_path) || asStr(o.path) || "";
    const content = asStr(o.content);
    return (
      <div className="td-wrap">
        <div className="td-head">{file || "写入"} · {content.split("\n").length} 行</div>
        <pre className="td-pre">{highlight(content, "js")}</pre>
      </div>
    );
  }

  // Bash / Shell：终端样式
  if (n.includes("bash") || n.includes("shell") || (o && typeof o.command === "string")) {
    const cmd = o ? asStr(o.command) : detail;
    return (
      <div className="td-term">
        <span className="td-prompt">$</span>
        <span className="td-cmd">{highlight(cmd, "sh")}</span>
      </div>
    );
  }

  // REPL / 代码：直接当代码高亮
  if (n.includes("repl") || n.includes("script")) {
    return <pre className="td-pre">{highlight(detail, "js")}</pre>;
  }

  // 兜底：JSON 也做高亮，其余原样
  return <pre className="td-pre">{highlight(detail, o ? "js" : "text")}</pre>;
}
