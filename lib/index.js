// dsh-agent-team-auto-orchestrator - host half.
//
// v0.2.0：在 v0.1.0 的「常驻提示」之上，加一层「工具层硬门」。
//
// v0.3.0（2026-11-08，用户批准 A+A′+B+C+D 全套）：修「任务板只增不派」。
//   实测根因：v0.2.x 把 team_task_create 也算作「已开团队」，于是模型选成本最低的
//   过关路径 —— 建一条任务板 → 闸门放行 → 全程自己干；任务板只增不派、子代理一个不开。
//   本次改动：① 工具集合拆分 —— TEAM_OPEN_TOOLS 剔除 team_task_create（只认新开执行者）、
//   另立 DISPATCH_TOOLS 计入 send_message；② gateMaxStrikes 2→4
//   并在拒绝理由里回显剩余次数；③ LAW_TEXT 改写（任务板只留痕 / 建完必 claim /
//   通道选择表：预设用 subagent，常驻多轮用 spawn_teammate）；④ 拒绝理由改为
//   「先派活、再留痕」，并明确「只建任务板不算开团队」。
//
// 为什么加：提示是建议，模型可以不理。用户要求「Fluent 模拟 / 插件开发 / DSH 排查 /
// 8 个预设相关任务必须硬启动团队」，那就必须在工具分发层强制，而不是靠自觉。
//
// 四层判定（结构照抄 dsh-todo-float-ball v0.13.2 的已验证写法，含 fail-open 与防死循环）：
//   第 0 层 域识别：订阅 agent/inbox/claimed，缓存本轮用户消息，用关键词判 fluent /
//          plugin / dsh / preset 四域。入域则本轮「除豁免名单外全部工具」都要先开团队。
//          未入域时只拦动手类工具（pwsh / bash / write / edit / mcp__ansys-fluent__*）。
//   第 1 层 状态判定：扫 session.snapshotEvents()，本轮出现过 subagent /
//          subagent_fork / spawn_teammate 任一，才视为「已开团队」。
//          ⚠️ team_task_create 不在其列（v0.3.0 起）：建任务板只是留痕，不等于派活。
//   第 2 层 拦截：未开团队 → { kind: "deny", reason } ，理由里写清该域的范围与过关两步。
//   第 3 层 防死循环：同一 turn 最多拦 gateMaxStrikes 次（默认 4），之后放行。
//          （dsh-todo-float-ball 踩过「计数卡死」事故，这个保险必须留。）
//
// 🔴 所有路径 try/catch → fail-open。宁可闸门不生效，绝不阻塞正常工作。
//
// 配置开关（都在 cordis.patch.yml 的 config 行里翻）：
//   injectLaw        (默认 true)  是否注册常驻 prompt 段
//   enforceTeamGate  (默认 true)  是否启用工具层硬门
//   gateMaxStrikes   (默认 4)     同一 turn 最多拦几次
//   gateDomains      (默认四域)   哪些域触发「全量拦截」
//   gateMaxParallel  (默认 6)     并行契约封顶路数；合法 2~16，非法值回落 6 并记 gateLog（1.1.2 新增）

import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 版本从 package.json 读，避免与发布版本漂移。
var PKG_VERSION = (function () {
  try {
    var here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch (e) {
    return "unknown";
  }
})();

var ROUTE_PREFIX = "/dsh-team-orchestrator";

// ── 常驻 prompt 段 ──────────────────────────────────────────────────────────
// 字符预算：模板本体 3709 字符 / 65 段 · 运行时替换路由后 3848 字符（本机 gateMaxParallel=10；
// =6 时为 3846）。无硬截断，全文注入。
// system-prompt 段是每一轮、每个会话都发，是永久 token 成本，所以只留最硬的条款；细节留在 agent-team-routing-law 技能里。
// ── 本机配置层（v0.3.2）──────────────────────────────────────────────────────
// 发布包里**只含通用默认**。本机专属内容（预设路由表 / 业务域关键词 / profile 名）
// 从 `<DSH_HOME>/team-orchestrator.local.json` 读 —— 该文件在**插件目录之外**，
// 所以 `npm pack` / `git push` 结构上就打不进去（不是靠"记得别提交"）。
//
//   优先级：环境变量 > local.json > 插件包内 cordis.patch.yml 的 config > 代码默认
//   容错  ：文件不存在 / JSON 坏 / 字段类型不对 → 全部回退默认，只影响行为不阻塞工作
//   热重载：按 mtime 检测；改 local.json 后**下次工具调用即重建 ACTIVE_TIER**（无需重启 DSH）。
//           注入正文同样是热更的，别被旧注释误导：
//             · 注入 section 的 text 是**函数求值**（text: function () { return ACTIVE_LAW_TEXT; }），
//               不是启动时定死的字符串常量；
//             · refreshActiveConfig 在每个工具调用入口（监听器）都会调一次，
//               按 local.json 的 mtime 重建 ACTIVE_TIER + ACTIVE_LAW_TEXT。
//           所以改 presetRoutes / 切档位后**下一个 model step 就吃到新注入**，
//           代价只是上游 prompt cache 失效一次（不做硬截断，全文注入）。
//           ⚠️ 唯一例外：ACTIVE_TIER.enforceTeamGate === false（关闸）时，监听器入口
//           直接 return next()、refresh 被跳过 → 此时改 local.json 不再热更，
//           必须彻底退出 DSH 再启动才生效。

var LOCAL_CONFIG_FILE = "team-orchestrator.local.json";

// 预设路由表：空数组 = 公开版默认（拒绝理由只建议 spawn_teammate，不吐任何预设 id）。
// 本机形状：[{ key:"plugin", label:"插件/DSH 配置", presetId:"<你的预设 config.id>" }, ...]
var DEFAULT_PRESET_ROUTES = [];

var DEFAULT_PROFILE_NAME = "desktop";

var _localCache = { path: "", mtime: -1, data: null };

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function loadLocalConfig() {
  var p = join(dshHome(), LOCAL_CONFIG_FILE);
  try {
    var st = statSync(p);
    if (_localCache.path === p && _localCache.mtime === st.mtimeMs) return _localCache.data;
    var raw = readFileSync(p, "utf8");
    var data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    _localCache = { path: p, mtime: st.mtimeMs, data: data };
    return data;
  } catch (e) {
    _localCache = { path: p, mtime: -1, data: null };
    return null;
  }
}

// 把 local.json 的 presetRoutes 规范成 [{key,label,presetId}]，非法项静默丢弃。
function resolvePresetRoutes(cfg) {
  try {
    var r = cfg && cfg.presetRoutes;
    if (Array.isArray(r)) {
      var out = [];
      for (var i = 0; i < r.length; i++) {
        var it = r[i];
        if (!it || typeof it !== "object") continue;
        if (typeof it.presetId !== "string" || !it.presetId) continue;
        if (typeof it.key !== "string" || !it.key) continue;
        out.push({
          key: it.key,
          label: (typeof it.label === "string" && it.label) ? it.label : it.key,
          presetId: it.presetId
        });
      }
      return out;
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_PRESET_ROUTES.slice();
}

// 运行时生效值（由 apply() 调用 refreshActiveConfig() 重建；热重载时就地更新）
var ACTIVE_DOMAIN_RULES = null; // 初值在 DOMAIN_RULES 定义后设置
var ACTIVE_PRESET_ROUTES = DEFAULT_PRESET_ROUTES.slice();
var ACTIVE_PROFILE_NAME = DEFAULT_PROFILE_NAME;
var ACTIVE_LAW_TEXT = "";
// 1.1.2：并行契约封顶路数（gateMaxParallel 的**生效值**）。
// 为什么放模块级：注入文本要在启动时按它渲染（buildLawText 里的 @@MAXPAR@@），
// 而 buildLawText 由 refreshActiveConfig 调用、拿不到 apply() 的 config 参数。
var ACTIVE_GATE_MAX_PARALLEL = 6;
var _activeMtime = null; // 上次重建时 local.json 的 mtime（热重载判据）

// ── 1.2.0 三档中控台 ────────────────────────────────────────────────────────
// 用户 2026-11-09 定：设置页只显示参数 + 手动切换按钮，不自动联动推导。
// 档位 = 「生效值快照」，不是配置项：闸门、注入文本、/status、预算面板都只读
// ACTIVE_TIER（全插件唯一读取点），由 refreshActiveConfig() 从 local.json 的
// tier 字段合成 —— 杜绝「闸门用 A 值、文本用 B 值」的双真值源漂移。
var TIER_NAMES = ["lean", "balanced", "turbo"];

var TIER_PRESETS = {
  lean: {
    labelZh: "省 Token",
    labelEn: "Token-saver",
    summaryZh: "能自己做就自己做，实在拆不开才派一路",
    summaryEn: "Do it yourself whenever possible; dispatch only when unavoidable",
    gateMinDispatches: 1,
    gateMaxParallel: 2,
    gateMaxStrikes: 2,
    waitAgentGate: "warn",
    spawnReuseGate: "warn",
    enforceTeamGate: true,
    injectLaw: true,
    maxMembers: 4,
    maxActiveSubagents: 8
  },
  balanced: {
    labelZh: "中规中矩",
    labelEn: "Balanced",
    summaryZh: "默认档：多文件多插件的活按并行拆，单点活自己做",
    summaryEn: "Default: split multi-file work in parallel, keep point tasks on the lead",
    gateMinDispatches: 2,
    gateMaxParallel: 4,
    gateMaxStrikes: 4,
    waitAgentGate: "warn",
    spawnReuseGate: "enforce",
    enforceTeamGate: true,
    injectLaw: true,
    maxMembers: 8,
    maxActiveSubagents: 16
  },
  turbo: {
    labelZh: "超级高效",
    labelEn: "Turbo",
    summaryZh: "该并行的一律并行，未派满就拦死",
    summaryEn: "Always fan out; deny until the declared degree is actually dispatched",
    gateMinDispatches: 3,
    gateMaxParallel: 10,
    gateMaxStrikes: 4,
    waitAgentGate: "enforce",
    spawnReuseGate: "enforce",
    enforceTeamGate: true,
    injectLaw: true,
    maxMembers: 16,
    maxActiveSubagents: 32
  }
};

// 「自定义」基线：local.json 没有 tier 字段时，完全沿用 1.1.2 的 config 解析结果。
// 这样升级到 1.2.0 不会偷偷改任何人的现有行为（零回归，见 §1.3 D2）。
// ⚠️ 必须在第一次 refreshActiveConfig(true) 之前填好（见改动 4）。
var _CONFIG_BASELINE = {
  gateMinDispatches: 1,
  gateMaxParallel: 6,
  gateMaxStrikes: 4,
  waitAgentGate: "warn",
  spawnReuseGate: "enforce",
  enforceTeamGate: true,
  injectLaw: true
};

// 当前生效值快照（唯一读取点）。name = "lean" | "balanced" | "turbo" | "custom"。
// source = "tier"（来自 local.json 的 tier 字段）| "config"（custom 态，来自 cordis.patch.yml）。
// 初值取 custom，与 1.1.2 等价；apply() 里第一次 refreshActiveConfig 会重新合成。
var ACTIVE_TIER = {
  name: "custom",
  source: "config",
  gateMinDispatches: 1,
  gateMaxParallel: 6,
  gateMaxStrikes: 4,
  waitAgentGate: "warn",
  spawnReuseGate: "enforce",
  enforceTeamGate: true,
  maxMembers: 16,
  maxActiveSubagents: 20
};

// 档名 → 预设；非法/缺失返回 null（调用方据此落到 custom 态）。
function resolveTierPreset(tierName) {
  var k = String(tierName == null ? "" : tierName);
  if (TIER_NAMES.indexOf(k) < 0) return null;
  return TIER_PRESETS[k];
}

// 数值收敛：空/非数字/越界一律返回 null（调用方据此判非法，不做「就近取整」的宽容）。
// 服务端是范围权威 —— 前端 type="number" 只是提示，任何值都要过这里。
function toInt(v, lo, hi) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  if (!isFinite(n)) return null;
  n = Math.floor(n);
  if (n < lo || n > hi) return null;
  return n;
}

// 自定义档的 3 个整数项（字段名 / 下界 / 上界）。
// 另有枚举项不走这张表、在下面单独校验：waitAgentGate（warn|enforce）、enforceTeamGate（on|off，
// 也容忍 true/false）；1.3.3 起再加可选枚举项 spawnReuseGate（warn|off，缺失/非法回落 enforce）。
var CUSTOM_INT_FIELDS = [
  ["gateMinDispatches", 1, 6],
  ["gateMaxParallel", 2, 16],
  ["gateMaxStrikes", 0, 10],
];

// 自定义档校验：合法 → 可编辑项对象；非法 → null（调用方保留 baseline）。
// 两项枚举：waitAgentGate 只认 warn|enforce；enforceTeamGate 收 on/off（也容忍 true/false）。
// 1.3.3（#1）：spawnReuseGate 只认 warn|off，缺省/其它值静默回落 "enforce"（可选键，不参与合法性判定）。
function validateCustomValues(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  var out = {};
  for (var i = 0; i < CUSTOM_INT_FIELDS.length; i++) {
    var f = CUSTOM_INT_FIELDS[i];
    var n = toInt(raw[f[0]], f[1], f[2]);
    if (n === null) return null;
    out[f[0]] = n;
  }
  var w = String(raw.waitAgentGate == null ? "" : raw.waitAgentGate);
  if (w !== "warn" && w !== "enforce") return null;
  out.waitAgentGate = w;
  var e = String(raw.enforceTeamGate == null ? "" : raw.enforceTeamGate);
  if (e === "true" || e === "1") e = "on";
  if (e === "false" || e === "0") e = "off";
  if (e !== "on" && e !== "off") return null;
  out.enforceTeamGate = (e === "on");
  // 1.3.3（#1）：spawnReuseGate 为**可选**新键 —— 缺失或非法一律回落 "enforce"，
  // 绝不因此让整份自定义配置失效（老配置仍按 1.1.2 行为跑，零回归）。
  var g = String(raw.spawnReuseGate == null ? "" : raw.spawnReuseGate);
  out.spawnReuseGate = (g === "warn" || g === "off") ? g : "enforce";
  return out;
}

// 1.3.3（#7）：命名档下「local.json 显式提供了这个键」要能覆盖 preset 的同名键。
// 判据必须是 hasOwnProperty（显式提供），不能用真值判断 —— false / 0 / "off" 都是合法值，
// 真值判断会把它们当成「没提供」而不覆盖，正是「在 turbo 档关了闸却没生效」那类事故。
// 只覆盖 6 个行为键；maxMembers / maxActiveSubagents 是宿主实测值，不在覆盖范围。
var LOCAL_OVERRIDE_KEYS = [
  "gateMinDispatches", "gateMaxParallel", "gateMaxStrikes",
  "waitAgentGate", "spawnReuseGate", "enforceTeamGate"
];

// undefined = 未显式提供或值非法（保持 preset 原值）；否则返回归一化后的值。
function pickLocalOverride(values, key) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(values, key)) return undefined;
  var raw = values[key];
  if (key === "waitAgentGate") {
    var w = String(raw == null ? "" : raw);
    return (w === "warn" || w === "enforce") ? w : undefined;
  }
  if (key === "spawnReuseGate") {
    var g = String(raw == null ? "" : raw);
    return (g === "warn" || g === "off") ? g : undefined;
  }
  if (key === "enforceTeamGate") {
    var e = String(raw == null ? "" : raw);
    if (e === "on" || e === "true" || e === "1") return true;
    if (e === "off" || e === "false" || e === "0") return false;
    return undefined;
  }
  for (var i = 0; i < CUSTOM_INT_FIELDS.length; i++) {
    if (CUSTOM_INT_FIELDS[i][0] === key) {
      var n = toInt(raw, CUSTOM_INT_FIELDS[i][1], CUSTOM_INT_FIELDS[i][2]);
      return (n === null) ? undefined : n;
    }
  }
  return undefined;
}

