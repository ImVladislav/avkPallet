import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTasks } from '../api'
import { AssignedTasksPanel } from '../components/AssignedTasksPanel'
import { useAuth } from '../context/AuthContext'
import {
  buildBestCutPlan,
  buildSequentialCutPlans,
  type CutPlanPiece,
  type RequestItem,
  type SequentialBoardCutStep,
} from '../helpers/cutPlan'
import { parseForemanOrderText, type OrderLine } from '../helpers/parseForemanOrders'
import { boardsFromTaskStripCuts, type TaskBoardFromInventoryRow } from '../helpers/taskBoardInventory'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { StripInventoryEntry, WorkTask } from '../types/task'

import './CircularSawPage.css'

/** Типова довжина смуги (мм) з журналу ленточної — за сумарною кількістю смуг. */
function dominantLogLengthMmFromStripInventory(inv: StripInventoryEntry[]): number | null {
  const byLen = new Map<number, number>()
  for (const e of inv) {
    const L = Math.round(Number(e.logLengthMm))
    const q = Math.round(Number(e.qty))
    if (!Number.isFinite(L) || L <= 0 || !Number.isFinite(q) || q <= 0) continue
    byLen.set(L, (byLen.get(L) ?? 0) + q)
  }
  let best: number | null = null
  let bestW = -1
  for (const [L, w] of byLen) {
    if (w > bestW || (w === bestW && best != null && L > best)) {
      bestW = w
      best = L
    }
  }
  return best
}

function orderLinesToRequests(lines: OrderLine[]): RequestItem[] {
  const map = new Map<number, number>()
  for (const l of lines) {
    const len = Math.round(l.lengthMm)
    map.set(len, (map.get(len) ?? 0) + l.qty)
  }
  let id = 1
  return [...map.entries()].map(([length, qty]) => ({ id: id++, length, qty }))
}

type VisualSegment = { type: 'piece' | 'kerf' | 'waste'; length: number; label: string }

type CutInstructionRow = {
  step: number
  pieceLength: number
  cutMarkFromLeftMm: number
  kerfAfterMm: number
  remainingOnRightMm: number
}

function buildCutInstructionTable(
  boardLengthMm: number,
  cutPlan: CutPlanPiece[],
  kerfMm: number,
): CutInstructionRow[] {
  let acc = 0
  return cutPlan.map((piece, i) => {
    acc += piece.length
    const cutMarkFromLeft = acc
    const kerfAfter = i < cutPlan.length - 1 ? kerfMm : 0
    const row: CutInstructionRow = {
      step: i + 1,
      pieceLength: piece.length,
      cutMarkFromLeftMm: cutMarkFromLeft,
      kerfAfterMm: kerfAfter,
      remainingOnRightMm: Math.max(0, boardLengthMm - cutMarkFromLeft),
    }
    acc += kerfAfter
    return row
  })
}

function usedLengthMm(cutPlan: CutPlanPiece[], kerfMm: number): number {
  return cutPlan.reduce((sum, piece, idx) => {
    const sawKerf = idx > 0 ? kerfMm : 0
    return sum + piece.length + sawKerf
  }, 0)
}

