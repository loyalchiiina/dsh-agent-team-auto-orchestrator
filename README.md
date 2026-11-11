# dsh-agent-team-auto-orchestrator

> **功能描述**：DSH 智能体团队编排器——宿主端每轮常驻注入 11 节「智能体团队编排方法论」（〇 先判再动手 / 一 该不该交出去 / 二 交给谁 / 三 能拆就拆 / 四 拆了就同时发 / 五 先派给有空的人 / 六 只做四件事 / 七 名字要能点名 / 八 跨会话接得上 / 九 任务板 / 十 预设路由 / 十一 工具层硬门），再加一层计数式工具硬门（按 todo 的并行条数分四档：标了「并行」须同轮一次派满、标 1 路照拒、真·小任务与单步免派），让「并行派活 + 成员复用 + 跨重启才按批次建板」成为任何预设、任何会话的默认行为。适配 DSH 内核 0.2.2-rc.1。

> **English**: A host-side orchestrator for DSH agent teams. It injects an 11-section orchestration law (including a 〇 pre-classification, the reversibility-based channel rule in §1–§2, and the naming rule in §7) into every turn and backs it with a counting tool gate that grades dispatch within each step into four tiers — a "parallel" todo contract must be fully dispatched within the same step (dispatching across steps does not count), a single declared route is still rejected, and genuine small tasks or explicitly single-step work are exempt — and member reuse is enforced by re-scanning `list_agents` before any new spawn, while any step that dispatches 2+ routes must keep a task board, so parallel dispatch, task-board traceability and member reuse become the default in any preset and any session. Adapts DSH kernel 0.2.2-rc.1.

DSH 智能体团队编排器（纯宿主插件，无客户端 UI）。

## 它解决什么问题

- **规则只在「技能被加载时」存在**：技能是机会主义的，模型想不起来加载就没有规则。本插件把编排铁律做成常驻 prompt 段，与是否加载技能无关。
- **「建了个任务板」被当成「派了活」**：早版本的团队工具集把 `team_task_create` 误算成派活信号，于是出现「任务板写得很漂亮、一个子代理都没启动」。1.1.0 起真派活只认三条派活工具。
- **「派 1 路」与「派 3 路」被当成同一件事**：布尔判定只能回答「有没有派活」。1.1.0 改为计数，1.1.1 再细成四档 —— 标了「并行」就是契约。
- **单步任务被硬门反复拦**：硬门对不可拆任务原本无路可走；现在第一条 todo 显式写 `【不可拆·单步】` 即合法豁免。

## 机制（常驻，不依赖技能被加载）

| 机制 | 落点 | 说明 |
|---|---|---|
| 常驻铁律 | `ctx.systemPrompt.section()`（`lib/index.js` L704-713） | 段名 `team-orchestrator-law`、order 250；每轮注入，无硬截断 |
| 工具层硬门 | `ctx.on("tools/pre-execute")`（L747） | 动手前判定，不满足即 deny 并给出可执行的整改步骤 |
| 状态路由 | `GET /dsh-team-orchestrator/status`（L917-926） | 只读回环诊断，非 loopback 一律 403 |
| 本机内容外置 | `<DSH_HOME>/team-orchestrator.local.json`（L80-94） | 预设路由 / 业务域关键词 / profile 名不进发布包 |

## 注入的编排方法论：11 节（单版本，无客户端 UI）

口径来自 `LAW_TEXT_TEMPLATE`（`[ "...", ... ].join("\n")`，长度约 3.1 KB）：

| 口径 | 数值 |
|---|---|
| 模板本体 | **3153 UTF-16 字符** / 3153 码点 / 7606 UTF-8 字节 / **59 行** |
| 模板内占位符 | 3 种 / 5 处：`@@ROUTES@@` ×1、`@@MAXPAR@@` ×2、`@@MINDISP@@` ×2（**无其它 `@@`**） |
| 运行时 textLength（本机 8 条预设路由） | **3292**（`gateMaxParallel: 10`）/ **3290**（`: 6`） |
| 节数 | **11**（〇 ~ 十一） |

口径推导（可自算复核）：`3153 − 10`（`@@ROUTES@@` 占位符）+ `185`（本机 8 条路由渲染出的整行）+ `2 × (2 − 10)`（两处 `@@MAXPAR@@` 换成两位数）+ `2 × (1 − 11)`（两处 `@@MINDISP@@` 换成 1 位数）= **3292**；`gateMaxParallel: 6` 时两处 `@@MAXPAR@@` 各换 1 位数 → **3290**。

本次同版本规则修订（v2）：① 第一节新增「新开代理的固定开销与任务大小无关 → 小任务开新代理必亏」；② 第二节新增 `agent_preset` 白名单提示（报 `selection is disabled` / `must be one of` 就别反复试）；③ 第五节 ④ 上移到 ③ 之后、并压掉「只有必须换预设」那半句重复、补「派活前对一眼上一步派过什么」；④ 第九节任务板降级为「要跨重启才建板」；⑤ 第十一节把「不受此限」改成显式清单（`read`/`glob`/`grep`/`ask_user_question`/`skill`/团队工具/`compress`），并新增 `wait_agent` 使用约束与「不写 todo = 按基础门槛算」兜底。

