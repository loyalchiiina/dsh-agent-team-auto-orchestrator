#!/usr/bin/env node
/**
 * verify.mjs — 「写入即断言」三档自检工具（零第三方依赖）
 *
 * 设计目标：把「写完一整篇再通读、再算 SHA、再人工数字符」换成「写一次、断言一次」。
 * 只依赖 node 内置模块：fs / path / crypto / child_process。
 *
 * 用法
 *   node scripts/verify.mjs assert <file> --expect "<文本>" [--count N] [--at-line L]
 *       断言文件里该文本出现恰好 N 次（默认 1）；--at-line L 断言第 L 行整行等于该文本。
 *       不匹配 → 打印 EXPECTED / ACTUAL 并 exit 1。
 *
 *   node scripts/verify.mjs changed [--root <repo>]
 *       取 git status --porcelain（含 ??）里的改动文件，逐个查：
 *       BOM（前 3 字节）/ CR 数 / 控制字符 / 字节数 / 行数 / SHA256，
 *       可选跑仓库根的 verify.rules.json 里的文本断言。有问题才 exit 1。
 *
 *   node scripts/verify.mjs release [--root <repo>] [--suite <suite目录名>]
 *       在 changed 之上再加：npm pack --dry-run 入包清单（断言不含
 *       lib/client.js / test/ / scripts/ / local.json）、scripts/scan-private.mjs exit 0、
 *       三副本 lib/index.js SHA256 相等（源 + 上一级 node_modules + suite 的 node_modules，后两处是 Junction）。
 *
 * 退出码：0 全部通过 / 1 有检查项失败 / 2 用法或环境错误。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const TOOL_VERSION = "1.0.0";

/** 控制字符白名单检查的字节：除 TAB(0x09) 与 LF(0x0a) 外都不允许出现 */
const CTRL_BYTES = [0x00, 0x07, 0x0b, 0x0c, 0x1b];

/** 入包里绝不允许出现的路径前缀/文件名（scripts 也不进包） */
const FORBIDDEN_IN_PACK = [/^lib\/client\.js$/, /^test(\/|$)/, /^scripts(\/|$)/, /^local\.json$/];

const OCCURRENCE_DEFAULT = 1;
const EXPECTED_PACK_ENTRY_COUNT = 11;

// ---------------------------------------------------------------- 通用小工具

function usage() {
  console.log(
    [
      "verify.mjs " + TOOL_VERSION,
      "",
      "  node scripts/verify.mjs assert <file> --expect \"<文本>\" [--count N] [--at-line L]",
      "  node scripts/verify.mjs changed [--root <repo>]",
      "  node scripts/verify.mjs release [--root <repo>] [--suite <suite目录名>]",
      ""
    ].join("\n")
  );
}

function die(message, code = 2) {
  console.error("[verify] " + message);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = String(next);
        i++;
      }
    } else {
      pos.push(arg);
    }
  }
  return { flags, pos };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    n++;
    from = at + needle.length;
  }
  return n;
}

function splitLines(text) {
  // 纯 LF 口径：末尾换行不额外算一行
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function relTo(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

// ---------------------------------------------------------------- 文件体检

function inspectFile(abs) {
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, 8192);
  const binary = head.includes(0);

  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  let cr = 0;
  let ctl = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) cr++;
    else if (CTRL_BYTES.includes(b)) ctl++;
  }

  let lines = 0;
  if (!binary) {
    const text = buf.toString("utf8");
    lines = splitLines(text).length;
  }

  return {
    abs,
    bytes: buf.length,
    lines,
    bom,
    cr,
    ctl,
    binary,
    sha256: sha256(buf),
    text: binary ? null : buf.toString("utf8")
  };
}

// ---------------------------------------------------------------- assert

