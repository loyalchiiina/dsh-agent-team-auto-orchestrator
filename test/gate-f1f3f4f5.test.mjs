// 用法: node test/gate-f1f3f4f5.test.mjs
// 测 1.3.2 的 F1 / F3 / F4 / F5 —— 逻辑**从真实 lib/index.js 抽出**，不改写。
// 覆盖：send_message 计入派活（F1）／本 turn 内单步峰值放行（F3）／spawn 前置复用校验（F4）与文案（F5）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(SRC, "utf8");

let pass = 0, fail = 0;
function t(no, desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + no + "  " + desc + "\n      got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
  ok ? pass++ : fail++;
}
function sliceBetween(a, b, label) {
  const s = src.indexOf(a);
  if (s < 0) { console.log("FAIL 抽取失败 " + label + " start"); process.exit(1); }
  const e = src.indexOf(b, s);
  if (e < 0) { console.log("FAIL 抽取失败 " + label + " end"); process.exit(1); }
  return src.slice(s, e);
}

// ── 第一部分：闸门计数与放行（F1 / F3）────────────────────────────────
const markLine = src.match(/var SINGLE_STEP_MARK = .*;/)[0];
const fns = sliceBetween("function hasSingleStepMark(args) {", "// 永远不拦（否则模型无法自救", "fns");
const body = sliceBetween("var dispatchedCount = 0;", "// required === 0 = 明确不需要派活", "gate body");

// 1.3.3（#3）：两个集合必须分开构造 —— DISPATCH_SET 计路数（含 send_message），
// OPEN_SET 只认新开执行者（置 F2 的位）。这里刻意与 lib/index.js 的字面值同步，
// 任何一边漂移，下面的 F1/F2 用例都会红（这是本测试的守门作用）。
const DISPATCH_SET = new Set(["subagent", "subagent_fork", "spawn_teammate", "send_message"]);
const OPEN_SET = new Set(["subagent", "subagent_fork", "spawn_teammate"]);
const SEEN = new Map();
const runGate = new Function(
  "DISPATCH_TOOLS", "TEAM_OPEN_TOOLS", "dispatchCounts", "sessionDispatchSeen", "gateMaxParallel",
  markLine + "\n" + fns + "\n" +
  "return function runGate(events, minDispatches, state, sid) {\n" +
  "  var next = function () { return 'next'; };\n" +
  "  var lastTodoArgs = null;\n" +
  "  var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };\n" +
  "  var noTodoFallbackHits = 0;\n" +
  body + "\n" +
  "  return { dispatched: dispatchedCount, turnMax: turnMaxStepDispatch, required: requiredDispatches, kind: gateKind, pass: (requiredDispatches === 0 || turnMaxStepDispatch >= requiredDispatches) };\n" +
  "};"
)(DISPATCH_SET, OPEN_SET, new Map(), SEEN, 6);

const call = (name, args) => ({ type: "tool/call", data: { name, arguments: args === undefined ? "{}" : args } });
const todo = (items) => call("todo_write", JSON.stringify({ todos: items }));
const T = (content) => ({ content });
const parallel = (n) => Array.from({ length: n }, (_, i) => T("【并行】块" + (i + 1)));
const stepStart = (n) => ({ type: "step/start", data: { turn: 1, step: n } });
const stepCall = (name, n) => ({ type: "tool/call", data: { name, arguments: "{}", step: n } });
const turnStart = () => ({ type: "turn/start", data: { turn: 1 } });
const MIN = 1;

// F1：send_message 也是派活（session-8a8a6a44 实录：3 次 send_message 派给 3 个空闲员工，旧闸门判 0 路）
let r = runGate([todo(parallel(3)), stepStart(1), stepCall("send_message", 1), stepCall("send_message", 1), stepCall("send_message", 1)], MIN, { turn: 1 }, "f1");
t("01", "F1 同一步 3× send_message → 计 3 路、放行", [r.dispatched, r.turnMax, r.required, r.pass], [3, 3, 3, true]);

