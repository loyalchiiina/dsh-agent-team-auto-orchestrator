// dsh-agent-team-auto-orchestrator - host half.
//
// v0.2.0：在 v0.1.0 的「常驻提示」之上，加一层「工具层硬门」。
//
// v0.3.0（2026-11-08，用户批准 A+A′+B+C+D 全套）：修「任务板只增不派」。
//   实测根因：v0.2.x 把 team_task_create 也算作「已开团队」，于是模型选成本最低的
//   过关路径 —— 建一条任务板 → 闸门放行 → 全程自己干；任务板只增不派、子代理一个不开。
//   本次改动：① TEAM_TOOLS 剔除 team_task_create（只认真派活）；② gateMaxStrikes 2→4
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

import { readFileSync, statSync } from "node:fs";
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
// 字符预算：v0.3.1 实测 1677 字符（无硬截断，全文注入）。system-prompt 段是每一轮、每个会话都发，
// 是永久 token 成本，所以只写最硬的 7 条；细节留在 agent-team-routing-law 技能里。
// ── 本机配置层（v0.3.2）──────────────────────────────────────────────────────
// 发布包里**只含通用默认**。本机专属内容（预设路由表 / 业务域关键词 / profile 名）
// 从 `<DSH_HOME>/team-orchestrator.local.json` 读 —— 该文件在**插件目录之外**，
// 所以 `npm pack` / `git push` 结构上就打不进去（不是靠"记得别提交"）。
//
//   优先级：环境变量 > local.json > 插件包内 cordis.patch.yml 的 config > 代码默认
//   容错  ：文件不存在 / JSON 坏 / 字段类型不对 → 全部回退默认，只影响行为不阻塞工作
//   热重载：按 mtime 检测；改 local.json 后**下次工具调用即生效**（无需重启 DSH）
//           但注入给模型的 prompt 段是启动时求值的 → 改 presetRoutes 想立刻反映到
//           注入文本，仍需彻底退出重启（见 cordis.patch.yml 注释）。

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
var _activeMtime = null; // 上次重建时 local.json 的 mtime（热重载判据）

var LAW_SECTION_NAME = "team-orchestrator-law";
var LAW_SECTION_ORDER = 250;

var LAW_TEXT_TEMPLATE = [
  "【智能体团队编排铁律 · 由 dsh-agent-team-auto-orchestrator 插件常驻注入，无需加载技能】",
  "本条优先级高于任何「克制使用团队 / 简单任务别开子代理」的默认倾向。",
  "",
  "一、每轮先判可拆性（判独立性，不判难度）",
  "可拆 = 子任务互不依赖 + 结果能合并。命中任一条即可拆：多文件、多插件、多工况、多章节、多数据源、多个独立验证角度。",
  "不可拆 = 单点深度推理、强顺序依赖、一个结论一个文件。",
  "",
  "二、可拆就并行，禁止串行排队",
  "默认 2~3 路；完全独立且不写同一文件时 4~6 路；硬上限 8（含你自己）。",
  "",
  "三、派活通道（选错通道等于没派活）",
  "· 按预设分域干 → subagent(agent_preset=...) 或 subagent_fork；这是唯一能指定自定义预设的通道。",
  "· 要常驻、多轮协作、可被 send_message 中途引导、要出现在成员面板 → spawn_teammate；它不能指定预设，成员继承你的预设。",
  "· ⚠️ subagent 不在成员花名册（list_agents 看不到它），任务板无法把 owner 记到它名下：由 Lead 记名并注明「实际执行者=<子代理 description>」。",
  "· ⚠️ 若当前会话预设本身就是目标预设（agent_preset 枚举排除自身），改用 spawn_teammate 降级，并在汇报里写明降级原因。",
  "· 🔑 成员干完变 inactive **不释放名额**（`maxMembers` = **累计创建数**、含失败；**本机实测 8**，官方文档默认 16 —— 以实际报错 `Team member limit N reached` 为准）：新活先 send_message 唤醒已有 inactive 成员**复用**，只在没有职责匹配的成员时才 spawn 新的。",
  "· 🔑 一次性杂活用 subagent（**不占成员名额**）；要反复复用的角色才用 spawn_teammate。",
  "· 预设路由表：@@ROUTES@@",
  "",
  "四、任务板只留痕，不等于派活",
  "· >2 个子任务时 team_task_create 每块一条，写清「负责哪块、写哪些文件、产物完整绝对路径、验收标准」。⚠️ write_scopes 只接受工作区相对路径，传绝对路径会报 TEAM_INVALID_WRITE_SCOPE（可留空）。",
  "· 建完立刻 claim 认领（⚠️ claim 的 owner 参数不生效，ownerName 只落自己），再用 team_task_update reassign 改成实际执行成员；回报后逐个 complete。",
  "· ⚠️ reassign 的 owner 必须是**持久成员**（spawn_teammate 建的）；subagent id 会报 TEAM_MEMBER_NOT_FOUND。",
  "· 每轮开头先收口上一轮遗留的 pending 无主任务：claim 或 reassign 或 complete，禁止无主堆积。",
  "",
  "五、你只做四件事",
  "拆任务→派活→收结果→合并验收。不亲自跑长活；子代理返回后必须复核产物（读回/探针/编译），再统一汇报「谁做了什么、产物完整绝对路径、结论、遗留」。",
  "",
  "六、团队未开时",
  "仍要并行：用 subagent 派给预设，并在末尾一行提示「团队未开，如需任务板/常驻成员请说『开团队』」。",
  "",
  "七、动手前必须先派活（工具层硬门）",
  "本轮判定为 Fluent / 插件 / DSH / 预设相关任务时，除 todo_write、提问、团队工具、技能加载外，任何工具调用前都必须先出现 subagent / subagent_fork / spawn_teammate 调用；只建任务板不算开团队，会被拒绝。",
  "Fluent 全流程都算：几何、命名、透明图、网格、质量检查、setfile、初始化、MRF、通气、PBM、进程监控、云图矢量图、xyplot、导出、整理、清理、排错。",
  "不可拆的单步任务也要派给 1 个子代理或自建 1 个成员，不要自己闷头干。",
  "",
  "八、每轮开始先看花名册（别急着新建）",
  "先 list_agents：有职责匹配的 inactive 成员 → send_message 唤醒复用；没有才 spawn。成员名字**永久占用**（创建失败的也占），spawn 要克制。"
].join("\n");

