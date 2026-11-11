// 用法: node test/gate-maxparallel.test.mjs
// 测：1.1.2 gateMaxParallel 可配化的 16 个行为用例 —— 判定代码**从真实 lib/index.js 抽出**，不改写逻辑。
// 覆盖：未配置默认 6 / 配置 10 生效 / 封顶生效 / 边界 2 与 16 / 非法值回落 + gateLog / 单步豁免优先 / 注入文本动态数字。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// 相对仓库根推导，任何 clone 都能跑（不写死任何本机绝对路径）
const SRC = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(SRC, "utf8");

function sliceBetween(a, b, label) {
  const s = src.indexOf(a);
  if (s < 0) { console.log("FAIL 抽取失败 " + label + "（找不到 start 锚点）"); process.exit(1); }
  const e = src.indexOf(b, s);
  if (e < 0) { console.log("FAIL 抽取失败 " + label + "（找不到 end 锚点）"); process.exit(1); }
  return src.slice(s, e);
}

const markLine = src.match(/var SINGLE_STEP_MARK = .*;/)[0];
const fns = sliceBetween("function hasSingleStepMark(args) {", "// 永远不拦（否则模型无法自救", "fns");
const body = sliceBetween("var dispatchedCount = 0;", "// required === 0 = 明确不需要派活", "gate body");
const parserBlock = sliceBetween("// ── gateMaxParallel 解析", "// ── 插件入口", "parser");
const tmplChunk = sliceBetween("var LAW_TEXT_TEMPLATE = [", "// 预设路由表是唯一需要运行时拼接的一段", "template");
const lawFn = sliceBetween("function buildLawText(routes) {", "export var name =", "buildLawText");

// 闸门主体：多一个 gateMaxParallel 形参（真实代码里它来自 apply() 闭包）
const buildGate = new Function(
  "TEAM_TOOLS", "dispatchCounts",
  markLine + "\n" + fns + "\n" +
  "return function runGate(events, minDispatches, state, sid, gateMaxParallel) {\n" +
  "  var next = function () { return 'next'; };\n" +
  "  var lastTodoArgs = null;\n" +
  "  var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };\n" +
  "  var noTodoFallbackHits = 0;\n" +
  body + "\n" +
  "  return { dispatched: dispatchedCount, required: requiredDispatches, parallelTodos: parallelTodos, todoTotal: todoTotal, kind: gateKind, singleStep: singleStepMarked, pass: (requiredDispatches === 0 || dispatchedCount >= requiredDispatches) };\n" +
  "};"
);

// 配置解析：真实 parseGateMaxParallel + 同作用域 gateLog
const buildParser = new Function(
  "var gateLog = [];\n" + parserBlock + "\n" +
  "return { parse: parseGateMaxParallel, gateLog: gateLog };"
);

// 注入文本：真实 LAW_TEXT_TEMPLATE + 真实 buildLawText
const buildLaw = new Function(
  "ACTIVE_GATE_MAX_PARALLEL", tmplChunk + lawFn + "\nreturn buildLawText;"
);

const TEAM_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate"]);
const call = (name, args) => ({ type: "tool/call", data: { name, arguments: args === undefined ? "{}" : args } });
const todo = (items) => call("todo_write", JSON.stringify({ todos: items }));
const T = (content, status) => (status ? { content, status } : { content });
const parallel = (n, status) => Array.from({ length: n }, (_, i) => T("【并行】块" + (i + 1), status));
const sub = () => call("subagent");
const MIN = 1; // 1.1.1 默认 minDispatches

function runWith(config, events) {
  const P = buildParser();
  const G = buildGate(TEAM_TOOLS, new Map());
  const cap = P.parse(config);
  const r = G(events, MIN, { turn: 1 }, "t1", cap);
  return { cap, r, gateLog: P.gateLog };
}

let pass = 0, fail = 0;
function t(no, desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + no + "  " + desc + "\n      got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
  ok ? pass++ : fail++;
}

// 01 未配置 → 封顶 6（与 1.1.1 行为一致）
let x = runWith(undefined, [todo(parallel(20))]);
t("01", "gateMaxParallel 未配置 + 20 条并行 → 封顶 6", [x.cap, x.r.parallelTodos, x.r.required, x.gateLog.length], [6, 20, 6, 0]);

// 02 配置 10 + todo 标 10 条并行 → required = 10
x = runWith({ gateMaxParallel: 10 }, [todo(parallel(10))]);
t("02", "gateMaxParallel=10 + 10 条并行 → required 10", [x.cap, x.r.parallelTodos, x.r.required], [10, 10, 10]);

// 03 配置 10 + 20 条并行 → 封顶 10
x = runWith({ gateMaxParallel: 10 }, [todo(parallel(20))]);
t("03", "gateMaxParallel=10 + 20 条并行 → 封顶 10", [x.cap, x.r.parallelTodos, x.r.required], [10, 20, 10]);

// 04 非法 1（低于 2）→ 回落 6 + gateLog 记一条
x = runWith({ gateMaxParallel: 1 }, [todo(parallel(20))]);
t("04", "gateMaxParallel=1（非法）→ 回落 6 + gateLog 记录",
  [x.cap, x.r.required, x.gateLog.length, x.gateLog[0].kind, x.gateLog[0].key, x.gateLog[0].value, x.gateLog[0].fallback],
  [6, 6, 1, "config-fallback", "gateMaxParallel", 1, 6]);

