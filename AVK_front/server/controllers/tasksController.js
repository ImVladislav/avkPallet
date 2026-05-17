import { readJson, writeJson } from '../helpers/jsonStore.js'
import { TASKS_FILE } from '../helpers/paths.js'
import { boardsPerPhysicalStrip } from '../helpers/alongLogPlan.js'
import {
  parseForemanOrderText,
  parseForemanOrderTextOrEmpty,
  adHocBandThicknessesFromDimensionRows,
} from '../helpers/parseForemanOrders.js'
import { buildForemanPlan, mergeOpenSecondaryDimensionRowsIntoPlanOrders } from '../helpers/foremanPlan.js'

const CAN_CREATE = ['foreman', 'admin', 'super_admin']

const PALLET_RECIPES = [
  {
    id: 'euro-1200x800',
    name: 'EUR 1200×800',
    materials: [
      { thicknessMm: 22, widthMm: 100, lengthMm: 1200, qty: 8 },
      { thicknessMm: 78, widthMm: 100, lengthMm: 1200, qty: 3 },
      { thicknessMm: 100, widthMm: 100, lengthMm: 145, qty: 9 },
    ],
  },
  {
    id: 'industrial-1200x1000',
    name: 'Industrial 1200×1000',
    materials: [
      { thicknessMm: 22, widthMm: 100, lengthMm: 1200, qty: 9 },
      { thicknessMm: 78, widthMm: 100, lengthMm: 1200, qty: 3 },
      { thicknessMm: 100, widthMm: 100, lengthMm: 145, qty: 9 },
    ],
  },
  {
    id: 'stringer-1200x800',
    name: 'Легкий 1200×800',
    materials: [
      { thicknessMm: 20, widthMm: 80, lengthMm: 1200, qty: 5 },
      { thicknessMm: 40, widthMm: 80, lengthMm: 800, qty: 3 },
    ],
  },
]

function canCreateTasks(role) {
  return CAN_CREATE.includes(role)
}

const STATION_KEYS = ['band_saw', 'strip_saw', 'circular_saw', 'pallets']

function userHasTab(user, tab) {
  return Array.isArray(user?.tabs) && user.tabs.includes(tab)
}

function userCanStation(user, station) {
  const role = user?.role
  if (['foreman', 'admin', 'super_admin'].includes(role)) return true
  if (station === 'band_saw') return role === 'sawyer' || userHasTab(user, 'band_saw')
  if (station === 'strip_saw') return role === 'circular_operator' || userHasTab(user, 'strip_saw')
  if (station === 'circular_saw') return role === 'circular_operator' || userHasTab(user, 'circular_saw')
  if (station === 'pallets') return role === 'pallet_assembly' || userHasTab(user, 'pallets')
  return false
}

function taskMatchesUserAccess(user, task) {
  const assign = Array.isArray(task.assignTo) ? task.assignTo : []
  const role = user?.role
  if (assign.includes(role)) return true
  if (userCanStation(user, 'band_saw') && assign.includes('sawyer')) return true
  if (userCanStation(user, 'strip_saw') && assign.includes('circular_operator')) return true
  if (userCanStation(user, 'circular_saw') && assign.includes('circular_operator')) return true
  if (userCanStation(user, 'pallets') && assign.includes('pallet_assembly')) return true

  const stations = task.stationAssignments
  if (!stations || typeof stations !== 'object') return false
  const uid = String(user?.sub ?? '')
  return STATION_KEYS.some((key) => {
    if (!userCanStation(user, key)) return false
    const ids = Array.isArray(stations[key]) ? stations[key].map((x) => String(x)) : []
    return ids.includes(uid)
  })
}

function sanitizeDimensionRows(raw) {
  if (!Array.isArray(raw)) return undefined
  const rows = raw
    .map((row) => {
      const source = row && typeof row === 'object' ? row : {}
      return {
        kind: source.kind === 'secondary' ? 'secondary' : 'main',
        qty: String(source.qty ?? '').trim(),
        height: String(source.height ?? '').trim(),
        width: String(source.width ?? '').trim(),
        length: String(source.length ?? '').trim(),
      }
    })
    .filter((row) => {
      if (!row.height || !row.width) return false
      if (row.kind === 'secondary' && !row.qty) return true
      return !!row.qty
    })
  return rows.length > 0 ? rows : undefined
}

