import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTasks, recordCircularSawCut } from '../api'
import { useAuth } from '../context/AuthContext'
import {
  boardWidthAcrossStripForThickness,
  parseForemanOrderText,
} from '../helpers/parseForemanOrders'
import { boardsFromTaskStripCuts } from '../helpers/taskBoardInventory'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
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
  const parsed = parseForemanOrderText(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
  if (!parsed.ok) return []

  const demand = new Map<
    string,
    { thicknessMm: number; widthMm: number; lengthMm: number; qtyNeeded: number }
  >()
  for (const line of parsed.lines) {
    const thicknessMm = Math.round(line.aMm)
    const widthMm = Math.round(boardWidthAcrossStripForThickness(line, thicknessMm) ?? line.bMm)
    const lengthMm = Math.round(line.lengthMm)
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

  const tasksForCircular = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.assignTo.includes('circular_operator') &&
          (task.taskKind ?? 'resaw') !== 'pallets',
      ),
    [tasks],
  )

  useEffect(() => {
    if (selectedTaskId && tasksForCircular.some((task) => task.id === selectedTaskId)) return
    setSelectedTaskId(tasksForCircular[0]?.id ?? '')
  }, [selectedTaskId, tasksForCircular])

  const selectedTask = useMemo(
    () => tasksForCircular.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasksForCircular],
  )

  const rows = useMemo(() => (selectedTask ? buildCircularRows(selectedTask) : []), [selectedTask])
  const canRecord =
    !!user &&
    (['circular_operator', 'foreman', 'admin', 'super_admin'].includes(user.role) ||
      user.tabs.includes('circular_saw'))

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

  return (
    <>
      <section className="panel circularSawPage">
        <header className="circularHero">
          <h2>Циркулярка - брус по довжині</h2>
          <p className="circularHeroLead">
            Оберіть завдання, подивіться який брус різати, на який розмір деталі, скільки треба,
            скільки вже порізано і скільки залишилось.
          </p>
        </header>

        {tasksErr && <p className="birkaMsgErr">{tasksErr}</p>}
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

        {err && <p className="birkaMsgErr">{err}</p>}
        {msg && <p className="circularOkMsg">{msg}</p>}

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
                    <td data-label="Брус / деталь">
                      <strong>
                        {fmtMm(row.thicknessMm)} × {fmtMm(row.widthMm)}
                      </strong>
                      <div className="circularSimpleSub">деталь {fmtCm(row.lengthMm)}</div>
                    </td>
                    <td data-label="Візуально">
                      <CircularMiniVisual row={row} />
                    </td>
                    <td data-label="Треба">{row.qtyNeeded}</td>
                    <td data-label="Порізав">{row.qtyDone}</td>
                    <td data-label="Залишилось">{row.left}</td>
                    <td data-label="Брусів є">{row.boardsReady}</td>
                    <td data-label="Скільки порізав">
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
                    <td data-label="">
                      <button
                        type="button"
                        className="circularBoardToPlanBtn"
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

        {!selectedTask && !tasksErr && <p className="panelHint">Оберіть завдання для циркулярки.</p>}
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
                disabled={busyKey === confirm.row.key}
                onClick={() =>
                  void submitCut(confirm.row, confirm.qty).then(() => setConfirm(null))
                }
              >
                {busyKey === confirm.row.key ? '...' : 'Записати'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busyKey === confirm.row.key}
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