11 节标题（与 `LAW_TEXT_TEMPLATE` 逐字一致）：

0. 〇、先判，再动手
1. 一、要不要交出去：两条判据
2. 二、交给谁：看「能不能反悔」
3. 三、能拆就拆
4. 四、拆了就同时发
5. 五、先派给有空的人
6. 六、我只做四件事
7. 七、名字要能点名
8. 八、跨会话要能接上
9. 九、任务板：每批派了什么、给了谁、做到哪了
10. 十、预设路由
11. 十一、工具层有一道硬门（执行保障，不改变上面的方法）

各节要点（择要）：

- **〇 先判再动手**：先在心里问三句（做错了要不要叫停/改口？能同时做吗？该我做还是交出去？）。分类不占工具调用，但**每轮第一个工具调用仍是 `todo_write`**，第一份清单就该是分好类的。
- **一 要不要交出去（两条判据）**：**剂量** —— 一句话能答完 / 一两次工具调用能落地（读一个文件、查一个参数、改一行字、回一句话）→ 零碎活自己做，别占人、别开子代理；**性质** —— 不可逆、做完就安心（查资料、核参数、收集信息、既定事实）→ 可交出去、适合并行，可能返工、要边做边聊、会中途变向 → 留主线或交能对话的成员；要读一堆材料 / 跨多文件 / 跑多轮 / 等很久 → 一律交出去。
- **二 交给谁（看可逆性）**：要中途刹车/补话 → 常驻成员 `spawn_teammate`；做完再改就行 → `subagent`。**只有 `subagent` 能指定预设**（`agent_preset`），常驻成员继承主对话当前预设。常驻成员不给身份、不设专长，人格统一为「牛马」。**`subagent` 的独占场景只有一条：这个活必须在某个专用预设下执行**（常驻成员不能单独指定预设）—— 要预设就 `subagent(agent_preset=X)`；不要预设、有人空闲 → `send_message`；不要预设、也没人空闲 → 新建；名额也满 → 才考虑 `subagent`。
- **四 拆了就同时发**：声明几路就是几路，**同一条消息内一次全部发出**；「派一个、等它回来、再派下一个」是伪装并行。并行条目必须用显式标记 `【并行】` / `【并行×N】`（也认 `[并行]`、`「并行」`、`（并行）`），**没标标记的条目不计入并行数**；路数只数派出去的执行者、不含 lead 自己，也不超过当前上限。
- **五 先派给有空的人**：本对话有自己的成员池（每个对话独立一份）。开工前先 `list_agents` 看谁空着 —— ① **任何空闲成员（inactive）**，不分「员工N号」还是早先建的专职成员，一律 `send_message` 复用，能复用就不新建；② **空闲不够同时开工才新建**，补到正好够用、不凑固定个数，编号只增不减；③ **全员在忙且确实没人空闲才改开 `subagent`**。每次准备新建成员之前，必须**在同一个 step 里先重新 `list_agents`** 刷新花名册，不许用上一步或更早的旧结果 —— 查到任何一个空闲成员就直接 `send_message`，不许新建。**名额满了只影响「新建」**：唤醒现有成员永远可用，哪怕 16/16 满，只要有人 inactive 就必须 `send_message`，绝不许因为「满了」改用 `subagent`。派活时谁空闲给谁，**成员闲着就是浪费，不是省钱**；**④ 手里同时有 N 个互不依赖的活 → 就把 N 个活同时分给 N 个不同的空闲成员（同一个 step 内一次发完），禁止排成队一个个喂给同一个成员**；只有「必须换预设」才走 `subagent`（见第二节）。
- **七 命名**：常驻成员按创建顺序叫「员工1号、员工2号、员工3号…」，编号只增不减；一次性执行者用序号+类型（如 `07_查文档_subagent`）；汇报用名字点名，出问题能追到人。
- **八 跨会话**：长活要求写固定进度文件（目标 / 已完成 / 断点 / 下一步 / 产物路径），下次接手先读再续；同一功能反复小修交给同一个成员。
- **九 任务板（派了活就要留痕）**：本轮派出 **≥2 路**、**并且这些活可能要跨重启接着做**（或新建了成员要长期跟踪）→ **才建板**，每个活一条，写清「负责范围 / 产物完整绝对路径 / 验收标准」，派完立刻 `claim`、做完标 `complete`；只是这一轮并行跑完就结束的 → **不建板**（别为了走流程建一堆空条目）；汇报必须按「任务 → 谁 → 状态（待办 / 进行中 / 已完成）」三档说；**建板不能代替派活**。
- **十一 硬门**：派活只算 `subagent` / `subagent_fork` / `spawn_teammate` 三者之一（**建任务板不算**）；跑命令、改文件前必须先派活；纯查询 / 提问 / 加载技能 / 团队工具不受限；**同一步内**一次派满（本机上限 10 路、基础门槛 1 路），分步凑数不算（计数只看当前 step）；同轮撞门达上限后强制放行；真·单步任务在 todo 第一条写 `【不可拆·单步】` 即免派。

