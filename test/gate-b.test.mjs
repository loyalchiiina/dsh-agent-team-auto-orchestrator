// 用法: node test/gate-b.test.mjs
// 测：1.4.0「标记驱动」判定链 —— 门只在明确标了【并行】时生效。
// 判定代码**从真实 lib/index.js 抽出**，不改写逻辑。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(SRC, "utf8");

const markLine = src.match(/var SINGLE_STEP_MARK = .*;/)[0];
const fnStart = src.indexOf("function hasSingleStepMark(args) {");
const fnEnd = src.indexOf("// 永远不拦（否则模型无法自救");
if (fnStart < 0 || fnEnd <= fnStart) { console.log("FAIL 抽取 fns 失败"); process.exit(1); }
const fns = src.slice(fnStart, fnEnd);

const loopStart = src.indexOf("var dispatchedCount = 0;");
const loopEnd = src.indexOf("// required === 0 = 明确不需要派活");
if (loopStart < 0 || loopEnd <= loopStart) {
  console.log("FAIL 抽取失败 loopStart=" + loopStart + " loopEnd=" + loopEnd);
  process.exit(1);
}
const body = src.slice(loopStart, loopEnd);

const build = new Function(
  "DISPATCH_TOOLS", "TEAM_OPEN_TOOLS", "dispatchCounts", "sessionDispatchSeen", "gateMaxParallel",
  markLine + "\n" + fns + "\n" +
  "return function runGate(events, state, sid) {\n" +
  "  var next = function () { return 'next'; };\n" +
  "  var lastTodoArgs = null;\n" +
  "  var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };\n" +
  "  var noTodoFallbackHits = 0;\n" +
  "  var dbgSnapshot = null;\n" +
  body + "\n" +
  "  return { dispatched: dispatchedCount, turnMax: turnMaxStepDispatch, required: requiredDispatches, parallelTodos: parallelTodos, todoTotal: todoTotal, kind: gateKind, singleStep: singleStepMarked, pass: (requiredDispatches === 0 || turnMaxStepDispatch >= requiredDispatches) };\n" +
  "};"
);

const DISPATCH_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate", "send_message"]);
const TEAM_OPEN_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate"]);
let n = 0, fail = 0;
const t = (id, desc, got, want) => {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`PASS ${id}  ${desc}`);
  else { fail++; console.log(`FAIL ${id}  ${desc}\n      got=${g} want=${w}`); }
};
const runGate = (events, state, sid) => build(DISPATCH_TOOLS, TEAM_OPEN_TOOLS, new Map(), new Map(), 6)(events, state || {}, sid || "s1");

const call = (name, args, step) => ({ type: "tool/call", data: Object.assign({ name, arguments: args === undefined ? "{}" : args }, step === undefined ? {} : { step }) });
const todo = (items) => call("todo_write", JSON.stringify({ todos: items }));
const T = (content, status) => (status ? { content, status } : { content });
const parallel = (k, prefix) => Array.from({ length: k }, (_, i) => T((prefix || "【并行】块") + (i + 1)));
const stepStart = (s) => ({ type: "step/start", data: { turn: 1, step: s } });
const stepCall = (name, s, args) => call(name, args, s);
const turnStart = () => ({ type: "turn/start", data: { turn: 1 } });

let r;
// 1–4：不标【并行】= 没有任何派活要求
r = runGate([], { turn: 1 }, "b1");
t("01", "无 todo → required 0 / no-parallel-mark / 放行", [r.required, r.kind, r.pass], [0, "no-parallel-mark", true]);

r = runGate([todo([T("看一行配置"), T("回一句话")])], { turn: 1 }, "b2");
t("02", "todo 2 条无【并行】→ required 0 / 放行", [r.required, r.kind, r.pass], [0, "no-parallel-mark", true]);

