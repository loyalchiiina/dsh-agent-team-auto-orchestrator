# CHANGELOG

## 1.3.3 — 2026-11-11

本轮按用户实测会话 `session-8a8a6a44`（14:06→14:34）的因果链收口：通道选择完全正确（`subagent = 0`，全是团队成员），却被「计数口径」逼成乱建 —— `send_message` 把活派给 3 个空闲成员后闸门仍判「本 step 已真派活 0 路」，`edit`/`pwsh` 被拦；模型于是改用唯一能计数的 `spawn_teammate` 连建 `employee-6`…`employee-14` 直到 16/16 满员，满员后又退回 `subagent_fork`（11 次）。累计派活 27 次（spawn 16 + fork 11）、硬门真拦 16 次（edit 8 / pwsh 6 / wait 2）、`list_agents` 全程只 4 次、`employee-3` 一直空着。

> **F1 / F3 / F4 / F5 的归属**：这四条闸门计数修正是 **1.3.2 发布（commit `dad1cf9`）之后**才写进代码的 —— 已发布版 `lib\index.js`（1,946 行）里没有 `DISPATCH_TOOLS` / `turnMaxStepDispatch` / `spawnReuseGate`，已发布版 CHANGELOG（699 行）的 1.3.2 节也没有这段叙述。因此它们**首次发布于 1.3.3**，逐条见下；npm 上的 1.3.2 **不含**这些改动，请以本节为准。

### 修复：F1 / F3 / F4 / F5 —— 闸门计数修正（**首次发布于 1.3.3**）

四条修正直接对应上面那次会话暴露的问题（该会话 27 次派活里 16 次是被闸门逼出来的新建、`list_agents` 全程只调 4 次）：

- **F1 `send_message` 计入派活路数**：新增 `DISPATCH_TOOLS`（`subagent`/`subagent_fork`/`spawn_teammate`/`send_message`）替换计数用的 `TEAM_TOOLS`。`send_message` 仍在 `EXEMPT_TOOLS`（随时可调、不被拦），但本闸门是**扫会话事件**计数，不依赖调用入口，豁免不会让它漏计。
- **F3 放行判据改「本 turn 内单步最多派了几路」**：新增 `turnMaxStepDispatch`（`turn/start` 重置、每步峰值取 max），放行条件由 `dispatchedCount >= required` 改为 `turnMaxStepDispatch >= required`。四档判定链一字未改。「分步凑数」仍拦得住：每次只派 1 路，任一步峰值都 =1。
- **F4 `spawn_teammate` 前置复用校验**：取**最近一次** `list_agents` 结果（按 `tool/call` 的 callId 与 `tool/result` 配对，从 `message.content[*].text` 解析 JSON 数组，统计 `role==='teammate' && status==='inactive'`）。花名册在 120 秒内且空闲 ≥1 → **拒绝新建**；花名册缺失/过期/解析失败 → 要求先 `list_agents`（**不因为查不到就放行**）。开关 `spawnReuseGate`：`enforce`（默认）/ `warn`（只记 log）/ `off`。
- **F5 拒绝文案直接点名**：`【复用优先】当前有 N 位空闲成员：a、b、c。` + 「先把这批活用 send_message 分给它们（一次发满），确实分不完才新建。」+「若花名册已过期，先调 list_agents 再派。」
- 新增 `/status.parallelGate` 观测字段：`turnMaxStepDispatch`、`idleMembers`、`rosterAgeMs`、`spawnReuseGate`、`spawnReuseHits`、`spawnReuseWaitHits`。
- 花名册解析只在遇到 `list_agents` 的 result 时做一次并按 `seq` 缓存，不做每次调用的全量 `JSON.parse`。
- **注入正文零改动**（本批只改闸门逻辑，模板仍 3,709 字符、运行时 3,848 / 3,846）；四档判定块与改前逐字节一致。
- 测试：新增 `test/gate-f1f3f4f5.test.mjs`，覆盖 F1 计入、F3 峰值与 reset、F4 五种花名册状态与 warn/off、F5 文案三段、F2 跨 turn、按 seq 缓存（用例数见下文「测试」一节的实测值）；三套既有用例（16 + 28 + 7）断言值零改动 —— 只把测试脚手架的计数集合与 pass 判据同步到新实现。

### 修复：F2 `wait_agent` 跨 turn 判定（治误拦）

新增按会话粘住的 `sessionDispatchSeen`（扫事件时只要出现任一派活工具就置位，`turn/start` **不清空**）。`wait_agent` 若在本会话内**任意时刻**真派过活 → 放行（照旧记 `gateLog.kind = "wait-before-full-dispatch"`）；从未派过活仍按 `waitAgentGate`（默认 `warn` 放行 + 记账，`enforce` 落进原有 strike/deny），1.1.0 D7 要治的「先等结果再派活」串行伪装照样拦。`/status.parallelGate` 新增 `sessionsWithDispatchSeen`。

### 修复：`/status` 暴露 wait 放行归属

`gateLog` 的 wait 分支本来就写了 `released`（取值 `f2` / `warn` / `deny`，分别对应「本会话真派过活 → 放行」「`waitAgentGate` 非 `enforce` → 只观察」「落进原有 strike/deny 真拦」），但 `/status` 的 `gateLog[i]` 映射只搬 `tool` / `domains` / `turn` / `at` / `dispatched` / `required` / `kind` 七项，把 `released` 漏掉了 —— 排障时只看到「被 wait 拦了」，看不出它是「因为有派活被放行」还是「warn 档放过」还是「真拦」。现在每条 `gateLog` 条目统一带 `released`：wait 分支给 `f2` / `warn` / `deny`，其余条目（`gate-deny`、`roster-not-checked`、`approval-missing`、`config-fallback` 等）一律给 `null`（显式 `null`，不是省略键、不是 `undefined`，前端不必判 `undefined`）。源码：`lib\index.js` L1954–L1957（`released: (g.released || null)`）；累计计数另有 `/status` 的 `waitReleaseCounts`（`f2` / `warn` / `deny` 三个数，L2016）。

### 修复：命名档下 `local.json` 的显式键可覆盖 preset