⚠️ 注入文本里**不再出现任何 token 数字**（`28,300` / `6,012` / `<2000` / `≤15 次` 等一律没有），经济判断改由第一节「要不要交出去」的**两条例据**承载；这些实测数字只留在本文档与 CHANGELOG 里。

⚠️ 旧文档里的「8 条规则 / 1881~1990 字符 / 约 750 字」是 0.3.x 陈旧口径；「14 节 worker-pool 版 / classic+pool 双模式」是 1.2.0 中途方案，**均已作废**，一律以上表实测值为准。


## 工具层硬门

### 判定分四层

| 层 | 做什么 | 出处 |
|---|---|---|
| ① 域识别 | 本轮用户消息命中 fluent / plugin / dsh / preset 任一域 | L500-528、L719 |
| ② 工具分类 | 豁免工具直接放行；未入域时只拦「动手类」重活 | L285-295、L531-545、L771 |
| ③ 计数 + 四档 | 数「真派活路数」与「todo 里标了几条并行」，算出当前 step 的 `required` | L793-834 |
| ④ 拦截与回显 | 未达标即 deny，回显整改步骤与拦截计数；到上限放行 | L621-678、L884-909 |

判定时机 = `tools/pre-execute`（L747）。**入域**时本轮所有非豁免调用都要过门；**未入域**时只有 `pwsh` / `bash` / `shell` / `write` / `edit` / `run_code` 这类动手工具才过门。每次调用都从事件流重算**当前 step** 的派活数（`turn/start` 或 `step/start` 即归零），不累加历史、不按调用序号判定。

### 三条计数口径

| 计数 | 口径 | 出处 |
|---|---|---|
| 真派活 `dispatchedCount` | 只数 `subagent` / `subagent_fork` / `spawn_teammate`；`team_task_create` **不算**（1.1.0 起剔除）；计数窗口 = **当前 step**（`step/start` 或 `tool/call.data.step` 变化即归零；两个信号都没有时退化为整轮累加，兼容离线事件流） | L208-212、L796-797 |
| 并行条数 `parallelTodos` | `todo_write` 里 **未完成**（`status !== "completed"`）且 content 含「并行」的条目数 | L241-262 |
| 单步标记 `singleStepMarked` | 只认 `todos[0].content`，且必须是字面量 `【不可拆·单步】`；JSON 解析失败 / 无 `todos` / 空数组一律不豁免 | L218、L222-236 |

### 前提与降级行为

四档判定**不是自足的**：它只读 `todo_write` 这一路输出。前提缺一层，四档就静默退化成「固定 `gateMinDispatches` 路」的门 —— 不报错、不告警，只有 `/status` 里的计数在变。先看清前提，再看档位。

**依赖链（四层，从结果往回读，缺一层就降级）**

- **四档判定**（L818-834） ← **本轮采到 todo**：每次门判定都重扫 `session.snapshotEvents()`，`turn/start` 时清零（L788-792），只认当前这一 **step** 的 `tool/call`（L798-802）；换 step 或上一轮写过都不算。
- **本轮采到 todo** ← **模型真调了 `todo_write`**：参数从事件里取（L799 `arguments || args || input` 三键兜底）。本轮没有这条事件（L242 兜底返回 `{0, 0}`）= `todoTotal: 0` = 直接落 `no-todo-fallback`。
- **模型真调 `todo_write`** ← **① 官方内置工具 `@deepseek-ai/dsh-tool-todo` 在**：随 `dsh-base` 默认启用，**人人都有**，不是本插件装的、也不是悬浮球装的。
- **每轮都调** ← **② `dsh-todo-float-ball` 的「每轮第一个调用必须是 `todo_write`」硬门**（**可选**）：它只是逼着模型每轮先写 todo；没装它，工具仍在，只是没人逼。

> ⚠️ `todo_write` 是 DSH 官方内置工具，**不由本插件提供，也不由悬浮球插件提供**。悬浮球是官方 `todo_write` 会话计划的**只读镜像**（浏览器端按会话缓存展示快照，不回写、不改写）；它做的第二件事是在工具分发层逼着每轮先写 todo。工具本体是官方的，权威记录只在官方会话投影里 —— 它手上只有一份浏览器端缓存快照（差异见下「我们会和悬浮球不一致」）。

另两条同样「静默失败」的隐性依赖：

- **工具名精确匹配**：L798 是 `called === "todo_write"` 字符串比较，无别名、无前缀匹配 —— `todo` / `task_write` / `write_todo` 之类的名字一律不认。
- **参数格式**：只认 `{ todos: [ { content, status } ] }`（L249-259）；只数 `status !== "completed"` 的条目（L257），`content` 里含「并行」二字即算一条并行契约（L259）。字段换成 `tasks` / `items`、或 `status` 用 `done` 之类，会被当成「本轮没 todo」，**不报错**，只有 `noTodoFallbackHits` 会悄悄 +1。