// 合成生效值快照。tierName 非法 → custom 态（读 _CONFIG_BASELINE）。
// 生效优先级（1.3.3 #7）：local.json **显式提供**的键 > 命名档 preset > 代码默认（_CONFIG_BASELINE）。
// 「显式提供」的判据是 hasOwnProperty —— 写 false / 0 / "off" 都算提供，不能用真值判断（0 会被当没写）。
// ⚠️ 本函数只做纯计算，不写盘、不改全局 —— 赋值由 refreshActiveConfig 统一完成。
function buildActiveTier(tierName, customValues) {
  var preset = resolveTierPreset(tierName);
  if (preset) {
    var tierOut = {
      name: String(tierName),
      source: "tier",
      gateMinDispatches: preset.gateMinDispatches,
      gateMaxParallel: preset.gateMaxParallel,
      gateMaxStrikes: preset.gateMaxStrikes,
      waitAgentGate: preset.waitAgentGate,
      spawnReuseGate: preset.spawnReuseGate,
      enforceTeamGate: preset.enforceTeamGate,
      maxMembers: preset.maxMembers,
      maxActiveSubagents: preset.maxActiveSubagents,
      // 1.3.3（#7）：本档被 local.json 显式覆盖掉的键名（空数组 = 完全按 preset 跑）
      overriddenKeys: []
    };
    for (var oi = 0; oi < LOCAL_OVERRIDE_KEYS.length; oi++) {
      var okey = LOCAL_OVERRIDE_KEYS[oi];
      var oval = pickLocalOverride(customValues, okey);
      if (oval !== undefined && oval !== tierOut[okey]) {
        tierOut[okey] = oval;
        tierOut.overriddenKeys.push(okey);
      }
    }
    return tierOut;
  }
  // 非命名档：先试自定义档（用户在表格里手改的那 8 项），命中就用它；
  // 不合法/未设置 → 退回 _CONFIG_BASELINE（= 1.1.2 行为），保证闸门永远拿得到确定值。
  var custom = validateCustomValues(customValues);
  if (custom) {
    return {
      name: "custom",
      source: "custom",
      // 1.3.3（#7）：custom 档本身就是用户显式值，不再单列「被覆盖的键」
      overriddenKeys: [],
      gateMinDispatches: custom.gateMinDispatches,
      gateMaxParallel: custom.gateMaxParallel,
      gateMaxStrikes: custom.gateMaxStrikes,
      waitAgentGate: custom.waitAgentGate,
      spawnReuseGate: custom.spawnReuseGate,
      enforceTeamGate: custom.enforceTeamGate,
      // custom 态不带 injectLaw（只读项），两个成员数沿用本机实测占位值
      maxMembers: 16,
      maxActiveSubagents: 20
    };
  }
  return {
    name: "custom",
    source: "config",
    overriddenKeys: [],
    gateMinDispatches: _CONFIG_BASELINE.gateMinDispatches,
    gateMaxParallel: _CONFIG_BASELINE.gateMaxParallel,
    gateMaxStrikes: _CONFIG_BASELINE.gateMaxStrikes,
    waitAgentGate: _CONFIG_BASELINE.waitAgentGate,
    spawnReuseGate: _CONFIG_BASELINE.spawnReuseGate,
    enforceTeamGate: _CONFIG_BASELINE.enforceTeamGate,
    // 经济阈值 1.1.2 是写死在注入文本里的 2000 / 15 / 10000，custom 态原样继承，
    // 保证「升级后注入文本与 1.1.2 逐字一致」。
    // custom 态的两个成员数只是占位（真实值由 readHostLimits() 现读 YAML 提供），
    // 这里写 1.1.2 的本机实测值，避免调用方拿到 undefined。
    maxMembers: 16,
    maxActiveSubagents: 20
  };
}

var LAW_SECTION_NAME = "team-orchestrator-law";
var LAW_SECTION_ORDER = 250;

var LAW_TEXT_TEMPLATE = [
  "〇、先判，再动手",
  "收到任务别急着列清单。先在心里问三句：① 这件事做错了，我需要中途叫停或改口吗？② 它能和别人同时做吗？③ 该我做，还是该交出去？",
  "分类在心里完成、不占工具调用；但每轮第一个工具调用仍然是 todo_write —— 先想清楚，第一份清单就该是分好类的。",
  "末节是工具层硬门，破了会被当场拒绝，务必看完。",
  "一、要不要交出去：两条判据",
  "剂量：一句话能答完、一两次工具调用就能落地（读一个文件、查一个参数、改一行字、回一句话）→ 零碎活自己做，别占人、别开子代理。",
  "**复杂度下限（1.5.10 新增，与上面的剂量一起判）**：≥3 个独立产出物（各写不同文件）且每个预计 ≥50 行 → **必须开团队**，不许自己串行吞完；单件大活（>150 行）→ 主会话自己做（单件没有并行收益，开成员反而多付前缀）；预计 ≤4 轮工具 → 自己做。判不准时宁可自己干，但不得把「多文件 + 多轮」的活全吞。",
  "性质：不可逆、做完就安心（查资料、核参数、收集信息、既定事实）→ 可以交出去，也适合并行；可能返工、要边做边聊、会中途变向 → 留在主线，或交给能随时沟通的成员。",
  "要读一堆材料、跨多个文件、跑好几轮、或要等很久 → 一律交出去，别自己闷头干。",
  "新开一个代理的固定开销与任务大小无关（每开一个新的都要重新付一遍完整上下文）—— 小任务开新代理必亏：能自己做就自己做，能盘活空闲队员就盘活（前缀只付一次、之后反复接活）。",
  "二、交给谁：看「能不能反悔」",
  "做错要立刻刹车、要中途补话 → 常驻成员（spawn_teammate）：能喊停、能改口、能反复接活。",
  "做错也不怕、跑完再改就行、且确认这活不会再来第二遍 → 才可以考虑一次性执行者（subagent），但还须满足下面「subagent 的正当用途只有两条」；只要还可能复用，就建 teammate —— 它付一次前缀能反复接活，subagent 每开一个都要重付一遍完整前缀。",
  "只有 subagent 能指定预设；常驻成员继承主对话当前预设，不能单独指定。",
  "**subagent 的正当用途只有两条**：① 这个活必须在某个专用预设下执行（照第十节「预设路由」取预设 id，用 subagent(agent_preset=X)）；② 团队成员已经满 16 人且全部在忙、确实没人可复用。其余一切情况：先 send_message 复用现有空闲成员；若无空闲成员，改用 spawn_teammate 建常驻成员。不要开 subagent —— teammate 付一次前缀就能反复接活，subagent 每开一个都要重付一遍完整前缀。这条是硬门：不带 agent_preset 的 subagent，只要不满足「满员且全忙」就直接被拒绝。",
  "`agent_preset` 能不能用，取决于本机预设有没有配白名单：若报「selection is disabled」或「must be one of」，说明本机没开预设选择 —— 直接用当前预设 / 盘活队员把活干完，不要反复试。",
  "常驻成员不给身份、不设专长，人格统一为「牛马」：能批量啃各类任务，高效、认真、又快又好，不挑活、不抱怨、不兜圈子。",
  "生米煮成熟饭最忌讳：派出去就撤不回来（子代理尤其——它跑着时你也叫不动）。",
  "三、选谁做：判三件事，顺序不能换",
  "① 会不会被重启打断：要改宿主端代码、要重启才能验、要跨多轮长跑 → **不能派 subagent**，改成我自己做 / 派 teammate / 或者先停手问用户「这里需要重启，什么时候方便」。",
  "② 做错了要不要能喊停：要能中途踩刹车、要补话改方向 → teammate；一次跑完再改就行、不需要对话 → 才可以考虑 subagent，但还得满足第二节那两条硬条件（必须指定预设 / 满员 16 且全忙），否则一律 teammate。",
  "③ 值不值得开：一两句话能答完、一两次工具调用就能落地 → 自己做，别为这点活开一个代理。",
  "四、拆了就同时发",
  "声明几路就是几路，同一条消息里一次全部发出。「派一个、等它回来、再派下一个」是伪装并行，等于没并行。",
  "要并行就在 todo 条目里显式标【并行】；要声明路数写【并行×N】（也认 [并行]、「并行」、（并行））。没标标记的条目不计入并行数。",
  "路数只数派出去的执行者，不含你自己，也不超过当前上限 @@MAXPAR@@ 路。",
  "不标【并行】就不会有任何派活要求；标了就必须在一步里真发满。能并行而不标，是你自己承担效率损失。",
  "五、先派给有空的人",
  "**开工第一步就查花名册**：动手前先 `list_agents`（跟 `todo_write` 并列，都是每轮的固定开场动作）——不查就派活 = 违规。",
  "本对话有自己的成员池（每个对话独立一份）。开工前先 list_agents 看谁空着：",
  "① **任何**空闲成员（inactive）—— 不管是员工N号，还是早先建的专职成员 —— 一律 send_message 交给它，不管它上一个活是什么；能复用就不新建。",
  "② 空闲的人不够同时开工 → 才新建，补到**正好够用**为止，不凑固定个数；编号接着往后排，只增不减。",
  "③ 全员在忙、**确实没有人空闲**，且团队已满 16 人 → 才允许开 subagent（不满 16 仍应新建 teammate）。",
  "④ 手里同时有 N 个互不依赖的活 → **就把 N 个活同时分给 N 个不同的空闲成员**（同一个 step 内一次发完）；禁止把活排成队、一个接一个地喂给同一个成员 —— 那样即使有 10 个人也只有一个在干。",
  "每次准备新建成员之前，必须**在同一个 step 里先重新 list_agents** 刷新花名册；不许用上一步或更早的旧结果判断「有没有空人」。查到任何空闲成员就直接 send_message，不许新建。",
  "派活前除了查「谁空闲」，还要**对一眼上一步派过什么** —— 同一个活不要重复派两遍。",
  "名额满了**只影响「新建」**，唤醒现有成员永远可用；哪怕显示 16/16 已满，只要名单里有人 inactive，就必须 send_message 唤醒它，**绝不许因为「满了」就改用 subagent**。",
  "派活时谁空闲就把活给它 —— 别自己干，也别开新的（除非都在忙、且确实没人空闲）。",
  "能派出去的活，优先分给空闲的常驻成员：成员闲着就是浪费，不是省钱。",
  "subagent 只按第二节那两条判定（必须指定预设 / 满 16 且全忙）；其余一律先 send_message 复用空闲成员，无空闲再 spawn_teammate。",
  "路数由「能拆出几个独立产出物」决定，不由空闲人数决定：6 个闲人 5 个活就派 5 路；4 个活 2 个闲人就派 2 路。**不许为占满而拆** —— 拆出来的每一路都必须有自己的产出物。",
  "派活必须给「读取白名单」：只准读哪几个文件、只准看哪几段；它要看更多得先回报申请。报告里出现「我扫描了全仓」＝ 这次派活失控。",
  "同类只读核对必须合并成 1 路（判据：产出物能不能写进同一份报告）；拆成多个只会多付固定前缀，不多得信息。",
  "`send_message` 的 `target` 只能填 `list_agents` 返回的名字；子代理（`subagent`）的会话 ID 不可寻址，发给它一定报 `not found`——想让它继续干，只能在它还在跑的时候发，跑完就再也叫不动。",
  "⑤ 派活先报批：一次要派 ≥2 路、或要新建常驻成员时，先用 `ask_user_question` **一次性**问清「这批派几路、分别给谁、你同意吗」，拿到同意再发——不许逐个问，更不许不问就甩出去。三种情形不用问：用户说过「直接干 / 无人值守 / 别问」；只派 1 路且纯只读；复用已同意过的同一批成员继续干同一批活。（被硬门拦下后的改道按第十一节，不再问用户。）",
  "六、我只做四件事",
  "拆、派、收、验。长活不自己上手；收回来的东西先核，再统一报。",
  "七、名字要能点名",
  "常驻成员按创建顺序叫员工1号、员工2号、员工3号…（技术名 employee-1 / employee-2 / employee-3…，spawn 只收小写连字符）；编号只增不减，新建的接着往后排，人格统一为「牛马」（定义见第二节），不带专长标签。",
  "一次性执行者用序号+类型，例如 07_查文档_subagent。",
  "汇报时用这个名字点名，出问题能追到是谁干的。",
  "八、跨会话要能接上",
  "谁做哪块、做到哪一步，要留痕迹：长活让对方把「目标 / 已完成 / 断点 / 下一步 / 产物路径」写进固定进度文件；下次接手先读它，再续原会话，不从头重来。",
  "同一功能反复小修，交给同一个成员。",
  "九、任务板：派了活就要留痕",
  "· 本轮派出 **≥2 路**、**并且这些活可能要跨重启接着做**（或新建了成员要长期跟踪）→ 才建板：每个活一条，写清「负责范围 / 产物完整绝对路径 / 验收标准」，派完立刻 claim，做完标 complete。",
  "· 只是这一轮并行跑完就结束的 → **不建板**，别为了走流程建一堆空条目。",
  "· 只有 1 路、纯问答、或单步任务 → 不建板。",
  "· 汇报必须按「**任务 → 谁 → 状态（待办 / 进行中 / 已完成）**」三档说，让人一眼看到流程走到哪、谁手上有什么。",
  "· 建板**不能代替派活**（只建板不派活，硬门照样拦）。",
  "十、预设路由",
  "按预设分域派活时优先匹配：@@ROUTES@@",
  "十一、工具层有一道硬门（执行保障，不改变上面的方法）",
  "「派活」只算四件事：subagent / subagent_fork / spawn_teammate / send_message 之一。建任务板不算派活。",
  "跑命令、改文件这类**动手类**操作只在 todo 标了【并行】时才受约束（不标【并行】就直接放行，不需要先派活）；下面这些工具连判定都不进、永远可直接调：读文件 `read` / 查路径 `glob` / 搜内容 `grep` / 要答案的提问 `ask_user_question` / 加载技能 `skill` / 团队工具 `list_agents`·`team_task_*`（`send_message` 本身也免检、可直接调，但用它唤醒成员去干活就计为一路派活） / 上下文管理 `compress` 等。",
  "门只在 todo 标了【并行】时生效：不标【并行】就不要求派活、直接放行；标了【并行×N】就必须在**同一步**内真发满 N 路（至少 @@MINDISP@@ 路起、最多 @@MAXPAR@@ 路）。计数取本 turn 内**单步峰值**：分步各派 1 路不算（峰值只有 1）；换 step 会清零，但仍按本 turn 单步最高值判定。",
  "**`wait_agent` 只能在已经派出去之后用**：不许先 wait 再派，也不许派 1 路就 wait。",
  "同一轮连撞门达上限后强制放行，不会死循环。",
  "**被硬门拦下时不要用 ask_user_question 问用户「怎么办」** —— 先 send_message 复用现有空闲成员；若无空闲成员，改用 spawn_teammate 建常驻成员。不要问我，直接改道继续，把活做完再汇报；**无人值守场景下这是硬要求，禁止任何形式的「等用户回复」**。",
  "真·单步任务在 todo 第一条写【不可拆·单步】即免派；明确「我自己做完、不派任何人」就在第一条写【独立完成】（两者同效，语义不同）。",
  "不写 todo ≠ 可以不动手：每轮第一件事就是把待办写进 todo_write；写完自己判断这一步要不要派人 —— 不派就把理由写进第一条（【不可拆·单步】或【独立完成】），要派就真派 ≥ @@MINDISP@@ 路。",
  "派活前没查过花名册的，会往 `gateLog` 记一条 `roster-not-checked`（不拦，只留痕）——连续出现，说明你在凭印象派活。",
  "派活前没问过审批的，`gateLog` 会记一条 `approval-missing`（不拦，只留痕）——连续出现说明你在自作主张，该停下来问一句了。",
].join("\n");

