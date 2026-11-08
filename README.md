# dsh-agent-team-auto-orchestrator

DSH 智能体团队编排器（纯宿主插件，无客户端 UI）。

## 它解决什么问题

DSH 的官方团队包 `@deepseek-ai/dsh-experimental-agent-team-profile` 只提供**工具面**
（`spawn_teammate` / `team_task_*` / `wait_agent` / `send_message`），**不注入任何提示**
（实测其 `lib/index.js` 全文 grep `systemPrompt` 零命中）。结果是：团队工具在线，
但模型默认仍单线程串行干活——「枪在枪套里，没人下命令」。

本插件补的就是这条「下命令」的缺口：注册一条常驻 system-prompt 段，把「判可拆性 →
并行 → 按自定义预设路由 → 任务板跟踪 → 主线程只做拆分与汇总」写进**每个会话、每个
预设**的系统提示里。

## 机制（为什么是「常驻」而不是「技能」）

| 层 | 生效条件 | 是否常驻 |
|---|---|---|
| 技能（`agent-team-routing-law` 等） | 需要被 `skill` 工具加载 | 否（按需） |
| 预设 persona | 该预设的会话 | 是，但每个预设要各写一遍 |
| **本插件的 prompt 段** | 插件挂载即生效 | **是，覆盖全部预设 / 全部会话** |

`ctx.systemPrompt.section({ name, order: 250, text })` 是 DSH 官方的常驻提示注册接口，
`dsh-todo-float-ball`（todo 纪律）、`dsh-artifact-linker`（产物路径铁律）、
`dsh-skill-guard`（技能库治理）用的都是同一套。

## 注入的 8 条规则（v0.3.4 实测 1881~1990 字符；无硬截断，全文注入）

1. **每轮先判可拆性**（判独立性，不判难度）。
2. **可拆就并行**：默认 2~3 路，独立块 4~6 路，上限 8（含 lead）。
3. **预设路由表**：**不写在代码里**（v0.3.2 起外置）。在 `<DSH_HOME>/team-orchestrator.local.json`
   的 `presetRoutes` 里填「域 → 你自己的预设 id」（示例见 `docs/local-config.md`）；
   未配置时一律走 `spawn_teammate` 自建成员，**不会猜任何预设 id**。
4. **>2 个子任务必须建任务板**（`team_task_*`），写入范围不重叠（`write_scopes` 用工作区相对路径）；**建完立刻 `claim` 认领（`owner` 参数不生效）→ `reassign` 改实际执行成员 → 回报后逐个 `complete`**，禁止无主堆积。
5. **主线程只做四件事**：拆任务 → 派活 → 收结果 → 合并验收；不亲自跑长活。
6. **团队未开时的降级路径**：仍用 `subagent` 并行，并提示用户「说开团队」。
7. **动手前必须先派活**（v0.2.0 硬门，v0.3.0 收紧）：本轮判定为 Fluent / 插件 / DSH / 预设域时，除豁免名单外任何工具调用前都必须先出现 `subagent` / `subagent_fork` / `spawn_teammate` 调用；**只建任务板不算开团队**。

## 工具层硬门（v0.2.0）

提示是建议，模型可以不理；硬门在工具分发层强制。

### 四层判定

| 层 | 机制 |
|---|---|
| **0 域识别** | 订阅 `agent/inbox/claimed` 缓存本轮用户消息，关键词判 `fluent` / `plugin` / `dsh` / `preset` 四域（strong 命中 1 个即入域；weak 命中 2 个以上才入域） |
| **1 工具分类** | **入域** → 除豁免名单外**全部工具**都要先开团队（含 `read`/`glob`/`grep`）；**未入域** → 只拦动手类（`pwsh`/`bash`/`write`/`edit`/`run_code`/`mcp__ansys-fluent__*`） |
| **2 状态判定** | 扫 `session.snapshotEvents()`，本轮出现 `subagent` / `subagent_fork` / `spawn_teammate` 任一即视为已开团队；⚠️ **`team_task_create` 不算**（v0.3.0 起，建板只留痕） |
| **3 防死循环** | 同一 turn 最多拦 `gateMaxStrikes` 次（默认 **4**），之后放行；拒绝理由会回显「本 turn 第 N / 4 次拦截，再拦 X 次后强制放行」 |