r = runGate([todo(parallel(2)), stepStart(1), stepCall("send_message", 1)], MIN, { turn: 1 }, "f1");
t("02", "F1 只派 1 路 send_message（要 2 路）→ 仍拒", [r.dispatched, r.required, r.pass], [1, 2, false]);

// F3：放行看「本 turn 内单步最多」。旧行为：换 step 就归零 → edit/pwsh 全被拦（实测硬拦 16 次）
r = runGate([turnStart(), todo(parallel(3)), stepStart(1), stepCall("spawn_teammate", 1), stepCall("spawn_teammate", 1), stepCall("spawn_teammate", 1), stepStart(2), stepCall("pwsh", 2)], MIN, { turn: 1 }, "f3");
t("03", "F3 第1步派满 3 路、第2步动手 → 放行（旧行为会拒）", [r.dispatched, r.turnMax, r.required, r.pass], [0, 3, 3, true]);

r = runGate([todo(parallel(3)), stepStart(1), stepCall("subagent", 1), stepStart(2), stepCall("subagent", 2), stepStart(3), stepCall("subagent", 3), stepStart(4)], MIN, { turn: 1 }, "f3");
t("04", "F3 分步凑数（1+1+1）仍拒 → 任一步峰值只有 1", [r.turnMax, r.required, r.pass], [1, 3, false]);

r = runGate([turnStart(), todo(parallel(3)), stepStart(1), stepCall("subagent", 1), stepCall("subagent", 1), stepCall("subagent", 1), turnStart(), todo(parallel(3)), stepStart(2), stepCall("pwsh", 2)], MIN, { turn: 2 }, "f3");
t("05", "F3 turn/start 会重置峰值 → 新 turn 未派活 → 拒", [r.turnMax, r.required, r.pass], [0, 3, false]);

r = runGate([todo(parallel(2)), stepStart(1), stepCall("send_message", 1), stepCall("subagent", 1), stepStart(2)], MIN, { turn: 1 }, "f3");
t("06", "F3 同一步内混合通道（send_message + subagent）→ 2 路放行", [r.turnMax, r.required, r.pass], [2, 2, true]);

// ── 第二部分：spawn 前置复用校验（F4 / F5）─────────────────────────────
const stateBlock = sliceBetween("var lastRoster = { at: 0", "var SPAWN_ROSTER_TTL_MS = 120000;", "roster state");
const helperBlock = sliceBetween("function parseRosterText(text) {", "function buildDenyReason(", "roster helpers");
const f4Block = sliceBetween('if (toolName === "spawn_teammate" && spawnReuseGate !== "off") {', "if (isExempt(toolName)) return next();", "F4 block");

const runSpawnGate = new Function(
  "toolName", "spawnReuseGate", "exec", "gateLog",
  stateBlock + "\n" + helperBlock + "\n" +
  "  var SPAWN_ROSTER_TTL_MS = 120000;\n" +
  "  var spawnReuseHits = 0;\n" +
  "  var spawnReuseWaitHits = 0;\n" +
  "  var __r = (function () {\n" + f4Block + "\n  })();\n" +
  "  return { result: __r || null, reuse: spawnReuseHits, wait: spawnReuseWaitHits, idle: lastRoster.idle.slice(), rosterOk: lastRoster.ok, log: gateLog.slice() };\n"
);

const NOW = Date.now();
function rosterEvents(list, opts) {
  const o = opts || {};
  const text = typeof list === "string" ? list : JSON.stringify(list);
  const seq = o.seq === undefined ? 100 : o.seq;
  return [
    { type: "tool/call", seq: seq - 1, time: NOW - 1000, data: { name: "list_agents", arguments: "{}", callId: "c1", turn: 1, step: 1 } },
    { type: "tool/result", seq: seq, time: o.at === undefined ? NOW - 1000 : o.at, data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text }], isError: !!o.isError, source: { kind: "tool", callId: "c1" } } } }
  ];
}
const mkExec = (events) => ({ agent: { session: { snapshotEvents: () => events } } });
const TEAMMATE = (name, status) => ({ target: name, role: "teammate", status, description: "x", provider: "spawn" });
const LEAD = (status) => ({ target: "lead", role: "lead", status });
const DENY_OK = (res, needle) => res.result && res.result.kind === "deny" && typeof res.result.reason === "string" && res.result.reason.indexOf(needle) >= 0;