// 预设路由表是唯一需要运行时拼接的一段（v0.3.2：从 local.json 读，公开版为空）。
// 1.1.2：封顶路数也走占位符替换（@@MAXPAR@@，模板里出现两次），值来自当前生效配置，
// 绝不能写死 —— 否则改了 gateMaxParallel 而注入文本仍说 6，等于自己给自己放假消息。
function buildLawText(routes) {
  var routeLine;
  if (routes && routes.length) {
    var parts = [];
    for (var i = 0; i < routes.length; i++) {
      parts.push(routes[i].label + "→" + routes[i].presetId);
    }
    routeLine = parts.join("｜") + "｜未命中→spawn_teammate 自建。";
  } else {
    routeLine = "本环境未配置 presetRoutes，一律用 spawn_teammate 自建成员（**不要猜预设 id**，猜错会报 INVALID_ARGS）。";
  }
  // 1.2.0：所有数字统一从 ACTIVE_TIER 取（唯一真值源），并全部用 split/join 做全局替换。
  // 用 .replace 的风险：替换串里的 `$&` / `$1` 会被解释成反向引用（presetLabel 里可能出现 $），
  // 且 .replace 只换第一处 —— 模板里 @@MAXPAR@@ 出现两次，用 .replace 会漏掉一处。
  // 🔴 测试注入契约（`test\gate-maxparallel.test.mjs:46-48`）：buildLawText 被包进
  //    `new Function("ACTIVE_GATE_MAX_PARALLEL", tmplChunk + lawFn)`，该环境里**只注入这一个自由变量**。
  //    因此：① 读 ACTIVE_TIER 必须先用 typeof 守卫 —— 未声明标识符直接读取会抛 ReferenceError，
  //    现有 16 个用例会**全部炸**；② maxParallel 必须优先取 ACTIVE_GATE_MAX_PARALLEL（测试靠它注入 10/16），
  //    运行时 refreshActiveConfig 已把 ACTIVE_GATE_MAX_PARALLEL 同步为 ACTIVE_TIER.gateMaxParallel，两者恒等。
  var tier = (typeof ACTIVE_TIER !== "undefined" && ACTIVE_TIER) ? ACTIVE_TIER : {};
  var maxParallel = (typeof ACTIVE_GATE_MAX_PARALLEL === "number" && ACTIVE_GATE_MAX_PARALLEL >= 2)
    ? ACTIVE_GATE_MAX_PARALLEL
    : (typeof tier.gateMaxParallel === "number" && tier.gateMaxParallel >= 2)
      ? tier.gateMaxParallel
      : 6;
  var minDisp = (typeof tier.gateMinDispatches === "number" && tier.gateMinDispatches >= 0)
    ? tier.gateMinDispatches
    : 1;
  var out = LAW_TEXT_TEMPLATE;
  out = out.split("@@ROUTES@@").join(routeLine);
  out = out.split("@@MAXPAR@@").join(String(maxParallel));
  out = out.split("@@MINDISP@@").join(String(minDisp));
  return out;
}
// 切档：写 local.json 的 tier 字段 → 强制重读并重建生效值快照 → 返回新快照。
// 只用本机配置层（local.json），绝不碰 cordis.patch.yml 与宿主条目（见 §1.3 D3）。
// 写盘用「临时文件 + rename」的原子替换，避免半截文件把 local.json 写坏。
function applyTier(tierName, customValues) {
  var want = String(tierName);
  var preset = resolveTierPreset(want);
  var custom = null;
  if (want === "custom") {
    // 自定义档没有预设可依，值必须自带且合法（服务端二次校验，不信任前端）
    custom = validateCustomValues(customValues);
    if (!custom) return { ok: false, error: "invalid custom values" };
  } else if (!preset) {
    return { ok: false, error: "unknown tier: " + want };
  }
  var path = join(dshHome(), LOCAL_CONFIG_FILE);
  var cur = loadLocalConfig();
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
  // 🔴 必须全量浅拷贝：local.json 里还有 presetRoutes / domainKeywords / profileName
  // 等私有字段，新建空对象覆盖会把它们抹掉（本插件最贵的一次数据丢失风险）。
  var next = {};
  for (var k in cur) {
    if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k];
  }
  next.tier = want;
  // 切到 custom 才写 customValues；切回命名档故意保留旧 customValues，便于一键恢复。
  if (custom) next.customValues = custom;
  var tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch (e2) { /* 临时文件没建成，忽略 */ }
    return { ok: false, error: "write local.json failed: " + String((e && e.message) || e) };
  }
  // 写盘后 mtime 已变，但 loadLocalConfig 的 mtime 短路判据不可靠（rename 后毫秒可能相同），
  // 直接把缓存打废，保证下一次读一定读盘。
  _localCache = { path: path, mtime: -1, data: null };
  refreshActiveConfig(true);
  return { ok: true, tier: ACTIVE_TIER.name, source: ACTIVE_TIER.source, values: ACTIVE_TIER };
}


export var name = "dsh-agent-team-auto-orchestrator";
export var inject = ["webServer", "systemPrompt"];

// ── 工具分类表 ──────────────────────────────────────────────────────────────

// 「算已开团队」的调用：必须真的新开执行者，才算本会话开过团队。
// v0.3.0 变更（用户 2026-11-08 批准，方案 A）：把 team_task_create 从本表剔除。
// 根因（实测）：它一进来，模型就选成本最低的过关路径 —— 建一条任务板 → 闸门放行
// → 全程自己干；任务板只增不派、子代理一个不开（用户截图 8 条「未分配·待处理」为证）。
// 现在：建任务板只是留痕（仍在 EXEMPT_TOOLS，永不拦），不再等于「已开团队」。
// 1.3.3（#3）：本集合只服务 F2（wait_agent 跨 turn 放行）—— 与 F1 的「派活路数」
// 是**两个语义**，不许合并：send_message 把活交给现有成员算「派活」（进 DISPATCH_TOOLS），
// 但不算「新开执行者」—— 单条 send_message 不该让 wait_agent 永久放行。
// 已知边界（保守做法，故意不做区分）：置位只看 tool/call，不看 tool/result，
// 因此「被 F4 拦掉的 spawn」或「参数失败没跑起来」也会置位。代价 = F2 偶尔早放行一次
// （wait_agent 本身无破坏性），收益 = 判定简单、可预测、不依赖结果事件顺序。
var TEAM_OPEN_TOOLS = new Set([
  "subagent",
  "subagent_fork",
  "spawn_teammate"
]);

// 1.3.2（F1，按实测因果链）：派活路数的口径 —— send_message 也是派活。
// 根因（session-8a8a6a44）：模型通道选择完全正确（subagent=0，全用 teammate），
// 但它用 send_message 把活交给 3 个空闲员工后，闸门仍判「本 step 已真派活 0 路」，
// 把 edit/pwsh 全拦了 → 逼它改用唯一能计数的 spawn_teammate，连建 10 个员工直到满员，
// 最后满员又逼它退回 subagent_fork（11 次）。累计 27 次派活里 16 次是「被逼出来的新建」。
// 所以：send_message 把活交给某位现有成员 = 派活，与 spawn 同权 +1 路。
// 它仍在 EXEMPT_TOOLS 里（可随时调用、不被门拦）；本闸门是扫会话事件计数的，
// 不依赖调用入口，所以豁免不会让它漏计。
var DISPATCH_TOOLS = new Set([
  "subagent",
  "subagent_fork",
  "spawn_teammate",
  "send_message"
]);

// 1.5.2：冷启动并发计数 —— 同一 step 里 n 路 subagent 是并行发起的，事件流里
// 互相看不到（tool/call 要等调用返回才入库），所以按会话累计「已发起」的无预设路数。
var coldStartBySession = new Map();

// 「不可拆的单步任务」豁免标记（1.1.0 新增）。
// 为什么要显式标记：闸门只能看到工具名，读不到任务语义；不给模型一个显式开关，
// 就只能二选一 —— 要么永远放行（旧布尔门的病），要么把真·单步任务也钉死在 2 路上。
// 滥用处置：写了标记却实际拆成多块 = 自相矛盾，闸门仍按 2 路要求（见 buildDenyReason ③）。
var SINGLE_STEP_MARK = "【不可拆·单步】";
// 只认「第一条 todo」= todos[0].content 里的标记，不做全文搜（1.1.1 修）。
// 为什么：全文搜等于给模型留后门 —— 任意一条无关待办里塞个标记就能拿到 1 路豁免，整道并行门形同虚设；
// 而「不可拆」本来就是对整个任务的一句话声明，只可能落在第一条。解析失败/无 todos/空数组一律不豁免。
function hasSingleStepMark(args) {
  if (args == null) return false;
  var payload;
  try {
    payload = typeof args === "string" ? JSON.parse(args) : args;
  } catch (e) {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  var todos = payload.todos;
  if (!todos || !Array.isArray(todos) || todos.length === 0) return false;
  var first = todos[0];
  if (!first || typeof first.content !== "string") return false;
  return first.content.indexOf(SINGLE_STEP_MARK) >= 0;
}

// 统计 todo 里的「并行」契约（1.1.3）：只认显式标记，不再用裸子串「并行」判定。
// 根因（真机实测）：描述性文字大量含「并行」二字（并行门 / 并行预算 / 不可并行 / 并行契约），
// 裸子串把它们全部误计成并行契约 —— 2 条真并行被算成 3 条，硬门多要求 1 路。
// 标记形态与 SINGLE_STEP_MARK（【不可拆·单步】）同一风格：前后缀齐全、一眼可辨、不与叙述混淆。
// 认这 5 种写法：【并行】 [并行] 「并行」 （并行） (并行)；前两种支持声明路数：【并行×3】 / 【并行3路】。
// count = max(并行条目数, 单条声明路数最大值)：10 条【并行】= 10 路；3 条各标 ×3 = 3 路（不是 9/12 路）。
// 只数未完成条目，status === "completed" 的不算（已完成是历史，不该继续抬高本轮的派活要求）。
// 返回 { count: 声明路数最大值, total: 未完成总条数 }；入参解析失败一律 {0, 0}，绝不抛。
var PARALLEL_MARK_RE = /【并行(?:[×xX✕]\s*\d+(?:\s*路)?|\d+\s*路)?】|\[并行\]|「并行」|（并行）|\(并行\)/;
function countParallelTodos(args) {
  if (args == null) return { count: 0, total: 0 };
  var payload;
  try {
    payload = typeof args === "string" ? JSON.parse(args) : args;
  } catch (e) {
    return { count: 0, total: 0 };
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.todos)) {
    return { count: 0, total: 0 };
  }
  var maxRoutes = 0;
  var parallelN = 0;
  var total = 0;
  for (var i = 0; i < payload.todos.length; i++) {
    var t = payload.todos[i];
    if (!t || typeof t !== "object") continue;
    if (t.status === "completed") continue;
    total++;
    if (typeof t.content !== "string") continue;
    var m = t.content.match(PARALLEL_MARK_RE);
    if (m) {
      var n = m[0].match(/[×xX✕]\s*(\d+)/) || m[0].match(/(\d+)\s*路/);
      parallelN++;
      var _routeN = n ? parseInt(n[1], 10) : 1;
      if (_routeN > maxRoutes) maxRoutes = _routeN;
    }
  }
  return { count: Math.max(parallelN, maxRoutes), total: total };
}

// 1.5.10：复杂任务未开团队检测 —— todo 里出现 ≥3 个不同产出文件（带扩展名），
// 且本 turn 0 派活时判为「该并行没并行」。文件数只是下限信号（行数无法从文本可靠读出），
// 行数门槛由注入词的界限判据约束；小文件活写【独立完成】即豁免。
var DISTINCT_FILE_RE = /[A-Za-z0-9_\-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|md|markdown|csv|json|txt|yml|yaml|html|htm|css|sql|ps1|sh|bat|java|go|rs|cpp|c|h)\b/gi;
function countDistinctFiles(args) {
  var text = "";
  try { text = (typeof args === "string") ? args : JSON.stringify(args); } catch (e) { return 0; }
  var set = {};
  var m;
  DISTINCT_FILE_RE.lastIndex = 0;
  while ((m = DISTINCT_FILE_RE.exec(text)) !== null) set[m[0].toLowerCase()] = 1;
  return Object.keys(set).length;
}

// 1.4.0（A3）：【独立完成】= 我自己做、不派任何人（与【不可拆·单步】同效，语义不同）。
// 同样只认 todo 第一条，避免正文里提一嘴就被当成声明。
function hasIndependentMark(args) {
  var o = null;
  try { o = (typeof args === "string") ? JSON.parse(args) : args; } catch (e) { return false; }
  if (!o || !Array.isArray(o.todos) || o.todos.length === 0) return false;
  var first = o.todos[0];
  if (!first || typeof first.content !== "string") return false;
  return first.content.indexOf("【独立完成】") >= 0;
}

// 永远不拦（否则模型无法自救：连建任务板/加载技能都被拦就死锁了）。
var EXEMPT_TOOLS = new Set([
  "todo_write",
  "ask_user_question",
  "team_task_create",
  "team_task_update",
  "team_task_list",
  "team_task_get",
  "subagent",
  "subagent_fork",
  "spawn_teammate",
  "list_agents",
  "send_message",
  // v1.1.0（D7）：wait_agent 移出永久豁免 —— 它能被用来「一次都不派就先等」或「派 1 路就等」，
  // 这两种都是串行伪装。改由闸门内 2b-i-b 按 waitAgentGate 配置判定（默认 warn 放行 + 记账）。
  "interrupt_agent",
  "skill",
  "present",
  // 上下文管理类工具无副作用（只读写上下文、不写盘、不跑命令、不联网），永不拦。
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  // 纯只读工具（读文件 / 列文件 / 搜内容），不写盘不跑命令 —— 拦它们只会白烧轮次。
  "read",
  "glob",
  "grep"
]);

// 未入域时拦的「动手类」工具。
var HEAVY_TOOLS = new Set([
  "pwsh",
  "bash",
  "shell",
  "write",
  "edit",
  "run_code"
]);

// Fluent MCP 工具前缀：任何该前缀的工具都算「动手 + Fluent 域强信号」。
var FLUENT_MCP_PREFIX = "mcp__ansys-fluent__";

// ── 域识别关键词（公开默认：只放跨环境通用的词）──────────────────────────────
// strong 命中 1 个即入域；weakStrong 命中 1 个即入域；weak 命中 2 个以上才入域。
// 注意：不用 "case" 这种泛词（"in this case" 会误判），只认 .cas / case文件 形态。
//
// ⚠️ v0.3.2 起：**用户业务专属词不写在这里**（会暴露使用者的行业/内容画像），
// 一律通过 `<DSH_HOME>/team-orchestrator.local.json` 的
// `domainKeywords` 追加（见 resolveDomainRules）。想加自己的词就改那个文件，
// 不要改这段代码。
var DOMAIN_RULES = {
  fluent: {
    label: "Fluent 模拟",
    strong: [
      "fluent", "pyfluent", "ansys", "workbench", "meshing", ".cas", ".dat"
    ],
    weakStrong: [
      "网格", "划网格", "求解", "云图", "矢量图", "初始化", "残差"
    ],
    weak: [
      "迭代", "收敛", "发散", "交界面", "后处理", "监测", "动画", "cfd"
    ]
  },
  plugin: {
    label: "插件开发",
    strong: ["插件", "plugin", "dsh-plugin", "dsh.bundle", "cordis.patch.yml"],
    weak: ["打包", "发布", "修复"]
  },
  dsh: {
    label: "DSH 排查/配置",
    strong: ["dsh", "cordis", "profile"],
    weak: ["配置", "启动失败", "桌面端"]
  },
  preset: {
    label: "自定义预设",
    strong: ["技能", "清理", "回收站", "翻译"],
    weak: ["助手", "预设"]
  }
};

// 用 local.json 的 domainKeywords 追加业务词（只追加到 weakStrong，等于"高置信词"）。
// 非法项静默丢弃；任何异常都返回内置默认，绝不抛。
function resolveDomainRules(cfg) {
  var rules = {};
  for (var k in DOMAIN_RULES) {
    if (!Object.prototype.hasOwnProperty.call(DOMAIN_RULES, k)) continue;
    var d = DOMAIN_RULES[k];
    rules[k] = {
      label: d.label,
      strong: (d.strong || []).slice(),
      weakStrong: (d.weakStrong || []).slice(),
      weak: (d.weak || []).slice()
    };
  }
  try {
    var extra = cfg && cfg.domainKeywords;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (var dk in extra) {
        if (!Object.prototype.hasOwnProperty.call(extra, dk)) continue;
        if (!rules[dk]) continue; // 只支持已存在的四个域
        var arr = extra[dk];
        if (!Array.isArray(arr)) continue;
        for (var i = 0; i < arr.length; i++) {
          var w = arr[i];
          if (typeof w !== "string") continue;
          var lw = w.toLowerCase().trim();
          if (!lw) continue;
          if (rules[dk].strong.indexOf(lw) >= 0) continue;
          if (rules[dk].weakStrong.indexOf(lw) >= 0) continue;
          rules[dk].weakStrong.push(lw);
        }
      }
    }
  } catch (e) { /* 回退默认 */ }
  return rules;
}

// 重建所有"运行时生效值"。任何异常都保留上一次的值（fail-open）。
// 传入 force=false 时，若 local.json 的 mtime 未变则直接跳过（热重载的廉价判据）。
function refreshActiveConfig(force) {
  try {
    var cfg = loadLocalConfig();
    var m = _localCache.mtime;
    if (!force && ACTIVE_LAW_TEXT && _activeMtime === m) return false;
    _activeMtime = m;
    ACTIVE_PRESET_ROUTES = resolvePresetRoutes(cfg);
    ACTIVE_DOMAIN_RULES = resolveDomainRules(cfg);
    ACTIVE_PROFILE_NAME = (typeof cfg.profileName === "string" && cfg.profileName)
      ? cfg.profileName
      : DEFAULT_PROFILE_NAME;
    // 1.2.0：先合成生效值快照，再渲染注入文本 —— 文本里的数字必须来自同一份快照，
    // 否则会出现「闸门按 10 路拦、文本却说封顶 4 路」的假消息。
    ACTIVE_TIER = buildActiveTier(cfg && cfg.tier, cfg && cfg.customValues);
    // 镜像变量（1.1.2 遗留）：只写不读，保留是为了不破坏可能引用它的历史测试。
    // 🔴 新代码一律读 ACTIVE_TIER.gateMaxParallel，禁止再读这个变量。
    ACTIVE_GATE_MAX_PARALLEL = ACTIVE_TIER.gateMaxParallel;
    ACTIVE_LAW_TEXT = buildLawText(ACTIVE_PRESET_ROUTES);
    return true;
  } catch (e) {
    if (!ACTIVE_DOMAIN_RULES) ACTIVE_DOMAIN_RULES = resolveDomainRules(null);
    // 兜底：快照被打坏（undefined / 档名非法）时按 custom 态重建，绝不让闸门读到 undefined。
    if (!ACTIVE_TIER || !ACTIVE_TIER.name ||
        TIER_NAMES.concat(["custom"]).indexOf(String(ACTIVE_TIER.name)) < 0) {
      ACTIVE_TIER = buildActiveTier(null);
    }
    if (!ACTIVE_LAW_TEXT) ACTIVE_LAW_TEXT = buildLawText(ACTIVE_PRESET_ROUTES);
    return false;
  }
}

