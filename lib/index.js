/**
 * dsh-session-mirror —— 按会话逐个备份 DSH 对话日志
 *
 * 设计目标（用户定）：出问题的时候能直接找到并恢复。
 *
 * - 每个对话各占一份，天天刷新成最新（不是整包 tar）
 * - 源里删掉的对话，备份里那份【留着不删】—— 这才是能防误删的语义
 * - 没变化就跳过（不重复覆盖）；改了先拷到临时文件并验帧，验过才替换
 *   → 永远不会用半个文件盖掉好文件
 * - 首次运行会在备份目录里写一份中文《怎么恢复.txt》
 *
 * 零 import（只用 node 内置模块）、纯 host、无浏览器半 → 不可能崩应用。
 */
import { readdir, stat, mkdir, copyFile, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

export const name = '@dsh-external/dsh-session-mirror'
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  dest: 'E:\\DshChatBackup',
  intervalMinutes: 30,
  verbose: false,
}

const ZSTD_MAGIC = 0xfd2fb528
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/** 本地时间（北京时间）字符串。纯展示用，不参与任何判断逻辑。 */
export function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function resolveOpts(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    enabled: c.enabled !== false,
    dest: typeof c.dest === 'string' && c.dest.trim() ? c.dest.trim() : DEFAULTS.dest,
    intervalMinutes: Number.isFinite(c.intervalMinutes) && c.intervalMinutes > 0 ? c.intervalMinutes : DEFAULTS.intervalMinutes,
    verbose: c.verbose === true,
    autoClean: c.autoClean === true,
  }
}

