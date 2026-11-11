// 用法: node test/gate-b.test.mjs
// 测：1.1.1（用户选 B）四档判定的 21 个行为用例 —— 判定代码**从真实 lib/index.js 抽出**，不改写逻辑。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// 相对仓库根推导，任何 clone 都能跑（不写死任何本机绝对路径）
const SRC = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(SRC, "utf8");

const markLine = src.match(/var SINGLE_STEP_MARK = .*;/)[0];
const fnStart = src.indexOf("function hasSingleStepMark(args) {");
const fnEnd = src.indexOf("// 永远不拦（否则模型无法自救");
const fns = src.slice(fnStart, fnEnd); // hasSingleStepMark + countParallelTodos 两段真实代码

const loopStart = src.indexOf("var dispatchedCount = 0;");
const loopEnd = src.indexOf("// required === 0 = 明确不需要派活");
if (loopStart < 0 || loopEnd < 0 || loopEnd <= loopStart) {
  console.log("FAIL 抽取失败 loopStart=" + loopStart + " loopEnd=" + loopEnd);
  process.exit(1);
}
const body = src.slice(loopStart, loopEnd);

const build = new Function(
  "DISPATCH_TOOLS", "TEAM_OPEN_TOOLS", "dispatchCounts", "sessionDispatchSeen",
  markLine + "\n" + fns + "\n" +
  "return function runGate(events, minDispatches, state, sid) {\n" +
  "  var next = function () { return 'next'; };\n" +
  "  var lastTodoArgs = null;\n" +
  "  var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };\n" +
  "  var noTodoFallbackHits = 0;\n" +
  body + "\n" +
  "  return { dispatched: dispatchedCount, required: requiredDispatches, parallelTodos: parallelTodos, todoTotal: todoTotal, kind: gateKind, singleStep: singleStepMarked, pass: (requiredDispatches === 0 || turnMaxStepDispatch >= requiredDispatches), turnMax: turnMaxStepDispatch };\n" +
  "};"
);

const DISPATCH_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate", "send_message"]);
// 1.3.3（#3）：F2 的置位集合独立于派活路数集合（不含 send_message）
const TEAM_OPEN_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate"]);
const dispatchCounts = new Map();
const runGate = build(DISPATCH_TOOLS, TEAM_OPEN_TOOLS, dispatchCounts, new Map());

const call = (name, args) => ({ type: "tool/call", data: { name, arguments: args === undefined ? "{}" : args } });
const todo = (items) => call("todo_write", JSON.stringify({ todos: items }));
const T = (content, status) => (status ? { content, status } : { content });
const parallel = (n, status) => Array.from({ length: n }, (_, i) => T("【并行】块" + (i + 1), status));
const serial = (n) => Array.from({ length: n }, (_, i) => T("步骤" + (i + 1)));
const sub = () => call("subagent");
const MIN = 1; // 1.1.1 默认 minDispatches

let pass = 0, fail = 0;
function t(no, desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + no + "  " + desc + "\n      got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
  ok ? pass++ : fail++;
}

// 1 无 todo → required 0 → 放行
let r = runGate([], MIN, { turn: 1 }, "t1");
t("01", "无 todo → 0 路（1.1.1 收紧：不再算小任务）", [r.required, r.kind, r.pass], [1, "no-todo-fallback", false]);

// 2 todo 2 条无并行 → 0 路放行
r = runGate([todo(serial(2))], MIN, { turn: 1 }, "t1");
t("02", "todo 2 条无「并行」→ 0 路", [r.todoTotal, r.parallelTodos, r.required, r.pass], [2, 0, 0, true]);

// 3 todo 5 条无并行 → 0 路拒（required = minDispatches = 1）
r = runGate([todo(serial(5))], MIN, { turn: 1 }, "t1");
t("03", "todo 5 条无「并行」→ 0 路", [r.todoTotal, r.required, r.kind, r.pass], [5, 1, "team-once", false]);

// 4 todo 5 条无并行 → 1 路放行
r = runGate([todo(serial(5)), sub()], MIN, { turn: 1 }, "t1");
t("04", "todo 5 条无「并行」→ 1 路", [r.dispatched, r.required, r.pass], [1, 1, true]);

// 5 todo 2 条标并行 → 1 路拒（治①：标了并行就是契约）
r = runGate([todo(parallel(2)), sub()], MIN, { turn: 1 }, "t1");
t("05", "todo 2 条标「并行」→ 1 路", [r.parallelTodos, r.required, r.kind, r.pass], [2, 2, "parallel-contract", false]);

// 6 todo 2 条标并行 → 2 路放行
r = runGate([todo(parallel(2)), sub(), call("subagent_fork")], MIN, { turn: 1 }, "t1");
t("06", "todo 2 条标「并行」→ 2 路", [r.dispatched, r.required, r.pass], [2, 2, true]);