### 🔴 Fluent 域按【全流程】判定

`几何参数 / 命名 / 透明图 / 网格划分 / 网格质量检查 / setfile / 初始化 / MRF / 通气 / PBM / 进程监控 / 云图矢量图 / xyplot / 数据导出 / 产物整理 / 清理 / 排错` —— **每一步都算**，连读日志、查 case、读 setfile 也一样要先开团队。

> 这一条是 2026-11-08 用户纠正后的口径：上一版只拦 `mcp__ansys-fluent__fluent_run_*` 那 5 个工具，**面太窄**——Fluent 任务绝大多数是用 `pwsh` 跑 PyFluent、用 `write` 写 journal，照旧版等于没拦。

### 豁免名单（永远不拦）

`todo_write` / `ask_user_question` / `team_task_*` / `subagent` / `subagent_fork` / `spawn_teammate` / `list_agents` / `send_message` / `wait_agent` / `interrupt_agent` / `skill` / `present` / `cordis_inspect_*`

> 不豁免这些会死锁：模型连建任务板、加载技能都被拦，就无法自救。

### 设计原则

- **全部路径 try/catch → fail-open**：宁可闸门不生效，绝不因闸门自身 bug 阻塞工作。
- **不要求"必须 ≥2 路并行"**：只要求"先派活"；不可拆的单步任务也要派给 1 个子代理或自建 1 个成员，不要自己闷头干。
- **不按调用序号判定**：只看"本轮有没有团队工具调用"，天然免疫 `run_code` 包装与并行批次乱序（`dsh-todo-float-ball` 踩过"计数卡死"事故，这个坑必须避开）。

### v0.3.0 修复（「任务板只增不派、子代理一个不开」）

用户 2026-11-08 实测：多个会话的共享任务板一路涨到 8 条，全是「未分配 · 待处理」，`list_agents` 只有 lead 一个人。

**根因**：v0.2.x 的 `TEAM_TOOLS` 里含 `team_task_create`，于是「建一条任务板」就算「已开团队」。
模型选了成本最低的过关路径 —— `todo_write`（豁免）→ `pwsh` 被拦 1 次 → `team_task_create` → 放行 → 全程自己干。
叠加两件事：文案写着「不可拆的单步任务也请建一条单任务记录再动手」，且每个 turn 都会重置判定 → **每个 turn 至少往板上丢一条任务**；
而 `team_task_create` 建的是 unowned pending，官方任务板**不会自动释放 owner**、面板又是只读的 → 永远「未分配」。

| 方案 | 改动 |
|---|---|
| **A 判定收紧** | `TEAM_TOOLS` 剔除 `team_task_create`，只留 `subagent` / `subagent_fork` / `spawn_teammate`。建板仍在 `EXEMPT_TOOLS`（永不拦），但不再等于开团队 |
| **A′ 配额** | `gateMaxStrikes` 默认 2 → **4**（`cordis.patch.yml` 同步）；拒绝理由回显「第 N / 4 次，再拦 X 次后强制放行」 |
| **B 文案改写** | 第七条改「必须先出现 subagent / subagent_fork / spawn_teammate；只建任务板不算开团队」；末条改「不可拆的单步任务也要派 1 个子代理或自建 1 个成员」 |
| **C 任务板卫生** | 第四条新增：建完立刻 `claim`（owner=实际执行成员）→ 派活 → 回报后逐个 `complete`；每轮开头收口上轮遗留 pending 无主任务（⚠️ 此处 owner 写法已被 v0.3.1 更正为「claim 只认领自己 + reassign 改 owner」） |
| **D 通道选择表** | 新增第三条：按预设分域 → `subagent(agent_preset=...)`；要常驻/多轮/中途引导/进成员面板 → `spawn_teammate`（不能指定预设，继承 Lead） |

