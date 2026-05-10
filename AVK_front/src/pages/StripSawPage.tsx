import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTasks, recordStripSawCut } from '../api'
import { useAuth } from '../context/AuthContext'
import {
  boardWidthAcrossStripForThickness,
  parseForemanOrderText,
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

function buildBrusRows(task: WorkTask): BrusRow[] {
  const parsed = parseForemanOrderText(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
  if (!parsed.ok) return []

  const demand = new Map<string, { thicknessMm: number; widthMm: number; qtyNeeded: number }>()
  for (const line of parsed.lines) {
    const thicknessMm = Math.round(line.aMm)
    const widthMm = Math.round(boardWidthAcrossStripForThickness(line, thicknessMm) ?? line.bMm)
    const key = rowKey(thicknessMm, widthMm)
    const prev = demand.get(key)
    if (prev) prev.qtyNeeded += line.qty
    else demand.set(key, { thicknessMm, widthMm, qtyNeeded: line.qty })
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
      const explicit = explicitDone.get(rowKey(row.thicknessMm, row.widthMm)) ?? 0
      const unallocated = unallocatedDoneByThickness.get(row.thicknessMm) ?? 0
      const allocated = Math.min(Math.max(0, row.qtyNeeded - explicit), unallocated)
      unallocatedDoneByThickness.set(row.thicknessMm, Math.max(0, unallocated - allocated))
      const qtyDone = explicit + allocated
      const left = Math.max(0, row.qtyNeeded - qtyDone)
      const stock = stockByThickness.get(row.thicknessMm)
      return {
        ...row,
        key: rowKey(row.thicknessMm, row.widthMm),
        qtyDone,
        left,
        stripRemainder: stock?.remainder ?? 0,
        boardsPerStrip: boardsPerStrip(stock?.undressedStripWidthMm ?? null, row.widthMm, task.kerfCircMm),
      }
    })
    .filter((row) => row.left > 0)
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