// 7 todo 3 条标并行 → 2 路拒 / 3 路放行
r = runGate([todo(parallel(3)), sub(), call("subagent_fork")], MIN, { turn: 1 }, "t1");
const r7a = [r.parallelTodos, r.required, r.pass];
r = runGate([todo(parallel(3)), sub(), call("subagent_fork"), call("spawn_teammate")], MIN, { turn: 1 }, "t1");
const r7b = [r.dispatched, r.required, r.pass];
t("07", "todo 3 条标「并行」→ 2 路拒 / 3 路放行", [r7a, r7b], [[3, 3, false], [3, 3, true]]);

// 8 todo 8 条标并行 → required 封顶 6
r = runGate([todo(parallel(8)), sub()], MIN, { turn: 1 }, "t1");
t("08", "todo 8 条标「并行」→ 封顶 6", [r.parallelTodos, r.required], [8, 6]);

// 9 第一条【不可拆·单步】 + 0 路 → 放行（required 0）
const MARK = JSON.stringify({ todos: [T("【不可拆·单步】改一行文案", "in_progress")] });
r = runGate([call("todo_write", MARK)], MIN, { turn: 1 }, "t1");
t("09", "单步标记 + 0 路", [r.singleStep, r.required, r.kind, r.pass], [true, 0, "single-step", true]);

// 10 已完成（completed）的并行条目不计入 count
r = runGate([todo([...parallel(3, "completed"), T("剩余一件事")])], MIN, { turn: 1 }, "t1");
t("10", "completed 并行条目不计入", [r.parallelTodos, r.todoTotal, r.required, r.pass], [0, 1, 0, true]);

// 11 单步标记优先级最高（即便同时标了并行）
r = runGate([call("todo_write", JSON.stringify({ todos: [{ content: "【不可拆·单步】一次改完", status: "in_progress" }, ...parallel(3)] }))], MIN, { turn: 1 }, "t1");
t("11", "单步标记 > 并行契约（优先级 1）", [r.singleStep, r.parallelTodos, r.required, r.pass], [true, 3, 0, true]);

// 12 并行条目写在第二条（第一条无标记）仍算并行契约
r = runGate([todo([T("先看代码"), T("【并行】改 A"), T("【并行】改 B")]), sub()], MIN, { turn: 1 }, "t1");
t("12", "并行条目不在第一条也生效", [r.parallelTodos, r.required, r.dispatched, r.pass], [2, 2, 1, false]);

// 13 turn/start 之后 todo 契约被清空（不沿用上一轮）
r = runGate([todo(parallel(3)), { type: "turn/start" }, sub()], MIN, { turn: 2 }, "t1");
t("13", "turn/start 重置 todo 契约与计数（重置后无 todo → 门槛 1 路）", [r.todoTotal, r.dispatched, r.required, r.pass], [0, 1, 1, true]);

// 14 gateMinDispatches=2 可退回 1.1.0 行为（中等任务要两路）
r = runGate([todo(serial(5)), sub()], 2, { turn: 1 }, "t1");
t("14", "minDispatches=2 回滚：5 条串行 + 1 路", [r.dispatched, r.required, r.pass], [1, 2, false]);

// 15 非法 JSON / 无 todos / 空数组 一律 (0,0) 不抛
const bad = [];
for (const a of ["not-json", JSON.stringify({ tasks: [{ content: "并行" }] }), JSON.stringify({ todos: [] })]) {
  const rr = runGate([call("todo_write", a)], MIN, { turn: 1 }, "t1");
  bad.push([rr.todoTotal, rr.parallelTodos, rr.required, rr.pass]);
}
t("15", "非法/缺 todos/空数组 → (0,0) 不抛（1.1.1：回落 1 路 → 拒）", bad, [[0, 0, 1, false], [0, 0, 1, false], [0, 0, 1, false]]);

// 19 从未调 todo_write → 0 路 → 拒（required = 1，kind = no-todo-fallback）
r = runGate([], MIN, { turn: 1 }, "t1");
t("19", "无 todo + 0 路 → 拒", [r.todoTotal, r.required, r.kind, r.pass], [0, 1, "no-todo-fallback", false]);

// 20 从未调 todo_write → 1 路 → 放行
r = runGate([sub()], MIN, { turn: 1 }, "t1");
t("20", "无 todo + 1 路 → 放行", [r.todoTotal, r.dispatched, r.required, r.kind, r.pass], [0, 1, 1, "no-todo-fallback", true]);