r = runGate([todo([T("a"), T("b"), T("c"), T("d"), T("e")]), stepStart(1), stepCall("pwsh", 1)], { turn: 1 }, "b3");
t("03", "todo 5 条无【并行】+ 0 路 → 仍放行（不再逼派活）", [r.required, r.kind, r.pass], [0, "no-parallel-mark", true]);

r = runGate([todo([T("a")]), stepStart(1), stepCall("pwsh", 1)], { turn: 1 }, "b4");
t("04", "todo 1 条无【并行】+ 动手 → 放行", [r.required, r.pass], [0, true]);

// 5–8：标了【并行】= 必须在一步里真发满
r = runGate([todo(parallel(2)), stepStart(1)], { turn: 1 }, "b5");
t("05", "标 【并行】×2、0 路 → required 2 / parallel-contract / 拒", [r.required, r.kind, r.pass], [2, "parallel-contract", false]);

r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1), stepCall("subagent_fork", 1)], { turn: 1 }, "b6");
t("06", "标 【并行】×2、同一步 2 路 → 放行", [r.required, r.turnMax, r.pass], [2, 2, true]);

r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1)], { turn: 1 }, "b7");
t("07", "标 【并行】×2、只 1 路 → turnMax<required → 拒", [r.required, r.turnMax, r.pass], [2, 1, false]);

r = runGate([todo([T("【并行×3】三块")]), stepStart(1), stepCall("subagent", 1), stepCall("subagent", 1), stepCall("subagent_fork", 1)], { turn: 1 }, "b8");
t("08", "单条 【并行×3】声明 3 路 → required 3 / 3 路放行", [r.required, r.parallelTodos, r.pass], [3, 3, true]);

// 9–12：标记豁免
r = runGate([todo([T("【不可拆·单步】改一行")]), stepStart(1), stepCall("pwsh", 1)], { turn: 1 }, "b9");
t("09", "首条 【不可拆·单步】→ required 0 / single-step", [r.required, r.kind, r.pass], [0, "single-step", true]);

r = runGate([todo([T("【独立完成】我自己做")]), stepStart(1), stepCall("pwsh", 1)], { turn: 1 }, "b10");
t("10", "首条 【独立完成】→ required 0 / single-step", [r.required, r.kind, r.pass], [0, "single-step", true]);

r = runGate([todo([T("【独立完成】但我又标了并行"), T("【并行】块")]), stepStart(1), stepCall("subagent", 1)], { turn: 1 }, "b11");
t("11", "首条【独立完成】优先 → required 0（单步优先于并行契约）", [r.required, r.kind, r.pass], [0, "single-step", true]);

r = runGate([todo([T("【并行】已完成", "completed"), T("普通")]), stepStart(1)], { turn: 1 }, "b12");
t("12", "completed 的【并行】不计 → required 0 / no-parallel-mark", [r.required, r.kind, r.pass], [0, "no-parallel-mark", true]);

// 13–16：cap 与窗口
r = runGate([todo(parallel(8)), stepStart(1)], { turn: 1 }, "b13");
t("13", "标 8 路但 gateMaxParallel=6 → required 封顶 6", [r.required, r.parallelTodos], [6, 8]);

r = runGate([todo(parallel(3)), stepStart(1), stepCall("subagent", 1), stepCall("subagent", 1)], { turn: 1 }, "b14");
t("14", "标 3 路、实派 2 路 → 拒", [r.required, r.turnMax, r.pass], [3, 2, false]);

r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1), stepStart(2), stepCall("subagent", 1), stepStart(3)], { turn: 1 }, "b15");
t("15", "标 2 路、分步 1+1（每步峰值 1）→ 拒（分步凑数不算）", [r.required, r.turnMax, r.pass], [2, 1, false]);

r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1), stepCall("subagent", 1), stepCall("pwsh", 1)], { turn: 1 }, "b16");
t("16", "标 2 路、同一步 2 路后同一步动手 → 放行", [r.required, r.turnMax, r.pass], [2, 2, true]);

console.log(`\n结果：${n - fail} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
