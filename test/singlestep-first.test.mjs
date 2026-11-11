// 用法: node test/singlestep-first.test.mjs
// 测：hasSingleStepMark 只认「第一条 todo」的【不可拆·单步】标记（7 个用例）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// 相对仓库根推导，任何 clone 都能跑（不写死任何本机绝对路径）
const SRC = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(SRC, "utf8");
// 从真实文件抽出常量与函数原文，喂 7 个用例（不改写逻辑）
const probe = src.slice(src.indexOf("var SINGLE_STEP_MARK ="), src.indexOf("// 永远不拦（否则模型无法自救"));
const build = new Function(probe + "\nreturn hasSingleStepMark;");
const has = build();

const cases = [
  ["A 第一条含标记", '{"todos":[{"content":"【不可拆·单步】改一行文案","status":"in_progress"},{"content":"第二条"}]}', true],
  ["B 仅第 4 条含标记（关键反例）", '{"todos":[{"content":"改文案"},{"content":"跑测试"},{"content":"读回"},{"content":"【不可拆·单步】顺便清理"}]}', false],
  ["C1 无 todos 字段", '{"items":["a"]}', false],
  ["C2 todos 为空数组", '{"todos":[]}', false],
  ["D 参数不是合法 JSON", 'todos: 【不可拆·单步】', false],
];

// 补充：对象形态（非字符串）同样只认第一条
const objectCases = [
  ["E 对象形态 todos[0] 含标记", { todos: [{ content: "【不可拆·单步】x" }] }, true],
  ["F 对象形态仅第 2 条含标记", { todos: [{ content: "普通" }, { content: "【不可拆·单步】" }] }, false],
];

let pass = 0, fail = 0;
/** 唯一断言入口。修复前 E/F 直接用 console.log 打印 PASS，绕过自增 → 自报「5 通过」而实际有 7 行 PASS。 */
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + " → hasSingleStepMark=" + got + "  期望=" + want);
}

for (const [name, input, want] of cases) check(name, has(input), want);
for (const [name, input, want] of objectCases) check(name, has(input), want);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