> **改不掉的边界**：`spawn_teammate` 没有 `agent_preset` 参数（官方 schema 决定），所以「团队成员按预设分工」做不到。
> 能做到的是「子代理按预设分工 + 任务板由 Lead claim 收口留痕」，D 就是这个折中写法。

### v0.3.2 变更（双轨架构 + 成员复用）

**双轨架构**：本机专属内容（预设路由表 / 业务域关键词 / profile 名）全部外置到
`<DSH_HOME>/team-orchestrator.local.json` —— 该文件在插件目录之外，`npm pack` / `git push` 结构上打不进去。

- 代码里只留**通用默认**：`DEFAULT_PRESET_ROUTES = []`、`DOMAIN_RULES` 去掉业务词、`profileName` 可覆盖
- `local.json` 不存在 / JSON 坏 / 类型错 → 全部回退默认，只影响行为不阻塞
- **热重载**：改 `local.json` 下次工具调用即生效（mtime 检测）；注入文本启动时求值，`presetRoutes` 想立刻反映仍需重启
- 状态路由新增 `localConfig` 段，可查「到底加载了没 / 生效 mtime / 路由条数」
- 等价性实测：改造前 72 个原词逐条比对 → **72/72 同域同级别、0 新增词**，本机行为零变化

**成员复用三条规则**（补真实缺口）：`inactive` 成员不释放名额（`maxMembers` 是累计创建数，**本机实测 8 / 官方默认 16**）→ 新活优先 `send_message` 唤醒复用；
一次性杂活用 `subagent`（不占名额）；`reassign` owner 必须是持久成员。并新增第八条「每轮开始先看花名册」。

### v0.3.1 修正（A/B 实测抓出的 4 句错文案）

v0.3.0 上线后跑了 A/B 两轮实测（A 轮 / B 轮两次独立对话），**硬门行为已验证正确**，
但 `LAW_TEXT` 里有 4 句在教模型做错事：

| # | 实测证据 | 修正 |
|---|---|---|
| 1 | 3 次 `claim` 传 `plugin-scout`/`recon`/subagent-id，返回 `ownerName` 一律 `lead` | `claim` 只能认领给自己；改 owner 必须 `reassign` |
| 2 | `reassign` 到 subagent id 报 `TEAM_MEMBER_NOT_FOUND` | subagent 不在花名册 → 由 Lead 记名并注明「实际执行者=<子代理 description>」 |
| 3 | `write_scopes` 传绝对路径报 `TEAM_INVALID_WRITE_SCOPE` | `write_scopes` 只接受工作区相对路径，可留空 |
| 4 | `subagent(agent_preset="<你的插件开发预设>")` 报 `INVALID_ARGS`（枚举排除当前预设自身） | 当前会话预设即目标预设时，改用 `spawn_teammate` 降级并写明原因 |

**实测确认有效、未改动**：硬门 A/B 各拦 1 次、理由含「只建任务板不算开团队」+「第 1 / 4 次」；
拦截后两轮都立刻改派；B 末态 3 条任务全 `completed`、owner 全非空、零 pending 无主。

### v0.2.2 修复（v0.2.1 的判定方式被实测推翻）

| 问题 | 现象 | 修复 |
|---|---|---|
| `toolSet.view()` 判定不可靠 | 子代理被判成「有团队工具」→ 仍死锁；lead 被判成「无团队工具」→ **硬门被自己关掉**（`pwsh` 不再拦） | 改用 `session.header.parentSession` 判定子代理；header 缺失时按 lead 处理（拦），不误放行 |
| `gateMaxStrikes` 永久放行 | 每个会话只拦第一次，之后全过（`payload.turn` 不递增 → 计数不重置） | `agent/inbox/claimed` 时重置计数；默认 `gateMaxStrikes` 从 1 调到 2 |

