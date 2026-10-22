# @dsh-external/dsh-session-mirror

按会话逐个镜像备份 DSH 对话日志（`~/.dsh/sessions`）到指定目录：每个对话一份最新文件，未变化跳过；源里已删除的会话在备份里保留并标记 orphaned（防误删）；可区分主对话 / 子对话。

## 形态

纯 host 插件，零外依赖（只用 node 内置模块），无浏览器半 —— 不会崩应用。

## 触发

- 启动后 8s 跑一次
- 每轮对话结束（turn/end）去抖 8s 后跑一次
- DSH 关闭时跑一次

（无固定定时周期）

## 备份内容

- 目标目录默认 `E:\DshChatBackup`（可由 profile 配置 `dest` 覆盖）
- `sessions/` 目录结构与 `~/.dsh/sessions` 一致，恢复单会话只需把对应文件复制回去
- `_mirror-state.json`：每份记录 size / mtime / copiedAt / kind(main|sub) / parentSession / delegationDepth / cwd / createdAt / id / title，以及 orphaned
- `怎么恢复.txt`：中文恢复说明（首次运行写入）
- `_mirror.log`：每次运行记录
- `对话总览.md`：给人看的目录树——按「工作区 → 主对话 → 子对话」组织，附每个对话的实际显示名（标题）、时间、大小、备份路径，并标出 **活跃 / 归档 / 已删除（源已无，备份保留）/ 置顶**，方便查询

## 主 / 子对话识别

每个会话文件第一行是 `session` 头，含 `origin` / `parentSession` / `delegationDepth`。判定：`origin === 'subagent'` 或有 `parentSession` 或 `delegationDepth > 0` → 子对话，否则主对话。

## 一键恢复

两种方式：

- **对话里直接说**：「恢复会话 <标题或ID前缀>」——模型调用工具 `session_mirror_restore`（传 `dryRun: true` 可先预览）。
- **命令行**：`node tools/restore.mjs`（交互式，列出可恢复会话按序号选）；`--list` 只列已删除可恢复的；`<ID前缀或标题>` 预览；加 `--yes` 执行。也可双击 `tools/一键恢复.bat`。

恢复会把备份文件拷回 `~/.dsh/sessions/<工作区>/<会话ID>/`（若该会话是归档状态，会顺带取消归档），回 DSH 按 F5 即可见。


## 安装（标准 bundle）

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里 link 本目录（已就位）
2. 同一文件的 `dsh.profile.bundles` 里加入 `"@dsh-external/dsh-session-mirror"`
3. 重启 DSH 生效

本包自带 `cordis.patch.yml`（由 package.json 的 `dsh.bundle.patch` 指向），加载器会自动挂载。

## 配置（profile 层传 config）

- `enabled`（默认 true）
- `dest`（默认 `E:\DshChatBackup`）
- `verbose`（默认 false）
