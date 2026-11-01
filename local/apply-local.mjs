/**
 * 本机定制补丁：把这些修复叠到上游 dsh-purge 之上（幂等）。
 *
 * 由来：1.1.71 时代在 node_modules 里手打过一批补丁。1.1.73+ 官方吸收了其中 5 处，
 * 剩下这些上游至今没有对应实现，必须每次跟上游后重放一次。
 *
 * 用法：node local/apply-local.mjs
 * 输出：ok / skip 逐条清单；改动直接写回仓库工作区，不碰 node_modules。
 * 校验：改完用 node --check 逐个验语法。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const steps = []
const ok = (m) => steps.push('ok    ' + m)
const skip = (m) => steps.push('skip  ' + m)

function patch(file, rules) {
  const p = join(root, file)
  let src = readFileSync(p, 'utf8')
  const before = src
  for (const [from, to, label] of rules) {
    if (src.includes(to)) { skip(`${file} :: ${label}（已应用）`); continue }
    if (!src.includes(from)) {
      // 不做「看起来已应用」的猜测：下游文件里同一行可能由别的替换先插进来，
      // 猜错会静默漏改（1.1.86 上就踩过一次）。命中不了就如实报，人工确认。
      skip(`${file} :: ${label}（from 未命中：已应用或上游已改）`)
      continue
    }
    src = src.split(from).join(to)
    ok(`${file} :: ${label}`)
  }
  if (src !== before) writeFileSync(p, src)
}

/* ── 1. 宿主根识别：0.2.1-rc.2 起 dsh-agent-instructions 没有 lib/ ───────── */
patch('lib/core.js', [[
  `function isAiBase(p) {
  return p && isDir(path.join(p, "dsh-agent-instructions", "lib"));
}`,
  `function isAiBase(p) {
  if (!p) return false;
  // [local] DSH 0.2.1-rc.2 ships dsh-agent-instructions without a lib/ dir;
  // recognize the harness base via other stable core packages too (back- and forward-compatible).
  return isDir(path.join(p, "dsh-agent-instructions", "lib"))
    || isDir(path.join(p, "dsh-system-prompt", "lib"))
    || isDir(path.join(p, "dsh-base", "lib"));
}`,
  'isAiBase 放宽宿主根识别',
]])

/* ── 2. 梁神预设补丁在没有该 preset 的机器上不该判失败 ─────────────────── */
patch('lib/core.js', [[
  `    file: ["preset-liangshen", "preset-liangshen-pkg"],
    strictFiles: true,`,
  `    file: ["preset-liangshen", "preset-liangshen-pkg"],
    optional: true, // [local] @linxin666/dsh-liangshen preset not installed here; absent target must not fail clean
    strictFiles: true,`,
  'preset-liangshen 标记 optional',
]])

/* ── 3. 并发闸门：listChildren 的目录条目没有 kind/activity ────────────── */
patch('lib/redteam/tools.js', [[
  `import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'`,
  `import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
/* [local] 并发口径只有一份实现：面板「智能体」页签与这里的闸门共用（见该文件头注释） */
import { readRunningChildren } from './agent-activity.js'`,
  '引入 readRunningChildren',
], [
  `function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}`,
  `/**
 * [local] 取 host 平面的 store。
 *
 * 预设平面（各角色智能体的工具行）的 ctx 不一定是 host 的 Proxy 视图：
 * \`ctx.redteam\` 属性访问可能直接抛（Scoped 上下文只认 ctx.get），
 * 所以两条路都要试 —— 只试 ctx.redteam 会静默拿到 undefined。
 */
function storeOf(ctx) {
  let store
  try { store = ctx.redteam } catch { store = undefined }
  if (!store) { try { store = ctx.get('redteam') } catch { store = undefined } }
  return store
}

/**
 * 并发上限：每次调用现读 settings.json → REDTEAM_MAX_AGENTS → 默认 3。
 *
 * root 必须与面板同源（面板读的是 host store 的 root = \`$DSH_HOME/redteam\`）：
 * 这里若拿不到 root，settingsPathOf(undefined) 会退化成相对路径 \`./settings.json\`，
 * 读不到面板保存的值 → 面板显示「上限 5」、闸门仍按默认 3 卡人（口径漂移）。
 */
function maxAgentsNow(ctx) {
  const store = storeOf(ctx)
  const root = store !== undefined && store !== null && typeof store.root === 'string' ? store.root : undefined
  return maxAgentsOf(root, process.env)
}`,
  'maxAgentsNow 加 store 兜底',
], [
  `async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: '列子会话失败：' + (error && error.message ? error.message : String(error)) }
  }
}`,
  `/**
 * 实时并发占用：读 subagents 注册表里"真正在跑"的直接子会话数。
 *
 * [local] 口径细节在 ./agent-activity.js：\`listChildren\` 返回的是父会话目录投影的原始条目
 * （只有 id / createdAt / mode / label），没有 kind 与 activity；拿它过滤
 * \`kind === 'child' && activity === 'running'\` 会恒为空数组 —— 上游到 1.1.86 仍如此，
 * 闸门因此永远「看不见」真实并发。这里改成走 listDescendants（唯一带 activity 的入口）。
 */
async function liveRunningChildren(ctx, rootSessionId) {
  return readRunningChildren(ctx, rootSessionId)
}`,
  'liveRunningChildren 改用 listDescendants 口径',
]])