// 01 有 2 个空闲 + spawn → 拒，文案带名字（F5）
let gl = [];
let res = runSpawnGate("spawn_teammate", "enforce", mkExec(rosterEvents([LEAD("running"), TEAMMATE("employee-1", "inactive"), TEAMMATE("employee-2", "inactive"), TEAMMATE("employee-3", "running")])), gl);
t("07", "F4 有 2 空闲 + spawn → 拒且点名", [DENY_OK(res, "【复用优先】当前有 2 位空闲成员：employee-1、employee-2") || DENY_OK(res, "employee-1、employee-2"), res.reuse, res.wait], [true, 1, 0]);
t("08", "F5 文案三段齐全", [res.result.reason.indexOf("【复用优先】") >= 0, res.result.reason.indexOf("这一路的活能不能交给它们？能就 send_message 直接派；确实没有能接的（职责不匹配 / 都在忙）才新建。") >= 0, res.result.reason.indexOf("若花名册已过期，先调 list_agents 再派。") >= 0], [true, true, true]);
t("09", "F4 gateLog 记 spawn-reuse-idle（不拦也要留痕）", [res.log.length, res.log[0].kind, res.log[0].dispatched], [1, "spawn-reuse-idle", 2]);

// 02 无空闲（全 running）→ 放行
gl = [];
res = runSpawnGate("spawn_teammate", "enforce", mkExec(rosterEvents([LEAD("running"), TEAMMATE("employee-1", "running"), TEAMMATE("employee-2", "running")])), gl);
t("10", "F4 无空闲 + spawn → 放行", [res.result, res.reuse, res.wait], [null, 0, 0]);

// 03 花名册过期（>120s）→ 拒，提示先查
gl = [];
res = runSpawnGate("spawn_teammate", "enforce", mkExec(rosterEvents([TEAMMATE("employee-1", "inactive")], { at: NOW - 200000 })), gl);
t("11", "F4 花名册 >120s + spawn → 拒并提示先查", [DENY_OK(res, "必须先查花名册"), res.reuse, res.wait], [true, 0, 1]);

// 04 完全没有花名册 → 拒（不许因为查不到就放行）
res = runSpawnGate("spawn_teammate", "enforce", mkExec([]), []);
t("12", "F4 无任何 list_agents → 拒（不许兜底放行）", [DENY_OK(res, "必须先查花名册"), res.wait], [true, 1]);

// 05 花名册文本非法 JSON → fail-safe → 拒、不崩
res = runSpawnGate("spawn_teammate", "enforce", mkExec(rosterEvents("not-a-json")), []);
t("13", "F4 花名册解析失败 → fail-safe 拒（不崩不放行）", [DENY_OK(res, "必须先查花名册"), res.wait], [true, 1]);

// 06 list_agents 结果 isError → 视为不可用 → 拒
res = runSpawnGate("spawn_teammate", "enforce", mkExec(rosterEvents([TEAMMATE("employee-1", "inactive")], { isError: true })), []);
t("14", "F4 list_agents 报错 → 视为不可用 → 拒", [DENY_OK(res, "必须先查花名册")], [true]);

// 07 非 spawn 工具 → 不校验
res = runSpawnGate("subagent", "enforce", mkExec(rosterEvents([TEAMMATE("employee-1", "inactive")])), []);
t("15", "F4 非 spawn 工具 → 不校验", [res.result, res.reuse, res.wait], [null, 0, 0]);

