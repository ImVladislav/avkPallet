import { readRoundwood, writeRoundwood, newNumericLogId } from '../helpers/roundwoodStore.js'

const CAN_READ = ['sawyer', 'circular_operator', 'foreman', 'admin', 'super_admin', 'pallet_assembly']
const CAN_WRITE_STOCK = ['sawyer', 'foreman', 'admin', 'super_admin']
const CAN_MANUAL_RECEIVE = ['super_admin']
const CAN_CLEAR = ['foreman', 'admin', 'super_admin']

/** Скасувати помилковий прийом: лише протягом цього часу після createdAt (мс). */
const RECEIVE_CANCEL_WINDOW_MS = 5 * 60 * 1000

function journalId() {
  return `j-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function getRoundwood(req, res) {
  if (!CAN_READ.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає доступу до складу кругляка' })
  }
  const state = await readRoundwood()
  const journalSorted = [...state.journal].sort((a, b) => {
    const ta = new Date(a.at).getTime()
    const tb = new Date(b.at).getTime()
    return tb - ta
  })
  return res.json({ stock: state.stock, brusStock: state.brusStock ?? [], journal: journalSorted })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function postReceive(req, res) {
  if (!CAN_MANUAL_RECEIVE.includes(req.user.role)) {
    return res.status(403).json({ error: 'Ручний прийом кругляка доступний лише супер адміну' })
  }
  const { radiusMm, lengthMm, id: clientId, volumeM3 } = req.body ?? {}
  const R = Number(radiusMm)
  const L = Number(lengthMm)
  if (!Number.isFinite(R) || R <= 0 || !Number.isFinite(L) || L <= 0) {
    return res.status(400).json({ error: 'Вкажіть radiusMm та lengthMm (мм, > 0)' })
  }
  const vol = volumeM3 != null ? Number(volumeM3) : NaN
  const volumeOk = Number.isFinite(vol) && vol >= 0
  const id = clientId != null ? newNumericLogId(clientId) : Date.now()
  const state = await readRoundwood()
  if (state.stock.some((s) => s.id === id)) {
    return res.status(409).json({ error: 'Колода з таким id уже є на складі' })
  }
  const now = new Date().toISOString()
  const item = {
    id,
    radius: Math.round(R),
    length: Math.round(L),
    createdAt: now,
    ...(volumeOk ? { volumeM3: vol } : {}),
  }
  state.stock.push(item)
  state.journal.push({
    id: journalId(),
    kind: 'received',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: id,
    radiusMm: item.radius,
    lengthMm: item.length,
    ...(volumeOk ? { volumeM3: vol } : {}),
  })
  await writeRoundwood(state)
  return res.status(201).json({ stock: state.stock, item })
}

/**
 * Прийом готового/купленого бруса на склад.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function postReceiveBrus(req, res) {
  if (!CAN_WRITE_STOCK.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає права записувати прийом бруса' })
  }
  const { sideAMm, sideBMm, lengthMm, qty, id: clientId } = req.body ?? {}
  const a = Math.round(Number(sideAMm))
  const b = Math.round(Number(sideBMm))
  const len = Math.round(Number(lengthMm))
  const rawQty = Number(qty)
  const q = Math.round(rawQty)
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0 || !Number.isFinite(len) || len <= 0) {
    return res.status(400).json({ error: 'Вкажіть сторону 1, сторону 2 та довжину (мм, > 0)' })
  }
  if (!Number.isFinite(rawQty) || q <= 0 || Math.abs(rawQty - q) > 1e-6) {
    return res.status(400).json({ error: 'Кількість бруса має бути цілим числом > 0' })
  }

  const id = clientId != null ? newNumericLogId(clientId) : Date.now()
  const state = await readRoundwood()
  if ((state.brusStock ?? []).some((s) => s.id === id)) {
    return res.status(409).json({ error: 'Брус з таким id уже є на складі' })
  }
  const now = new Date().toISOString()
  const item = { id, sideAMm: a, sideBMm: b, lengthMm: len, qty: q, createdAt: now }
  state.brusStock = [...(state.brusStock ?? []), item]
  state.journal.push({
    id: journalId(),
    kind: 'brus_received',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: id,
    sideAMm: a,
    sideBMm: b,
    lengthMm: len,
    qty: q,
  })
  await writeRoundwood(state)
  return res.status(201).json({ brusStock: state.brusStock, item })
}

/**
 * Прийом кругляка по номеру бірки (дані з зовнішнього API).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function postReceiveFromLabel(req, res) {
  if (!CAN_WRITE_STOCK.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає права записувати прийом кругляка' })
  }

  const { labelNumber, id: clientId } = req.body ?? {}
  const label = Math.round(Number(labelNumber))
  if (!Number.isFinite(label) || label <= 0) {
    return res.status(400).json({ error: 'Вкажіть коректний номер бірки' })
  }

  let upstreamJson
  try {
    const upstreamRes = await fetch(`https://macvpn.cloud/log/${encodeURIComponent(String(label))}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    upstreamJson = await upstreamRes.json().catch(() => ({}))
    if (!upstreamRes.ok) {
      const upstreamError =
        typeof upstreamJson?.error === 'string' && upstreamJson.error
          ? upstreamJson.error
          : `Помилка сервісу бірок (${upstreamRes.status})`
      return res.status(502).json({ error: upstreamError })
    }
  } catch {
    return res.status(502).json({ error: 'Не вдалося отримати дані бірки' })
  }

  const src = upstreamJson?.data ?? {}
  const diameter = Number(src['Диаметр'])
  const length = Number(src['Длина'])
  const volumeRaw = src['Объем']
  const volumeParsed = volumeRaw != null ? Number(volumeRaw) : NaN
  const volumeOk = Number.isFinite(volumeParsed) && volumeParsed >= 0
  if (!Number.isFinite(diameter) || diameter <= 0 || !Number.isFinite(length) || length <= 0) {
    return res.status(400).json({ error: 'У відповіді бірки немає коректних Диаметр/Длина' })
  }

  // Зовнішній API повертає Діаметр у см, Довжину у м.
  const radiusMm = Math.round(diameter * 10)
  const lengthMm = Math.round(length * 1000)
  const id = clientId != null ? newNumericLogId(clientId) : Date.now()

  const state = await readRoundwood()
  if (state.stock.some((s) => Math.round(Number(s.labelNumber)) === label)) {
    return res.status(409).json({ error: `Колода з біркою ${label} уже є на складі` })
  }
  if (state.stock.some((s) => s.id === id)) {
    return res.status(409).json({ error: 'Колода з таким id уже є на складі' })
  }

  const now = new Date().toISOString()
  const item = {
    id,
    radius: radiusMm,
    length: lengthMm,
    createdAt: now,
    labelNumber: label,
    ...(volumeOk ? { volumeM3: volumeParsed } : {}),
  }
  state.stock.push(item)
  state.journal.push({
    id: journalId(),
    kind: 'received',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: id,
    radiusMm: item.radius,
    lengthMm: item.length,
    labelNumber: label,
    ...(volumeOk ? { volumeM3: volumeParsed } : {}),
  })
  await writeRoundwood(state)

  return res.status(201).json({
    stock: state.stock,
    item,
    source: {
      labelNumber: label,
      diameter,
      length,
      ...(volumeOk ? { volumeM3: volumeParsed } : {}),
    },
  })
}

