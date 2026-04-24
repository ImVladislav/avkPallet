import { readJson, writeJson } from '../helpers/jsonStore.js'
import { TASKS_FILE } from '../helpers/paths.js'
import { boardsPerPhysicalStrip } from '../helpers/alongLogPlan.js'
import { parseForemanOrderText } from '../helpers/parseForemanOrders.js'
import { buildForemanPlan } from '../helpers/foremanPlan.js'

const CAN_CREATE = ['foreman', 'admin']

function canCreateTasks(role) {
  return CAN_CREATE.includes(role)
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function listTasks(req, res) {
  const tasks = await readJson(TASKS_FILE, [])
  const sorted = [...tasks].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime()
    const tb = new Date(b.createdAt).getTime()
    return tb - ta
  })
  const role = req.user.role
  if (['foreman', 'admin'].includes(role)) {
    return res.json({ tasks: sorted })
  }
  const assignKey =
    role === 'sawyer'
      ? 'sawyer'
      : role === 'circular_operator'
        ? 'circular_operator'
        : role === 'pallet_assembly'
          ? 'pallet_assembly'
          : null
  if (!assignKey) {
    return res.status(403).json({ error: 'Немає доступу до завдань' })
  }
  return res.json({ tasks: sorted.filter((t) => t.assignTo.includes(assignKey)) })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function createTask(req, res) {
  if (!canCreateTasks(req.user.role)) {
    return res.status(403).json({ error: 'Лише бригадир або адмін можуть створювати завдання' })
  }

  const {
    title,
    orderText,
    unit = 'mm',
    radiusMm,
    kerfBandMm,
    kerfCircMm,
    assignTo,
  } = req.body ?? {}

  const t = String(title ?? '').trim()
  if (!t) {
    return res.status(400).json({ error: 'Вкажіть назву завдання' })
  }

  const order = String(orderText ?? '')
  const u = unit === 'cm' ? 'cm' : 'mm'
  const parsed = parseForemanOrderText(order, u)
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error })
  }

  const R = Number(radiusMm)
  const kb = Number(kerfBandMm)
  const kc = Number(kerfCircMm)
  if (!Number.isFinite(R) || R <= 0) {
    return res.status(400).json({ error: 'Некоректний радіус колоди' })
  }
  if (!Number.isFinite(kb) || kb < 0 || !Number.isFinite(kc) || kc < 0) {
    return res.status(400).json({ error: 'Некоректні пропили' })
  }

  const planRaw = buildForemanPlan(parsed.lines, R, kb, kc)
  const plan = {
    ...planRaw,
    band: planRaw.band.map((b) => ({ ...b, qtyDone: b.qtyDone ?? 0 })),
    circular: planRaw.circular.map((c) => ({ ...c, qtyDone: c.qtyDone ?? 0 })),
  }

  let assign = Array.isArray(assignTo) ? assignTo : ['sawyer', 'circular_operator']
  const allowed = new Set(['sawyer', 'circular_operator', 'pallet_assembly'])
  assign = assign.filter((x) => allowed.has(String(x)))
  if (assign.length === 0) assign = ['sawyer', 'circular_operator']

  const tasks = await readJson(TASKS_FILE, [])
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const now = new Date().toISOString()

  const task = {
    id,
    title: t,
    orderText: order,
    unit: u,
    radiusMm: R,
    kerfBandMm: kb,
    kerfCircMm: kc,
    assignTo: assign,
    plan,
    stripInventory: [],
    status: 'pending',
    createdAt: now,
    createdBy: {
      id: req.user.sub,
      username: req.user.username,
    },
  }

  tasks.push(task)
  await writeJson(TASKS_FILE, tasks)
  return res.status(201).json({ task })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function updateTask(req, res) {
  if (!canCreateTasks(req.user.role)) {
    return res.status(403).json({ error: 'Лише бригадир або адмін можуть змінювати завдання' })
  }

  const { id } = req.params
  const {
    title,
    orderText,
    unit = 'mm',
    radiusMm,
    kerfBandMm,
    kerfCircMm,
    assignTo,
  } = req.body ?? {}

  const t = String(title ?? '').trim()
  if (!t) {
    return res.status(400).json({ error: 'Вкажіть назву завдання' })
  }

  const order = String(orderText ?? '')
  const u = unit === 'cm' ? 'cm' : 'mm'
  const parsed = parseForemanOrderText(order, u)
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error })
  }

  const R = Number(radiusMm)
  const kb = Number(kerfBandMm)
  const kc = Number(kerfCircMm)
  if (!Number.isFinite(R) || R <= 0) {
    return res.status(400).json({ error: 'Некоректний радіус колоди' })
  }
  if (!Number.isFinite(kb) || kb < 0 || !Number.isFinite(kc) || kc < 0) {
    return res.status(400).json({ error: 'Некоректні пропили' })
  }

  const planRaw = buildForemanPlan(parsed.lines, R, kb, kc)
  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((task) => task.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const prev = tasks[idx]
  const prevByTh = new Map((prev.plan?.band ?? []).map((b) => [b.thicknessMm, b.qtyDone ?? 0]))
  const prevCircByTh = new Map(
    (prev.plan?.circular ?? []).map((c) => [c.thicknessMm, c.qtyDone ?? 0]),
  )
  const plan = {
    ...planRaw,
    band: planRaw.band.map((b) => ({
      ...b,
      qtyDone: Math.min(prevByTh.get(b.thicknessMm) ?? 0, b.qtyNeeded),
    })),
    circular: planRaw.circular.map((c) => ({
      ...c,
      qtyDone: Math.min(prevCircByTh.get(c.thicknessMm) ?? 0, c.qtyNeeded),
    })),
  }

  let assign = Array.isArray(assignTo) ? assignTo : ['sawyer', 'circular_operator']
  const allowed = new Set(['sawyer', 'circular_operator', 'pallet_assembly'])
  assign = assign.filter((x) => allowed.has(String(x)))
  if (assign.length === 0) assign = ['sawyer', 'circular_operator']

  const now = new Date().toISOString()
  const task = {
    ...prev,
    title: t,
    orderText: order,
    unit: u,
    radiusMm: R,
    kerfBandMm: kb,
    kerfCircMm: kc,
    assignTo: assign,
    plan,
    stripInventory: prev.stripInventory ?? [],
    updatedAt: now,
  }

  tasks[idx] = task
  await writeJson(TASKS_FILE, tasks)
  return res.json({ task })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function deleteTask(req, res) {
  if (!canCreateTasks(req.user.role)) {
    return res.status(403).json({ error: 'Лише бригадир або адмін можуть видаляти завдання' })
  }

  const { id } = req.params
  const tasks = await readJson(TASKS_FILE, [])
  const next = tasks.filter((t) => t.id !== id)
  if (next.length === tasks.length) {
    return res.status(404).json({ error: 'Завдання не знайдено' })
  }
  await writeJson(TASKS_FILE, next)
  return res.status(204).send()
}

/**
 * Ленточна: додати фактично зняті смуги (по товщині), накопичити для станка 2.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function recordBandCut(req, res) {
  const role = req.user.role
  if (!['sawyer', 'foreman', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Немає доступу' })
  }

  const { id } = req.params
  const { cuts, logLengthMm, stripWidthsByThicknessMm } = req.body ?? {}
  if (!Array.isArray(cuts) || cuts.length === 0) {
    return res.status(400).json({ error: 'Передайте cuts: [{ thicknessMm, stripQty }]' })
  }

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  if (role === 'sawyer' && !task.assignTo.includes('sawyer')) {
    return res.status(403).json({ error: 'Завдання не призначене на ленточну' })
  }

  const L = Number(logLengthMm)
  const logLen = Number.isFinite(L) && L > 0 ? Math.round(L) : 0
  if (logLen <= 0) {
    return res.status(400).json({ error: 'Вкажіть довжину використаної колоди logLengthMm (мм)' })
  }

  const addByTh = new Map()
  for (const c of cuts) {
    const th = Number(c.thicknessMm)
    const raw = Number(c.stripQty)
    if (!Number.isFinite(th) || th <= 0) {
      return res.status(400).json({ error: 'Некоректна товщина в cuts' })
    }
    if (!Number.isFinite(raw) || raw <= 0) {
      return res.status(400).json({ error: 'stripQty має бути числом > 0' })
    }
    const q = Math.round(raw)
    if (q <= 0 || Math.abs(raw - q) > 1e-6) {
      return res.status(400).json({ error: 'stripQty має бути цілим числом смуг' })
    }
    addByTh.set(th, (addByTh.get(th) ?? 0) + q)
  }

  for (const th of addByTh.keys()) {
    if (!task.plan.band.some((b) => b.thicknessMm === th)) {
      return res.status(400).json({ error: `Немає позиції ${th} мм у завданні` })
    }
  }

  const widthMap =
    stripWidthsByThicknessMm && typeof stripWidthsByThicknessMm === 'object'
      ? stripWidthsByThicknessMm
      : {}

  const orderParsed = parseForemanOrderText(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
  if (!orderParsed.ok) {
    return res.status(400).json({ error: `Замовлення в завданні: ${orderParsed.error}` })
  }
  const orderLines = orderParsed.lines
  const kerfCirc = Number(task.kerfCircMm) || 0

  /** physical strips per thickness; boards credited toward qtyDone */
  const stripsAppliedByTh = new Map()
  const boardsAppliedByTh = new Map()
  let appliedTotal = 0
  for (const th of addByTh.keys()) {
    const row = task.plan.band.find((b) => b.thicknessMm === th)
    const prev = row?.qtyDone ?? 0
    const need = row?.qtyNeeded ?? 0
    const rem = Math.max(0, need - prev)
    const wantStrips = addByTh.get(th) ?? 0
    const per = boardsPerPhysicalStrip(orderLines, th, logLen, kerfCirc)
    const maxStrips = per > 0 ? Math.ceil(rem / per) : rem
    const physicalStrips = Math.min(wantStrips, maxStrips)
    const appliedBoards = Math.min(physicalStrips * per, rem)
    stripsAppliedByTh.set(th, physicalStrips)
    boardsAppliedByTh.set(th, appliedBoards)
    appliedTotal += appliedBoards
  }

  if (appliedTotal <= 0) {
    return res.status(400).json({
      error:
        'За вказаними товщинами норма вже закрита (знято = потрібно). Оновіть сторінку або перевірте таблицю.',
    })
  }

  const recordedAt = new Date().toISOString()
  const newInv = [...(task.stripInventory ?? [])]
  for (const [th, stripQty] of stripsAppliedByTh) {
    if (stripQty <= 0) continue
    const widthsRaw = Array.isArray(widthMap[String(th)]) ? widthMap[String(th)] : []
    const widths = widthsRaw
      .map((x) => Math.round(Number(x)))
      .filter((x) => Number.isFinite(x) && x > 0)
      .slice(0, stripQty)

    if (widths.length === 0) {
      // Зворотна сумісність: якщо ширини не передали, зберігаємо старим агрегованим записом.
      newInv.push({ thicknessMm: th, qty: stripQty, logLengthMm: logLen, recordedAt })
      continue
    }

    for (let i = 0; i < stripQty; i += 1) {
      const w = widths[i]
      newInv.push({
        thicknessMm: th,
        qty: 1,
        logLengthMm: logLen,
        ...(w != null ? { stripWidthMm: w } : {}),
        recordedAt,
      })
    }
  }

  const nextBand = task.plan.band.map((b) => {
    const credited = boardsAppliedByTh.get(b.thicknessMm) ?? 0
    if (credited === 0) return { ...b }
    const prev = b.qtyDone ?? 0
    return { ...b, qtyDone: Math.min(b.qtyNeeded, prev + credited) }
  })

  const nextStatus = task.status === 'pending' ? 'in_progress' : task.status

  tasks[idx] = {
    ...task,
    plan: { ...task.plan, band: nextBand },
    stripInventory: newInv,
    status: nextStatus,
    updatedAt: recordedAt,
  }

  await writeJson(TASKS_FILE, tasks)
  return res.json({ task: tasks[idx] })
}

