# 本机专属配置：team-orchestrator.local.json

## 1. 这是什么

`team-orchestrator.local.json` 是**放在插件包之外**的纯 JSON 配置，承载三类内容：① 三个本机专属字段 —— 预设路由表（`presetRoutes`）、追加领域关键词（`domainKeywords`）、profile 名称（`profileName`）；② **两个硬门档位字段** —— `tier` 与 `customValues`（第 4.2 节）；③ **6 个可直接覆盖命名档的行为键** —— `gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `spawnReuseGate` / `enforceTeamGate`（这 6 个键写在 `customValues` **对象内**，写顶层无效；第 4.2 节）。

为什么非要独立成文件：

- **安全边界**：它住在 DSH 主目录（`~/.dsh/`）下，不在插件发布目录里，所以 `npm pack` 打不进、`git push` 推不走，本机预设名与内部术语不会外泄。
- **升级不丢、随时可撤**：插件升级只替换包内文件，包外配置原样保留；删掉或改名即回通用默认，零风险。

## 2. 放在哪

文件名固定为 `team-orchestrator.local.json`，位置是 DSH 主目录 `<DSH_HOME>` 的根：

```text
Windows : %USERPROFILE%\.dsh\team-orchestrator.local.json
macOS   : $HOME/.dsh/team-orchestrator.local.json
Linux   : $HOME/.dsh/team-orchestrator.local.json
```

若设置了环境变量 `DSH_HOME`，主目录以它为准，配置文件跟着走：

```sh
# 实际读取：$DSH_HOME/team-orchestrator.local.json
export DSH_HOME=/path/to/your/dsh-home
```

## 3. 三个字段逐个说明

### 3.1 `presetRoutes`：域标签 → 预设

| 项 | 说明 |
| --- | --- |
| 类型 | 对象；键是域标签（任意字符串），值是该预设的 `config.id`（字符串） |
| 示例 | `{"插件开发": "my-plugin-agent", "数据处理": "my-data-agent"}` |
| 不填 | 只用通用路由表，按内置域分派 |
| 填错 | 整体不是对象、键或值不是字符串 → 该组回退通用默认并记一条告警；值写成预设**显示名**而非 `config.id` → 结构合法但不生效（见第 8 节） |

### 3.2 `domainKeywords`：域 → 追加关键词

| 项 | 说明 |
| --- | --- |
| 类型 | 对象；键限定为 `fluent` / `plugin` / `dsh` / `preset`，值是字符串数组 |
| 示例 | `{"plugin": ["my-plugin-sdk"], "dsh": ["my-harness"], "fluent": ["my-cfd-tool"]}` |
| 不填 | 只用内置通用关键词 |
| 填错 | 值不是数组、数组里混入非字符串、键不在允许集合内 → 非法条目被忽略（严重时整组回退），并记一条告警 |

这些词是**追加**语义：内置通用关键词始终有效，本地词只做补充。

### 3.3 `profileName`：profile 名称

| 项 | 说明 |
| --- | --- |
| 类型 | 字符串，默认 `"desktop"` |
| 示例 | `"desktop"` |
| 用途 | 仅用于状态路由诊断输出，不改变实际加载路径 |
| 填错 | 非字符串（数字 / 布尔 / 对象）→ 回退 `"desktop"` 并记一条告警 |

## 4. 优先级：分两类字段，取值链不同

`local.json` 里的字段分两类，**走的是两条不同的链**，别混：

| 类别 | 字段 | 取值链 |
| --- | --- | --- |
| 本机专属三字段 | `presetRoutes` / `domainKeywords` / `profileName` | 见 §4.1 |
| 硬门档位两字段 + `customValues` 内的 6 个行为键 | `tier` / `customValues`；6 个行为键（`gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `spawnReuseGate` / `enforceTeamGate`）写在 `customValues` 对象内，写顶层读不到 | 见 §4.2（**会覆盖 patch `config` 的硬门参数**） |

⚠️ 1.1.x 及更早的文档写过「硬门参数写进 `local.json` 一律不生效」—— **那句从 1.2.0 起已作废**，以 §4.2 为准。

### 4.1 三个本机专属字段的取值链

从高到低，命中即停：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 `DSH_HOME` | **只用于定位主目录**（决定去哪里找 `local.json`），它本身不携带任何字段值 |
| 2 | `team-orchestrator.local.json` | 本机专属配置，覆盖插件取值 |
| 3 | 插件包内 `cordis.patch.yml` 的 `config` | 随包分发，可被本地文件覆盖 |
| 4 | 代码默认（通用） | 兜底，永远可用 |

