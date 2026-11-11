/**
 * verify-tool.test.mjs — 给 scripts/verify.mjs 做回归（零第三方依赖）
 *
 * 覆盖：
 *   - assert 命中 / 未命中 / --count 次数 / --at-line 整行
 *   - changed 对含 BOM 的文件报红、对 CR 文件报红、对干净 LF 文件为绿
 *   - changed 读 verify.rules.json 的文本断言，不满足即红
 *
 * 临时目录：优先用 E:\DSHskills-test\_verify_tmp（--root 由环境变量 VERIFY_TMP_ROOT 覆盖），
 * 该路径不可写时回落到系统临时目录；跑完无条件删净。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, "..", "scripts", "verify.mjs");

let PASS = 0;
let FAIL = 0;

function ok(name, cond, extra) {
  if (cond) {
    PASS++;
    console.log("PASS " + name);
  } else {
    FAIL++;
    console.log("FAIL " + name + (extra ? "  → " + extra : ""));
  }
}

function makeTmpRoot() {
  const preferred = process.env.VERIFY_TMP_ROOT || "E:\\DSHskills-test\\_verify_tmp";
  const candidates = [preferred, path.join(os.tmpdir(), "dsh-verify-tool-test")];
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true });
      const dir = path.join(base, "run-" + process.pid + "-" + Date.now());
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // 换下一个候选
    }
  }
  throw new Error("找不到可写的临时目录");
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // 忽略清理失败，不影响结论
  }
}

function runVerify(args, cwd) {
  return spawnSync(process.execPath, [VERIFY, ...args], { cwd, encoding: "utf8" });
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

function writeBom(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]));
}

function initRepo(dir) {
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git init 失败：" + (r.stderr || "").trim());
}

const tmp = makeTmpRoot();
console.log("[verify-tool] 临时目录 " + tmp);

try {
  // ------------------------------------------------ assert
  const aFile = path.join(tmp, "assert", "sample.txt");
  writeText(aFile, "alpha\nBRAVO bravo\nBRAVO\n");
  console.log("[verify-tool] 样例文件 " + aFile + "（3 行）");

  let r = runVerify(["assert", aFile, "--expect", "BRAVO", "--count", "2"], tmp);
  ok("assert 命中（BRAVO 恰好 2 次，exit 0）", r.status === 0, "exit=" + r.status + " out=" + r.stdout);

  r = runVerify(["assert", aFile, "--expect", "BRAVO"], tmp);
  ok("assert 默认 count=1 对 2 次命中应失败", r.status === 1, "exit=" + r.status);

  r = runVerify(["assert", aFile, "--expect", "CHARLIE"], tmp);
  ok("assert 未命中 exit 1", r.status === 1, "exit=" + r.status);
  ok(
    "assert 未命中打印 EXPECTED / ACTUAL",
    r.stdout.includes("EXPECTED:") && r.stdout.includes("ACTUAL"),
    r.stdout
  );

  r = runVerify(["assert", aFile, "--at-line", "3", "--expect", "BRAVO"], tmp);
  ok("assert --at-line 3 整行命中", r.status === 0, "exit=" + r.status);

  r = runVerify(["assert", aFile, "--at-line", "2", "--expect", "BRAVO"], tmp);
  ok("assert --at-line 2 整行不符（实际是 BRAVO bravo）", r.status === 1, "exit=" + r.status);

  r = runVerify(["assert", path.join(tmp, "assert", "nope.txt"), "--expect", "x"], tmp);
  ok("assert 文件不存在 exit 1", r.status === 1, "exit=" + r.status);

  r = runVerify(["assert"], tmp);
  ok("assert 缺参数 exit 2（用法错）", r.status === 2, "exit=" + r.status);

  // ------------------------------------------------ changed：干净 LF 绿
  const cleanRepo = path.join(tmp, "repo-clean");
  fs.mkdirSync(cleanRepo, { recursive: true });
  initRepo(cleanRepo);
  writeText(path.join(cleanRepo, "plain.txt"), "line1\nline2\n");

  r = runVerify(["changed", "--root", cleanRepo], tmp);
  ok("changed 干净 LF 文件 → exit 0", r.status === 0, "exit=" + r.status + " out=" + r.stdout);
  ok("changed 表格里该文件结论为 OK", /plain\.txt/.test(r.stdout) && /OK/.test(r.stdout), r.stdout);

  // ------------------------------------------------ changed：BOM 红
  const bomRepo = path.join(tmp, "repo-bom");
  fs.mkdirSync(bomRepo, { recursive: true });
  initRepo(bomRepo);
  writeBom(path.join(bomRepo, "bom.txt"), "hello\n");

  r = runVerify(["changed", "--root", bomRepo], tmp);
  ok("changed 含 BOM 文件 → exit 1", r.status === 1, "exit=" + r.status + " out=" + r.stdout);
  ok("changed 指明含 BOM", r.stdout.includes("含 BOM"), r.stdout);
  ok("changed BOM 列表达 BOM=YES", /YES/.test(r.stdout), r.stdout);

  // ------------------------------------------------ changed：CR 红
  const crRepo = path.join(tmp, "repo-cr");
  fs.mkdirSync(crRepo, { recursive: true });
  initRepo(crRepo);
  fs.writeFileSync(path.join(crRepo, "cr.txt"), Buffer.from("a\r\nb\r\n", "utf8"));

  r = runVerify(["changed", "--root", crRepo], tmp);
  ok("changed 含 CR 文件 → exit 1", r.status === 1, "exit=" + r.status);
  ok("changed 指明 CR 计数", /CR=2/.test(r.stdout), r.stdout);

  // ------------------------------------------------ changed：rules
  const rulesRepo = path.join(tmp, "repo-rules");
  fs.mkdirSync(rulesRepo, { recursive: true });
  initRepo(rulesRepo);
  writeText(path.join(rulesRepo, "plain.txt"), "line1\nline2\n");
  writeText(
    path.join(rulesRepo, "verify.rules.json"),
    JSON.stringify({ "plain.txt": [{ expect: "MUST_APPEAR", count: 1 }] }, null, 2) + "\n"
  );

  r = runVerify(["changed", "--root", rulesRepo], tmp);
  ok("changed rules 未满足 → exit 1", r.status === 1, "exit=" + r.status);
  ok("changed 报出 rules 违例", /rules:/.test(r.stdout), r.stdout);

  // rules 满足时应恢复绿色（只留规则文件与 plain.txt，规则改成真实存在文本）
  writeText(path.join(rulesRepo, "verify.rules.json"), JSON.stringify({ "plain.txt": [{ expect: "line2", count: 1 }] }, null, 2) + "\n");
  r = runVerify(["changed", "--root", rulesRepo], tmp);
  ok("changed rules 满足 → exit 0", r.status === 0, "exit=" + r.status + " out=" + r.stdout);

  // ------------------------------------------------ 未知子命令
  r = runVerify(["nonsense"], tmp);
  ok("未知子命令 exit 2", r.status === 2, "exit=" + r.status);
} finally {
  rmrf(tmp);
  console.log("[verify-tool] 临时目录已删除 " + tmp);
}

console.log("");
console.log("[verify-tool] 结果：" + PASS + " 通过 / " + FAIL + " 失败");
process.exit(FAIL === 0 ? 0 : 1);