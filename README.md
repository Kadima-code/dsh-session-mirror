# dsh-session-mirror

> English: [README.en.md](README.en.md)

一个纯 host 的 DSH（DeepSeek Harness）插件：把**每个对话各自备份成一份最新文件**，支持按需**恢复**、按规则**清理**，并在源被删除时**保留备份防误删**。

- 版本：`0.1.0` · 许可：BSD-3-Clause
- 形态：纯 host、零外部依赖（只用 Node 内置模块），无浏览器半 —— 不会崩应用
- 默认备份目录：`E:\DshChatBackup`

---

## 它管哪几件事

1. **增量备份**：启动 / 每轮对话结束 / 关闭时自动备份；没变化的不重复拷，改了先拷临时文件、校验完整再原子替换。
2. **主 / 子识别 + 两份人读索引**：《对话总览.md》目录树、《对话清单.md/html》详表（状态、主/子、对话长度、开启/结束/归档/删除时间、到期）。
3. **一键恢复**：支持会话 ID 前缀、标题关键字、甚至只记得标题里跳着的几个字；先预览，`加 yes` 才真恢复。
4. **清理与到期回收站**：手动清理子对话备份；可选「到期自动清理」——到期先进回收站，留 7 天再真删。
5. **安全兜底**：只动备份不动原文件；坏帧绝不覆盖好文件；自动清理默认关闭。

---

## 快速开始（安装）

本插件是标准 bundle 插件，安装 = 包落地 + profile 登记 + **完全重启 DSH**。

### 方式一：npm（发布后）

```bash
npm i @dsh-external/dsh-session-mirror
```

随后在 `~/.dsh/profiles/desktop/package.json` 登记（见下方「profile 登记」）。

### 方式二：Release zip

把 zip 解压到 `~/.dsh/_plugins/dsh-session-mirror`，再按下方登记。

### 方式三：本地目录 link

`dependencies` 里写 `"@dsh-external/dsh-session-mirror": "link:<插件目录绝对路径>"`。

### profile 登记（`~/.dsh/profiles/desktop/package.json`）

```jsonc
{
  "dependencies": {
    "@dsh-external/dsh-session-mirror": "link:C:/Users/<你>/.dsh/_plugins/dsh-session-mirror"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它…
        "@dsh-external/dsh-session-mirror"
      ]
    }
  }
}
```

> ⚠️ **改完必须「完全退出 DSH」再启动**（关掉应用进程，不只是按 Ctrl+R 刷新页面）。插件代码是宿主侧加载，Ctrl+R 只换前端，不会加载新插件代码。

本包自带 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 指向），加载器会自动挂载。

---

## 功能详解

### 1）备份

**自动触发**：DSH 启动后约 8 秒、每轮对话结束（去抖 8 秒）、DSH 关闭时各跑一次。没有固定定时周期。

**增量规则**：按「文件大小 + 最后修改时间」判断——没有备份就全拷一份；已备份但没变化就跳过；有变化才重新拷贝。

**可靠性**：每次先拷到临时文件 → 校验 zstd 帧完整 → 才原子替换正式文件。因此**永远不会用半个文件盖掉好文件**。

**防误删**：源里已删除的会话，备份**保留**并标记 `orphaned`（已删除）。

**手动补一次**：对话里说「备份一下」，或用「+ → 指令」菜单 `mirror-backup`。

### 2）主 / 子识别与两份索引

每个会话文件第一行是 `session` 头，含 `origin` / `parentSession` / `delegationDepth`。判定为**子对话**：`origin === 'subagent'` 或含 `parentSession` 或 `delegationDepth > 0`；否则为**主对话**。

插件在备份目录生成两份人读索引：

- **《对话总览.md》**：工作区 → 主对话 → 子对话 的目录树，附标题、时间、大小、备份路径，标出 活跃 / 归档 / 已删除 / 置顶；子对话用 🧹 标「少用·可清理」。
- **《对话清单.md》**（另出 `对话清单.html` 网页版）：13 列表格 —— 名字、状态、主/子、对话长度、大小、开启时间、结束时间、归档时间、删除时间、到期、备份时间、ID、工作区。

**对话长度**是复合指标：文件大小 + 我发消息条数 + AI 回复条数 + 最后活动时间/存活时长。超过 2MB 的大会话只解最后一帧取「最后活动时间」，避免逐条精算拖慢。

> 说明：开启/结束时间取自会话自带记录，**准确**；归档时间/删除时间只能是「插件第一次检测到」的时刻（DSH 本身不保存这两个时间），可能比你实际操作晚几分钟。

### 3）恢复

**三种入口**：

- **对话里说**：「恢复对话：<标题里的字/词 或 ID 前缀>」
- **「+ → 指令」菜单**：`mirror-restore <字/词 或 ID>` → 先预览；`mirror-restore <字/词 或 ID> yes` → 真恢复
- **命令行**：`node tools/restore.mjs`（交互式）/ `--list` 只列可恢复的已删除主对话 / `<查询> --yes`；也可双击 `tools\一键恢复.bat`