// 21 写 1 条 todo（真声明小任务）→ 0 路仍放行（小任务自由未被收紧）
r = runGate([todo(serial(1))], MIN, { turn: 1 }, "t1");
t("21", "todo 1 条 + 0 路 → 放行（小任务自由保留）", [r.todoTotal, r.required, r.kind, r.pass], [1, 0, "small-task", true]);

// 16 dispatchCounts 观测字段完整
r = runGate([todo(parallel(2)), sub()], MIN, { turn: "7" }, "obs");
t("16", "dispatchCounts 记录 kind/parallelTodos/todoTotal", dispatchCounts.get("obs"), {
  turn: "7", dispatched: 1, required: 2, singleStep: false, parallelTodos: 2, todoTotal: 2, kind: "parallel-contract"
});

// 17 注入文本含「十、预设路由」+ 旧矛盾句已消失
// 沿革：1.2.0 二次修订时该节为「十一、预设路由」；按优先级重排为 11 节后编号减一，
// 预设路由变成「十、预设路由」，故锚点同步更新（仍验证「预设路由节在注入段内」这一意图）。
const lawStart = src.indexOf("var LAW_TEXT_TEMPLATE = [");
const lawEnd = src.indexOf("].join(\"\\n\");", lawStart);
const law = src.slice(lawStart, lawEnd);
t("17", "注入段含第十一条 / 不含「spawn 要克制」", [
  law.includes("十、预设路由"),
  law.includes("spawn 要克制")
], [true, false]);

// 18 拒绝文案分支存在
t("18", "拒绝文案含【并行契约违约】段", [src.includes("【并行契约违约】")], [true]);

// ── 22-28（1.2.0 治「派一路等一路」）：派活计数改成按 step 分窗 ──
// 新增辅助：带 step 的事件。既有 01-21 用例的事件不带 step → 走「两个信号都没有 → 整轮累加」的兜底，
// 期望值一字不改（这正是本次改动的兼容保证）。
const stepStart = (n) => ({ type: "step/start", data: { turn: 1, step: n } });
const stepCall = (name, n, args) => ({ type: "tool/call", data: { name, arguments: args === undefined ? "{}" : args, step: n } });

// 22 同一步内 2 路 → 过门（并行契约 2）
r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1), stepCall("subagent_fork", 1)], MIN, { turn: 1 }, "t1");
t("22", "同一步内 2 路 → 放行", [r.dispatched, r.required, r.kind, r.pass], [2, 2, "parallel-contract", true]);

// 23 上一 step 派过 1 路、本 step 动手 → 计数归零 → 拒（旧行为会放行，这正是「派一路等一路」）
r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1), stepStart(2)], MIN, { turn: 1 }, "t1");
t("23", "上一步派 1 路 + 本步动手 → 0 路 → 拒", [r.dispatched, r.required, r.pass], [0, 2, false]);

// 24 分步凑数不算：step1 派 1、step2 派 1 → 计数只看当前 step → 仍拒
r = runGate([todo(parallel(2)), stepStart(1), stepCall("subagent", 1), stepStart(2), stepCall("subagent", 2)], MIN, { turn: 1 }, "t1");
t("24", "分步凑数（1+1）不算 → 仍拒", [r.dispatched, r.required, r.pass], [1, 2, false]);

// 25 同一步内补齐 3 路 → 放行（同一步内追加是允许的，跨 step 才算串行）
r = runGate([todo(parallel(3)), stepStart(1), stepCall("subagent", 1), stepCall("subagent_fork", 1), stepCall("spawn_teammate", 1)], MIN, { turn: 1 }, "t1");
t("25", "同一步内补满 3 路 → 放行", [r.dispatched, r.required, r.pass], [3, 3, true]);

// 26 兜底信号：没有 step/start 事件，但 tool/call 自带 data.step → 仍能分窗
r = runGate([todo(parallel(2)), stepCall("subagent", 5), stepCall("subagent_fork", 6)], MIN, { turn: 1 }, "t1");
t("26", "无 step/start、靠 data.step 分窗 → 1 路拒", [r.dispatched, r.required, r.pass], [1, 2, false]);

// 27 step 边界不影响 turn 级契约（todo_write 早于 step/start 也照样生效）
r = runGate([stepStart(1), todo(parallel(2)), stepStart(2), stepCall("subagent", 2), stepCall("subagent_fork", 2)], MIN, { turn: 1 }, "t1");
t("27", "step 边界不清空 todo 契约", [r.parallelTodos, r.required, r.dispatched, r.pass], [2, 2, 2, true]);

// 28 两个信号都没有 → 退化为整轮累加（离线/极简事件流不误伤）
r = runGate([todo(serial(5)), sub()], MIN, { turn: 1 }, "t1");
t("28", "无 step 信号 → 整轮累加（兼容旧行为）", [r.dispatched, r.required, r.kind, r.pass], [1, 1, "team-once", true]);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);