// ── 回报识别（v0.2.1 修复 Bug 2）─────────────────────────────────────────────
// 子代理回报 / 系统通知里也会出现「dsh」「技能」「台账」「预设」这些词，如果照常判域，
// 父会话连查一条日志都会被拦（2026-11-08 实测踩到）。命中 2 个以上以下标记即视为
// 「回报/通知」而不是「用户下命令」，不参与域识别。
var REPORT_MARKERS = [
  "回报", "自检", "退出码", "exit=", "exit code", "已完成", "子会话",
  "subagentid", "写入的文件", "改动位置", "复核命中", "sha256", "转交"
];

function looksLikeReport(rawText) {
  var text = String(rawText || "").toLowerCase();
  if (!text) return false;
  var hits = 0;
  for (var i = 0; i < REPORT_MARKERS.length; i++) {
    if (text.indexOf(REPORT_MARKERS[i]) >= 0) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// ── 会话能力判定（v0.2.2 重写）───────────────────────────────────────────────
// v0.2.1 曾用 ResolvedToolSet.view(scope) 探测「本会话有没有团队工具」，实测**不可靠**：
// 它对子代理会话也返回含 team_task_create 的集合，导致判定失效；而 lead 会话反而被判
// 成「无团队工具」而全部放行（硬门形同被关掉）。
//
// 2026-11-08 子代理实测证据：team_task_create 不存在、spawn_teammate 不存在、
// subagent 存在但 "Delegation depth: current 1, maximum 1, remaining levels 0" 禁止调用。
//
// 改用会话 header 判定：子代理会话的 header.parentSession 有值。
function isSubagentSession(exec) {
  try {
    var session = exec && exec.agent && exec.agent.session;
    if (!session) return false;
    var header = session.header;
    if (header && header.parentSession) return true;
    if (session.parentSession) return true;
    if (header && header.parent) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// ── 运行态（per-session）────────────────────────────────────────────────────

// sessionId -> { turn, text, domains: string[] }
var sessionDomains = new Map();
// sessionId -> { turn, count }
var gateStrikes = new Map();
// 并行闸门的观测表（1.1.0）：sessionId -> { turn, dispatched, required, singleStep }
// 只用于 /status 排查与 gateLog，不参与放行判定（判定每次从事件流重算，天然幂等）。
var dispatchCounts = new Map();
// 最近一次 todo_write 的原始参数（1.1.1）：闸门要数「标了几条并行」，而 todo_write 自身是豁免工具、
// 不会经过闸门判定，只能在扫事件时把它记下来。turn/start 时清空，避免沿用上一轮的旧契约。
var lastTodoArgs = null;
// 最近一次闸门判定的结论（1.1.1，供 /status 验真使用）：required / parallelTodos / todoTotal / kind。
var lastGateDecision = { required: null, parallelTodos: null, todoTotal: null, kind: null };
// 1.1.1：「从未写 todo」回落基础门槛的命中次数（重启后从 /status 一眼看出这条兜底有没有在工作）
var noTodoFallbackHits = 0;
// 1.3.3（F2，治 wait_agent 跨 turn 误拦）：sessionId -> true，表示「本会话内曾经真派过活」。
// 与 dispatchCounts（每 turn 覆盖写）不同，这个标记**按会话粘住，永不清空**。
// 根因（session-8a8a6a44）：t2/s1、t2/s4 两次 wait_agent 被拦，文案「本轮还没有开团队」——
// 但上一轮明明派过 3 路。wait_agent 是「等已经派出去的活」，跨 turn 看才符合语义；
// 从未派过活就 wait_agent 仍必须拦（那才是 1.1.0 D7 要治的串行伪装）。
var sessionDispatchSeen = new Map();

// 1.4.0（A2）：pwsh 只读豁免的两张表。负向词优先 → 命中即按动手处理（fail-closed）；
// 否则整条命令必须落在只读白名单里才放行（只记账 kind="readonly-pwsh"，不拦）。
var PW_DENY_PATTERN = /\b(Remove-Item|Remove-ItemProperty|Set-Item|Set-ItemProperty|New-ItemProperty|Clear-Item|Clear-Content|Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Start-Process|Stop-Process|Add-Type|Invoke-Expression|iex|Remove-Variable|Invoke-WebRequest|Invoke-RestMethod|cmd|powershell|wsl|python|pip|curl|rm|del|rmdir|git\s+(push|commit|reset|checkout|stash|apply|restore|rm|clean|tag|merge|rebase|switch)|npm\s+(publish|install)|pnpm)\b/i;
var PW_READONLY_PATTERN = /^\s*(?:(Get-ChildItem|Get-Content|Get-Item|Test-Path|Select-String|Measure-Object|Compare-Object|Resolve-Path|Split-Path|Join-Path|ConvertTo-Json|Get-FileHash|Get-Date|Get-Location|Get-Process)(\s+(-{1,2}[\w]+|"[^"]*"|'[^']*'|[\w.\/\\:*?=@{}%+-]+))*\s*$|(git\s+(status|diff|log|show|rev-parse|ls-remote|cat-file|ls-files|rev-list)|npm\s+(view|ls)|node\s+--check)\b[^|>&`]*$)/i;
// 1.4.0（A4）：todo 里出现「等重启」语义时，禁止本 turn 派 subagent（它跑在宿主进程外，重启即断）。
var RESTART_WAIT_RE = /(等用户彻底退出|等\s*DSH\s*重启|重启后用|待重启|等重启|重启之后再用|重启后再|等我重开|退出重进|关掉客户端再开|我先重启一下|关机前|after restart|post-reboot|once you restart|before reboot)/i;
// 1.4.0（A5）：subagent 的 description / spawn_teammate 的 name 必须带序号前缀（warn 不拦）。
var NAME_PREFIX_RE = /^\d{1,2}[_\-]/;

function parseToolArgs(args) {
  if (!args) return null;
  if (typeof args === "object") return args;
  if (typeof args === "string") {
    try { var o = JSON.parse(args); return (o && typeof o === "object") ? o : null; } catch (e) { return null; }
  }
  return null;
}
function pwshCommandText(args) {
  var o = parseToolArgs(args);
  if (!o) return "";
  var c = o.command || o.script || o.code || o.cmd || "";
  return (typeof c === "string") ? c : "";
}
function isReadonlyPwsh(args) {
  var o = parseToolArgs(args);
  if (!o) return false;
  if (o.cwd || o.environmentVariables) return false;
  var cmd = (typeof o.command === "string") ? o.command : "";
  if (!cmd && typeof o.script === "string") cmd = o.script;
  if (/-File\b/.test(cmd)) return false;
  var text = cmd.trim();
  if (!text) return false;
  if (/[|>&`]|\$\(/.test(text)) return false;
  if (PW_DENY_PATTERN.test(text)) return false;
  return PW_READONLY_PATTERN.test(text);
}
function badNameOf(toolName, args) {
  var o = parseToolArgs(args);
  if (!o) return "";
  var nm = "";
  if (toolName === "subagent" || toolName === "subagent_fork") nm = o.description || o.name || "";
  else if (toolName === "spawn_teammate") nm = o.name || "";
  if (typeof nm !== "string" || !nm) return "";
  return NAME_PREFIX_RE.test(nm) ? "" : nm;
}

// 1.3.2（F4/F5）：最近一次 list_agents 的花名册缓存。
// 只在扫到「新的」list_agents result 时解析一次（按 seq 命中缓存），不做每次调用全量 JSON.parse。
var lastRoster = { at: 0, ok: false, idle: [], total: -1, seq: -1 };
var spawnReuseHits = 0;      // F4 拦下「有空闲成员还新建」的次数
var spawnReuseWaitHits = 0;  // F4 拦下「花名册缺失/过期」的次数
// 花名册有效期：超过这个时长就要求先重新 list_agents（不因为「查不到」就放行）
var SPAWN_ROSTER_TTL_MS = 600000;
// 1.2.0 临时诊断（治「闸门不拦」）：闸门最近一次评估的现场快照，只写不读，/status 只读不改行为。
// 1.4.0（标记驱动）：观测计数器，纯计数、不参与判定。
var dispatchHistogram = { "0": 0, "1": 0, "2": 0, "3plus": 0 };
var selfWorkTurns = 0;
var serialSuspect = 0;
var subagentHintHits = 0;
var readonlyPwshHits = 0;
var badNameHits = 0;
var subagentBeforeRestartHits = 0;
var obsSeenTurn = null;

var dbgSnapshot = null;
// 花名册留痕（只记账、不拦）：本轮是否查过 list_agents（turn 变化即重置）+ 累计「未查即派」命中数
var rosterCheckedThisTurn = false;
var rosterTurnKey = null;
var rosterHintHits = 0;
// 审批留痕（只记账、不拦）：本轮是否问过审批（turn 变化即重置）+ 累计「未问即派」命中数
var approvalAskedThisTurn = false;
var approvalTurnKey = null;
var approvalMissingHits = 0;
// 最近拦截记录（排查用，最多 10 条）
var gateLog = [];
// 1.3.3（#4）：wait_agent 每次被「看到」的归属计数 —— 统计误拦率一律按这个口径，
// 不许再拿 kind === "wait-before-full-dispatch" 当「被拦」用。
var waitReleaseCounts = { f2: 0, warn: 0, deny: 0 };
var lastWaitReleased = null;

// 花名册 + 审批留痕（1.3.x）：list_agents / ask_user_question 与派活工具（DISPATCH_TOOLS，含 send_message）都在 EXEMPT_TOOLS 里，
// 走不到闸门判定体，所以必须在 isExempt 之前调用本函数记一笔。
// 只写 gateLog / rosterHintHits / approvalMissingHits，绝不 deny、绝不改 required，
// 也绝不改四档判定 —— 两件事在同一次调用里做完，不重复遍历事件流。
function noteRosterTool(exec, toolName) {
  try {
    var rAgent = exec && exec.agent;
    var rSid = (rAgent && rAgent.id) ? String(rAgent.id) : "";
    var rState = rSid ? sessionDomains.get(rSid) : null;
    var rTurn = (rState && rState.turn != null) ? String(rState.turn) : "unknown";
    var rRec = rSid ? dispatchCounts.get(rSid) : null;
    var rDispatched = (rRec && typeof rRec.dispatched === "number") ? rRec.dispatched : 0;
    var rRequired = (rRec && typeof rRec.required === "number") ? rRec.required : lastGateDecision.required;
    var rDomains = (rState && Array.isArray(rState.domains)) ? rState.domains.slice() : [];

    // ── 1) 花名册：本轮查过没有 ──────────────────────────────────────────
    if (rosterTurnKey !== rTurn) {
      rosterTurnKey = rTurn;
      rosterCheckedThisTurn = false;
    }
    if (toolName === "list_agents") {
      rosterCheckedThisTurn = true;
    } else if (DISPATCH_TOOLS.has(toolName) && rosterCheckedThisTurn !== true) {
      rosterHintHits++;
      gateLog.push({
        at: Date.now(),
        tool: toolName,
        domains: rDomains,
        turn: rTurn,
        dispatched: rDispatched,
        required: rRequired,
        kind: "roster-not-checked"
      });
      if (gateLog.length > 10) gateLog.shift();
    }

    // ── 2) 审批：本轮问过没有 ────────────────────────────────────────────
    // 第 1 路静默通过（避免小任务单路派活刷屏），从第 2 路起或 spawn_teammate 才记。
    if (approvalTurnKey !== rTurn) {
      approvalTurnKey = rTurn;
      approvalAskedThisTurn = false;
    }
    if (toolName === "ask_user_question") {
      approvalAskedThisTurn = true;
    } else if (DISPATCH_TOOLS.has(toolName) && approvalAskedThisTurn !== true && (rDispatched >= 1 || toolName === "spawn_teammate")) {
      approvalMissingHits++;
      gateLog.push({
        at: Date.now(),
        tool: toolName,
        domains: rDomains,
        turn: rTurn,
        dispatched: rDispatched,
        required: rRequired,
        kind: "approval-missing"
      });
      if (gateLog.length > 10) gateLog.shift();
    }
  } catch (e) { /* fail-open：留痕失败绝不影响放行 */ }
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

function isLoopback(req) {
  var a = (req.socket && req.socket.remoteAddress) || "";
  var n = a.toLowerCase();
  if (n === "::1") return true;
  if (n.startsWith("::ffff:")) return n.slice(7).startsWith("127.");
  return n.startsWith("127.");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
// 读请求体（JSON）。只在 POST /tier 用，限制 4KB 并带 2 秒兜底超时。
// 手写而不用框架的原因：本插件不依赖任何 HTTP 库，webServer.register 给的是原生 req/res。
function readJsonBody(req, limitBytes, cb) {
  var chunks = [];
  var size = 0;
  var done = false;
  var timer = null;
  function finish(err, obj) {
    if (done) return;
    done = true;
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } }
    cb(err, obj);
  }
  timer = setTimeout(function () { finish(new Error("body timeout")); }, 2000);
  req.on("data", function (c) {
    size += c.length;
    if (size > limitBytes) {
      finish(new Error("body too large"));
      try { req.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    chunks.push(c);
  });
  req.on("end", function () {
    try {
      var raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return finish(null, {});
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return finish(new Error("body must be a JSON object"));
      }
      return finish(null, obj);
    } catch (e) {
      return finish(e);
    }
  });
  req.on("error", function (e) { finish(e); });
}

// ── 性能基准（1.2.0 面板「一键测试」）──────────────────────────────────────
// 两层：①微基准 = 直接调用现有函数，量本插件自身开销；②并行收益 = 真 setTimeout 墙钟。
// 铁律：这里只「调用」countParallelTodos / hasSingleStepMark / buildLawText，
// 一行都不改它们的实现 —— 基准要是顺手改了被测对象，量到的就不是生产路径了。
var BENCH_MICRO_ROUNDS = { countParallelTodos: 10000, hasSingleStepMark: 10000, buildLawText: 1000 };
// 合成输入：6 条标记，其中 2 条声明 3 路（= 生产里最典型的「多条并行」形态）
var BENCH_TODO_ARGS = JSON.stringify({
  todos: [
    { content: "【并行×3】拆三路并行做 A/B/C", status: "in_progress" },
    { content: "【并行×3】拆三路并行做 D/E/F", status: "pending" },
    { content: "【并行】模块一", status: "pending" },
    { content: "【并行】模块二", status: "pending" },
    { content: "【并行】模块三", status: "completed" },
    { content: "收尾：合并验收", status: "pending" }
  ]
});
var BENCH_SINGLE_STEP_ARGS = JSON.stringify({
  todos: [{ content: "【不可拆·单步】查一行配置", status: "in_progress" }]
});

function nowMs() {
  if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function benchMicro() {
  var rounds = BENCH_MICRO_ROUNDS;
  var checksum = 0;
  var i;
  var t;
  var total0 = nowMs();

  t = nowMs();
  for (i = 0; i < rounds.countParallelTodos; i++) {
    checksum += countParallelTodos(BENCH_TODO_ARGS).count;
  }
  var cptMs = nowMs() - t;

  t = nowMs();
  for (i = 0; i < rounds.hasSingleStepMark; i++) {
    checksum += hasSingleStepMark(BENCH_SINGLE_STEP_ARGS) ? 1 : 0;
  }
  var hssMs = nowMs() - t;

  t = nowMs();
  for (i = 0; i < rounds.buildLawText; i++) {
    checksum += buildLawText(ACTIVE_PRESET_ROUTES).length;
  }
  var bltMs = nowMs() - t;

  return {
    rounds: {
      countParallelTodos: rounds.countParallelTodos,
      hasSingleStepMark: rounds.hasSingleStepMark,
      buildLawText: rounds.buildLawText
    },
    micro: {
      countParallelTodos_ms: round3(cptMs),
      hasSingleStepMark_ms: round3(hssMs),
      buildLawText_ms: round3(bltMs),
      total_ms: round3(nowMs() - total0)
    },
    // 校验和：证明循环真的跑了（也防 JIT 把无副作用循环整个优化掉）
    checksum: checksum
  };
}

var BENCH_MAX_TASKS = 32;
var BENCH_MAX_WORK_MS = 1000;

// 固定并发上限的 worker pool：cap 个 worker 各自「取下一个任务 → await 真定时器」。
// 全程 await，不忙等、不 Atomics.wait —— 宿主事件循环在基准期间照常响应。
function benchRunPool(tasks, workMs, cap) {
  var limit = Math.max(1, Math.min(cap || 1, tasks));
  var next = 0;
  function worker() {
    if (next >= tasks) return Promise.resolve();
    next++;
    return new Promise(function (resolve) {
      setTimeout(resolve, workMs);
    }).then(worker);
  }
  var running = [];
  for (var i = 0; i < limit; i++) running.push(worker());
  return Promise.all(running);
}

function benchParallel(tasks, workMs) {
  var groups = [
    { key: "serial", label: "串行（P=1）", cap: 1 },
    { key: "lean", label: "省Token 上限", cap: TIER_PRESETS.lean.gateMaxParallel },
    { key: "balanced", label: "中规中矩 上限", cap: TIER_PRESETS.balanced.gateMaxParallel },
    { key: "turbo", label: "超级高效 上限", cap: TIER_PRESETS.turbo.gateMaxParallel },
    {
      key: "current",
      label: "当前档上限",
      cap: (ACTIVE_TIER && typeof ACTIVE_TIER.gateMaxParallel === "number") ? ACTIVE_TIER.gateMaxParallel : 1
    }
  ];
  var out = [];
  var serialMs = 0;
  var idx = 0;
  function step() {
    if (idx >= groups.length) {
      for (var i = 0; i < out.length; i++) {
        out[i].speedup = (serialMs > 0 && out[i].elapsedMs > 0)
          ? Math.round((serialMs / out[i].elapsedMs) * 100) / 100
          : 1;
      }
      return Promise.resolve({ tasks: tasks, workMs: workMs, groups: out });
    }
    var g = groups[idx++];
    var effective = Math.max(1, Math.min(g.cap, tasks));
    var t0 = nowMs();
    return benchRunPool(tasks, workMs, g.cap).then(function () {
      var ms = nowMs() - t0;
      if (g.key === "serial") serialMs = ms;
      out.push({
        key: g.key,
        label: g.label,
        cap: g.cap,
        effectiveCap: effective,
        elapsedMs: round3(ms),
        speedup: 1
      });
      return step();
    });
  }
  return step();
}

// 读宿主限制（只读，不写）。数据源 = profile 的 cordis.patch.yml 文本。
// 刻意不用 yaml 解析库：本插件零运行时依赖，且只需要 6 个标量键。
// 解析策略：一行 `- id: xxx` 开一个条目，其后缩进更深的 `key: 数字` 归该条目。
function readHostLimits() {
  var out = {
    ok: false,
    source: "",
    maxMembers: null,
    maxActiveSubagents: null,
    maxTasks: null,
    maxMessageBytes: null,
    disposalTimeoutMs: null,
    maxParallelToolCalls: null
  };
  try {
    var profileDir = join(dshHome(), "profiles", ACTIVE_PROFILE_NAME);
    var p = join(profileDir, "cordis.patch.yml");
    var txt = readFileSync(p, "utf8");
    out.ok = true;
    out.source = p;
    var lines = txt.split(/\r?\n/);
    var currentId = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var mId = /^\s*-\s+id:\s*['"]?([^\s'"]+)['"]?\s*$/.exec(line);
      if (mId) { currentId = mId[1]; continue; }
      var mKV = /^\s+([A-Za-z][A-Za-z0-9_]*):\s*(\d+)\s*$/.exec(line);
      if (!mKV) continue;
      var k = mKV[1];
      var v = parseInt(mKV[2], 10);
      if (currentId === "subagent" && k === "maxActiveSubagents") out.maxActiveSubagents = v;
      else if (currentId === "agent-team" && k === "maxMembers") out.maxMembers = v;
      else if (currentId === "agent-team" && k === "maxTasks") out.maxTasks = v;
      else if (currentId === "agent-team" && k === "maxMessageBytes") out.maxMessageBytes = v;
      else if (currentId === "agent-team" && k === "disposalTimeoutMs") out.disposalTimeoutMs = v;
      else if (k === "maxParallelToolCalls") out.maxParallelToolCalls = v;
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

// 并发预算：R = min(并行条数, gateMaxParallel)，A = maxActiveSubagents − 常驻成员数。
// 自洽条件：gateMaxParallel + maxMembers ≤ maxActiveSubagents。
// ⚠️ 「当前常驻成员实际存活数」宿主未暴露给插件，只能按 maxMembers 上限保守估算 ——
//    面板必须把这条写成文案，不许假装知道。
function buildBudget(tierValues, host) {
  var parallel = (tierValues && typeof tierValues.gateMaxParallel === "number") ? tierValues.gateMaxParallel : 6;
  var members = (host && typeof host.maxMembers === "number") ? host.maxMembers : null;
  var active = (host && typeof host.maxActiveSubagents === "number") ? host.maxActiveSubagents : null;
  var need = (members === null) ? null : (parallel + members);
  var enough = (need === null || active === null) ? null : (need <= active);
  return {
    needParallel: parallel,
    needMembers: members,
    need: need,
    available: active,
    enough: enough,
    headroom: (need === null || active === null) ? null : (active - need),
    formula: "gateMaxParallel + maxMembers ≤ maxActiveSubagents",
    calc: (need === null || active === null)
      ? null
      : (parallel + " + " + members + " = " + need + (enough ? " ≤ " : " > ") + active),
    membersKnown: false,
    // maxDepth=1 的隐藏自锁必须写在面板里：成员是 depth 1，不能再派子代理，
    // 所以「并行」只发生在主代理这一层，把 maxMembers 调大对并行度毫无帮助。
    depthNote: "maxDepth=1：团队成员（depth 1）不能再派子代理，并行只发生在主代理这一层。",
    membersNote: "常驻成员实际存活数宿主未暴露给插件，本预算按 maxMembers 上限保守估算。"
  };
}

// 从 UserMessage 里尽力取出文本（形态可能随版本变化，多路兜底）。
function extractUserText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  var out = [];
  var c = message.content;
  if (typeof c === "string") out.push(c);
  else if (Array.isArray(c)) {
    for (var i = 0; i < c.length; i++) {
      var p = c[i];
      if (!p) continue;
      if (typeof p === "string") out.push(p);
      else if (typeof p.text === "string") out.push(p.text);
    }
  }
  if (!out.length && typeof message.text === "string") out.push(message.text);
  if (!out.length && Array.isArray(message.parts)) {
    for (var j = 0; j < message.parts.length; j++) {
      var q = message.parts[j];
      if (q && typeof q.text === "string") out.push(q.text);
    }
  }
  return out.join("\n");
}

// 返回命中的域名数组（可能为空）。
function detectDomains(rawText, allowed) {
  var text = String(rawText || "").toLowerCase();
  if (!text) return [];
  var hits = [];
  var rulesAll = ACTIVE_DOMAIN_RULES || DOMAIN_RULES;
  for (var key in rulesAll) {
    if (!Object.prototype.hasOwnProperty.call(rulesAll, key)) continue;
    if (allowed && allowed.indexOf(key) < 0) continue;
    var rule = rulesAll[key];
    var strongHit = false;
    for (var i = 0; i < rule.strong.length; i++) {
      if (text.indexOf(rule.strong[i]) >= 0) { strongHit = true; break; }
    }
    if (strongHit) { hits.push(key); continue; }

    // 单命中即入域的「高置信弱词」（例：「网格」「求解」在中文语境几乎只出现在 CFD）
    var weakStrongHit = false;
    if (Array.isArray(rule.weakStrong)) {
      for (var k = 0; k < rule.weakStrong.length; k++) {
        if (text.indexOf(rule.weakStrong[k]) >= 0) { weakStrongHit = true; break; }
      }
    }
    if (weakStrongHit) { hits.push(key); continue; }

    var weakCount = 0;
    for (var j = 0; j < rule.weak.length; j++) {
      if (text.indexOf(rule.weak[j]) >= 0) weakCount++;
      if (weakCount >= 2) break;
    }
    if (weakCount >= 2) hits.push(key);
  }
  return hits;
}

function isExempt(name) {
  if (!name) return false;
  if (EXEMPT_TOOLS.has(name)) return true;
  if (name.indexOf("cordis_inspect") === 0) return true;
  return false;
}

function isFluentMcp(name) {
  return typeof name === "string" && name.indexOf(FLUENT_MCP_PREFIX) === 0;
}

function isHeavy(name) {
  if (!name) return false;
  if (isFluentMcp(name)) return true;
  return HEAVY_TOOLS.has(name);
}

function domainLabel(key) {
  var rulesAll = ACTIVE_DOMAIN_RULES || DOMAIN_RULES;
  var r = rulesAll[key];
  return (r && r.label) || key;
}

// 读 profile 的 bundles 快照 —— 只为排查「团队包到底挂没挂」。
// profile 名来自 local.json 的 profileName（默认 "desktop"），不再写死。
function readProfileBundles() {
  try {
    var profileDir = join(dshHome(), "profiles", ACTIVE_PROFILE_NAME);
    var p = join(profileDir, "package.json");
    var j = JSON.parse(readFileSync(p, "utf8"));
    var bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [];
    var teamId = "@deepseek-ai/dsh-experimental-agent-team-profile";
    return {
      ok: true,
      profile: ACTIVE_PROFILE_NAME,
      bundleCount: bundles.length,
      teamMounted: bundles.indexOf(teamId) >= 0,
      // 1.1.0 修 D6：本插件从不写进 profile 的 bundles 数组（靠母包 cordis.patch.yml 的 insert 行挂载），
      // 旧判据 bundles.indexOf(...) 恒为 false = 永远自报「未挂载」，把排查方向带偏。
      // 语义修正：能执行到 apply 就说明已被挂载 —— 这里恒为 true，证据链单独放 orchestratorMountedVia。
      orchestratorMounted: true,
      orchestratorMountedVia: detectOrchestratorMount(bundles, profileDir)
    };
  } catch (e) {
    return { ok: false, profile: ACTIVE_PROFILE_NAME, error: String((e && e.message) || e) };
  }
}

// 本插件「挂在哪儿」的证据链：profile.bundles → profile/cordis.patch.yml → 各 bundle 包内 cordis.patch*.yml。
// 都定位不到时返回 "patch-insert(未定位)"（事实仍是已挂载，只是没找到那一行）。
function detectOrchestratorMount(bundles, profileDir) {
  var selfName = "dsh-agent-team-auto-orchestrator";
  if (bundles.indexOf(selfName) >= 0) return "profile.bundles";
  var candidates = [join(profileDir, "cordis.patch.yml")];
  for (var i = 0; i < bundles.length; i++) {
    candidates.push(join(profileDir, "node_modules", String(bundles[i]), "cordis.patch.yml"));
    candidates.push(join(profileDir, "node_modules", String(bundles[i]), "cordis.patch.public.yml"));
  }
  for (var k = 0; k < candidates.length; k++) {
    try {
      var txt = readFileSync(candidates[k], "utf8");
      if (txt.indexOf("name: " + selfName) >= 0 || txt.indexOf("id: " + selfName) >= 0) return candidates[k];
    } catch (e) {
      /* 候选不存在，继续下一处 */
    }
  }
  return "patch-insert(未定位)";
}

// 按域从 presetRoutes 找对应的预设 id，拼成「具体出路」。
// ⚠️ 找不到时**绝不能吐 `agent_preset="<占位符>"`** —— 那是直接喂给模型的指令，
// 它会照抄，然后连撞 `INVALID_ARGS` 把配额耗光（硬门文案从「给出路」变「给死路」）。
function presetHint(domains) {
  var routes = ACTIVE_PRESET_ROUTES || [];
  for (var i = 0; i < domains.length; i++) {
    for (var j = 0; j < routes.length; j++) {
      if (routes[j].key === domains[i]) {
        return 'subagent(agent_preset="' + routes[j].presetId + '") 派给「' + routes[j].label + '」，或 spawn_teammate 自建成员';
      }
    }
  }
  if (!domains || !domains.length) {
    // 未命中特定域（只拦「动手类操作」）：给通用出路。
    // ⚠️ 这里**不能**说「本环境未配置 presetRoutes」—— 那是域为空时的误判，会误导模型。
    return '按任务实际领域派给对应预设，或 spawn_teammate(name="...") 自建成员';
  }
  return 'spawn_teammate(name="...") 自建成员（该域未配置 presetRoutes，**不要猜 agent_preset**）';
}

// 拒绝理由（这是模型真正会读到的文字，措辞要给出路、不要只说"不行"）。
// ── 1.3.2（F4/F5）：spawn 前置复用校验的辅助函数 ──────────────────────

// 把 list_agents 的文本结果解析成 { ok, idle[], total }。
// fail-safe：非字符串 / JSON 非法 / 非数组 → ok:false（调用方按「花名册不可用」处理，不放行、不崩）。
function parseRosterText(text) {
  if (typeof text !== "string" || text.length === 0) return { ok: false, idle: [], total: -1 };
  var arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    return { ok: false, idle: [], total: -1 };
  }
  if (!Array.isArray(arr)) return { ok: false, idle: [], total: -1 };
  var idle = [];
  var total = 0;
  for (var i = 0; i < arr.length; i++) {
    var m = arr[i];
    if (!m || typeof m !== "object") continue;
    if (m.role !== "teammate") continue;
    total++;
    if (m.status === "inactive" && typeof m.target === "string" && m.target) idle.push(m.target);
  }
  return { ok: true, idle: idle, total: total };
}

// 从会话事件里取**最近一次** list_agents 的结果并解析；结果未变则直接返回缓存。
// 事件形状（app.asar 实测）：tool/call.data = {name, arguments, callId, turn, step}
//                          tool/result.data.message = {role:"tool", toolCallId, content:[{type:"text",text}], isError}
function refreshRoster(events, sid) {
  if (!events || typeof events[Symbol.iterator] !== "function") {
    return { at: 0, ok: false, idle: [], total: -1, seq: -1 };
  }
  var listCallIds = {};
  var best = null;
  for (var ev of events) {
    if (!ev) continue;
    if (ev.type === "tool/call") {
      var nm = (ev.data && ev.data.name) || ev.name;
      var cid = ev.data && (ev.data.callId || ev.data.id);
      if (nm === "list_agents" && cid) listCallIds[String(cid)] = true;
    } else if (ev.type === "tool/result") {
      var msg = ev.data && ev.data.message;
      var rid = msg && (msg.toolCallId || (msg.source && msg.source.callId));
      if (!rid || !listCallIds[String(rid)]) continue;
      var txt = "";
      if (msg && Array.isArray(msg.content)) {
        for (var ci = 0; ci < msg.content.length; ci++) {
          var part = msg.content[ci];
          if (part && typeof part.text === "string") txt += part.text;
        }
      }
      var at = (typeof ev.time === "number") ? ev.time : 0;
      if (!best || at >= best.at) {
        best = { at: at, seq: (typeof ev.seq === "number") ? ev.seq : -1, text: txt, isError: !!(msg && msg.isError) };
      }
    }
  }
  if (!best) return { at: 0, ok: false, idle: [], total: -1, seq: -1 };
  if (lastRoster && lastRoster.sid === String(sid || "") && lastRoster.seq === best.seq) return lastRoster;
  var parsed = best.isError ? { ok: false, idle: [], total: -1 } : parseRosterText(best.text);
  lastRoster = { at: best.at, ok: parsed.ok, idle: parsed.idle, total: parsed.total, seq: best.seq, sid: String(sid || "") };
  return lastRoster;
}

// F5：有空闲成员时的拒绝文案（必须把名字直接列出来，否则模型不知道派给谁）
function buildReuseReason(roster) {
  var names = roster.idle.join("、");
  return [
    "【复用优先】当前有 " + roster.idle.length + " 位空闲成员：" + names + "。",
    "这一路的活能不能交给它们？能就 send_message 直接派；确实没有能接的（职责不匹配 / 都在忙）才新建。（不要为了用满空闲成员而拆任务。）",
    "若花名册已过期，先调 list_agents 再派。",
    "",
    "（本条来自 dsh-team-orchestrator 的 spawn 前置复用校验：查到空闲成员时新建成员会被拒绝。）"
  ].join("\n");
}

// F5：花名册缺失/过期时的拒绝文案（不许因为「查不到」就放行）
function buildRosterMissingReason(roster) {
  var ageSec = (roster && roster.at) ? Math.round((Date.now() - roster.at) / 1000) : -1;
  return [
    "【复用优先】新建成员之前必须先查花名册。",
    ageSec >= 0
      ? ("最近一次 list_agents 已是 " + ageSec + " 秒前（有效期 " + Math.round(SPAWN_ROSTER_TTL_MS / 1000) + " 秒），已过期。")
      : "当前会话里还没有可用的 list_agents 结果（或结果无法解析）。",
    "先调一次 list_agents，确认有没有空闲成员；有空闲就用 send_message 派给它们，确实没有才新建。",
    "",
    "（本条来自 dsh-team-orchestrator 的 spawn 前置复用校验。）"
  ].join("\n");
}

function buildDenyReason(toolName, domains, strikeInfo) {
  var label = domains.length
    ? "「" + domains.map(domainLabel).join(" / ") + "」域"
    : "「动手类操作」";
  // 1.1.0：把「差几路」写进文案 —— 笼统的「还没开团队」正是模型反复只派 1 路的原因
  // 1.1.1：required 的兜底值随默认门槛改为 1（用户选 B 后基础门槛就是 1 路）
  var required = (strikeInfo && typeof strikeInfo.required === "number") ? strikeInfo.required : 1;
  var dispatched = (strikeInfo && typeof strikeInfo.dispatched === "number") ? strikeInfo.dispatched : 0;
  // 1.3.2（F3）：放行看的是「本 turn 内单步最多派了几路」，所以文案也要按这个口径说，
  // 否则模型会以为「这一步再派几路」就能过，实际要求的是「任何一步里一次派满」。
  var turnMax = (strikeInfo && typeof strikeInfo.turnMax === "number") ? strikeInfo.turnMax : dispatched;
  var parallelTodos = (strikeInfo && typeof strikeInfo.parallelTodos === "number") ? strikeInfo.parallelTodos : 0;
  var lines = [];
  lines.push("【并行契约违约 · " + label + "】检测到「" + toolName + "」调用，本 turn 单步派活不足；" + required + " 路要求在**某一步内**一次发满。");
  lines.push("");
  lines.push("门只在你把 todo 标了【并行】时才生效。你声明了 " + parallelTodos + " 路并行，本 turn 当前单步最多只发了 " + turnMax + " 路（当前这一步 " + dispatched + " 路）。");
  lines.push("派活工具只算四件事：subagent / subagent_fork / spawn_teammate / send_message；建任务板不算派活。");
  lines.push("");
  lines.push(presetHint(domains));
  lines.push("");
  lines.push("真不需要派的两种情形：真·小任务（todo ≤2 条且不含「并行」）与不可拆的单步任务 —— 单步只需在 todo_write 第一条里写 " + SINGLE_STEP_MARK + " 或【独立完成】；两者都不要求派活。");
  lines.push("");
  lines.push("【并行缺口】本 turn 内单步最多只派活 " + turnMax + " 路（当前这一步 " + dispatched + " 路），过门要求 " + required + " 路 —— 缺的 "
    + Math.max(0, required - turnMax) + " 路要**在某一步里一次派满**，不要等已派的那几路回来，也不要分步凑数（换 step 不会清零）。");

  if (strikeInfo && typeof strikeInfo.count === "number") {
    var left = Math.max(0, strikeInfo.max - strikeInfo.count);
    lines.push("");
    lines.push("【拦截计数】本 turn 第 " + strikeInfo.count + " / " + strikeInfo.max + " 次拦截"
      + (left > 0 ? "，再拦 " + left + " 次后强制放行（但那等于本次改动没生效，请立刻派活）。" : "，已达上限，下次放行。"));
  }

  lines.push("");
  lines.push("做完 ① 后，重试本次调用即可通过。");
  return lines.join("\n");
}

// ── gateMaxParallel 解析（1.1.2 新增）──────────────────────────────────────
// 合法范围 2~16：低于 2 与「并行」契约本身矛盾（并行至少 2 路）；高于 16 超出
// maxActiveSubagents=20 的实际承载力，且成本失控。缺省（未配置）= 6 → 与 1.1.1 行为完全一致。
var GATE_MAX_PARALLEL_DEFAULT = 6;
var GATE_MAX_PARALLEL_MIN = 2;
var GATE_MAX_PARALLEL_MAX = 16;
function parseGateMaxParallel(config) {
  var hasKey = !!(config && Object.prototype.hasOwnProperty.call(config, "gateMaxParallel"));
  var raw = hasKey ? config.gateMaxParallel : undefined;
  if (!hasKey || raw === undefined || raw === null) return GATE_MAX_PARALLEL_DEFAULT;
  var legal = (typeof raw === "number") && isFinite(raw) &&
    raw >= GATE_MAX_PARALLEL_MIN && raw <= GATE_MAX_PARALLEL_MAX;
  if (legal) return Math.floor(raw);
  // 非法值：回落默认 + 记一条 gateLog（/status 的 gateLog 里能看到 kind=config-fallback）
  gateLog.push({
    at: Date.now(),
    tool: "-",
    domains: [],
    turn: "-",
    dispatched: null,
    required: null,
    kind: "config-fallback",
    key: "gateMaxParallel",
    value: raw,
    fallback: GATE_MAX_PARALLEL_DEFAULT
  });
  if (gateLog.length > 10) gateLog.shift();
  return GATE_MAX_PARALLEL_DEFAULT;
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // 1.1.2：gateMaxParallel 必须先于 refreshActiveConfig 解析 —— 注入文本里的封顶数字
  // 由 buildLawText 按当前生效快照渲染，写死就会与配置漂移。
  var gateMaxParallel = parseGateMaxParallel(config);
  ACTIVE_GATE_MAX_PARALLEL = gateMaxParallel;
  var injectLaw = !(config && config.injectLaw === false);
  var enforceGate = !(config && config.enforceTeamGate === false);
  var maxStrikes = (config && typeof config.gateMaxStrikes === "number" && config.gateMaxStrikes >= 0)
    ? config.gateMaxStrikes
    : 4;
  // 1.1.1 并行门基础门槛（用户选 B）：默认 1 —— 基础要求只是「走一次团队流程」；
  // todo 里标了「并行」的条目会把它抬到并行条数（见闸门 2b-i 的三档判定），真·小任务则放宽到 0。
  // 设 0 即全关（连基础门槛都不要），设 2 可退回 1.1.0 的「必须两路」行为。
  var minDispatches = (config && typeof config.gateMinDispatches === "number" && config.gateMinDispatches >= 0)
    ? Math.floor(config.gateMinDispatches)
    : 1;
  // wait_agent 专项：warn（默认）= 放行 + 记账；enforce = 未派满即拦。
  var waitAgentGate = (config && (config.waitAgentGate === "enforce" || config.waitAgentGate === "warn"))
    ? config.waitAgentGate
    : "warn";
  var allowedDomains = (config && Array.isArray(config.gateDomains) && config.gateDomains.length)
    ? config.gateDomains
    : ["fluent", "plugin", "dsh", "preset"];
  // 1.2.0：config 基线必须在第一次 refreshActiveConfig 之前填好。
  // 顺序反了 → custom 态快照会拿 _CONFIG_BASELINE 的默认值（gateMaxParallel=6）去渲染，
  // 本机实际是 10 → 注入文本与闸门同时「静默回落到 6」，用户会以为配置丢了。
  _CONFIG_BASELINE = {
    gateMinDispatches: minDispatches,
    gateMaxParallel: gateMaxParallel,
    gateMaxStrikes: maxStrikes,
    waitAgentGate: waitAgentGate,
    enforceTeamGate: enforceGate,
    injectLaw: injectLaw
  };
  // 启动时先按 local.json 重建一次生效值；之后每次工具调用前做一次廉价的 mtime 检查。
  refreshActiveConfig(true);

  // ── 1. 常驻 prompt 段 ──
  if (injectLaw) {
    ctx.effect(function () {
      return ctx.systemPrompt.section({
        name: LAW_SECTION_NAME,
        order: LAW_SECTION_ORDER,
        // 1.2.0：必须是函数，不能是字符串快照。DSH 在每次组装 prompt 时按
        // `typeof entry.text === "function" ? entry.text(context) : entry.text` 求值
        // （@deepseek-ai/dsh-system-prompt\lib\index.js:189 与 :389，:214 每 model step 前组装），
        // 所以切档后下一次模型请求就取到新文本 —— 不需要重载条目、不需要重启。
        // 代价：文本变了 → 上游 prompt cache 失效一次（只此一次，稳态下每轮返回同一字符串，cache 前缀稳定）。
        text: function () { return ACTIVE_LAW_TEXT; }
      });
    }, "dsh-agent-team-auto-orchestrator: team orchestration law section");
  }

  // ── 2. 硬门 ──
  // 1.2.0：闸门注册不再受 enforceTeamGate 控制 —— 开关判断挪进监听器内部（见 10.3），
  // 这样切档把 ACTIVE_TIER.enforceTeamGate 由 true 改成 false 才能真正「立即关掉闸门」
  // （DSH 的 ctx.on 无法卸载单个监听器，注册期决定 = 只能彻底重启才能改）。
  // 用裸块 `{ ... }` 保持原有花括号配对与缩进：本块结束于 index.js:960 的 `}`，不动它。
  {
    // 2a. 缓存本轮用户消息 → 判定任务域
    try {
      ctx.on("agent/inbox/claimed", function (payload) {
        try {
          var agent = payload && payload.agent;
          var sid = agent && agent.id ? String(agent.id) : "";
          if (!sid) return;
          var text = extractUserText(payload && payload.message);
          if (!text) return;
          var turn = payload && payload.turn != null ? payload.turn : null;
          // v0.2.2 修复 Bug 3：新用户消息 = 新 turn，重置本会话拦截计数。
          // 不重置的话 gateMaxStrikes 一旦用掉就永久放行（实测：每个会话只拦第一次，
          // 之后所有调用都过 —— 因为 payload.turn 并不可靠地递增）。
          gateStrikes.delete(sid);
          rosterCheckedThisTurn = false;
          rosterTurnKey = null;
          approvalAskedThisTurn = false;
          approvalTurnKey = null;
          // 子代理回报 / 系统通知：不判域（否则父会话查个日志都会被拦）
          if (looksLikeReport(text)) {
            sessionDomains.set(sid, { turn: turn, text: text.slice(0, 400), domains: [] });
            return;
          }
          var domains = detectDomains(text, allowedDomains);
          sessionDomains.set(sid, {
            turn: turn,
            text: text.slice(0, 400),
            domains: domains
          });
        } catch (e) { /* fail-open */ }
      });
    } catch (e) { /* 事件不存在时静默降级为「只按工具类型拦」 */ }

    // 2b. 工具分发层闸门
    ctx.on("tools/pre-execute", async function (exec, next) {
      try {
        // 花名册留痕：与闸门开关无关 —— 放在最前面，闸门关着也必须能观测「有没有查花名册」；
        // 同时必须在 isExempt 之前（list_agents 与三件派活工具都在豁免名单里）。
        var toolName = exec && exec.name;
        if (!toolName) return next();
        noteRosterTool(exec, toolName);
        // 1.2.0：运行期总开关 —— 必须在 refreshActiveConfig 之前。
        // 先判开关再刷新，是为了「闸门关着的时候连 statSync 都不做」，保持零开销。
        if (ACTIVE_TIER && ACTIVE_TIER.enforceTeamGate === false) return next();
        // 热重载：local.json 的 mtime 变了才重建（文件不存在则沿用上次的值）。
        refreshActiveConfig();
        // 1.2.0：把 4 个启动期闭包常量在监听器入口 shadow 成 live 值 —— 切档后下一次工具调用即生效。
        // 🔴 必须落在 dispatchedCount 的初值行之前：行为测试从该行起用字符串切片抽出闸门主体，
        //    body 内的 gateMaxParallel / minDispatches 在测试里是 runGate 形参，在运行时是本处局部 var。
        var gateMaxParallel = (ACTIVE_TIER && typeof ACTIVE_TIER.gateMaxParallel === "number" && ACTIVE_TIER.gateMaxParallel >= 2) ? ACTIVE_TIER.gateMaxParallel : 6;
        var minDispatches  = (ACTIVE_TIER && typeof ACTIVE_TIER.gateMinDispatches === "number" && ACTIVE_TIER.gateMinDispatches >= 0) ? ACTIVE_TIER.gateMinDispatches : 1;
        var maxStrikes     = (ACTIVE_TIER && typeof ACTIVE_TIER.gateMaxStrikes === "number" && ACTIVE_TIER.gateMaxStrikes >= 0) ? ACTIVE_TIER.gateMaxStrikes : 4;
        var waitAgentGate  = (ACTIVE_TIER && typeof ACTIVE_TIER.waitAgentGate === "string") ? ACTIVE_TIER.waitAgentGate : "warn";
        // 1.3.2（F4）：spawn 前置复用校验开关。enforce = 拦（默认）；warn = 只记 log 不拦；off = 关。
        var spawnReuseGate = (ACTIVE_TIER && typeof ACTIVE_TIER.spawnReuseGate === "string") ? ACTIVE_TIER.spawnReuseGate : "enforce";
        // 🔴 F4 必须放在 isExempt 之前：spawn_teammate 本身在豁免名单里，放后面这条校验永远跑不到。
        // 1.4.0（A2）：pwsh 只读豁免 —— 只读命令不该被「先派活才能动手」挡住。
        // 先过负向词（写盘/起进程/发网/改仓库），命中即按动手处理；否则整条命令都在只读白名单里才放行。
        if (toolName === "pwsh" && isReadonlyPwsh(exec && exec.arguments)) {
          gateLog.push({
            at: Date.now(),
            tool: toolName,
            domains: [],
            turn: null,
            dispatched: 0,
            required: 0,
            kind: "readonly-pwsh"
          });
          readonlyPwshHits++;
          if (gateLog.length > 10) gateLog.shift();
          return next();
        }
        // 1.4.0（A5）：命名前缀检查 —— 只记账、不拦（第 3 条是习惯要求，不是硬门）。
        var badNm = badNameOf(toolName, exec && exec.arguments);
        if (badNm) {
          gateLog.push({
            at: Date.now(),
            tool: toolName,
            domains: [],
            turn: null,
            dispatched: 0,
            required: 0,
            kind: "bad-name",
            name: badNm
          });
          badNameHits++;
          if (gateLog.length > 10) gateLog.shift();
        }
        // 1.4.0（A4）：todo / 最近用户消息里出现「等重启」语义时，禁止派 subagent。
        //   必须在 isExempt 之前（subagent/subagent_fork 都在豁免名单里），
        //   todo 的 args 是对象，必须 JSON.stringify（只认字符串会永远拿到空串）。
        if (toolName === "subagent" || toolName === "subagent_fork") {
          try {
            var a4Sid = (exec && exec.agent && exec.agent.id) ? String(exec.agent.id) : "";
            var a4Events = (exec && exec.agent && exec.agent.session && typeof exec.agent.session.snapshotEvents === "function") ? exec.agent.session.snapshotEvents() : null;
            var a4Todo = null;
            if (a4Events) {
              for (var a4i = 0; a4i < a4Events.length; a4i++) {
                var a4e = a4Events[a4i];
                if (a4e && a4e.type === "tool/call" && (((a4e.data && a4e.data.name) || a4e.name) === "todo_write")) {
                  a4Todo = (a4e.data && (a4e.data.arguments || a4e.data.args || a4e.data.input)) || a4Todo;
                }
              }
            }
            if (a4Todo == null) a4Todo = turnTodoArgs;
            var a4UserText = "";
            try {
              var a4State = (a4Sid && sessionDomains && typeof sessionDomains.get === "function") ? sessionDomains.get(a4Sid) : null;
              if (a4State && typeof a4State.text === "string") a4UserText = a4State.text;
            } catch (eA4s) { /* 无缓存忽略 */ }
            var restartWaitText = (a4Todo != null ? JSON.stringify(a4Todo) : "") + "\n" + a4UserText;
            if (restartWaitText && RESTART_WAIT_RE.test(restartWaitText)) {
              subagentBeforeRestartHits++;
              gateLog.push({
                at: Date.now(),
                tool: toolName,
                domains: ["restart-wait"],
                turn: null,
                dispatched: 0,
                required: 0,
                kind: "subagent-before-restart"
              });
              if (gateLog.length > 10) gateLog.shift();
              return { kind: "deny", reason: "【重启前禁派 subagent】这一轮还挂着「等重启」的事 —— subagent 跑在宿主进程之外，DSH 一重启它就没了。请改用 spawn_teammate（常驻成员重启后可续），或者这一小块你自己做。" };
            }
            try {
              var rHint = refreshRoster(a4Events, a4Sid);
              var rHintAge = (rHint && rHint.at > 0) ? (Date.now() - rHint.at) : Infinity;
              var rHintIdle = (rHint && rHint.idle) ? rHint.idle.length : 0;
              // 1.5.0（P2）：无预设 subagent 与 spawn_teammate 同等走「复用优先」——
              //   有 ≥2 空闲成员时直接拦；带 agent_preset 的放行（预设任务只能走 subagent）。
              var subagentPreset = "";
              try {
                var subagentCallArgs = null;
                if (a4Events) {
                  for (var sbi = a4Events.length - 1; sbi >= 0; sbi--) {
                    var sbe = a4Events[sbi];
                    var sbeName = (sbe && sbe.data && sbe.data.name) || (sbe && sbe.name) || "";
                    if (sbe && sbe.type === "tool/call" && (sbeName === "subagent" || sbeName === "subagent_fork")) {
                      subagentCallArgs = (sbe.data && (sbe.data.arguments || sbe.data.args || sbe.data.input)) || null;
                      break;
                    }
                  }
                }
                if (typeof subagentCallArgs === "string") subagentCallArgs = JSON.parse(subagentCallArgs);
                if (subagentCallArgs && typeof subagentCallArgs.agent_preset === "string") subagentPreset = subagentCallArgs.agent_preset.trim();
              } catch (ePreset) { subagentPreset = ""; }
              // 1.5.9：旧的「复用优先 idle≥2 就拦 subagent」分支已删除——
              // 它与下面的 subagent-not-allowed 判定重复，且旧文案会先命中，导致用户看到的不是新口径。
              // 1.5.4（用户 2026-11-12 拍板）：无预设 subagent 只有两种情况允许：
              // ① 带 agent_preset（预设任务只能走 subagent，上面的分支已放行）；
              // ② 团队名额满（>=16 人）且全部在忙（无空闲可复用）。
              // 其余一律 deny —— 防止漏网疯狂开子代理、每次都重付一遍完整前缀。
              if (!subagentPreset) {
                var rosterTotal = (rHint && typeof rHint.total === "number") ? rHint.total : -1;
                var idleCount = (rHint && rHint.idle) ? rHint.idle.length : 0;
                var teamFullAndBusy = rosterTotal >= 16 && idleCount === 0;
                if (!teamFullAndBusy) {
                  subagentHintHits++;
                  gateLog.push({
                    at: Date.now(),
                    tool: toolName,
                    domains: ["subagent-not-allowed"],
                    turn: null,
                    dispatched: idleCount,
                    required: 0,
                    kind: "subagent-not-allowed"
                  });
                  if (gateLog.length > 10) gateLog.shift();
                  if (spawnReuseGate === "enforce") {
                    var rosterDesc = (rosterTotal >= 0) ? ("当前花名册 " + rosterTotal + " 人、空闲 " + idleCount + " 人") : "花名册还没拉取或已过期";
                    return { kind: "deny", reason: "【子代理限制】subagent 只允许两种情况：① 必须指定专用预设（带 agent_preset，如 skill-master）；② 团队成员已满 16 人且全部在忙、确实没人可复用。现在是「" + rosterDesc + "」，不满足条件。请先 send_message 复用现有空闲成员；若无空闲成员，改用 spawn_teammate 建常驻成员。不要问我，直接改道继续——**无人值守时也必须自动改道，不许用 ask_user_question 打断用户。**" };
                  }
                }
              }
            } catch (eHint) { /* 提示失败不影响放行 */ }
          } catch (eA4) { /* fail-open */ }
        }
        if (toolName === "spawn_teammate" && spawnReuseGate !== "off") {
          try {
            var rSession = (exec && exec.agent && exec.agent.session) || null;
            var rEvents = (rSession && typeof rSession.snapshotEvents === "function") ? rSession.snapshotEvents() : null;
            var roster = refreshRoster(rEvents);
            var rosterFresh = (roster.ok === true) && roster.at > 0 && (Date.now() - roster.at) <= SPAWN_ROSTER_TTL_MS;
            if (rosterFresh && roster.idle.length > 0) {
              spawnReuseHits++;
              gateLog.push({
                at: Date.now(),
                tool: toolName,
                domains: ["spawn-reuse"],
                turn: (rEvents && roster.seq >= 0) ? String(roster.seq) : "",
                dispatched: roster.idle.length,
                required: 0,
                kind: "spawn-reuse-idle"
              });
              if (gateLog.length > 10) gateLog.shift();
              if (spawnReuseGate === "enforce") {
                return { kind: "deny", reason: buildReuseReason(roster) };
              }
            } else if (!rosterFresh) {
              spawnReuseWaitHits++;
              gateLog.push({
                at: Date.now(),
                tool: toolName,
                domains: ["spawn-reuse"],
                turn: "",
                dispatched: 0,
                required: 0,
                kind: "spawn-reuse-stale"
              });
              if (gateLog.length > 10) gateLog.shift();
              if (spawnReuseGate === "enforce") {
                return { kind: "deny", reason: buildRosterMissingReason(roster) };
              }
            }
          } catch (e) {
            // fail-safe：取事件/解析异常 → 视为「花名册不可用」→ 走「先查花名册」分支（不放行、不崩）
            spawnReuseWaitHits++;
            if (spawnReuseGate === "enforce") {
              return { kind: "deny", reason: buildRosterMissingReason({ at: 0, ok: false, idle: [], total: -1 }) };
            }
          }
        }
        if (isExempt(toolName)) return next();

        // v0.2.2 修复 Bug 1：子代理会话（header.parentSession 有值）没有任何开团队手段
        // （team_task_create / spawn_teammate 不存在，subagent 的 delegation depth 已用尽）
        // → 硬门对它不可满足 → 直接放行，否则死锁。
        if (isSubagentSession(exec)) return next();

        var agent = exec.agent;
        var sid = agent && agent.id ? String(agent.id) : "";
        var state = sid ? sessionDomains.get(sid) : null;
        var domains = (state && Array.isArray(state.domains)) ? state.domains : [];

        // Fluent MCP 工具本身就是 Fluent 域强信号
        if (isFluentMcp(toolName) && domains.indexOf("fluent") < 0) domains = domains.concat(["fluent"]);

        var inDomain = domains.length > 0;

        // 未入域：只拦动手类
        if (!inDomain && !isHeavy(toolName)) return next();

        // 2b-i. 扫本轮事件，看有没有开团队
        var session = agent && agent.session;
        if (!session || typeof session.snapshotEvents !== "function") return next();
        var events = session.snapshotEvents();
        if (!events || typeof events[Symbol.iterator] !== "function") return next();

        // 2b-i. 数「本轮真派活了几路」（1.1.0 治 D1：旧布尔判定只要派过一次就放行，派 1 路与派 3 路同价，
        // 「派一路 → 等它回来 → 再派一路」的串行排队永远过关）。每次调用都从事件流重算，不累加历史。
        // 1.1.1：顺带记下本轮最后一次 todo_write 的参数（todo_write 自身是豁免工具，不经过这里判定，
        // 所以只能在扫事件时取样），供三档判定数「标了几条并行」。
        var dispatchedCount = 0;
        // 1.3.2（F3，按实测因果链）：本 turn 内「单步最多的一步」派了几路。
        // 根因（session-8a8a6a44）：计数按 step 归零 → 每个 assistant message 就是一个 step，
        // 模型这一步派 3 路、下一步动手时又算 0 路 → edit/pwsh 全被拦，实测硬拦 16 次。
        // 所以放行改看「本 turn 内任一步曾派满」，同时保留「分步凑数」拦截：
        // 若每次只派 1 路，任一步的最大值都 =1 < 3，照样拦。
        var turnMaxStepDispatch = 0;
        var singleStepMarked = false;
        var turnTodoArgs = null;
        // 1.2.0（治「派一路等一路」）：派活计数只在**当前 step 窗口**内累积。
        // 旧行为是整轮（turn）累加 →「派 1 路 → 被拦 → 再补 2 路」也能凑够，等于放行串行排队。
        // 窗口信号一：宿主每个 model step 开始写一条 `step/start` 会话事件（data:{turn,step}）→ 归零。
        // 窗口信号二：tool/call 事件自带 data.step，作为兜底同步（缺 step/start 时仍能分窗）。
        // 两个信号都没有（例如离线复现的极简事件流）→ 退化为整轮累加，保证不误伤。
        var stepKey = null;
        // 1.2.0 临时诊断计数器（只累加，不参与任何判定）
        var dbgTurnStartCount = 0;
        var dbgLastToolCallName = null;
        var dbgLastTodoWriteLen = -1;
        for (var ev of events) {
          var type = ev && ev.type;
          if (type === "turn/start") {
            dispatchedCount = 0;
            turnMaxStepDispatch = 0;
            singleStepMarked = false;
            turnTodoArgs = null;
            lastTodoArgs = null;
            stepKey = null;
            dbgTurnStartCount++;
          } else if (type === "step/start") {
            dispatchedCount = 0;
            stepKey = (ev.data && ev.data.step != null) ? String(ev.data.step) : null;
          } else if (type === "tool/call") {
            var called = (ev.data && ev.data.name) || ev.name;
            dbgLastToolCallName = (typeof called === "string") ? called : dbgLastToolCallName;
            var callStep = (ev.data && ev.data.step != null) ? String(ev.data.step) : null;
            if (callStep !== null && callStep !== stepKey) {
              dispatchedCount = 0;
              stepKey = callStep;
            }
            if (typeof called === "string") {
              if (DISPATCH_TOOLS.has(called)) {
                dispatchedCount++;
                // F3：同一步内的峰值同时记到 turn 级，供放行判定
                if (dispatchedCount > turnMaxStepDispatch) turnMaxStepDispatch = dispatchedCount;
              }
              // F2：只给 wait_agent 用 —— 本会话内真开过执行者就永久记住（跨 turn，不随 turn/start 清空）。
              // 1.3.3（#3）：用 TEAM_OPEN_TOOLS（不含 send_message），与 F1 的派活路数口径分开。
              if (TEAM_OPEN_TOOLS.has(called)) {
                if (sid) sessionDispatchSeen.set(sid, true);
              }
              if (called === "todo_write") {
                var todoArgs = ev.data && (ev.data.arguments || ev.data.args || ev.data.input);
                turnTodoArgs = todoArgs;
                lastTodoArgs = todoArgs;
                try { dbgLastTodoWriteLen = (typeof todoArgs === "string") ? todoArgs.length : JSON.stringify(todoArgs).length; } catch (e1) { dbgLastTodoWriteLen = -2; }
                if (hasSingleStepMark(todoArgs)) singleStepMarked = true;
              }
            }
          }
        }
        // 1.4.0（标记驱动）：门只在明确标了【并行】时生效。
        //   ① todo 第一条含【不可拆·单步】或【独立完成】→ required 0（自己干）
        //   ② 没有任何【并行】标记 → required 0（不逼派活、不逼凑路数）
        //   ③ 标了 N 路并行 → required = min(N, gateMaxParallel)，必须在一步里真发满
        // gateMinDispatches 仅作观测/兼容配置，不参与 required。
        var parallelInfo = countParallelTodos(turnTodoArgs);
        var parallelTodos = parallelInfo.count;
        var todoTotal = parallelInfo.total;
        var independentMarked = hasIndependentMark(turnTodoArgs);
        var requiredDispatches = 0;
        var gateKind;
        if (singleStepMarked || independentMarked) {
          requiredDispatches = 0;
          gateKind = "single-step";
        } else if (parallelTodos === 0) {
          var missedFiles = countDistinctFiles(turnTodoArgs);
          if (missedFiles >= 3) {
            requiredDispatches = 0;
            gateKind = "parallel-missed";
          } else {
            requiredDispatches = 0;
            gateKind = "no-parallel-mark";
          }
        } else {
          requiredDispatches = Math.min(parallelTodos, Math.max(1, gateMaxParallel));
          gateKind = "parallel-contract";
        }
        // 观测（纯计数，不参与判定；同一 turn 只统计一次）
        try {
          var obsState = (sid && sessionDomains && typeof sessionDomains.get === "function") ? sessionDomains.get(sid) : null;
          var obsTurn = (obsState && obsState.turn != null) ? String(obsState.turn) : "";
          if (obsTurn && obsTurn !== obsSeenTurn) {
            obsSeenTurn = obsTurn;
            var dHK = (turnMaxStepDispatch >= 3) ? "3plus" : String(turnMaxStepDispatch);
            dispatchHistogram[dHK] = (dispatchHistogram[dHK] || 0) + 1;
            if (requiredDispatches > 0 && turnMaxStepDispatch < requiredDispatches) serialSuspect++;
            if ((gateKind === "single-step" || gateKind === "no-parallel-mark") && turnMaxStepDispatch === 0) selfWorkTurns++;
          }
        } catch (eObs) { /* 观测失败不影响判定 */ }
        dbgSnapshot = {
          at: Date.now(),
          sid: (typeof sid !== "undefined") ? sid : null,
          sessionSeq: (typeof session !== "undefined" && session && session.seq != null) ? Number(session.seq) : null,
          eventCount: (typeof events !== "undefined" && Array.isArray(events)) ? events.length : -1,
          lastEventType: (typeof events !== "undefined" && events && events.length) ? (events[events.length - 1] && events[events.length - 1].type) : null,
          turnStartSeen: dbgTurnStartCount > 0,
          turnStartCount: dbgTurnStartCount,
          lastToolCallName: dbgLastToolCallName,
          lastTodoWriteLen: dbgLastTodoWriteLen,
          turnTodoArgsHead: (typeof turnTodoArgs !== "undefined" && turnTodoArgs) ? String(turnTodoArgs).slice(0, 80) : null,
          lastTodoArgsHead: (typeof lastTodoArgs !== "undefined" && lastTodoArgs) ? String(lastTodoArgs).slice(0, 80) : null,
          singleStepMarked: (typeof singleStepMarked !== "undefined") ? singleStepMarked : null,
          dispatchedCount: dispatchedCount,
          required: requiredDispatches,
          kind: (typeof gateKind !== "undefined") ? gateKind : null,
          domains: (typeof domains !== "undefined" && Array.isArray(domains)) ? domains.slice() : []
        };
        lastGateDecision = {
          required: requiredDispatches,
          parallelTodos: parallelTodos,
          todoTotal: todoTotal,
          turnMax: turnMaxStepDispatch,
          kind: gateKind
        };
        var dispatchedTurnKey = (state && state.turn != null) ? String(state.turn) : "unknown";
        if (sid) {
          dispatchCounts.set(sid, {
            turn: dispatchedTurnKey,
            dispatched: dispatchedCount,
            required: requiredDispatches,
            singleStep: singleStepMarked,
            parallelTodos: parallelTodos,
            todoTotal: todoTotal,
            kind: gateKind
          });
        }
        // required === 0 = 明确不需要派活（单步 / 真·小任务）：直接放行，且不记 strike。
        // 1.5.10：复杂任务未开团队 —— todo 列了 ≥3 个不同文件、本 turn 却 0 派活。
        // 只在 enforce 档拦；warn 档只留痕（/status 的 lastGateKind 会显示 parallel-missed）。
        if (gateKind === "parallel-missed" && turnMaxStepDispatch === 0 && spawnReuseGate === "enforce") {
          try {
            gateLog.push({
              at: Date.now(),
              tool: toolName,
              domains: domains,
              turn: null,
              dispatched: 0,
              required: 0,
              kind: "parallel-missed"
            });
            if (gateLog.length > 10) gateLog.shift();
          } catch (ePM) { /* 记录失败不影响拦截 */ }
          return {
            kind: "deny",
            reason: "【复杂任务未开团队】你的 todo 里列了 " + countDistinctFiles(turnTodoArgs) + " 个不同产出文件，但本 turn 一次都没派活。按界限判据：≥3 个产出物且每个预计 ≥50 行 → 必须先开团队（spawn_teammate 建 ≥2 个成员，同一步发满；或标【并行×N】）；单件大活（>150 行）或每个产出都很小的，请在 todo 第一条写【独立完成】再动手。不要问我，直接改道继续。"
          };
        }
        if (requiredDispatches === 0 || turnMaxStepDispatch >= requiredDispatches) return next();

        // 2b-i-b. wait_agent 专项（1.1.0 治 D7）：它已移出 EXEMPT_TOOLS。
        // 默认 warn = 放行 + 记账（先量真实误拦率）；enforce = 不提前返回，落进下面现成的
        // strike/deny 分支（不新建返回结构，保证拒绝形态与其它工具完全一致）。
        if (toolName === "wait_agent") {
          // F2（1.3.3）：本会话内任意时刻真派过活 → 放行（跨 turn 看）。
          // 治 session-8a8a6a44 的 t2/s1、t2/s4：上一轮派过 3 路，本轮先等结果却被判「本轮还没有开团队」。
          // 从未派过活不走这一条 → 仍按 waitAgentGate（warn 放行 / enforce 拒），D7 要治的串行伪装照样拦。
          // 1.3.3（#4）：先把「归属」算出来再记一条，避免同一个 kind 既表示放行又表示拦截。
          //   released = "f2"   → 跨 turn 放行（见过真派活）
          //   released = "warn" → warn 档放行（没派过，本轮只观察）
          //   released = "deny" → 落进下面 strike/deny 分支（真拦）
          // 判读方式变化：以前按 kind === "wait-before-full-dispatch" 统计误拦率会把放行也算成拦截，
          // 现在必须按 released 过滤；/status 的 waitReleaseCounts 直接给这三个计数。
          var waitReleased = "deny";
          if (sid && sessionDispatchSeen.get(sid) === true) waitReleased = "f2";
          else if (waitAgentGate !== "enforce") waitReleased = "warn";
          waitReleaseCounts[waitReleased]++;
          lastWaitReleased = waitReleased;
          gateLog.push({
            at: Date.now(),
            tool: toolName,
            domains: domains.slice(),
            turn: dispatchedTurnKey,
            dispatched: dispatchedCount,
            required: requiredDispatches,
            kind: "wait-before-full-dispatch",
            released: waitReleased
          });
          if (gateLog.length > 10) gateLog.shift();
          if (waitReleased !== "deny") return next();
        }

        // 2b-ii. 防死循环：同一 turn 最多拦 maxStrikes 次
        var turnKey = (state && state.turn != null) ? String(state.turn) : "unknown";
        var strike = sid ? gateStrikes.get(sid) : null;
        if (!strike || strike.turn !== turnKey) {
          strike = { turn: turnKey, count: 0 };
          if (sid) gateStrikes.set(sid, strike);
        }
        if (strike.count >= maxStrikes) return next();
        strike.count++;

        // 2b-iii. 记录 + 拒绝
        gateLog.push({
          at: Date.now(),
          tool: toolName,
          domains: domains.slice(),
          turn: turnKey,
          dispatched: dispatchedCount,
          required: requiredDispatches,
          kind: "gate-deny"
        });
        if (gateLog.length > 10) gateLog.shift();

        return {
          kind: "deny",
          reason: buildDenyReason(toolName, domains, {
            count: strike.count,
            max: maxStrikes,
            dispatched: dispatchedCount,
            turnMax: turnMaxStepDispatch,
            required: requiredDispatches,
            parallelTodos: parallelTodos,
            gateKind: gateKind
          })
        };
      } catch (e) {
        // fail-open：任何异常都放行，绝不因为闸门自身 bug 阻塞正常工作
        return next();
      }
    });
  }

  // ── 3. 状态路由（排查用）──
  // ⚠️ v0.3.3：必须包进 ctx.effect。HMR 重载（改 cordis.patch.yml 会触发 recompose →
  // 本插件重新 apply）时若不清理旧路由，就会 `webserver: duplicate exact route`，
  // 并把本 entry 标成 `did not activate`（2026-11-08 实测：desktop-next.log L536/L547）。
  // 1.2.0：三个路由（/status / /tiers / /tier）共用一个 effect，disposer 一次性清理。
  ctx.effect(function () {
    var handles = [];
    try {
      // 3a. GET /status（1.1.x 原有，1.2.0 增 tiers 字段）
      var statusHandle = ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/status",
        handler: function (req, res) {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: "loopback only" });
            return;
          }
          var recent = [];
          for (var i = 0; i < gateLog.length; i++) {
            var g = gateLog[i];
            var entry = {
              tool: g.tool,
              domains: g.domains,
              turn: g.turn,
              at: new Date(g.at).toISOString(),
              dispatched: (typeof g.dispatched === "number" ? g.dispatched : null),
              required: (typeof g.required === "number" ? g.required : null),
              // 1.1.2 原文即 `|| "gate-deny"`，此处照抄，不要改成 null（前端/排障脚本依赖这个默认值）
              kind: g.kind || "gate-deny",
              // 1.3.3（#7）：wait 分支写进 gateLog 的 released（f2 / warn / deny）单独带出；
              // 其余 gateLog 条目没有这个字段 → 统一给 null，前端不用判 undefined。
              released: (g.released || null),
              name: (g.name || null)
            };
            // 1.1.2：配置非法回落也写 gateLog，这里把回落明细带出来（否则 /status 只看到 kind）
            // ⚠️ 这段 1.2.0 必须原样保留 —— 它不在「三档」相关路径上，容易被重写时漏掉。
            if (g.kind === "config-fallback") {
              entry.key = g.key;
              entry.value = (g.value === undefined ? null : g.value);
              entry.fallback = (typeof g.fallback === "number" ? g.fallback : null);
            }
            recent.push(entry);
          }
          json(res, 200, {
            ok: true,
            name: name,
            version: PKG_VERSION,
            injectLaw: injectLaw,
            // 1.2.0：读运行期快照（原 1.1.2 读启动期闭包变量 enforceGate，切档后会说谎）
            enforceTeamGate: !!(ACTIVE_TIER && ACTIVE_TIER.enforceTeamGate),
            gateMaxStrikes: (ACTIVE_TIER && typeof ACTIVE_TIER.gateMaxStrikes === "number") ? ACTIVE_TIER.gateMaxStrikes : 4,
            gateDomains: allowedDomains,
            // 1.2.0 新增：三档中控台状态（当前档 + 生效值 + 可选档清单）
            tiers: {
              active: ACTIVE_TIER ? ACTIVE_TIER.name : "custom",
              source: ACTIVE_TIER ? ACTIVE_TIER.source : "config",
              available: TIER_NAMES.slice(),
              // 1.3.3（#7）：当前档被 local.json 显式覆盖的键（空数组 = 完全按 preset 跑）
              overriddenKeys: (ACTIVE_TIER && Array.isArray(ACTIVE_TIER.overriddenKeys)) ? ACTIVE_TIER.overriddenKeys.slice() : [],
              values: {
                gateMinDispatches: ACTIVE_TIER ? ACTIVE_TIER.gateMinDispatches : null,
                gateMaxParallel: ACTIVE_TIER ? ACTIVE_TIER.gateMaxParallel : null,
                gateMaxStrikes: ACTIVE_TIER ? ACTIVE_TIER.gateMaxStrikes : null,
                waitAgentGate: ACTIVE_TIER ? ACTIVE_TIER.waitAgentGate : null,
                enforceTeamGate: ACTIVE_TIER ? !!(ACTIVE_TIER.enforceTeamGate) : null,
              }
            },
            // 1.1.0 并行门观测：minDispatches / waitAgentGate 生效值 + 当前各会话已派路数
            // 1.1.1：补 lastRequired / lastParallelTodos / lastTodoTotal / lastGateKind，重启后可直接验真三档判定
            parallelGate: {
              minDispatches: (ACTIVE_TIER && typeof ACTIVE_TIER.gateMinDispatches === "number") ? ACTIVE_TIER.gateMinDispatches : 1,
              // 1.1.2：并行契约封顶路数（当前生效值；未配置时 = 默认 6）
              maxParallel: (ACTIVE_TIER && typeof ACTIVE_TIER.gateMaxParallel === "number") ? ACTIVE_TIER.gateMaxParallel : 6,
              waitAgentGate: (ACTIVE_TIER && typeof ACTIVE_TIER.waitAgentGate === "string") ? ACTIVE_TIER.waitAgentGate : "warn",
              lastRequired: lastGateDecision.required,
              lastParallelTodos: lastGateDecision.parallelTodos,
              lastTodoTotal: lastGateDecision.todoTotal,
              // 1.3.x 花名册留痕（只观测，不参与判定）
              rosterCheckedThisTurn: rosterCheckedThisTurn,
              rosterHintHits: rosterHintHits,
        approvalAskedThisTurn: approvalAskedThisTurn,
        approvalMissingHits: approvalMissingHits,
              lastGateKind: lastGateDecision.kind,
              noTodoFallbackHits: noTodoFallbackHits,
            dispatchHistogram: { "0": dispatchHistogram["0"], "1": dispatchHistogram["1"], "2": dispatchHistogram["2"], "3plus": dispatchHistogram["3plus"] },
            selfWorkTurns: selfWorkTurns,
            serialSuspect: serialSuspect,
            subagentHintHits: subagentHintHits,
            readonlyPwshHits: readonlyPwshHits,
            badNameHits: badNameHits,
            subagentBeforeRestartHits: subagentBeforeRestartHits,
              // 1.3.2（F3/F4）：本 turn 内单步峰值 + 最近花名册的空闲名单
              turnMaxStepDispatch: (lastGateDecision && typeof lastGateDecision.turnMax === "number") ? lastGateDecision.turnMax : 0,
              idleMembers: (lastRoster && Array.isArray(lastRoster.idle)) ? lastRoster.idle.slice() : [],
              rosterAgeMs: (lastRoster && lastRoster.at) ? (Date.now() - lastRoster.at) : -1,
              spawnReuseGate: (ACTIVE_TIER && typeof ACTIVE_TIER.spawnReuseGate === "string") ? ACTIVE_TIER.spawnReuseGate : "enforce",
              spawnReuseHits: spawnReuseHits,
              spawnReuseWaitHits: spawnReuseWaitHits,
              // 1.3.3（#4）：wait_agent 归属计数 + 最近一次归属（"f2" | "warn" | "deny" | null）
              waitReleaseCounts: { f2: waitReleaseCounts.f2, warn: waitReleaseCounts.warn, deny: waitReleaseCounts.deny },
              lastWaitReleased: lastWaitReleased,
              lastTodoArgsSeen: !!lastTodoArgs,
              // 1.3.3（F2）：本会话内「曾真派过活」的会话数 —— wait_agent 跨 turn 放行的依据是否已在工作
              sessionsWithDispatchSeen: sessionDispatchSeen.size,
              trackedSessions: dispatchCounts.size,
              sessions: (function () {
                var out = [];
                dispatchCounts.forEach(function (v, k) {
                  out.push({
                    sid: k,
                    turn: v.turn,
                    dispatched: v.dispatched,
                    required: v.required,
                    singleStep: !!v.singleStep,
                    parallelTodos: (typeof v.parallelTodos === "number") ? v.parallelTodos : null,
                    todoTotal: (typeof v.todoTotal === "number") ? v.todoTotal : null,
                    kind: v.kind || null
                  });
                });
                return out;
              })()
            },
            dbg: dbgSnapshot,
            section: {
              name: LAW_SECTION_NAME,
              order: LAW_SECTION_ORDER,
              textLength: ACTIVE_LAW_TEXT.length
            },
            // 本机配置层状态（排查「local.json 到底加载了没 / 热重载生效没」）
            localConfig: {
              file: join(dshHome(), LOCAL_CONFIG_FILE),
              loaded: !!(_localCache && _localCache.data),
              mtime: (_localCache ? _localCache.mtime : null),
              activeMtime: _activeMtime,
              presetRouteCount: (ACTIVE_PRESET_ROUTES || []).length,
              profileName: ACTIVE_PROFILE_NAME
            },
            team: readProfileBundles(),
            gateLog: recent
          });
        }
      });
      handles.push(statusHandle);

      // 3b. GET /tiers —— 三档中控台的全量数据（客户端唯一数据源）
      var tiersHandle = ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/tiers",
        handler: function (req, res) {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: "loopback only" });
            return;
          }
          try {
            var host = readHostLimits();
            var presets = {};
            for (var i = 0; i < TIER_NAMES.length; i++) {
              var key = TIER_NAMES[i];
              var p = TIER_PRESETS[key];
              presets[key] = {
                name: key,
                labelZh: p.labelZh,
                labelEn: p.labelEn,
                summaryZh: p.summaryZh,
                summaryEn: p.summaryEn,
                gateMinDispatches: p.gateMinDispatches,
                gateMaxParallel: p.gateMaxParallel,
                gateMaxStrikes: p.gateMaxStrikes,
                waitAgentGate: p.waitAgentGate,
                enforceTeamGate: p.enforceTeamGate,
                injectLaw: p.injectLaw,
                maxMembers: p.maxMembers,
                maxActiveSubagents: p.maxActiveSubagents,
                budget: buildBudget(p, host)
              };
            }
            json(res, 200, {
              ok: true,
              version: PKG_VERSION,
              current: {
                name: ACTIVE_TIER ? ACTIVE_TIER.name : "custom",
                source: ACTIVE_TIER ? ACTIVE_TIER.source : "config",
                values: ACTIVE_TIER || null,
                budget: buildBudget(ACTIVE_TIER, host)
              },
              presets: presets,
              order: TIER_NAMES.slice(),
              hostLimits: host,
              configBaseline: _CONFIG_BASELINE,
              paths: {
                localConfig: join(dshHome(), LOCAL_CONFIG_FILE),
                patchFile: join(dshHome(), "profiles", ACTIVE_PROFILE_NAME, "cordis.patch.yml")
              }
            });
          } catch (e) {
            json(res, 500, { ok: false, error: String((e && e.message) || e) });
          }
        }
      });
      handles.push(tiersHandle);

      // 3c. POST /tier —— 切档（唯一写操作）
      // 三重校验：loopback + method === POST + 档名白名单。任何一条不过都不写盘。
      var tierHandle = ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/tier",
        handler: function (req, res) {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: "loopback only" });
            return;
          }
          if (String((req && req.method) || "").toUpperCase() !== "POST") {
            json(res, 405, { ok: false, error: "method not allowed: use POST" });
            return;
          }
          readJsonBody(req, 4096, function (err, body) {
            if (err) {
              json(res, 400, { ok: false, error: String((err && err.message) || err) });
              return;
            }
            var wanted = (body && typeof body.tier === "string") ? body.tier : "";
            if (wanted !== "custom" && TIER_NAMES.indexOf(wanted) < 0) {
              json(res, 400, {
                ok: false,
                error: "invalid tier: " + String(wanted),
                allowed: TIER_NAMES.concat(["custom"])
              });
              return;
            }
            var r = (wanted === "custom")
              ? applyTier("custom", body && body.values)
              : applyTier(wanted);
            if (!r || r.ok !== true) {
              json(res, 500, { ok: false, error: (r && r.error) ? r.error : "apply failed" });
              return;
            }
            json(res, 200, { ok: true, tier: r.tier, source: r.source, values: r.values });
          });
        }
      });
      handles.push(tierHandle);

      // 3d. POST /bench/micro（1.2.0 面板「一键测试」第 1 层：纯计算微基准，秒级）
      var benchMicroHandle = ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/bench/micro",
        handler: function (req, res) {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: "loopback only" });
            return;
          }
          if (String((req && req.method) || "").toUpperCase() !== "POST") {
            json(res, 405, { ok: false, error: "method not allowed: use POST" });
            return;
          }
          var r = benchMicro();
          json(res, 200, { ok: true, rounds: r.rounds, micro: r.micro, checksum: r.checksum });
        }
      });
      handles.push(benchMicroHandle);

      // 3e. POST /bench/parallel（第 2 层：真墙钟并行收益模拟）
      // 上限保护：tasks<=32 且 workMs<=1000（最坏 32s，但全程 await，不阻塞事件循环）
      var benchParallelHandle = ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/bench/parallel",
        handler: function (req, res) {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: "loopback only" });
            return;
          }
          if (String((req && req.method) || "").toUpperCase() !== "POST") {
            json(res, 405, { ok: false, error: "method not allowed: use POST" });
            return;
          }
          readJsonBody(req, 4096, function (err, body) {
            if (err) {
              json(res, 400, { ok: false, error: String((err && err.message) || err) });
              return;
            }
            var tasks = (body && body.tasks === undefined) ? 8 : Number(body.tasks);
            var workMs = (body && body.workMs === undefined) ? 120 : Number(body.workMs);
            if (!isFinite(tasks) || Math.floor(tasks) !== tasks || tasks < 1 || tasks > BENCH_MAX_TASKS) {
              json(res, 400, { ok: false, error: "invalid tasks: integer 1.." + BENCH_MAX_TASKS });
              return;
            }
            if (!isFinite(workMs) || Math.floor(workMs) !== workMs || workMs < 1 || workMs > BENCH_MAX_WORK_MS) {
              json(res, 400, { ok: false, error: "invalid workMs: integer 1.." + BENCH_MAX_WORK_MS });
              return;
            }
            benchParallel(tasks, workMs).then(function (r) {
              json(res, 200, { ok: true, tasks: r.tasks, workMs: r.workMs, groups: r.groups });
            }).catch(function (e) {
              json(res, 500, { ok: false, error: String((e && e.message) || e) });
            });
          });
        }
      });
      handles.push(benchParallelHandle);

      // disposer：HMR 卸载时清理全部路由，避免下次 apply 重复注册同一 exact route
      return function () {
        for (var i = 0; i < handles.length; i++) {
          try {
            var hdl = handles[i];
            if (hdl && typeof hdl.dispose === "function") hdl.dispose();
            else if (typeof hdl === "function") hdl();
          } catch (e2) { /* ignore */ }
        }
        // 兜底：按路径 unregister（handles 里某一条注册失败时也能清掉）
        var paths = [
          ROUTE_PREFIX + "/status",
          ROUTE_PREFIX + "/tiers",
          ROUTE_PREFIX + "/tier",
          ROUTE_PREFIX + "/bench/micro",
          ROUTE_PREFIX + "/bench/parallel"
        ];
        for (var j = 0; j < paths.length; j++) {
          try {
            if (typeof ctx.webServer.unregister === "function") ctx.webServer.unregister(paths[j]);
          } catch (e3) { /* ignore */ }
        }
      };
    } catch (e) {
      // 路由已存在（HMR 重载）→ 旧路由仍在服务，忽略即可，绝不让它阻塞启动
      return function () {
        for (var i = 0; i < handles.length; i++) {
          try {
            var hdl = handles[i];
            if (hdl && typeof hdl.dispose === "function") hdl.dispose();
            else if (typeof hdl === "function") hdl();
          } catch (e2) { /* ignore */ }
        }
      };
    }
  }, "dsh-agent-team-auto-orchestrator: status routes");
}