/* ── 4. 面板侧同一口径 + agentsStatus 暴露注册表可用性 ─────────────────── */
patch('lib/redteam/ui.js', [[
  `import { maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'`,
  `import { maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
/* [local] 并发口径只有一份实现：这里的「智能体」页签与 redteam_agent_slot 闸门共用 */
import { readRunningChildren } from './agent-activity.js'`,
  '引入 readRunningChildren',
], [
  `    const subagents = ctx.get('subagents')
    const sessions = ctx.get('sessions')
    if (subagents !== undefined && subagents !== null && sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {`,
  `    const sessions = ctx.get('sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {`,
  '重启提示：去掉 subagents 硬依赖',
], [
  `        try {
          const kids = await subagents.listChildren(root.id)
          for (const k of Array.isArray(kids) ? kids : []) {
            if (k && k.kind === 'child' && k.activity === 'running') running.push({ session: String(root.id), label: k.label || String(k.id) })
          }
        } catch { /* 单个会话读不到不影响其它 */ }`,
  `        const live = await readRunningChildren(ctx, root.id)
        for (const label of live.running_labels ?? []) running.push({ session: String(root.id), label })`,
  '重启提示：在跑智能体改走新口径',
], [
  `  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: "subagents / sessions registry unavailable: cannot read concurrent usage.", max }
  }`,
  `  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: "sessions registry unavailable: cannot read concurrent usage.", max }
  }`,
  'agentsStatus：去掉 subagents 硬依赖',
], [
  `  const children = []
  try {`,
  `  const children = []
  const registryErrors = []
  let registryAvailable = false
  let totalChildren = 0
  try {`,
  'agentsStatus：注册表状态变量',
], [
  `    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') children.push({ parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
        }
      } catch { /* 单个会话读不到就跳过 */ }
    }`,
  `    for (const parent of roots) {
      const live = await readRunningChildren(ctx, parent.id)
      if (live.available) registryAvailable = true
      else if (live.error) registryErrors.push(String(parent.id).slice(0, 8) + '…: ' + live.error)
      totalChildren += typeof live.total_children === 'number' ? live.total_children : 0
      for (const label of live.running_labels ?? []) children.push({ parent: String(parent.id), label })
    }`,
  'agentsStatus：在跑智能体改走新口径',
], [
  `  const running = children.filter((c) => c.activity === 'running')
  return {
    ok: true, max, used: running.length, free: Math.max(max - running.length, 0),
    running: running.slice(0, 20), total_children: children.length,`,
  `  return {
    ok: true, max, used: children.length, free: Math.max(max - children.length, 0),
    running: children.slice(0, 20), total_children: totalChildren,
    registry_available: registryAvailable,
    registry_note: registryAvailable ? undefined : (registryErrors[0] ?? undefined),`,
  'agentsStatus：返回注册表可用性',
]])

/* ── 5. 面板并发数字自更新（上游只在挂载时取一次快照） ─────────────────── */
patch('lib/redteam/client.js', [[
  `        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])`,
  `        refreshConcurrency()
      }
      /* [local] 只重取并发（不动角色提示词）：挂载、手动刷新、轮询共用这一条 */
      function refreshConcurrency() {
        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
          else if (r && r.error) setErr(r.error)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])
      /* [local] 面板要跟着派活/收工自己动：以前只在挂载那一刻取一次快照，
         子智能体跑起来之后数字不会变，看起来就像"并发一直是 0"。
         这里加 5 秒静默重取 + 窗口重新聚焦时立刻重取。 */
      React.useEffect(() => {
        const timer = setInterval(refreshConcurrency, 5000)
        const onFocus = () => refreshConcurrency()
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(timer)
          if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('focus', onFocus)
        }
      }, [eng])`,
  'agentsStatus 5 秒轮询 + 聚焦重取',
]])