一句话记：**`DSH_HOME`（只定位）→ local.json → patch config → 代码默认**，且**只对上面这 3 个字段成立**。

### 4.2 硬门参数：`local.json`（`tier` / `customValues` / 6 个行为键）优先于 patch `config`

生效值由 `refreshActiveConfig()` 合成：`ACTIVE_TIER = buildActiveTier(cfg.tier, cfg.customValues)`，闸门与注入文本的数字**全部取自这一份快照**。合成前先经 `pickLocalOverride()` 把 `local.json` 的 **`customValues` 对象内**显式写出的 6 个行为键挑出来（`pickLocalOverride()` 的 `values` 实参就是 `cfg.customValues`，**顶层键读不到**），再交给 `buildActiveTier()` 覆盖档内预设（第 1 行）。优先级从高到低：

| 顺序 | 来源 | 采纳条件 |
| --- | --- | --- |
| 1 | `local.json` 的 **`customValues` 对象内**显式写出的 6 个行为键 | **覆盖下面第 2 行的命名档 preset**（只影响这 6 个键；`maxMembers` / `maxActiveSubagents` 不参与，见下方「显式键覆盖命名档」）。判定用 `hasOwnProperty`，写 `false` / `0` / `"off"` 也算「显式提供」；非法值不覆盖，也不会让整份配置失效 |
| 2 | `local.json` 的 `tier` | 取值为 `lean` / `balanced` / `turbo` 之一（大小写敏感）。命中即用档内预设，**patch `config` 里的同名值被完全忽略** |
| 3 | `local.json` 的 `customValues` | 两用：① **命名档下它就是上表第 1 行那 6 个覆盖键的容器** —— 只需写要改的几个键，`pickLocalOverride()` 逐键 `hasOwnProperty` 判定，某个键值非法只跳过它自己（保持 preset 值）；② `tier` 缺失或非法时作为**整份自定义档**解析，那时必须五项全给且都合法，**任一项非法整份作废** |
| 4 | 宿主真正加载的那份 patch `config` | 1、2、3 都没命中时生效（即 `_CONFIG_BASELINE`，与 1.1.2 行为一致） |