**降级对照表**

| 情形 | 实际行为 | 影响 |
|---|---|---|
| 官方工具在 + 每轮都写 | 四档全部正常：`single-step` / `parallel-contract` / `small-task` / 兜底 | 单步与小任务直接放行；标了几路并行就必须同轮一次派满 |
| 官方工具在 + 某轮漏写 | 该轮 `todoTotal = 0` → 落 `no-todo-fallback` → `required` 回落到 `gateMinDispatches`（默认 1，L693-695、L827-829） | 同一台机器「有时宽松、有时被拦」—— 是**这一轮**没写 todo，不是插件坏了 |
| 没装悬浮球（没人逼着写） | 漏写变成常态 → 常驻 `no-todo-fallback`、`required` 恒等于 `gateMinDispatches`（默认 1）；而 `single-step` / `parallel-contract` / `small-task` 三档都要先读到本轮 todo，漏写的轮次里**永不可达** | 每件小事都要求先派 1 路；不派就连拦 `gateMaxStrikes`（默认 4，L687-689、L880）次后被强制放行 |
| 别家插件也用 todo，但工具名不同（`todo` / `task_write`） | 本插件只认 `todo_write` → 落 `no-todo-fallback`（1 路）；**且**别家 todo 工具不在豁免名单里（`EXEMPT_TOOLS` 从 L265 起，其中只有 `todo_write` 在 L266）→ 入域会话里「写 todo」这个动作本身会被派活门拦 | 最差的一档：连写 todo 都被拒 |
| 同名撞车（别家也注册 `todo_write`） | 宿主**硬抛错** `tool "todo_write" is already registered` → 后注册方 `apply` 中断、该 entry `did not activate` | **不是遮蔽、不是双注册**；那插件在列表里「装上了但不生效」 |

**30 秒自查**

桌面端起来后，GET 本机回环地址下的 `/dsh-team-orchestrator/status`（非 loopback 一律 403，L922-926），看 `parallelGate` 这一段（L950-959）：

- `lastTodoArgsSeen`（L958）为 `true` 且 `lastTodoTotal`（L955）> 0 → 这一轮确实采样到了 todo，四档在正常工作；
- `lastGateKind`（L956）为 `no-todo-fallback` 且 `lastTodoTotal: 0` → 本轮没拿到 todo（「模型漏写」与「工具缺失」这两个原因在此字段里**不区分**）；
- `noTodoFallbackHits`（L957）持续增长 → 降级正在发生；注意它按**每次门判定**累加（L830），同一轮多次工具调用会多次 +1，不是「每轮 +1」；
- `lastRequired`（L953）/ `lastParallelTodos`（L954）是最近一次判定的结论：要求派几路 / 数出几条并行；
- 刚重启、还没触发过门判定时，上述字段仍是初值（`null` / `false` / `0`，L450、L452），不要当成降级；
- 最外层 `enforceTeamGate`（L945）为 `false`，说明硬门根本没注册，这些字段会停在旧值。

**两套待办不通用**

「悬浮球待办」与 `dsh-schedule-calendar` 日程中心的「待办」是**两套不同源数据**，互不写入对方：前者跟的是官方 `todo_write` 的会话级计划（清单本身每轮覆盖式重写，但悬浮球的浏览器端缓存会累积历史，见下），后者是日程插件自己的数据仓。本插件只读 `todo_write` 那一套 —— 两边对不上属正常，不是数据丢失，不必去修。

**我们会和悬浮球不一致**

悬浮球是镜像、不是真值源，三类不一致是**已知且预期**的：

| 不一致 | 原因 | 后果 |
|---|---|---|
| 数量 / 内容分歧 | 悬浮球累积历史清单（另有 `MAX_ITEMS = 100` 条上限） | 它显示 12 条、本插件只数到 8 条 |
| stale 错位 | 宿主每轮 `turn/start` 把会话投影置 null，悬浮球的 STICKY 逻辑不清空 | 它还挂着上一轮的清单、本插件已是空白 |
| 三类本地态本插件看不到 | ✕ 隐藏行（`HIDE_KEY`）、骨架占位行、固定会话（`PIN_KEY`）只存在浏览器端 | 用户看到的 ≠ 本插件读到的 |

> **本插件读的是 `tool/call` 的权威 args（每次调用即真值）；悬浮球显示的是带缓存的镜像（可能滞后或累积）。要严格对齐官方真值，不要去读悬浮球。**

**想彻底关掉**

在 `cordis.patch.yml` 本插件的 `config` 行里放，按需要分两档：

- **只放松基础门槛**：`gateMinDispatches: 0`（L693-695）—— 只把 `no-todo-fallback` / `team-once` 两档的 `required` 归零；`parallel-contract` 档照旧按 `min(并行条数, gateMaxParallel)`（默认 6，本机配 10）拦，**不是不拦**。
- **完全不拦**：`enforceTeamGate: false`（L686、L716）—— 整段 `tools/pre-execute` 钩子不注册，任何档位（含 `parallel-contract`）都不再拦。**这一个开关就够，不必再叠加 `gateMinDispatches: 0`。**

