# dsh-session-mirror

> 中文: [README.md](README.md)

A pure-host plugin for DSH (DeepSeek Harness) that **keeps one up-to-date backup file per conversation**, with on-demand **restore**, rule-based **cleanup**, and **protection against accidental deletion** (backups of deleted sessions are kept).

- Version: `0.1.0` · License: BSD-3-Clause
- Shape: pure host, zero external dependencies (Node built-ins only), no browser half — it cannot crash the UI
- Default backup directory: `E:\DshChatBackup`

---

## What it does

1. **Incremental backup** — runs on startup, after each turn, and on shutdown; unchanged files are skipped; a changed file is copied to a temp file, frame-validated, then atomically replaced.
2. **Main/sub conversation awareness + two human-readable indexes** — a tree (`对话总览.md`) and a detailed table (`对话清单.md` / `.html`) with status, main/sub, conversation length, timestamps and expiry.
3. **One-click restore** — accepts an ID prefix, a title word, or even a few scattered characters of the title; preview first, `yes` to actually restore.
4. **Cleanup with a recycle bin** — manual sub-conversation cleanup, plus an optional scheduled cleanup that moves expired backups to a recycle bin for 7 days before hard delete.
5. **Safety** — only backups are touched, never originals; a corrupt frame never overwrites a good file; scheduled cleanup is off by default.

---

## Install

This is a standard DSH bundle: place the package, register it in the profile, then **fully restart DSH**.

### Option 1: npm (once published)

```bash
npm i @dsh-external/dsh-session-mirror
```

Then register it in `~/.dsh/profiles/desktop/package.json` (see below).

### Option 2: Release zip

Unzip into `~/.dsh/_plugins/dsh-session-mirror`, then register it.

### Option 3: local link

Use `"@dsh-external/dsh-session-mirror": "link:<absolute path>"` in `dependencies`.

### Profile registration (`~/.dsh/profiles/desktop/package.json`)

```jsonc
{
  "dependencies": {
    "@dsh-external/dsh-session-mirror": "link:C:/Users/<you>/.dsh/_plugins/dsh-session-mirror"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …
        "@dsh-external/dsh-session-mirror"
      ]
    }
  }
}
```

> ⚠️ **Fully quit DSH and start it again** after changing this (not just Ctrl+R). Plugins load on the host side; Ctrl+R only reloads the UI.

The package ships `cordis.patch.yml` (referenced by `dsh.bundle.patch`), which the loader mounts automatically.

---

## Features

### 1) Backup

**Triggers**: ~8s after startup, after each turn (debounced 8s), and on DSH shutdown. No fixed interval.

**Incremental**: compares file size + mtime — full copy if never backed up, skip if unchanged, re-copy only if changed.

**Reliability**: copy to a temp file → validate the zstd frame → atomic rename. An incomplete file can never overwrite a good one.

**Deleted source**: the backup is **kept** and marked `orphaned`.

**Manual run**: say “备份一下”, or use the `mirror-backup` command from the “+” menu.

### 2) Main/sub detection and two indexes

Each session file starts with a `session` header containing `origin` / `parentSession` / `delegationDepth`. A session is a **sub** conversation when `origin === 'subagent'`, or it has `parentSession`, or `delegationDepth > 0`; otherwise it is a **main** conversation.

Two indexes are generated in the backup directory:

- `对话总览.md` — a tree (workspace → main → sub) with title, time, size, path, and status (active / archived / deleted / pinned); sub conversations are marked 🧹 “low-use · cleanable”.
- `对话清单.md` (plus `对话清单.html`) — a 13-column table: name, status, main/sub, conversation length, size, start/end/archived/deleted times, expiry, backup time, ID, workspace.

**Conversation length** is a composite metric: file size + user message count + assistant reply count + last-activity time / lifespan. Sessions over 2 MB only decode the last frame to get the last-activity time.

> Note: start/end times are accurate (from the session log). Archived/deleted times are the moment the plugin **first detected** them — DSH does not store those timestamps.

### 3) Restore

**Three entry points**:

- In chat: “恢复对话：<title word or ID prefix>”
- “+” menu command: `mirror-restore <query>` → preview; `mirror-restore <query> yes` → restore
- CLI: `node tools/restore.mjs` (interactive) / `--list` / `<query> --yes`; or double-click `tools\一键恢复.bat`

**Fuzzy matching**: title substring, character subsequence (e.g. “诗技” matches “古诗词…技能”), or ID prefix. A unique match is chosen automatically; multiple matches are listed (name · status · first 8 chars of ID) so you can narrow it down. It never guesses.

