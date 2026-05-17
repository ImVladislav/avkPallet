import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTasks, recordStripSawCut } from '../api'
import { useAuth } from '../context/AuthContext'
import type { OrderLine } from '../helpers/parseForemanOrders'
import {
  boardCrossAndLengthFromDimensionRow,
  boardWidthAcrossStripForThickness,
  crossSectionMmFromDimensionRow,
  parseForemanOrderTextOrEmpty,
} from '../helpers/parseForemanOrders'
import { stripStockRowsForTask } from '../helpers/stripStockRows'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { WorkTask } from '../types/task'
import './StripSawPage.css'

type BrusRow = {
  key: string
  thicknessMm: number
  widthMm: number
  qtyNeeded: number
  qtyDone: number
  left: number
  stripRemainder: number
  boardsPerStrip: number
  isSecondary?: boolean
}

type ShortageConfirm = {
  row: BrusRow
  boardsTotal: number
  neededStrips: number
  stripQty: number
  overBy: number
}

function fmtMm(mm: number): string {
  return `${Math.round(mm)} мм`
}

function rowKey(thicknessMm: number, widthMm: number): string {
  return `${Math.round(thicknessMm)}|${Math.round(widthMm)}`
}

function boardsPerStrip(stripWidthMm: number | null, boardWidthMm: number, kerfMm: number): number {
  if (stripWidthMm == null || stripWidthMm <= 0 || boardWidthMm <= 0) return 1
  return Math.max(1, Math.floor((stripWidthMm + Math.max(0, kerfMm)) / (boardWidthMm + Math.max(0, kerfMm))))
}

function dimensionRowsForTask(task: WorkTask): WorkTask['dimensionRows'] {
  if (Array.isArray(task.dimensionRows) && task.dimensionRows.length > 0) return task.dimensionRows
  if (Array.isArray(task.plan?.dimensionRows) && task.plan.dimensionRows.length > 0) {
    return task.plan.dimensionRows
  }
  return undefined
}

