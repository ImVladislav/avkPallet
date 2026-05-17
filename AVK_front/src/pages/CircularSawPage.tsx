import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTasks, recordCircularSawCut, undoLastCircularSawCut } from '../api'
import { useAuth } from '../context/AuthContext'
import {
  boardCrossAndLengthFromDimensionRow,
  boardWidthAcrossStripForThickness,
  parseForemanOrderTextOrEmpty,
} from '../helpers/parseForemanOrders'
import { boardsFromTaskStripCuts } from '../helpers/taskBoardInventory'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { OrderLine } from '../helpers/parseForemanOrders'
import type { WorkTask } from '../types/task'
import './CircularSawPage.css'

type CircularRow = {
  key: string
  thicknessMm: number
  widthMm: number
  lengthMm: number
  qtyNeeded: number
  qtyDone: number
  left: number
  boardsReady: number
  sampleBoardLengthMm: number | null
  piecesPerBoard: number
}

type CircularConfirm = {
  row: CircularRow
  qty: number
  neededBoards: number
}

function fmtMm(mm: number): string {
  return `${Math.round(mm)} мм`
}

function fmtCm(mm: number): string {
  const cm = Math.round(mm / 10)
  return `${cm} см`
}

function rowKey(thicknessMm: number, widthMm: number, lengthMm: number): string {
  return `${Math.round(thicknessMm)}|${Math.round(widthMm)}|${Math.round(lengthMm)}`
}

/** Довжина деталі з рядків замовлення, де для цієї пари товщина×ширина вже вказана довжина (>0). */
function pieceLengthMmForStripSection(
  lines: OrderLine[],
  thicknessMm: number,
  widthMm: number,
): number | null {
  const tw = Math.round(thicknessMm)
  const ww = Math.round(widthMm)
  let best: { L: number; q: number } | null = null
  for (const o of lines) {
    const wAcross = boardWidthAcrossStripForThickness(o, tw)
    if (wAcross == null || Math.round(wAcross) !== ww) continue
    const L = Math.round(o.lengthMm)
    if (L <= 0) continue
    if (!best || o.qty > best.q || (o.qty === best.q && L > best.L)) best = { L, q: o.qty }
  }
  return best?.L ?? null
}

/** Сума кількостей з рядків, де для смуги (th×w) довжина в замовленні не задана (розпил). */
function orderPieceQtyForStripSectionZeroLengthLines(
  lines: OrderLine[],
  thicknessMm: number,
  widthMm: number,
): number {
  let q = 0
  const tw = Math.round(thicknessMm)
  const ww = Math.round(widthMm)
  for (const o of lines) {
    const t = Math.round(o.aMm)
    const wAcross = boardWidthAcrossStripForThickness(o, t)
    const wm = Math.round(wAcross ?? o.bMm)
    if (t !== tw || wm !== ww) continue
    if (Math.round(o.lengthMm) > 0) continue
    q += o.qty
  }
  return q
}

function demandHasAnyForThW(
  demand: Map<
    string,
    { thicknessMm: number; widthMm: number; lengthMm: number; qtyNeeded: number }
  >,
  th: number,
  w: number,
): boolean {
  for (const v of demand.values()) {
    if (Math.round(v.thicknessMm) === Math.round(th) && Math.round(v.widthMm) === Math.round(w))
      return true
  }
  return false
}

function normalizeCutLengthMm(rawLengthMm: number, boardLengthMm: number | null): number {
  if (boardLengthMm == null || boardLengthMm <= 0) return rawLengthMm
  const maybeMmTypedIntoCmField = rawLengthMm / 10
  if (rawLengthMm > boardLengthMm && maybeMmTypedIntoCmField > 0 && maybeMmTypedIntoCmField <= boardLengthMm) {
    return Math.round(maybeMmTypedIntoCmField)
  }
  return rawLengthMm
}

function piecesPerBoard(boardLengthMm: number | null, pieceLengthMm: number, kerfMm: number): number {
  if (boardLengthMm == null || boardLengthMm <= 0 || pieceLengthMm <= 0) return 0
  return Math.max(0, Math.floor((boardLengthMm + Math.max(0, kerfMm)) / (pieceLengthMm + Math.max(0, kerfMm))))
}

