// 用法: node test/config-tier-spawnreuse.test.mjs
// 1.3.3（#1）专项：spawnReuseGate 必须是**真能配**的开关（曾经只有读取点，没有写入入口 → 恒 enforce）。
// 逻辑**从真实 lib/index.js 抽出**，不改写：TIER_NAMES / TIER_PRESETS / _CONFIG_BASELINE /
// resolveTierPreset / toInt / CUSTOM_INT_FIELDS / validateCustomValues / buildActiveTier。
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

// 一次抽全：从档名表到注入文本之前（含 baseline / ACTIVE_TIER 初值 / 校验器 / 合成器）
const configBlock = sliceBetween("var TIER_NAMES", "var LAW_SECTION_NAME =", "config block");
const C = new Function(
  configBlock + "\n" +
  "return { TIER_NAMES: TIER_NAMES, TIER_PRESETS: TIER_PRESETS, BASELINE: _CONFIG_BASELINE, ACTIVE: ACTIVE_TIER, v: validateCustomValues, build: buildActiveTier };"
)();

// 自定义档的 5 个旧键（1.1.2 时代就有的，必须全填才合法）
const LEGACY = { gateMinDispatches: 2, gateMaxParallel: 6, gateMaxStrikes: 4, waitAgentGate: "warn", enforceTeamGate: "on" };

// 01 三个档位都在，且每档都带 spawnReuseGate（少一个 = 该档退回 undefined = 读取点兜底 enforce，等于该档没配）
t("01", "#1 三档预设都声明了 spawnReuseGate",
  C.TIER_NAMES.map((k) => typeof C.TIER_PRESETS[k].spawnReuseGate), ["string", "string", "string"]);

// 02 默认值分布：lean 只观测（warn）、balanced/turbo 拦截（enforce）—— 与各档严格度同向
t("02", "#1 档位默认值：lean=warn / balanced=enforce / turbo=enforce",
  C.TIER_NAMES.map((k) => C.TIER_PRESETS[k].spawnReuseGate), ["warn", "enforce", "enforce"]);

// 03 走真实合成器拿三档生效值（不是直接读常量）—— 证明 buildActiveTier 没把字段吃掉
t("03", "#1 buildActiveTier 三档都透传 spawnReuseGate",
  [C.build("lean").spawnReuseGate, C.build("balanced").spawnReuseGate, C.build("turbo").spawnReuseGate],
  ["warn", "enforce", "enforce"]);

// 04 非法档名 → custom 态，走 baseline
t("04", "#1 非法档名回落 custom 态，取 baseline 的 enforce",
  [C.build("nope").name, C.build("nope").source, C.build("nope").spawnReuseGate], ["custom", "config", "enforce"]);

// 05 baseline 必须显式带该键（否则 custom 态拿 undefined，读取点虽兜底但语义不清）
t("05", "#1 _CONFIG_BASELINE 显式声明 spawnReuseGate=enforce", [C.BASELINE.spawnReuseGate], ["enforce"]);

// 06 零回归：老配置（只有 5 个旧键、没有新键）必须仍然合法，且新键静默回落 enforce
const legacyOk = C.v(LEGACY);
t("06", "#1 老配置（5 个旧键、无 spawnReuseGate）仍合法且回落 enforce",
  [legacyOk !== null, legacyOk && legacyOk.spawnReuseGate, C.build("custom", LEGACY).source], [true, "enforce", "custom"]);

// 07 warn 档可达
t("07", "#1 customValues.spawnReuseGate=warn 生效",
  [C.build("custom", Object.assign({}, LEGACY, { spawnReuseGate: "warn" })).spawnReuseGate], ["warn"]);

// 08 off 档可达（off = 整个 F4 分支不介入，lib 内已有 spawnReuseGate !== "off" 的判据）
t("08", "#1 customValues.spawnReuseGate=off 生效",
  [C.build("custom", Object.assign({}, LEGACY, { spawnReuseGate: "off" })).spawnReuseGate], ["off"]);

// 09 非法值静默回落 enforce（不整份失效，也不抛错）
t("09", "#1 customValues.spawnReuseGate=乱填 → 回落 enforce，且其余字段照常生效",
  [C.build("custom", Object.assign({}, LEGACY, { spawnReuseGate: "bogus" })).spawnReuseGate,
   C.build("custom", Object.assign({}, LEGACY, { spawnReuseGate: "bogus" })).gateMaxParallel],
  ["enforce", 6]);