**模糊匹配**：支持标题包含、跳字子序列（如「诗技」能对上「古诗词…技能」）、ID 前缀。命中唯一才自动选中；命中多个会把候选（名字·状态·ID 前 8 位）列出来让你再补字或报 ID，**绝不乱猜**。

**恢复做什么**：把该会话的备份文件拷回 `~/.dsh/sessions/<工作区>/<会话ID>/`，并把会话 id 回填到 `~/.dsh/storages/workspace.json` 对应工作区（若原为归档状态会自动取消归档）。回 DSH 按 F5 即可见。

**安全**：默认先预览（dryRun）；目标已存在不覆盖、只补登记。

### 4）清理与到期回收站

**手动清理子对话备份**：

- 对话里说「清理子对话备份」或菜单 `mirror-clean`（默认只预览，列出要清理的清单）
- 确认执行：菜单 `mirror-clean yes`，或命令行 `node tools/clean.mjs --yes`
- 清掉的会话 id 记入 `_mirror-clean-skip.json`，以后不再重新备份

**到期自动清理（默认关闭）**：打开后会按以下规则把到期的备份**先移入 `_回收站/`，再留 7 天**，之后才真删。

| 对象 | 规则 |
|---|---|
| 活跃的主对话 | **永不自动删** |
| 子代理 | 「子代理最后结束时间 距 主对话最后结束时间 > 3 天」才清（参照是主对话，不是当前时间） |
| 子代理（父主对话已被删除） | 父删日 + 7 天，取更早者 |
| 已删除的主对话 | 留 30 天（该条规则为可选项，默认未启用） |
| 归档的会话 | 不动 |
| 置顶 / 收藏 | 不参与判断（判断只看标记） |

开关：存在文件 `_mirror-autoclean.on`，或配置 `autoClean: true`。关闭状态下**只做标记与统计，绝不删除任何东西（回收站也不动）**。

### 5）安全与已知限制

- **只动备份，不碰原文件**：所有删除都发生在 `E:\DshChatBackup` 内。
- **坏帧保护**：拷贝前校验 zstd 帧完整性，不合格的副本会被丢弃并保留旧副本。
- **两阶段删除**：到期先进 `_回收站`，留 7 天再真删，中途可反悔捞回。
- **自动清理默认关闭**：需你显式开启才执行。
- **已知限制**：
  - 归档时间 / 删除时间是「插件第一次检测到」的时刻，不是精确操作时间；
  - 大文件（>2MB）的对话长度只按最后活动时间近似；
  - DSH 内核升级后，建议先跑一次回归（备份 / 恢复 / 清理各一次）再长期使用；
  - 子对话备份清理后，若源仍在，会记入 skip 名单不再备份（避免反复备份-清理）。

---

## 配置（profile 层传 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后插件不执行任何备份 |
| `dest` | `E:\DshChatBackup` | 备份根目录 |
| `verbose` | `false` | 是否在日志里输出每份明细 |
| `autoClean` | `false` | 是否开启到期自动清理（也可用 `_mirror-autoclean.on` 开关） |

---

## 备份目录里有哪些东西

```
E:\DshChatBackup\
  sessions\                每个对话的备份，目录结构与 ~/.dsh/sessions 一致
  _mirror-state.json       每份备份的状态（大小/时间/主或子/标题/是否已删除/指标）
  _mirror.log              每次运行记录（超 5MB 自动轮转为 _mirror.log.1）
  怎么恢复.txt             中文恢复说明（首次运行写入）
  对话总览.md              人读目录树
  对话清单.md / .html      人读详表（13 列）
  待清理子代理名单.html/txt  清理预览清单
  子对话清理对照表.html    全部子对话 vs 符合规则的红黑对照
  _回收站\                 到期备份先进这里，留 7 天再真删（含 _manifest.json）
  _mirror-autoclean.on     自动清理开关（存在=开）
  _mirror-clean-skip.json  已清理、不再重新备份的会话 id
```

---

## 命令与工具速查

| 场景 | 对话工具 | 「+ → 指令」菜单 | 命令行 |
|---|---|---|---|
| 立即备份 | `session_mirror_now` | `mirror-backup` | — |
| 恢复 | `session_mirror_restore` | `mirror-restore <查询> [yes]` | `tools/restore.mjs` |
| 清理子对话 | `session_mirror_clean` | `mirror-clean [yes]` | `tools/clean.mjs [--yes]` |
| 查看到期 | — | — | `tools/clean.mjs --expiring` |
| 自动清理开关 | — | — | `tools/clean.mjs --auto-on` / `--auto-off` |
| 清空回收站(超7天) | — | — | `tools/clean.mjs --purge` |

> 「+ 菜单」命令名只能是英文小写；需要参数的命令在命令后跟参数即可（如 `/mirror-restore 作图`）。

---

## 开发说明

- 纯 host ESM，零外部依赖，无需构建；`lib/index.js` 即全部逻辑。
- 依赖 DSH 的两个契约：`ctx.tools.register(spec): Promise<void>`；`ctx.get('commands').register({name, description, handler})`，其中 **handler 必须返回 `CommandResult` 对象 `{kind:'success'|'error', text}`**（返回裸字符串会报错）。

---

## License

BSD-3-Clause。见 [LICENSE](LICENSE)。