function buildCircularRows(task: WorkTask): CircularRow[] {
  const parsed = parseForemanOrderTextOrEmpty(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
  if (!parsed.ok) return []

  const demand = new Map<
    string,
    { thicknessMm: number; widthMm: number; lengthMm: number; qtyNeeded: number }
  >()
  for (const line of parsed.lines) {
    const lengthMm = Math.round(line.lengthMm)
    if (lengthMm <= 0) continue
    const thicknessMm = Math.round(line.aMm)
    const widthMm = Math.round(boardWidthAcrossStripForThickness(line, thicknessMm) ?? line.bMm)
    const key = rowKey(thicknessMm, widthMm, lengthMm)
    const prev = demand.get(key)
    if (prev) prev.qtyNeeded += line.qty
    else demand.set(key, { thicknessMm, widthMm, lengthMm, qtyNeeded: line.qty })
  }

  const ready = new Map<string, { qty: number; sampleLength: number | null }>()
  for (const board of boardsFromTaskStripCuts(task, parsed.lines)) {
    if (board.orderLengthMm == null || board.orderLengthMm <= 0) continue
    const key = rowKey(board.thicknessMm, board.widthMm, board.orderLengthMm)
    const prev = ready.get(key) ?? { qty: 0, sampleLength: null }
    ready.set(key, {
      qty: prev.qty + 1,
      sampleLength:
        prev.sampleLength != null && prev.sampleLength > 0
          ? prev.sampleLength
          : board.stripLengthPrimaryMm > 0
            ? board.stripLengthPrimaryMm
            : null,
    })
  }

  const u = task.unit === 'cm' ? 'cm' : 'mm'
  for (const r of task.dimensionRows ?? []) {
    if (r.kind !== 'secondary' || String(r.qty ?? '').trim() !== '') continue
    const g = boardCrossAndLengthFromDimensionRow(r, u)
    if (!g) continue
    const thicknessMm = Math.round(g.aMm)
    const widthMm = Math.round(
      boardWidthAcrossStripForThickness(
        { qty: 1, aMm: g.aMm, bMm: g.bMm, lengthMm: g.lengthMm },
        thicknessMm,
      ) ?? g.bMm,
    )
    const lengthMm = Math.round(g.lengthMm)
    const key = rowKey(thicknessMm, widthMm, lengthMm)
    if (demand.has(key)) continue
    const stock = ready.get(key)
    if (!stock || stock.qty <= 0) continue
    demand.set(key, { thicknessMm, widthMm, lengthMm, qtyNeeded: stock.qty })
  }

  const taskKind = task.taskKind ?? 'resaw'
  if (taskKind === 'resaw') {
    for (const [key, stock] of ready) {
      if (stock.qty <= 0) continue
      const parts = key.split('|')
      const thicknessMm = Number(parts[0])
      const widthMm = Number(parts[1])
      const boardLen = Number(parts[2])
      if (![thicknessMm, widthMm, boardLen].every((n) => Number.isFinite(n))) continue
      if (demandHasAnyForThW(demand, thicknessMm, widthMm)) continue
      const pieceLen = pieceLengthMmForStripSection(parsed.lines, thicknessMm, widthMm) ?? boardLen
      const dKey = rowKey(thicknessMm, widthMm, pieceLen)
      if (demand.has(dKey)) continue
      const orderPieces = orderPieceQtyForStripSectionZeroLengthLines(
        parsed.lines,
        thicknessMm,
        widthMm,
      )
      const ppb = Math.max(
        1,
        piecesPerBoard(stock.sampleLength ?? boardLen, pieceLen, task.kerfCircMm),
      )
      const qtyNeeded = orderPieces > 0 ? orderPieces : stock.qty * ppb
      demand.set(dKey, { thicknessMm, widthMm, lengthMm: pieceLen, qtyNeeded })
    }
  }

  const done = new Map<string, number>()
  for (const cut of task.circularSaw?.cuts ?? []) {
    const key = rowKey(cut.thicknessMm, cut.widthMm, cut.lengthMm)
    done.set(key, (done.get(key) ?? 0) + Math.max(0, Math.round(Number(cut.qty))))
  }

  const merged = new Map<string, Omit<CircularRow, 'left'>>()
  for (const row of demand.values()) {
    const rawKey = rowKey(row.thicknessMm, row.widthMm, row.lengthMm)
    const stock = ready.get(rawKey)
    const lengthMm = normalizeCutLengthMm(row.lengthMm, stock?.sampleLength ?? null)
    const key = rowKey(row.thicknessMm, row.widthMm, lengthMm)
    const prev = merged.get(key)
    if (prev) {
      prev.qtyNeeded += row.qtyNeeded
      prev.boardsReady += stock?.qty ?? 0
      if (prev.sampleBoardLengthMm == null) prev.sampleBoardLengthMm = stock?.sampleLength ?? null
      prev.piecesPerBoard = piecesPerBoard(prev.sampleBoardLengthMm, prev.lengthMm, task.kerfCircMm)
      continue
    }
    merged.set(key, {
      thicknessMm: row.thicknessMm,
      widthMm: row.widthMm,
      lengthMm,
      key,
      qtyNeeded: row.qtyNeeded,
      qtyDone: done.get(key) ?? 0,
      boardsReady: stock?.qty ?? 0,
      sampleBoardLengthMm: stock?.sampleLength ?? null,
      piecesPerBoard: piecesPerBoard(stock?.sampleLength ?? null, lengthMm, task.kerfCircMm),
    })
  }

  return [...merged.values()]
    .sort((a, b) => b.thicknessMm - a.thicknessMm || b.widthMm - a.widthMm || b.lengthMm - a.lengthMm)
    .map((row) => {
      return {
        ...row,
        left: Math.max(0, row.qtyNeeded - row.qtyDone),
      }
    })
    .filter((row) => row.left > 0)
}

function CircularMiniVisual({ row }: { row: CircularRow }) {
  const boardLength = row.sampleBoardLengthMm ?? row.lengthMm
  const pieceCount = Math.max(1, row.piecesPerBoard || 1)
  const safeBoardLength = Math.max(boardLength, row.lengthMm * pieceCount)
  const piecePercent = (row.lengthMm / safeBoardLength) * 100
  const usedPercent = Math.min(100, piecePercent * pieceCount)
  return (
    <div className="circularMiniVisual" title={`Брус ${row.thicknessMm}×${row.widthMm}, деталь ${row.lengthMm} мм`}>
      <div className="circularMiniDims">
        {fmtMm(row.thicknessMm)} × {fmtMm(row.widthMm)}
      </div>
      <div className="circularMiniBar">
        {Array.from({ length: pieceCount }, (_, idx) => (
          <span
            key={idx}
            className="circularMiniPiece"
            style={{ width: `${Math.max(piecePercent, 8)}%` }}
          >
            {fmtCm(row.lengthMm)}
          </span>
        ))}
        {usedPercent < 100 && <span className="circularMiniWaste">зал.</span>}
      </div>
      <div className="circularMiniLength">
        Брус: {row.sampleBoardLengthMm != null ? fmtCm(row.sampleBoardLengthMm) : 'довжина не вказана'}
        {row.piecesPerBoard > 0 ? ` · з 1 бруса: ${row.piecesPerBoard} шт` : ''}
      </div>
    </div>
  )
}

export function CircularSawPage() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [tasksErr, setTasksErr] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<CircularConfirm | null>(null)
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

  const tasksForCircular = useMemo(() => {
    return tasks.filter((task) => {
      if (!task.assignTo.includes('circular_operator')) return false
      const k = task.taskKind ?? 'resaw'
      return k === 'circular' || k === 'resaw'
    })
  }, [tasks])

  useEffect(() => {
    if (selectedTaskId && tasksForCircular.some((task) => task.id === selectedTaskId)) return
    setSelectedTaskId(tasksForCircular[0]?.id ?? '')
  }, [selectedTaskId, tasksForCircular])

  const selectedTask = useMemo(
    () => tasksForCircular.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasksForCircular],
  )

  const canRecord =
    !!user &&
    (['circular_operator', 'foreman', 'admin', 'super_admin'].includes(user.role) ||
      user.tabs.includes('circular_saw'))

  const rows = useMemo(() => (selectedTask ? buildCircularRows(selectedTask) : []), [selectedTask])

  const lastCircularCut = useMemo(() => {
    const cuts = selectedTask?.circularSaw?.cuts ?? []
    return cuts.length > 0 ? cuts[cuts.length - 1]! : null
  }, [selectedTask])

  const canUndoLastCircularCut = useMemo(() => {
    if (!selectedTask || !user || !lastCircularCut || !canRecord) return false
    if (['foreman', 'admin', 'super_admin'].includes(user.role)) return true
    const aid = lastCircularCut.recordedBy?.id
    if (aid == null || String(aid).trim() === '') return false
    return String(aid) === String(user.id)
  }, [selectedTask, user, lastCircularCut, canRecord])

  const submitCut = async (row: CircularRow, qty: number) => {
    if (!selectedTask) return
    setBusyKey(row.key)
    try {
      const updated = await recordCircularSawCut(selectedTask.id, {
        thicknessMm: row.thicknessMm,
        widthMm: row.widthMm,
        lengthMm: row.lengthMm,
        qty,
      })
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)))
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[row.key]
        return next
      })
      setMsg(
        `Записано ${qty} шт деталей ${fmtMm(row.lengthMm)} з бруса ${fmtMm(row.thicknessMm)} × ${fmtMm(row.widthMm)}.`,
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не вдалося застосувати')
    } finally {
      setBusyKey(null)
    }
  }

  const applyRow = async (row: CircularRow) => {
    setErr(null)
    setMsg(null)
    setConfirm(null)
    const raw = Number(String(drafts[row.key] ?? '').replace(',', '.'))
    const qty = Math.round(raw)
    if (!Number.isFinite(raw) || qty <= 0 || Math.abs(raw - qty) > 1e-6) {
      setErr('Вкажіть цілу кількість деталей більше 0.')
      return
    }

    const neededBoards = row.piecesPerBoard > 0 ? Math.ceil(qty / row.piecesPerBoard) : qty
    if (neededBoards > row.boardsReady) {
      setConfirm({ row, qty, neededBoards })
      return
    }

    await submitCut(row, qty)
  }

  const handleUndoLastCircular = async () => {
    if (!selectedTask || !canUndoLastCircularCut) return
    setErr(null)
    setConfirm(null)
    setBusyKey('__undo__')
    try {
      const updated = await undoLastCircularSawCut(selectedTask.id)
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)))
      setMsg('Останній запис розкрою скасовано.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не вдалося скасувати')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <>
      <section className="panel circularSawPage">
        <header className="circularHero">
          <h2>Циркулярка - брус по довжині</h2>
        </header>

        {tasksErr && <p className="birkaMsgErr">{tasksErr}</p>}
        {!tasksErr && tasksForCircular.length === 0 && (
          <p className="panelHint circularSawOnlyCircularHint">
            Немає завдань з призначенням «Станок 2 / циркулярка». Бригадир додає його в ланцюг на сторінці
            «Завдання» — і для типу «Розпил», і для «Циркулярка».
          </p>
        )}

        {tasksForCircular.length > 0 ? (
        <>
        <div className="circularCard">
          <label className="circularField">
            <span className="circularFieldLabel">Завдання</span>
            <select
              value={selectedTaskId}
              onChange={(event) => {
                setSelectedTaskId(event.target.value)
                setDrafts({})
                setErr(null)
                setMsg(null)
                setConfirm(null)
              }}
            >
              <option value="">Оберіть завдання</option>
              {tasksForCircular.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        {msg && (
          <div className="circularOkBlock" role="status">
            <p className="circularOkMsg">{msg}</p>
            {canUndoLastCircularCut ? (
              <div className="circularUndoRow">
                <button
                  type="button"
                  className="ghost circularUndoLastBtn"
                  disabled={busyKey != null}
                  onClick={() => void handleUndoLastCircular()}
                >
                  {busyKey === '__undo__' ? '…' : 'Скасувати останній запис'}
                </button>
                <span className="panelHint circularUndoHint">
                  {lastCircularCut.qty} шт × {fmtMm(lastCircularCut.lengthMm)} (
                  {fmtMm(lastCircularCut.thicknessMm)} × {fmtMm(lastCircularCut.widthMm)})
                </span>
              </div>
            ) : null}
          </div>
        )}

        {selectedTask && rows.length === 0 && (
          <p className="circularDoneMsg">Усі деталі по цьому завданню закриті або ще немає брусів після багатопилу.</p>
        )}

        {selectedTask && rows.length > 0 && (
          <div className="circularSimpleTableWrap">
            <table className="circularSimpleTable">
              <thead>
                <tr>
                  <th>Брус / деталь</th>
                  <th>Візуально</th>
                  <th>Треба</th>
                  <th>Порізав</th>
                  <th>Залишилось</th>
                  <th>Брусів є</th>
                  <th>Скільки порізав</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="circularSimpleTdDetail" data-label="Брус / деталь">
                      <strong>
                        {fmtMm(row.thicknessMm)} × {fmtMm(row.widthMm)}
                      </strong>
                      <div className="circularSimpleSub">деталь {fmtCm(row.lengthMm)}</div>
                    </td>
                    <td className="circularSimpleTdVisual" data-label="Візуально">
                      <CircularMiniVisual row={row} />
                    </td>
                    <td className="circularSimpleTdStat" data-label="Треба">
                      {row.qtyNeeded}
                    </td>
                    <td className="circularSimpleTdStat" data-label="Порізав">
                      {row.qtyDone}
                    </td>
                    <td className="circularSimpleTdStat" data-label="Залишилось">
                      {row.left}
                    </td>
                    <td className="circularSimpleTdStat" data-label="Брусів є">
                      {row.boardsReady}
                    </td>
                    <td className="circularSimpleTdQtyInput" data-label="Скільки порізав">
                      <input
                        className="circularSimpleInput"
                        type="number"
                        min={1}
                        step={1}
                        value={drafts[row.key] ?? ''}
                        onChange={(event) =>
                          setDrafts((prev) => ({ ...prev, [row.key]: event.target.value }))
                        }
                        placeholder={row.piecesPerBoard > 0 ? String(Math.min(row.left, row.piecesPerBoard)) : '0'}
                      />
                    </td>
                    <td className="circularSimpleTdApply" data-label="">
                      <button
                        type="button"
                        className="circularBoardToPlanBtn"
                        disabled={!canRecord || busyKey === row.key || busyKey === '__undo__'}
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

        {!selectedTask && !tasksErr && tasksForCircular.length > 0 && (
          <p className="panelHint">Оберіть завдання для циркулярки.</p>
        )}
        </>
        ) : null}
      </section>

      {confirm && (
        <div className="circularModalBackdrop" role="presentation">
          <div className="circularModal" role="dialog" aria-modal="true" aria-labelledby="circularModalTitle">
            <h3 id="circularModalTitle">Перевірте кількість</h3>
            <p>
              Ви ввели <strong>{confirm.qty}</strong> шт деталей. Для цього потрібно приблизно{' '}
              <strong>{confirm.neededBoards}</strong> брусів, а в списку є{' '}
              <strong>{confirm.row.boardsReady}</strong>.
            </p>
            <p>
              Можливо помилились у кількості. Записати все одно?
            </p>
            <div className="circularModalActions">
              <button
                type="button"
                className="circularBoardToPlanBtn"
                disabled={busyKey === confirm.row.key || busyKey === '__undo__'}
                onClick={() =>
                  void submitCut(confirm.row, confirm.qty).then(() => setConfirm(null))
                }
              >
                {busyKey === confirm.row.key ? '...' : 'Записати'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busyKey === confirm.row.key || busyKey === '__undo__'}
                onClick={() => setConfirm(null)}
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