/**
 * Видалити щойно прийняту колоду зі складу (лише протягом RECEIVE_CANCEL_WINDOW_MS).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function deleteStockItem(req, res) {
  if (!CAN_WRITE_STOCK.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає права видаляти запис прийому' })
  }
  const lid = Math.round(Number(req.params.logId))
  if (!Number.isFinite(lid) || lid <= 0) {
    return res.status(400).json({ error: 'Некоректний logId' })
  }
  const state = await readRoundwood()
  const idx = state.stock.findIndex((s) => s.id === lid)
  if (idx < 0) {
    return res.status(404).json({ error: 'Позицію не знайдено на складі' })
  }
  const item = state.stock[idx]
  const createdMs = new Date(item.createdAt).getTime()
  if (!Number.isFinite(createdMs)) {
    return res.status(400).json({ error: 'Некоректна дата запису' })
  }
  const elapsed = Date.now() - createdMs
  if (elapsed > RECEIVE_CANCEL_WINDOW_MS) {
    return res.status(403).json({
      error: 'Видалити можна лише протягом 5 хвилин після прийому',
    })
  }
  state.stock.splice(idx, 1)
  const now = new Date().toISOString()
  state.journal.push({
    id: journalId(),
    kind: 'receive_cancelled',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: item.id,
    radiusMm: item.radius,
    lengthMm: item.length,
    ...(item.labelNumber != null ? { labelNumber: item.labelNumber } : {}),
  })
  await writeRoundwood(state)
  return res.json({ ok: true, stock: state.stock })
}

/**
 * Скасувати щойно прийнятий брус (лише протягом RECEIVE_CANCEL_WINDOW_MS).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function deleteBrusStockItem(req, res) {
  if (!CAN_WRITE_STOCK.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає права видаляти запис прийому' })
  }
  const lid = Math.round(Number(req.params.itemId))
  if (!Number.isFinite(lid) || lid <= 0) {
    return res.status(400).json({ error: 'Некоректний id бруса' })
  }
  const state = await readRoundwood()
  const brus = state.brusStock ?? []
  const idx = brus.findIndex((s) => s.id === lid)
  if (idx < 0) {
    return res.status(404).json({ error: 'Позицію не знайдено на складі бруса' })
  }
  const item = brus[idx]
  const createdMs = new Date(item.createdAt).getTime()
  if (!Number.isFinite(createdMs)) {
    return res.status(400).json({ error: 'Некоректна дата запису' })
  }
  const elapsed = Date.now() - createdMs
  if (elapsed > RECEIVE_CANCEL_WINDOW_MS) {
    return res.status(403).json({
      error: 'Видалити можна лише протягом 5 хвилин після прийому',
    })
  }
  brus.splice(idx, 1)
  state.brusStock = brus
  const now = new Date().toISOString()
  state.journal.push({
    id: journalId(),
    kind: 'brus_receive_cancelled',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: item.id,
    sideAMm: item.sideAMm,
    sideBMm: item.sideBMm,
    lengthMm: item.lengthMm,
    qty: item.qty,
  })
  await writeRoundwood(state)
  return res.json({ ok: true, brusStock: state.brusStock })
}

/**
 * Списати колоду після ленточної (ідемпотентно).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function postConsume(req, res) {
  if (!CAN_WRITE_STOCK.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає права списувати колоду' })
  }
  const { logId, taskId, taskTitle } = req.body ?? {}
  const lid = Math.round(Number(logId))
  if (!Number.isFinite(lid) || lid <= 0) {
    return res.status(400).json({ error: 'Вкажіть logId' })
  }
  const state = await readRoundwood()
  const idx = state.stock.findIndex((s) => s.id === lid)
  if (idx < 0) {
    return res.json({ ok: true, idempotent: true, stock: state.stock })
  }
  const removed = state.stock[idx]
  state.stock.splice(idx, 1)
  const now = new Date().toISOString()
  state.journal.push({
    id: journalId(),
    kind: 'band_consumed',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: removed.id,
    radiusMm: removed.radius,
    lengthMm: removed.length,
    ...(removed.labelNumber != null ? { labelNumber: removed.labelNumber } : {}),
    ...(removed.volumeM3 != null ? { volumeM3: removed.volumeM3 } : {}),
    taskId: taskId != null ? String(taskId) : undefined,
    taskTitle: taskTitle != null ? String(taskTitle) : undefined,
  })
  await writeRoundwood(state)
  return res.json({ ok: true, stock: state.stock })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function patchStockItem(req, res) {
  if (!CAN_WRITE_STOCK.includes(req.user.role)) {
    return res.status(403).json({ error: 'Немає права змінювати колоду' })
  }
  const lid = Math.round(Number(req.params.logId))
  if (!Number.isFinite(lid) || lid <= 0) {
    return res.status(400).json({ error: 'Некоректний logId' })
  }
  const { radiusMm, lengthMm } = req.body ?? {}
  const R = Number(radiusMm)
  const L = Number(lengthMm)
  if (!Number.isFinite(R) || R <= 0 || !Number.isFinite(L) || L <= 0) {
    return res.status(400).json({ error: 'Вкажіть radiusMm та lengthMm (мм, > 0)' })
  }
  const state = await readRoundwood()
  const item = state.stock.find((s) => s.id === lid)
  if (!item) {
    return res.status(404).json({ error: 'Колоду не знайдено на складі' })
  }
  const prevR = item.radius
  const prevL = item.length
  item.radius = Math.round(R)
  item.length = Math.round(L)
  const now = new Date().toISOString()
  state.journal.push({
    id: journalId(),
    kind: 'stock_updated',
    at: now,
    recordedBy: { username: req.user.username, sub: req.user.sub },
    logId: item.id,
    radiusMm: item.radius,
    lengthMm: item.length,
    previousRadiusMm: prevR,
    previousLengthMm: prevL,
  })
  await writeRoundwood(state)
  return res.json({ stock: state.stock, item })
}

/**
 * Очистити лише залишок на складі (журнал не чіпаємо).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function deleteClearStock(req, res) {
  if (!CAN_CLEAR.includes(req.user.role)) {
    return res.status(403).json({ error: 'Лише бригадир або адмін можуть очистити склад кругляка' })
  }
  const state = await readRoundwood()
  const n = state.stock.length
  state.stock = []
  if (n > 0) {
    state.journal.push({
      id: journalId(),
      kind: 'stock_cleared',
      at: new Date().toISOString(),
      recordedBy: { username: req.user.username, sub: req.user.sub },
      clearedCount: n,
    })
  }
  await writeRoundwood(state)
  return res.json({ stock: state.stock })
}