改动前：命名档（`lean` / `balanced` / `turbo`）走 `resolveTierPreset` **直接返回字面量**，`local.json` 里写的 6 个行为键（`gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `spawnReuseGate` / `enforceTeamGate`）**一个都不能覆盖**；而 `lib\index.js` 的注释又写着「local.json 优先于 cordis config / 代码默认」—— 文档与实现互相矛盾，典型事故就是「在 turbo 档里把闸门关了却没生效」。

现在改为 **`local.json`（显式提供）> 命名档 preset > 代码默认**（`buildActiveTier`，L316–L345），「显式提供」的判据是 `Object.prototype.hasOwnProperty`（`pickLocalOverride`，L289–L314）：

- 写 `false` / `0` / `"off"` **也算显式提供** —— 真值判断会把 `0` 当成「没写」而漏掉覆盖，这正是原事故的另一半；
- **非法值不覆盖**：区间外整数、非法枚举一律保持 preset 原值（函数返回 `undefined`），且不会让整份配置失效；
- 只在值与 preset **不同**时才记进 `overriddenKeys`（L340–L343），与 preset 相同的显式写值不算「覆盖」。

新增观测：`/status.tiers.overriddenKeys` 列出当前档被 `local.json` 显式覆盖掉的键名（空数组 = 完全按 preset 跑，L1982）；`custom` 档本身即用户显式值，不单列（L355）。

**故意不纳入覆盖的两个键**：`maxMembers` / `maxActiveSubagents` —— 它们是宿主现读的实测值，让 `local.json` 覆盖等于「拿假值压真值」（L282 注释即此意）；要改这两个只能改 preset 或找宿主。

另：`enforceTeamGate` 被归一化成 **布尔** `true` / `false`（`"on"` / `"true"` / `"1"` → `true`，`"off"` / `"false"` / `"0"` → `false`，L301–L306），不是字符串 `"off"` —— 因为闸门判据是 `=== false`。所以 `/status.tiers.values.enforceTeamGate` 显示 `false` 即表示「已关闸」（`!!ACTIVE_TIER.enforceTeamGate`，L1988）。

### 追加：B5 重复派提醒（注入词，v2 已落）

注入第五节已有「派活前除了查「谁空闲」，还要**对一眼上一步派过什么** —— 同一个活不要重复派两遍」。实测依据：同一成员 16 秒内（15:14:58 / 15:15:14）收到几乎一样的活。本轮在 README 第五节要点里补上该条并给出实测依据，注入正文未再改动。

### 文档：注入节数口径校正（11 节 → 12 节）

`LAW_TEXT_TEMPLATE` 的序号标题实际有 **12** 个（〇、先判，再动手 ＋ 一～十一）。此前 README（中文功能描述 / English 描述 / 「注入的编排方法论：11 节」标题 / 节标题清单 / 「节数」口径行）、`docs\team-orchestration-methodology.md`（§3.1 / 路 B 第 1 步 / 配置 `injectLaw` 注释）、`cordis.patch.yml`（第 10 行注释）均误写为 **11 节**，本次统一为 **12 节**；`package.json` 的 description 本来就写「12 节」，未动。同时把 README 节标题清单里第 9 节从「九、任务板：每批派了什么、给了谁、做到哪了」改回与代码逐字一致的「九、任务板：派了活就要留痕」（另有 5 处短标题按代码补全：〇 先判，再动手 / 一 要不要交出去：两条判据 / 二 交给谁：看「能不能反悔」/ 八 跨会话要能接上 / 十一 工具层有一道硬门）。本文件 1.1.2 / 1.3.0 等历史节里的「11 节」是当时的记录，保留原样不改。

### 口径（实测，非推算）

注入模板本体 **3,709 UTF-16 字符 / 3,709 码点 / 8,862 UTF-8 字节 / 65 段**（源码数组块含引号缩进共 4,074 字符）；占位符 `@@ROUTES@@` ×1 / `@@MAXPAR@@` ×2 / `@@MINDISP@@` ×2，无其它 `@@`；运行时 `buildLawText` 实测 **3,848（gateMaxParallel = 10）/ 3,846（= 6）**，渲染后无 `@@` 残留。推导：`3,709 − 10 + 185 + 2×(2−10) + 2×(1−11) = 3,848`（`routeLine` 实测 **185** 字符；两处 `@@MINDISP@@` 占位符各 **11** 字符，换成一位数基础门槛）。旧文把 `routeLine` 记成 183、把 `@@MINDISP@@` 记成 10 字符 —— 两个错 **+2 / −2 恰好抵消**，所以 3,848 是侥幸正确的结果，不是推导正确的证据（详见下文「1.2.0 未发布期修订」的口径条）。

### 测试

`test\` 下**五个**测试文件实测 **96/96** 全绿（核对时刻 **2026-11-11 16:41**，代码已冻结：`lib\index.js` 118,357 B / 2,253 行）：`gate-b` 28 / `gate-maxparallel` 16 / `singlestep-first` 7 / `gate-f1f3f4f5` 27（原 20 + F2 五例 + 后续追加 2 例）/ `config-tier-spawnreuse` **18**（10 → 18，新增 8 例覆盖「local.json 显式键覆盖命名档」与「/status 暴露 released / overriddenKeys」）。`gate-b` 与 `gate-maxparallel` 的**脚手架**各补一个 `sessionDispatchSeen` 形参（不补则真实代码里的新语句越界），**断言期望值零改动**。注：本节早前写的是「四文件合计 76」、其后一度是「88/88」—— 都是代码侧并发追加测试时的中间值；代码已于 2026-11-11 16:40 冻结，**本条即为冻结后的终值**（96 = 16 + 28 + 7 + 27 + 18，`^FAIL` 行数 0，`npm test` 与逐文件单跑两种跑法结果一致）。

### 已知限制

`sessionDispatchSeen` 按会话粘住且不随进程重启持久化：重启后本会话的历史事件仍会被扫到（事件流在会话里），所以「派过活」不会因重启丢失；但跨会话不共享 —— 这是刻意的，避免 A 会话的派活替 B 会话开绿灯。

### 已知限制（运行态未验证）

- **F2 跨 turn `wait_agent` 放行**：本版只做代码走查（`sessionDispatchSeen` 按会话粘住、`turn/start` 不清空、`released` 三值归属），**未做运行态构造测试**。原因是该分支要求会话已被打上域标记（`lib\index.js` L1708 的 `if (!inDomain && !isHeavy(toolName)) return next();` 在 L1855 的 wait 分支之前），而域标记只由**用户消息文本**经 `detectDomains()` 决定（L1612），不匹配域词的会话里 `wait_agent` 根本进不到 F2 分支。首次遇到「跨 turn 先 wait 结果被拒」时请回来核这一条。
- 其余三条（**F1** `send_message` 计入派活路数、**F3** 本 turn 单步峰值放行、**F4/F5** spawn 前置复用校验 + 点名空闲成员）**均已在运行态实测通过**。

## 1.3.2 — 2026-11-11

### 新增：查花名册留痕 + 派活先报批（只留痕，不拦截）

- `parallelGate.rosterHintHits`：本轮出现动手类或派活动作、但还没 `list_agents` 过 → 记一条 `roster-not-checked`。计数点在总开关之前，**闸门关着也照记**。
- `parallelGate.approvalMissingHits`：一次派 ≥2 路、或新建常驻成员，而本轮没用 `ask_user_question` 问过 → 记一条 `approval-missing`；**第 1 路静默通过**，小任务不刷屏。
- `parallelGate.approvalAskedThisTurn`：本轮是否问过。
- 三条都**只 warn、绝不 deny**，四档判定链一字未改。

### 注入正文（61 → 65 段，3,305 → 3,709 字符）

- 派活前 `list_agents` 提为固定开场动作（原来只在某节里一句）。
- 新增 ④「派活先报批」：一次派 ≥2 路或新建成员时，先 `ask_user_question` 一次性问清「这批派几路 / 分别给谁 / 你同意吗」；三种情形免问（用户说过直接干或无人值守、只派 1 路且纯只读、复用已同意过的同一批成员）。
- 新增「子代理会话 ID 不可寻址」：`send_message` 只能发 `list_agents` 返回的名字，子代理跑起来就叫不动了。
- 运行时注入 3,848 字符（上限 10 档）/ 3,846（上限 6 档）。

### 修正

- CHANGELOG 1.3.1 节有四处字符损坏（控制字符吞字导致 `agent_preset` / `exports["./client"]` / `read` / `test\` 显示不全），已修复。代码不受影响。
## 1.3.1 — 2026-11-11（与 1.3.0 逐字节相同；当时误判 1.3.0 未发布而绕号重发）

- 版本号取 1.3.1 而非 1.3.0：1.3.0 的 `npm publish` 一度返回 `E409 Cannot publish over previously staged version`，当时 `npm view` 查不到该版本、`npm stage list` 也显示无暂存，据此判断为 npm 侧孤儿暂存标记且无法清除，遂绕过该号重发。**2026-11-11 16:22 事后核实：1.3.0 实际已完整发布成功** —— registry 上存在该版本，发布时刻 `2026-11-11T03:24:01Z`（北京时间 11:24:01），tarball SHA1 `2d3353a0f7f6cb24002a8dcf3e6854beb645df5e`，解包 11 个文件齐全，`lib\index.js` 94,218 B / SHA256 `7EE8DDEC57FFABAF13EA928B3C51087CFBA0AD0D4099284BF16961CD5C4CB91E`。1.3.1 于 `03:27:06Z` 发布，两版 `lib\index.js` 是**同一个 git blob**（`3b7a5ddbb85df51dce5233b71712324ba429ab60`，94,218 B），仅 `package.json` 的 `version` 不同 —— 故「代码与 1.3.0 一字不差」成立，但 1.3.1 并非 1.3.0 的替代品，两者等价。
- 1.3.0 于 `2026-11-11T06:02:02Z` 被标为 `deprecated`，deprecated 文案复述了上面那条错误判断（「孤儿暂存标记未能完整发布」）。该版本实际完整可用；要去掉这条误导提示，须由用户在批准后执行 `npm deprecate dsh-agent-team-auto-orchestrator@1.3.0 ""`（本次不动 registry）。

- 版本号 1.2.0 → 1.3.0：1.2.0 从未发布到 npm（发布 1.3.0 的那一刻 npm 上最新仍是 1.0.1，1.3.0 于 `03:24:01Z` 成为第一个带上「未发布期」全部改动的版本）。
- 注入正文改为方法论版 11 节，并叠加 v2 的 10 条修订：小任务开新代理必亏 / agent_preset 白名单降级句 / N 个独立活同一步分给 N 个空闲成员 / 不重复派同一个活 / 任务板仅在可能跨重启时建 / wait_agent 只能派完再用 / 真·小任务免派与「不写 todo 按基础门槛算」兜底。
- 移除设置页面板：删 lib\client.js，package.json 去掉 dsh.client 与 exports["./client"] —— 不再有客户端 bundle，改完只需重启宿主。
- EXEMPT_TOOLS 补 read / glob / grep（compress 一族此前已豁免），纯只读工具不再被团队硬门拦截。
- 插件自带 cordis.patch.yml 的 gateMaxParallel 由 10 降为 6（母包仍 10，本机实际注入不受影响）。
- 新增 GET /status 的 dbg 诊断字段（纯只读，用于定位闸门判定现场）。
- 新增 test\ 三个测试文件（合计 51 用例）与 scripts\scan-private.mjs（prepublishOnly 脱敏闸门）。

## 1.2.0 未发布期修订 — 2026-11-10（版本号仍 1.2.0，未 bump）

### 变更：注入正文换成方法论版（按优先级重排为 11 节），取消双模式

- 注入段由 14 节 worker-pool 版**整块替换**为方法论版，并按优先级兜底重排为 11 节（先判该不该交 → 再判交给谁 → 再拆几路 → 再派给空闲者）（逐字节标题：〇 先判，再动手 / 一 要不要交出去：两条判据 / 二 交给谁：看「能不能反悔」/ 三 能拆就拆 / 四 拆了就同时发 / 五 先派给有空的人 / 六 我只做四件事 / 七 名字要能点名 / 八 跨会话要能接上 / 九 任务板：派了活就要留痕 / 十 预设路由 / 十一 工具层有一道硬门（执行保障，不改变上面的方法））。
- 中途曾做过 classic/pool 双模式（`ACTIVE_ORCH_MODE` + `applyMode()` + `POST /tier` 的 `mode` 分支 + `METHOD_LAW_TEMPLATE`），**已全部拆除**：现只有一套正文、一个常量 `LAW_TEXT_TEMPLATE`，`buildLawText` 恢复为 `var out = LAW_TEXT_TEMPLATE;` 单行取值。
- 正文不再出现任何 token 数字（`28,300` / `6,012` / `<2000` / `≤15 次`），经济判断改由「一、要不要交出去：两条判据」承载；实测数字只保留在本文档与 README。

### 移除：设置页面板（`lib/client.js` 整个删除）

- 删 `lib/client.js`（原 46,057 字节 / 875 行）；`package.json` 同步删 `exports["./client"]`（现 exports 3 键：`.` / `./package.json` / `./locale/*.json`）与整个 `dsh.client`（现 `dsh` 只剩 `bundle`）——插件不再有客户端 bundle，**改完只需重启宿主**，不再需要 Ctrl+Shift+R。
- 面板上的三档滑块、自定义表格、性能基准按钮全部随文件消失；**后端能力一条没删**：`GET /status`、`GET /tiers`、`POST /tier`、`POST /bench/micro`、`POST /bench/parallel` 五条路由与 disposer `paths` 原样保留，改档/跑基准仍需时可直接打回环 HTTP。
- `package.json` 的 `description` 重写：去掉「设置页提供三档中控台…不用退出 DSH」，改为「三档通过本机回环 HTTP 路由切换」；「团队编排铁律」改为「智能体团队编排方法论（11 节）」；「封顶路数」改为「路数可配 2~16」。

### 追加：成员池自检与补建（用户选 B：另建员工1号~5号）

- 背景：池子里已有 7 个老分析员（`patch-planner`、`scan-fixer` 这类，名字改不了），「池里有几个人」不能当判据 —— 判定依据落到**技术名前缀** `employee-N` 上。
- 第五节改写：各对话共享同一个成员池，开工前先 `list_agents` 认自己的牛马 —— 有 `employee-N` 且空闲就直接派、别重复建；**一个都没有或不足五个、且没到名额上限就补齐**（技术名 `employee-1` … `employee-5`，spawn 只收小写连字符，对外称「员工1号」…「员工5号」）；**够五个就一个都别建**。
- 第七节首行补技术名映射：`员工N号` ↔ `employee-N`，说明 spawn 只收小写连字符。
- ⚠️ 上一条里的「不足五个就补齐 / 够五个就一个都别建」是**当时的固定个数判据**，已在同版本后续 **A 条**中**废除**（改为「任何空闲成员一律复用、空闲不够才新建、补到正好够用」），以 A 条为准。
- 模板 1838 → **2049 UTF-16 字符**（48 → 51 行）；运行时 1987 → **2198**（`gateMaxParallel: 6` 时 2196）。占位符计数不变（`@@ROUTES@@`×1 / `@@MAXPAR@@`×2 / `@@MINDISP@@`×1）。⚠️ 该组数字是 **A~F 修订前**的中间值，当前值见下方「口径」。

### 清理：经济阈值占位符与配置键（死配置）

- 新正文不再使用 `@@ECON_LOW@@` / `@@ECON_LOW_C@@` / `@@ECON_LOW_CALLS@@` / `@@ECON_HIGH@@`，`buildLawText` 里对应 4 行 split/join 一并删除。
- 随之删除 30 行已成死配置的键：`TIER_PRESETS` 三档的 `econLowTok` / `econLowCalls` / `econHighTok`、`_CONFIG_BASELINE` 与 custom 基线的同名字段、`CUSTOM_INT_FIELDS` 三条、`buildActiveTier` 的 preset/custom 映射、`/tiers` 的 presets 输出、`/status` 的 `tiers.values`。三档的硬门参数（`gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `enforceTeamGate`）**未动**。

### 修复：成员复用 + 并行计数 + 任务板留痕（A~F 六条，按用户实测漏洞）

- **A 第五节重写（先派给有空的人）**：删掉「五个」固定个数判据 —— ① 任何空闲成员（`inactive`，不分「员工N号」还是早先建的专职成员）一律 `send_message` 复用；② 空闲不够同时开工才新建，补到正好够用、不凑固定个数，编号只增不减；③ 全员在忙且确实没人空闲才改开 `subagent`。实测背景：同一对话 3 轮内 `spawn_teammate` 17 次、其中 9 次明明有 13~15 个成员空闲（`list_agents` 早 4 分钟已显示空闲 13，随后仍连建 `employee-10`~`employee-14`）；另有一次 `spawn` 报 `Team member limit 16 reached` 时仍有 13 人空闲。
- **C 新建前必须同一步重扫**：每次 `spawn_teammate` 之前，必须在**同一个 step** 里重新 `list_agents`，禁止拿上一步或更早的旧结果当依据。
- **D 名额满只挡新建**：`Team member limit N reached` 只影响「新建」，唤醒现有 inactive 成员永远可用；绝不许因为「满了」就改用 `subagent`。
- **E `subagent` 的独占场景**：只有「这个活必须在某个专用预设下执行」才用 `subagent`（常驻成员只能继承父对话预设、不能单独指定预设）；预设 id 走第十节 `@@ROUTES@@` 占位，不硬编码。三选一顺序：需预设 → `subagent(agent_preset=X)`；不需预设且有人空闲 → `send_message`；不需预设且确实无人空闲 → 新建；名额也满 → 才考虑 `subagent`。与 D 不矛盾。
- **F 第九节任务板从「可选」改「跟派活数量硬挂钩」**：本轮派出 **≥2 路**（或新建了成员）→ **必须建板**，每活一条，写清「负责范围 / 产物完整绝对路径 / 验收标准」，派完立刻 `claim`、做完标 `complete`；只有 1 路、纯问答、或单步任务才不建板；汇报按「任务 → 谁 → 状态（待办 / 进行中 / 已完成）」三档；**建板不能代替派活**。背景：`session-adb6afb4` 全程 1,189 行事件里 `spawn_teammate` 17 次、`send_message` 30 次、`subagent` 13 次，而 `team_task_create/update/list/get` **全部 0 次** —— 旧文案「串着做两三件的不用建板」被当成整场豁免。（v2 已进一步降级为「要跨重启接着做才建板」，见下节。）
- **B 硬门计数改成按 step 分窗**：`dispatchedCount` 原来整轮累计，于是「派 1 路 → 被拦 → 再补 2 路」也能过关。现改为 `step/start`（或 `tool/call.data.step` 变化）即归零，只看**当前 step** 的派活数；四档判定逻辑逐字未改，只改计数窗口。两个信号都没有（离线/极简事件流）时退化为整轮累加，兼容旧行为。拒绝文案同步点名「**同一步内**一次派满，分步凑数不算」。
### 修复：上下文管理工具豁免 + 多条独立活同时派（G1 / G2）

- **G1（真 bug）`EXEMPT_TOOLS` 漏了上下文管理工具**：实测 `session-adb6afb4` 在 `00:12:32` 报 `Error: 【团队硬启动闸门 ·「插件开发 / DSH 排查/配置 / 自定义预设」域】检测到「compress」调用，但本轮还没有开团队。` —— `compress` / `decompress` / `search_context` / `acp_status` 是**纯上下文管理**（只读写上下文，不写盘、不跑命令、不联网、无任何副作用），永远不该被这道门拦。已在 `EXEMPT_TOOLS` 补 4 项，并加注释「上下文管理类工具无副作用（只读写上下文、不写盘、不跑命令、不联网），永不拦」。
- **G2（注入词）缺一句「多条独立活必须同时派给多个成员」**：实测 `session-0c69d8cb` 只有 **7 个成员**却发生 **137 次 `send_message`**，其中 `dock-player-impl` 一个人独占 **75 次**、`qq-integration-impl` 17 次、`songwriter-runner` 12 次；整个 **165 轮**里「同一步 ≥2 路」的并行批次只有 **8 次**，`team_task_create` 仍为 **0**。根因是把活排成队、一个接一个地喂给同一个成员（用户原话：「已经有队员的情况下一个队员不增加，一直和一个对话对话」）。已在**第五节末尾**追加 ④：「手里同时有 N 个互不依赖的活 → **就把 N 个活同时分给 N 个不同的空闲成员**（同一个 step 内一次发完）；禁止把活排成队、一个接一个地喂给同一个成员 —— 那样即使有 10 个人也只有一个在干。」
### 追加（同版本规则修订 v2）

注入词 9 处文案改动 + `EXEMPT_TOOLS` 三项只读工具 + 本插件 `cordis.patch.yml` 默认并行上限 10→6（**母包仍为 10，本机实注不受影响**）。逐条：

1. **第一节末尾新增**：新开一个代理的固定开销与任务大小无关（每开一个新的都要重新付一遍完整上下文）—— 小任务开新代理必亏：能自己做就自己做，能盘活空闲队员就盘活（前缀只付一次、之后反复接活）。
2. **第二节「常驻成员不给身份…」之前新增**：`agent_preset` 能不能用，取决于本机预设有没有配白名单：若报「selection is disabled」或「must be one of」，说明本机没开预设选择 —— 直接用当前预设 / 盘活队员把活干完，不要反复试。
3. **第五节 ④ 上移**：从节末移到 ③ 之后（文字一字未改），让「先判忙闲 → 再一次性分发」的顺序连续。
4. **第五节压掉半句重复**：「只有「必须换预设」才走 subagent（见第二节）：它不是团队成员用完后的替补 —— 名额满只挡住新建，不挡唤醒。」→「只有「必须换预设」才走 subagent（见第二节）。」（名额与唤醒语义已由 ③ 与本节前文覆盖）。
5. **第五节新增去重提醒**：派活前除了查「谁空闲」，还要对一眼上一步派过什么 —— 同一个活不要重复派两遍。
6. **第九节任务板降级**：建板条件收紧为「≥2 路**且**可能要跨重启接着做（或新建了成员要长期跟踪）」；只是这一轮并行跑完就结束的 → **不建板**，别为了走流程建一堆空条目。
7. **第十一节第 2 句改为显式免派清单**：动手类操作之前必须先派活；读文件 `read` / 查路径 `glob` / 搜内容 `grep` / 要答案的提问 `ask_user_question` / 加载技能 `skill` / 团队工具 `send_message`·`list_agents`·`team_task_*` / 上下文管理 `compress` 等不受此限（直接做）。
8. **第十一节新增 `wait_agent` 约束**：`wait_agent` 只能在已经派出去之后用 —— 不许先 wait 再派，也不许派 1 路就 wait。
9. **第十一节末尾新增小任务豁免与兜底**：真·小任务（todo 只有 1~2 条、且都不含【并行】）同样免派；反过来 —— 不写 todo 就等于按基础门槛 `@@MINDISP@@` 路算，别指望不列清单就蒙过去。
10. **`EXEMPT_TOOLS` 补三个纯只读工具**：`read` / `glob` / `grep`（读文件、列文件、搜内容，不写盘不跑命令 —— 拦它们只会白烧轮次）。
11. **本插件 `cordis.patch.yml` 默认 `gateMaxParallel` 10 → 6**：只改插件自带那份，作为独立 bundle 安装时的默认值；**母包 `dsh-loyalchiiina-suite\cordis.patch.yml` 仍为 10，本机实注（10 路）不受影响**。

> 说明：注入文本 `@@MINDISP@@` 因第 9 条新增一处引用，出现次数由 1 变 2（仍是同一种占位符，`buildLawText` 的 split/join 全局替换逻辑不变）。

### 追加（同版本规则修订 v3）：花名册留痕（只记账、不拦）

实测证据（被监控会话）：23:00–00:03 段它**真在用**员工 —— `employee-1/2/6` 各被 `send_message` 5 次、`employee-3/4` 各 3 次，表扬 `employee-13` 时还引用了它上一轮说过的话（说明在复用上下文）；**09:36 之后彻底改道**：21 次派活里 **20 次 `subagent`**（全部未填 `agent_preset`）、只有 1 次 `send_message`；而 `list_agents` 一共 16 次调用、**最后一次在 00:00:31，09:36 之后 0 次**。
→ 结论：**它不是不愿复用，是根本没查花名册**。而原硬门只数派活次数、不看通道，所以「先查花名册」这条建议零强制力。

本轮两处改动：

1. **注入第五节开头新增**（放在「本对话有自己的成员池…」之前）：**开工第一步就查花名册** —— 动手前先 `list_agents`（跟 `todo_write` 并列，都是每轮的固定开场动作），**不查就派活 = 违规**。
2. **注入第十一节末尾新增**：派活前没查过花名册的，会往 `gateLog` 记一条 `roster-not-checked`（不拦，只留痕）—— 连续出现，说明你在凭印象派活。
3. **闸门侧新增 `noteRosterTool(exec, toolName)` 记账函数**：`list_agents` 与 `subagent` / `subagent_fork` / `spawn_teammate` 全在 `EXEMPT_TOOLS` 里、走不到闸门判定体，所以该函数**在 `isExempt` 之前调用**（仍是监听器入口最前面，`toolName` 取到就记）。规则：本轮查到 `list_agents` → `rosterCheckedThisTurn = true`；派活工具被调用且本轮未查 → `rosterHintHits++` 并 `gateLog.push({ tool, domains, turn, dispatched, required, kind: 「roster-not-checked」 })`（沿用 10 条上限）。turn 变化（`sessionDomains.turn` 变化，或新用户消息 `agent/inbox/claimed`）时 `rosterCheckedThisTurn` 重置为 false。
4. **`/status.parallelGate` 新增两个观测字段**：`rosterCheckedThisTurn`（本轮是否查过）与 `rosterHintHits`（累计「未查即派」命中数）。

> **本改动只留痕、不拦**：四档判定（`requiredDispatches` 计算链）、主放行行 `if (requiredDispatches === 0 || dispatchedCount >= requiredDispatches) return next();`、`buildDenyReason` 调用与 `strike` 计数**一字未动**；`noteRosterTool` 本身 `try/catch` 全包，留痕失败也不影响放行。

### 追加（同版本规则修订 v4）：派活先报批 + 子代理不可寻址（只留痕、不拦）

用户原话：「此外他创建子代理的时候从来不经过我批准，直接就甩出去了，也不问我是不是要这么做」—— 这与 11-09 就提过的「安排任务前执行前需要审批，除非开启无人值守模式」是同一件事，此前一直没落到插件里。同批补上「子代理不可寻址」这条有实测支撑的事实。

实测证据（同一会话）：`send_message` 发给 `employee-1 … employee-13` 共 **27 次全部成功**；发给子代理 UUID 共 **5 次全部** `active teammate "…" not found`。

本轮五处改动（3 处注入词 + 1 处代码 + 1 处观测字段）：

1. **注入第五节新增（子代理不可寻址）**：`send_message` 的 `target` 只能填 `list_agents` 返回的名字；子代理（`subagent`）的会话 ID 不可寻址，发给它一定报 `not found` —— 想让它继续干，只能在它还在跑的时候发，跑完就再也叫不动。
2. **注入第五节新增 ⑤（派活先报批）**：一次要派 ≥2 路、或要新建常驻成员时，先用 `ask_user_question` **一次性**问清「这批派几路、分别给谁、你同意吗」，拿到同意再发 —— 不许逐个问，更不许不问就甩出去。三种情形不用问：用户说过「直接干 / 无人值守 / 别问」；只派 1 路且纯只读；复用已同意过的同一批成员继续干同一批活。
3. **注入第二节末尾补呼应句**（lead 原话写「第四节」，实际「交给谁」是第二节）：生米煮成熟饭最忌讳：派出去就撤不回来（子代理尤其 —— 它跑着时你也叫不动）。
4. **注入第十一节末尾补**：派活前没问过审批的，`gateLog` 会记一条 `approval-missing`（不拦，只留痕）—— 连续出现说明你在自作主张，该停下来问一句了。
5. **闸门侧 `noteRosterTool(exec, toolName)` 内同批记账**（**不重复遍历事件流**）：`ask_user_question` → `approvalAskedThisTurn = true`；派活工具（`TEAM_TOOLS`）且本轮没问过、且「已派过 ≥1 路 **或** 本工具是 `spawn_teammate`」→ `approvalMissingHits++` 并 `gateLog.push({ …, kind: "approval-missing" })`（第 1 路静默通过，避免小任务刷屏）。turn 变化（新用户消息同一处重置）与 `rosterCheckedThisTurn` 一起重置。`/status.parallelGate` 新增 `approvalAskedThisTurn` 与 `approvalMissingHits` 两个观测字段。

> **本改动只留痕、不拦**：绝不 deny、绝不动 `requiredDispatches`、四档判定链与主放行行**一字未改**（与备份逐字 `IDENTICAL`）。另修一处实现细节：`gateLog` 裁剪从「函数末尾统一剪一次」改为**每处 `push` 之后就剪** —— 因为该函数被 `try/catch` 全包，两段之间任何异常都会被吞掉、末尾裁剪就跑不到（旧写法导致 roster 自测用例 5 出现 `len=18`）。

### 口径（实测，非推算）

- 模板本体：**3709 UTF-16 字符 / 3709 码点 / 8862 UTF-8 字节 / 65 行**（v4 前为 3305 / 7924 / 61 行；v3 前为 3153 / 7606 / 59 行）；占位符 `@@ROUTES@@`×1、`@@MAXPAR@@`×2、`@@MINDISP@@`×2（3 种 / 5 处），**无其它 `@@`**。
- 运行时注入长度（本机 8 条预设路由）：**3848**（`gateMaxParallel: 10`）/ **3846**（`: 6`）；推导：`3709 − 10 + 185 + 2×(2−10) + 2×(1−11) = 3848`（`: 6` 时两处 `@@MAXPAR@@` 各换 1 位数，`2×(2−10)` → `2×(1−10)` → 3846）。注：本机 `routeLine` 实测 **185**（按 `buildLawText` 真实渲染输出逐字符数得，8 条 `presetRoutes` 用全角「｜」连接）；本条曾把 `routeLine` 误记为 183、把 `@@MINDISP@@` 占位符误记为 10 字符（实际 **11** 字符），**两个错 +2 / −2 恰好抵消**，3,848 因此侥幸正确 —— 结果对不等于推导对，这里按实测值订正。
- 硬门四档判定代码（`requiredDispatches` 计算链、主放行行、`buildDenyReason` 调用）**逐字未改**。

### 测试

- `node --check` 通过；`gate-maxparallel` 16/16、`gate-b` **28/28**（原 21 + 本轮新增 7 例：22 同一步 2 路放行 / 23 上一步派 1 路、本步动手 → 计数归零 → 拒 / 24 分步凑数 1+1 仍拒 / 25 同一步内补满 3 路放行 / 26 无 `step/start` 靠 `data.step` 分窗 / 27 step 边界不清空 todo 契约 / 28 无 step 信号 → 整轮累加兼容）、`singlestep-first` 7/7（合计 **51/51**）；既有 21 条断言零改动（它们的事件不带 step，走整轮累加兜底）。
- v3 追加：新增功能自测 `_test-roster-hint.mjs`（从真实文件切出 `noteRosterTool` 函数体，21 条断言全过）：未查即派 → `gateLog` 出现 `roster-not-checked`、`rosterHintHits` 0→1、且**无 deny 返回值**；先 `list_agents` 再派 → 不记 hint；turn 变化 → `rosterCheckedThisTurn` 回到 false；非派活工具不记 hint；`gateLog` 仍截到 10 条；`dispatchCounts` 缺失时 `required` 回落 `lastGateDecision.required`（不瞎猜）。
- 仅两处**字面量期望**随正文改动同步（逻辑未削弱）：① `gate-maxparallel` 用例 07 把「封顶 N」改为「当前上限 N 路」，期望数组 `[1,1,1,0,2,0,-1]` → `[2,2,2,0,2,0,-1]`（新文案在第三、第十二节各出现一次）；② `gate-b` 用例 17 的 `law.includes("十一、并行声明即契约")` → `law.includes("十、预设路由")`（重排后预设路由为第十节）。
- v4 追加：新增功能自测 `_test-approval-hint.mjs`（从真实文件切出 `noteRosterTool` 函数体，**29/29** 全过）：第 1 路派活未审批 → 不记；第 2 路 → 记 1 条 `kind="approval-missing"` 且 `approvalMissingHits=1`、`dispatched/required` 正确；先 `ask_user_question` 再派（含 `spawn_teammate`）→ 不记；`spawn_teammate` 首路未审批 → 记；turn 变化 → `approvalAskedThisTurn` 回 false 并从「第 1 路不记」重新开始；`enforceTeamGate: false` 时同样留痕且仍 `return next()`；非派活工具（`pwsh`/`todo_write`/`read`）不记；连 15 次 → 计数 15 且 `gateLog` 截到 10 条；花名册与审批两段互不干扰。既有 `_test-roster-hint.mjs` 21/21、`_test-roster-gateoff.mjs` 20/20 仍全绿（**两个 harness 未改**）。


## 1.2.0 — 2026-11-09

### 新增：三档中控台（lean / balanced / turbo）

- **设置页一键切档**：`lean`（省 Token）/ `balanced`（中规中矩）/ `turbo`（超级高效）三档，档位写入 `<DSH_HOME>/team-orchestrator.local.json` 的 `tier` 字段，**点按钮即生效、不需要重启** —— 闸门参数（`gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `enforceTeamGate`）立刻改变，注入文本在下一轮重建时取到新值。
- **切档不覆盖用户配置**：只新增/覆盖 `tier` 一个键，`presetRoutes` / `domainKeywords` / `profileName` 原样保留；写盘走「临时文件 + rename」原子替换，写失败不改动原文件。
- **未切档时即 custom 态**：`tier` 缺失或非法 → 完全按 `cordis.patch.yml` 的 config 走，行为与 1.1.x 等价（`tiers.active = "custom"`、`tiers.source = "config"`）。

### 新增路由

- `GET /dsh-team-orchestrator/tiers` —— 三档中控台的全量数据源：当前档、三档参数、宿主限额、并发预算、最近拦截记录。
- `POST /dsh-team-orchestrator/tier` —— 切档（body `{"tier":"lean|balanced|turbo"}`），非法值返回 400 并回带可用档名。
- 三个路由（含原有 `/status`）共用同一个 `ctx.effect` 与一次性 disposer，卸载插件时全部注销。

### 注入文本改为函数形式（每轮重取）

- `ctx.systemPrompt.section({ text })` 由**常量字符串**改为**函数**（`text: function () { return ACTIVE_LAW_TEXT; }`）：切档后下一次取段即拿到新文本，无需重启、无需重载插件。
- 注入文本内所有数字改从生效值快照取，模板保留 4 个占位符：`@@MINDISP@@`（本档至少派几路）、`@@ECON_LOW_CALLS@@`（经济阈值·工具调用上限）、`@@ECON_LOW_C@@`（千分位带逗号形态）、`@@ECON_HIGH@@`（高 token 阈值）。三档经济阈值分别为 800 / 6 / 6000、2000 / 15 / 10000、4000 / 25 / 20000。

### 修复：闸门注册不再受 `enforceTeamGate` 控制

- 1.1.2 的问题：`enforceTeamGate: false` 时**整块监听器都不注册**，而注入文本仍写着「硬门会拦」—— prompt 与实际行为不一致；且切档把开关从 `true` 改成 `false` 之后，改回来也不会重新注册。
- 1.2.0：监听器**无条件注册**，开关判断挪进监听器内部（`if (ACTIVE_TIER && ACTIVE_TIER.enforceTeamGate === false) return next();`）。于是切档可以**立即**开关闸门，「关掉再打开」也不再需要重启。

### `/status` 扩容

- 新增 `tiers` 段：`active` / `source` / `values`（六项生效值）/ `available` / `lastGateDecision` / `noTodoFallbackHits`。
- 新增 `budget` 段：并发预算（在跑的 subagent 数、上限、按档位建议的路数）。
- 新增宿主限额：`maxMembers` / `maxActiveSubagents` / `maxDepth`（**只读展示**，插件不写宿主配置）。

### 并行标记白名单（沿用 1.1.3）

- 1.1.3 已把并行契约判定从裸子串 `indexOf("并行")` 改为显式标记白名单（【并行】/【并行×N】等 5 种形态），本版不改该逻辑，只把它的两个经济阈值数字接入三档体系。

### 文档/口径

- 注入文本长度随档位变化（模板本体 + `gateMaxParallel` 的位数差异）：`/status` 的 `section.textLength` 必须等于同档 `buildLawText()` 的返回值，且全文不得残留 `@@`。
- 本版新增 `lib/client.js`（客户端档位面板）；`dsh.client` 只声明 `platform: "web"`，配合 `exports["./client"]` 指向 `./lib/client.js` —— 与生态内其余客户端插件形态一致（不写 `entry` 键）。

### 追加（同版本文档/规则修订 · 注入铁律二次修订）

- **新增〇节「动手前先预分类」**（插在首段之后、第一节之前）：收到任务先按**可逆性**分两组（不可逆·无需对话·做完就安心 → 可 subagent 或自己做、可安心并行；可能需维护/交流/返工 → 留主线或 teammate、能中途刹车），分完再写 todo（第一类挂「可并行」、第二类归「需对接」）；大任务先判可否拆独立子任务（独立互不沟通 → 并行 subagent 批量；需互相沟通/对接 → 派多个 teammate），并给名额取舍（任务量小一次一个 → 用 teammate；一下量很大 → 优先不占名额的 subagent，别堆满 teammate 名额）；再补「与 dsh-todo-float-ball 调和」：预分类在心中完成、不占工具调用，每轮第一动作仍是 `todo_write`，第一次写出的就是按可逆性分好类的清单；且该调和在**无 dsh-todo-float-ball** 的环境同样成立，由本插件的注入纪律兜底。
- **三 派活通道**开头新增「通道二轴判定」：**先判会不会要改口、再判要不要并行**，两条轴独立。可并行轴决定派几路（互相独立 + 结果能合并 → 声明 N 路一次派满，见第二节）；可变向轴决定走哪个通道（频繁交互 / 信息易变 / 可能中途刹车/变向/返工 → 必须 `spawn_teammate` 常驻成员、能 send_message 引导 / interrupt 停下，**绝不 subagent**；只读查询 / 结果稳定 / 做完就返回 → `subagent` 不占名额最合适；独立但易变 → 并行的是多个团队成员而非多个 subagent）。一句话：**力度看并行，通道看可逆性**。
- **新增第十二节「派活命名约束」**：每次派活 / 开 subagent / 建成员，名称带**序号前缀**（`01_`、`02_`…按本 turn 派出顺序）+ 名称/描述里**明确类型**（常驻成员 `teammate`、一次性子代理 `subagent`），如 `03_fluent-solver_teammate`；spawn_teammate 只接受 lower-kebab-case 时把下划线换连字符、序号与类型后缀都保留；汇报必须用带序号的名字点名。
- **注入长度（最新）**：经「终极收口」补 A1/A2 两条后，模板本体 **88 行 / 6469 字符**；运行时（本机 8 条预设路由 + `gateMaxParallel: 10`）`section.textLength` **6562**；`gateMaxParallel: 6` 时 **6560**。占位符仍 9 处、全文无 `@@` 残留。
- **worker-pool 协作纪律（范式反转，注入第四轮）**：第八节「每轮先看花名册」重写为「**worker-pool：主力是可通信 teammate，subagent 只做溢出**」——成员**不给狭窄人格 / 锁领域**、一律**通用干活身份**（名字只作区分，后经第五轮统一为 `01号员工` 格式）谁空闲谁接；**实时队列**：有任务即时扫空闲成员派发、干一个发一个、不等活；**自适应扩容**：第一轮抢不过来 → 未达 maxMembers 上限就新增 teammate 扩池，**快满员且都忙**才退化 subagent（一次性/重跑便宜/只读）；**重启可续**（teammate 可 send_message 唤醒继续）；**守恒**：maxMembers 累计不回收、规划角色别无限扩，满了只能 subagent。正文新增第十三节「**跨会话协作**」（续接 A / 进度文件 B / 成员池 C / 重启时机 D / 任务板判据 E，C 按通用身份+自适应扩容写）。段落数 75→86、模板本体 5052→6012（+960 UTF-16）、运行时 textLength 5145/5143→**6105/6103**。
- **员工命名（注入第五轮）**：第八节与第十二节把**主力池常驻成员**命名统一为 `01号员工` / `02号员工` / `03号员工`…（序号 + 「号员工」，只作区分、不锁领域）；一次性子代理保持**序号 + 类型**格式（`05_doc-query_subagent`），两边严格区分、不混；spawn_teammate 技术名限 lower-kebab-case 时另给 `01-employee` 并在描述/进度文件映射「01号员工」。模板 6012→6078（+66）、textLength 6105/6103→**6171/6169**。
- **单步豁免表述收紧（发版前）**：第七节 L388 原文「才允许只派 1 路（…硬门按 2 路要求）」→ 实际实现是**单步标记 → `required 0` 免派**，且代码不侦测「实际拆多块」按 2 路拦，属未实现承诺。改为准确稿：「单步任务：todo_write 第一条里显式写 `【不可拆·单步】` 即免派 0 路（不要再派代理，也不要闷头拆多块）；没写该标记的单步任务仍按当轮要求路数派活。」
- **措辞统一**：〇节「与 todo 悬浮球调和」改为「与 dsh-todo-float-ball 调和」，正文内「悬浮球」字样全部替换为插件名 `dsh-todo-float-ball`，并在调和句末尾追加无插件环境兜底句（本规则在无该插件的环境同样成立，每轮仍先 `todo_write`、带进度，由本插件注入纪律兜底，不依赖任何显示插件）。上述长度已含该兜底句（再 +113 UTF-16）。
- 不 bump 版本：仍 `1.2.0`，属同版本文档/规则修正（无新代码逻辑改动，`countParallelTodos` / `hasSingleStepMark` / 硬门判定块逐字未动）。

### 已知限制

- `maxMembers` / `maxDepth` **只能显示不能改**：它们属于宿主 agent-team 配置（profile patch），插件改写会被设置页反向覆盖，故按只读处理。
- 切档后**上游 prompt cache 会失效一次**（注入段文本变化 → 缓存前缀不再命中），下一轮自动恢复。
- 客户端面板不做轮询，切档结果以面板回读的 `tiers.active` 为准。

### 测试

- 既有 44 个行为用例（判定段守门人）在改动后**断言零调整**全部通过；另做 20 项改动命中校验（A1–A20 全过）。

### 版本号

`package.json` `version` `1.1.3` → `1.2.0`。

## 1.1.3 — 2026-11-09

### 修复：并行标记裸子串误判（用户拍板「先修误判再发」）

- **根因**：`countParallelTodos` 唯一判定行是 `content.indexOf("并行") >= 0` —— 裸子串包含即算并行契约。中文没有词边界，任何含「并行」二字的叙述都被计入，导致 2 条真并行被算成 3 条，硬门多要求 1 路。
- **误判样例（旧规则实测 count=1，应为 0）**：
  - 「并行门真机行为测试（硬门不可绕过、并行预算核对）」
  - 「汇报结论：本任务不可并行，串行即可」（否定句）
  - 「修复【不可拆·单步】与并行门的优先级冲突」
  - 「调整并行预算 gateMaxParallel 默认值 6→8」
- **漏判方向**（同一规则的反面）：`同时派 3 路` / `并发执行 4 个` / `fan out 3 subagents in parallel` / `一次派满 6 路` 全部计 0 —— 讽刺的是注入第二节自己教的措辞「一次派满 N 路」，实现侧一个字都认不出。
- **修法**：改为固定标记白名单 + 路数加权。只认 5 种显式标记 `【并行】` / `[并行]` / `「并行」` / `（并行）` / `(并行)`；前两种支持声明路数 `【并行×3】` / `【并行3路】`，按声明路数计入（`count = 各条声明路数之和`），无路数默认 1。新增常量 `PARALLEL_MARK_RE`，`countParallelTodos` 整段重写（只此一段 + 两个测试 helper 改动，闸门主流程与上限逻辑零改动）。
- **教读对齐（同批）**：注入文本第十一节正文改写为「要并行的条目必须用显式标记…正文里的「并行门 / 并行预算 / 不可并行 / 并行契约」等描述性文字不算并行契约」（标记形态此前全仓库 0 处定义，与单步豁免用的 `【不可拆·单步】` 风格统一）；拒绝文案「标了 N 条「并行」」→「声明了 N 路并行（【并行】/【并行×N】标记合计）」，保留 `【并行契约违约】` 前缀。
- **测试夹具同步**：`test/gate-b.test.mjs` 与 `test/gate-maxparallel.test.mjs` 的 `parallel()` helper 由 `"块N 并行处理"` 改为 `"【并行】块N"`；`test/gate-b.test.mjs` 第 12 例的内联文本同改。旧夹具靠裸子串命中，新规则会漏，故必须同步（否则 19 个断言假红）。

### 文档/口径

- 注入文本模板本体 3,339 字符；运行时 `textLength` 随 `gateMaxParallel` 变化：上限 6 → 3,496，上限 16 → 3,500（按本机 8 条 presetRoutes 实测）。本机配 `gateMaxParallel: 10` → 期望 `/status` 的 `section.textLength = 3498`。

### 测试

- `node test/gate-b.test.mjs` 21/21、`node test/gate-maxparallel.test.mjs` 16/16、`node test/singlestep-first.test.mjs` 7/7（合计 44/44），断言零调整。

### 版本号

`package.json` `version` `1.1.2` → `1.1.3`。

## 1.1.2 — 2026-11-09

### 新增 / 变更

- **并行契约路数上限可配（`gateMaxParallel`）**：默认 6，合法区间 2~16；非法值回落 6 并记一条 `config-fallback`。本机配置设为 10。此前上限是写死的 6。
- **注入文本动态反映该值**：模板中改为 `@@MAXPAR@@` 占位符，运行时按 `gateMaxParallel` 替换；同时纠正旧文案「含你自己」→「不含 lead 自己 —— 只数 `subagent` / `subagent_fork` / `spawn_teammate` 调用次数」。
- **团队成员上限 `maxMembers` 从 8 调高到 16**（= 官方 `DEFAULT_MAX_MEMBERS`），并在 profile patch 追加「按 id 覆盖」条目 —— asar 内的 `config` 是整体替换而非深合并，故四个键必须写全。
- **`/status` 的 `parallelGate` 新增 `maxParallel` 字段**，用于核对运行时实际生效的上限。

### 文档修正

- 注入字符数口径统一：模板本体 3204 字符；运行时随 `gateMaxParallel` 为 3361（上限 6）~3363（上限 10），本机配 10 故实际注入 3363（按 `LAW_TEXT_TEMPLATE` + 本机 8 条路由实测，与 `/status` 的 `section.textLength` 同值）。
- `docs` 口径对齐 1.1.2：两处「七条」→「11 节」（与注入原文一致）、并行上限改为 `Math.min(并行条数, gateMaxParallel)` 并写明「不含 lead 自己」、`maxMembers` 三处由「本机 8」更正为 16。
- `README` 新增「前提与降级行为」节：四档判定的四层依赖、静默降级对照表、30 秒自查字段，以及与 `dsh-todo-float-ball`（只读镜像）的三类预期不一致与判断口径；同步 1.1.2 口径 —— 注入字符数 3204 / 3363、「并行路数上限」改为「可配 `gateMaxParallel`」、开关表与 `/status` 表补 `gateMaxParallel` / `maxParallel`、`maxMembers` 更正为 16。

### 测试

- 本版**未随包提供自动化测试文件**：`gateMaxParallel` 的默认值、边界 2 / 16、越界与非法值回落，靠 `/status` 的 `parallelGate.maxParallel` 与 `gateLog` 里的 `kind: "config-fallback"` 人工核对。

### 版本号

`package.json` `version` `1.1.1` → `1.1.2`。

### 文档修正（发版后补）

- 修正 `package.json` 描述里写死的「封顶 6」→ 改为「封顶路数可配 2~16」
- 修正 `docs/local-config.md` 优先级说明：拆成「可被 `local.json` 覆盖的 3 个字段」与「只能从 patch config 读的 7 个键」，并明确写进 `local.json` 不生效
- 补充 `README.md`：`gateMaxStrikes: 0` = 永不拦截（非常规取值）
- 补充 `README.md`：两种安装方式（经聚合包挂载 / 直接安装）读取的 `cordis.patch.yml` 不是同一份
- 测试文件现已随仓库提供：`test/gate-maxparallel.test.mjs`（16 用例）、`test/gate-b.test.mjs`（21 用例）、`test/singlestep-first.test.mjs`（7 用例）。三者**只进 git、不进 npm 包**（`files` 白名单不含 `test/`），故上面「本版未随包提供自动化测试文件」仍然成立；`npm test` 跑 `gate-maxparallel`。

---

## 1.1.1 — 2026-11-09

### 改判（用户拍板选 B：并行门改为三档判定）

用户两条诉求原文：
- ① 该并行却串行（标了「并行」却只派 1 路）
- ② 小任务也硬开子代理（查一行配置也开一个）

1.1.0 的固定门槛（默认 2 路、单步标记才降到 1 路）只治 ① 的一半 —— 基础值仍是 1 路起步、连「查一行配置」都要先派活，② 没解决。本版改为按 todo 内容自适应：

```js
// 优先级从高到低：
// 1) 单步标记命中           → required = 0（明确声明不拆，自己干）
// 2) parallelTodos >= 2     → required = Math.min(parallelTodos, 6)
// 3) todoCount 1~2 且 parallelTodos <= 1 → required = 0（真·小任务，不拦）
// 4) todoCount === 0（从未写 todo）      → required = minDispatches（= 1，不许「不写就绕过」）
// 5) 其余（todoCount >= 3 但没标并行）    → required = minDispatches（= 1）
```

含义：小任务放你自由；中等任务至少走一次团队流程；**标了并行就是契约，必须一次派满**。

### 修复

- **「不写 todo 就绕过硬门」的缺口（三档 → 四档）**：初版三档把「`todoTotal <= 2`」一律当小任务放行，而闸门输入完全来自模型自己写的 todo —— 只要不调 `todo_write`（或只写 ≤2 条），硬门就永久失效，① 号诉求（该并行却串行）等于换个口子重新打开。现收紧为 **`todoTotal >= 1 && todoTotal <= 2`** 才算小任务；`todoTotal === 0`（从未声明待办）回落基础门槛 `minDispatches`（默认 1 路），并标记 `lastGateKind = "no-todo-fallback"`、累计 `noTodoFallbackHits`。注入文本第十一条同步补一句「没写 todo ≠ 小任务：动手前必须先把本轮待办写进 todo_write」。
- **`gateMinDispatches` 默认值 2 → 1**：基础门槛只是「走一次团队流程」；标了「并行」的 todo 会把它抬到并行条数（上限 6）。设 `0` 即全关。设 `2` 只对**中等及以上任务**（`todoTotal >= 3`）退回 1.1.0 的「必须两路」；真·小任务（`todoTotal <= 2`）与单步标注按优先级 1/3 仍然豁免，不受此旋钮影响。
- **新增 `countParallelTodos(todoArgs)`**：统计 `todos[].content` 含「并行」的**未完成**条目数，`status === "completed"` 不计入；解析失败 / 无 `todos` / 非数组一律返回 `{ count: 0, total: 0 }`，绝不抛。
- **`lastTodoArgs`**：闸门扫事件时缓存本轮最后一次 `todo_write` 的原始参数（`todo_write` 是豁免工具、不经过闸门判定，只能这样取样）；`turn/start` 时清 `null`，不沿用上一轮契约。
- **拒绝文案分场景**：`required >= 2` 且派活不足时新增【并行契约违约】段，点名「todo 里标了 N 条「并行」，本 turn 只真派活 M 路」；`required === 0` 时不拦、不记 strike。步骤 ③ 同步改写为「真·小任务与单步任务都不要求派活」。

### 注入文本

- 新增第十一条「并行声明即契约（1.1.1）」：标了「并行」必须同一条消息内一次派满，标 3 路只派 1 路＝违约；没标「并行」的小改动（≤15 次工具调用或产出 <2,000 token）不要开子代理；同一功能模块的连续小修复用同一个常驻成员（新 subagent 每次重付约 28,300 token 固定前缀）。

### 新增排查字段

`/dsh-team-orchestrator/status` 的 `parallelGate` 增加 `lastRequired` / `lastParallelTodos` / `lastTodoTotal` / `lastGateKind` / `lastTodoArgsSeen`，各会话条目增加 `parallelTodos` / `todoTotal` / `kind`。

### 版本号

`package.json` `version` `1.0.1` → `1.1.1`（1.1.0 发布时因放行范围只含代码与 CHANGELOG，版本号未同步，本版一并补齐）。

---

## 1.1.0 — 2026-11-09

### 修复（用户批准的 P0/P1 方案）

- **D1 硬门布尔 → 计数**：旧布尔判定（派 1 路 = 派 3 路）改为 `dispatchedCount` + `requiredDispatches`；默认过门要求 2 路真派活，`gateMinDispatches` 可配（设 1 即退回旧行为）。
- **D1 单步豁免**：`todo_write` 第一条写 `【不可拆·单步】` 才允许只派 1 路；未写标记按 2 路要求。闸门只读 `todos[0].content`——其余位置出现该标记一律不豁免（解析失败 / 无 `todos` / 空数组同样不豁免），防止「任意一条无关待办塞标记」绕过并行门。
- **D3/D4/D5 注入文本**：删「spawn 要克制」→「克制的是新建成员数，不是并行路数」；「拆任务→派活→收结果→合并验收」→「拆任务→一次派满 N 路→统一收结果→合并验收」；`maxMembers` 实测 8 与官方默认 16 均标注来源，冲突以实际报错为准。
- **D6 自报状态造假**：`orchestratorMounted` 由 `bundles.indexOf(...)`（恒 false）改为「apply 已执行 = 已挂载」，并新增 `orchestratorMountedVia` 给出证据链（`profile.bundles` / 具体 `cordis.patch.yml` 绝对路径 / `patch-insert(未定位)`）。
- **D7 `wait_agent` 空转**：移出 `EXEMPT_TOOLS`，改由 `waitAgentGate` 判定；默认 `warn`（放行 + 记账），可切 `enforce`。
- **P1-4 经济阈值**：注入文本新增第十节（每个新 subagent 固定前缀 ≈ 28,300 token，平均产出 6,012 token → 三类阈值）。

### 新增配置

`gateMinDispatches`（默认 `2`）、`waitAgentGate`（默认 `"warn"`）。

### 新增排查字段

`/dsh-team-orchestrator/status` 增加 `parallelGate`（生效阈值 + 各会话已派路数）；`gateLog` 每条增加 `dispatched` / `required` / `kind`（`gate-deny` 或 `wait-before-full-dispatch`）。

### 更正

- 0.2.0 段「`gateMaxStrikes`（默认 `1`）」与代码实际默认值 `4` 不一致，以代码为准：**默认 4**。
- 本版 `package.json` 的 `version` 仍为 `1.0.1` —— 本次放行范围只含 `lib/index.js` 与 `CHANGELOG.md`，版本号需用户批准后单独同步为 `1.1.0`。
  - 上述欠账已在 **1.1.1** 结清：`version` 直接同步为 `1.1.1`（不另出 `1.1.0` 号），代码与 CHANGELOG 的语义版本以 1.1.1 为准。

---

## 1.0.1 — 2026-11-09

### 插件市场元数据：新增 locale 显示名与描述

- 新增 `locale/en.json`、`locale/zh.json`：插件列表 / 市场的显示名（Agent Team Orchestration / 智能体团队编排）与一句话功能描述。
- `package.json`：`exports` 增加 `./locale/*.json`；`files` 白名单增加 `locale/*.json`（缺这行 npm 包里就没有 locale 文件）。
- 运行代码（`lib/*.js`）无改动，行为与 1.0.0 完全一致。

## 1.0.0 — 2026-11-08

### 包名改为 `dsh-agent-team-auto-orchestrator`（npm 与 GitHub 统一）

npm 包名与 GitHub 仓库名统一为 **`dsh-agent-team-auto-orchestrator`**。本地目录名保持不动（仍是原目录名）。

同步改动 6 处改名点（少一处就出事）：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert.id` 与 `insert.name`、`lib/index.js` 的 `export var name`（**必须与 `package.json` 完全一致，否则插件静默不上线**）、`lib/index.js` 的 `orchestratorMounted` 判定（否则 `/status` 永远报 `false`）、`LAW_TEXT` 首行（模型每轮可见，必须对）。

**保留不动**：`ROUTE_PREFIX = "/dsh-team-orchestrator"`（本机回环调试通道，改了要连带 3 处文档且需重验 HMR）、`cordis.patch.yml` 里的状态路由注释、`README.md` 里的状态路由 URL。

### 修订 4 处业务画像残留

| 位置 | 修订 |
|---|---|
| `lib/index.js` · 硬门拒绝文案（preset 域） | 去掉预设名枚举，改为指向 `team-orchestrator.local.json` 的 `presetRoutes`；同时修掉「写 8 实际列 7」的错数 |
| `lib/index.js` · `DOMAIN_RULES` 上方注释 | 去掉业务词举例，改为「用户业务专属词不写在这里（会暴露使用者的行业/内容画像）」 |
| `docs/team-orchestration-methodology.md` | 域关键词举例改为「你所在行业 / 项目的专有名词」，不再举例 |
| `CHANGELOG.md`（0.3.2 段） | 业务词举例改为「行业/项目专有名词…」 |

### 元数据补齐

新增 `repository` / `homepage` / `bugs` 三个字段（指向 GitHub 仓库），使 npm 页面与仓库侧信息一致。

### 首发 1.0.0

0.3.x 系列已在实战中稳定（常驻注入 + 工具层硬门 + 状态路由 + 本机配置外置层），至此定为 1.0.0 首发版本。

---

## 0.3.4 — 2026-11-08

### 纠正 `maxMembers` 的真实值：**本机 8，不是 16**

v0.3.2 / v0.3.3 的 `LAW_TEXT` 写「`maxMembers=16`」——**错了**。查证链：

1. `desktop` profile 层（`app.asar` 内 yml）把 `@deepseek-ai/dsh-experimental-agent-team` 的 `config.maxMembers` 覆盖为 **8**
2. 本会话实测：第 9 个 `spawn_teammate` 报 **`Team member limit 8 reached`**
3. 官方文档默认表确为 `maxMembers | 16` —— 但那是**默认值**，本机被 profile 层覆盖

`LAW_TEXT` 已改为：

> `maxMembers` = **累计创建数**、含失败；**本机实测 8**，官方文档默认 16 —— 以实际报错 `Team member limit N reached` 为准

同步修正 6 处错写 16：`README.md`（2 处）、`CHANGELOG.md`（1 处）、`docs/team-orchestration-methodology.md`（3 处）。

### 顺带确认三条（写进文档，防再错）

- `maxActiveSubagents: 20`（`desktop/cordis.patch.yml` **L5220**）归 `@deepseek-ai/dsh-subagent`，是 **subagent 并发上限**，**不是团队成员名额**（同文件 `team` 零命中可作反证）
- 团队名额 = `@deepseek-ai/dsh-experimental-agent-team` 的 `config.maxMembers`，**由 `dsh.profile.bundles` 里的 `@deepseek-ai/dsh-experimental-agent-team-profile` 这个 bundle 注入**（本机注入值 **8**），不是靠 `cordis.patch.yml` 手写配置（该 `cordis.patch.yml` 里 `maxMembers` / `agent-team` 均 0 命中）
- **不存在 `maxActiveMembers` 这种键**；`maxMembers` 语义是「团队累计可创建成员数（含失败）」，**不是同时在岗数**

### 注入字符数变化

`LAW_TEXT` **1927 → 1990 字符**（本机 8 路由版）；公开版 **1818 → 1881**。增量只来自 `maxMembers` 那条的纠正说明，8 条规则标题未变。

### 铁证链（三段闭环，可复核）

| # | 证据 | 位置 |
|---|---|---|
| ① | bundle 注入：`@deepseek-ai/dsh-experimental-agent-team-profile` 的 `cordis.patch.yml` 写着 `maxMembers: 8` | `app.asar` → `node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml` 第 13–20 行；该 bundle 在 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里 |
| ② | 运行时用注入值：断言是 ````if (state.members.length >= this.maxMembers) throw new TeamError(`Team member limit ${this.maxMembers} reached`, "TEAM_MEMBER_LIMIT")````，`this.maxMembers` 来自 config 覆盖而非代码默认 | `app.asar` → `node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js` |
| ③ | 日志实测：`{"tool":"spawn_teammate","failureCode":"TEAM_MEMBER_LIMIT","error":{"message":"Team member limit 8 reached"}}` | `<DSH_HOME>\logs\desktop-next-2026-11-08.0.jsonl` **L3113** |

> 代码默认 `DEFAULT_MAX_MEMBERS = 16`、README 也写 16 —— 都只是**未注入 config 时的兜底**。本机 bundle 注入 8 ⇒ 生效 8。

### 教训

「官方文档默认值」≠「本机生效值」。本机有 profile 层覆盖时必须以**实测报错**为准，不能拿文档默认值当事实写进注入文本。

---

## 0.3.3 — 2026-11-08

### 修 HMR 重载导致 `/status` 路由重复注册（真故障，非优化）

**现象**（`desktop-next.log` L536/L547 实测）：

```
[error] Error: webserver: duplicate exact route "/dsh-team-orchestrator/status"
[warn]  Error: dsh: warning: 1 entry did not activate
[warn]  config reload at …cordis.patch.yml failed [host.kernel.hmr]
```

**根因**：`ctx.webServer.register(...)` 直接写在 `apply()` 里，**没包 `ctx.effect`**。
每次改 `cordis.patch.yml` 都会触发 HMR → `reconcileProfile → recompose` → 本插件重新 `apply()`
→ 旧路由没被卸载 → 重复注册同一 exact route 失败 → 该 entry 被标 `did not activate`。

**修复**：

- 整段包进 `ctx.effect(fn, "dsh-team-orchestrator: status route")`（与 `systemPrompt.section` 一致）
- 返回 disposer：依次尝试 `routeHandle.dispose()` / `routeHandle()` / `ctx.webServer.unregister(path)`
- 注册抛错（duplicate）时 **catch 并返回空 disposer** —— 旧路由仍在服务，绝不阻塞启动

### 修 `presetHint` 文案误报

`domains` 为空（只拦「动手类操作」）时，原来会错误输出「**本环境未配置 presetRoutes**」——
本机明明配了 8 条。改为：

- 域为空 → 「按任务实际领域派给对应预设，或 `spawn_teammate(name="...")` 自建成员」
- 命中域但该域无路由 → 才说「该域未配置 presetRoutes」

**生效方式**：宿主端改动 → **彻底退出 DSH 客户端再启动**（HMR 重载不能替代）。

---

## 0.3.2 — 2026-11-08

### 双轨架构：公开核心 + 本机覆盖层（发布包不再含任何本机信息）

**问题**：v0.3.1 的 `LAW_TEXT` 里写死 8 个预设 id、`DOMAIN_RULES` 里写死业务词
（行业/项目专有名词…），`readProfileBundles()` 写死 `"desktop"`。
一旦公开发布，等于把「使用者本地在做什么」直接贴出去。

**方案**：本机专属内容全部外置到 `<DSH_HOME>/team-orchestrator.local.json`
（**该文件在插件目录之外 → `npm pack` / `git push` 结构上打不进去**）。

| 项 | 变化 |
|---|---|
| `DEFAULT_PRESET_ROUTES` | 空数组（公开版拒绝理由只建议 `spawn_teammate`，**绝不吐占位符** `agent_preset="..."`，避免模型照抄撞 `INVALID_ARGS`） |
| `DOMAIN_RULES` | 只留跨环境通用词；业务词由 `local.json` 的 `domainKeywords` **追加到 weakStrong**（与 strong 判定等价，命中 1 个即入域） |
| `DEFAULT_PROFILE_NAME` | `"desktop"`（DSH 默认 profile 名，非隐私），可被 `local.json` 覆盖 |
| `loadLocalConfig()` | 新增：mtime 缓存 + 损坏/缺失全回退默认，任何异常不抛 |
| `refreshActiveConfig()` | 新增：重建生效值；`force=false` 时 mtime 未变直接跳过 |
| 热重载 | 每次 `tools/pre-execute` 前做一次廉价 mtime 检查 → **改 `local.json` 下次调用即生效**（注入文本因启动时求值，`presetRoutes` 想立刻反映仍需重启） |
| `/status` | 新增 `localConfig` 段：文件路径 / 是否加载 / mtime / 生效 mtime / 路由条数 / profile 名 |

**等价性验证（机器实测）**：把改造前的 72 个原词逐条与「默认 + local.json 合并后」的词表
做判定级别比对 → **72/72 同域同级别、0 新增词**，本机行为零变化。

### 成员复用：补三条规则（真实缺口）

v0.3.1 之前从未教模型「成员可以复用」，导致长会话里每轮都新 spawn，
很快撞 `maxMembers`（**累计创建数**含失败，inactive 不释放名额；**本机实测 8**，官方默认 16）。新增：

- 第三条第 5 条：`inactive` 成员不释放名额 → 新活先 `send_message` 唤醒复用，没有匹配成员才 spawn
- 第三条第 6 条：一次性杂活用 `subagent`（**不占成员名额**）
- 第四条第 3 条：`reassign` 的 owner 必须是持久成员（subagent id 会报 `TEAM_MEMBER_NOT_FOUND`）
- **新增第八条「每轮开始先看花名册」**：`list_agents` → 有匹配的 inactive 就复用；成员名字永久占用，spawn 要克制

### 脱敏（6 处）

`README.md` / `CHANGELOG.md` 里 6 处本机信息清除：Windows 用户名 + home 绝对路径 1 处、测试盘绝对路径 1 处、会话 id 2 处、技能库绝对路径 1 处、成员 id 1 处。
改后按「用户名 / home 路径 / 盘符绝对路径 / 会话 id」四类字面重新扫描，**全部零命中**（扫描口径见「发布前检查」小节，不含任何字面列举）。

### 文档

- 新增 `docs/local-config.md`（配置说明，含路径/优先级/热重载/容错/常见问题）
- 新增 `docs/local-config.example.json`（脱敏示例）
- `docs/team-orchestration-methodology.md` 增 §5.4 成员复用、§7 Step 7 本机配置层、§8.5 两条失败模式
- `package.json` 的 `files` 白名单补 `docs/`（否则方法论不进 npm 包）

### 修正

- `cordis.patch.yml` 头部注释原写「不拦截任何工具调用（硬门故意不做）」——与 `enforceTeamGate: true` 的实际行为**直接矛盾**，已改为双层机制说明
- 补一条：想关硬门请用 `enforceTeamGate: false`，**不要**用 `gateDomains: []`（代码判空会回退默认四域）

**生效方式**：`lib/index.js` / `package.json` / `cordis.patch.yml` 属宿主端 → **彻底退出 DSH 客户端再启动**；
`docs/*` 与 `README/CHANGELOG` 纯文档 → 不需要重启；`local.json` → 下次工具调用即生效。

---

## 0.3.1 — 2026-11-08

### 修 0.3.0 文案里 4 处给错指令的地方（只改 LAW_TEXT，不动代码逻辑）

0.3.0 上线后跑了 A/B 两轮实测（A 轮 / B 轮两次独立对话），硬门行为已验证正确，
但暴露 **LAW_TEXT 有 4 句在教模型做错事** —— 模型照着做必然踩坑：

| # | 现象（实测证据） | 0.3.0 的错文案 | 0.3.1 修正 |
|---|---|---|---|
| 1 | B 里 3 次 `claim` 传 `plugin-scout` / `recon` / subagent-id，返回 `ownerName` **一律是 `lead`** | 「建完必须立刻 `team_task_update claim`（**owner=实际执行成员**）」 | 「建完立刻 `claim` 认领（⚠️ **claim 的 owner 参数不生效**，ownerName 只落自己），再用 `reassign` 改成实际执行成员」 |
| 2 | B 里 `reassign` 到 subagent id 报 `active teammate "<成员 id>" not found`（`TEAM_MEMBER_NOT_FOUND`） | 完全没写 | 新增「⚠️ **subagent 不在成员花名册**（`list_agents` 看不到它），任务板无法把 owner 记到它名下：由 Lead 记名并注明『实际执行者=<子代理 description>』」 |
| 3 | B 里 `team_task_create` 传 `write_scopes: ["<工作区相对路径>\\T1-plugins.md"]` → `TEAM_INVALID_WRITE_SCOPE`，任务没建成 | 完全没写 | 第四条补「⚠️ `write_scopes` 只接受工作区相对路径，传绝对路径会报 `TEAM_INVALID_WRITE_SCOPE`（可留空）」 |
| 4 | B 里 `subagent(agent_preset="<你的插件开发预设>")` 被拒，报 `INVALID_ARGS`（枚举只有 7 个，排除当前预设自身） | 路由表写「插件/DSH 配置→`<插件开发预设>`」，在**该预设自己的会话里****永远不可用** | 新增「⚠️ 若当前会话预设本身就是目标预设（`agent_preset` 枚举排除自身），改用 `spawn_teammate` 降级，并在汇报里写明降级原因」 |

**实测确认有效的部分（0.3.0 保留不动）**

- 硬门拦截：A/B 各拦 1 次（`read`），理由含「只建任务板、不派活 —— 不算开团队」+「第 1 / 4 次拦截」。
- 拦截后行为：两轮都是**立刻改派 `subagent`/`spawn_teammate`**，没有硬扛 4 次配额。
- B 末态：3 条任务全 `completed`、owner 全非空、**零 pending 无主任务**；两条通道都真实派活（`subagent` ×3 + `spawn_teammate` ×2）。

### 文档口径同步（同一批修正，verifier 复验时抓出）

代码侧 4 句改完后，文档里仍有 3 处旧口径，同批修掉：

- `README.md` 现役 7 条摘要第 4 条：仍写「建完必须立刻 `claim`（owner=实际执行成员）」→ 改为「建完立刻 `claim` 认领（`owner` 参数不生效）→ `reassign` 改实际执行成员 → 回报后逐个 `complete`」，并补「`write_scopes` 用工作区相对路径」。
- `README.md` 标题与 `lib/index.js` 注释的字符预算：原写「实测约 1030 字，硬上限 1080」，实际早已超（基线 1342、现 1677），改为「v0.3.1 实测 1677 字符；无硬截断，全文注入」。
- 历史段加注：`README.md` 的 v0.3.0 表格 C 项与 `CHANGELOG.md` 的 0.3.0 C 条目各加一句「⚠️ 已被 0.3.1 更正：`claim` 只认领自己 + `reassign` 改 owner」，避免后人照旧抄。

另注：本插件在开发机上以 `link:`（本地目录依赖）方式挂载，未发 npm / 未推 GitHub；发布包内容以 `npm pack --dry-run --json` 结果为准。

**生效方式**：宿主端文案，**必须彻底退出 DSH 客户端再启动**。

---

## 0.3.0 — 2026-11-08

### 修复「任务板只增不派、子代理一个不开」（用户截图 8 条「未分配·待处理」为证）

**根因（三层）**

1. **判定放水（决定性）**：`TEAM_TOOLS` 里含 `team_task_create`，于是「建一条任务板」就算「已开团队」。
   模型选成本最低的过关路径：`todo_write`（豁免）→ `pwsh` 被拦 1 次 → `team_task_create` → 放行 → 全程自己干。
2. **文案鼓励**：`LAW_TEXT` 写着「不可拆的单步任务也请建一条单任务记录再动手」，叠加每个 turn 重置，
   等于每个 turn 至少往板上丢一条任务。
3. **无主堆积**：`team_task_create` 建的是 unowned pending，官方任务板**不会自动释放 owner**，
   面板又是只读的 → Lead 不 claim 就永远「未分配」。

**改动（用户 2026-11-08 批准 A+A′+B+C+D 全套）**

- **A 判定收紧**：`TEAM_TOOLS` 剔除 `team_task_create`，只留 `subagent` / `subagent_fork` / `spawn_teammate`。
  建任务板仍在 `EXEMPT_TOOLS`（永不拦），但**不再等于开团队**。
- **A′ 配额**：`gateMaxStrikes` 默认 2 → 4（`cordis.patch.yml` 同步 2 → 4），
  并在拒绝理由里回显「本 turn 第 N / 4 次拦截，再拦 X 次后强制放行」。
- **B 文案改写**：第七条改为「必须先出现 subagent / subagent_fork / spawn_teammate 调用；只建任务板不算开团队」；
  末条改为「不可拆的单步任务也要派给 1 个子代理或自建 1 个成员」。
- **C 任务板卫生**：第四条新增「建完必须立刻 `team_task_update claim`（owner=实际执行成员）再派活；
  子代理回报后逐个 complete；每轮开头收口上一轮遗留 pending 无主任务，禁止无主堆积」。
  （⚠️ 此写法已被 0.3.1 更正：`claim` 的 owner 参数不生效，改 owner 必须用 `reassign`）
- **D 通道选择表**：新增第三条「派活通道（选错通道等于没派活）」——
  按预设分域干 → `subagent(agent_preset=...)`；要常驻/多轮/中途引导/进成员面板 → `spawn_teammate`（不能指定预设，继承 Lead）。

**拒绝理由重写**

- 原来「① team_task_create 建任务板 ② subagent ③ 单步任务也建板」→ 现在「① 先派活（这一步才是过关条件）② 再留痕 ③ 单步也要派」，
  并显式加一行「🔴 只建任务板、不派活 —— 不算开团队，本次仍会被拒」。

**已知边界（改不掉，官方 schema 决定）**

- `spawn_teammate` 的参数只有 `name / description / prompt / context(fresh|fork)`，**没有 `agent_preset`** →
  「团队成员按预设分工」做不到；能做到的是「子代理按预设分工 + 任务板由 Lead claim 收口留痕」，D 即此折中写法。

**生效方式**：宿主端改动，**必须彻底退出 DSH 客户端再启动**（无热重载）。

---

## 0.2.2 — 2026-11-08

### 修复 v0.2.1 引入的三个问题（子代理实测抓出来的）

**Bug 1 重做 · `toolSet.view()` 判定不可靠**

- v0.2.1 用 `ResolvedToolSet.view(scope)` 探测「本会话有没有团队工具」，实测两个方向都错：
  - 子代理被判成「有团队工具」→ **仍然死锁**；
  - lead 被判成「无团队工具」→ **硬门被自己关掉**（`pwsh` 不再拦）。
- 改用**会话 header 判定**：子代理会话的 `header.parentSession` 有值 → 直接放行。header 缺失时按 lead 处理（拦），不误放行。

**Bug 3 · `gateMaxStrikes` 一旦用掉就永久放行**

- 现象：每个会话只拦第一次，之后所有调用都过。
- 根因：`payload.turn` 并不可靠递增 → `turnKey` 恒为同一个值 → 计数永不重置。
- 修复：`agent/inbox/claimed` 时 `gateStrikes.delete(sid)` —— 新用户消息 = 新 turn，必定重置。默认 `gateMaxStrikes` 从 1 调到 2（多一道兜底）。

### 子代理实测证据（2026-11-08）

派子代理做只读验证，它回报：

> `team_task_create` **不存在**、`spawn_teammate` **不存在**、`subagent` 存在但「Delegation depth: current 1, maximum 1, remaining levels 0」禁止调用
> → 硬门三条出路全不可用，`read` 死锁。

这是本次修复的直接依据。

### 测试

probe.mjs 扩到 **66 项 ALL PASS**，新增场景 13（header 判定 4 条）与场景 15（新消息重置计数 3 条）。

---

## 0.2.1 — 2026-11-08

### 修复两个实测暴露的缺陷（用户重启后第一轮就踩到）

**Bug 1（严重）· 子代理会话死锁**

- 现象：`<技能治理预设>` 子会话（delegation depth = 0）的 `read` 被硬门拦下，但它的工具清单里**没有** `team_task_create` / `subagent` / `spawn_teammate`，硬门对它不可满足 → 只能改用 `pwsh` 绕路。
- 根因：豁免名单防的是「工具有但被拦」，防不了「工具压根不存在」。
- 修复：新增 `canOpenTeam(exec)` —— 用 `ResolvedToolSet.view(scope)` 检查本会话有没有任何团队工具；一个都没有 → 直接放行（fail-open）。

**Bug 2（中等）· 回报消息被误判为硬启动域**

- 现象：子代理回报里含「台账 / 技能 / dsh / 预设」等词，父会话紧接着查一条日志就被判成「DSH 排查/配置 + 自定义预设」域并拦下。
- 修复：新增 `looksLikeReport(text)` —— 命中 2 个以上回报标记（`回报`/`自检`/`退出码`/`EXIT=`/`已完成`/`子会话`/`subagentId`/`写入的文件`/`改动位置`/`复核命中`/`SHA256`/`转交`）即视为回报，不参与域识别。

### 新增断言（probe.mjs 场景 13 / 14，共 60 项）

子代理无团队工具 → allow ｜ lead 有团队工具 → 仍 deny ｜ `toolSet` 缺失 → 按原逻辑 ｜ 回报消息不判域 ｜ 真实命令仍入域。

### 未变

提示段文本、域关键词表、豁免名单、`gateMaxStrikes` 防死循环全部保持 0.2.0 行为。

---

## 0.2.0 — 2026-11-08

### 新增：工具层硬门（`tools/pre-execute`）

v0.1.0 只有常驻提示（软约束，模型可以不理）。0.2.0 加硬门：**动手前没开团队就拒绝**。

四层判定：

| 层 | 机制 |
|---|---|
| 0 域识别 | 订阅 `agent/inbox/claimed` 缓存本轮用户消息，关键词判 `fluent` / `plugin` / `dsh` / `preset` 四域（strong 命中 1 个即入域；weak 命中 2 个以上才入域，降误判） |
| 1 工具分类 | **入域** → 除豁免名单外**全部工具**都要求已开团队（含 read/glob/grep）；**未入域** → 只拦动手类（`pwsh`/`bash`/`write`/`edit`/`run_code`/`mcp__ansys-fluent__*`） |
| 2 状态判定 | 扫 `session.snapshotEvents()`，本轮出现 `team_task_create` / `subagent` / `subagent_fork` / `spawn_teammate` 任一即视为已开团队 |
| 3 防死循环 | 同一 turn 最多拦 `gateMaxStrikes` 次（默认 1），之后放行 |

### 🔴 Fluent 域按【全流程】判定（不是只拦"求解"）

`几何参数 / 命名 / 透明图 / 网格划分 / 网格质量检查 / setfile / 初始化 / MRF / 通气 / PBM / 进程监控 / 云图矢量图 / xyplot / 数据导出 / 产物整理 / 清理 / 排错` —— **每一步都算**，连读日志、查 case、读 setfile 也一样要先开团队。

### 豁免名单（永远不拦）

`todo_write` / `ask_user_question` / `team_task_*` / `subagent` / `subagent_fork` / `spawn_teammate` / `list_agents` / `send_message` / `wait_agent` / `interrupt_agent` / `skill` / `present` / `cordis_inspect_*`

> 不豁免这些会死锁：模型连建任务板、加载技能都被拦，就无法自救。

### 新增配置

`enforceTeamGate`（默认 `true`）、`gateMaxStrikes`（默认 `1`）、`gateDomains`（默认四域）。

### 新增排查字段

`/dsh-team-orchestrator/status` 增加 `enforceTeamGate` / `gateMaxStrikes` / `gateDomains` / `gateLog`（最近 10 次拦截：工具名 + 域 + turn + 时间）。

### 设计原则

- **全部路径 try/catch → fail-open**：宁可闸门不生效，绝不因为闸门自身 bug 阻塞正常工作。
- **要求「同一件活一次派满 N 路并行」**（1.1.0 起取代旧表述「不要求必须 ≥2 路并行、不为并行而并行」）：声明可拆 N 路就必须一次派满 N 路，禁止派一路等一路；不可拆的单步任务须先在 `todo_write` 第一条写 `【不可拆·单步】`，才允许只派 1 路。
- **按「真派活路数」计数判定，不按调用序号**（`dsh-todo-float-ball` 踩过"计数卡死"事故）：每轮从事件流重算 `dispatchedCount`，只数 `subagent` / `subagent_fork` / `spawn_teammate` 三种，天然免疫 `run_code` 包装与并行批次乱序，也不累加历史残留。

---

## 0.1.0 — 2026-11-08

首版。

### 新增

- 常驻 system-prompt 段 `team-orchestrator-law`（order 250，约 750 字），
  让「判可拆性 → 并行 → 按自定义预设路由 → 任务板跟踪 → 主线程只做拆分与汇总」
  在每个会话、每个预设生效，不依赖任何技能被加载。
- 回环状态路由 `GET /dsh-team-orchestrator/status`：返回插件版本、注入开关、
  段名/order/字数、desktop profile bundles 快照、`teamMounted` / `orchestratorMounted`。
- 配置开关 `injectLaw`（默认 `true`）。

### 设计决定

- **不做硬门**：`tools/pre-execute` 拦截只对「单一确定性动作」成立（如 `todo_write`
  必须是首个调用）；「该不该开团队」是判断题，硬门必然误伤单步任务。
- **不改 persona**：8 个预设各写一遍风险高、易漂移；prompt 段一次覆盖全部。
- **不含客户端 UI**：客户端 bundle 是主要故障源，本插件无 UI 需求。

### 实测依据

- 官方团队包 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js`（62KB）
  全文无 `systemPrompt` 注入 → 团队工具在线但无人下命令。
- 团队包 `cordis.patch.yml` 在宿主层 `disabled: true` 了 `tool-subagent`；
  各预设 `delegation` group 在 isolate 作用域内另行声明 → `subagent(agent_preset)`
  仍然可用。
- `spawn_teammate` schema 无 `agent_preset` 参数 → 预设派活只能走 `subagent`。