function distributeSinkAcrossOpenSecondaries(sink: number, n: number): number[] {
  if (n <= 0) return []
  const s = Math.max(0, Math.round(sink))
  if (s <= 0) return Array.from({ length: n }, () => 0)
  const base = Math.floor(s / n)
  const rem = s % n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

function buildBrusRows(task: WorkTask): BrusRow[] {
  const parsed = parseForemanOrderTextOrEmpty(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
  if (!parsed.ok) return []

  const unit = task.unit === 'cm' ? 'cm' : 'mm'
  const demand = new Map<string, { thicknessMm: number; widthMm: number; qtyNeeded: number }>()
  const secondaryKeys = new Set<string>()

  const keysFromOrderText = new Set<string>()
  for (const line of parsed.lines) {
    const thicknessMm = Math.round(line.aMm)
    const widthMm = Math.round(boardWidthAcrossStripForThickness(line, thicknessMm) ?? line.bMm)
    const key = rowKey(thicknessMm, widthMm)
    keysFromOrderText.add(key)
    const prev = demand.get(key)
    if (prev) prev.qtyNeeded += line.qty
    else demand.set(key, { thicknessMm, widthMm, qtyNeeded: line.qty })
  }

  const sumMainQtyByTh = new Map<number, number>()
  for (const line of parsed.lines) {
    const t = Math.round(line.aMm)
    sumMainQtyByTh.set(t, (sumMainQtyByTh.get(t) ?? 0) + line.qty)
  }

  const circByTh = new Map(
    (task.plan?.circular ?? []).map((c) => [Math.round(c.thicknessMm), c] as const),
  )
  const circThicknesses = new Set(circByTh.keys())

  const openSecondaryWidthsByT = new Map<number, number[]>()
  const dimRows = dimensionRowsForTask(task)

  if (dimRows?.length) {
    const addSecondaryDemand = (T: number, Wm: number, q: number) => {
      if (q <= 0) return
      const key = rowKey(T, Wm)
      const existedBefore = demand.has(key)
      const prev = demand.get(key)
      if (prev) prev.qtyNeeded += q
      else demand.set(key, { thicknessMm: T, widthMm: Wm, qtyNeeded: q })
      if (!existedBefore && !keysFromOrderText.has(key)) secondaryKeys.add(key)
    }

    /** Рядок таблиці навіть при qty=0 (потім «Треба» дожміть зі складу або мін. 1). */
    const ensureSecondaryBrusSlot = (T: number, Wm: number) => {
      const key = rowKey(T, Wm)
      if (!demand.has(key)) {
        demand.set(key, { thicknessMm: T, widthMm: Wm, qtyNeeded: 0 })
      }
      if (!keysFromOrderText.has(key)) secondaryKeys.add(key)
    }

    const stripStockThicknessWithRemainder = new Set(
      stripStockRowsForTask(task)
        .filter((s) => s.remainder > 0)
        .map((s) => s.thicknessMm),
    )

    for (const r of dimRows) {
      const qtyEmpty = !String(r.qty ?? '').trim()
      if (r.kind !== 'secondary' && !qtyEmpty) continue
      const cs = crossSectionMmFromDimensionRow(r, unit)
      if (!cs) continue

      const bl = boardCrossAndLengthFromDimensionRow(r, unit)
      const lengthMm = bl != null ? Math.round(bl.lengthMm) : 0
      const syn: OrderLine = { qty: 1, aMm: cs.aMm, bMm: cs.bMm, lengthMm }

      const Ta = Math.round(cs.aMm)
      const Tb = Math.round(cs.bMm)
      const pickStripThickness = (): number | null => {
        const hiA = circThicknesses.has(Ta)
        const hiB = circThicknesses.has(Tb)
        if (hiA && !hiB) return Ta
        if (hiB && !hiA) return Tb
        if (hiA && hiB) return Math.min(Ta, Tb)
        if (stripStockThicknessWithRemainder.has(Ta) && !stripStockThicknessWithRemainder.has(Tb)) {
          return Ta
        }
        if (stripStockThicknessWithRemainder.has(Tb) && !stripStockThicknessWithRemainder.has(Ta)) {
          return Tb
        }
        if (stripStockThicknessWithRemainder.has(Ta) && stripStockThicknessWithRemainder.has(Tb)) {
          return Math.min(Ta, Tb)
        }
        if (Ta > 0 && Tb > 0) {
          for (const c of [Ta, Tb, Math.min(Ta, Tb), Math.max(Ta, Tb)]) {
            if (c > 0 && circThicknesses.has(c)) return c
          }
          return null
        }
        if (Ta > 0 && circThicknesses.has(Ta)) return Ta
        if (Tb > 0 && circThicknesses.has(Tb)) return Tb
        return null
      }
      const T = pickStripThickness()
      if (T == null || T <= 0) continue
      const wAcross = boardWidthAcrossStripForThickness(syn, T)
      if (wAcross == null) continue
      const Wm = Math.round(wAcross)
      if (Wm <= 0) continue

      const pq = String(r.qty ?? '').trim()
      if (pq !== '') {
        const qn = Math.round(Number(pq.replace(',', '.')))
        if (Number.isFinite(qn) && qn > 0) addSecondaryDemand(T, Wm, qn)
        continue
      }

      const list = openSecondaryWidthsByT.get(T) ?? []
      list.push(Wm)
      openSecondaryWidthsByT.set(T, list)
    }

    for (const [T, widths] of openSecondaryWidthsByT) {
      const circ = circByTh.get(T)
      const sumMain = sumMainQtyByTh.get(T) ?? 0
      const sink = Math.max(0, Math.round(circ?.qtyNeeded ?? 0) - sumMain)
      const amounts = distributeSinkAcrossOpenSecondaries(sink, widths.length)
      for (let i = 0; i < widths.length; i += 1) {
        addSecondaryDemand(T, widths[i]!, amounts[i] ?? 0)
      }
      for (const Wm of widths) {
        ensureSecondaryBrusSlot(T, Wm)
      }
    }
  }

  const explicitDone = new Map<string, number>()
  for (const cut of task.stripSaw?.cuts ?? []) {
    const thicknessMm = Math.round(cut.thicknessMm)
    const byWidth = cut.boardsByWidthMm ?? {}
    for (const [widthRaw, qtyRaw] of Object.entries(byWidth)) {
      const widthMm = Math.round(Number(widthRaw))
      const qty = Math.round(Number(qtyRaw))
      if (!Number.isFinite(widthMm) || !Number.isFinite(qty) || qty <= 0) continue
      const key = rowKey(thicknessMm, widthMm)
      explicitDone.set(key, (explicitDone.get(key) ?? 0) + qty)
    }
  }

  const explicitDoneByThickness = new Map<number, number>()
  for (const [key, qty] of explicitDone) {
    const thicknessMm = Number(key.split('|')[0])
    explicitDoneByThickness.set(thicknessMm, (explicitDoneByThickness.get(thicknessMm) ?? 0) + qty)
  }

  const unallocatedDoneByThickness = new Map<number, number>()
  for (const row of task.plan?.circular ?? []) {
    const thicknessMm = Math.round(row.thicknessMm)
    const totalDone = Math.round(row.qtyDone ?? 0)
    const explicit = explicitDoneByThickness.get(thicknessMm) ?? 0
    unallocatedDoneByThickness.set(thicknessMm, Math.max(0, totalDone - explicit))
  }

  const stockByThickness = new Map(stripStockRowsForTask(task).map((row) => [row.thicknessMm, row]))
  const rows = [...demand.values()].sort((a, b) => b.thicknessMm - a.thicknessMm || b.widthMm - a.widthMm)

  return rows
    .map((row) => {
      const rk = rowKey(row.thicknessMm, row.widthMm)
      const explicit = explicitDone.get(rk) ?? 0
      const unallocated = unallocatedDoneByThickness.get(row.thicknessMm) ?? 0
      let qtyNeeded = row.qtyNeeded
      const stock = stockByThickness.get(row.thicknessMm)
      const boardsPerStripVal = boardsPerStrip(
        stock?.undressedStripWidthMm ?? null,
        row.widthMm,
        task.kerfCircMm,
      )
      if (secondaryKeys.has(rk) && qtyNeeded <= 0 && (stock?.remainder ?? 0) > 0) {
        qtyNeeded = Math.max(qtyNeeded, (stock?.remainder ?? 0) * boardsPerStripVal)
      }
      if (secondaryKeys.has(rk) && qtyNeeded <= 0) {
        qtyNeeded = 1
      }
      const allocated = Math.min(Math.max(0, qtyNeeded - explicit), unallocated)
      unallocatedDoneByThickness.set(row.thicknessMm, Math.max(0, unallocated - allocated))
      const qtyDone = explicit + allocated
      const left = Math.max(0, qtyNeeded - qtyDone)
      return {
        ...row,
        qtyNeeded,
        key: rk,
        qtyDone,
        left,
        stripRemainder: stock?.remainder ?? 0,
        boardsPerStrip: boardsPerStripVal,
        isSecondary: secondaryKeys.has(rk),
      }
    })
    .filter((row) => row.left > 0 || (row.isSecondary && row.stripRemainder > 0))
}

export function StripSawPage() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [tasksErr, setTasksErr] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [shortageConfirm, setShortageConfirm] = useState<ShortageConfirm | null>(null)
  const tasksFetchSeq = useRef(0)

  const reloadTasks = useCallback(() => {
    const n = ++tasksFetchSeq.current
    void (async () => {
      try {
        const list = await fetchTasks()
        if (tasksFetchSeq.current !== n) return
        setTasks(list)
        setTasksErr(null)
      } catch (e) {
        if (tasksFetchSeq.current !== n) return
        setTasks([])
        setTasksErr(e instanceof Error ? e.message : 'Не вдалося завантажити завдання')
      }
    })()
  }, [])

  useEffect(() => {
    reloadTasks()
  }, [reloadTasks])

  useWorkTasksReload(reloadTasks)

  const tasksForStrip = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.assignTo.includes('circular_operator') &&
          (task.taskKind ?? 'resaw') === 'resaw',
      ),
    [tasks],
  )

  useEffect(() => {
    if (selectedTaskId && tasksForStrip.some((task) => task.id === selectedTaskId)) return
    setSelectedTaskId(tasksForStrip[0]?.id ?? '')
  }, [selectedTaskId, tasksForStrip])

  const selectedTask = useMemo(
    () => tasksForStrip.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasksForStrip],
  )

  const rows = useMemo(() => (selectedTask ? buildBrusRows(selectedTask) : []), [selectedTask])
  const canRecord =
    !!user &&
    (['circular_operator', 'foreman', 'admin', 'super_admin'].includes(user.role) ||
      user.tabs.includes('strip_saw'))

  const submitBrus = async (row: BrusRow, boardsTotal: number, stripQty: number) => {
    if (!selectedTask) return
    setBusyKey(row.key)
    try {
      const updated = await recordStripSawCut(selectedTask.id, {
        thicknessMm: row.thicknessMm,
        stripQty,
        boardsTotal,
        boardsByWidthMm: { [String(row.widthMm)]: boardsTotal },
      })
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)))
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[row.key]
        return next
      })
      setMsg(`Записано ${boardsTotal} шт бруса ${fmtMm(row.thicknessMm)} × ${fmtMm(row.widthMm)}.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не вдалося застосувати')
    } finally {
      setBusyKey(null)
    }
  }

  const applyRow = async (row: BrusRow) => {
    setErr(null)
    setMsg(null)
    setShortageConfirm(null)

    const raw = Number(String(drafts[row.key] ?? '').replace(',', '.'))
    const boardsTotal = Math.round(raw)
    if (!Number.isFinite(raw) || boardsTotal <= 0 || Math.abs(raw - boardsTotal) > 1e-6) {
      setErr('Вкажіть цілу кількість бруса більше 0.')
      return
    }
    if (row.stripRemainder <= 0) {
      setErr(`Для ${fmtMm(row.thicknessMm)} немає смуг на складі багатопилу.`)
      return
    }

    const stripQty = Math.ceil(boardsTotal / row.boardsPerStrip)
    const overBy = Math.max(0, boardsTotal - row.left)
    if (overBy > 0 || stripQty > row.stripRemainder) {
      setShortageConfirm({
        row,
        boardsTotal,
        neededStrips: stripQty,
        stripQty: Math.min(stripQty, row.stripRemainder),
        overBy,
      })
      return
    }

    await submitBrus(row, boardsTotal, stripQty)
  }

  return (
    <>
      <section className="panel stripSawPageRoot">
        <h2>Багатопил — брус</h2>
        {tasksErr && <p className="birkaMsgErr">{tasksErr}</p>}

        <div className="row">
          <label>
            Завдання
            <select
              value={selectedTaskId}
              onChange={(event) => {
                setSelectedTaskId(event.target.value)
                setDrafts({})
                setErr(null)
                setMsg(null)
                setShortageConfirm(null)
              }}
            >
              <option value="">Оберіть завдання</option>
              {tasksForStrip.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        {err && <p className="birkaMsgErr">{err}</p>}
        {msg && <p className="stripActionOkMsg">{msg}</p>}

        {selectedTask && rows.length === 0 && (
          <p className="stripWorkflowDone">
            Усі бруси по цьому завданню закриті або немає позицій для багатопилу.
          </p>
        )}

        {selectedTask && rows.length > 0 && (
          <div className="stripSimpleTableWrap">
            <table className="stripSimpleTable">
              <thead>
                <tr>
                  <th>Брус</th>
                  <th>Треба</th>
                  <th>Зроблено</th>
                  <th>Залишилось</th>
                  <th>Смуг</th>
                  <th>Скільки є</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td data-label="Брус">
                      <strong>
                        {fmtMm(row.thicknessMm)} × {fmtMm(row.widthMm)}
                      </strong>
                      {row.isSecondary ? (
                        <span
                          className="stripRowSecondaryBadge"
                          title="Побічний розмір з форми бригадира (рядок без кількості в тексті або побічний)"
                        >
                          {' '}
                          побічний
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Треба">{row.qtyNeeded}</td>
                    <td data-label="Зроблено">{row.qtyDone}</td>
                    <td data-label="Залишилось">{row.left}</td>
                    <td data-label="Смуг">{row.stripRemainder}</td>
                    <td data-label="Скільки є">
                      <input
                        className="stripSimpleInput"
                        type="number"
                        min={1}
                        step={1}
                        value={drafts[row.key] ?? ''}
                        onChange={(event) =>
                          setDrafts((prev) => ({ ...prev, [row.key]: event.target.value }))
                        }
                        placeholder="0"
                      />
                    </td>
                    <td data-label="">
                      <button
                        type="button"
                        className="btnSecondary"
                        disabled={!canRecord || busyKey === row.key}
                        onClick={() => void applyRow(row)}
                      >
                        {busyKey === row.key ? '...' : 'Застосувати'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!selectedTask && !tasksErr && <p className="panelHint">Оберіть завдання для багатопилу.</p>}
      </section>

      {shortageConfirm && (
        <div className="stripModalBackdrop" role="presentation">
          <div className="stripModal" role="dialog" aria-modal="true" aria-labelledby="stripModalTitle">
            <h3 id="stripModalTitle">Підтвердити кількість</h3>
            {shortageConfirm.overBy > 0 && (
              <p>
                Ви ввели <strong>{shortageConfirm.boardsTotal}</strong> шт, але по плану залишилось{' '}
                <strong>{shortageConfirm.row.left}</strong>. Надлишок:{' '}
                <strong>{shortageConfirm.overBy}</strong> шт. Можливо, помилились?
              </p>
            )}
            {shortageConfirm.neededStrips > shortageConfirm.row.stripRemainder && (
              <p>
                Для <strong>{shortageConfirm.boardsTotal}</strong> шт потрібно приблизно{' '}
                <strong>{shortageConfirm.neededStrips}</strong> смуг, а на складі є{' '}
                <strong>{shortageConfirm.row.stripRemainder}</strong>.
              </p>
            )}
            <p>
              Записати <strong>{shortageConfirm.boardsTotal}</strong> шт бруса все одно?
            </p>
            <div className="stripModalActions">
              <button
                type="button"
                className="btnSecondary"
                disabled={busyKey === shortageConfirm.row.key}
                onClick={() =>
                  void submitBrus(
                    shortageConfirm.row,
                    shortageConfirm.boardsTotal,
                    shortageConfirm.stripQty,
                  ).then(() => setShortageConfirm(null))
                }
              >
                {busyKey === shortageConfirm.row.key ? '...' : 'Записати'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busyKey === shortageConfirm.row.key}
                onClick={() => setShortageConfirm(null)}
              >
                Скасувати
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
