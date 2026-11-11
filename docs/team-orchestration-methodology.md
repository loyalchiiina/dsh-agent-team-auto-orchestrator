# DSH 智能体团队：可复用方法论与实现指南

> 本文讲一件很具体的事：**怎么让 Lead 真的把活派出去**，而不是只往共享任务板上堆任务。
> 适用于任何想在自己环境里启用「Agent Teams」并让它真正干活的人。
> 文中路径一律用占位符（`<PROFILE_DIR>` / `<PLUGIN_DIR>`），不含任何本机信息。

---

## 0. 一句话结论

> **「团队工具在线」≠「团队会用」。**
> 只加提示词不够——模型会选成本最低的过关路径。必须有一道**工具层硬门**，把"是否真的派了活"变成可以判定、可以拒绝的事实。

---

## 1. 先认三种典型失败（症状极具欺骗性）

| 现象 | 你以为的原因 | 真实原因 |
|---|---|---|
| 共享任务板一路涨，全是「未分配 · 待处理」 | 模型太懒 | **「建任务板」被当成了「已开团队」**，模型建一条就过关，然后全程自己干 |
| `list_agents` 里只有 lead 一个 | 团队没开 | 从没调用过 `spawn_teammate` / `subagent`；任务板涨 ≠ 派活 |
| 派了活，但任务板 owner 记不上 | 插件坏了 | `subagent` **不在成员花名册**；`claim` 的 `owner` 参数**根本不生效** |

这三种失败在日志里**几乎不留痕迹**：不报错、不报警，只有一个安静膨胀的任务板。

---

## 2. 组件全景：官方 4 个包 + 1 个编排插件

官方把团队拆成四个层级，你只需要开一个开关（组合包），其余是零件：

| 组件（npm 包） | 职责 | 必须知道的关键事实 |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **组合包（要开的就是它）** | 运行时内容就是一份 `cordis.patch.yml`，在 base 之上叠加「服务 + 工具 + UI」。**默认关闭** |
| `@deepseek-ai/dsh-experimental-agent-team` | **领域服务**：roster + 持久任务板 + 直投消息 + 冷恢复 | `TeamId = SessionId` → **每个会话是一支独立团队、一块独立任务板**；`maxMembers` 16、`maxTasks` 256；**任务板不会自动释放 owner** |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | **给模型的 9 个工具** | 只有 Lead 能 `spawn_teammate` / `reassign` / `interrupt_agent` |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | **面板**：成员列表 + 任务看板 + 点进成员会话 | **纯只读**，面板上不能改任务；任务只能由模型用工具改 |
| **`dsh-agent-team-auto-orchestrator`（自研编排插件）** | 常驻注入规则 + **工具层硬门** | 本文的核心。官方没有这一层，这就是「工具在线但不用」的缺口 |

### 九个工具的正确语义

| 工具 | 谁可用 | 语义要点 |
|---|---|---|
| `spawn_teammate(name, description, prompt, context)` | **仅 Lead** | `context=fresh` 不继承对话；`fork` 继承 Lead 已完成轮次。**名字永久占用，失败也不复用**。⚠️ **没有 `agent_preset` 参数** |
| `send_message(target, message)` | 全员 | 对运行中成员在最近步骤边界 steering；对 inactive 成员**启动/恢复**它。发送成功 ≠ 已处理 |
| `list_agents` | 全员 | 返回 `target` 与状态。`inactive` = 当前没在跑，**不代表任务完成/失败** |
| `wait_agent(timeout_ms)` | 全员 | 只等「下一次变化」，**从不唤醒成员**；无活跃成员时立刻返回 `noProgress` |
| `interrupt_agent(target)` | **仅 Lead** | 打断当前轮次，保留其待收 inbox |
| `team_task_create / get / list / update` | 全员 | `update` 是 **CAS**（必须带 `expected_revision`）；动作：claim / release / edit / set_dependencies / complete / reopen / reassign / delete |

**官方推荐流程**：`list` → `get` → `claim`（带当前 revision）→ 干活 → `complete`。
就绪状态**永远不会自动启动 owner**，必须你主动 spawn 或 send_message。