// 08 warn 模式 → 不拦，但留痕
gl = [];
res = runSpawnGate("spawn_teammate", "warn", mkExec(rosterEvents([TEAMMATE("employee-1", "inactive")])), gl);
t("16", "F4 warn 模式 → 放行但计数 +1 且留痕", [res.result, res.reuse, res.log.length], [null, 1, 1]);

// 09 off 模式 → 完全不介入
res = runSpawnGate("spawn_teammate", "off", mkExec(rosterEvents([TEAMMATE("employee-1", "inactive")])), []);
t("17", "F4 off 模式 → 不介入", [res.result, res.reuse], [null, 0]);

// 10 idle 只算 role==='teammate'（lead 空闲不算）
res = runSpawnGate("spawn_teammate", "enforce", mkExec(rosterEvents([LEAD("inactive"), TEAMMATE("employee-1", "running")])), []);
t("18", "F4 lead 空闲不计入 → 放行", [res.result, res.idle.length], [null, 0]);

// 11 多个 list_agents 取「最近一次」（旧的那份说有 3 个空闲，新的说都忙 → 应放行）
const evs = [
  { type: "tool/call", seq: 1, data: { name: "list_agents", arguments: "{}", callId: "old", turn: 1, step: 1 } },
  { type: "tool/result", seq: 2, time: NOW - 60000, data: { turn: 1, step: 1, message: { toolCallId: "old", content: [{ type: "text", text: JSON.stringify([TEAMMATE("e1", "inactive"), TEAMMATE("e2", "inactive"), TEAMMATE("e3", "inactive")]) }], source: { callId: "old" } } } },
  { type: "tool/call", seq: 3, data: { name: "list_agents", arguments: "{}", callId: "new", turn: 1, step: 2 } },
  { type: "tool/result", seq: 4, time: NOW - 1000, data: { turn: 1, step: 2, message: { toolCallId: "new", content: [{ type: "text", text: JSON.stringify([TEAMMATE("e1", "running"), TEAMMATE("e2", "running")]) }], source: { callId: "new" } } } }
];
res = runSpawnGate("spawn_teammate", "enforce", mkExec(evs), []);
t("19", "F4 取最近一次花名册（旧的 3 空闲不算）→ 放行", [res.result, res.idle.length], [null, 0]);

// 12 缓存：同一 seq 重复调用不重新解析（seq 不变即命中）
res = runSpawnGate("spawn_teammate", "warn", mkExec(rosterEvents([TEAMMATE("e1", "inactive")])), []);
t("20", "F4 花名册按 seq 命中缓存（rosterOk=true）", [res.rosterOk, res.idle], [true, ["e1"]]);

// ── 第二部分：F2 —— wait_agent 跨 turn 判定（1.3.3）──────────────────────
// 从真实 lib/index.js 抽出 2b-i-b 分支（不重写），stub 掉 next / gateLog / domains。
// 实测依据：session-8a8a6a44 的 t2/s1、t2/s4 两次 wait_agent 被拦，文案「本轮还没有开团队」，
// 但上一轮明明派过 3 路 —— 等已经派出去的活，本来就该跨 turn 看。
const waitSrc = sliceBetween('if (toolName === "wait_agent") {', "// 2b-ii. 防死循环", "wait block");
const runWait = new Function(
  "toolName", "dispatchedCount", "requiredDispatches", "waitAgentGate", "sid", "next", "gateLog", "domains",
  "dispatchedTurnKey", "sessionDispatchSeen", "waitReleaseCounts", "lastWaitReleased",
  waitSrc + "\n  return 'deny';"
);
function waitOnce(o) {
  const log = [];
  // 1.3.3（#4）：wait 分支现在会写 released + 计数，harness 必须提供这两个容器。
  const counts = { f2: 0, warn: 0, deny: 0 };
  const r = runWait("wait_agent", o.dispatched === undefined ? 0 : o.dispatched,
    o.required === undefined ? 2 : o.required, o.gate, o.sid, () => "next", log, ["plugin"],
    String(o.turn === undefined ? 1 : o.turn), o.seen || new Map(), counts, null);
  return { result: r, log: log, counts: counts };
}