function stripIncomingQty(task, th) {
  const inv = task.stripInventory ?? []
  const thr = Math.round(Number(th))
  let s = 0
  for (const e of inv) {
    if (Math.round(Number(e.thicknessMm)) === thr) {
      const q = Math.round(Number(e.qty))
      if (Number.isFinite(q) && q > 0) s += q
    }
  }
  return s
}

function stripCutSumForThickness(task, th) {
  const cuts = task.stripSaw?.cuts ?? []
  const thr = Math.round(Number(th))
  let s = 0
  for (const c of cuts) {
    if (Math.round(Number(c.thicknessMm)) === thr) {
      const q = Math.round(Number(c.stripQty))
      if (Number.isFinite(q) && q > 0) s += q
    }
  }
  return s
}

function stripSawThicknessKey(th) {
  return String(Math.round(Number(th)))
}

function stripSawEffectiveRemainder(task, th) {
  const k = stripSawThicknessKey(th)
  const raw = task.stripSaw?.remainderOverrideByThicknessMm?.[k]
  if (raw !== undefined && raw !== null) {
    const r = Math.round(Number(raw))
    if (Number.isFinite(r)) return Math.max(0, r)
  }
  const incoming = stripIncomingQty(task, th)
  const cut = stripCutSumForThickness(task, th)
  return Math.max(0, incoming - cut)
}