---

## 3. 三层机制：让「真派活」变成硬事实

### 3.0 先记住一条通则（全文最值钱的一句）

> **闸门只认「不可替代的过关动作」。凡存在更便宜的动作能过关，模型必选最便宜那条。**

这条不是猜的，是实测出来的：最初把「建任务板」放进过关条件，模型立刻找到了最省事路径——

```
todo_write（豁免）→ 动手工具被拦 1 次 → team_task_create（算开团队）→ 放行 → 全程自己干
```

**成本 1 次调用，换来全程自由。** 于是任务板涨到 8 条、子代理一个没开。

由这条通则可推出闸门设计的五条硬规则：

| # | 规则 | 违反的后果 |
|---|---|---|
| 1 | 过关条件必须是**只有真干活才会产生**的动作（如 `spawn_teammate` / `subagent`） | 放水 |
| 2 | **不能把"留痕类动作"放进过关条件**（建任务板、写 todo、写日志） | 模型只留痕不干活 |
| 3 | 过关动作要**唯一且不可伪造**（别给两条等价路径） | 模型选更便宜那条 |
| 4 | 配额要**够**（1~2 次会被硬扛到放行，推荐 4） | 拦了等于没拦 |
| 5 | 拒绝理由要**回显剩余次数** | 模型以为被永久封禁，乱试或放弃 |

**适用范围**：任何「必须先做 X 才能做 Y」的闸门（不限于团队场景）——例如"必须先跑质量检查才能提交"、"必须先备份才能改配置"。

---

### 3.1 第一层 · 常驻注入（软约束，管方向）

一段约 4412 字符（模板本体 4254 字符；替换本机 8 条路由与并行上限占位后 4410~4412 字符；本机并行上限配 10，故实际注入 4412 字符）。

1. **每轮先判可拆性**（判独立性，不判难度）
2. **可拆就并行**（默认 2~3 路，独立块 4~6 路，声明路数封顶 `gateMaxParallel`（默认 6、本机 10）且**不含 lead 自己** —— 闸门按 `Math.min(并行条数, gateMaxParallel)` 计算，只数 `subagent` / `subagent_fork` / `spawn_teammate` / `send_message` 调用次数，1.3.2 起 `send_message` 也计入派活路数）
3. **派活通道选择**（见 §5.1；并写明"预设枚举排除自身"的降级规则）
4. **任务板只留痕，不等于派活**（建完必 claim → reassign → complete；每轮收口上轮遗留）
5. **你只做四件事**：拆任务 → 派活 → 收结果 → 合并验收（不亲自跑长活）
6. **团队未开时**：仍用 `subagent` 并行，并在末尾提示用户
7. **动手前必须先派活**（工具层硬门，见 3.2）

> 注意：**只靠这一层不够**。提示是建议，模型可以不理；实测中它会把第 4 条读成"建条任务就算留痕"，然后跳过派活。

### 3.2 第二层 · 工具层硬门（硬约束，管执行）

在工具分发层拦截，判定规则只有一条：

```
本轮是否出现过 subagent / subagent_fork / spawn_teammate / send_message 调用？
  ├─ 是 → 放行
  └─ 否 → 拒绝，并给出「先派活、再留痕」的过关路径
```

**四个必须做对的细节**（这是本文最值钱的部分）：

| 细节 | 为什么 |
|---|---|
| **`team_task_create` 绝不能算"已开团队"** | 否则模型建一条任务就过关，任务板只增不派。这是最核心的修复 |
| **配额要有上限（推荐 4）** | 配额 1 或 2 时，模型被拦 1~2 次后仍会硬扛到放行；4 次才能逼出真实派活 |
| **拒绝理由要回显「第 N / 4 次」** | 让模型知道还有几次机会，避免它以为"被永久封禁"而乱试 |
| **子代理会话必须直接放行** | 子代理没有 `spawn_teammate` / `team_task_create`（delegation depth 用尽），对它拦就是**死锁** |

**另外两条工程纪律**：

- **fail-open**：硬门自身任何异常都放行。宁可闸门不生效，绝不因闸门 bug 阻塞正常工作。
- **`team_task_create` 要留在豁免名单**：建板本身永不拦（否则模型连留痕都做不到，无法自救）；它只是**不再算过关**。

