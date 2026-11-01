/**
 * 执行智能体「在跑」口径 —— 面板（ui.js）与并发闸门（tools.js）共用这一份实现。
 *
 * 为什么需要单独一层：`ctx.get('subagents')`（@deepseek-ai/dsh-subagent 的
 * SubagentRuntime）有两个长得很像、返回结构却完全不同的方法：
 *
 *   · listChildren(rootId)    → 父会话 `subagentCatalog` 投影的**原始目录条目**：
 *                               { id, createdAt, mode: 'one-shot'|'continuable'|'external'|'unknown', label? }
 *                               **没有 kind，也没有 activity**。
 *   · listDescendants(rootId) → 遍历过的行：
 *                               { kind: 'child'|'diagnostic', id, parentId, depth,
 *                                 activity: 'running'|'inactive', ... }
 *                               activity 由「该子会话是否仍活在 sessions 里」推出
 *                               （dsh-subagent：sessions.get(id) === undefined ? 'inactive' : 'running'）。
 *
 * v1.1.71 及之前，面板与闸门都拿 listChildren 的返回值去过滤
 * `kind === 'child' && activity === 'running'` —— 两个字段根本不存在，过滤结果恒为空数组，
 * 于是「在跑」永远是 0（面板显示「在跑 0 / 剩余 max」，闸门也看不见真实并发）。
 *
 * 正确做法：走 listDescendants，并按 parentId 只取**直接子会话**（一次派活）。
 * 孙级（执行智能体再往下派）不计入本项目标的并发名额。
 * 旧版 runtime 没有 listDescendants 时回退 listChildren + sessions 判活，
 * 活跃度口径与 dsh-subagent 内部保持一致。
 */

/** 取服务；ctx.get 在服务未加载时会抛，统一收敛成 undefined。 */
function serviceOf(ctx, name) {
  try {
    const value = ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/** 标签：优先 label，退回 id（与旧实现的 running_labels 结构一致）。 */
function labelOf(row) {
  return String(row.label !== undefined && row.label !== null && row.label !== '' ? row.label : row.id)
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/** 子会话是否仍活在本进程的 sessions 里（dsh-subagent 判 activity 用的同一判据）。 */
function isLive(sessions, id) {
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
  try {
    return sessions.get(id) !== undefined
  } catch {
    return undefined
  }
}

/**
 * 读 root 会话的直接子会话里「正在跑」的那部分。
 *
 * @param ctx - 插件上下文（要能取到 `subagents` / `sessions`）。
 * @param rootSessionId - 绑定的根会话 id（靶标隔离用的同一个键）。
 * @returns `{ available, running, running_labels, total_children, via, error? }`
 *   · available=false 表示注册表不可用（此时 running=0 不代表没在跑，调用方要如实说明）；
 *   · via 标明这次是用哪条路径读到的（descendants / children），便于排障。
 */
export async function readRunningChildren(ctx, rootSessionId) {
  const subagents = serviceOf(ctx, 'subagents')
  if (subagents === undefined || subagents === null) {
    return {
      available: false,
      running: 0,
      running_labels: [],
      total_children: 0,
      via: 'unavailable',
      error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）',
    }
  }
  const rootId = String(rootSessionId)
  const descendantsError = []

  /* ① 首选：listDescendants —— 唯一带 kind / activity 的入口 */
  if (typeof subagents.listDescendants === 'function') {
    try {
      const rows = await subagents.listDescendants(rootId)
      const children = (Array.isArray(rows) ? rows : []).filter((row) => row && row.kind === 'child')
      const direct = children.filter((row) => row.parentId === undefined || row.parentId === null
        || String(row.parentId) === rootId)
      const running = direct.filter((row) => row.activity === 'running')
      return {
        available: true,
        running: running.length,
        running_labels: running.map(labelOf).slice(0, 20),
        total_children: direct.length,
        via: 'descendants',
      }
    } catch (error) {
      descendantsError.push('listDescendants: ' + messageOf(error))
    }
  }

  /* ② 回退：listChildren（只有目录条目）+ sessions 判活 */
  if (typeof subagents.listChildren === 'function') {
    try {
      const entries = await subagents.listChildren(rootId)
      const rows = Array.isArray(entries) ? entries : []
      const sessions = serviceOf(ctx, 'sessions')
      /* external 子会话没有本地 session（宿在外部后端），判不了活跃度：
         不当成运行中，避免把「已结束的外部运行」永久算进并发名额。 */
      const local = rows.filter((row) => row && row.mode !== 'external')
      const running = local.filter((row) => isLive(sessions, row.id) === true)
      return {
        available: true,
        running: running.length,
        running_labels: running.map(labelOf).slice(0, 20),
        total_children: local.length,
        via: 'children',
      }
    } catch (error) {
      descendantsError.push('listChildren: ' + messageOf(error))
    }
  }

  return {
    available: false,
    running: 0,
    running_labels: [],
    total_children: 0,
    via: 'unavailable',
    error: descendantsError.length > 0 ? descendantsError.join('；') : 'subagents 注册表没有可用的子会话读取方法',
  }
}