// 21 跨 turn：上一轮派过活（标记已在），本轮先 wait_agent → 放行（旧行为在 enforce 下被拦）
let w = waitOnce({ gate: "enforce", sid: "s1", seen: new Map([["s1", true]]), turn: 2 });
t("21", "F2 跨 turn：本会话派过活 → wait_agent 放行（旧行为被拦）",
  [w.result, w.log.length, w.log[0] && w.log[0].kind, w.log[0] && w.log[0].turn, w.log[0] && w.log[0].released, w.counts.f2],
  ["next", 1, "wait-before-full-dispatch", "2", "f2", 1]);

// 22 从未派过活 + enforce → 仍然拦（D7 要治的串行伪装不许一起放开）
w = waitOnce({ gate: "enforce", sid: "s2", seen: new Map(), turn: 1 });
t("22", "F2 从未派过活 + enforce → 仍拦（released=deny）",
  [w.result, w.log.length, w.log[0] && w.log[0].released, w.counts.deny], ["deny", 1, "deny", 1]);

// 23 warn 档（默认）行为不变：从未派过活也放行 + 记账
w = waitOnce({ gate: "warn", sid: "s3", seen: new Map(), turn: 1 });
t("23", "F2 warn 档（默认）→ 从未派过活也放行 + 记账（released=warn）",
  [w.result, w.log.length, w.log[0] && w.log[0].released, w.counts.warn], ["next", 1, "warn", 1]);

// ── 第三部分：F2 端到端（1.3.3 #5 补的缺陷）────────────────────────────────
// 21-23 只测「读」分支：seen 由测试直接注入，绕过了置位点，与用例 21 同构 = 空转。
// 实测后果：把 lib/index.js 里 sessionDispatchSeen.set(sid, true) 的 sid 写错，25 条用例仍全绿。
// 这里从真实源码抽出「事件扫描 + 置位 + 四档 + wait 分支」整段（原样切片，不改写），
// 让写入门与读入门在同一次断言里被打通。
const bodyE2E = sliceBetween("var dispatchedCount = 0;", "// 2b-ii. 防死循环", "gate body e2e");
const makeGateE2E = new Function(
  "DISPATCH_TOOLS", "TEAM_OPEN_TOOLS", "dispatchCounts", "sessionDispatchSeen", "gateMaxParallel",
  "waitAgentGate", "toolName", "domains", "gateLog", "waitReleaseCounts",
  markLine + "\n" + fns + "\n" +
  "return function runGateE2E(events, minDispatches, state, sid) {\n" +
  "  var next = function () { return 'next'; };\n" +
  "  var lastTodoArgs = null;\n" +
  "  var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };\n" +
  "  var noTodoFallbackHits = 0;\n" +
  "  var lastWaitReleased = null;\n" +
  bodyE2E + "\n" +
  "  return { result: 'fell-through' };\n" +
  "};"
);
function runE2E(o) {
  const log = [];
  const counts = { f2: 0, warn: 0, deny: 0 };
  const seen = o.seen || new Map();
  // 切片里的放行路径直接 `return next()`（返回字符串 "next"）；落到函数末尾才是对象。
  // 两种形态在这里归一，避免用例断言被返回结构差异污染。
  const raw = makeGateE2E(DISPATCH_SET, OPEN_SET, o.dispatchCounts || new Map(), seen,
    o.gate || "enforce", "wait_agent", ["plugin"], log, counts)(
    o.events, o.min === undefined ? 1 : o.min, { turn: o.turn === undefined ? 1 : o.turn }, o.sid);
  const result = (raw === "next") ? "next" : ((raw && raw.result) || "fell-through");
  return { result: result, log: log, counts: counts, seen: seen };
}
const lastLog = (r) => (r.log.length ? r.log[r.log.length - 1] : null);