### 3.3 第三层 · 任务板闭环（管收口）

```
建板 → claim 认领 → reassign 给实际执行成员 → 派活 → 回报后逐个 complete
```

**不闭环的后果**：任务永远停在「未分配 · 待处理」，你每次看都像"没派活"。

---

## 4. 六条平台事实（踩坑清单，照抄即可避坑）

| # | 事实（实测） | 应对 |
|---|---|---|
| 1 | `team_task_update` 的 `claim` **忽略 `owner` 参数**，返回的 `ownerName` 一律是调用者自己（Lead） | `claim` 只用于占位；改 owner 必须再发一次 `action: "reassign"` + `owner: <成员 target>` |
| 2 | `subagent` **不在成员花名册**（`list_agents` 看不到、`team/member` 无记录）；`reassign` 到 subagent id 报 `TEAM_MEMBER_NOT_FOUND` | 由 subagent 干的活，任务板 owner 只能记 Lead，并在任务描述里注明「实际执行者=<子代理 description>」 |
| 3 | `team_task_create` 的 `write_scopes` **只接受工作区相对路径**；传绝对路径报 `TEAM_INVALID_WRITE_SCOPE`，任务建不成 | 写作用域用相对路径；工作区外的文件**留空 `write_scopes`**，把**完整绝对路径写进 `description`** |
| 4 | `subagent` 的 `agent_preset` 枚举**排除当前会话预设自身**：在 A 预设会话里派 A 会报 `INVALID_ARGS` | 目标预设=自身时，改用 `spawn_teammate`（继承 Lead 预设）降级，并在汇报里写明降级原因 |
| 5 | 硬门**只认** `subagent` / `subagent_fork` / `spawn_teammate`；**只建任务板不算开团队** | 顺序固定为「先派活、再留痕」 |
| 6 | `gateMaxStrikes` 默认 **4**：同一 turn 最多拦 4 次；**每条新用户消息重置计数** | 被拦就当场派活再重试；连拦 4 次后放行属兜底，不代表闸门失效 |

---

## 5. 正确用法（可直接抄）

### 5.1 通道选择表

| 场景 | 用哪个通道 | 理由 |
|---|---|---|
| **按预设分域干**（不同域交给不同角色的子代理） | `subagent(agent_preset=...)` / `subagent_fork` | **唯一能指定预设的通道** |
| **要常驻、多轮协作、可被中途引导、要出现在成员面板** | `spawn_teammate` | 进 roster、可 `send_message`、可 `interrupt`；但**不能指定预设**（继承 Lead） |
| **两者都要** | subagent 拿结果 → Lead 自己 claim 任务并在描述里注明实际执行者 → complete | 兼顾"按预设干"与"任务板留痕" |

### 5.2 任务板写法（>2 个子任务才建）

```text
team_task_create(
  subject  = 一句话说清这块干什么
  description = 负责哪块 / 写哪些文件 / 产物完整绝对路径 / 验收标准
  write_scopes = ["相对路径1", "相对路径2"]   # 绝对路径会报错；工作区外留空
)
→ claim（认领给自己）
→ reassign（owner = 实际执行成员）
→ 派活
→ 回报后 complete
```

### 5.3 每轮开头要做的收口

> 先看上一轮遗留的 pending 无主任务：**claim / reassign / complete 三选一**，禁止无主堆积。

### 5.4 成员复用（最容易被忽略的一节）

`list_agents` 里那些显示 `inactive` 的成员，**不是死成员，是待命成员**。这一节讲清楚：为什么不复用，跑到后面必然撞墙。

#### 成员状态四态

| 状态 | 含义 | 判据 |
|---|---|---|
| `provisioning` | 正在创建（进程起来了、还没就绪） | 秒级过渡态 |
| `running` | 当前正在干活 | `send_message` 在最近步骤边界 steering |
| **`inactive`** | **当前没在跑** | ⚠️ **既不代表任务完成，也不代表失败**，只表示这一刻空闲 |
| `failed` | 创建或运行失败 | 名字仍被永久占用，**名额照样计** |