**What restore does**: copies the backup back to `~/.dsh/sessions/<workspace>/<sessionId>/` and re-registers the ID in `~/.dsh/storages/workspace.json` (un-archiving automatically if needed). Press F5 in DSH to see it.

**Safety**: preview by default; never overwrites an existing file.

### 4) Cleanup and recycle bin

**Manual sub-conversation cleanup**:

- `mirror-clean` in the “+” menu (preview only), or say “清理子对话备份”
- Execute: `mirror-clean yes`, or `node tools/clean.mjs --yes`
- Cleaned IDs are recorded in `_mirror-clean-skip.json` so they are not backed up again

**Scheduled cleanup (off by default)**: when enabled, expired backups are **moved into `_回收站/` first**, kept 7 days, then hard-deleted.

| Target | Rule |
|---|---|
| Active main conversation | **never auto-deleted** |
| Sub-agent | deleted when “sub's last end time is more than 3 days before the main conversation's last end time” |
| Sub-agent whose parent main was deleted | parent deletion + 7 days (earlier wins) |
| Deleted main conversation | 30 days (optional rule, disabled by default) |
| Archived session | never touched |
| Pinned / bookmarked | irrelevant (decision is based on status marks only) |

Enable with the `_mirror-autoclean.on` marker file or `autoClean: true`. When off, it only marks and reports — **it deletes nothing, not even from the recycle bin**.

### 5) Safety and known limitations

- **Backups only** — all deletions happen inside `E:\DshChatBackup`.
- **Corrupt-frame guard** — each copy is frame-validated before replacing; a bad copy is discarded and the previous one kept.
- **Two-stage delete** — expired items go to the recycle bin for 7 days first.
- **Scheduled cleanup off by default** — must be enabled explicitly.
- **Known limitations**:
  - Archived/deleted times are detection times, not exact operation times;
  - Large sessions (>2 MB) approximate conversation length using last-activity time only;
  - After a DSH core upgrade, run a quick regression (backup / restore / cleanup) before relying on it;
  - Once a sub-conversation backup is cleaned, its ID goes on the skip list so it will not be re-backed up.

---

## Configuration (profile config)

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Disable to stop all backups |
| `dest` | `E:\DshChatBackup` | Backup root |
| `verbose` | `false` | Log per-file details |
| `autoClean` | `false` | Enable scheduled cleanup (or use `_mirror-autoclean.on`) |

---

## Backup directory layout

```
E:\DshChatBackup\
  sessions\                one file per conversation, same structure as ~/.dsh/sessions
  _mirror-state.json       state per backup (size/time/main-or-sub/title/orphaned/metrics)
  _mirror.log              run log (rotated to _mirror.log.1 above 5 MB)
  怎么恢复.txt             Chinese restore notes (written on first run)
  对话总览.md              human-readable tree
  对话清单.md / .html      human-readable 13-column table
  待清理子代理名单.html/txt  cleanup preview list
  子对话清理对照表.html     all sub-conversations vs rule-matching ones
  _回收站\                 expired backups kept 7 days before hard delete (+ _manifest.json)
  _mirror-autoclean.on     scheduled-cleanup switch (exists = on)
  _mirror-clean-skip.json  IDs that were cleaned and should not be re-backed up
```

---

## Command / tool cheat sheet

| Task | Chat tool | “+” menu | CLI |
|---|---|---|---|
| Back up now | `session_mirror_now` | `mirror-backup` | — |
| Restore | `session_mirror_restore` | `mirror-restore <query> [yes]` | `tools/restore.mjs` |
| Clean sub-conversations | `session_mirror_clean` | `mirror-clean [yes]` | `tools/clean.mjs [--yes]` |
| Show expiry | — | — | `tools/clean.mjs --expiring` |
| Toggle scheduled cleanup | — | — | `tools/clean.mjs --auto-on` / `--auto-off` |
| Purge recycle bin (>7d) | — | — | `tools/clean.mjs --purge` |

> “+” menu command names must be lowercase ASCII; append parameters after the command (e.g. `/mirror-restore 作图`).

---

## Development notes

- Pure host ESM, no external dependencies, no build step; `lib/index.js` contains all logic.
- Relies on two DSH contracts: `ctx.tools.register(spec): Promise<void>`, and `ctx.get('commands').register({name, description, handler})` where **handler must return a `CommandResult` object `{kind:'success'|'error', text}`** (returning a bare string throws).

---

## License

BSD-3-Clause. See [LICENSE](LICENSE).