/** 结构校验：按 zstd 帧走完整个 buffer，正好走到末尾才算完整（防拷到半个帧）。 */
export function isValidZstdFrames(buf) {
  if (!buf || buf.length < 4) return false
  if (buf.readUInt32LE(0) !== ZSTD_MAGIC) return false
  let offset = 0
  try {
    while (offset < buf.length) {
      if (buf.length - offset < 4) return false
      const magic = buf.readUInt32LE(offset)
      if ((magic & 0xFFFFFFF0) === 0x184D2A50) { // zstd skippable frame
        if (buf.length - offset < 8) return false
        offset += 8 + buf.readUInt32LE(offset + 4)
        if (offset > buf.length) return false
        continue
      }
      if (magic !== ZSTD_MAGIC) return false
      offset += 4
      const descriptor = buf.readUInt8(offset); offset += 1
      const fcsFlag = descriptor >>> 6
      const singleSegment = (descriptor & 0x20) !== 0
      const dictFlag = descriptor & 0x03
      const dictBytes = dictFlag === 3 ? 4 : dictFlag
      const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag
      offset += (singleSegment ? 0 : 1) + dictBytes + fcsBytes
      for (;;) {
        if (buf.length - offset < 3) return false
        const header = buf.readUIntLE(offset, 3); offset += 3
        const last = (header & 1) !== 0
        const btype = (header >>> 1) & 0x03
        const bsize = header >>> 3
        offset += btype === 0x01 ? 1 : bsize
        if (offset > buf.length) return false
        if (last) break
      }
      if ((descriptor & 0x04) !== 0) offset += 4
      if (offset > buf.length) return false
    }
    return offset === buf.length
  } catch {
    return false
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

/** 拷贝并对 EBUSY/EPERM/EACCES/ENOENT（源正被写/被锁）做退避重试。 */
async function copyWithRetry(src, dst, tries = 4) {
  const delays = [500, 2000, 5000, 8000]
  let last
  for (let i = 0; i < tries; i++) {
    try { await copyFile(src, dst); return } catch (e) {
      last = e
      const code = e && e.code
      if (!(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT')) throw e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delays[i] || 5000))
    }
  }
  throw last
}

/** 从已解压的首行 header 判定主/子对话（任一命中即子对话）。 */
export function parseHeaderLine(line) {
  try {
    const h = JSON.parse(line)
    const isSub = h.origin === 'subagent' || !!h.parentSession || (typeof h.delegationDepth === 'number' && h.delegationDepth > 0)
    return {
      kind: isSub ? 'sub' : 'main',
      origin: h.origin ?? null,
      parentSession: h.parentSession ?? null,
      delegationDepth: typeof h.delegationDepth === 'number' ? h.delegationDepth : null,
      cwd: typeof h.cwd === 'string' ? h.cwd : null,
      createdAt: typeof h.createdAt === 'number' ? h.createdAt : null,
      id: typeof h.id === 'string' ? h.id : null,
    }
  } catch { return { kind: 'unknown' } }
}

/** 从完整 zstd buffer 读首行 header。 */
export function headerFromBuffer(buf) {
  try {
    const text = zstdDecompressSync(buf).toString('utf8')
    const nl = text.indexOf('\n')
    return parseHeaderLine(nl === -1 ? text : text.slice(0, nl))
  } catch { return { kind: 'unknown' } }
}

/** 流式读会话文件首行（只解压到第一个换行，避免整份解压大文件）。 */
export function headerFromFile(file) {
  return new Promise((resolve) => {
    let done = false
    let rs, zs
    const finish = (v) => {
      if (done) return
      done = true
      try { rs && rs.destroy() } catch {}
      try { zs && zs.destroy() } catch {}
      resolve(v)
    }
    try {
      rs = createReadStream(file)
      zs = createZstdDecompress()
      let text = ''
      zs.on('data', (chunk) => {
        text += chunk.toString('utf8')
        const nl = text.indexOf('\n')
        if (nl !== -1) return finish(parseHeaderLine(text.slice(0, nl)))
        if (text.length > 262144) return finish(parseHeaderLine(text.slice(0, 262144)))
      })
      zs.on('error', () => finish({ kind: 'unknown' }))
      zs.on('end', () => finish(parseHeaderLine(text.split('\n')[0] || '')))
      rs.on('error', () => finish({ kind: 'unknown' }))
      rs.pipe(zs)
    } catch { finish({ kind: 'unknown' }) }
  })
}

/** 从会话 buffer 中提取「实际显示名」：取前若干 zstd 帧里的最后一个 session/title，退化用首条用户消息。 */
export function extractTitle(buf) {
  try {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const offs = []
    let i = 0
    while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i += 4 }
    let lastTitle = null, firstUser = null
    const total = offs.length
    const head = Math.min(total, 200)
    const tailStart = Math.max(head, total - 60)
    const idxs = []
    for (let k = 0; k < head; k++) idxs.push(k)
    for (let k = tailStart; k < total; k++) if (!idxs.includes(k)) idxs.push(k)
    for (const k of idxs) {
      let t
      const end = k + 1 < total ? offs[k + 1] : buf.length
      try { t = zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
      for (const ln of t.split('\n')) {
        if (!ln) continue
        let o
        try { o = JSON.parse(ln) } catch { continue }
        if (o.type === 'session/title' && o.data && typeof o.data.title === 'string') lastTitle = o.data.title
        if (!firstUser && o.type === 'user/message' && o.data && Array.isArray(o.data.content)) {
          const tx = o.data.content.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ').trim()
          if (tx) firstUser = tx
        }
      }
    }
    const title = (lastTitle || firstUser || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    return { title, titleSource: lastTitle ? 'event' : (firstUser ? 'first-user' : 'none') }
  } catch { return { title: '', titleSource: 'error' } }
}

/** 扫描 ~/.dsh/sessions 下所有正式会话日志（session.vN.jsonl.zstd，已排除 .bak-* 修复副本）。 */
export async function scanSource() {
  const found = []
  let workspaces = []
  try { workspaces = await readdir(SESSIONS_ROOT, { withFileTypes: true }) } catch { return found }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS_ROOT, ws.name)
    let sessions = []
    try { sessions = await readdir(wsDir, { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sDir = path.join(wsDir, s.name)
      let files = []
      try { files = await readdir(sDir, { withFileTypes: true }) } catch { continue }
      for (const f of files) {
        if (!f.isFile()) continue
        if (!/^session\.v\d+\.jsonl\.zstd$/.test(f.name)) continue
        const abs = path.join(sDir, f.name)
        try {
          const st = await stat(abs)
          found.push({
            key: path.join(ws.name, s.name, f.name),
            ws: ws.name, session: s.name, file: f.name, abs,
            size: st.size, mtimeMs: Math.floor(st.mtimeMs),
          })
        } catch { /* 竞态：文件刚被删 */ }
      }
    }
  }
  return found
}

const README = `这个文件夹 = DSH 对话备份（每个对话各存一份最新）

【怎么恢复一个对话】
1. 进 sessions\\ 里面，按"工作区"分文件夹，再按"会话"分文件夹。
   会话文件夹的名字就是那个对话的 ID（形如 session-xxxxxxxx-...）。
2. 把里面的 session.v4.jsonl.zstd 复制到：
      C:\\Users\\Kadima\\.dsh\\sessions\\<同一个工作区名>\\<新建一个同名文件夹>\\
3. 回到 DSH 网页按 F5 刷新刷新，列表里就会出现它。
4. 如果打开时报 "contains event type ... unknown to this harness and not marked ignorable"，
   说明那份日志里有一条插件事件没打标记，用这个脚本修（只加标记，不删内容）：
      node "E:\\Documents\\deepseek-harness\\default-workspace\\_fix-ignorable.mjs" "<日志文件路径>" write

【哪些是"已经删掉的对话"】
  打开 _mirror-state.json，带 "orphaned": true 的那些 —— 它们在 DSH 里已经没了，
   这里是你唯一的副本。（它们不会被自动清理）

【文件说明】
  sessions\\           每个对话的备份，目录结构与 DSH 里一致
  _mirror-state.json   每个备份的状态（大小/时间/是否已失联）
  _mirror.log          每次执行干了什么的记录
`

export async function runOnce(opts, log) {
  const destRoot = path.join(opts.dest, 'sessions')
  await mkdir(destRoot, { recursive: true })
  const stateFile = path.join(opts.dest, '_mirror-state.json')
  let state = {}
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch (e) {
    if (existsSync(stateFile)) { try { await rename(stateFile, stateFile + '.corrupt-' + Date.now()) } catch {} }
    state = {}
  }

  // 迁移：剔除历史 .bak-* 修复副本条目（旧版本误收录；只从索引移除，不动磁盘文件）
  let purgedBak = 0
  for (const bk of Object.keys(state)) { if (/\.bak-/.test(bk)) { delete state[bk]; purgedBak++ } }
  if (purgedBak) await log(`清理 .bak 索引条目：${purgedBak} 条（磁盘文件保留）`)

  // 首次运行写一份中文恢复说明
  const readmeFile = path.join(opts.dest, '怎么恢复.txt')
  if (!existsSync(readmeFile)) {
    try { await writeFile(readmeFile, README, 'utf8') } catch { /* 忽略 */ }
  }

  // 已清理的子对话：记在 skip 名单里，以后不再重新备份（否则删了下轮又回来）
  const skipFile = path.join(opts.dest, '_mirror-clean-skip.json')
  let skipIds = new Set()
  try { skipIds = new Set(JSON.parse(await readFile(skipFile, 'utf8'))) } catch {}

  const items = await scanSource()
  const seen = new Set()
  let copied = 0, skipped = 0, failed = 0

  for (const it of items) {
    if (skipIds.has(it.session)) continue
    seen.add(it.key)
    const prev = state[it.key]
    const target = path.join(destRoot, it.key)
    // 没变化就不覆盖
    if (prev && prev.size === it.size && prev.mtimeMs === it.mtimeMs && existsSync(target)) {
      skipped++
      if (prev.orphaned) { delete prev.orphaned; delete prev.orphanedAt }
      continue
    }
    try {
      await mkdir(path.dirname(target), { recursive: true })
      const tmp = target + '.tmp-copy-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
      await copyWithRetry(it.abs, tmp)
      const buf = await readFile(tmp)
      if (!isValidZstdFrames(buf)) {
        await unlink(tmp).catch(() => {})
        failed++
        await log(`  ⚠️ 校验失败，保留旧副本: ${it.key} (${buf.length} B)`)
        continue
      }
      await rename(tmp, target)
      const meta = { ...headerFromBuffer(buf), ...extractTitle(buf) }
      state[it.key] = {
        size: it.size, mtimeMs: it.mtimeMs,
        session: it.session, ws: it.ws, file: it.file,
        copiedAt: fmtLocal(new Date()),
        ...meta,
        ...measureSession(buf, it.size),
        lowUse: meta.kind === 'sub',
      }
      copied++
      if (opts.verbose) await log(`  ✓ ${it.key}  ${meta.kind || '?'}  ${(it.size / 1048576).toFixed(2)} MB`)
    } catch (e) {
      failed++
      await log(`  ❌ ${it.key}: ${e && e.message ? e.message : e}`)
    }
  }

  // 源里已消失的 → 备份留着（防误删的关键），只标记
  for (const key of Object.keys(state)) {
    if (seen.has(key)) continue
    if (!state[key].orphaned) {
      state[key].orphaned = true
      state[key].orphanedAt = fmtLocal(new Date())
    }
  }

  // 一次性补标：老条目缺 kind/title/cwd/createdAt/id 的，从已备份文件补齐（守卫文件只做一次，供总览用）
  const overviewMarker = path.join(opts.dest, '_mirror-overview.marker')
  if (!existsSync(overviewMarker)) {
    let filled = 0
    for (const key of Object.keys(state)) {
      const rec = state[key]
      if (!rec || typeof rec !== 'object') continue
      const need = rec.kind === undefined || rec.title === undefined || rec.cwd === undefined || rec.createdAt === undefined || rec.id === undefined
      if (!need) continue
      const target = path.join(destRoot, key)
      if (!existsSync(target)) continue
      let buf
      try { buf = await readFile(target) } catch { continue }
      Object.assign(rec, { ...headerFromBuffer(buf), ...extractTitle(buf) })
      filled++
    }
    if (filled > 0) await log(`补标总览信息：${filled} 份`)
    try { await writeFile(overviewMarker, fmtLocal(new Date()), 'utf8') } catch {}
  }

  // 一次性补算「对话长度」指标（大文件只标 big、不精算）
  const metricsMarker = path.join(opts.dest, '_mirror-metrics.marker')
  if (!existsSync(metricsMarker)) {
    let mf = 0
    for (const key of Object.keys(state)) {
      const rec = state[key]
      if (!rec || typeof rec !== 'object' || rec.users !== undefined) continue
      const target = path.join(destRoot, key)
      if (!existsSync(target)) continue
      let buf
      try { buf = await readFile(target) } catch { continue }
      Object.assign(rec, measureSession(buf, rec.size || buf.length))
      mf++
    }
    if (mf > 0) await log(`补算对话长度：${mf} 份`)
    try { await writeFile(metricsMarker, fmtLocal(new Date()), 'utf8') } catch {}
  }

  // 记「归档时间」：首次检测到被归档的时刻；取消归档则清掉（DSH 不存归档时间，这里只能记首次发现时间）
  try {
    const archivedSet = await readArchivedSet()
    for (const key of Object.keys(state)) {
      const rec = state[key]
      if (!rec || typeof rec !== 'object') continue
      const id = rec.session || rec.id
      if (archivedSet.has(id)) { if (!rec.archivedAt) rec.archivedAt = fmtLocal(new Date()) }
      else if (rec.archivedAt) { delete rec.archivedAt }
    }
  } catch {}

  // 回收站：把超过 7 天的彻底删除
  try {
    const pr = await purgeRecycle(opts)
    if (pr > 0) await log(`回收站彻底删除 ${pr} 份（超过 7 天）`)
  } catch (e) { await log('回收站清理异常: ' + (e && e.message ? e.message : e)) }

  // 到期自动清理（默认关：需 config.autoClean=true 或存在 _mirror-autoclean.on）
  const autoOn = opts.autoClean || existsSync(path.join(opts.dest, '_mirror-autoclean.on'))
  if (autoOn) {
    try {
      const ac = await autoCleanExpired(opts, state, log)
      if (ac.count > 0) await log(`自动到期清理：移入回收站 ${ac.count} 份，约 ${(ac.bytes / 1048576).toFixed(1)} MB（再留 7 天后真删）`)
    } catch (e) { await log('自动清理异常: ' + (e && e.message ? e.message : e)) }
  }

  const stTmp = stateFile + '.tmp-write'
  await writeFile(stTmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(stTmp, stateFile)
  try { await writeOverview(opts, state) } catch (e) { await log(`  总览生成失败: ${e && e.message ? e.message : e}`) }
  try { await writeCatalog(opts, state) } catch (e) { await log(`  清单生成失败: ${e && e.message ? e.message : e}`) }
  const vals = Object.values(state).filter((v) => v && typeof v === 'object')
  const totalOrphan = vals.filter((v) => v.orphaned).length
  const totalSub = vals.filter((v) => v.kind === 'sub').length
  const totalMain = vals.filter((v) => v.kind === 'main').length
  await log(`完成：新拷 ${copied} / 跳过 ${skipped} / 失败 ${failed}；已消失但保留 ${totalOrphan} 份；主 ${totalMain} / 子 ${totalSub}`)
  return { copied, skipped, failed, keptOrphans: totalOrphan, totalMain, totalSub, total: items.length }
}

/** 读取工作区归档集合（~/.dsh/storages/workspace.json）。 */
export async function readArchivedSet() {
  try {
    const wsp = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
    const ws = JSON.parse(await readFile(wsp, 'utf8'))
    return new Set((ws && ws.global && ws.global.archivedSessionIds) || [])
  } catch { return new Set() }
}

/** 把工作区路径编码成 sessions 目录名（与 DSH 一致：:\/ → -，空格/非ASCII → ~XXXX）。 */
export function encodeWorkspacePath(p) {
  let s = '--' + String(p).replace(/[\\:]+/g, '-') + '--'
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp > 127 || ch === ' ') out += '~' + cp.toString(16).toUpperCase().padStart(4, '0')
    else out += ch
  }
  return out
}

/** 恢复后把会话重新登记到对应工作区：移出 archivedSessionIds、加入该工作区 sessionIds（原子写+备份）。 */
export async function registerInWorkspace(id, wsDirName) {
  try {
    const wsp = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
    const raw = await readFile(wsp, 'utf8')
    const ws = JSON.parse(raw)
    const g = ws.global || (ws.global = {})
    const arch = g.archivedSessionIds || (g.archivedSessionIds = [])
    let changed = false
    const ai = arch.indexOf(id)
    if (ai !== -1) { arch.splice(ai, 1); changed = true }
    const tbl = (ws.tables && ws.tables.workspaces) || {}
    let targetId = null
    for (const [wid, w] of Object.entries(tbl)) {
      if (w && w.path && encodeWorkspacePath(w.path) === wsDirName) { targetId = wid; break }
    }
    if (!targetId && g.defaultWorkspaceId && tbl[g.defaultWorkspaceId]) targetId = g.defaultWorkspaceId
    if (targetId && tbl[targetId]) {
      const sess = tbl[targetId].sessionIds || (tbl[targetId].sessionIds = [])
      if (!sess.includes(id)) { sess.push(id); changed = true }
    }
    if (!changed) return { changed: false, workspaceId: targetId }
    try { await writeFile(wsp + '.bak-restore-' + Date.now(), raw, 'utf8') } catch {}
    const tmp = wsp + '.tmp-write'
    await writeFile(tmp, JSON.stringify(ws, null, 2) + '\n', 'utf8')
    await rename(tmp, wsp)
    return { changed: true, workspaceId: targetId }
  } catch { return { changed: false, error: true } }
}

/** 一键恢复：按 会话ID前缀 或 标题关键字 找到备份，拷回 ~/.dsh/sessions 对应工作区；若为归档则顺带取消归档。 */
export async function restoreSession(opts, state, query, o) {
  const dryRun = !!(o && o.dryRun)
  const q = String(query == null ? '' : query).trim()
  if (!q) return { ok: false, message: '请提供 会话ID前缀 或 标题关键字' }
  const destRoot = path.join(opts.dest, 'sessions')
  const uniq = new Map()
  for (const [key, r] of Object.entries(state || {})) {
    if (!r || typeof r !== 'object') continue
    const id = r.session || r.id || key
    const k = (r.ws || '') + '/' + id
    const score = (r.orphaned ? 0 : 2) + (/^session\.v\d+\.jsonl\.zstd$/.test(r.file || '') ? 1 : 0)
    const prev = uniq.get(k)
    if (!prev || score > prev._score) uniq.set(k, { ...r, key, id, _score: score })
  }
  const all = [...uniq.values()]
  const ql = q.toLowerCase()
  let matches = all.filter((r) => String(r.id || r.session || '').toLowerCase().includes(ql) || String(r.title || '').toLowerCase().includes(ql))
  if (matches.length === 0) return { ok: false, message: `未找到匹配「${q}」的备份会话` }
  if (matches.length > 1) {
    const exact = matches.filter((r) => r.id === q || r.session === q)
    if (exact.length === 1) matches = exact
    else return { ok: false, multiple: true, message: `匹配到 ${matches.length} 个，请用更精确的 ID/标题：\n` + matches.slice(0, 20).map((r) => `- ${r.title || '（无标题）'} · ${r.id}`).join('\n') }
  }
  const r = matches[0]
  if (!r.ws) return { ok: false, message: '该条目缺少工作区目录信息，无法自动定位恢复路径' }
  const src = path.join(destRoot, r.key)
  if (!existsSync(src)) return { ok: false, message: `备份文件不存在：${src}` }
  const fileName = /^session\.v\d+\.jsonl\.zstd$/.test(r.file || '') ? r.file : 'session.v4.jsonl.zstd'
  const targetDir = path.join(SESSIONS_ROOT, r.ws, r.session || r.id)
  const target = path.join(targetDir, fileName)
  const title = r.title || r.id
  const archivedSet = await readArchivedSet()
  if (existsSync(target)) {
    const arch = archivedSet.has(r.id || r.session)
    if (dryRun) return { ok: true, dryRun: true, already: true, message: `「${title}」源文件已存在${arch ? '（当前为归档状态，恢复会取消归档）' : '，无需恢复'}。` }
    const reg = await registerInWorkspace(r.id || r.session, r.ws)
    return { ok: true, already: true, message: `「${title}」源文件已存在，无需恢复${reg && reg.changed ? '；已重新登记到工作区列表（移出归档），刷新即可见' : ''}。` }
  }
  if (dryRun) return { ok: true, dryRun: true, message: `将恢复「${title}」\n  从 ${src}\n  到 ${target}` }
  await mkdir(targetDir, { recursive: true })
  const tmp = target + '.restore-tmp'
  await copyFile(src, tmp)
  const buf = await readFile(tmp)
  if (!isValidZstdFrames(buf)) { await unlink(tmp).catch(() => {}); return { ok: false, message: '备份文件校验未通过，已放弃恢复' } }
  await rename(tmp, target)
  const reg = await registerInWorkspace(r.id || r.session, r.ws)
  return { ok: true, message: `已恢复「${title}」→ ${target}${reg && reg.changed ? '（已重新登记到工作区列表）' : ''}\n回 DSH 按 F5 刷新；若仍不显示，重启 DSH 让工作区状态重载。` }
}

/* ────────────── 回收站 + 到期自动清理 ────────────── */
const RECYCLE_DIRNAME = '_回收站'
function recyclePaths(opts) {
  const dir = path.join(opts.dest, RECYCLE_DIRNAME)
  return { dir, manifest: path.join(dir, '_manifest.json') }
}
async function readManifest(opts) {
  try { const a = JSON.parse(await readFile(recyclePaths(opts).manifest, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] }
}
async function writeManifest(opts, list) {
  const { dir, manifest } = recyclePaths(opts)
  await mkdir(dir, { recursive: true })
  await writeFile(manifest, JSON.stringify(list, null, 2) + '\n', 'utf8')
}

/** 回收站里超过 7 天的，彻底删除。返回删除份数。 */
export async function purgeRecycle(opts) {
  const now = Date.now()
  const list = await readManifest(opts)
  const keep = []
  let removed = 0
  for (const e of list) {
    if (!e || !e.movedAt || (now - e.movedAt) < 7 * 86400000) { keep.push(e); continue }
    const f = path.join(recyclePaths(opts).dir, e.key)
    try { await unlink(f) } catch {}
    removed++
  }
  if (removed > 0) await writeManifest(opts, keep)
  return removed
}

/** 列出所有条目的到期时间（毫秒）；deadline=null 表示不自动清。 */
export function expireList(state) {
  const recs = Object.entries(state || {}).filter(([k, r]) => r && typeof r === 'object')
  const byId = new Map()
  for (const [k, r] of recs) byId.set(r.session || r.id || k, r)
  return recs.map(([key, r]) => ({ key, rec: r, deadline: deadlineOf(state, r, byId), bytes: r.size || 0 }))
}

/** 把已到期的备份移进回收站（删 state 条目）。返回 {count,bytes,list}。 */
export async function autoCleanExpired(opts, state, log) {
  const now = Date.now()
  const due = expireList(state).filter((x) => x.deadline && x.deadline <= now)
  if (!due.length) return { count: 0, bytes: 0, list: [] }
  const { dir } = recyclePaths(opts)
  await mkdir(dir, { recursive: true })
  const man = await readManifest(opts)
  let bytes = 0, done = []
  for (const it of due) {
    const src = path.join(opts.dest, 'sessions', it.key)
    const dst = path.join(dir, it.key)
    await mkdir(path.dirname(dst), { recursive: true })
    let ok = true
    try { await rename(src, dst) } catch (e) {
      try { await copyFile(src, dst); await unlink(src) } catch { ok = false }
    }
    if (!ok) continue
    delete state[it.key]
    man.push({ key: it.key, movedAt: now, session: it.rec.session, title: it.rec.title || '', size: it.rec.size || 0, kind: it.rec.kind })
    bytes += it.rec.size || 0
    done.push(it.key)
    if (log) await log(`  到期→回收站: ${it.key}`)
  }
  await writeManifest(opts, man)
  return { count: done.length, bytes, list: done }
}

/** 统计单条会话的「长度指标」：我发消息数、AI回复数、最后活动时间；>2MB 的大文件只标 big 不精算。 */
export function measureSession(buf, size) {
  try {
    if (size > 2 * 1048576) return { users: -1, replies: -1, lastAt: null, big: true }
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const offs = []
    let i = 0
    while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i += 4 }
    let users = 0, replies = 0, lastAt = null
    for (let k = 0; k < offs.length; k++) {
      const end = k + 1 < offs.length ? offs[k + 1] : buf.length
      let t
      try { t = zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
      for (const ln of t.split('\n')) {
        if (!ln) continue
        let o
        try { o = JSON.parse(ln) } catch { continue }
        if (typeof o.time === 'number' && (lastAt === null || o.time > lastAt)) lastAt = o.time
        if (o.type === 'user/message') users++
        else if (o.type === 'assistant/message') replies++
      }
    }
    return { users, replies, lastAt, big: false }
  } catch { return { users: -1, replies: -1, lastAt: null, big: false } }
}

/** 综合判「太短/临时」，命中任一即算：①内容很少 ②开启≈结束(活得<10分钟) ③结束≈删除(删后用<30分钟)。归档清由 deadlineOf 统一豁免。 */
export function isShortSession(rec) {
  const size = rec.size || 0
  const life = (rec.lastAt && rec.createdAt) ? (rec.lastAt - rec.createdAt) : 0
  const delMs = parseLocalMs(rec.orphanedAt)
  const delGap = (rec.orphaned && rec.lastAt && delMs) ? (delMs - rec.lastAt) : NaN
  const replies = rec.replies || 0
  const users = (rec.users === undefined || rec.users === null) ? -1 : rec.users
  const smallish = size < 500 * 1024 && replies <= 10
  const contentSmall = size < 300 * 1024 && users >= 0 && users <= 5 && replies <= 5 && life < 2 * 3600 * 1000
  const quickLife = smallish && life > 0 && life < 10 * 60 * 1000
  const quickDelete = smallish && Number.isFinite(delGap) && delGap >= 0 && delGap < 30 * 60 * 1000
  return contentSmall || quickLife || quickDelete
}

/** 计算到期时间（毫秒），null=不自动清。归档/父归档→永不清；主太短(含临时)→1天；主已删→30天；子随父删→7天。 */
export function deadlineOf(state, rec, byId) {
  if (rec.archivedAt) return null                 // 归档的一律不动
  if (rec.kind === 'sub') {
    if (rec.archivedAt) return null                // 子自身归档才不动（父归档不保护子，子按自己情况判）
    const rootId = _rootMainId(rec, byId)
    const root = byId.get(rootId)
    // 子代理：按「自己最后结束时间距今」算，超过 3 天即清（还在跑的不受影响）
    const idleBase = rec.lastAt || parseLocalMs(rec.copiedAt)
    let dl = idleBase ? idleBase + 3 * 86400000 : null
    // 父主对话被删 → 父删日 + 7 天；两者取更早
    let parentDl = null
    if (root && root.orphaned) {
      const b = parseLocalMs(root.orphanedAt) || parseLocalMs(root.copiedAt)
      if (b) parentDl = b + 7 * 86400000
    } else if (!root) {
      const b = parseLocalMs(rec.orphanedAt) || parseLocalMs(rec.copiedAt)
      if (b) parentDl = b + 7 * 86400000
    }
    if (parentDl != null) dl = dl == null ? parentDl : Math.min(dl, parentDl)
    return dl
  }
  // 主对话：活跃的一律不动；只有「已删除」的留 30 天后清；归档的不动
  if (rec.orphaned) {
    const base = parseLocalMs(rec.orphanedAt) || parseLocalMs(rec.copiedAt)
    return base ? base + 30 * 86400000 : null
  }
  return null
}

/** 解析 "YYYY-MM-DD HH:MM:SS" 为本地毫秒。 */
export function parseLocalMs(s) {
  if (!s || typeof s !== 'string') return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

/** 往上找到某会话的最顶层主对话 id。父不在备份里=返回该父 id（视为已删）。 */
function _rootMainId(rec, byId, seen) {
  seen = seen || new Set()
  const id = rec.session || rec.id
  if (!rec.parentSession) return id
  if (seen.has(id)) return id
  seen.add(id)
  const p = byId.get(rec.parentSession)
  if (!p) return rec.parentSession
  return _rootMainId(p, byId, seen)
}

/** 生成《对话清单.md》：一张纯表格，含 状态/主子/对话长度/大小/备份时间/到期。 */
export function buildCatalog(state, now) {
  const uniq = new Map()
  for (const [key, r] of Object.entries(state || {})) {
    if (!r || typeof r !== 'object') continue
    const id = r.session || r.id || key
    const k = (r.ws || '') + '/' + id
    const score = (r.orphaned ? 0 : 2) + (/^session\.v\d+\.jsonl\.zstd$/.test(r.file || '') ? 1 : 0)
    const prev = uniq.get(k)
    if (!prev || score > prev._score) uniq.set(k, { ...r, key, id, _score: score })
  }
  const recs = [...uniq.values()]
  const byId = new Map()
  for (const r of recs) byId.set(r.session || r.id, r)
  const nowMs = parseLocalMs(now) || Date.now()
  const fmtD = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
  const fmtDT = (v) => {
    if (v == null || v === '') return ''
    const ms = typeof v === 'number' ? v : parseLocalMs(v)
    if (!ms) return ''
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const rows = recs.map((r) => {
    const short = isShortSession(r)
    const dl = deadlineOf(state, r, byId)
    const lenTxt = r.big ? '大文件' : ((r.users === undefined || r.users < 0) ? '—' : `${r.users}问/${r.replies || 0}答`)
    return { r, short, dl, lenTxt }
  }).sort((a, b) => (a.dl || Infinity) - (b.dl || Infinity))
  const lines = []
  lines.push('# 对话清单（备份索引）')
  lines.push('')
  lines.push(`> 更新于 ${now} · 共 ${recs.length} 条 · 「到期」为自动清理的预计日期，保留=不自动清`)
  lines.push('')
  lines.push('| 名字 | 状态 | 主/子 | 对话长度 | 大小 | 开启时间 | 结束时间 | 归档时间 | 删除时间 | 到期 | 备份时间 | ID | 工作区 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const { r, short, dl, lenTxt } of rows) {
    const status = r.orphaned ? '已删除' : (r.archivedAt ? '归档' : '活跃')
    const kind = r.kind === 'sub' ? '子' : '主'
    const sz = r.size || 0
    const size = (sz / 1048576).toFixed(sz >= 1048576 ? 1 : 2) + 'MB'
    const exp = dl ? (dl <= nowMs ? '**已到期**' : fmtD(dl)) : '保留'
    const title = (String(r.title || '').replace(/\|/g, '\\|').slice(0, 40)) || '(无标题)'
    lines.push(`| ${title} | ${status} | ${kind} | ${lenTxt} | ${size} | ${fmtDT(r.createdAt)} | ${fmtDT(r.lastAt)} | ${fmtDT(r.archivedAt)} | ${fmtDT(r.orphanedAt)} | ${exp} | ${r.copiedAt || ''} | \`${r.id || r.session}\` | ${r.ws || ''} |`)
  }
  return lines.join('\n') + '\n'
}

export async function writeCatalog(opts, state) {
  const md = buildCatalog(state, fmtLocal(new Date()))
  await writeFile(path.join(opts.dest, '对话清单.md'), md, 'utf8')
}

/** 生成给人看的《对话总览.md》：按 工作区 → 主对话 → 子对话 的树。 */
export function buildOverview(state, now, statusSets) {
  const sets = statusSets || {}
  const archived = sets.archived instanceof Set ? sets.archived : new Set()
  const pinned = sets.pinned instanceof Set ? sets.pinned : new Set()
  const inWs = sets.inWs instanceof Set ? sets.inWs : new Set()

  // 去重：同一 ws/会话 可能有 session.vN 与 .bak-* 多份，只保留最有代表性的一条
  const uniq = new Map()
  for (const [key, r] of Object.entries(state)) {
    if (!r || typeof r !== 'object') continue
    const id = r.session || r.id || key
    const k = (r.ws || '') + '/' + id
    const score = (r.orphaned ? 0 : 2) + (/^session\.v\d+\.jsonl\.zstd$/.test(r.file || '') ? 1 : 0)
    const prev = uniq.get(k)
    if (!prev || score > prev._score) uniq.set(k, { ...r, key, id, _score: score })
  }
  const recs = [...uniq.values()]

  const byWs = new Map()
  for (const r of recs) {
    const ws = r.ws || '（未知工作区）'
    if (!byWs.has(ws)) byWs.set(ws, [])
    byWs.get(ws).push(r)
  }
  const fmtDate = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const mb = (n) => (n / 1048576).toFixed(n >= 1048576 ? 1 : 2)
  const clean = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim()
  const statusOf = (r) => {
    if (r.kind === 'sub') return r.orphaned ? 'deleted' : 'sub'
    const id = r.session || r.id
    if (r.orphaned) return 'deleted'
    if (archived.has(id)) return 'archived'
    if (inWs.has(id)) return 'active'
    return 'unlisted'
  }

  let uMain = 0, uSub = 0, cActive = 0, cArchived = 0, cDeletedMain = 0, cDeletedSub = 0, cUnlisted = 0, subBytes = 0
  for (const r of recs) {
    const s = statusOf(r)
    if (r.kind === 'sub') { uSub++; subBytes += (r.size || 0); if (s === 'deleted') cDeletedSub++ }
    else {
      uMain++
      if (s === 'active') cActive++
      else if (s === 'archived') cArchived++
      else if (s === 'deleted') cDeletedMain++
      else cUnlisted++
    }
  }

  const lines = []
  lines.push('# DSH 对话备份总览')
  lines.push('')
  lines.push(`> 更新于 ${now} · 共 ${recs.length} 个会话`)
  lines.push(`> 主对话 ${uMain}：活跃 ${cActive} / 归档 ${cArchived} / 已删除 ${cDeletedMain}${cUnlisted ? ' / 未归属 ' + cUnlisted : ''}；子对话 ${uSub}（其中源已删 ${cDeletedSub}）`)
  lines.push(`> 🧹 = 子对话（一次性任务，标为「少用·可清理」）：共 ${uSub} 个、约 ${(subBytes / 1048576).toFixed(1)} MB；主对话只标记不清理。清理需你手动下令。`)
  lines.push('> 状态来源：归档 = ~/.dsh/storages/workspace.json 的 archivedSessionIds；已删除 = 源目录已无此文件（备份保留）。')
  lines.push('> 本文件由备份插件自动生成；真实文件在 `sessions/` 下按「工作区/会话ID」原样存放，恢复见 `怎么恢复.txt`。')
  lines.push('')

  const wsNames = [...byWs.keys()].sort((a, b) => String(a).localeCompare(String(b), 'zh'))
  let idx = 0
  for (const ws of wsNames) {
    idx++
    const list = byWs.get(ws)
    const mains = list.filter((r) => r.kind !== 'sub')
    const subs = list.filter((r) => r.kind === 'sub')
    const wsDir = ws
    const dispPath = clean((list.find((r) => r.cwd) || {}).cwd || '') || ws
    lines.push(`## 工作区 ${idx}：${dispPath}`)
    lines.push(`备份目录：\`sessions/${wsDir}/\` · 主 ${mains.length} / 子 ${subs.length}`)
    lines.push('')
    const used = new Set()
    const childrenOf = (id) => subs.filter((r) => r.parentSession === id)
    const renderNode = (r, depth) => {
      const rid = r.session || r.id
      if (used.has(rid)) return
      used.add(rid)
      const ind = '  '.repeat(depth)
      const rawId = String(r.id || r.session || '')
      const title = clean(r.title) || `（未命名 ${rawId.length > 24 ? rawId.slice(0, 24) + '…' : rawId}）`
      const bits = []
      const st = statusOf(r)
      if (r.createdAt) bits.push(fmtDate(r.createdAt))
      if (typeof r.size === 'number') bits.push(`${mb(r.size)} MB`)
      bits.push(`\`${r.id || r.session}\``)
      if (st === 'archived') bits.push('🗄️ 已归档')
      if (st === 'deleted') bits.push('⚠️ 源已删除')
      if (st === 'unlisted') bits.push('未在工作区列表')
      if (pinned.has(r.session || r.id)) bits.push('📎 置顶')
      const icon = depth > 0 ? '🧹' : (st === 'archived' ? '🗄️' : st === 'deleted' ? '⚠️' : '📌')
      lines.push(`${ind}- ${icon} **${title}**  ${bits.join(' · ')}`)
      for (const c of childrenOf(rid)) renderNode(c, depth + 1)
    }
    mains.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    for (const m of mains) renderNode(m, 0)
    const leftovers = subs.filter((r) => !used.has(r.session || r.id))
    if (leftovers.length) {
      lines.push(`- （父会话缺失的子对话 ${leftovers.length} 份）`)
      for (const o of leftovers) renderNode(o, 1)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

/** 清理「少用·可清理」的子对话备份：默认只预览；confirm=true 才真删。删掉的 id 记入 skip 名单，以后不再重新备份。 */
export async function cleanSubBackups(opts, state, o) {
  const confirm = !!(o && o.confirm)
  const destRoot = path.join(opts.dest, 'sessions')
  const targets = []
  for (const [key, r] of Object.entries(state || {})) {
    if (!r || typeof r !== 'object') continue
    if (r.kind !== 'sub') continue
    targets.push({ key, session: r.session || r.id, size: r.size || 0, orphaned: !!r.orphaned })
  }
  const totalBytes = targets.reduce((s, t) => s + t.size, 0)
  const orphanCount = targets.filter((t) => t.orphaned).length
  if (!confirm) {
    return { ok: true, dryRun: true, count: targets.length, orphanCount, bytes: totalBytes,
      message: `将清理 ${targets.length} 个子对话备份（其中 ${orphanCount} 个是源已删、仅剩备份），约 ${(totalBytes / 1048576).toFixed(1)} MB。这是预览；确认执行请传 confirm=true。` }
  }
  const skipFile = path.join(opts.dest, '_mirror-clean-skip.json')
  let skipIds = []
  try { skipIds = JSON.parse(await readFile(skipFile, 'utf8')) } catch { skipIds = [] }
  const skipSet = new Set(skipIds)
  let deleted = 0, failed = 0
  for (const t of targets) {
    const f = path.join(destRoot, t.key)
    try { await unlink(f) } catch (e) { if (!(e && e.code === 'ENOENT')) { failed++; continue } }
    delete state[t.key]
    if (t.session) skipSet.add(t.session)
    deleted++
  }
  try { await writeFile(skipFile, JSON.stringify([...skipSet], null, 2) + '\n', 'utf8') } catch {}
  const stTmp = path.join(opts.dest, '_mirror-state.json') + '.tmp-write'
  await writeFile(stTmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(stTmp, path.join(opts.dest, '_mirror-state.json'))
  try { await writeOverview(opts, state) } catch {}
  return { ok: true, deleted, failed, bytes: totalBytes,
    message: `已清理 ${deleted} 个子对话备份（失败 ${failed}），释放约 ${(totalBytes / 1048576).toFixed(1)} MB；这些对话以后不再重新备份。` }
}

export async function writeOverview(opts, state) {
  let sets
  try {
    const wsp = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
    const ws = JSON.parse(await readFile(wsp, 'utf8'))
    const archived = new Set((ws && ws.global && ws.global.archivedSessionIds) || [])
    const pinned = new Set((ws && ws.global && ws.global.pinnedSessionIds) || [])
    const inWs = new Set()
    const tbl = (ws && ws.tables && ws.tables.workspaces) || {}
    for (const w of Object.values(tbl)) for (const id of (w.sessionIds || [])) inWs.add(id)
    sets = { archived, pinned, inWs }
  } catch { /* 拿不到工作区状态就只标 主/子/已删 */ }
  const md = buildOverview(state, fmtLocal(new Date()), sets)
  await writeFile(path.join(opts.dest, '对话总览.md'), md, 'utf8')
}

export function apply(ctx, config) {
  const opts = resolveOpts(config)
  if (!opts.enabled) return

  let running = false

  const log = async (msg) => {
    const line = `[${fmtLocal(new Date())}] ${msg}\n`
    try {
      await mkdir(opts.dest, { recursive: true })
      await writeFile(path.join(opts.dest, '_mirror.log'), line, { encoding: 'utf8', flag: 'a' })
    } catch { /* 盘不在就静默 */ }
    if (opts.verbose) ctx.logger?.info?.('[session-mirror] ' + msg)
  }

  const tick = async () => {
    if (running) return
    running = true
    try { await runOnce(opts, log) } catch (e) { await log('本轮异常: ' + (e && e.message ? e.message : e)) } finally { running = false }
  }

  // ── 时机一：启动 —— 插件装好后跑一次 ─────────────────────────────
  ctx.effect(() => {
    const boot = setTimeout(() => { void tick() }, 8000)
    return () => clearTimeout(boot)
  }, 'dsh-session-mirror: run on startup')

  // ── 时机二：每轮对话结束 —— turn/end 去抖 8 秒后跑一次 ────────────
  ctx.effect(() => {
    let debounce = null
    const onEvent = (_session, event) => {
      if (!event || event.type !== 'turn/end') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void tick() }, 8000)
    }
    try { ctx.on('session/event', onEvent, { global: true }) } catch { ctx.on('session/event', onEvent) }
    return () => {
      if (debounce) clearTimeout(debounce)
      try { ctx.off?.('session/event', onEvent) } catch { /* 没有 off 就交给 fiber 回收 */ }
    }
  }, 'dsh-session-mirror: run on turn end')

  // ── 时机三：关闭 —— 宿主会等这个 promise；拷一半被打断也不会盖掉旧副本 ──
  ctx.effect(() => () => {
    return runOnce(opts, log).catch(() => {})
  }, 'dsh-session-mirror: run on shutdown')

  // 注册对话工具（挂 ctx.effect：fiber 重建/卸载时自动注销，避免重复注册与泄漏）
  // 注意：ctx.tools.register 是 async（Promise<void>），必须串行 await——
  // 同步连发会因并发约束导致后面的注册被拒（曾因此第三个工具静默丢失）。
  ctx.effect(async () => {
    const disposers = []
    const reg = async (spec) => {
      try {
        const ret = await ctx.tools.register(spec)
        disposers.push(typeof ret === 'function' ? ret : () => { try { ret && ret.dispose && ret.dispose() } catch {} })
        return true
      } catch (e) {
        try {
          await mkdir(opts.dest, { recursive: true })
          await writeFile(path.join(opts.dest, '_mirror-tool-register.log'),
            `[${fmtLocal(new Date())}] 注册失败 ${spec.name}: ${e && e.message ? e.message : e}\n`, { flag: 'a' })
        } catch {}
        return false
      }
    }
    await reg({
      name: 'session_mirror_now',
      description: '立即执行一次按会话逐个的对话日志备份，返回本轮统计。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute() {
        const r = await runOnce(opts, log)
        return `备份完成：新拷 ${r.copied} / 跳过 ${r.skipped} / 失败 ${r.failed}；已消失但保留 ${r.keptOrphans} 份；主 ${r.totalMain} / 子 ${r.totalSub}（目标 ${opts.dest}）`
      },
    })
    await reg({
      name: 'session_mirror_restore',
      description: '一键从对话备份恢复某个会话：按 会话ID前缀 或 标题关键字 找到备份，拷回 ~/.dsh/sessions 对应工作区并重新登记到工作区列表；dryRun=true 可先预览。',
      parameters: {
        query: { type: 'string', required: true, description: '会话ID前缀 或 标题关键字' },
        dryRun: { type: 'boolean', required: false, description: '只预览不写入' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        const stateFile = path.join(opts.dest, '_mirror-state.json')
        const state = await readJson(stateFile, {})
        const r = await restoreSession(opts, state, args && args.query, { dryRun: !!(args && args.dryRun) })
        return r.message
      },
    })
    await reg({
      name: 'session_mirror_clean',
      description: '清理「少用·可清理」的子对话备份（子对话一律算少用）。默认只预览数量与体积；confirm=true 才真删，删后不再重新备份。主对话永不清理。',
      parameters: {
        confirm: { type: 'boolean', required: true, description: 'true=真删；false=只预览' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        const stateFile = path.join(opts.dest, '_mirror-state.json')
        const state = await readJson(stateFile, {})
        const r = await cleanSubBackups(opts, state, { confirm: !!(args && args.confirm) })
        return r.message
      },
    })
    return () => {
      for (const d of disposers) {
        try { if (typeof d === 'function') d() } catch {}
      }
    }
  }, 'dsh-session-mirror: register tools')
}