> 最容易读错的就是 `inactive`：它既不是「做完了」，也不是「挂了」，而是「这个人还在花名册上，只是此刻没说话」。

#### `send_message` 会启动或恢复非活动成员

对 `inactive` 成员发一条 `send_message`，它会**从冷状态被唤回、接着自己原有的会话上下文继续干活**——这就是复用，**不需要重新 `spawn_teammate`**。

#### `maxMembers` 是「累计创建数」（**官方默认 16，本机 1.1.2 起也设 16**）

官方服务的 `maxMembers` 指的是**这个会话累计创建过多少个成员**，不是并发数，**而且创建失败的成员也计入**。所以「用完就扔、下次再 spawn」这种写法，必然撞上限且**没有任何补救手段**（上限不会被 inactive 释放）。

#### 一个推演：不复用会怎么死

```text
会话开始，maxMembers = **16**（1.1.2 起本机 profile 层覆盖值 = 官方默认 16；1.1.1 及更早实测 8 —— 以实际报错 `Team member limit N reached` 为准；累计创建数，非并发数）

spawn_teammate(recon)    # 1
spawn_teammate(impl)     # 2
spawn_teammate(review)   # 3
spawn_teammate(test)     # 4
spawn_teammate(docs)     # 5
→ 5 个成员先后跑完，全部变 inactive（名额一个都没释放）

新任务来了：
❌ spawn_teammate(recon2)   # 6
❌ spawn_teammate(impl2)    # 7
   ...
❌ spawn_teammate(whatever) # 17 → 报成员上限，任务卡死，无解

✅ 正确写法（名额不消耗）：
send_message(target=recon, "新任务：先摸清 X 的现状，给结论")
send_message(target=impl,  "接着 recon 的结论，改 Y")
```

结论：**第 6 个开始就不该再 spawn，该唤回**。

#### 标准动作：每次派活前三秒看一眼花名册

```text
新任务到了 → 先查花名册，再决定要不要建人
list_agents()
  ├─ 有职责匹配的 inactive 成员 → send_message(...)   ← 复用，名额 +0
  ├─ 有职责匹配的 running 成员  → send_message(...)   ← steering，排在它的步骤边界
  └─ 一个都没有                → 才 spawn_teammate    ← 名额 +1，且永久不可退回
```

这条顺序**不能倒过来**：先 spawn 再想"是不是有人能干"——那一步已经把名额花掉了。

#### `spawn_teammate` vs `subagent`：一眼选对

| 维度 | `spawn_teammate` | `subagent` |
|---|---|---|
| 进成员花名册（`list_agents` 可见） | ✅ 是，持久成员 | ❌ 否，只在后台跑自己的 |
| 占 `maxMembers` 名额 | ✅ 占，创建即计数（含失败） | ❌ 不占 |
| 能否复用（后续再派新任务） | ✅ `send_message` 随时唤回 | ❌ 一次性，跑完即弃 |
| 能否当任务板 owner | ✅ 可以 | ❌ 不可以（会报 `TEAM_MEMBER_NOT_FOUND`） |
| 适用场景 | 常驻角色：侦察 / 实现 / 验收 / 文档 | 一次性杂活：查个资料、跑一次命令、做个独立分析 |

#### 复用的两个前提（不满足就别复用）

1. **职责对得上**：新任务和该成员原来的角色是同一类活（recon 还是侦察、impl 还是实现）。角色错了，复用只会得到一堆跑题产出。
2. **上下文可继承**：`send_message` 唤回的成员**带着自己那段历史上下文**。如果新任务需要完全干净的上下文，才值得新开一个成员——但要清楚这一步会**永久花掉一个名额**。

#### 三种常见误用

| 误用 | 后果 | 正解 |
|---|---|---|
| 「上一个成员做完了，扔掉再建一个」 | 名额累计上涨，跑到第 17 个直接报错 | 建前先 `list_agents`，职责匹配就唤回 |
| 让 `subagent` 接着干第二件事 | 报 `TEAM_MEMBER_NOT_FOUND`，任务板也挂不上 owner | subagent 只干一次；要接力就换 `spawn_teammate` 建的持久成员 |
| 用 `spawn_teammate` 干一次性小活 | 白占一个永久名额，且这名成员以后没活可干 | 一次性杂活一律 `subagent` |

