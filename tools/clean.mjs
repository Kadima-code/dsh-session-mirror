#!/usr/bin/env node
/**
 * 清理「少用·可清理」的子对话备份（子对话一律算少用；主对话永不清理）。
 * 用法：
 *   node tools/clean.mjs         预览：会清多少个、多少 MB
 *   node tools/clean.mjs --yes   真删（删后不再重新备份）
 * 环境变量 DSH_MIRROR_DEST 可覆盖备份目录（默认 E:\DshChatBackup）
 */
import fs from 'node:fs'
import path from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const dest = process.env.DSH_MIRROR_DEST || 'E:\\DshChatBackup'
const stateFile = path.join(dest, '_mirror-state.json')
if (!fs.existsSync(stateFile)) { console.error('找不到备份状态文件：' + stateFile); process.exit(1) }
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const yes = process.argv.includes('--yes') || process.argv.includes('-y')
const r = await mod.cleanSubBackups({ dest }, state, { confirm: yes })
console.log(r.message)