/* ── 6. 可选：把「检查更新」的源指向自己的 fork ────────────────────────── */
/* 不改的话，面板会盯着上游：上游发新版时一键更新会把你覆盖回官方包。
   DSH_PURGE_FORK_REPO=<owner>/dsh-purge node local/apply-local.mjs */
const forkRepo = process.env.DSH_PURGE_FORK_REPO
if (forkRepo) {
  patch('lib/update.js', [[
    `const REPO = "YuJunZhiXue/dsh-purge";`,
    `const REPO = "${forkRepo}";`,
    '更新源指向自己的 fork（update.js）',
  ]])
  patch('lib/redteam/ui.js', [[
    `  return 'YuJunZhiXue/dsh-purge'`,
    `  return '${forkRepo}'`,
    '更新源指向自己的 fork（面板）',
  ]])
} else {
  skip('未设置 DSH_PURGE_FORK_REPO：lib/update.js 与面板仍指向上游（上游发版会提示覆盖自己）')
}

/* ── 7. package.json 元数据自洽 ───────────────────────────────────────── */
/* 版本号用 `+local.N`（semver 构建元数据）：lib/update.js 的 splitVersion 只切 `-`，
   所以 1.1.86+local.1 的 core=[1,1,86]、pre=""，不会把上游 1.1.86 判成「有新版本」。
   若写成 1.1.86-local.1，pre="local.1" 会被判定比 1.1.86 旧，自检永远提示更新。 */
function pointPackageJsonAt(repo) {
  const p = join(root, 'package.json')
  const raw = readFileSync(p, 'utf8')
  const pkg = JSON.parse(raw)
  const upstreamVer = String(pkg.version || '0.0.0').split('+')[0].split('-')[0]
  const wantVersion = `${upstreamVer}+local.1`
  const set = (obj, path, value) => {
    const keys = path.split('.')
    let cur = obj
    for (const k of keys.slice(0, -1)) {
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
      cur = cur[k]
    }
    cur[keys[keys.length - 1]] = value
  }
  let changed = 0
  if (pkg.version !== wantVersion) { pkg.version = wantVersion; changed += 1 }
  if (repo) {
    const targets = [
      ['repository.url', `git+https://github.com/${repo}.git`],
      ['homepage', `https://github.com/${repo}#readme`],
      ['bugs.url', `https://github.com/${repo}/issues`],
      ['dsh.install.tarball', `https://codeload.github.com/${repo}/tar.gz/refs/heads/local`],
      ['dsh.install.zip', `https://codeload.github.com/${repo}/zip/refs/heads/local`],
      ['dsh.install.git', `https://github.com/${repo}.git`],
    ]
    for (const [path, value] of targets) {
      const keys = path.split('.')
      let cur = pkg
      for (const k of keys.slice(0, -1)) cur = cur && cur[k]
      const now = cur ? cur[keys[keys.length - 1]] : undefined
      if (now !== value) { set(pkg, path, value); changed += 1 }
    }
  }
  if (!changed) { skip('package.json :: 元数据已是本 fork 形态'); return }
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
  ok(`package.json :: version=${wantVersion}${repo ? '，repository/homepage/bugs/dsh.install 指向 ' + repo : ''}（${changed} 处）`)
}

pointPackageJsonAt(forkRepo)

/* ── 依赖文件存在性检查：新增模块不进补丁表，必须随仓库一起带 ─────────────── */
for (const f of ['lib/redteam/agent-activity.js']) {
  if (!existsSync(join(root, f))) steps.push('FAIL  ' + f + ' :: 缺失（该文件应由仓库自带，不靠补丁生成）')
  else ok(f + ' :: 存在')
}

/* ── 语法校验 ─────────────────────────────────────────────────────────── */
const touched = [...new Set(steps.filter((s) => s.startsWith('ok')).map((s) => s.slice(6).split(' :: ')[0]))]
for (const f of touched) {
  try {
    if (f.endsWith('.json')) {
      JSON.parse(readFileSync(join(root, f), 'utf8'))
      ok(`${f} :: JSON 解析通过`)
      continue
    }
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' })
    ok(`${f} :: node --check 通过`)
  } catch (e) {
    steps.push('FAIL  ' + f + ' :: ' + String(e.stderr || e.message).split('\n')[0])
  }
}

console.log(steps.join('\n'))
const failed = steps.filter((s) => s.startsWith('FAIL')).length
console.log(`\n合计 ${steps.length} 条，失败 ${failed} 条`)
process.exitCode = failed ? 1 : 0