#### 一句话

> **常驻角色建一次、之后一直 `send_message` 复用；一次性杂活用 `subagent`（不占名额）。**

---

## 6. 应用场景

### 该开团队（命中任一条）

- **多文件 / 多插件**：一次要改 3 个以上互不依赖的文件或包
- **多工况 / 多数据集**：同一套流程跑 N 组参数
- **多章节 / 多文档**：长文档分章并行撰写或翻译
- **多个独立验证角度**：同一产物要同时做「语法 / 一致性 / 脱敏 / 性能」四种检查
- **长流程里可并行的阶段**：先串行定方案，再并行执行

### 不该开团队

- **单点深度推理**（一个问题、一个结论、一条推理链）
- **强顺序依赖**（后一步必须看前一步结果才能决定）
- **一个结论一个文件**（拆了也合不回来）

### 一个真实场景（脱敏）

> 用户反馈「任务板一直涨，但子代理一个没开」。
> 排查路径：读插件源码 → 定位 `TEAM_TOOLS` 含 `team_task_create` → 确认"建板即过关" → 改判定 + 提配额 + 改文案 → 用两个对照会话（单步任务 / 三子任务）实测 → 发现 4 处文案给错指令（claim owner、subagent 花名册、write_scopes、预设枚举）→ 修文案 → 独立复核 → 重启验收。
> **关键教训**：修完之后要**用两个不同规模的任务各测一次**——单步任务验"会不会被拦后立刻改派"，多子任务验"建板/claim/complete 闭环"。

---

## 7. 移植到你自己的环境（Step 1~7）

### Step 1 · 前置检查

- 宿主版本满足官方包要求
- 有一个可用的 profile（`<PROFILE_DIR>`），且已装 base 包
- 有持久会话存储（官方团队包**依赖**它）

### Step 2 · 装官方组合包

```sh
dsh plugin --profile <你的 profile> add @deepseek-ai/dsh-experimental-agent-team-profile
```

或在该 profile 的插件页开启「智能体团队」。
装完检查：`<PROFILE_DIR>/package.json` 的 `dsh.profile.bundles` 里应只有**一个**组合包条目（不要同时留旧的 web-profile 条目）。

### Step 3 · 装/实现硬门

两条路，任选：

**路 A（省事）**：装现成的 `dsh-agent-team-auto-orchestrator`（本文描述的插件），它已包含注入 + 硬门 + 状态路由。

**路 B（自建，约 200 行）**：在你自己的宿主插件里实现三件事：
1. 注册一条 `systemPrompt` 段（内容抄 §3.1 的 12 节）
2. 监听工具分发前置事件，实现 §3.2 的判定（三个细节一个都不能少）
3. 注册一个只读状态路由（便于排查：当前配置 / 最近 10 次拦截记录）

### Step 3.5 · 把插件挂进 profile（选路 A 才需要）

现成插件不会自动出现在 profile 里，必须显式挂载：

1. 把插件目录放到任意位置，记下绝对路径 `<PLUGIN_DIR>`
2. 编辑 `<PROFILE_DIR>/package.json`：
   - `dependencies` 加一行 `"dsh-agent-team-auto-orchestrator": "link:<PLUGIN_DIR>"`
   - `dsh.profile.bundles` 数组追加 `"dsh-agent-team-auto-orchestrator"`
3. 在 profile 目录执行 `pnpm install`
4. 🔴 **不要**再在 `<PROFILE_DIR>/cordis.patch.yml` 里手写同一个 `- insert:` 段——插件自带的 `dsh.bundle.patch` 已经负责，重复写会触发 `duplicate loader entry id`
5. 确认官方团队包**也在**同一份 `bundles` 里（两者缺一，整套机制空转）

### Step 4 · 配置

