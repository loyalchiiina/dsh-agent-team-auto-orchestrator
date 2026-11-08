# 本机专属配置：team-orchestrator.local.json

## 1. 这是什么

`team-orchestrator.local.json` 是**放在插件包之外**的纯 JSON 配置，承载三件事：预设路由表（`presetRoutes`）、追加领域关键词（`domainKeywords`）、profile 名称（`profileName`）。

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

## 4. 优先级

从高到低，命中即停：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 | 最高优先，适合临时覆盖 |
| 2 | `team-orchestrator.local.json` | 本机专属配置 |
| 3 | 插件包内 `cordis.patch.yml` 的 `config` | 随包分发，可被本地文件覆盖 |
| 4 | 代码默认（通用） | 兜底，永远可用 |

一句话记：**环境变量 > local.json > patch config > 代码默认**。

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

把下面整份内容复制到第 2 节给出的路径即可：

```json
{
  "_comment": "本机专属配置示例",
  "presetRoutes": {
    "插件开发": "my-plugin-agent"
  },
  "domainKeywords": {
    "plugin": ["my-plugin-sdk"]
  },
  "profileName": "desktop"
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

## 9. 安全提醒

- 文件里可能写着内部预设名与私有术语，**永远不要提交到 git**；也不要为「方便」在插件目录或示例目录放副本（插件仓库已把它排除在包外）。
- 若 DSH 主目录被纳入某个仓库，请把它写进 `.gitignore`：

```sh
# .gitignore
team-orchestrator.local.json
```