代价：完全不拦时并行契约只剩注入文本自觉；十一节铁律本身还在，除非同时设 `injectLaw: false`（L685、L705）。

**后续路线图（未排入 1.1.2）**：把计数器按会话 / 按轮拆开、并改读官方 `todo/write` 事件（不再靠扫 `tool/call` 参数）。本节只做文档说明，代码改动另行排期。

### 四档判定（5 个分支，优先级从高到低）

| # | 条件 | `required` | `kind` |
|---|---|---|---|
| 1 | 第一条 todo 带 `【不可拆·单步】` | 0 | `single-step` |
| 2 | `parallelTodos >= 2` | `min(parallelTodos, gateMaxParallel)`（默认 6，本机 10） | `parallel-contract` |
| 3 | `todoTotal` 为 1~2 且 `parallelTodos <= 1` | 0 | `small-task` |
| 4 | `todoTotal === 0`（本轮从未写 todo） | `gateMinDispatches`（默认 1） | `no-todo-fallback`（`noTodoFallbackHits` 自增） |
| 5 | 其余（≥3 条 todo 但没标并行） | `gateMinDispatches`（默认 1） | `team-once` |

`dispatchedCount >= required` 即放行；`required === 0` 直接放行且不记拦截（L853-854）。

要点：

- **「标了并行」才是契约**：标 3 路就要真派 3 路；超过上限时闸门只要求到上限（`Math.min(parallelTodos, gateMaxParallel)`）。
- **没写 todo 不算小任务**（1.1.1 收紧）：第 4 档回落基础门槛；只有「明确写了 1~2 条 todo 且没标并行」的真·小任务才免派（第 3 档）。
- 默认 `gateMinDispatches = 1` 的含义是「至少走一次团队流程」；设 `2` 可退回 1.1.0 的「必须两路」，设 `0` 等于关掉基础门槛（并行契约档与单步/小任务档不受影响）。

### 拒绝文案（`buildDenyReason`，L621-678）

- 【并行缺口】—— **每次拒绝都会带**：回显「本 turn 已真派活 M 路 / 过门要求 N 路 / 还缺 K 路」（L665-666）。
- 【并行契约违约】—— **仅当** `required >= 2` 且 `parallelTodos >= 2` 时追加：点名「标了 N 条并行，本 turn 只真派活 M 路」（L658-663）。
- 【拦截计数】—— **仅当**本轮有拦截计数时追加：回显第 N / `gateMaxStrikes` 次，以及「再拦几次后强制放行」（L668-673）。

三条整改路径固定写在文案里：① 一次派满 N 路（同一 step 内并发发出）② 再留痕（`team_task_create` 建板 + `claim` + `team_task_update reassign`）③ 真·小任务与单步标记不要求派活。

### 域识别

四域（`DOMAIN_RULES`，L305-333）：`fluent` / `plugin` / `dsh` / `preset`。三档命中（L500-528）：

- `strong` 命中 1 个即入域（例：fluent 域的 `fluent` / `pyfluent` / `ansys` / `workbench` / `meshing` / `.cas` / `.dat`）；
- `weakStrong` 命中 1 个即入域（例：`网格` / `划网格` / `求解` / `云图` / `矢量图` / `初始化` / `残差`）；
- `weak` 命中 ≥2 个才入域（例：`迭代` / `收敛` / `发散` / `交界面` / `后处理` / `监测` / `动画` / `cfd`）。

另有三条硬规则：

- `mcp__ansys-fluent__` 前缀的工具**无条件**算 Fluent 域（L538-540、L766）。
- 看起来像「子代理回报 / 系统通知」的输入（`REPORT_MARKERS` 命中 ≥2 个，L398-403）不参与域识别，避免回报里的「dsh / 技能 / 预设」把会话误判成任务轮。
- 业务专属词不写在代码里（避免暴露使用者画像），一律通过 `local.json` 的 `domainKeywords` 追加到 `weakStrong` 档（L301-304、L337-370）。

### 豁免与放行

- 豁免名单（`EXEMPT_TOOLS`）：`todo_write`、`ask_user_question`、`team_task_create`、`team_task_update`、`team_task_list`、`team_task_get`、`subagent`、`subagent_fork`、`spawn_teammate`、`list_agents`、`send_message`、`interrupt_agent`、`skill`、`present`，以及**上下文管理类** `compress`、`decompress`、`search_context`、`acp_status`（纯读写上下文、不写盘、不跑命令，**永不拦**）；此外 `cordis_inspect*` 前缀整体放行。
- `wait_agent` 自 1.1.0 起**移出豁免**，改由 `waitAgentGate` 判定：默认 `warn`（放行 + 记账），切 `enforce` 才拦。
- 子代理会话（`header.parentSession` 非空，L423、L758）直接放行 —— 对子代理执行硬门会导致永远无法满足的死锁。

