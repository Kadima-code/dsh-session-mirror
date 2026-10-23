#!/usr/bin/env node
/**
 * dsh-session-mirror 清理工具（命令行）。
 * 用法：
 *   node tools/clean.mjs                预览：手动清理“子对话备份”会清多少
 *   node tools/clean.mjs --yes          执行手动清理子对话备份（直接删，记入 skip 不再备份）
 *   node tools/clean.mjs --expiring     查看“已到期 / 未来 7 天内到期”的备份（自动清理计划）
 *   node tools/clean.mjs --auto-on      打开「到期自动清理」（先移入回收站，留 7 天再真删）
 *   node tools/clean.mjs --auto-off     关闭「到期自动清理」
 *   node tools/clean.mjs --purge        立即彻底删除回收站里超过 7 天的
 * 环境变量 DSH_MIRROR_DEST 可覆盖备份目录（默认 E:\DshChatBackup）
 */
import fs from 'node:fs'
import path from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const dest = process.env.DSH_MIRROR_DEST || 'E:\\DshChatBackup'
const stateFile = path.join(dest, '_mirror-state.json')
if (!fs.existsSync(stateFile)) { console.error('找不到备份状态文件：' + stateFile); process.exit(1) }
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const arg = (n) => process.argv.includes(n)
const marker = path.join(dest, '_mirror-autoclean.on')
const fmtD = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
const mb = (b) => (b / 1048576).toFixed(b >= 1048576 ? 1 : 2) + ' MB'

if (arg('--auto-on')) { fs.writeFileSync(marker, mod.fmtLocal(new Date())); console.log('✅ 已打开「到期自动清理」（先移入回收站，留 7 天再真删）。'); process.exit(0) }
if (arg('--auto-off')) { try { fs.rmSync(marker, { force: true }) } catch {} ; console.log('✅ 已关闭「到期自动清理」（不再自动移走任何备份）。'); process.exit(0) }
if (arg('--purge')) { const n = await mod.purgeRecycle({ dest }); console.log(`回收站已彻底删除 ${n} 份（超过 7 天的）。`); process.exit(0) }

if (arg('--expiring')) {
  const now = Date.now()
  const list = mod.expireList(state).filter((x) => x.deadline)
  const due = list.filter((x) => x.deadline <= now)
  const soon = list.filter((x) => x.deadline > now && x.deadline <= now + 7 * 86400000).sort((a, b) => a.deadline - b.deadline)
  const flag = fs.existsSync(marker) ? '已开启' : '未开启'
  console.log(`自动清理：${flag}`)
  console.log(`\n【已到期·将移入回收站】${due.length} 份，约 ${mb(due.reduce((s, x) => s + x.bytes, 0))}`)
  for (const x of due) console.log(`  - ${x.rec.title || '(无标题)'}  ${x.rec.kind === 'sub' ? '子' : '主'}  ${mb(x.bytes)}  ${x.rec.session || x.rec.id}`)
  console.log(`\n【未来 7 天内到期】${soon.length} 份，约 ${mb(soon.reduce((s, x) => s + x.bytes, 0))}`)
  for (const x of soon) console.log(`  - ${fmtD(x.deadline)}  ${x.rec.title || '(无标题)'}  ${x.rec.kind === 'sub' ? '子' : '主'}  ${mb(x.bytes)}`)
  process.exit(0)
}

// 默认：手动清理子对话备份（旧行为，直接删）
const yes = arg('--yes') || arg('-y')
const r = await mod.cleanSubBackups({ dest }, state, { confirm: yes })
console.log(r.message)