```yaml
- insert:
    - id: team-orchestrator
      name: dsh-agent-team-auto-orchestrator
      config:
        injectLaw: true          # 是否注入 12 节方法论
        enforceTeamGate: true    # 是否启用工具层硬门
        gateMaxStrikes: 4        # 同一 turn 最多拦几次（推荐 4）
        gateDomains: [fluent, plugin, dsh, preset]   # 哪些域触发全量拦截
```

> **生效方式**：宿主端改动**没有热重载**，必须**彻底退出客户端（含托盘）再启动**。
> 客户端 bundle 类改动才用硬刷新（Ctrl+Shift+R），两者别混。

### Step 5 · 验收（三步，缺一不可）

**① 单步任务**：新开对话，让 Lead 读一个文件。
期望：**先被拦一次**（理由里应出现「只建任务板、不派活 —— 不算开团队」+「第 1 / 4 次拦截」），然后**立刻改派 `subagent`**，再重试通过。

**② 多子任务**：给一个 3 块、互不依赖、各要产出文件的任务。
期望：建 3 条任务 → `claim` → `reassign` → 派活 → 3 个产物落盘 → 逐条 `complete`；`list_agents` 里出现非 lead 成员；末态**零 pending 无主任务**。

**③ 反向验证**：故意只调 `team_task_create`，然后直接调动手类工具。
期望：**被拒**。如果通过了，说明硬门判定还包含 `team_task_create`，没改干净。

---

### Step 6 · 移植时必改的三处（否则别人跑不起来）

| # | 要改什么 | 在哪 | 不改会怎样 |
|---|---|---|---|
| 1 | **预设 id 表** | `LAW_TEXT` 第三条路由表 + `buildDenyReason` 的「具体出路」 | 别人没这些预设 → `subagent(agent_preset=...)` 报 `INVALID_ARGS`，只能降级 `spawn_teammate`，**拒绝理由给出的"具体出路"全部失效**（这是最大移植障碍） |
| 2 | **域关键词表** | `DOMAIN_RULES`（strong / weakStrong / weak 三级） | 非本机领域几乎永不入域 → 退化成「只拦动手类工具」的弱模式；英文用户命中率为零 |
| 3 | **profile 名** | `readProfileBundles()` 里写死的 `"desktop"` | 状态路由少几个字段（**不影响闸门**），但别人看状态页会困惑 |

**推荐改法**：

- **预设 id** → 抽成文件顶部常量表，注释写「改成你自己的预设 id」；或把路由表改成"按域描述"（如「插件域→你的插件开发预设」），由使用者自己填
- **域关键词** → 只留通用词（多文件 / 多插件 / 多工况 / 多章节 / 多数据源 / 多个独立验证角度），把本机专属词（你所在行业 / 项目的专有名词）删掉或注释掉
- **profile 名** → 参数化，默认 `"desktop"`，允许配置覆盖

> ⚠️ 还有一件容易被忽略的：**验收脚本不一定在发布包里**。写文档时如果引用了测试脚本（如 `test/gate-maxparallel.test.mjs`），请确认它真的随包发布（该文件现在已随仓库提供，但**只进 git、不进 npm 包** —— `package.json` 的 `files` 白名单不含 `test/`），否则别人"读完能懂、跑不起来"。

### Step 7 · 本机配置层（不随包发布）

> 从 v0.3.2 起，本机专属内容**不再写在代码里**，改为运行时从插件包外的一个文件读。

插件里有一类值永远不该进包：**预设 id 列表、业务域关键词、profile 名**。写死在代码里，一推 GitHub 就把本机环境泄了。

从 v0.3.2 起，这些值改由运行时从下面这个文件读：

```text
<DSH_HOME>/team-orchestrator.local.json
# 例：~/.dsh/team-orchestrator.local.json
```

**为什么这样安全**：该文件在 `~/.dsh/` 下，**不在插件目录**，所以 `npm pack`（按 `files` 白名单打包）和 `git push`（按仓库结构上传）**在结构上就打不进去**——不是靠人记得脱敏，是靠位置天然隔离。

**优先级（高 → 低，上层没有才往下落）**：

