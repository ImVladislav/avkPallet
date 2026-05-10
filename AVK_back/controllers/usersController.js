import { readJson, writeJson } from '../helpers/jsonStore.js'
import { ROUNDWOOD_FILE, TASKS_FILE, USERS_FILE } from '../helpers/paths.js'
import { hashPassword } from '../helpers/password.js'
import { ROLE_TABS } from '../helpers/roles.js'
import { publicUser, sanitizeTabs } from '../helpers/userTabs.js'
import { SalaryConfigModel } from '../db/models/salaryConfigModel.js'

const ROLES = Object.keys(ROLE_TABS)
const STATION_KEYS = ['band_saw', 'strip_saw', 'circular_saw', 'pallets']
const STATION_ROLE_MAP = {
  band_saw: 'sawyer',
  strip_saw: 'circular_operator',
  circular_saw: 'circular_operator',
  pallets: 'pallet_assembly',
}
const DEFAULT_SALARY_RATES = {
  band_saw: 900,
  strip_saw: 700,
  circular_saw: 700,
  pallets: 600,
}

function newUserId() {
  return `u-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function monthKey(isoDate) {
  const d = new Date(isoDate)
  if (!Number.isFinite(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function roundwoodVolumeM3(entry) {
  const explicit = Number(entry?.volumeM3)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const radiusMm = Number(entry?.radiusMm)
  const lengthMm = Number(entry?.lengthMm)
  if (!Number.isFinite(radiusMm) || radiusMm <= 0 || !Number.isFinite(lengthMm) || lengthMm <= 0) {
    return 0
  }
  return (Math.PI * radiusMm * radiusMm * lengthMm) / 1_000_000_000
}

function roundwoodVolumeByTask(journal) {
  const map = new Map()
  for (const entry of journal) {
    if (entry?.kind !== 'band_consumed' || !entry.taskId) continue
    const taskId = String(entry.taskId)
    map.set(taskId, (map.get(taskId) ?? 0) + roundwoodVolumeM3(entry))
  }
  return map
}

function salaryBasisForStationObj(station, task, roundwoodByTask) {
  if (station === 'band_saw' || station === 'strip_saw') {
    const qty = roundwoodByTask.get(String(task.id)) ?? 0
    return { qty, unit: 'm3' }
  }
  return { qty: 1, unit: 'task' }
}

function stationsForUser(role, tabs) {
  const out = new Set()
  const t = Array.isArray(tabs) ? tabs : []
  if (role === 'sawyer') out.add('band_saw')
  if (role === 'circular_operator') {
    out.add('strip_saw')
    out.add('circular_saw')
  }
  if (role === 'pallet_assembly') out.add('pallets')
  if (t.includes('band_saw')) out.add('band_saw')
  if (t.includes('strip_saw')) out.add('strip_saw')
  if (t.includes('circular_saw')) out.add('circular_saw')
  if (t.includes('pallets')) out.add('pallets')
  return [...out]
}

function fallbackStationsForTask(role, tabs, task) {
  const availableStations = stationsForUser(role, tabs)
  if (role === 'circular_operator' && availableStations.includes('circular_saw')) {
    return ['circular_saw']
  }
  const taskHasStripFact = (task.stripSaw?.cuts ?? []).length > 0
  if (taskHasStripFact && availableStations.includes('strip_saw')) {
    return ['strip_saw']
  }
  return availableStations
}

/**
 * Рядки нарахування для одного користувача (логіка як у фронті «Моя ЗП»).
 * @param {any[]} tasks
 * @param {any} user
 * @param {Record<string, number>} rates
 * @param {Map<string, number>} roundwoodByTask
 */
function salaryRowsForOneUser(tasks, user, rates, roundwoodByTask) {
  const rows = []
  const userId = String(user.id)
  const role = String(user?.role ?? '')
  const tabs = Array.isArray(user.tabs) ? user.tabs : []

  for (const task of tasks) {
    if (task.status !== 'done') continue
    const stamp = String(task.updatedAt ?? task.createdAt ?? '')
    const stationAssignments =
      task.stationAssignments && typeof task.stationAssignments === 'object'
        ? task.stationAssignments
        : null
    const paidStations = new Set()

    const hasOwnStripFact = (task.stripSaw?.cuts ?? []).some(
      (cut) => String(cut.recordedBy?.id) === userId,
    )
    const hasOwnCircularFact = (task.circularSaw?.cuts ?? []).some(
      (cut) => String(cut.recordedBy?.id) === userId,
    )

    if (hasOwnStripFact) {
      const basis = salaryBasisForStationObj('strip_saw', task, roundwoodByTask)
      if (basis.qty > 0) {
        const ownCuts = (task.stripSaw?.cuts ?? []).filter(
          (cut) => String(cut.recordedBy?.id) === userId,
        )
        const atLast =
          ownCuts.length > 0 ? String(ownCuts[ownCuts.length - 1]?.recordedAt ?? '') : stamp
        rows.push({
          taskId: String(task.id),
          taskTitle: String(task.title ?? ''),
          station: 'strip_saw',
          at: atLast || stamp,
          amountUah: Number(rates.strip_saw ?? 0) * basis.qty,
          basisQty: basis.qty,
          basisUnit: basis.unit,
        })
      }
      continue
    }

    if (hasOwnCircularFact) {
      const basis = salaryBasisForStationObj('circular_saw', task, roundwoodByTask)
      const ownCuts = (task.circularSaw?.cuts ?? []).filter(
        (cut) => String(cut.recordedBy?.id) === userId,
      )
      const atLast =
        ownCuts.length > 0 ? String(ownCuts[ownCuts.length - 1]?.recordedAt ?? '') : stamp
      rows.push({
        taskId: String(task.id),
        taskTitle: String(task.title ?? ''),
        station: 'circular_saw',
        at: atLast || stamp,
        amountUah: Number(rates.circular_saw ?? 0) * basis.qty,
        basisQty: basis.qty,
        basisUnit: basis.unit,
      })
      continue
    }

    if (stationAssignments) {
      for (const station of STATION_KEYS) {
        const workers = Array.isArray(stationAssignments[station])
          ? stationAssignments[station].map((x) => String(x))
          : []
        if (!workers.includes(userId)) continue
        const basis = salaryBasisForStationObj(station, task, roundwoodByTask)
        if (basis.qty <= 0) continue
        const splitBy = Math.max(1, workers.length)
        rows.push({
          taskId: String(task.id),
          taskTitle: String(task.title ?? ''),
          station,
          at: stamp,
          amountUah: (Number(rates[station] ?? 0) * basis.qty) / splitBy,
          basisQty: basis.qty,
          basisUnit: basis.unit,
        })
        paidStations.add(station)
      }
    }

    if (paidStations.size > 0) continue

    const fallbackStations = fallbackStationsForTask(role, tabs, task)
    const assignTo = Array.isArray(task.assignTo) ? task.assignTo : []

    for (const station of fallbackStations) {
      if (paidStations.has(station)) continue
      const roleKey =
        station === 'band_saw'
          ? 'sawyer'
          : station === 'pallets'
            ? 'pallet_assembly'
            : 'circular_operator'
      if (!assignTo.includes(roleKey)) continue
      const basis = salaryBasisForStationObj(station, task, roundwoodByTask)
      if (basis.qty <= 0) continue
      rows.push({
        taskId: String(task.id),
        taskTitle: String(task.title ?? ''),
        station,
        at: stamp,
        amountUah: Number(rates[station] ?? 0) * basis.qty,
        basisQty: basis.qty,
        basisUnit: basis.unit,
      })
      break
    }
  }

  return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

function normalizeRates(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const key of STATION_KEYS) {
    const n = Number(source[key])
    out[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SALARY_RATES[key]
  }
  return out
}

async function getSalaryRates() {
  const doc = await SalaryConfigModel.findOne({ key: 'singleton' }, { _id: 0, key: 0 }).lean()
  return normalizeRates(doc?.rates)
}

async function getManualAdjustments() {
  const doc = await SalaryConfigModel.findOne({ key: 'singleton' }, { manualAdjustments: 1 }).lean()
  return Array.isArray(doc?.manualAdjustments) ? doc.manualAdjustments : []
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function listUsers(req, res) {
  const users = await readJson(USERS_FILE, [])
  const list = users.map((u) => publicUser(u))
  return res.json({ users: list })
}

/**
 * Каталог працівників для призначень у завданні (бригадир/адмін).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function listWorkersDirectory(req, res) {
  const users = await readJson(USERS_FILE, [])
  const workers = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
  }))
  return res.json({ workers })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function createUser(req, res) {
  const { username, displayName, role, tabs, password } = req.body ?? {}
  const u = String(username ?? '').trim()
  const name = String(displayName ?? '').trim()
  const pwd = String(password ?? '')

  if (!u || !name) {
    return res.status(400).json({ error: 'Вкажіть логін і ім’я' })
  }
  if (!pwd) {
    return res.status(400).json({ error: 'Вкажіть пароль' })
  }
  const roleNorm = String(role ?? 'sawyer').trim().toLowerCase()
  if (!ROLES.includes(roleNorm)) {
    return res.status(400).json({ error: 'Невідома роль' })
  }
  const tabsClean = sanitizeTabs(tabs)
  if (tabsClean.length === 0) {
    return res.status(400).json({ error: 'Оберіть хоча б один доступ (вкладку)' })
  }
  const users = await readJson(USERS_FILE, [])
  if (users.some((x) => x.username === u)) {
    return res.status(409).json({ error: 'Користувач з таким логіном уже є' })
  }

  const row = {
    id: newUserId(),
    username: u,
    passwordHash: hashPassword(pwd),
    role: roleNorm,
    displayName: name,
    tabs: tabsClean,
  }
  users.push(row)
  await writeJson(USERS_FILE, users)
  return res.status(201).json({ user: publicUser(row) })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function updateUser(req, res) {
  const id = String(req.params.id ?? '').trim()
  const { username, displayName, role, tabs, password } = req.body ?? {}
  const name = String(displayName ?? '').trim()
  const uLogin = String(username ?? '').trim()
  const pwd = password != null ? String(password) : ''

  if (!id) {
    return res.status(400).json({ error: 'Некоректний id' })
  }
  if (!name) {
    return res.status(400).json({ error: 'Вкажіть ім’я' })
  }
  const roleNorm = String(role ?? '').trim().toLowerCase()
  if (!ROLES.includes(roleNorm)) {
    return res.status(400).json({ error: 'Невідома роль' })
  }
  const tabsClean = sanitizeTabs(tabs)
  if (tabsClean.length === 0) {
    return res.status(400).json({ error: 'Оберіть хоча б один доступ (вкладку)' })
  }

  const users = await readJson(USERS_FILE, [])
  const idx = users.findIndex((x) => x.id === id)
  if (idx < 0) {
    return res.status(404).json({ error: 'Користувача не знайдено' })
  }
  const existing = users[idx]
  if (uLogin && uLogin !== existing.username) {
    return res.status(400).json({ error: 'Логін не можна змінити після створення' })
  }

  const next = {
    ...existing,
    username: existing.username,
    displayName: name,
    role: roleNorm,
    tabs: tabsClean,
  }
  if (pwd.trim().length > 0) {
    next.passwordHash = hashPassword(pwd.trim())
  }
  users[idx] = next
  await writeJson(USERS_FILE, users)
  return res.json({ user: publicUser(next) })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function deleteUser(req, res) {
  const id = String(req.params.id ?? '').trim()
  if (!id) {
    return res.status(400).json({ error: 'Некоректний id' })
  }
  if (id === req.user.sub) {
    return res.status(400).json({ error: 'Не можна видалити власний обліковий запис' })
  }

  const users = await readJson(USERS_FILE, [])
  const idx = users.findIndex((x) => x.id === id)
  if (idx < 0) {
    return res.status(404).json({ error: 'Користувача не знайдено' })
  }
  const target = users[idx]
  if (target.role === 'admin') {
    const adminCount = users.filter((x) => x.role === 'admin').length
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Неможливо видалити останнього адміністратора' })
    }
  }

  users.splice(idx, 1)
  await writeJson(USERS_FILE, users)
  return res.status(204).send()
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function getSalaryRatesConfig(req, res) {
  const rates = await getSalaryRates()
  return res.json({ rates })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function putSalaryRatesConfig(req, res) {
  const rates = normalizeRates(req.body?.rates)
  await SalaryConfigModel.updateOne(
    { key: 'singleton' },
    { $set: { key: 'singleton', rates } },
    { upsert: true },
  )
  return res.json({ rates })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function getSalaryReport(req, res) {
  const month = String(req.query.month ?? 'all').trim()
  const users = await readJson(USERS_FILE, [])
  const usersById = new Map(users.map((u) => [String(u.id), u]))
  const tasks = await readJson(TASKS_FILE, [])
  const roundwood = await readJson(ROUNDWOOD_FILE, { stock: [], journal: [] })
  const rates = await getSalaryRates()
  const roundwoodByTask = roundwoodVolumeByTask(Array.isArray(roundwood?.journal) ? roundwood.journal : [])

  /** @type {Array<{userId:string, displayName:string, username:string, taskId:string, taskTitle:string, station:string, at:string, amountUah:number, basisQty?:number, basisUnit?:string}>} */
  const rows = []

  for (const u of users) {
    const userRows = salaryRowsForOneUser(tasks, u, rates, roundwoodByTask)
    for (const r of userRows) {
      if (month !== 'all' && monthKey(r.at) !== month) continue
      rows.push({
        userId: String(u.id),
        displayName: String(u.displayName ?? ''),
        username: String(u.username ?? ''),
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        station: r.station,
        at: r.at,
        amountUah: r.amountUah,
        basisQty: r.basisQty,
        basisUnit: r.basisUnit,
      })
    }
  }

  const manualList = await getManualAdjustments()
  for (const e of manualList) {
    if (!e?.userId || !e?.id) continue
    if (month !== 'all' && monthKey(String(e.at)) !== month) continue
    const amount = Number(e.amountUah)
    if (!Number.isFinite(amount) || amount === 0) continue
    const target = usersById.get(String(e.userId))
    if (!target) continue
    rows.push({
      userId: String(e.userId),
      displayName: String(target.displayName ?? ''),
      username: String(target.username ?? ''),
      taskId: String(e.id),
      taskTitle: String(e.note ?? 'Додаткове нарахування'),
      station: 'manual',
      at: String(e.at),
      amountUah: amount,
      basisQty: 1,
      basisUnit: 'task',
    })
  }

  rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  /** @type {Record<string, {userId:string, displayName:string, username:string, totalUah:number}>} */
  const totalsMap = {}
  for (const row of rows) {
    const cur =
      totalsMap[row.userId] ??
      {
        userId: row.userId,
        displayName: row.displayName,
        username: row.username,
        totalUah: 0,
      }
    cur.totalUah += row.amountUah
    totalsMap[row.userId] = cur
  }
  const totals = Object.values(totalsMap).sort((a, b) => b.totalUah - a.totalUah)
  return res.json({ month: month || 'all', rates, totals, rows })
}

/**
 * Ручні нарахування: список. Адмін — усі (?all=1), інші — лише свої.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function listSalaryManual(req, res) {
  const entries = await getManualAdjustments()
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin'
  if (isAdmin && String(req.query.all ?? '') === '1') {
    const sorted = [...entries].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    return res.json({ entries: sorted })
  }
  const self = String(req.user.sub)
  return res.json({
    entries: entries.filter((e) => String(e.userId) === self),
  })
}

/**
 * Додати ручне нарахування (лише адмін).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function createSalaryManual(req, res) {
  const { userId, amountUah, note } = req.body ?? {}
  const uid = String(userId ?? '').trim()
  const amount = Number(typeof amountUah === 'string' ? amountUah.replace(',', '.') : amountUah)
  const noteStr = String(note ?? '').trim()

  if (!uid) {
    return res.status(400).json({ error: 'Оберіть працівника' })
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'Вкажіть ненульову суму' })
  }
  if (!noteStr) {
    return res.status(400).json({ error: 'Опишіть, за що нарахування' })
  }

  const users = await readJson(USERS_FILE, [])
  if (!users.some((u) => String(u.id) === uid)) {
    return res.status(404).json({ error: 'Користувача не знайдено' })
  }

  const entry = {
    id: `sa-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    userId: uid,
    amountUah: Math.round(amount * 100) / 100,
    note: noteStr.slice(0, 500),
    at: new Date().toISOString(),
    recordedBy: { username: req.user.username, sub: req.user.sub },
  }

  await SalaryConfigModel.updateOne(
    { key: 'singleton' },
    {
      $push: { manualAdjustments: entry },
      $setOnInsert: { key: 'singleton', rates: { ...DEFAULT_SALARY_RATES } },
    },
    { upsert: true },
  )

  return res.status(201).json({ entry })
}