function cmdAssert(pos, flags) {
  const target = pos[0];
  if (!target) die("assert 需要文件路径：verify.mjs assert <file> --expect \"<文本>\"");

  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    console.log("FAIL  文件不存在：" + abs);
    process.exit(1);
  }

  const expect = typeof flags.expect === "string" ? flags.expect : null;
  if (expect === null) die("assert 需要 --expect \"<文本>\"");

  const info = inspectFile(abs);
  console.log("ASSERT  " + abs);
  console.log("  file   bytes=" + info.bytes + " lines=" + info.lines + " sha256=" + info.sha256);

  if (info.binary) {
    console.log("FAIL  该文件被判定为二进制（前 8192 字节含 0x00），无法做文本断言");
    process.exit(1);
  }

  if (typeof flags["at-line"] === "string") {
    const lineNo = Number(flags["at-line"]);
    if (!Number.isInteger(lineNo) || lineNo < 1) die("--at-line 需要正整数行号");
    const lines = splitLines(info.text);
    const actual = lines[lineNo - 1];
    console.log("  check  第 " + lineNo + " 行整行相等（共 " + lines.length + " 行）");
    console.log("  expect 「" + expect + "」");
    if (actual === expect) {
      console.log("  PASS   第 " + lineNo + " 行完全一致");
      process.exit(0);
    }
    console.log("  EXPECTED: 第 " + lineNo + " 行 = 「" + expect + "」");
    console.log("  ACTUAL  : 第 " + lineNo + " 行 = " + (actual === undefined ? "<该行不存在>" : "「" + actual + "」"));
    process.exit(1);
  }

  const want = typeof flags.count === "string" ? Number(flags.count) : OCCURRENCE_DEFAULT;
  if (!Number.isInteger(want) || want < 0) die("--count 需要非负整数");

  const actual = countOccurrences(info.text, expect);
  console.log("  check  出现次数恰好 = " + want);
  console.log("  expect 「" + expect + "」");
  if (actual === want) {
    console.log("  PASS   实际出现 " + actual + " 次");
    process.exit(0);
  }
  console.log("  EXPECTED: 出现 " + want + " 次");
  console.log("  ACTUAL  : 出现 " + actual + " 次");
  process.exit(1);
}

// ---------------------------------------------------------------- git status

function resolveRoot(flags) {
  const root = typeof flags.root === "string" ? path.resolve(flags.root) : process.cwd();
  if (!fs.existsSync(root)) die("--root 指向的目录不存在：" + root);
  return root;
}

function gitStatus(root) {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (r.error) die("git status 执行失败：" + r.error.message);
  if (r.status !== 0) die("git status 返回 " + r.status + "：" + (r.stderr || "").trim());
  return String(r.stdout || "")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  let rest = line.slice(3);
  if (rest.includes(" -> ")) rest = rest.split(" -> ").pop();
  return { status, rel: rest.trim() };
}

// ---------------------------------------------------------------- 规则文件

function loadRules(root) {
  const p = path.join(root, "verify.rules.json");
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      die("verify.rules.json 顶层必须是对象：{ \"相对路径\": [{ \"expect\": \"文本\", \"count\": 1 }] }");
    }
    return parsed;
  } catch (e) {
    die("verify.rules.json 不是合法 JSON：" + e.message);
  }
  return null;
}

function checkRulesFor(rel, info, rules) {
  if (!rules) return [];
  const items = rules[rel];
  if (!Array.isArray(items)) return [];
  const problems = [];
  for (const item of items) {
    if (!item || typeof item.expect !== "string") continue;
    const want = Number.isInteger(item.count) ? item.count : OCCURRENCE_DEFAULT;
    const actual = countOccurrences(info.text || "", item.expect);
    if (actual !== want) {
      problems.push("rules: 「" + item.expect + "」期望 " + want + " 次、实际 " + actual + " 次");
    }
  }
  return problems;
}

// ---------------------------------------------------------------- changed

function runChanged(root, opts) {
  const quiet = Boolean(opts && opts.quiet);
  const entries = gitStatus(root);
  const rules = loadRules(root);

  const rows = [];
  const problems = [];

  for (const line of entries) {
    const { status, rel } = parseStatusLine(line);
    if (!rel) continue;
    const abs = path.join(root, rel.split("/").join(path.sep));

    if (/D/.test(status) || !fs.existsSync(abs)) {
      rows.push({ rel, status, deleted: true });
      continue;
    }

    const info = inspectFile(abs);
    const rowProblems = [];
    if (!info.binary) {
      if (info.bom) rowProblems.push("含 BOM");
      if (info.cr > 0) rowProblems.push("CR=" + info.cr);
      if (info.ctl > 0) rowProblems.push("控制字符=" + info.ctl);
    }
    for (const p of checkRulesFor(rel, info, rules)) rowProblems.push(p);

    rows.push({
      rel,
      status,
      deleted: false,
      bytes: info.bytes,
      lines: info.lines,
      bom: info.bom,
      cr: info.cr,
      ctl: info.ctl,
      binary: info.binary,
      sha256: info.sha256,
      problems: rowProblems
    });

    if (rowProblems.length > 0) problems.push(rel + " → " + rowProblems.join("；"));
  }

  if (!quiet) {
    console.log("CHANGED  根目录 " + root);
    console.log("规则文件 " + (rules ? "verify.rules.json（已加载，键 " + Object.keys(rules).length + " 个）" : "无（跳过文本断言）"));
    console.log("");

    if (rows.length === 0) {
      console.log("  （git status --porcelain 为空：工作区干净，无改动文件）");
    } else {
      const head = ["状态", "文件", "字节", "行", "BOM", "CR", "控制符", "SHA256", "结论"];
      const body = rows.map((r) => {
        if (r.deleted) return [r.status, r.rel, "-", "-", "-", "-", "-", "-", "已删除（跳过）"];
        return [
          r.status,
          r.rel,
          String(r.bytes),
          String(r.lines),
          r.binary ? "bin" : r.bom ? "YES" : "no",
          String(r.cr),
          String(r.ctl),
          r.sha256.slice(0, 12) + "…",
          r.problems.length === 0 ? "OK" : "FAIL"
        ];
      });
      printTable(head, body);
    }

    console.log("");
    if (problems.length === 0) {
      console.log("结论  GREEN  " + rows.length + " 个改动文件，0 处问题");
    } else {
      console.log("结论  RED    " + rows.length + " 个改动文件，" + problems.length + " 处问题：");
      for (const p of problems) console.log("  - " + p);
    }
  }

  return { root, rows, problems, rules };
}