### 拦截计数与容错

- 每会话每轮累计拦截，默认 `gateMaxStrikes = 4`（L687-689）；到上限即放行并记账。
- 整条判定链包在 `try/catch` 里 **fail-open**（L906-909）：判定自身出异常绝不影响正常工具调用。

### 设计原则

**并行契约优先于「先派活」**。1.1.1 起要求的是「按 todo 声明如实派满」：

- 标了「并行」→ 同一条消息内一次派满（≤ `gateMaxParallel` 路，默认 6、本机 10）；
- 没标并行、todo ≤2 条 → 不要求派活（真·小任务，自己做更快更省）；
- 从未写 todo → 至少派 1 路（`gateMinDispatches`，默认 1）；
- 不可拆的单步任务 → 在第一条 todo 写 `【不可拆·单步】`，允许不派活。

⚠️ 旧文档那句「不要求必须 ≥2 路并行，只要求先派活」与实现正面矛盾，已删除：现行为是「声明的并行路数就是硬性下限」。

## 并行路数上限：可配（`gateMaxParallel`）

- **闸门实际要求**：`required = Math.min(parallelTodos, gateMaxParallel)`（L855、L868-870）—— 标 20 条并行、上限 6 时闸门只要求 6 路；本机配 10 则要求 10 路。
- **配置口径**：默认 `6`，合法 `2~16`（小数向下取整）；越界 / 非数字 / 字符串一律回落 `6`，并在 `/status` 的 `gateLog` 里留一条 `kind: "config-fallback"`（L698-720）。
- **注入文本**：模板里两处 `@@MAXPAR@@` 在启动时按生效值替换（L202-207），**绝不写死** —— 改了配置而注入文本仍说 6，等于自己给自己放假消息。

1.1.1 曾把上限写死为 6（注入文本还误写「含你自己」，与 `dispatchedCount` 只数三次工具调用的实现冲突）；1.1.2 起两处都改成按配置渲染，并明确「不含 lead 自己」。实践建议：标并行按 2~3 路写，硬场景按上限（本机 10）；`maxMembers`（官方默认 16）是另一条独立上限，别混用。

## 本机内容外置

发布包只含通用默认。本机专属内容从 `<DSH_HOME>/team-orchestrator.local.json` 读（`DSH_HOME` 环境变量可改根目录，默认 `~/.dsh`；L76-78）：

| 字段 | 作用 |
|---|---|
| `presetRoutes` | 预设路由表，拼进注入文本第三节的 `@@ROUTES@@`（`buildLawText`，L184-196）；为空时注入「本环境未配置 presetRoutes，一律用 spawn_teammate 自建成员（不要猜预设 id）」 |
| `domainKeywords` | 追加业务域关键词（只追加到 `weakStrong` 档） |
| `profileName` | `/status` 里显示的 profile 名 |

- 优先级（L60 注释）：**只有上面这 3 个字段**走「`DSH_HOME`（只定位主目录）→ `local.json` → 插件包内 `cordis.patch.yml` 的 `config` → 代码默认」；**硬门参数（`injectLaw` / `enforceTeamGate` / `gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `gateDomains`）不走这条链，只能从 patch `config` 读，写进 `local.json` 不生效**（详见 `docs/local-config.md` 第 4 节）。
- 容错：文件不存在 / JSON 坏 / 字段类型不对 → 全部回退默认，只影响行为不阻塞工作。
- 热重载：按 mtime 检测，改 `local.json` 后**下次工具调用即生效**；但注入文本在启动时求值，改 `presetRoutes` 想立刻反映到注入文本仍需彻底重启。
- 结构隔离：该文件在插件目录之外，`npm pack` / `git push` 结构上就打不进去。

形状与示例见 `docs/local-config.md`、`docs/local-config.example.json`。

## 开关（`cordis.patch.yml` 的 `config`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `injectLaw` | boolean | `true` | 关掉后不注入常驻铁律（只留硬门） |
| `enforceTeamGate` | boolean | `true` | 关掉后不挂硬门（只留注入文本） |
| `gateMaxStrikes` | number ≥ 0 | `4` | 每会话每轮最多拦截次数，到上限放行；**`0` = 永不拦截**（非常规取值，见下） |
| `gateMinDispatches` | number ≥ 0 | **`1`** | 基础门槛（第 4/5 档）：`1` = 走一次团队流程；`2` = 退回 1.1.0「必须两路」；`0` = 关掉基础门槛 |
| `gateMaxParallel` | number 2~16 | `6` | 并行契约封顶路数（1.1.2 新增）；只归零基础门槛关不掉它，非法值回落 6 并记 `config-fallback` |
| `waitAgentGate` | `"warn"` \| `"enforce"` | `"warn"` | `warn` = `wait_agent` 放行 + 记账；`enforce` = 未派满即拦 |
| `gateDomains` | string[] | `["fluent","plugin","dsh","preset"]` | 参与硬门的域 |

```yaml
config:
  injectLaw: true
  enforceTeamGate: true
  gateMaxStrikes: 4
  gateMinDispatches: 1        # 1.1.1 默认值（1.1.0 时为 2）
  gateMaxParallel: 10         # 1.1.2 新增；合法 2~16，默认 6
  waitAgentGate: "warn"       # warn | enforce
  gateDomains: [fluent, plugin, dsh, preset]