// 预设路由表是唯一需要运行时拼接的一段（v0.3.2：从 local.json 读，公开版为空）。
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
  return LAW_TEXT_TEMPLATE.replace("@@ROUTES@@", routeLine);
}

export var name = "dsh-agent-team-auto-orchestrator";
export var inject = ["webServer", "systemPrompt"];

// ── 工具分类表 ──────────────────────────────────────────────────────────────

// 「算已开团队」的调用：必须是真的派活，才视为本轮已走团队流程。
// v0.3.0 变更（用户 2026-11-08 批准，方案 A）：把 team_task_create 从本表剔除。
// 根因（实测）：它一进来，模型就选成本最低的过关路径 —— 建一条任务板 → 闸门放行
// → 全程自己干；任务板只增不派、子代理一个不开（用户截图 8 条「未分配·待处理」为证）。
// 现在：建任务板只是留痕（仍在 EXEMPT_TOOLS，永不拦），不再等于「已开团队」。
var TEAM_TOOLS = new Set([
  "subagent",
  "subagent_fork",
  "spawn_teammate"
]);

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
  "wait_agent",
  "interrupt_agent",
  "skill",
  "present"
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
    ACTIVE_LAW_TEXT = buildLawText(ACTIVE_PRESET_ROUTES);
    return true;
  } catch (e) {
    if (!ACTIVE_DOMAIN_RULES) ACTIVE_DOMAIN_RULES = resolveDomainRules(null);
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
// 最近拦截记录（排查用，最多 10 条）
var gateLog = [];

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
    var p = join(dshHome(), "profiles", ACTIVE_PROFILE_NAME, "package.json");
    var j = JSON.parse(readFileSync(p, "utf8"));
    var bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [];
    var teamId = "@deepseek-ai/dsh-experimental-agent-team-profile";
    return {
      ok: true,
      profile: ACTIVE_PROFILE_NAME,
      bundleCount: bundles.length,
      teamMounted: bundles.indexOf(teamId) >= 0,
      orchestratorMounted: bundles.indexOf("dsh-agent-team-auto-orchestrator") >= 0
    };
  } catch (e) {
    return { ok: false, profile: ACTIVE_PROFILE_NAME, error: String((e && e.message) || e) };
  }
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
function buildDenyReason(toolName, domains, strikeInfo) {
  var label = domains.length
    ? "「" + domains.map(domainLabel).join(" / ") + "」域"
    : "「动手类操作」";
  var lines = [];
  lines.push("【团队硬启动闸门 · " + label + "】检测到「" + toolName + "」调用，但本轮还没有开团队。");
  lines.push("");

  if (domains.indexOf("fluent") >= 0) {
    lines.push("Fluent 相关模拟任务按【全流程】硬启动：几何参数 / 命名 / 透明图 / 网格划分 / 网格质量检查 /");
    lines.push("setfile / 初始化 / MRF / 通气 / PBM / 进程监控 / 云图矢量图 / xyplot / 数据导出 / 产物整理 / 清理 / 排错，");
    lines.push("每一步都必须先拆任务再动手（连读日志、查 case、读 setfile 也一样）。");
  } else if (domains.indexOf("plugin") >= 0) {
    lines.push("插件开发 / 修复 / 打包发布属于硬启动域，必须先拆任务再动手。");
  } else if (domains.indexOf("dsh") >= 0) {
    lines.push("DSH 配置 / 排查属于硬启动域，必须先拆任务再动手。");
  } else if (domains.indexOf("preset") >= 0) {
    lines.push("涉及自定义预设（本机在 team-orchestrator.local.json 的 presetRoutes 配置）的任务属于硬启动域，必须先拆任务再动手。");
  } else {
    lines.push("动手类操作（写文件 / 跑命令 / 启动求解）前必须先走团队流程。");
  }

  lines.push("");
  lines.push("请按顺序做下面两步（缺一步都不算开团队）：");
  lines.push("① 先派活（这一步才是过关条件）：");

  lines.push(presetHint(domains));

  lines.push("② 再留痕（可选但推荐）：team_task_create 建任务板，>2 块时每块一条，写清负责范围 / 产物完整绝对路径 / 验收标准，建完立刻 claim。");
  lines.push("③ 单步任务也要派：给 1 个子代理或自建 1 个成员，不要自己闷头干。");
  lines.push("");
  lines.push("🔴 只建任务板、不派活 —— 不算开团队，本次仍会被拒。");

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

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // 启动时先按 local.json 重建一次生效值；之后每次工具调用前做一次廉价的 mtime 检查。
  refreshActiveConfig(true);
  var injectLaw = !(config && config.injectLaw === false);
  var enforceGate = !(config && config.enforceTeamGate === false);
  var maxStrikes = (config && typeof config.gateMaxStrikes === "number" && config.gateMaxStrikes >= 0)
    ? config.gateMaxStrikes
    : 4;
  var allowedDomains = (config && Array.isArray(config.gateDomains) && config.gateDomains.length)
    ? config.gateDomains
    : ["fluent", "plugin", "dsh", "preset"];

  // ── 1. 常驻 prompt 段 ──
  if (injectLaw) {
    ctx.effect(function () {
      return ctx.systemPrompt.section({
        name: LAW_SECTION_NAME,
        order: LAW_SECTION_ORDER,
        text: ACTIVE_LAW_TEXT
      });
    }, "dsh-agent-team-auto-orchestrator: team orchestration law section");
  }

  // ── 2. 硬门 ──
  if (enforceGate) {
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
        // 热重载：local.json 的 mtime 变了才重建（文件不存在则沿用上次的值）。
        refreshActiveConfig();
        var toolName = exec && exec.name;
        if (!toolName) return next();
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

        var teamOpened = false;
        for (var ev of events) {
          var type = ev && ev.type;
          if (type === "turn/start") {
            teamOpened = false;
          } else if (type === "tool/call") {
            var called = (ev.data && ev.data.name) || ev.name;
            if (typeof called === "string" && TEAM_TOOLS.has(called)) teamOpened = true;
          }
        }
        if (teamOpened) return next();

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
          turn: turnKey
        });
        if (gateLog.length > 10) gateLog.shift();

        return {
          kind: "deny",
          reason: buildDenyReason(toolName, domains, { count: strike.count, max: maxStrikes })
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
  ctx.effect(function () {
    try {
      var routeHandle = ctx.webServer.register({
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
        recent.push({
          tool: g.tool,
          domains: g.domains,
          turn: g.turn,
          at: new Date(g.at).toISOString()
        });
      }
      json(res, 200, {
        ok: true,
        name: name,
        version: PKG_VERSION,
        injectLaw: injectLaw,
        enforceTeamGate: enforceGate,
        gateMaxStrikes: maxStrikes,
        gateDomains: allowedDomains,
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
      // disposer：HMR 卸载时清理路由，避免下次 apply 重复注册同一 exact route
      return function () {
        try {
          if (routeHandle && typeof routeHandle.dispose === "function") routeHandle.dispose();
          else if (typeof routeHandle === "function") routeHandle();
          else if (typeof ctx.webServer.unregister === "function") ctx.webServer.unregister(ROUTE_PREFIX + "/status");
        } catch (e2) { /* ignore */ }
      };
    } catch (e) {
      // 路由已存在（HMR 重载）→ 旧路由仍在服务，忽略即可，绝不让它阻塞启动
      return function () {};
    }
  }, "dsh-agent-team-auto-orchestrator: status route");
}