> 子代理实测原话：`team_task_create` 不存在、`spawn_teammate` 不存在、`subagent` 存在但「Delegation depth: current 1, maximum 1, remaining levels 0」→ 三条出路全不可用，`read` 死锁。这就是判定必须基于 header 而不是工具集的直接原因。

### v0.2.1 修复（实测踩到的两个坑）

| 坑 | 现象 | 修复 |
|---|---|---|
| **子代理死锁** | `<技能治理预设>` 子会话（delegation depth = 0）工具清单里没有 `team_task_create` / `subagent`，`read` 被拦后**无法自救**，只能改用 `pwsh` 绕路 | `canOpenTeam(exec)`：用 `ResolvedToolSet.view(scope)` 检查本会话有没有团队工具，一个都没有 → 直接放行 |
| **回报被误判** | 子代理回报含「台账/技能/dsh/预设」等词，父会话查条日志就被判成 DSH 域并拦下 | `looksLikeReport(text)`：命中 ≥2 个回报标记（`回报`/`自检`/`退出码`/`EXIT=`/`已完成`/`子会话`/`改动位置`/`SHA256`…）即视为回报，不参与域识别 |

> 教训：豁免名单防的是「工具有但被拦」，防不了「工具压根不存在」。凡是要求"先做 X 才能做 Y"的闸门，都必须先确认「X 在这个会话里做得到吗」。

## 关键事实（别踩）

- **`spawn_teammate` 不能指定预设**（schema 只有 `name / description / prompt / context`）。
  要「用自定义预设」必须走 `subagent(agent_preset=...)`。
- 团队包在**宿主层** disable 了 `tool-subagent`，但每个预设自己的 `delegation` group
  在 isolate 作用域里又声明了一份，所以 `subagent` 在预设内部仍然可用——两者并存。
- 团队上限：`maxMembers: 8`（**本机 profile 层覆盖值**；官方文档默认 16，以实际报错 `Team member limit N reached` 为准）/ `maxTasks: 256`（官方 `agent-team` README 口径）。
- 本插件**做硬门**（v0.2.0 起，v0.3.0 收紧）：`tools/pre-execute` 对「本轮有没有真派活」做判定；
  代价是单步任务也会被拦最多 `gateMaxStrikes` 次，靠 fail-open + 配额兜底，不会死锁。

## 开关

`cordis.patch.yml` 的 `config`：

```yaml
- insert:
    - id: dsh-agent-team-auto-orchestrator
      name: dsh-agent-team-auto-orchestrator
      config:
        injectLaw: true          # false = 不注入 prompt 段，只保留状态路由
        enforceTeamGate: true    # false = 关掉硬门，退回纯软约束
        gateMaxStrikes: 4        # 同一 turn 最多拦几次（4 = 连拦 4 次才放行，逼真派活）
        gateDomains:             # 哪些域触发「全量拦截」
          - fluent
          - plugin
          - dsh
          - preset
```

## 排查

```text
GET http://127.0.0.1:<port>/dsh-team-orchestrator/status
```

返回：插件版本、`injectLaw`、段名/order/字数、desktop profile 的 bundles 快照、
`teamMounted`（团队包是否已挂载）、`orchestratorMounted`（本插件是否已挂载）。
仅本机回环可访问（非 loopback 返回 403）。

> desktop 端默认 `port: 0`（每次重启换随机端口），端口可从启动日志或
> `~/.dsh/desktop-preferences.json` 找到。

## 生效方式

**改完必须彻底退出 DSH 再启动**（宿主是 Node 进程，无热重载；Ctrl+R 不重载宿主）。

## 边界

- 零写入、零 spawn、零联网、零遥测。
- 唯一副作用：每条会话的系统提示多约 750 字（这是它起作用的方式，也是它的成本）。
- 与同名技能 `agent-team-routing-law`（技能库内）分工：本插件管「每轮都提醒」，
  技能管「拆分协议 / 汇总模板 / 路由细节」。

## License

MIT