function printTable(head, body) {
  const widths = head.map((h, i) => {
    let w = displayWidth(h);
    for (const r of body) w = Math.max(w, displayWidth(r[i]));
    return w;
  });
  const line = (cells) =>
    cells
      .map((c, i) => c + " ".repeat(Math.max(0, widths[i] - displayWidth(c))))
      .join("  ")
      .replace(/\s+$/, "");
  console.log("  " + line(head));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of body) console.log("  " + line(r));
}

/** 东亚宽字符按 2 列算，保证中文表格不歪 */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    w += isWide(code) ? 2 : 1;
  }
  return w;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff)
  );
}

function cmdChanged(flags) {
  const root = resolveRoot(flags);
  const result = runChanged(root, {});
  process.exit(result.problems.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- release

function runNpm(root, args) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? process.env.ComSpec || "cmd.exe" : "npm";
  const argv = isWin ? ["/d", "/s", "/c", "npm " + args.join(" ")] : args;
  return spawnSync(cmd, argv, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function runNode(root, scriptRel) {
  return spawnSync(process.execPath, [scriptRel], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function checkPack(root) {
  const r = runNpm(root, ["pack", "--dry-run", "--json"]);
  if (r.error) return { ok: false, detail: "npm pack 执行失败：" + r.error.message, files: [], count: 0 };
  if (r.status !== 0) {
    return { ok: false, detail: "npm pack 退出码 " + r.status + "：" + String(r.stderr || "").trim().slice(0, 400), files: [], count: 0 };
  }
  let arr;
  try {
    arr = JSON.parse(String(r.stdout));
  } catch (e) {
    return { ok: false, detail: "npm pack --json 输出不是合法 JSON：" + e.message, files: [], count: 0 };
  }
  const entry = Array.isArray(arr) ? arr[0] : arr;
  const files = (entry && Array.isArray(entry.files) ? entry.files : []).map((f) => String(f.path || f.name || "").split(path.sep).join("/"));
  const bad = files.filter((p) => FORBIDDEN_IN_PACK.some((re) => re.test(p)));
  const detail = [];
  if (bad.length > 0) detail.push("入包含禁止路径：" + bad.join(", "));
  if (files.length !== EXPECTED_PACK_ENTRY_COUNT) detail.push("入包文件数 " + files.length + "，期望 " + EXPECTED_PACK_ENTRY_COUNT);
  return {
    ok: detail.length === 0,
    detail: detail.join("；") || "入包 " + files.length + " 个文件，无禁止路径",
    files,
    count: files.length,
    size: entry && entry.size,
    unpackedSize: entry && entry.unpackedSize,
    filename: entry && entry.filename
  };
}

function checkScanPrivate(root) {
  const scriptRel = "scripts/scan-private.mjs";
  if (!fs.existsSync(path.join(root, scriptRel.split("/").join(path.sep)))) {
    return { ok: false, detail: "缺少 " + scriptRel };
  }
  const r = runNode(root, scriptRel);
  if (r.error) return { ok: false, detail: "scan-private 执行失败：" + r.error.message, tail: "" };
  const out = String(r.stdout || "") + String(r.stderr || "");
  const tail = out.trim().split("\n").slice(-6).join("\n");
  if (r.status !== 0) return { ok: false, detail: "scan-private 退出码 " + r.status + "（期望 0）", tail };
  const blocker = /BLOCKER\s+([1-9]\d*)/.exec(out);
  if (blocker) return { ok: false, detail: "scan-private 报 BLOCKER " + blocker[1] + " 处", tail };
  return { ok: true, detail: "scan-private 退出码 0，无 BLOCKER", tail };
}

function copyPaths(root, suiteName) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const name = String(pkg.name || "");
  const parent = path.dirname(root);
  return [
    { label: "源码正本", abs: path.join(root, "lib", "index.js") },
    { label: "上级 node_modules", abs: path.join(parent, "node_modules", name, "lib", "index.js") },
    { label: "suite node_modules", abs: path.join(parent, suiteName, "node_modules", name, "lib", "index.js") }
  ];
}

function checkCopies(root, suiteName) {
  const rows = copyPaths(root, suiteName).map((c) => {
    if (!fs.existsSync(c.abs)) return { ...c, exists: false };
    const buf = fs.readFileSync(c.abs);
    return { ...c, exists: true, bytes: buf.length, sha256: sha256(buf) };
  });
  const missing = rows.filter((r) => !r.exists);
  const hashes = new Set(rows.filter((r) => r.exists).map((r) => r.sha256));
  let ok = missing.length === 0 && hashes.size === 1;
  let detail;
  if (missing.length > 0) detail = "缺失副本：" + missing.map((m) => m.label).join(", ");
  else if (hashes.size !== 1) detail = "三副本 SHA256 不一致（" + hashes.size + " 种）";
  else detail = "三副本 SHA256 全等 " + rows[0].sha256;
  return { ok, detail, rows };
}

function cmdRelease(flags) {
  const root = resolveRoot(flags);
  const suiteName = typeof flags.suite === "string" ? flags.suite : "dsh-loyalchiiina-suite";

  console.log("RELEASE 根目录 " + root);
  console.log("");

  const changed = runChanged(root, {});
  console.log("");

  const results = [];
  results.push({ name: "改动文件体检（changed）", ok: changed.problems.length === 0, detail: changed.problems.length === 0 ? "0 处问题" : changed.problems.join("；") });

  const pack = checkPack(root);
  results.push({ name: "npm pack 入包清单", ok: pack.ok, detail: pack.detail });
  if (pack.ok) {
    console.log("入包 " + pack.count + " 个文件（size=" + pack.size + " / unpackedSize=" + pack.unpackedSize + "）：");
    for (const f of pack.files) console.log("  - " + f);
    console.log("");
  }

  const scan = checkScanPrivate(root);
  results.push({ name: "私有信息扫描（scan-private）", ok: scan.ok, detail: scan.detail });
  if (scan.tail) {
    console.log("scan-private 输出（末 6 行）：");
    for (const l of scan.tail.split("\n")) console.log("  " + l);
    console.log("");
  }

  const copies = checkCopies(root, suiteName);
  results.push({ name: "三副本 SHA256（源 / 上级 node_modules / suite）", ok: copies.ok, detail: copies.detail });
  console.log("三副本明细：");
  for (const r of copies.rows) {
    console.log("  " + (r.exists ? "OK  " : "MISS") + "  " + r.label.padEnd(16) + "  " + (r.exists ? r.bytes + " B  " + r.sha256 : "<不存在>"));
    console.log("        " + r.abs);
  }
  console.log("");

  console.log("检查项汇总：");
  printTable(
    ["检查项", "结论", "说明"],
    results.map((r) => [r.name, r.ok ? "PASS" : "FAIL", r.detail])
  );

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length === 0) {
    console.log("结论  GREEN  " + results.length + " 类检查全部通过，可以进入发版流程");
    process.exit(0);
  }
  console.log("结论  RED    " + failed.length + " 类检查未通过：" + failed.map((f) => f.name).join("；"));
  process.exit(1);
}

// ---------------------------------------------------------------- 入口

function main() {
  const argv = process.argv.slice(2);
  const { flags, pos } = parseArgs(argv);
  const sub = pos[0];

  if (!sub || flags.help || sub === "help") {
    usage();
    process.exit(sub ? 0 : 2);
  }

  switch (sub) {
    case "assert":
      cmdAssert(pos.slice(1), flags);
      break;
    case "changed":
      cmdChanged(flags);
      break;
    case "release":
      cmdRelease(flags);
      break;
    default:
      usage();
      die("未知子命令：" + sub);
  }
}

main();