> **显式键覆盖命名档**（1.3.3 起，**这 6 个键写在 `customValues` 对象内，不是顶层**）：`local.json` 的 `customValues` 里**显式写出** `gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `spawnReuseGate` / `enforceTeamGate` 这 6 个行为键 → **覆盖命名档 preset**（优先级高于第 2 行的档内预设值）。判定用 `hasOwnProperty`，所以写 `false` / `0` / `"off"` 也算「显式提供」（真值判断会把 `0` 当没写）；非法值不覆盖、也不会让整份配置失效；`maxMembers` / `maxActiveSubagents` **不参与覆盖** —— 它们是宿主现读的实测值，覆盖等于拿假值压真值。
>
> 被覆盖了哪几个键，看 `/status.tiers.overriddenKeys`（只列与档位预设**实际不同**的键；`tier` 为 `custom` 时不单列）。注意 `spawnReuseGate` 的读数位置是 `parallelGate.spawnReuseGate`，不在 `tiers.values` 里（见第 8 节 Q5）。

#### 位置：这 6 个键必须写在 `customValues` 对象内

正确写法（只写要改的键即可，其余键继续用档位预设）：

```json
{
  "tier": "turbo",
  "customValues": {
    "gateMaxParallel": 12,
    "waitAgentGate": "warn"
  }
}
```

反例 —— 写在 `local.json` 顶层，**不生效、静默忽略**（不报错、不告警，`/status` 也不会变）：

```json
{
  "tier": "turbo",
  "gateMaxParallel": 12
}
```

为什么顶层读不到：生效快照的第二个实参是 `cfg.customValues` —— `lib\index.js` L766 原文

```js
ACTIVE_TIER = buildActiveTier(cfg && cfg.tier, cfg && cfg.customValues);
```

`buildActiveTier(tierName, customValues)` 里逐键取的是 `pickLocalOverride(customValues, okey)`（L337-344）；`pickLocalOverride(values, key)`（L289-314）的第一步就是 `Object.prototype.hasOwnProperty.call(values, key)`（L291）。`local.json` 顶层只有 `tier` / `customValues` / `presetRoutes` / `domainKeywords` / `profileName` 这 5 个字段会被读（`_comment` 仅供人看），**没有任何代码读顶层的行为键**。

⚠️ 别混用两种角色：`tier` 写成 `"custom"` 时读的是**同一个** `customValues`，但那时走 `validateCustomValues()`（L255-277）整份校验、五项必填全给；只想改一两个键、其余沿用命名档 → 用 `"tier": "turbo"`（或 `lean` / `balanced`）把键写进 `customValues`，**不要**写成 `tier: "custom"` 却只给 2 个键（那会整份作废、回落代码默认）。

> **同类静默失效（同样是「位置/形态写错就不报错」）**：`presetRoutes` 必须是**数组**，写成对象会被静默忽略（`resolvePresetRoutes()` 只认 `Array.isArray`，非数组直接回落空表 → 注入文本变成「本环境未配置 presetRoutes」）；数组元素需同时给 `key` 与 `presetId`（可带 `label`，缺省用 `key` 顶替），缺任一个该条被静默丢弃。

三个命名档的实际数值（源码 `TIER_PRESETS`，`lib\index.js` L148-194）：

| 参数 | `lean` 省 Token | `balanced` 中规中矩 | `turbo` 超级高效 |
| --- | --- | --- | --- |
| `gateMinDispatches` | 1 | 2 | 3 |
| `gateMaxParallel` | 2 | 4 | **10** |
| `gateMaxStrikes` | 2 | 4 | 4 |
| `waitAgentGate` | `warn` | `warn` | `enforce` |
| `spawnReuseGate` | `warn` | `enforce` | `enforce` |
| `enforceTeamGate` | `true` | `true` | `true` |
| `maxMembers` | 4 | 8 | 16 |
| `maxActiveSubagents` | 8 | 16 | 32 |

`customValues` 的合法区间（`validateCustomValues()`，`lib\index.js` L255-277）：

| 键 | 合法值 | 说明 |
| --- | --- | --- |
| `gateMinDispatches` | 1 ~ 6 | 必填 |
| `gateMaxParallel` | 2 ~ 16 | 必填 |
| `gateMaxStrikes` | 0 ~ 10 | 必填 |
| `waitAgentGate` | `"warn"` \| `"enforce"` | 必填 |
| `enforceTeamGate` | `"on"` \| `"off"`（也认 `true` / `false` / `1` / `0`） | 必填 |
| `spawnReuseGate` | `"warn"` \| `"off"` | **可选**；缺失或非法静默回落 `"enforce"`，不会让整份配置作废 |

### 4.3 patch `config` 的 7 个键

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `injectLaw` | boolean | `true` | 是否注册常驻注入段 |
| `enforceTeamGate` | boolean | `true` | 是否挂工具层硬门 |
| `gateMinDispatches` | number ≥ 0 | `1` | 基础门槛要求派活数；`0` = 关掉基础门槛 |
| `gateMaxParallel` | number 2~16 | `6` | 并行契约封顶路数 |
| `gateMaxStrikes` | number ≥ 0 | `4` | 每会话每轮最多拦截次数；`0` = 永不拦截 |
| `waitAgentGate` | `"warn"` / `"enforce"` | `"warn"` | `wait_agent` 放行还是拦 |
| `gateDomains` | string[] | `["fluent","plugin","dsh","preset"]` | 参与硬门的域 |

⚠️ 这 7 个键**只从宿主真正加载的那份 patch `config` 读**（经聚合包挂载时是母包那条 entry，直接安装时才是插件自己那份，见 README「参数从哪来」节）；`gateDomains` 与 `injectLaw` 不受档位影响。

但 `gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `spawnReuseGate` / `enforceTeamGate` 这 6 个行为键会被 §4.2 的档位链**顶掉** —— 这是最容易踩的坑：`local.json` 里写着 `tier: "turbo"` 时，无论 patch `config` 写 `gateMaxParallel: 6` 还是 `10`，实际都用 **10**；反过来，在 `local.json` 的 `customValues` 对象内显式写 `gateMaxParallel` 又能把这个 10 再改掉（写顶层不算，见 §4.2「位置」小节）。改硬门参数前先看 `local.json` 有没有 `tier`、有没有显式写这 6 个键。

推荐改法：**要动硬门就在 `local.json` 的 `customValues` 对象内直接写这 6 个键**（显式提供即覆盖命名档，不必切档；写顶层无效），例如 `{"tier": "turbo", "customValues": {"gateMaxParallel": 12}}`；想整档换风格时再切 `tier`，或把 `tier` 写成 `"custom"` 并给全 `customValues`（五项必填）。这三条都按 mtime 热重载，下次工具调用即生效，不用重启。只有落到 §4.3 的 patch `config` 时才需要**彻底退出 DSH 再启动**（宿主侧无热重载）。

## 5. 热重载