const TASK_KIND_SET = new Set(['resaw', 'circular', 'pallets'])

/** @param {unknown} raw */
function normalizeTaskKind(raw) {
  const s = String(raw ?? '').trim()
  return TASK_KIND_SET.has(s) ? s : 'resaw'
}

/** @param {string} kind */
function assignDefaultForTaskKind(kind) {
  if (kind === 'pallets') return ['pallet_assembly']
  if (kind === 'circular') return ['circular_operator']
  return ['sawyer', 'circular_operator']
}

/** @param {unknown} raw */
function sanitizePalletTarget(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const id = String(/** @type {{ palletTypeId?: string }} */ (raw).palletTypeId ?? '').trim()
  const qty = Math.round(Number(/** @type {{ qty?: unknown }} */ (raw).qty))
  const recipe = PALLET_RECIPES.find((r) => r.id === id)
  if (!recipe) return undefined
  if (!Number.isFinite(qty) || qty < 1) return undefined
  return { palletTypeId: id, palletTypeName: recipe.name, qty }
}

function buildPlanFromParsedLines(lines, R, kb, kc, dimensionRows, unit) {
  const dim = Array.isArray(dimensionRows) ? dimensionRows : []
  const merged = mergeOpenSecondaryDimensionRowsIntoPlanOrders(lines, dim, unit, R, kb, kc)
  const planRaw = buildForemanPlan(merged, R, kb, kc)
  return {
    ...planRaw,
    band: planRaw.band.map((b) => ({ ...b, qtyDone: b.qtyDone ?? 0 })),
    circular: planRaw.circular.map((c) => ({ ...c, qtyDone: c.qtyDone ?? 0 })),
    dimensionRows: dim,
  }
}

function palletMaterialKey(line) {
  return `${Math.round(Number(line.thicknessMm))}|${Math.round(Number(line.widthMm))}|${Math.round(Number(line.lengthMm))}`
}

