# CHANGELOG

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
- **不要求"必须 ≥2 路并行"**：只要求"先走团队流程"。不可拆的单步任务建一条任务记录即放行，不为并行而并行。
- **不按调用序号判定**（`dsh-todo-float-ball` 踩过"计数卡死"事故）：只看"本轮有没有团队工具调用"，天然免疫 `run_code` 包装与并行批次乱序。

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