```

`gateMinDispatches` / `waitAgentGate` / `gateMaxParallel` 是 1.1.0 / 1.1.1 / 1.1.2 新增键，缺省时用代码默认值（L693-720）—— 不在 `config` 里写也一样生效。

- ⚠️ **`gateMaxStrikes: 0` = 一次都不拦、永不拦截**，等价于把硬门关掉，但比 `enforceTeamGate: false` 更隐蔽 —— 注入文本还在、硬门代码也还在跑，只是永远不触发，`/status` 里看 `enforceTeamGate` 依然是 `true`。**这是非常规取值**，除排障复现外不要用；要关硬门请显式写 `enforceTeamGate: false`。

### 参数从哪来：两种安装方式读的不是同一份 `cordis.patch.yml`

本插件有两种装法，`config` 的读取位置完全不同：

| 安装方式 | 谁的 `config` 生效 | 说明 |
|---|---|---|
| **经聚合包挂载**（插件**不在**本 profile 的 `dsh.profile.bundles` 里，母包在） | **只有母包 `cordis.patch.yml` 里那条 entry 的 `config`** | 插件自己那份 `cordis.patch.yml` 的 `config` **不被解析** |
| **直接安装**（插件自身进 `dsh.profile.bundles`） | **插件自己** `package.json` → `dsh.bundle.patch` 指向的 `cordis.patch.yml` 的 `config` | 发布包默认路径，`npm` 用户看到的就是这一份 |

依据：宿主里 `dsh.bundle.patch` **只对「本 profile 的 `dsh.profile.bundles` 里被点名的包」解析**（asar 内 `dsh-app-boot` 的 `lib/index.js` L1306-1315 注释 + L1328-1348 实现；官方 `README.zh.md` L50 同义）。插件只是母包的一个子插件、自身没被 `dsh.profile.bundles` 点名时，宿主根本不会去读它的 `dsh.bundle.patch`。

⚠️ 所以**经聚合包挂载时，改插件目录里 `cordis.patch.yml` 的 `config` 是无效的**，要去改母包那条 entry：

```yaml
# <profile>/node_modules/<聚合包>/cordis.patch.yml
- id: <母包里那条 entry 的 id>
  name: dsh-agent-team-auto-orchestrator
  config:
    gateMaxParallel: 10