// 24 端到端（正）：turn1 真调 spawn_teammate → 置位点写入本会话 sid；turn2 只 wait_agent → 读点读到同一 sid 放行
const E2E_SEEN = new Map();
const e2eTurn1 = runE2E({ seen: E2E_SEEN, sid: "e2e-1", turn: 1, min: 2,
  events: [turnStart(), todo(parallel(2)), stepStart(1), stepCall("spawn_teammate", 1), stepCall("spawn_teammate", 1)] });
const e2eTurn2 = runE2E({ seen: E2E_SEEN, sid: "e2e-1", turn: 2, min: 2,
  events: [turnStart(), todo(parallel(2)), stepStart(1), stepCall("wait_agent", 1)] });
// 1.4.0 设计变更：wait_agent 不再承担「开团记忆」语义 —— 无【并行】标记或未派满时，
  // 判定链在放行行之前就走完了，wait 专项不会命中（本用例保留为「不再串号/不再依赖 F2 位」的回归）。
  t("24", "端到端（1.4.0 变更）：次轮 wait_agent 不依赖 F2 置位，结果与置位状态无关",
  [e2eTurn1.result, E2E_SEEN.has("e2e-1"), E2E_SEEN.size, e2eTurn2.result, e2eTurn2.counts.f2, lastLog(e2eTurn2) && lastLog(e2eTurn2).released],
  ["fell-through", true, 1, "fell-through", 0, null]);

// 24b 端到端（反）：同一个 seen Map 里，另一个会话 sid 从未置位 → 不放行（证明读写用的是同一个会话键）
const e2eOther = runE2E({ seen: E2E_SEEN, sid: "e2e-2", turn: 2, min: 2,
  events: [turnStart(), todo(parallel(2)), stepStart(1), stepCall("wait_agent", 1)] });
t("25", "端到端（1.4.0 变更）：另一个 sid 同样不受前一 sid 影响（无串号）",
  [e2eOther.result, e2eOther.counts.deny, lastLog(e2eOther) && lastLog(e2eOther).released, E2E_SEEN.has("e2e-2")],
  ["fell-through", 0, null, false]);

// 26 计数不串：wait_agent 既不计入派活路数，也不清空本 turn 已派路数
r = runGate([turnStart(), todo(parallel(3)), stepStart(1), stepCall("send_message", 1), stepCall("send_message", 1), stepCall("send_message", 1), stepCall("wait_agent", 1)], MIN, { turn: 1 }, "f2a");
const afterWait = r;
r = runGate([turnStart(), todo(parallel(3)), stepStart(1), stepCall("wait_agent", 1)], MIN, { turn: 1 }, "f2b");
t("26", "F2 wait_agent 不计入派活、不清空已派路数", [afterWait.dispatched, afterWait.pass, r.dispatched], [3, true, 0]);

// 27（#3 核心）：send_message 只算「派活路数」，不再单独构成「开过团队」
// 旧行为：send_message 走同一个集合，单条 send_message 就能永久置位 → 次轮 wait_agent 直接放行（复核实测）。
const SEND_SEEN = new Map();
const sendTurn1 = runE2E({ seen: SEND_SEEN, sid: "e2e-3", turn: 1, min: 3,
  events: [turnStart(), todo(parallel(3)), stepStart(1), stepCall("send_message", 1), stepCall("send_message", 1), stepCall("send_message", 1)] });
const sendTurn2 = runE2E({ seen: SEND_SEEN, sid: "e2e-3", turn: 2, min: 2,
  events: [turnStart(), todo(parallel(2)), stepStart(1), stepCall("wait_agent", 1)] });
t("27", "#3 send_message ×3 计入派活路数但不置 F2 位（1.4.0：wait 不再因此被拦）",
  [sendTurn1.result, SEND_SEEN.size, sendTurn2.result, lastLog(sendTurn2) && lastLog(sendTurn2).released],
  ["fell-through", 0, "fell-through", null]);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);