function piecesByLengthFromPlan(cutPlan: CutPlanPiece[]): [number, number][] {
  const m = new Map<number, number>()
  for (const p of cutPlan) {
    m.set(p.length, (m.get(p.length) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[0] - a[0])
}

function visualSegmentsForPlan(
  boardLengthMm: number,
  cutPlan: CutPlanPiece[],
  kerfMm: number,
  wasteMm: number,
): VisualSegment[] {
  if (boardLengthMm <= 0 || cutPlan.length === 0) return []
  const segments: VisualSegment[] = []
  cutPlan.forEach((piece, idx) => {
    segments.push({
      type: 'piece',
      length: piece.length,
      label: `${idx + 1}`,
    })
    if (idx < cutPlan.length - 1 && kerfMm > 0) {
      segments.push({ type: 'kerf', length: kerfMm, label: 'П' })
    }
  })
  if (wasteMm > 0) {
    segments.push({ type: 'waste', length: wasteMm, label: 'Залишок' })
  }
  return segments
}

type BoardCutPanelProps = {
  title: string
  boardLengthMm: number
  cutPlan: CutPlanPiece[]
  kerfMm: number
  boardRow?: TaskBoardFromInventoryRow
  totalBoards: number
  boardCount?: number
  boardRangeLabel?: string
}

function CircularBoardCutPanel({
  title,
  boardLengthMm,
  cutPlan,
  kerfMm,
  boardRow,
  totalBoards,
  boardCount = 1,
  boardRangeLabel,
}: BoardCutPanelProps) {
  const used = usedLengthMm(cutPlan, kerfMm)
  const wasteMm = boardLengthMm > 0 ? Math.max(boardLengthMm - used, 0) : 0
  const bandKerfLossMm = cutPlan.length <= 1 ? 0 : (cutPlan.length - 1) * kerfMm
  const piecesByLength = piecesByLengthFromPlan(cutPlan)
  const cutInstructionRows =
    boardLengthMm > 0 && cutPlan.length > 0
      ? buildCutInstructionTable(boardLengthMm, cutPlan, kerfMm)
      : []
  const visualSegments = visualSegmentsForPlan(boardLengthMm, cutPlan, kerfMm, wasteMm)

  return (
    <div className="circularPerBoardBlock">
      <div className="circularCard circularCardPerBoard">
        <h3 className="circularCardTitle">{title}</h3>
        {boardRow ? (
          <p className="panelHint circularPerBoardMeta">
            У черзі завдання:{' '}
            <strong>
              {boardRangeLabel ? `бруси ${boardRangeLabel}` : `брус ${boardRow.n}`}
            </strong>{' '}
            з <strong>{totalBoards}</strong>
            {boardCount > 1 ? (
              <>
                {' '}
                (<strong>{boardCount}</strong> шт)
              </>
            ) : null}
            . Смуга (факт):{' '}
            <strong>{boardRow.stripLengthsLabel}</strong> мм. Заготовка за замовл.:{' '}
            {boardRow.orderLengthMm != null ? (
              <strong>{boardRow.orderLengthMm}</strong>
            ) : (
              '—'
            )}{' '}
            мм.
          </p>
        ) : null}
        {cutPlan.length === 0 ? (
          <p className="panelHint">
            На цьому брусі не вміщується жодна заготовка з <strong>поточного залишку</strong> потреби —
            переходьте до наступного бруса або перевірте довжину / замовлення.
          </p>
        ) : (
          <>
            <dl className="circularSummaryGrid">
              <div>
                <dt>Довжина бруса</dt>
                <dd>
                  <strong>{boardLengthMm}</strong> мм
                </dd>
              </div>
              <div>
                <dt>Деталей з цього бруса</dt>
                <dd>
                  <strong>{cutPlan.length}</strong> шт
                </dd>
              </div>
              <div>
                <dt>Використано по довжині</dt>
                <dd>
                  <strong>{Math.round(used)}</strong> мм
                </dd>
              </div>
              <div>
                <dt>Залишок (відхід)</dt>
                <dd>
                  <strong>{wasteMm.toFixed(0)}</strong> мм
                </dd>
              </div>
              <div>
                <dt>Пропил між деталями</dt>
                <dd>
                  <strong>{bandKerfLossMm.toFixed(0)}</strong> мм
                  {cutPlan.length > 1 ? ` (${cutPlan.length - 1} × ${kerfMm})` : ''}
                </dd>
              </div>
            </dl>

            {piecesByLength.length > 0 ? (
              <div className="circularPiecesBreakdown">
                <h4 className="circularSubheading">З цього бруса виходить</h4>
                <ul className="circularPiecesBreakdownList">
                  {piecesByLength.map(([len, n]) => (
                    <li key={len}>
                      <strong>{len}</strong> мм — <strong>{n}</strong> шт
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>

      {cutPlan.length > 0 ? (
        <>
          <div className="circularCard">
            <h3 className="circularCardTitle">Схема по довжині</h3>
            <p className="panelHint circularBarHint">
              Від <strong>лівого</strong> торця: сині — заготовки, червоний — пропил, сірий — залишок.
            </p>
            <div className="circularScaleRow">
              <span>0</span>
              <span>{Math.round(boardLengthMm / 2)} мм</span>
              <span>{boardLengthMm} мм</span>
            </div>
            <div className="circularCutBar">
              {visualSegments.map((segment, idx) => {
                const widthPercent = (segment.length / boardLengthMm) * 100
                const className =
                  segment.type === 'piece'
                    ? 'circularSegPiece'
                    : segment.type === 'kerf'
                      ? 'circularSegKerf'
                      : 'circularSegWaste'
                return (
                  <div
                    key={`${segment.type}-${idx}`}
                    className={className}
                    style={{ width: `${Math.max(widthPercent, 0.6)}%` }}
                    title={`${segment.label}: ${segment.length} мм`}
                  >
                    <span className="circularSegLabel">{segment.label}</span>
                    <span className="circularSegMm">{segment.length} мм</span>
                  </div>
                )
              })}
            </div>
            <div className="circularLegend">
              <span>
                <span className="circularLegSwatch circularLegPiece" aria-hidden /> заготовка
              </span>
              <span>
                <span className="circularLegSwatch circularLegKerf" aria-hidden /> пропил
              </span>
              <span>
                <span className="circularLegSwatch circularLegWaste" aria-hidden /> залишок
              </span>
            </div>
          </div>

          <div className="circularCard">
            <h3 className="circularCardTitle">Таблиця різів (від лівого торця)</h3>
            <p className="panelHint circularTableHint">
              Мітка — відстань від лівого торця бруса. Після різу можна міряти від нового торця; між
              деталями пропил <strong>{kerfMm}</strong> мм.
            </p>
            <div className="circularTableWrap">
              <table className="circularCutTable">
                <thead>
                  <tr>
                    <th># різу</th>
                    <th>Заготовка, мм</th>
                    <th>Мітка від лівого торця, мм</th>
                    <th>Пропил після, мм</th>
                    <th>Залишок справа від мітки, мм</th>
                  </tr>
                </thead>
                <tbody>
                  {cutInstructionRows.map((row) => (
                    <tr key={row.step}>
                      <td>{row.step}</td>
                      <td>
                        <strong>{row.pieceLength}</strong>
                      </td>
                      <td>
                        <strong>{row.cutMarkFromLeftMm}</strong>
                      </td>
                      <td>{row.kerfAfterMm > 0 ? row.kerfAfterMm : '—'}</td>
                      <td>{Math.round(row.remainingOnRightMm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Етап 3: нарізка заготовок по довжині бруса (без обліку кругляка). */
export function CircularSawPage() {
  const { user } = useAuth()
  const lastAutoFillTaskIdRef = useRef<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksErr, setTasksErr] = useState<string | null>(null)
  const [kerf, setKerf] = useState('3')
  const [boardLengthMmStr, setBoardLengthMmStr] = useState('')
  const [requestLength, setRequestLength] = useState('1200')
  const [requestQty, setRequestQty] = useState('2')
  const [manualRequests, setManualRequests] = useState<RequestItem[]>([])

  const tasksFetchSeq = useRef(0)
  const reloadTasks = useCallback(() => {
    const n = ++tasksFetchSeq.current
    setTasksLoading(true)
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
      } finally {
        if (tasksFetchSeq.current === n) setTasksLoading(false)
      }
    })()
  }, [])

  useWorkTasksReload(reloadTasks)

  const tasksForCircular = useMemo(
    () => tasks.filter((t) => t.assignTo.includes('circular_operator')),
    [tasks],
  )

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [tasks, selectedTaskId],
  )

  const taskOrderParse = useMemo(() => {
    if (!selectedTask) return null
    return parseForemanOrderText(
      selectedTask.orderText,
      selectedTask.unit === 'cm' ? 'cm' : 'mm',
    )
  }, [selectedTask])

  const requests = useMemo(() => {
    if (selectedTaskId && selectedTask) {
      if (!taskOrderParse || !taskOrderParse.ok) return []
      return orderLinesToRequests(taskOrderParse.lines)
    }
    return manualRequests
  }, [selectedTaskId, selectedTask, taskOrderParse, manualRequests])

  const orderParseError =
    selectedTask && taskOrderParse && !taskOrderParse.ok ? taskOrderParse.error : null

  const effectiveKerfMm = useMemo(() => {
    if (selectedTask) return selectedTask.kerfCircMm
    return Number(String(kerf).replace(',', '.')) || 0
  }, [selectedTask, kerf])

  const boardLengthMm = useMemo(() => {
    const raw = Number(String(boardLengthMmStr).replace(',', '.'))
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  }, [boardLengthMmStr])

  const cutPlan = useMemo(() => {
    if (boardLengthMm <= 0) return []
    return buildBestCutPlan(boardLengthMm, requests, effectiveKerfMm)
  }, [boardLengthMm, requests, effectiveKerfMm])

  const totalRequestedPieces = useMemo(
    () => requests.reduce((s, r) => s + r.qty, 0),
    [requests],
  )

  const usedLength = useMemo(() => {
    return cutPlan.reduce((sum, piece, idx) => {
      const sawKerf = idx > 0 ? effectiveKerfMm : 0
      return sum + piece.length + sawKerf
    }, 0)
  }, [cutPlan, effectiveKerfMm])

  const wasteMm = boardLengthMm > 0 ? Math.max(boardLengthMm - usedLength, 0) : 0

  const bandKerfLossMm = useMemo(() => {
    if (cutPlan.length <= 1) return 0
    return (cutPlan.length - 1) * effectiveKerfMm
  }, [cutPlan.length, effectiveKerfMm])

  const piecesByLength = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of cutPlan) {
      m.set(p.length, (m.get(p.length) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0])
  }, [cutPlan])

  const cutInstructionRows = useMemo(
    () =>
      boardLengthMm > 0 && cutPlan.length > 0
        ? buildCutInstructionTable(boardLengthMm, cutPlan, effectiveKerfMm)
        : [],
    [boardLengthMm, cutPlan, effectiveKerfMm],
  )

  const visualSegments: VisualSegment[] = useMemo(() => {
    if (boardLengthMm <= 0 || cutPlan.length === 0) return []
    const segments: VisualSegment[] = []
    cutPlan.forEach((piece, idx) => {
      segments.push({
        type: 'piece',
        length: piece.length,
        label: `${idx + 1}`,
      })
      if (idx < cutPlan.length - 1 && effectiveKerfMm > 0) {
        segments.push({ type: 'kerf', length: effectiveKerfMm, label: 'П' })
      }
    })
    if (wasteMm > 0) {
      segments.push({ type: 'waste', length: wasteMm, label: 'Залишок' })
    }
    return segments
  }, [boardLengthMm, cutPlan, effectiveKerfMm, wasteMm])

  const addRequest = () => {
    if (selectedTaskId) return
    const l = Number(String(requestLength).replace(',', '.'))
    const q = Number(String(requestQty).replace(',', '.'))
    if (!l || !q || l <= 0 || q <= 0) return
    setManualRequests((prev) => [...prev, { id: Date.now(), length: Math.round(l), qty: Math.round(q) }])
  }

  const clearRequests = () => {
    if (selectedTaskId) return
    setManualRequests([])
  }

  const removeRequest = (id: number) => {
    if (selectedTaskId) return
    setManualRequests((prev) => prev.filter((r) => r.id !== id))
  }

  const minOrderLengthMm = selectedTask?.plan.alongLog?.minLogLengthMm

  const taskBoardRows = useMemo(() => {
    if (!selectedTask) return []
    const lines = taskOrderParse?.ok ? taskOrderParse.lines : null
    return boardsFromTaskStripCuts(selectedTask, lines)
  }, [selectedTask, taskOrderParse])

  const hasStripInventory = Boolean(
    selectedTask?.stripInventory && selectedTask.stripInventory.length > 0,
  )

  const boardsForSequential = useMemo(
    () => taskBoardRows.filter((r) => r.stripLengthPrimaryMm > 0),
    [taskBoardRows],
  )

  const sequentialCutResult = useMemo(() => {
    if (!requests.length || boardsForSequential.length === 0) {
      return { steps: [] as SequentialBoardCutStep[], remainingRequests: [] as RequestItem[] }
    }
    return buildSequentialCutPlans(
      boardsForSequential.map((r) => r.stripLengthPrimaryMm),
      requests,
      effectiveKerfMm,
    )
  }, [boardsForSequential, requests, effectiveKerfMm])

  const useSequentialLayout =
    Boolean(selectedTaskId) && boardsForSequential.length > 0 && requests.length > 0

  const remainingPiecesAfterSequential = useMemo(
    () => sequentialCutResult.remainingRequests.reduce((s, r) => s + r.qty, 0),
    [sequentialCutResult.remainingRequests],
  )

  const sequentialPlanReady = useSequentialLayout && sequentialCutResult.steps.length > 0

  const groupedSequentialSteps = useMemo(() => {
    if (!sequentialPlanReady) return []
    const out: Array<{
      step: SequentialBoardCutStep
      row: TaskBoardFromInventoryRow | undefined
      from: number
      to: number
      count: number
      sig: string
    }> = []
    for (let idx = 0; idx < sequentialCutResult.steps.length; idx += 1) {
      const step = sequentialCutResult.steps[idx]!
      const row = boardsForSequential[idx]
      const cutSig = step.cutPlan.map((p) => p.length).join(',')
      const sig = [
        step.boardLengthMm,
        cutSig,
        row?.thicknessMm ?? '',
        row?.widthMm ?? '',
        row?.orderLengthMm ?? '',
        row?.stripLengthsLabel ?? '',
      ].join('|')
      const last = out[out.length - 1]
      if (last && last.sig === sig) {
        last.to = idx + 1
        last.count += 1
      } else {
        out.push({
          step,
          row,
          from: idx + 1,
          to: idx + 1,
          count: 1,
          sig,
        })
      }
    }
    return out
  }, [sequentialPlanReady, sequentialCutResult.steps, boardsForSequential])

  const planReady =
    !useSequentialLayout && boardLengthMm > 0 && requests.length > 0 && cutPlan.length > 0

  /** Лише коли брус уже заданий і щось вміщується, але не все замовлення (інакше це «не ввели L» або «нічого не лізе»). */
  const notAllFitSingle =
    !useSequentialLayout &&
    boardLengthMm > 0 &&
    cutPlan.length > 0 &&
    totalRequestedPieces > 0 &&
    cutPlan.length < totalRequestedPieces

  const dominantInvLengthMm = useMemo(() => {
    if (!selectedTask?.stripInventory?.length) return null
    return dominantLogLengthMmFromStripInventory(selectedTask.stripInventory)
  }, [selectedTask])

  /** Поки немає брусів зі ст.2 — підставляємо довжину смуги з ленточної, щоб одразу була карта різів. */
  useEffect(() => {
    if (!selectedTaskId || !selectedTask) {
      lastAutoFillTaskIdRef.current = null
      return
    }
    if (boardsForSequential.length > 0) return
    const inv = selectedTask.stripInventory
    if (!inv?.length) return
    const L = dominantLogLengthMmFromStripInventory(inv)
    if (L == null) return

    const taskSwitched = lastAutoFillTaskIdRef.current !== selectedTaskId
    lastAutoFillTaskIdRef.current = selectedTaskId

    setBoardLengthMmStr((prev) => {
      const t = prev.trim()
      if (taskSwitched) return String(L)
      if (t === '') return String(L)
      return prev
    })
  }, [selectedTaskId, selectedTask, boardsForSequential.length])

  return (
    <>
      {user?.role === 'circular_operator' && <AssignedTasksPanel />}
      <section className="panel circularSawPage">
        <header className="circularHero">
          <h2>Циркулярка — розкрій бруса по довжині</h2>
          <p className="circularHeroLead">
            Кругляк не потрібен. Якщо обрано завдання зі списком брусів після станка 2 — показуємо{' '}
            <strong>чергу брусів</strong>: берете перший (наприклад 4 м), ріжете по схемі, потім
            наступний і т.д., а потреба з замовлення зменшується після кожного бруса. Без завдання —
            одна довжина бруса вручну і одна карта різів.
          </p>
        </header>

        <div className="circularCard">
          <h3 className="circularCardTitle">1. Завдання</h3>
          <p className="panelHint circularCardHint">
            Можна взяти довжини з призначеного завдання або задати вручну (коли завдання не обране).
          </p>
          <label className="circularField">
            <span className="circularFieldLabel">Завдання</span>
            <select
              value={selectedTaskId ?? ''}
              onChange={(e) => setSelectedTaskId(e.target.value || null)}
              disabled={tasksLoading}
            >
              <option value="">Без завдання — тільки ручний список довжин</option>
              {tasksForCircular.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.status === 'in_progress' ? ' · у роботі' : ''}
                </option>
              ))}
            </select>
          </label>
          {tasksLoading && <p className="panelHint">Завантаження завдань…</p>}
          {tasksErr && <p className="birkaMsgErr">{tasksErr}</p>}
          {!tasksLoading && tasksForCircular.length === 0 && !tasksErr && (
            <p className="panelHint">
              Немає завдань з роллю «циркулярка». Це не заважає працювати вручну нижче.
            </p>
          )}
        </div>

        {selectedTask && (
          <div className="circularTaskPill">
            <strong>{selectedTask.title}</strong>
            {typeof minOrderLengthMm === 'number' && (
              <span className="circularTaskPillMeta">
                {' '}
                · оцінка мін. довжини під усе замовлення:{' '}
                <strong>{Math.round(minOrderLengthMm)} мм</strong>
              </span>
            )}
          </div>
        )}

        <div className="circularCard">
          <h3 className="circularCardTitle">2. Брус і пропил</h3>
          <div className="circularTwoCol">
            <label className="circularField">
              <span className="circularFieldLabel">Довжина бруса (мм)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={boardLengthMmStr}
                onChange={(e) => setBoardLengthMmStr(e.target.value)}
                placeholder="Напр. 6000"
                className="circularInputLg"
              />
              <span className="circularFieldHint">
                {useSequentialLayout
                  ? 'Для режиму з завданням розкрій нижче — по кожному брусу з таблиці; це поле для ручної перевірки одного бруса.'
                  : dominantInvLengthMm != null ? `Якщо ще немає записів станка 2, довжина підставляється з журналу смуг (ленточна), найчастіше ${dominantInvLengthMm} мм — перевірте фактичний брус.`
                    : 'Виміряйте готовий брус або візьміть довжину зі смуги після ленточної.'}
              </span>
            </label>
            <label className="circularField">
              <span className="circularFieldLabel">Пропил між деталями (мм)</span>
              <input
                value={selectedTask ? String(selectedTask.kerfCircMm) : kerf}
                onChange={(e) => setKerf(e.target.value)}
                type="number"
                min={0}
                disabled={!!selectedTask}
                title={selectedTask ? 'Береться з завдання' : undefined}
              />
              {selectedTask ? (
                <span className="circularFieldHint">Зафіксовано в завданні.</span>
              ) : null}
            </label>
          </div>

          {selectedTask ? (
            <>
              <p className="panelHint circularBoardsIntro">
                Бруси з цього завдання (після <strong>станка 2</strong>). Робочий порядок:{' '}
                <strong>1-й брус</strong> у списку → карта різів для нього → <strong>2-й</strong> →
                … Потреба з замовлення оновлюється після кожного бруса. Кнопка «У поле» лише
                підставляє довжину одного бруса у поле вручну.
              </p>
              {!hasStripInventory ? (
                <p className="panelHint circularBoardsWarn">
                  У завданні ще немає записів <strong>stripInventory</strong> (смуги з ленточної) —
                  фактичні довжини смуг можуть бути невідомі (показ «—» або 0).
                </p>
              ) : null}
              {taskBoardRows.length === 0 ? (
                <p className="panelHint">
                  Поки немає записів розпилу станка 2 — список брусів з’явиться після реєстрації
                  розпилу смуг у завданні.
                </p>
              ) : (
                <div className="circularBoardsTableWrap">
                  <table className="circularBoardsTable">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Товщина, мм</th>
                        <th>Ширина, мм</th>
                        <th>Довжина за замовл., мм</th>
                        <th>Довжина смуги (факт), мм</th>
                        <th>У поле</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskBoardRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.n}</td>
                          <td>{row.thicknessMm}</td>
                          <td>{row.widthMm}</td>
                          <td>{row.orderLengthMm != null ? row.orderLengthMm : '—'}</td>
                          <td>
                            <strong>{row.stripLengthsLabel}</strong>
                            {row.stripFactLengthsMm.filter((x) => x > 0).length > 1 ? (
                              <span className="circularBoardsStripNote" title="Кілька смуг у записі">
                                {' '}
                                (кілька смуг)
                              </span>
                            ) : null}
                          </td>
                          <td>
                            {row.stripLengthPrimaryMm > 0 ? (
                              <button
                                type="button"
                                className="circularBoardToPlanBtn"
                                onClick={() =>
                                  setBoardLengthMmStr(String(row.stripLengthPrimaryMm))
                                }
                              >
                                У поле
                              </button>
                            ) : (
                              <span className="circularBoardsNoLen">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="panelHint circularBoardsIntro">
              Оберіть завдання вище — тут з’явиться список брусів із записів станка 2 по цьому
              завданню.
            </p>
          )}
        </div>

        {!selectedTaskId && (
          <div className="circularCard">
            <h3 className="circularCardTitle">3. Заготовки (вручну)</h3>
            <div className="circularManualRow">
              <label className="circularField circularFieldCompact">
                <span className="circularFieldLabel">Довжина (мм)</span>
                <input
                  value={requestLength}
                  onChange={(e) => setRequestLength(e.target.value)}
                  type="number"
                  min={1}
                />
              </label>
              <label className="circularField circularFieldCompact">
                <span className="circularFieldLabel">Кількість (шт)</span>
                <input
                  value={requestQty}
                  onChange={(e) => setRequestQty(e.target.value)}
                  type="number"
                  min={1}
                />
              </label>
              <div className="circularManualActions">
                <button type="button" onClick={addRequest} className="circularBtnPrimary">
                  Додати в список
                </button>
                <button type="button" onClick={clearRequests} className="ghost">
                  Очистити
                </button>
              </div>
            </div>
          </div>
        )}

        {orderParseError && (
          <p className="birkaMsgErr">Помилка замовлення в завданні: {orderParseError}</p>
        )}

        <div className="circularCard">
          <h3 className="circularCardTitle">
            {selectedTaskId ? '3. Потреба по довжинах (з завдання)' : '4. Потреба по довжинах'}
          </h3>
          {requests.length === 0 ? (
            <p className="panelHint">
              {selectedTaskId
                ? 'Немає розпізнаних довжин у замовленні або завдання з помилкою.'
                : 'Додайте рядки вище або оберіть завдання.'}
            </p>
          ) : (
            <ul className="circularDemandList">
              {requests.map((req) => (
                <li key={req.id} className="circularDemandItem">
                  <span className="circularDemandDims">
                    <strong>{req.length}</strong> мм
                  </span>
                  <span className="circularDemandQty">× {req.qty} шт</span>
                  {!selectedTaskId && (
                    <button
                      type="button"
                      className="circularDemandRemove"
                      onClick={() => removeRequest(req.id)}
                      aria-label="Прибрати рядок"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {totalRequestedPieces > 0 && (
            <p className="circularDemandTotal">
              Усього заготовок за нормою: <strong>{totalRequestedPieces}</strong> шт
            </p>
          )}
        </div>

        {!useSequentialLayout &&
          boardLengthMm > 0 &&
          typeof minOrderLengthMm === 'number' &&
          boardLengthMm + 0.5 < minOrderLengthMm && (
            <p className="birkaMsgErr circularWarn">
              Довжина бруса ({boardLengthMm} мм) менша за оцінковий мінімум під це замовлення (
              {Math.round(minOrderLengthMm)} мм). Перевірте брус або замовлення.
            </p>
          )}

        {notAllFitSingle && (
          <p className="birkaMsgErr circularWarn">
            З цього бруса вміщується лише <strong>{cutPlan.length}</strong> заготовок з{' '}
            <strong>{totalRequestedPieces}</strong> потрібних. Збільште довжину бруса, зменште
            кількість або зніміть зайві довжини зі списку — підбираємо набір, що максимізує сумарну
            довжину вироблених заготовок.
          </p>
        )}

        {sequentialPlanReady && (
          <div className="circularSequentialSection">
            <h3 className="circularSequentialTitle">Черга розкрою по брусах</h3>
            <p className="panelHint">
              Ідіть зверху вниз: спочатку повністю наріжте <strong>брус 1</strong>, потім{' '}
              <strong>брус 2</strong> вже з урахуванням залишку потреби після першого.
            </p>
            {groupedSequentialSteps.map((g) => {
              const row = g.row
              const rangeLabel = g.from === g.to ? String(g.from) : `${g.from}-${g.to}`
              const title = row
                ? `Бруси ${rangeLabel} з ${boardsForSequential.length}: ${g.step.boardLengthMm} мм · товщ. ${row.thicknessMm} × шир. ${row.widthMm} мм${g.count > 1 ? ` · ×${g.count}` : ''}`
                : `Бруси ${rangeLabel} з ${boardsForSequential.length}: ${g.step.boardLengthMm} мм${g.count > 1 ? ` · ×${g.count}` : ''}`
              return (
                <CircularBoardCutPanel
                  key={`${row?.id ?? g.from}-${g.from}-${g.to}`}
                  title={title}
                  boardLengthMm={g.step.boardLengthMm}
                  cutPlan={g.step.cutPlan}
                  kerfMm={effectiveKerfMm}
                  boardRow={row}
                  totalBoards={boardsForSequential.length}
                  boardCount={g.count}
                  boardRangeLabel={rangeLabel}
                />
              )
            })}
            {remainingPiecesAfterSequential > 0 ? (
              <p className="birkaMsgErr circularWarn">
                Після останнього бруса в списку лишається потреба:{' '}
                <strong>{remainingPiecesAfterSequential}</strong> заготовок (за сумою довжин у
                замовленні). Додайте бруси через станок 2 або перевірте довжини / кількості.
              </p>
            ) : null}
          </div>
        )}

        {useSequentialLayout && !sequentialPlanReady && requests.length > 0 ? (
          <p className="panelHint">
            Немає брусів з відомою довжиною смуги (0 мм) — дочекайтесь записів станка 2 або
            ленточної з довжиною смуги.
          </p>
        ) : null}

        {planReady && (
          <>
            <div className="circularCard circularCardHighlight">
              <h3 className="circularCardTitle">Карта розкрою</h3>
              <dl className="circularSummaryGrid">
                <div>
                  <dt>Брус</dt>
                  <dd>
                    <strong>{boardLengthMm}</strong> мм
                  </dd>
                </div>
                <div>
                  <dt>Деталей з бруса</dt>
                  <dd>
                    <strong>{cutPlan.length}</strong> шт
                  </dd>
                </div>
                <div>
                  <dt>Використано по довжині</dt>
                  <dd>
                    <strong>{Math.round(usedLength)}</strong> мм
                  </dd>
                </div>
                <div>
                  <dt>Залишок (відхід)</dt>
                  <dd>
                    <strong>{wasteMm.toFixed(0)}</strong> мм
                  </dd>
                </div>
                <div>
                  <dt>Пропил між деталями</dt>
                  <dd>
                    <strong>{bandKerfLossMm.toFixed(0)}</strong> мм
                    {cutPlan.length > 1 ? ` (${cutPlan.length - 1} × ${effectiveKerfMm})` : ''}
                  </dd>
                </div>
              </dl>

              {piecesByLength.length > 0 && (
                <div className="circularPiecesBreakdown">
                  <h4 className="circularSubheading">Що виходить з цього бруса</h4>
                  <ul className="circularPiecesBreakdownList">
                    {piecesByLength.map(([len, n]) => (
                      <li key={len}>
                        <strong>{len}</strong> мм — <strong>{n}</strong> шт
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="circularCard">
              <h3 className="circularCardTitle">Схема по довжині бруса</h3>
              <p className="panelHint circularBarHint">
                Від <strong>лівого</strong> торця: сині блоки — заготовки за порядком різів, червоний —
                пропил, сірий — залишок бруса.
              </p>
              <div className="circularScaleRow">
                <span>0</span>
                <span>{Math.round(boardLengthMm / 2)} мм</span>
                <span>{boardLengthMm} мм</span>
              </div>
              <div className="circularCutBar">
                {visualSegments.map((segment, idx) => {
                  const widthPercent = (segment.length / boardLengthMm) * 100
                  const className =
                    segment.type === 'piece'
                      ? 'circularSegPiece'
                      : segment.type === 'kerf'
                        ? 'circularSegKerf'
                        : 'circularSegWaste'
                  return (
                    <div
                      key={`${segment.type}-${idx}`}
                      className={className}
                      style={{ width: `${Math.max(widthPercent, 0.6)}%` }}
                      title={`${segment.label}: ${segment.length} мм`}
                    >
                      <span className="circularSegLabel">{segment.label}</span>
                      <span className="circularSegMm">{segment.length} мм</span>
                    </div>
                  )
                })}
              </div>
              <div className="circularLegend">
                <span>
                  <span className="circularLegSwatch circularLegPiece" aria-hidden /> заготовка
                </span>
                <span>
                  <span className="circularLegSwatch circularLegKerf" aria-hidden /> пропил
                </span>
                <span>
                  <span className="circularLegSwatch circularLegWaste" aria-hidden /> залишок
                </span>
              </div>
            </div>

            <div className="circularCard">
              <h3 className="circularCardTitle">Таблиця різів (від лівого торця бруса)</h3>
              <p className="panelHint circularTableHint">
                Мітка — відстань від початкового лівого торця, де робити різ, щоб відокремити чергову
                заготовку зліва. Після кожного різу можна знову вести лінійку від нового торця: тоді
                наступна довжина дорівнює колонці «Заготовка, мм» (між деталями — пропил{' '}
                {effectiveKerfMm} мм).
              </p>
              <div className="circularTableWrap">
                <table className="circularCutTable">
                  <thead>
                    <tr>
                      <th>№ різу</th>
                      <th>Заготовка, мм</th>
                      <th>Мітка від лівого торця, мм</th>
                      <th>Пропил після, мм</th>
                      <th>Залишок справа від мітки, мм</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cutInstructionRows.map((row) => (
                      <tr key={row.step}>
                        <td>{row.step}</td>
                        <td>
                          <strong>{row.pieceLength}</strong>
                        </td>
                        <td>
                          <strong>{row.cutMarkFromLeftMm}</strong>
                        </td>
                        <td>{row.kerfAfterMm > 0 ? row.kerfAfterMm : '—'}</td>
                        <td>{Math.round(row.remainingOnRightMm)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {!useSequentialLayout &&
          boardLengthMm > 0 &&
          requests.length > 0 &&
          cutPlan.length === 0 &&
          !orderParseError && (
            <p className="panelHint">
              Не вдалося вкласти жодну заготовку у брус {boardLengthMm} мм — перевірте довжини та
              пропил.
            </p>
          )}

        {!useSequentialLayout && boardLengthMm <= 0 && requests.length > 0 && (
          <p className="panelHint">Введіть довжину бруса (мм), щоб побачити карту розкрою.</p>
        )}
      </section>
    </>
  )
}