// 10 旧键缺失仍判非法（新键的宽松不能反过来放松旧键的严格）
t("10", "#1 旧键缺失仍然整体非法（返回 null → custom 态不生效）",
  [C.v({ gateMinDispatches: 2, gateMaxParallel: 6 })], [null]);

// ================= 1.3.3(#7)：命名档下 local.json 显式键覆盖 preset =================
// 事故背景：用户在 turbo 档把 enforceTeamGate 写成 off，闸门却照样拦 —— 因为命名档直接返回 preset
// 写死的 true，local 值被无视，而 /status 还显示 true，人只会判「改了没用」。
// 判据必须是 hasOwnProperty：只要 local.json **显式写了**这个键就覆盖，写着 false / 0 / "off" 也算显式。

// 11 命名档 + 显式 off → 覆盖生效，且 source 仍是 tier、只列这一个被覆盖的键
const turboOff = C.build("turbo", { enforceTeamGate: "off" });
t("11", "#7 turbo + {enforceTeamGate:off} → 实际生效 false，source 仍 tier，overriddenKeys=[enforceTeamGate]",
  [turboOff.enforceTeamGate, turboOff.source, turboOff.name, turboOff.overriddenKeys],
  [false, "tier", "turbo", ["enforceTeamGate"]]);

// 12 命名档 + spawnReuseGate:off → F4 整个分支不介入
const turboSpawnOff = C.build("turbo", { spawnReuseGate: "off" });
t("12", "#7 turbo + {spawnReuseGate:off} → off，且未提供的键仍取 preset",
  [turboSpawnOff.spawnReuseGate, turboSpawnOff.gateMaxParallel, turboSpawnOff.gateMinDispatches, turboSpawnOff.overriddenKeys],
  ["off", 10, 3, ["spawnReuseGate"]]);

// 13 什么都不提供 → 与直接 build("turbo") 完全一致（覆盖逻辑不得污染默认路径）
t("13", "#7 turbo + {} → 与 build(turbo) 逐字段一致，overriddenKeys=[]",
  [C.build("turbo", {}), C.build("turbo", null)],
  [C.build("turbo"), C.build("turbo")]);

// 14 假值（0 / false）是真值判断最容易踩的坑：0 必须覆盖，不能被当成「没提供」
const strikesZero = C.build("turbo", { gateMaxStrikes: 0 });
t("14", "#7 gateMaxStrikes:0 属显式提供 → 覆盖成 0（真值判断会漏掉），其余键不动",
  [strikesZero.gateMaxStrikes, strikesZero.gateMaxParallel, strikesZero.overriddenKeys],
  [0, 10, ["gateMaxStrikes"]]);
const boolFalse = C.build("lean", { enforceTeamGate: false });
t("15", "#7 enforceTeamGate:false（布尔假值）同样算显式提供 → 覆盖，不再回落 preset true",
  [boolFalse.enforceTeamGate, boolFalse.overriddenKeys], [false, ["enforceTeamGate"]]);

// 16 非法值不覆盖（宁可按 preset 跑，也不把脏值传进闸门）
const dirty = C.build("turbo", {
  spawnReuseGate: "bogus", waitAgentGate: "bogus", enforceTeamGate: "maybe", gateMaxParallel: 99,
});
t("16", "#7 非法值一律不覆盖（4 个脏值全被拒，overriddenKeys 为空）",
  [dirty.spawnReuseGate, dirty.waitAgentGate, dirty.enforceTeamGate, dirty.gateMaxParallel, dirty.overriddenKeys],
  ["enforce", "enforce", true, 10, []]);

// 17 多键同时覆盖：顺序按 LOCAL_OVERRIDE_KEYS 固定，便于 /status 稳定显示
t("17", "#7 多键同时覆盖 → overriddenKeys 按固定顺序列出",
  [C.build("turbo", { waitAgentGate: "warn", gateMinDispatches: 1 }).overriddenKeys],
  [["gateMinDispatches", "waitAgentGate"]]);

// 18 fix#1：/status 的 gateLog 映射必须把 wait 条目的 released 带出来（源码级断言，配合变异自证）
t("18", "#7 /status gateLog 映射带 released 字段，且 tiers 暴露 overriddenKeys",
  [src.includes("released: (g.released || null)"), src.includes("overriddenKeys: (ACTIVE_TIER && Array.isArray(ACTIVE_TIER.overriddenKeys))")],
  [true, true]);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);