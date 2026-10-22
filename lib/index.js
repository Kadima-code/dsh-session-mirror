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
export const inject = []

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
      if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return false
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

/** 扫描 ~/.dsh/sessions 下所有会话日志（含 .bak-* 修复副本）。 */
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
        if (!/^session\.v\d+\.jsonl\.zstd/.test(f.name)) continue
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
  const state = await readJson(stateFile, {})

  // 首次运行写一份中文恢复说明
  const readmeFile = path.join(opts.dest, '怎么恢复.txt')
  if (!existsSync(readmeFile)) {
    try { await writeFile(readmeFile, README, 'utf8') } catch { /* 忽略 */ }
  }

  const items = await scanSource()
  const seen = new Set()
  let copied = 0, skipped = 0, failed = 0

  for (const it of items) {
    seen.add(it.key)
    const prev = state[it.key]
    const target = path.join(destRoot, it.key)
    // 没变化就不覆盖
    if (prev && prev.size === it.size && prev.mtimeMs === it.mtimeMs && existsSync(target)) {
      skipped++
      if (prev.orphaned) delete prev.orphaned
      continue
    }
    try {
      await mkdir(path.dirname(target), { recursive: true })
      const tmp = target + '.tmp-copy'
      await copyFile(it.abs, tmp)
      const buf = await readFile(tmp)
      if (!isValidZstdFrames(buf)) {
        await unlink(tmp).catch(() => {})
        failed++
        await log(`  ⚠️ 校验失败，保留旧副本: ${it.key} (${buf.length} B)`)
        continue
      }
      await rename(tmp, target)
      const meta = headerFromBuffer(buf)
      state[it.key] = {
        size: it.size, mtimeMs: it.mtimeMs,
        session: it.session, ws: it.ws, file: it.file,
        copiedAt: fmtLocal(new Date()),
        ...meta,
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

  // 一次性补标：老条目没有 kind 的，从已备份文件读首行 header 补上（用标记文件守卫，只做一次）
  const kindMarker = path.join(opts.dest, '_mirror-kind.marker')
  if (!existsSync(kindMarker)) {
    let filled = 0
    for (const key of Object.keys(state)) {
      const rec = state[key]
      if (!rec || typeof rec !== 'object' || rec.kind !== undefined) continue
      const target = path.join(destRoot, key)
      if (!existsSync(target)) continue
      const meta = await headerFromFile(target)
      if (meta.kind && meta.kind !== 'unknown') { Object.assign(rec, meta); filled++ }
    }
    if (filled > 0) await log(`补标主/子对话：${filled} 份`)
    try { await writeFile(kindMarker, fmtLocal(new Date()), 'utf8') } catch {}
  }

  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
  const vals = Object.values(state).filter((v) => v && typeof v === 'object')
  const totalOrphan = vals.filter((v) => v.orphaned).length
  const totalSub = vals.filter((v) => v.kind === 'sub').length
  const totalMain = vals.filter((v) => v.kind === 'main').length
  await log(`完成：新拷 ${copied} / 跳过 ${skipped} / 失败 ${failed}；已消失但保留 ${totalOrphan} 份；主 ${totalMain} / 子 ${totalSub}`)
  return { copied, skipped, failed, keptOrphans: totalOrphan, totalMain, totalSub, total: items.length }
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
    ctx.on('session/event', onEvent)
    return () => {
      if (debounce) clearTimeout(debounce)
      try { ctx.off?.('session/event', onEvent) } catch { /* 没有 off 就交给 fiber 回收 */ }
    }
  }, 'dsh-session-mirror: run on turn end')

  // ── 时机三：关闭 —— 宿主会等这个 promise；拷一半被打断也不会盖掉旧副本 ──
  ctx.effect(() => () => {
    return runOnce(opts, log).catch(() => {})
  }, 'dsh-session-mirror: run on shutdown')

  // 让模型能手动触发一次（注册失败不影响定时器）
  try {
    ctx.tools?.register?.({
      name: 'session_mirror_now',
      description: '立即执行一次按会话逐个的对话日志备份，返回本轮统计。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute() {
        const r = await runOnce(opts, log)
        return `备份完成：新拷 ${r.copied} / 跳过 ${r.skipped} / 失败 ${r.failed}；已消失但保留 ${r.keptOrphans} 份；主 ${r.totalMain} / 子 ${r.totalSub}（目标 ${opts.dest}）`
      },
    })
  } catch { /* host 没暴露 tools 就只跑定时器 */ }
}
