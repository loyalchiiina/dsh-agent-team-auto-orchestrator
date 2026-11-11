// 用法: node test/gate-140-features.test.mjs
// 1.4.0 新特性专项：A2 只读 pwsh（含三条绕过）、A4 重启前禁派（对象 args + 可达性）、
// bad-name warn、subagent-reuse-hint warn、计数集合分离。全部从真实 lib/index.js 切片，不改写逻辑。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(SRC, "utf8");

let n = 0, fail = 0;
const t = (id, desc, got, want) => {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`PASS ${id}  ${desc}`);
  else { fail++; console.log(`FAIL ${id}  ${desc}\n      got=${g} want=${w}`); }
};

// ── 抽 helpers：parseToolArgs / pwshCommandText / isReadonlyPwsh / badNameOf 及其常量 ──
const helperStart = src.indexOf("var PW_DENY_PATTERN = ");
const helperEnd = src.indexOf("// 1.3.2（F4/F5）：最近一次 list_agents 的花名册缓存。");
if (helperStart < 0 || helperEnd <= helperStart) { console.log("FAIL 抽 helper 失败"); process.exit(1); }
const helperSrc = src.slice(helperStart, helperEnd);
const H = new Function(helperSrc + "\nreturn { isReadonlyPwsh, badNameOf, RESTART_WAIT_RE, PW_DENY_PATTERN, PW_READONLY_PATTERN };")();

const ro = (cmd) => H.isReadonlyPwsh({ command: cmd });
// A2 真只读放行
t("01", "A2 真只读（Get-ChildItem .）=放行", [ro("Get-ChildItem .")], [true]);
t("02", "A2 真只读（git status）=放行", [ro("git status")], [true]);
t("03", "A2 真只读（node --check lib/index.js）=放行", [ro("node --check lib/index.js")], [true]);
// A2 三条绕过必须不豁免
t("04", "A2 绕过：单管道 | → 不豁免", [ro("Get-ChildItem . | ForEach-Object { [IO.File]::WriteAllText('a','b') }")], [false]);
t("05", "A2 绕过：重定向 > → 不豁免", [ro("Get-Content a > b")], [false]);
t("06", "A2 绕过：子表达式 $( → 不豁免", [ro("Get-Content $(Get-Item a)")], [false]);
// 其它负向
t("07", "A2 写盘负向词 Set-Content → 不豁免", [ro("Set-Content a b")], [false]);
t("08", "A2 出现 cwd 字段 → 不豁免", [H.isReadonlyPwsh({ command: "Get-ChildItem", cwd: "C:/x" })], [false]);
t("09", "A2 只有 script 且含 -File → 不豁免", [H.isReadonlyPwsh({ script: "powershell -File a.ps1" })], [false]);
t("10", "A2 空命令 → 不豁免（fail-closed）", [H.isReadonlyPwsh({})], [false]);

// ── A4：对象 args 能被取到（JSON.stringify 路线）+ 正则覆盖 ──
const a4 = (todoObj, userText) => H.RESTART_WAIT_RE.test(JSON.stringify(todoObj) + "\n" + (userText || ""));
t("11", "A4 对象 args{todos:[『待重启』]} → 命中（证明对象不是空串）", [a4({ todos: [{ content: "改完待重启验证" }] })], [true]);
t("12", "A4 「等用户彻底退出」→ 命中", [a4({ todos: [{ content: "等用户彻底退出后再跑" }] })], [true]);
t("13", "A4 英文 after restart → 命中", [a4({ todos: [{ content: "re-run after restart" }] })], [true]);
t("14", "A4 普通 todo + 普通用户消息 → 不命中", [a4({ todos: [{ content: "改 README" }] }, "把文档改一下")], [false]);
// A4 可达性：代码里 A4 块必须出现在 isExempt 之前
const iA4 = src.indexOf('kind: "subagent-before-restart"');
const iExempt = src.indexOf("if (isExempt(toolName)) return next();");
t("15", "A4 代码位置在 isExempt 之前（可达性）", [iA4 > 0, iExempt > 0, iA4 < iExempt], [true, true, true]);
// A4 双源：命中的是 sessionDomains 里的用户消息也能触发
t("16", "A4 用户消息源命中（todo 普通、用户说『我先重启一下』）", [a4({ todos: [{ content: "改 README" }] }, "我先重启一下")], [true]);

// ── 命名 warn ──
t("17", "bad-name：subagent description 无序号前缀 → 返回名字", [H.badNameOf("subagent", { description: "查文档" })], ["查文档"]);
t("18", "bad-name：带 01_ 前缀 → 不报", [H.badNameOf("subagent", { description: "01_doc-query_subagent" })], [""]);
t("19", "bad-name：spawn_teammate name 带 02- → 不报", [H.badNameOf("spawn_teammate", { name: "02-verifier" })], [""]);
t("20", "bad-name：spawn_teammate 中文名 → 报", [H.badNameOf("spawn_teammate", { name: "员工3号" })], ["员工3号"]);

// ── 计数分离 + 观测字段存在 ──
const disp = src.match(/var DISPATCH_TOOLS = new Set\(\[([^\]]*)\]\)/);
const open = src.match(/var TEAM_OPEN_TOOLS = new Set\(\[([^\]]*)\]\)/);
t("21", "DISPATCH_TOOLS 含 send_message", [!!disp && disp[1].indexOf("send_message") >= 0], [true]);
t("22", "TEAM_OPEN_TOOLS 不含 send_message", [!!open && open[1].indexOf("send_message") < 0], [true]);
for (const k of ["dispatchHistogram", "selfWorkTurns", "serialSuspect", "subagentHintHits", "readonlyPwshHits", "badNameHits", "subagentBeforeRestartHits"]) {
  t("23." + k, "status 观测字段存在: " + k, [src.indexOf(k + ":") >= 0 || src.indexOf("var " + k) >= 0], [true]);
}
t("24", "subagent-reuse-hint 留痕分支存在", [src.indexOf('kind: "subagent-reuse-hint"') >= 0], [true]);

console.log(`\n结果：${n - fail} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