| 顺序 | 来源 | 用途 |
|---|---|---|
| 1 | 环境变量 | 临时覆盖、调试、CI |
| 2 | `local.json` | **本机真实配置**（私密，不发布） |
| 3 | 插件包内 `cordis.patch.yml` 的 config | 公开默认配置 |
| 4 | 代码默认值 | 通用兜底（任何环境都能跑起来） |

**热重载**：

- 改 `local.json` → **不需要重启 DSH**：下次工具调用会检测文件 mtime 变化并重读，改完即生效。
- ⚠️ 唯一的例外是 `presetRoutes`：它除了参与运行时判定，还会拼进**注入给模型的规则文本**，而注入段是**启动时求值**的——想让它立刻反映到注入文本里，仍需彻底退出重启。
- 改代码（`lib/index.js` 等）→ 必须**彻底退出 DSH 客户端再启动**（宿主是 Node 进程，没有热重载）。

**文件不存在时**：自动回落到通用默认值，**不报错、不阻塞**——公开版（GitHub / npm 用户）就是这个状态，装完即用。

字段说明见 `docs/local-config.md`，示例见 `docs/local-config.example.json`。

**哪些值归 `local.json`、哪些留在代码里**：

| 归 `local.json`（私密，不发布） | 留在代码（公开，通用） |
|---|---|
| 预设 id 列表（本机实际能用的 `agent_preset` 枚举值） | 预设缺失时的通用兜底与降级路径（`spawn_teammate`） |
| 业务域关键词（自定义项目名 / 罐型 / 工况代号等本机词） | 通用域关键词（插件、DSH、预设、多文件、多工况…） |
| profile 名（本机在用的 profile） | `readProfileBundles()` 的默认回退逻辑 |
| 本机插件清单与安装路径 | 工具名分类表、硬门规则、注入文案 |

一句话：**代码只留「任何环境都成立」的通用值，本机值全部外置到 `~/.dsh/` 下。**

## 8. 验收清单（可打印对照）

- [ ] 团队组合包已启用，`bundles` 里只有一个团队条目
- [ ] 硬门判定**只认** `subagent` / `subagent_fork` / `spawn_teammate`
- [ ] `team_task_create` 在**豁免名单**里（永不拦），但**不在**过关判定里
- [ ] 配额 = 4，拒绝理由回显「第 N / 4 次」
- [ ] 子代理会话直接放行（无死锁）
- [ ] 所有判定路径 try/catch → fail-open
- [ ] 任务板闭环：建板 → claim → reassign → complete
- [ ] 每轮开头收口上轮遗留 pending
- [ ] 单步任务 / 多子任务 / 反向验证 三种测试都过
- [ ] 状态路由可查最近拦截记录

---

## 8.5 失败模式目录（症状 → 根因 → 修法）

这张表是全套实现里最容易踩的 13 个坑，按"症状"查最快：

| 症状 | 根因 | 修法 |
|---|---|---|
| 任务板一直涨，子代理 0 个 | 过关条件里含 `team_task_create` | 从判定表剔除，**只认派活通道** |
| 被拦后模型硬扛、就是不去派活 | 配额太小（1~2 次） | 提到 **4**，并在理由里回显「第 N / 4 次」 |
| 子代理会话 `read` 被拦、无法自救 | 没做子代理放行 | `session.header.parentSession` 有值 → **直接放行** |
| 每个会话只拦第一次，之后全过 | 用 `payload.turn` 判 turn，但它不递增 | 改为**新用户消息时重置计数**（`agent/inbox/claimed`） |
| 子代理回报被当成用户命令拦下 | 回报文本含域关键词 | `looksLikeReport`：命中 ≥2 个回报标记（`回报`/`EXIT=`/`已完成`/`SHA256`…）则不判域 |
| 用"工具集探测"判有没有团队工具 | 子代理被判"有"、lead 被判"无"，**两个方向都错** | 改用 `session.header.parentSession` 判会话类型 |
| `claim` 传了 owner 却没生效 | `claim` **忽略 owner 参数** | 再发一次 `reassign` |
| `reassign` 到 subagent id 报 `MEMBER_NOT_FOUND` | subagent **不在花名册** | owner 记 Lead + 描述里注明「实际执行者=…」 |
| `write_scopes` 传绝对路径，任务建不成 | 只接受**工作区相对路径** | 用相对路径，或留空 + 路径写进 `description` |
| 派「当前会话自己的预设」报 `INVALID_ARGS` | 枚举**排除自身** | 降级 `spawn_teammate` 并写明原因 |
| 状态页看不到团队挂载状态 | profile 名写死 | 参数化 profile 名 |
| 会话跑到后面 `spawn_teammate` 报成员上限 | `maxMembers` 是**累计创建数**（含创建失败的），inactive 成员**不释放名额**；**官方默认 16，本机 1.1.2 起也设 16**（1.1.1 及更早实测 8；以实际报错为准） | 建前先 `list_agents`，有职责匹配的 inactive 成员就 `send_message` 复用；一次性活用 `subagent`（见 §5.4） |
| 想让某个 subagent 接新任务，`send_message` 或 `reassign` 报 `TEAM_MEMBER_NOT_FOUND` | subagent **不在花名册**、不是持久成员 | subagent 是一次性的，要复用就改用 `spawn_teammate` 创建持久成员 |

