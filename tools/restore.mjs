#!/usr/bin/env node
/**
 * 一键恢复 DSH 对话备份（命令行版）。
 * 用法：
 *   node tools/restore.mjs                交互式：列出可恢复会话，按序号/ID/标题选择
 *   node tools/restore.mjs --list         只列出「已删除、可恢复」的主对话
 *   node tools/restore.mjs <ID前缀|标题>   预览（dry-run）
 *   node tools/restore.mjs <ID前缀|标题> --yes   真正执行恢复
 * 环境变量 DSH_MIRROR_DEST 可覆盖备份目录（默认 E:\DshChatBackup）
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const dest = process.env.DSH_MIRROR_DEST || 'E:\\DshChatBackup'
const stateFile = path.join(dest, '_mirror-state.json')
if (!fs.existsSync(stateFile)) { console.error('找不到备份状态文件：' + stateFile); process.exit(1) }
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const opts = { dest }

const uniqRecs = () => mod.uniqSessions(state)
const fmt = (r) => `${(r.title || '(无标题)').padEnd(28)} ${r.id}  ${r.orphaned ? '【已删除·可恢复】' : ''}`
async function doRestore(q, yes) {
  const r = await mod.restoreSession(opts, state, q, { dryRun: !yes })
  console.log(r.message)
  return r
}

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const positional = args.filter((a) => !a.startsWith('-'))

if (has('--list')) {
  const del = uniqRecs().filter((r) => r.orphaned && r.kind !== 'sub')
  console.log(`可恢复（已删除）的主对话 ${del.length} 个：`)
  del.slice(0, 300).forEach((r, i) => console.log(String(i + 1).padStart(3) + '. ' + fmt(r)))
  process.exit(0)
}
if (positional.length) { await doRestore(positional.join(' '), has('--yes')); process.exit(0) }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((res) => rl.question(q, res))
const all = uniqRecs()
const del = all.filter((r) => r.orphaned && r.kind !== 'sub')
console.log(`共 ${all.length} 个会话；其中「已删除、可恢复」的主对话 ${del.length} 个。`)
del.slice(0, 40).forEach((r, i) => console.log(String(i + 1).padStart(3) + '. ' + fmt(r)))
const ans = (await ask('输入序号，或 ID前缀/标题关键字（直接回车退出）> ')).trim()
if (!ans) { rl.close(); process.exit(0) }
let q = ans
if (/^\d+$/.test(ans)) { const idx = parseInt(ans, 10) - 1; if (del[idx]) q = del[idx].id }
const confirm = (await ask(`确认恢复「${q}」？(y/N) `)).trim().toLowerCase()
rl.close()
if (confirm !== 'y' && confirm !== 'yes') { console.log('已取消'); process.exit(0) }
await doRestore(q, true)