function palletStockForTask(task) {
  const stock = new Map()
  for (const cut of task.circularSaw?.cuts ?? []) {
    const q = Math.round(Number(cut.qty))
    if (!Number.isFinite(q) || q <= 0) continue
    const key = palletMaterialKey(cut)
    stock.set(key, (stock.get(key) ?? 0) + q)
  }
  for (const build of task.palletAssembly?.builds ?? []) {
    const buildQty = Math.max(1, Math.round(Number(build.qty) || 1))
    for (const line of build.materials ?? []) {
      const q = Math.round(Number(line.qty))
      if (!Number.isFinite(q) || q <= 0) continue
      const key = palletMaterialKey(line)
      stock.set(key, (stock.get(key) ?? 0) - q * buildQty)
    }
  }
  return stock
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
  if (['foreman', 'admin', 'super_admin'].includes(role)) {
    return res.json({ tasks: sorted })
  }
  if (!['sawyer', 'circular_operator', 'pallet_assembly'].includes(role) && !Array.isArray(req.user.tabs)) {
    return res.status(403).json({ error: 'Немає доступу до завдань' })
  }
  return res.json({ tasks: sorted.filter((t) => taskMatchesUserAccess(req.user, t)) })
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
    dimensionRows,
    taskKind: taskKindBody,
    palletTarget: palletTargetBody,
  } = req.body ?? {}

  const taskKind = normalizeTaskKind(taskKindBody)
  const palletTargetClean = sanitizePalletTarget(palletTargetBody)

  const t = String(title ?? '').trim()
  if (!t) {
    return res.status(400).json({ error: 'Вкажіть назву завдання' })
  }

  if (taskKind === 'pallets' && !palletTargetClean) {
    return res.status(400).json({ error: 'Для збірки вкажіть тип піддону та кількість' })
  }

  let order = String(orderText ?? '').trim()
  const u = unit === 'cm' ? 'cm' : 'mm'
  const dimClean = sanitizeDimensionRows(dimensionRows)

  /** @type {{ ok: true, lines: { qty: number, aMm: number, bMm: number, lengthMm: number }[] }} */
  let parsed
  if (taskKind === 'pallets') {
    parsed = { ok: true, lines: [] }
    if (!order) order = `${palletTargetClean.qty} шт × ${palletTargetClean.palletTypeName}`
  } else {
    if (!order) {
      if (!dimClean || dimClean.length === 0) {
        return res.status(400).json({ error: 'Додайте рядки розмірів або замовлення' })
      }
      parsed = { ok: true, lines: [] }
    } else {
      parsed = parseForemanOrderText(order, u)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }
    }
    if (taskKind === 'circular') {
      const bad = parsed.lines.some((l) => !(Number(l.lengthMm) > 0))
      if (bad) {
        return res.status(400).json({
          error: 'Для циркулярки кожен рядок має містити довжину (четверте число)',
        })
      }
    }
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

  const plan = buildPlanFromParsedLines(parsed.lines, R, kb, kc, dimClean, u)
  const assign = assignDefaultForTaskKind(taskKind)

  const tasks = await readJson(TASKS_FILE, [])
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const now = new Date().toISOString()

  const task = {
    id,
    title: t,
    taskKind,
    orderText: order,
    ...(dimClean && dimClean.length > 0 ? { dimensionRows: dimClean } : {}),
    ...(palletTargetClean && taskKind === 'pallets' ? { palletTarget: palletTargetClean } : {}),
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
    dimensionRows,
    taskKind: taskKindBody,
    palletTarget: palletTargetBody,
  } = req.body ?? {}

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((task) => task.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const prev = tasks[idx]
  const taskKindResolved =
    taskKindBody !== undefined && taskKindBody !== null
      ? normalizeTaskKind(taskKindBody)
      : normalizeTaskKind(prev.taskKind)

  const palletTargetClean = sanitizePalletTarget(palletTargetBody)

  const t = String(title ?? '').trim()
  if (!t) {
    return res.status(400).json({ error: 'Вкажіть назву завдання' })
  }

  if (taskKindResolved === 'pallets' && !palletTargetClean) {
    return res.status(400).json({ error: 'Для збірки вкажіть тип піддону та кількість' })
  }

  let order = String(orderText ?? '').trim()
  const u = unit === 'cm' ? 'cm' : 'mm'
  const dimClean = sanitizeDimensionRows(dimensionRows)

  /** @type {{ ok: true, lines: { qty: number, aMm: number, bMm: number, lengthMm: number }[] }} */
  let parsed
  if (taskKindResolved === 'pallets') {
    parsed = { ok: true, lines: [] }
    if (!order) order = `${palletTargetClean.qty} шт × ${palletTargetClean.palletTypeName}`
  } else {
    if (!order) {
      if (!dimClean || dimClean.length === 0) {
        return res.status(400).json({ error: 'Додайте рядки розмірів або замовлення' })
      }
      parsed = { ok: true, lines: [] }
    } else {
      parsed = parseForemanOrderText(order, u)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }
    }
    if (taskKindResolved === 'circular') {
      const bad = parsed.lines.some((l) => !(Number(l.lengthMm) > 0))
      if (bad) {
        return res.status(400).json({
          error: 'Для циркулярки кожен рядок має містити довжину (четверте число)',
        })
      }
    }
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

  const prevByTh = new Map((prev.plan?.band ?? []).map((b) => [b.thicknessMm, b.qtyDone ?? 0]))
  const prevCircByTh = new Map(
    (prev.plan?.circular ?? []).map((c) => [c.thicknessMm, c.qtyDone ?? 0]),
  )
  const planRaw = buildPlanFromParsedLines(parsed.lines, R, kb, kc, dimClean, u)
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

  const assign = assignDefaultForTaskKind(taskKindResolved)

  const now = new Date().toISOString()
  const task = {
    ...prev,
    title: t,
    taskKind: taskKindResolved,
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
  if (dimClean && dimClean.length > 0) {
    task.dimensionRows = dimClean
  } else {
    delete task.dimensionRows
  }
  if (taskKindResolved === 'resaw' || taskKindResolved === 'circular') {
    delete task.palletTarget
  } else if (palletTargetClean && taskKindResolved === 'pallets') {
    task.palletTarget = palletTargetClean
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
  if (!userCanStation(req.user, 'band_saw')) {
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
    const raw = Number(c.doneQty ?? c.stripQty)
    if (!Number.isFinite(th) || th <= 0) {
      return res.status(400).json({ error: 'Некоректна товщина в cuts' })
    }
    if (!Number.isFinite(raw) || raw <= 0) {
      return res.status(400).json({ error: 'Передайте doneQty або stripQty (ціле число смуг) > 0' })
    }
    const q = Math.round(raw)
    if (q <= 0 || Math.abs(raw - q) > 1e-6) {
      return res.status(400).json({ error: 'Кількість смуг має бути цілим числом' })
    }
    addByTh.set(th, (addByTh.get(th) ?? 0) + q)
  }

  const dimensionRows =
    Array.isArray(task.dimensionRows) && task.dimensionRows.length > 0
      ? task.dimensionRows
      : Array.isArray(task.plan?.dimensionRows) && task.plan.dimensionRows.length > 0
        ? task.plan.dimensionRows
        : []
  const allowedAdHocTh = adHocBandThicknessesFromDimensionRows(
    dimensionRows,
    task.unit === 'cm' ? 'cm' : 'mm',
  )

  for (const th of addByTh.keys()) {
    const inPlan = task.plan.band.some((b) => b.thicknessMm === th)
    if (!inPlan && !allowedAdHocTh.has(th)) {
      return res
        .status(400)
        .json({ error: `Немає позиції ${th} мм у завданні або серед побічних розмірів` })
    }
  }

  const widthMap =
    stripWidthsByThicknessMm && typeof stripWidthsByThicknessMm === 'object'
      ? stripWidthsByThicknessMm
      : {}

  const orderParsed = parseForemanOrderTextOrEmpty(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
  if (!orderParsed.ok) {
    return res.status(400).json({ error: `Замовлення в завданні: ${orderParsed.error}` })
  }
  const orderLines = orderParsed.lines
  const kerfCirc = Number(task.kerfCircMm) || 0

  /** physical strips per thickness; boards credited toward qtyDone; зайве за норму — на склад для побічних товщин */
  const stripsToInventory = new Map()
  const boardsAppliedByTh = new Map()

  for (const th of addByTh.keys()) {
    const wantStripsTotal = addByTh.get(th) ?? 0
    const row = task.plan.band.find((b) => b.thicknessMm === th)
    const prev = row?.qtyDone ?? 0
    const need = row?.qtyNeeded ?? 0
    const rem = Math.max(0, need - prev)
    const per = boardsPerPhysicalStrip(orderLines, th, logLen, kerfCirc)

    let planStrips = 0
    let boardsFromStrips = 0
    if (rem > 0) {
      const maxStripsForRemainder = per > 0 ? Math.ceil(rem / per) : rem
      planStrips = Math.min(Math.max(0, wantStripsTotal), maxStripsForRemainder)
      boardsFromStrips = Math.min(planStrips * per, rem)
    }

    const leftoverStrips = wantStripsTotal - planStrips
    let extraStrips = 0
    if (leftoverStrips > 0) {
      if (allowedAdHocTh.has(th)) {
        extraStrips = leftoverStrips
      } else if (!row) {
        return res.status(400).json({ error: `Товщина ${th} мм не входить у план смуг завдання` })
      } else if (rem <= 0) {
        return res.status(400).json({
          error: `Для ${th} мм план уже закритий; додаткові смуги дозволені лише для побічних розмірів з замовлення`,
        })
      } else {
        return res.status(400).json({ error: `Занадто багато смуг для ${th} мм відносно залишку плану` })
      }
    }

    const totalToInventory = planStrips + extraStrips
    if (totalToInventory > 0) stripsToInventory.set(th, totalToInventory)
    if (boardsFromStrips > 0) boardsAppliedByTh.set(th, boardsFromStrips)
  }

  const physicalTotal = [...stripsToInventory.values()].reduce((sum, qty) => sum + qty, 0)
  if (physicalTotal <= 0) {
    return res.status(400).json({
      error: 'Додайте хоча б одну фактично зняту смугу.',
    })
  }

  const recordedAt = new Date().toISOString()
  const newInv = [...(task.stripInventory ?? [])]
  for (const [th, stripQty] of stripsToInventory) {
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

/** Сума вже зарахованих дощок по цій товщині з попередніх записів strip-saw (для відновлення plan.circular). */
function stripSawBoardsCreditedSumForThickness(task, th) {
  const thr = Math.round(Number(th))
  const cuts = task.stripSaw?.cuts ?? []
  let s = 0
  for (const c of cuts) {
    if (Math.round(Number(c.thicknessMm)) !== thr) continue
    const bc = Number(c.boardsCredited)
    if (Number.isFinite(bc) && bc > 0) {
      s += Math.round(bc)
      continue
    }
    const bt = Number(c.boardsTotal)
    if (Number.isFinite(bt) && bt > 0) s += Math.round(bt)
  }
  return s
}

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

/**
 * Станок 2: зареєструвати розпил (списати смуги з залишку після ленточної).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function recordStripSawCut(req, res) {
  const role = req.user.role
  if (!userCanStation(req.user, 'strip_saw')) {
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

  let circRows = Array.isArray(task.plan?.circular) ? [...task.plan.circular] : []
  let circIdx = circRows.findIndex((c) => Math.round(Number(c.thicknessMm)) === th)
  if (circIdx < 0) {
    const bandRow = (task.plan?.band ?? []).find((b) => Math.round(Number(b.thicknessMm)) === th)
    const baseNeed = bandRow ? Math.max(0, Math.round(Number(bandRow.qtyNeeded) || 0)) : 0
    const priorBoards = stripSawBoardsCreditedSumForThickness(task, th)
    const qtyNeededNew = Math.max(baseNeed, boardsTotalIn, priorBoards + boardsTotalIn)
    if (!Number.isFinite(qtyNeededNew) || qtyNeededNew <= 0) {
      return res.status(400).json({ error: 'Немає позиції цієї висоти в плані циркулярки' })
    }
    circRows.push({
      thicknessMm: th,
      qtyNeeded: qtyNeededNew,
      avgChordMm: 0,
      avgBoardWidthMm: 0,
      circularCutsPerCrossSection: 0,
      circularCutsTotalEstimate: 0,
      qtyDone: 0,
    })
    circIdx = circRows.length - 1
  }
  let circRow = circRows[circIdx]
  let circPrev = Math.max(0, Math.round(Number(circRow.qtyDone) || 0))
  let qtyNeeded = Math.max(0, Math.round(Number(circRow.qtyNeeded) || 0))
  let circRem = Math.max(0, qtyNeeded - circPrev)
  let boardsCredited = Math.min(boardsTotalIn, circRem)

  if (boardsCredited < boardsTotalIn) {
    const expandedNeed = circPrev + boardsTotalIn
    qtyNeeded = Math.max(qtyNeeded, expandedNeed)
    circRow = { ...circRow, qtyNeeded }
    circRows[circIdx] = circRow
    circRem = Math.max(0, qtyNeeded - circPrev)
    boardsCredited = Math.min(boardsTotalIn, circRem)
  }

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
      recordedBy: { id: req.user.sub, username: req.user.username },
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
  if (!['circular_operator', 'foreman', 'admin', 'super_admin'].includes(role)) {
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
 * Циркулярка: записати факт розкрою бруса по довжині.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function recordCircularSawCut(req, res) {
  const role = req.user.role
  if (!userCanStation(req.user, 'circular_saw')) {
    return res.status(403).json({ error: 'Немає доступу' })
  }

  const { id } = req.params
  const { thicknessMm, widthMm, lengthMm, qty } = req.body ?? {}
  const th = Math.round(Number(thicknessMm))
  const w = Math.round(Number(widthMm))
  const len = Math.round(Number(lengthMm))
  const rawQty = Number(qty)
  const q = Math.round(rawQty)

  if (!Number.isFinite(th) || th <= 0) {
    return res.status(400).json({ error: 'Некоректна товщина бруса' })
  }
  if (!Number.isFinite(w) || w <= 0) {
    return res.status(400).json({ error: 'Некоректна ширина бруса' })
  }
  if (!Number.isFinite(len) || len <= 0) {
    return res.status(400).json({ error: 'Некоректна довжина деталі' })
  }
  if (!Number.isFinite(rawQty) || q <= 0 || Math.abs(rawQty - q) > 1e-6) {
    return res.status(400).json({ error: 'Кількість має бути цілим числом > 0' })
  }

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  if (role === 'circular_operator' && !task.assignTo.includes('circular_operator')) {
    return res.status(403).json({ error: 'Завдання не призначене на циркулярку' })
  }

  const recordedAt = new Date().toISOString()
  const prevSaw = task.circularSaw ?? { cuts: [] }
  const nextCuts = [
    ...(prevSaw.cuts ?? []),
    {
      thicknessMm: th,
      widthMm: w,
      lengthMm: len,
      qty: q,
      recordedBy: { id: req.user.sub, username: req.user.username },
      recordedAt,
    },
  ]

  tasks[idx] = {
    ...task,
    circularSaw: { cuts: nextCuts },
    status: task.status === 'pending' ? 'in_progress' : task.status,
    updatedAt: recordedAt,
  }
  await writeJson(TASKS_FILE, tasks)
  return res.json({ task: tasks[idx] })
}

/**
 * Циркулярка: скасувати останній запис розкрою (помилка оператора).
 * Оператор — лише свій запис; бригадир / адмін — будь-який останній.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function undoLastCircularSawCut(req, res) {
  const role = req.user.role
  if (!userCanStation(req.user, 'circular_saw')) {
    return res.status(403).json({ error: 'Немає доступу' })
  }

  const { id } = req.params
  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  if (role === 'circular_operator' && !task.assignTo.includes('circular_operator')) {
    return res.status(403).json({ error: 'Завдання не призначене на циркулярку' })
  }

  const cuts = task.circularSaw?.cuts ?? []
  if (cuts.length === 0) {
    return res.status(400).json({ error: 'Немає записів розкрою для скасування' })
  }

  const last = cuts[cuts.length - 1]
  const privileged = ['foreman', 'admin', 'super_admin'].includes(role)
  const lastAuthor = last?.recordedBy?.id != null ? String(last.recordedBy.id) : ''
  if (!privileged) {
    if (!lastAuthor || lastAuthor !== String(req.user.sub)) {
      return res.status(403).json({
        error: 'Можна скасувати лише власний останній запис. Зверніться до бригадира.',
      })
    }
  }

  const nextCuts = cuts.slice(0, -1)
  const recordedAt = new Date().toISOString()
  const updated = {
    ...task,
    updatedAt: recordedAt,
  }
  if (nextCuts.length > 0) {
    updated.circularSaw = { cuts: nextCuts }
  } else {
    delete updated.circularSaw
  }

  tasks[idx] = updated
  await writeJson(TASKS_FILE, tasks)
  return res.json({ task: tasks[idx] })
}

/**
 * Складання піддонів: списати готові деталі з циркулярки і записати зібрані піддони.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function buildPallets(req, res) {
  const role = req.user.role
  if (!userCanStation(req.user, 'pallets')) {
    return res.status(403).json({ error: 'Немає доступу' })
  }

  const { id } = req.params
  const { palletTypeId, qty } = req.body ?? {}
  const qRaw = Number(qty)
  const buildQty = Math.round(qRaw)
  if (!Number.isFinite(qRaw) || buildQty <= 0 || Math.abs(qRaw - buildQty) > 1e-6) {
    return res.status(400).json({ error: 'Кількість піддонів має бути цілим числом > 0' })
  }

  const recipe = PALLET_RECIPES.find((x) => x.id === String(palletTypeId))
  if (!recipe) {
    return res.status(400).json({ error: 'Невідомий тип піддону' })
  }

  const tasks = await readJson(TASKS_FILE, [])
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Завдання не знайдено' })

  const task = tasks[idx]
  if (role === 'pallet_assembly' && !task.assignTo.includes('pallet_assembly')) {
    return res.status(403).json({ error: 'Завдання не призначене на збірку піддонів' })
  }

  const stock = palletStockForTask(task)
  const missing = []
  for (const line of recipe.materials) {
    const need = line.qty * buildQty
    const have = stock.get(palletMaterialKey(line)) ?? 0
    if (have < need) {
      missing.push({ ...line, need, have })
    }
  }
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Недостатньо матеріалу для піддону',
      missing,
    })
  }

  const recordedAt = new Date().toISOString()
  const prev = task.palletAssembly ?? { builds: [] }
  const nextBuilds = [
    ...(prev.builds ?? []),
    {
      palletTypeId: recipe.id,
      palletTypeName: recipe.name,
      qty: buildQty,
      materials: recipe.materials,
      recordedAt,
    },
  ]

  tasks[idx] = {
    ...task,
    palletAssembly: { builds: nextBuilds },
    status: task.status === 'pending' ? 'in_progress' : task.status,
    updatedAt: recordedAt,
  }
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
  if (['foreman', 'admin', 'super_admin'].includes(role)) {
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