> 一句总教训：**豁免名单防的是「工具有但被拦」，防不了「工具压根不存在」。**
> 凡是要求"先做 X 才能做 Y"的闸门，都必须先确认「X 在这个会话里做得到吗」。

## 9. 已知边界（改不掉的，别白费劲）

| 边界 | 原因 | 变通 |
|---|---|---|
| **团队成员不能指定预设** | `spawn_teammate` 的 schema 只有 `name / description / prompt / context` | 要按预设分工就用 `subagent(agent_preset=...)`；要常驻就用 `spawn_teammate`，二者按 §5.1 选 |
| **subagent 不进花名册** | 官方设计：subagent 是一次性委派，不是持久成员 | 任务板 owner 记 Lead + 描述里注明实际执行者 |
| **任务板不会自动释放 owner** | 官方设计：状态由模型显式推进 | 每轮开头主动收口 |
| **面板只读** | UI 不提供修改控件 | 任务只能由模型用工具改 |
| **配额用完会强制放行** | 防死锁的必要兜底 | 靠"拒绝理由回显次数"让模型主动配合，而不是靠无限拦 |

---

## 9.5 成本与取舍：什么时候该关掉它

| 项 | 数值 |
|---|---|
| 注入成本 | 约 **3848 字符 / 轮**（模板本体 3709；替换本机 8 条预设路由与 `@@MAXPAR@@` 并行上限占位后 3846（上限 6）~3848（上限 10），本机配 `gateMaxParallel: 10` 故实际 3848；每轮、每个会话都发，是永久 token 成本） |
| 误伤成本 | 单步任务被拦 1 次（多数模型第一次被拦就改派）；最坏 4 次 |
| 运行成本 | 零写入、零 spawn、零联网、零遥测；只有一条**本机回环**状态路由 |

**该关掉注入（`injectLaw: false`）**：
- 纯短会话（一问一答，没有多步任务）
- 上下文预算极紧
- 只想要硬门、不想要规则（可以只关注入，保留 `enforceTeamGate: true`）

**该保留**：
- 长任务、多文件、多工况
- 团队协作频繁
- 需要「不靠自觉」的强制约束

> 硬门可以单独关（`enforceTeamGate: false`），注入也可以单独关。两者解耦，按需组合。

## 10. 一页速记

```
工具在线 ≠ 会用
硬门只认真派活（subagent / spawn_teammate），建任务板不算
配额 4，理由带「第 N / 4 次」
建板 → claim → reassign → 派活 → complete
claim 改不了 owner，reassign 才行
subagent 不在花名册，owner 记 Lead + 注明执行者
write_scopes 只收相对路径，绝对路径写进 description
预设枚举排除自身 → 降级 spawn_teammate 并说明
子代理会话必须放行，否则死锁
所有路径 fail-open
```

---

> 本文与具体产品版本解耦：机制描述对应官方 Agent Teams 四包 + 一层自研硬门。
> 若上游改动了 `claim` / `reassign` / 枚举行为，请回来同步 §4 那张表，否则它会变成新的过期口径。