// 05 非法 99（高于 16）→ 回落 6
x = runWith({ gateMaxParallel: 99 }, [todo(parallel(20))]);
t("05", "gateMaxParallel=99（非法）→ 回落 6 + gateLog 记录",
  [x.cap, x.r.required, x.gateLog.length, x.gateLog[0].value], [6, 6, 1, 99]);

// 06 单步豁免优先于封顶：=10 但标【不可拆·单步】→ required 0
x = runWith({ gateMaxParallel: 10 }, [todo([T("【不可拆·单步】整块一件事", "in_progress"), ...parallel(10)])]);
t("06", "gateMaxParallel=10 + 单步标记 → required 0（单步豁免优先）",
  [x.cap, x.r.singleStep, x.r.required, x.r.kind, x.r.pass], [10, true, 0, "single-step", true]);

// 07 注入文本里的上限数字 = 当前生效值（不许写死 6）
// 1.2.0 二次修订：模板换成 12 节方法论版，旧字面量「封顶 N 路」已不存在，
// 上限句改为「当前上限 @@MAXPAR@@ 路」（第三节、第十二节各一处 → 渲染后出现 2 次）。
// 断言结构（7 项）与判定意图不变，仅把字面量锚点换成新文案。
const lawDefault = buildLaw(6)([]);
const lawTen = buildLaw(10)([]);
const lawSixteen = buildLaw(16)([]);
const countOf = (s, sub2) => s.split(sub2).length - 1;
t("07", "注入文本上限数字随生效值变化（6 / 10 / 16），且模板无写死",
  [
    countOf(lawDefault, "当前上限 6 路"),
    countOf(lawTen, "当前上限 10 路"),
    countOf(lawSixteen, "当前上限 16 路"),
    countOf(lawTen, "当前上限 6 路"),
    countOf(tmplChunk, "@@MAXPAR@@"),
    countOf(tmplChunk, "当前上限 6 路"),
    lawTen.indexOf("@@MAXPAR@@")
  ],
  [2, 2, 2, 0, 2, 0, -1]);

// 08 边界：=2（合法下限）→ required = 2
x = runWith({ gateMaxParallel: 2 }, [todo(parallel(20))]);
t("08", "gateMaxParallel=2（合法下限）→ required 2", [x.cap, x.r.required], [2, 2]);

// 09 边界：=16（合法上限）→ required = 16
x = runWith({ gateMaxParallel: 16 }, [todo(parallel(20))]);
t("09", "gateMaxParallel=16（合法上限）→ required 16", [x.cap, x.r.required], [16, 16]);

// 10 范围校验先于取整：15.9 在 [2,16] 内 → floor 15；16.7 超出 16 → 非法回落 6
x = runWith({ gateMaxParallel: 15.9 }, [todo(parallel(20))]);
t("10a", "gateMaxParallel=15.9（范围内非整数）→ 向下取整 15", [x.cap, x.r.required, x.gateLog.length], [15, 15, 0]);
x = runWith({ gateMaxParallel: 16.7 }, [todo(parallel(20))]);
t("10b", "gateMaxParallel=16.7（超出 16 上界）→ 非法回落 6", [x.cap, x.r.required, x.gateLog.length, x.gateLog[0].value], [6, 6, 1, 16.7]);

// 11 非数字（字符串 "10"）→ 非法，回落 6
x = runWith({ gateMaxParallel: "10" }, [todo(parallel(20))]);
t("11", "gateMaxParallel=\"10\"（字符串，非法）→ 回落 6", [x.cap, x.r.required, x.gateLog.length], [6, 6, 1]);

// 12 显式 null → 视为未配置，回落 6 且不记非法日志
x = runWith({ gateMaxParallel: null }, [todo(parallel(20))]);
t("12", "gateMaxParallel=null（视为未配置）→ 6 且不记日志", [x.cap, x.r.required, x.gateLog.length], [6, 6, 0]);

// 13 配置 10 但 todo 只有 3 条并行 → required 3（封顶不误伤小规模）
x = runWith({ gateMaxParallel: 10 }, [todo(parallel(3))]);
t("13", "gateMaxParallel=10 + 3 条并行 → required 3（封顶不误伤）", [x.cap, x.r.parallelTodos, x.r.required], [10, 3, 3]);

// 14 未标并行的大任务仍走 minDispatches（与 gateMaxParallel 无关）
x = runWith({ gateMaxParallel: 10 }, [todo(Array.from({ length: 5 }, (_, i) => T("步骤" + (i + 1))))]);
t("14", "gateMaxParallel=10 + 5 条非并行 → required = minDispatches 1", [x.r.required, x.r.kind], [1, "team-once"]);

// 15 同上但已派 1 路 → 放行（证明封顶不影响基础门槛路径）
x = runWith({ gateMaxParallel: 10 }, [todo(Array.from({ length: 5 }, (_, i) => T("步骤" + (i + 1)))), sub()]);
t("15", "gateMaxParallel=10 + 5 条非并行 + 已派 1 路 → 放行", [x.r.dispatched, x.r.required, x.r.pass], [1, 1, true]);

console.log("\n=== gateMaxParallel 用例：" + pass + "/" + (pass + fail) + " PASS ===");
if (fail > 0) process.exit(1);