```

改完仍需**彻底退出 DSH 再启动**（宿主侧无热重载）。

## 排查：`/dsh-team-orchestrator/status`

只读 JSON，只允许 loopback（非 loopback 返回 `403 {"ok":false,"error":"loopback only"}`，L923-925）。桌面端端口常为随机，从启动日志或 `desktop-preferences.json` 取。

| 字段 | 含义 |
|---|---|
| `ok` / `name` / `version` | 是否就绪 / 插件名 / 版本 |
| `injectLaw` / `enforceTeamGate` | 注入与硬门是否开启 |
| `gateMaxStrikes` / `gateDomains` | 生效的配置 |
| `parallelGate.minDispatches` / `waitAgentGate` | 并行门基础门槛与 `wait_agent` 策略 |
| `parallelGate.maxParallel` | 生效的并行封顶路数（1.1.2 新增，默认 6；本机 10） |
| `parallelGate.lastRequired` / `lastParallelTodos` / `lastTodoTotal` / `lastGateKind` | 最近一次判定的四档结论 |
| `parallelGate.noTodoFallbackHits` | 第 4 档「从未写 todo → 回落基础门槛」的累计命中次数 |
| `parallelGate.lastTodoArgsSeen` | 是否已捕获到最近一次 `todo_write` 参数 |
| `parallelGate.trackedSessions` / `sessions[]` | 追踪中的会话，及各会话 `dispatched` / `required` / `parallelTodos` / `todoTotal` / `kind` / `singleStep` |
| `section.name` / `order` / `textLength` | 注入段的段名、order 与**运行时字符长度**（本机 8 条路由 + 上限 10 = **3292**；上限 6 时为 **3290**） |
| `localConfig.file` / `loaded` / `mtime` / `activeMtime` / `presetRouteCount` / `profileName` | local.json 是否读到、路由条数 |
| `team.teamMounted` / `team.bundleCount` | profile 的 bundles 里是否有官方团队包 |
| `team.orchestratorMounted` / `orchestratorMountedVia` | 本插件是否已挂载，以及证据链（`profile.bundles` / 具体 `cordis.patch.yml` / `patch-insert(未定位)`） |
| `gateLog` | 最近拦截记录（最多 10 条），每条含 `tool` / `domains` / `turn` / `at` / `dispatched` / `required` / `kind`（`gate-deny` 或 `wait-before-full-dispatch`） |

## 生效方式

| 改动 | 生效方式 |
|---|---|
| `lib/index.js` / `package.json` / `cordis.patch.yml` | **彻底退出 DSH 客户端再启动**（宿主是 Node 进程，没有热重载） |
| `<DSH_HOME>/team-orchestrator.local.json` | **下次工具调用即生效**（mtime 热重载）；但 `presetRoutes` 影响注入文本，需彻底重启才反映到 prompt |
| 本插件无客户端 bundle（1.2.0 起 `lib/client.js` 已删除） | 不需要 Ctrl+Shift+R，改完直接重启宿主 |

## HTTP 路由（无 UI，全部保留）

设置页面板已移除，但后端能力一个都没删 —— 需要时用请求（或浏览器）直接调，全部只允许 loopback：

| 路由 | 用途 |
|---|---|
| `GET /dsh-team-orchestrator/status` | 只读状态（见上一节字段表） |
| `GET /dsh-team-orchestrator/tiers` | 三档预设 + 宿主预算 |
| `POST /dsh-team-orchestrator/tier` | 切档 `{"tier":"lean\|balanced\|turbo"}`，或自定义 `{"tier":"custom","values":{...}}` |
| `POST /dsh-team-orchestrator/bench/micro` | 纯计算微基准（`countParallelTodos` / `hasSingleStepMark` / `buildLawText`） |
| `POST /dsh-team-orchestrator/bench/parallel` | 并行收益基准 `{"tasks":8,"workMs":120}` |


验证口径：`/status` 的 `version` 与 `section.textLength` 都要对得上 —— 只看「点了没反应」不算验证。

## 边界与已知限制

- 零写入、零 `spawn`、零联网、零遥测：只读取 profile 的 `package.json` 与 `<DSH_HOME>/team-orchestrator.local.json`，唯一副作用是常驻 prompt 段 + 一条回环状态路由。
- 注入有真实成本：每条会话的系统提示多出 **3292 个 UTF-16 字符**（本机 8 条预设路由 + `gateMaxParallel: 10` 实测；模板本体 7606 UTF-8 字节），相当于每轮都随行一份方法论。
- `spawn_teammate` 不能指定预设（成员继承当前预设）；`subagent` / `subagent_fork` 才能指定，但 `subagent` 不在成员花名册。
- `maxMembers` 是**累计创建数**（含失败）：官方默认 16，本机 1.1.2 起也设为 16（此前实测 8）；最终仍以实际报错 `Team member limit N reached` 里的 N 为准；inactive 成员不释放名额。
- 硬门只管「当前 step 有没有真派活 / 有没有在同一步内按声明的并行数一次派满」，不判断任务质量、不判断派给谁最合适。

## 变更记录（择要）

| 版本 | 日期 | 要点 |
|---|---|---|
| 1.1.1 | 2026-11-09 | 并行门改**四档**（含单步共 5 个分支：单步 / 并行契约 / 真·小任务 / 无 todo 回落 / 其余）；`gateMinDispatches` 默认 2 → **1**；新增 `countParallelTodos` 与「最近一次 `todo_write` 参数」捕获；拒绝文案按场景加【并行契约违约】；注入文本加第十一节；`/status` 加 `lastRequired` / `lastParallelTodos` / `lastTodoTotal` / `lastGateKind` / `lastTodoArgsSeen`；版本号 1.0.1 → 1.1.1（1.1.0 发布时漏同步版本号） |
| 1.1.0 | 2026-11-09 | 硬门**布尔 → 计数**（当时默认 2 路）；单步豁免只认 `todos[0]`；注入文本去掉「克制开子代理」改为「克制的是新建成员数」、拆任务改为「一次派满 N 路」；`orchestratorMounted` 语义修正 + 新增 `orchestratorMountedVia` 证据链；`wait_agent` 移出豁免并新增 `waitAgentGate`；新增第十节经济阈值（28,300 / 6,012 token）；`/status` 新增 `parallelGate`，`gateLog` 每条加 `dispatched` / `required` / `kind` |
| 1.0.1 | 2026-11-09 | 新增 `locale/en.json`、`locale/zh.json` 与 `exports` / `files` 白名单条目；`lib` 无改动 |
| 1.0.0 | 2026-11-08 | 包名统一为 `dsh-agent-team-auto-orchestrator`；清掉业务画像残留；补 `repository` / `homepage` / `bugs`；首发 |
| 0.3.x | — | 任务板误判修复（`team_task_create` 不计派活）、`gateMaxStrikes` 2→4、拒绝文案改写；本机专属内容外置到 `local.json`（双轨架构）；澄清 claim / reassign / write_scopes / agent_preset 四句错文案 |
| 0.2.x | — | 硬门改用 `header.parentSession` 识别子代理会话（替代不可靠的 `toolSet.view`）；回报误判修复（`looksLikeReport`）；拦截计数重置 |

更细的逐条变更见 `CHANGELOG.md`，方法论长文见 `docs/team-orchestration-methodology.md`。

## License

MIT