- **改 `local.json` 不用重启 DSH**：下次工具调用会比对文件 mtime，发现变化就重新读取。
- **改代码必须彻底退出重启**：`lib/`、`package.json`、`cordis.patch.yml` 属宿主侧，没有热重载，只能完全退出客户端再启动。

验证方法（不重启、不改代码）：

```text
1. 在 domainKeywords 里加一个只有你会用、且不会误触发的词
2. 保存文件，不做任何重启动作
3. 在对话里发一句含该新词的话，触发一次工具调用
4. 看路由是否按新词生效；没变化时先确认改的是 DSH_HOME 下那份
```

## 6. 容错行为

配置文件**永远不是启动阻塞项**：

| 情况 | 行为 |
| --- | --- |
| 文件不存在 | 静默使用通用默认，不告警 |
| JSON 语法错误 | 整份忽略，回退通用默认，只记一条告警 |
| 字段类型不对 | 该组回退通用默认，其它组照常生效，只记一条告警 |
| 未知字段 | 忽略该字段，不影响其它配置 |

原则：**回退默认 + 一条告警，绝不报错、绝不阻塞**。

## 7. 最小示例

把下面整份内容复制到第 2 节给出的路径即可（`presetRoutes` 必须是**数组**，元素需带 `key` 与 `presetId`；写成对象会被 `resolvePresetRoutes()` 静默丢弃 → 回退「未配置 presetRoutes」）：

```json
{
  "_comment": "本机专属配置示例",
  "presetRoutes": [
    { "key": "插件开发", "label": "插件开发", "presetId": "my-plugin-agent" }
  ],
  "domainKeywords": {
    "plugin": ["my-plugin-sdk"]
  },
  "profileName": "desktop",
  "tier": "balanced"
}
```

只想微调某个硬门参数时，再加一个 `customValues` 对象（只写要改的键，其余沿用档位预设）：

```json
{
  "tier": "balanced",
  "customValues": { "gateMaxParallel": 8 }
}
```

## 8. 常见问题

**Q1：填了 `presetRoutes` 但没生效？**
先确认值写的是预设的 `config.id`，不是界面显示名——两者常常不同。拿到 id 后再逐字符核对（大小写、连字符、首尾空格都算不同）。

**Q2：想临时关掉本地覆盖，又不想删文件？**
把文件改名（如加 `.bak` 后缀）即可，下次工具调用就回退到 patch config / 代码默认；改回来立刻恢复。

**Q3：说 JSON 解析失败，但我看着没写错？**
常见原因是尾随逗号、缺引号、单引号或 `//` 注释（JSON 不支持注释）。过一遍 JSON 校验器即可定位。

**Q4：改了 `domainKeywords`，关键词好像没效果？**
确认键名在允许集合内（`fluent` / `plugin` / `dsh` / `preset`），值是字符串数组；这些词只做追加，不替换内置通用关键词。

**Q5：改了 patch `config` 的 `gateMaxParallel`，但 `/status` 显示的不是我写的值？**
先看 `local.json` 有没有 `tier`。有的话档位预设优先级更高，patch `config` 的同名值被完全忽略（§4.2）。要改就在 `local.json` 的 **`customValues` 对象内**直接显式写这 6 个行为键（`gateMinDispatches` / `gateMaxParallel` / `gateMaxStrikes` / `waitAgentGate` / `spawnReuseGate` / `enforceTeamGate`）—— **写在顶层会被静默忽略**（见 §4.2「位置」小节）；写在 `customValues` 内即显式提供、覆盖命名档，不必切档；也可以切 `tier`，或把 `tier` 写成 `"custom"` 并给全 `customValues`。都按 mtime 热重载，下次工具调用即生效，不用重启。
想确认到底被覆盖了哪几个键，看 `/status.tiers.overriddenKeys`（只列与档位预设**实际不同**的键；`tier` 为 `custom` 时不单列）。
⚠️ 看值时注意位置：`/status.tiers.values` 只列 5 个键，**不含 `spawnReuseGate`** —— 它挂在 **`parallelGate.spawnReuseGate`**。这不是 bug，两个接口职责不同（`tiers.values` 只给档位表内的数值键，`spawnReuseGate` 是 `parallelGate` 这组闸门的成员），但照 `tiers.values` 找会找不到。

## 9. 安全提醒

- 文件里可能写着内部预设名与私有术语，**永远不要提交到 git**；也不要为「方便」在插件目录或示例目录放副本（插件仓库已把它排除在包外）。
- 若 DSH 主目录被纳入某个仓库，请把它写进 `.gitignore`：

```sh
# .gitignore
team-orchestrator.local.json
```
