// 用法: node test/gate-maxparallel.test.mjs
// 1.4.0 起 gateMaxParallel 不再放大 required，只作【并行】契约的封顶：
//   required = min(声明路数, gateMaxParallel)。本文件测封顶 + 模板占位符口径。
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

// ── 1) 模板占位符口径 ─────────────────────────────────────────
const tplStart = src.indexOf("var LAW_TEXT_TEMPLATE = [");
const tplEnd = src.indexOf('].join("\\n");', tplStart);
const tpl = src.slice(tplStart, tplEnd);
const cnt = (s, sub) => s.split(sub).length - 1;
t("01", "模板内 @@ROUTES@@ 恰好 1 处", [cnt(tpl, "@@ROUTES@@")], [1]);
t("02", "模板内 @@MAXPAR@@ 恰好 2 处", [cnt(tpl, "@@MAXPAR@@")], [2]);
t("03", "模板内 @@MINDISP@@ 恰好 2 处", [cnt(tpl, "@@MINDISP@@")], [2]);
t("04", "模板内不再出现「封顶 N 路」式硬编码", [/(封顶|封顶路数)/.test(tpl)], [false]);

// ── 2) required 封顶行为（真实判定代码切片）────────────────────
const markLine = src.match(/var SINGLE_STEP_MARK = .*;/)[0];
const fns = src.slice(src.indexOf("function hasSingleStepMark(args) {"), src.indexOf("// 永远不拦（否则模型无法自救"));
const body = src.slice(src.indexOf("var dispatchedCount = 0;"), src.indexOf("// required === 0 = 明确不需要派活"));
const build = new Function(
  "DISPATCH_TOOLS", "TEAM_OPEN_TOOLS", "dispatchCounts", "sessionDispatchSeen", "gateMaxParallel",
  markLine + "\n" + fns + "\n" +
  "return function runGate(events, state, sid) {\n" +
  "  var next = function () { return 'next'; };\n  var lastTodoArgs = null;\n" +
  "  var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };\n" +
  "  var noTodoFallbackHits = 0;\n  var dbgSnapshot = null;\n" +
  body + "\n" +
  "  return { required: requiredDispatches, parallelTodos: parallelTodos, kind: gateKind };\n};"
);
const DISPATCH_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate", "send_message"]);
const TEAM_OPEN_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate"]);
const call = (name, args) => ({ type: "tool/call", data: { name, arguments: args === undefined ? "{}" : args } });
const todo = (items) => call("todo_write", JSON.stringify({ todos: items }));
const T = (c) => ({ content: c });
const parallel = (k) => Array.from({ length: k }, (_, i) => T("【并行】块" + (i + 1)));
const runWith = (cap, events) => build(DISPATCH_TOOLS, TEAM_OPEN_TOOLS, new Map(), new Map(), cap)(events, { turn: 1 }, "m");

let r;
r = runWith(6, [todo(parallel(10))]);
t("05", "gateMaxParallel=6 + 标 10 路 → required 6（封顶）", [r.required, r.parallelTodos, r.kind], [6, 10, "parallel-contract"]);

r = runWith(10, [todo(parallel(10))]);
t("06", "gateMaxParallel=10 + 标 10 路 → required 10", [r.required], [10]);

r = runWith(2, [todo(parallel(5))]);
t("07", "gateMaxParallel=2 + 标 5 路 → required 2", [r.required], [2]);

r = runWith(16, [todo(parallel(3))]);
t("08", "gateMaxParallel=16 + 标 3 路 → required 3（不放大）", [r.required], [3]);

r = runWith(6, [todo([T("【不可拆·单步】一行")])]);
t("09", "单步标记时 cap 不参与 → required 0", [r.required, r.kind], [0, "single-step"]);

console.log(`\n结果：${n - fail} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