/**
 * Станок 2: зареєструвати розпил (списати смуги з залишку після ленточної).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function normalizeBoardsByWidth(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const w = Math.round(Number(k))
    const q = Math.round(Number(v))
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(q) || q < 0) continue
    const key = String(w)
    out[key] = (out[key] ?? 0) + q
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export async function recordStripSawCut(req, res) {
  const role = req.user.role
  if (!['circular_operator', 'foreman', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Немає доступу' })
  }

  const { id } = req.params
  const { thicknessMm, stripQty, boardsTotal: boardsTotalBody, boardsByWidthMm: byWBody } =
    req.body ?? {}
  const th = Math.round(Number(thicknessMm))
  const raw = Number(stripQty)
  const qty = Math.round(raw)
  const btRaw = Number(boardsTotalBody)
  const boardsTotalIn = Math.round(btRaw)

  if (!Number.isFinite(th) || th <= 0) {
    return res.status(400).json({ error: 'Некоректна висота смуги thicknessMm' })
  }
  if (!Number.isFinite(raw) || raw <= 0 || qty <= 0 || Math.abs(raw - qty) > 1e-6) {
    return res.status(400).json({ error: 'stripQty має бути цілим числом > 0' })
  }
  if (!Number.isFinite(btRaw) || boardsTotalIn <= 0 || Math.abs(btRaw - boardsTotalIn) > 1e-6) {
    return res.status(400).json({
      error: 'Передайте boardsTotal — ціле число готових дощок (брусів) за цей розпил',
    })
  }

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  if (role === 'circular_operator' && !task.assignTo.includes('circular_operator')) {
    return res.status(403).json({ error: 'Завдання не призначене на станок 2' })
  }

  const rem = stripSawEffectiveRemainder(task, th)
  if (rem <= 0) {
    return res.status(400).json({ error: 'За цією висотою немає смуг у залишку' })
  }
  if (qty > rem) {
    return res.status(400).json({ error: `Залишок ${rem} смуг, не можна списати ${qty}` })
  }

  const circRows = task.plan?.circular ?? []
  const circIdx = circRows.findIndex((c) => Math.round(Number(c.thicknessMm)) === th)
  if (circIdx < 0) {
    return res.status(400).json({ error: 'Немає позиції цієї висоти в плані циркулярки' })
  }
  const circRow = circRows[circIdx]
  const circPrev = circRow.qtyDone ?? 0
  const circRem = Math.max(0, (circRow.qtyNeeded ?? 0) - circPrev)
  const boardsCredited = Math.min(boardsTotalIn, circRem)

  const byWidthNorm = normalizeBoardsByWidth(byWBody)
  const nextCircular = circRows.map((c, i) =>
    i === circIdx ? { ...c, qtyDone: circPrev + boardsCredited } : { ...c },
  )

  const k = stripSawThicknessKey(th)
  const prevSaw = task.stripSaw ?? { cuts: [] }
  const recordedAt = new Date().toISOString()
  const nextCuts = [
    ...(prevSaw.cuts ?? []),
    {
      thicknessMm: th,
      stripQty: qty,
      boardsTotal: boardsTotalIn,
      boardsCredited,
      ...(byWidthNorm ? { boardsByWidthMm: byWidthNorm } : {}),
      recordedAt,
    },
  ]

  const override = { ...(prevSaw.remainderOverrideByThicknessMm ?? {}) }
  if (k in override) {
    const cur = Math.round(Number(override[k]))
    const nextOv = Math.max(0, cur - qty)
    if (nextOv <= 0) delete override[k]
    else override[k] = nextOv
  }

  const nextStripSaw = {
    cuts: nextCuts,
    ...(Object.keys(override).length > 0 ? { remainderOverrideByThicknessMm: override } : {}),
  }

  tasks[idx] = {
    ...task,
    plan: { ...task.plan, circular: nextCircular },
    stripSaw: nextStripSaw,
    status: task.status === 'pending' ? 'in_progress' : task.status,
    updatedAt: recordedAt,
  }

  await writeJson(TASKS_FILE, tasks)
  return res.json({ task: tasks[idx] })
}

/**
 * Станок 2: вручну задати залишок смуг (або скинути корекцію — remainder: null).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function patchStripSawRemainder(req, res) {
  const role = req.user.role
  if (!['circular_operator', 'foreman', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Немає доступу' })
  }

  const { id } = req.params
  const { thicknessMm, remainder } = req.body ?? {}
  const th = Math.round(Number(thicknessMm))
  if (!Number.isFinite(th) || th <= 0) {
    return res.status(400).json({ error: 'Некоректна висота смуги thicknessMm' })
  }

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  if (role === 'circular_operator' && !task.assignTo.includes('circular_operator')) {
    return res.status(403).json({ error: 'Завдання не призначене на станок 2' })
  }

  const k = stripSawThicknessKey(th)
  const incoming = stripIncomingQty(task, th)
  const prevSaw = task.stripSaw ?? { cuts: [] }

  if (remainder === null) {
    const override = { ...(prevSaw.remainderOverrideByThicknessMm ?? {}) }
    delete override[k]
    const nextStripSaw = {
      cuts: prevSaw.cuts ?? [],
      ...(Object.keys(override).length > 0 ? { remainderOverrideByThicknessMm: override } : {}),
    }
    tasks[idx] = { ...task, stripSaw: nextStripSaw, updatedAt: new Date().toISOString() }
    await writeJson(TASKS_FILE, tasks)
    return res.json({ task: tasks[idx] })
  }

  const R = Math.round(Number(remainder))
  if (!Number.isFinite(R) || R < 0) {
    return res.status(400).json({ error: 'Залишок має бути невід’ємним цілим числом' })
  }
  if (R > incoming) {
    return res.status(400).json({
      error: `Залишок не може перевищувати надійшло з ленточної (${incoming} шт)`,
    })
  }
  const cutSum = stripCutSumForThickness(task, th)
  if (cutSum + R > incoming) {
    return res.status(400).json({
      error: `Записано розпилів ${cutSum} шт, залишок ${R} — разом більше за надійшло (${incoming})`,
    })
  }

  const override = { ...(prevSaw.remainderOverrideByThicknessMm ?? {}), [k]: R }
  const nextStripSaw = {
    cuts: prevSaw.cuts ?? [],
    remainderOverrideByThicknessMm: override,
  }

  tasks[idx] = { ...task, stripSaw: nextStripSaw, updatedAt: new Date().toISOString() }
  await writeJson(TASKS_FILE, tasks)
  return res.json({ task: tasks[idx] })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function patchTask(req, res) {
  const { id } = req.params
  const { status } = req.body ?? {}
  const allowedStatus = ['pending', 'in_progress', 'done']
  if (!allowedStatus.includes(String(status))) {
    return res.status(400).json({ error: 'Некоректний статус' })
  }

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  const role = req.user.role
  if (['foreman', 'admin'].includes(role)) {
    // ok
  } else if (['sawyer', 'circular_operator', 'pallet_assembly'].includes(role)) {
    if (!task.assignTo.includes(role)) {
      return res.status(403).json({ error: 'Завдання не призначене для вашої ролі' })
    }
  } else {
    return res.status(403).json({ error: 'Немає прав на зміну' })
  }

  tasks[idx] = { ...tasks[idx], status: String(status), updatedAt: new Date().toISOString() }
  await writeJson(TASKS_FILE, tasks)
  return res.json({ task: tasks[idx] })
}
