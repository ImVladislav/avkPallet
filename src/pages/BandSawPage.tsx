import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  consumeRoundwoodLog,
  fetchRoundwoodState,
  fetchTasks,
  patchRoundwoodStockItem,
  recordBandCut,
} from '../api'
import { AssignedTasksPanel } from '../components/AssignedTasksPanel'
import { useAuth } from '../context/AuthContext'
import {
  BAND_CROSS_FIT_STORAGE_KEY,
  buildResawRulerSteps,
  buildStackedBandCrossSection,
  buildStackedBandCrossSectionForDemand,
  crossSectionSouthPoleGapAfterLastRow,
  markSurplusStripsInCrossRows,
  maxThicknessFeasibleForRadius,
  type BandCrossFitMode,
} from '../helpers/crossSection'
import {
  bandRemainingQty,
  recomputeBandPlanForRadius,
  sortBandByLeastWaste,
} from '../helpers/foremanPlan'
import { boardsPerPhysicalStrip, workpiecesAlongOneLog } from '../helpers/alongLogPieces'
import {
  orderPieceLengthsForThicknessMm,
  orderWidthSummaryForThicknessMm,
  parseForemanOrderText,
} from '../helpers/parseForemanOrders'
import { sortLogsLargeFirst } from '../helpers/logsStorage'
import type { LogItem } from '../types/roundwood'
import { useRoundwoodReload } from '../hooks/useRoundwoodReload'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { WorkTask } from '../types/task'

function fmtCm(mm: number): string {
  const cm = mm / 10
  const r = Math.round(cm * 10) / 10
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1).replace(/\.0$/, '')
  return `${s} см`
}

/** Радіус кола торця в одиницях viewBox (майже впоперек 240px — менше «обрізання» схеми). */
const SVG_LOG_RADIUS = 119

/** Один знак після коми, кома як десятковий роздільник (мм). */
function fmtMmOneDecimal(n: number): string {
  return n.toFixed(1).replace('.', ',')
}

function readStoredBandCrossFit(): BandCrossFitMode {
  try {
    const v = localStorage.getItem(BAND_CROSS_FIT_STORAGE_KEY)
    if (v === 'max_inscribed') return 'max_inscribed'
  } catch {
    /* ignore */
  }
  return 'min_waste'
}

/** Етап 1: ленточна знімає смуги заданої товщини (висота в торці), різ вздовж усієї осі колоди — без нарізки по довжині. */
export function BandSawPage() {
  const { user } = useAuth()
  const [logs, setLogs] = useState<LogItem[]>([])
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksErr, setTasksErr] = useState<string | null>(null)
  const [kerf, setKerf] = useState('4')
  const [boardThickness, setBoardThickness] = useState('25')
  const [editRadius, setEditRadius] = useState('')
  const [editLength, setEditLength] = useState('')
  const [bandCutDraft, setBandCutDraft] = useState<Record<number, string>>({})
  const [bandCutBusy, setBandCutBusy] = useState(false)
  const [bandCutMsg, setBandCutMsg] = useState<string | null>(null)
  const [bandCutErr, setBandCutErr] = useState(false)
  const [bandCrossFit, setBandCrossFit] = useState<BandCrossFitMode>(readStoredBandCrossFit)
  /** Показання 1-го різу (мм, одна цифра після коми); порожньо — лише геометрія з тим же округленням. */
  const [resawFirstCutMm, setResawFirstCutMm] = useState('')

  const bandCutSeedKeyRef = useRef<string | null>(null)
  const [bandCalcOpen, setBandCalcOpen] = useState(false)
  const [hideCompletedBandRows, setHideCompletedBandRows] = useState(false)

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

  const roundwoodSeq = useRef(0)
  const reloadRoundwood = useCallback(() => {
    const n = ++roundwoodSeq.current
    void (async () => {
      try {
        const { stock } = await fetchRoundwoodState()
        if (roundwoodSeq.current !== n) return
        setLogs(stock)
      } catch {
        if (roundwoodSeq.current !== n) return
        setLogs([])
      }
    })()
  }, [])

  useRoundwoodReload(reloadRoundwood)

  useEffect(() => {
    try {
      localStorage.setItem(BAND_CROSS_FIT_STORAGE_KEY, bandCrossFit)
    } catch {
      /* ignore */
    }
  }, [bandCrossFit])

  useEffect(() => {
    setBandCutDraft({})
    setBandCutMsg(null)
    setBandCutErr(false)
    bandCutSeedKeyRef.current = null
    // За замовчуванням оператор бачить тільки позиції, які ще треба різати.
    setHideCompletedBandRows(true)
  }, [selectedTaskId])

  const tasksForBand = useMemo(
    () => tasks.filter((t) => t.assignTo.includes('sawyer')),
    [tasks],
  )

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [tasks, selectedTaskId],
  )

  const selectedLog = useMemo(
    () => logs.find((item) => item.id === selectedLogId) ?? null,
    [logs, selectedLogId],
  )

  const logsForSelect = useMemo(() => sortLogsLargeFirst(logs), [logs])

  const effectiveKerfMm = useMemo(() => {
    if (selectedTask) return selectedTask.kerfBandMm
    return Number(kerf) || 0
  }, [selectedTask, kerf])

  /** План ленточної під радіус завдання або обраної колоди — сортування: мін. перерізи, мін. надлишок. */
  const bandSortedForLog = useMemo(() => {
    if (!selectedTask?.plan.band.length) return []
    const rMm = selectedLog?.radius ?? selectedTask.radiusMm
    return sortBandByLeastWaste(
      recomputeBandPlanForRadius(rMm, effectiveKerfMm, selectedTask.plan.band, bandCrossFit),
    )
  }, [selectedTask, selectedLog, effectiveKerfMm, bandCrossFit])

  const bandCompletedCount = useMemo(
    () => bandSortedForLog.filter((b) => bandRemainingQty(b) === 0).length,
    [bandSortedForLog],
  )

  const bandTableRows = useMemo(() => {
    if (!hideCompletedBandRows) return bandSortedForLog
    return bandSortedForLog.filter((b) => bandRemainingQty(b) > 0)
  }, [bandSortedForLog, hideCompletedBandRows])

  const preferredThicknessMm = bandSortedForLog[0]?.thicknessMm

  /** Для карти торця: тільки товщини з незакритим залишком (вже виконані не показуємо). */
  const bandFullOrderForMap = useMemo(() => {
    if (!bandSortedForLog.length) return []
    return [...bandSortedForLog]
      .filter((b) => bandRemainingQty(b) > 0)
      .sort((a, b) => {
        const aOk = a.feasible !== false && (a.boardsFromOneCrossSection ?? 0) > 0
        const bOk = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
        if (aOk !== bOk) return aOk ? -1 : 1
        return b.thicknessMm - a.thicknessMm
      })
  }, [bandSortedForLog])

  /** Порядок товщин на одному торці (зовні → всередину): настоювання рядів у схемі. */
  const stackThicknessesMm = useMemo(() => {
    const manual = Number(boardThickness) || 0
    if (!selectedTask?.plan.band.length || !bandFullOrderForMap.length) {
      return manual > 0 ? [manual] : []
    }
    const seq = bandFullOrderForMap
      .filter((b) => b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0)
      .map((b) => b.thicknessMm)
    return seq.length > 0 ? seq : manual > 0 ? [manual] : []
  }, [selectedTask, bandFullOrderForMap, boardThickness])

  /** Для завдання: товщина схеми торця — перша виконувана з порядку фізичного різання (усі товщини вже зведені в цей порядок вище). */
  const displayThicknessMm = useMemo(() => {
    if (!selectedTask?.plan.band.length || !bandFullOrderForMap.length) {
      return Number(boardThickness) || 0
    }
    const firstOk = bandFullOrderForMap.find(
      (b) => b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0,
    )
    if (firstOk) return firstOk.thicknessMm
    return bandFullOrderForMap[0]?.thicknessMm ?? 0
  }, [selectedTask, bandFullOrderForMap, boardThickness])

  const taskOrderLines = useMemo(() => {
    if (!selectedTask) return null
    const p = parseForemanOrderText(
      selectedTask.orderText,
      selectedTask.unit === 'cm' ? 'cm' : 'mm',
    )
    return p.ok ? p.lines : null
  }, [selectedTask])

  const orderWidthByThickness = useMemo(() => {
    const m = new Map<number, ReturnType<typeof orderWidthSummaryForThicknessMm>>()
    if (!taskOrderLines?.length) return m
    for (const t of stackThicknessesMm) {
      const s = orderWidthSummaryForThicknessMm(taskOrderLines, t)
      if (s) m.set(t, s)
    }
    return m
  }, [taskOrderLines, stackThicknessesMm])

  useEffect(() => {
    if (preferredThicknessMm == null) return
    setBoardThickness(String(preferredThicknessMm))
  }, [selectedTaskId, selectedLogId, preferredThicknessMm])

  const maxThHintMm = useMemo(() => {
    const r = selectedLog?.radius ?? selectedTask?.radiusMm
    if (r == null || r <= 0) return null
    return maxThicknessFeasibleForRadius(r, effectiveKerfMm, bandCrossFit)
  }, [selectedLog, selectedTask, effectiveKerfMm, bandCrossFit])

  /** Скільки деталей по довжині дає одна знята смуга (для обраної колоди). */
  const boardsPerStripByThickness = useMemo(() => {
    const m = new Map<number, number>()
    if (!selectedLog || !taskOrderLines?.length || !selectedTask) return m
    const kerf = selectedTask.kerfCircMm
    for (const row of selectedTask.plan.band) {
      m.set(
        row.thicknessMm,
        boardsPerPhysicalStrip(taskOrderLines, row.thicknessMm, selectedLog.length, kerf),
      )
    }
    return m
  }, [selectedTask, taskOrderLines, selectedLog])

  /**
   * Підстановка в полі «Смуг на зріз»: не більше норми по довжині (ceil(залишок/per)),
   * орієнтир — скільки дощок видно на торці в одному «шарі» (boardsFromOneCrossSection).
   */
  const suggestedBandCutDraft = useMemo(() => {
    if (!selectedLog || !selectedTask || bandSortedForLog.length === 0) return null
    const out: Record<number, string> = {}
    for (const b of bandSortedForLog) {
      const ok = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
      const left = bandRemainingQty(b)
      const per = boardsPerStripByThickness.get(b.thicknessMm) ?? 1
      const maxStrips = per > 0 ? Math.ceil(left / per) : left
      if (!ok || left <= 0) continue
      const suggested = maxStrips
      out[b.thicknessMm] = String(suggested)
    }
    return Object.keys(out).length > 0 ? out : null
  }, [selectedLog, selectedTask, bandSortedForLog, boardsPerStripByThickness])

  useEffect(() => {
    if (!selectedLogId) {
      bandCutSeedKeyRef.current = null
      return
    }
    if (!selectedTaskId || !suggestedBandCutDraft) return
    const key = `${selectedTaskId}:${selectedLogId}`
    if (bandCutSeedKeyRef.current === key) return
    bandCutSeedKeyRef.current = key
    setBandCutDraft(suggestedBandCutDraft)
  }, [selectedLogId, selectedTaskId, suggestedBandCutDraft])

  useEffect(() => {
    if (!bandCalcOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBandCalcOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bandCalcOpen])

  const bandCalcBreakdown = useMemo(() => {
    if (!selectedLog || !selectedTask || !taskOrderLines?.length) return []
    return bandSortedForLog
      .filter((b) => bandRemainingQty(b) > 0)
      .map((b) => {
        const ok = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
        const left = bandRemainingQty(b)
        const per = boardsPerStripByThickness.get(b.thicknessMm) ?? 1
        const maxStrips = per > 0 ? Math.ceil(left / per) : left
        const faceBoardsRaw = b.boardsFromOneCrossSection ?? 0
        const suggested = ok ? maxStrips : 0
        const piecesIfSuggested = ok ? Math.min(left, suggested * per) : 0
        const lengthsForTh = orderPieceLengthsForThicknessMm(taskOrderLines, b.thicknessMm)
        return {
          thicknessMm: b.thicknessMm,
          ok,
          left,
          per,
          maxStrips,
          faceBoards: faceBoardsRaw,
          suggested,
          piecesIfSuggested,
          lengthsForTh,
        }
      })
  }, [
    selectedLog,
    selectedTask,
    taskOrderLines,
    bandSortedForLog,
    boardsPerStripByThickness,
  ])

  /** Скільки смуг кожної товщини ще потрібно за незакритим залишком. */
  const bandStripBudgetForSvg = useMemo(() => {
    if (!selectedTask?.plan.band.length) return null
    const m = new Map<number, number>()
    for (const b of bandSortedForLog) {
      const per = boardsPerStripByThickness.get(b.thicknessMm) ?? 1
      const boardsLeft = bandRemainingQty(b)
      const stripsNeeded = per > 0 ? Math.ceil(boardsLeft / per) : boardsLeft
      m.set(b.thicknessMm, Math.max(0, stripsNeeded))
    }
    return m
  }, [
    selectedTask?.plan.band.length,
    bandSortedForLog,
    boardsPerStripByThickness,
  ])

  const crossRows = useMemo(() => {
    if (!selectedLog || !stackThicknessesMm.length) return []
    const full = buildStackedBandCrossSection(
      selectedLog.radius,
      stackThicknessesMm,
      effectiveKerfMm,
      bandCrossFit,
    )
    if (!bandStripBudgetForSvg) return full
    const demand = buildStackedBandCrossSectionForDemand(
      selectedLog.radius,
      stackThicknessesMm,
      effectiveKerfMm,
      bandStripBudgetForSvg,
      bandCrossFit,
    )
    /** Якщо бюджет смуг 0 (норма закрита або чернетка «з’їла» залишок), demand не малює рядів — показуємо повну геометрію торця. */
    return demand.length > 0 ? demand : full
  }, [selectedLog, stackThicknessesMm, effectiveKerfMm, bandStripBudgetForSvg, bandCrossFit])

  const crossRowStripSurplus = useMemo(() => {
    if (!bandStripBudgetForSvg || crossRows.length === 0) return null
    return markSurplusStripsInCrossRows(crossRows, bandStripBudgetForSvg)
  }, [bandStripBudgetForSvg, crossRows])

  const stripWidthsByThicknessForCurrentMap = useMemo(() => {
    const m = new Map<number, number[]>()
    for (let i = 0; i < crossRows.length; i += 1) {
      const row = crossRows[i]!
      const flags = crossRowStripSurplus?.[i]
      for (let j = 0; j < row.boards; j += 1) {
        if (flags?.[j]) continue
        const w = Math.max(1, Math.round(row.boardWidth))
        const arr = m.get(row.thicknessMm)
        if (arr) arr.push(w)
        else m.set(row.thicknessMm, [w])
      }
    }
    return m
  }, [crossRows, crossRowStripSurplus])

  const crossDiagramHasSurplus = useMemo(() => {
    if (!crossRowStripSurplus) return false
    return crossRowStripSurplus.some((row) => row.some(Boolean))
  }, [crossRowStripSurplus])

  const resawRulerSteps = useMemo(() => {
    if (!selectedLog || !crossRows.length) return []
    return buildResawRulerSteps(crossRows, selectedLog.radius, resawFirstCutMm)
  }, [selectedLog, crossRows, resawFirstCutMm])

  /** Ряд із найдовшою хордою (середина кола — смуги найширші вздовж хорди). */
  const rowIdxMaxChord = useMemo(() => {
    if (!crossRows.length) return null
    let best = 0
    for (let i = 1; i < crossRows.length; i += 1) {
      if (crossRows[i].chord > crossRows[best].chord) best = i
    }
    return best
  }, [crossRows])

  const activeBandRow = useMemo(() => {
    if (!bandSortedForLog.length) return null
    return (
      bandSortedForLog.find((b) => b.thicknessMm === displayThicknessMm) ?? bandSortedForLog[0]
    )
  }, [bandSortedForLog, displayThicknessMm])

  /** Зона до полюса кола після останнього ряду — ще можлива нарізка меншою товщиною. */
  const southPoleCapPathD = useMemo(() => {
    if (!selectedLog || !crossRows.length) return null
    const last = crossRows[crossRows.length - 1]
    const gapMm = crossSectionSouthPoleGapAfterLastRow(
      selectedLog.radius,
      last.y,
      last.thicknessMm,
    )
    if (gapMm < 0.5) return null
    const logR = selectedLog.radius
    const ybMm = last.y + last.thicknessMm / 2
    const wMm = Math.sqrt(Math.max(logR * logR - ybMm * ybMm, 0))
    const scale = SVG_LOG_RADIUS / logR
    const cx = 120
    const cy = 120
    const ybSvg = cy + (ybMm / logR) * SVG_LOG_RADIUS
    const xL = cx - wMm * scale
    const xR = cx + wMm * scale
    return `M ${xL} ${ybSvg} L ${xR} ${ybSvg} A ${SVG_LOG_RADIUS} ${SVG_LOG_RADIUS} 0 1 1 ${xL} ${ybSvg} Z`
  }, [selectedLog, crossRows])

  const changeSelectedLog = (id: number) => {
    setSelectedLogId(id)
    const found = logs.find((item) => item.id === id)
    if (found) {
      setEditRadius(String(found.radius))
      setEditLength(String(found.length))
    }
  }

  const saveLogChanges = () => {
    if (!selectedLogId) return
    const r = Number(editRadius)
    const l = Number(editLength)
    if (!r || !l || r <= 0 || l <= 0) return
    void (async () => {
      try {
        const { stock } = await patchRoundwoodStockItem(selectedLogId, {
          radiusMm: r,
          lengthMm: l,
        })
        setLogs(stock)
      } catch (e) {
        setBandCutErr(true)
        setBandCutMsg(e instanceof Error ? e.message : 'Не вдалося оновити колоду')
      }
    })()
  }

  return (
    <>
      {user?.role === 'sawyer' && <AssignedTasksPanel />}
      <section className="panel">
        <div className="row bandTaskRow">
          <label className="bandTaskSelect">
            Завдання
            <select
              value={selectedTaskId ?? ''}
              onChange={(e) => setSelectedTaskId(e.target.value || null)}
              disabled={tasksLoading}
            >
              <option value="">Без завдання (товщина вручну)</option>
              {tasksForBand.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.status === 'in_progress' ? ' · у роботі' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        {tasksLoading && <p className="panelHint">Завантаження завдань…</p>}
        {tasksErr && <p className="birkaMsgErr">{tasksErr}</p>}
        {!tasksLoading && tasksForBand.length === 0 && !tasksErr && (
          <p className="panelHint">
            Немає завдань з призначенням «ленточна». Бригадир має зберегти завдання з галочкою
            розпиловщика.
          </p>
        )}

        {selectedTask && (
          <div className="bandTaskSummary panelHint">
            <strong>{selectedTask.title}</strong>
            {selectedTask.plan.alongLog && (
              <span className="bandTaskAlong">
                {' '}
                · нарізку по <strong>довжині</strong> дивіться на вкладці «Циркулярка» (оцінка мін.
                довжини: {fmtCm(selectedTask.plan.alongLog.minLogLengthMm)}).
              </span>
            )}
          </div>
        )}

        <div className="row">
          <label>
            Оберіть кругляк
            <select
              value={selectedLogId ?? ''}
              onChange={(e) => changeSelectedLog(Number(e.target.value))}
            >
              <option value="" disabled>
                Виберіть зі списку
              </option>
              {logsForSelect.map((item) => (
                <option key={item.id} value={item.id}>
                  R {fmtCm(item.radius)} / L {fmtCm(item.length)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Пропил ленточної (мм)
            <input
              value={selectedTask ? String(selectedTask.kerfBandMm) : kerf}
              onChange={(e) => setKerf(e.target.value)}
              type="number"
              min={0}
              disabled={!!selectedTask}
              title={selectedTask ? 'З завдання' : undefined}
            />
          </label>
          <button type="button" onClick={saveLogChanges} className="ghost">
            Оновити колоду
          </button>
        </div>

        {selectedLog && (
          <div className="row">
            <label>
              Радіус колоди (см)
              <input
                value={editRadius === '' ? '' : String((Number(editRadius) || 0) / 10)}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v === '') {
                    setEditRadius('')
                    return
                  }
                  const cm = Number(v.replace(',', '.'))
                  if (!Number.isFinite(cm) || cm <= 0) return
                  setEditRadius(String(Math.round(cm * 10)))
                }}
                type="number"
                min={0.1}
                step={0.1}
              />
            </label>
            <label>
              Довжина колоди (см)
              <input
                value={editLength === '' ? '' : String((Number(editLength) || 0) / 10)}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v === '') {
                    setEditLength('')
                    return
                  }
                  const cm = Number(v.replace(',', '.'))
                  if (!Number.isFinite(cm) || cm <= 0) return
                  setEditLength(String(Math.round(cm * 10)))
                }}
                type="number"
                min={0.1}
                step={0.1}
              />
            </label>
          </div>
        )}

        {selectedTask && bandSortedForLog.length > 0 && (
          <>
            <div className="bandTableToolbar">
              <p className="panelHint bandTableToolbarHint">
                Рядки таблиці — <strong>товщина смуги</strong> (ленточна). Колонка «З колоди по довжині» — скільки{' '}
                <strong>деталей кожної довжини</strong> з замовлення вміщається в{' '}
                <strong>одну обрану колоду</strong> по осі (нарізка циркуляркою; пропил{' '}
                {selectedTask.kerfCircMm} мм між заготовками). У тексті замовлення порядок чисел:{' '}
                <strong>
                  кількість · висота (товщина смуги) · ширина дошки · довжина
                </strong>
                .
              </p>
              <div className="bandTableToolbarActions">
                {selectedLog && (
                  <button
                    type="button"
                    className="ghost bandCalcOpenBtn"
                    onClick={() => setBandCalcOpen(true)}
                  >
                    Як пораховано
                  </button>
                )}
                {bandCompletedCount > 0 && (
                  <button
                    type="button"
                    className="ghost bandHideDoneBtn"
                    onClick={() => setHideCompletedBandRows((v) => !v)}
                    title={
                      hideCompletedBandRows
                        ? 'Знову показати рядки, по яких норма ленточної вже закрита'
                        : 'Приховати виконані позиції з таблиці'
                    }
                  >
                    {hideCompletedBandRows
                      ? `Показати виконані (${bandCompletedCount})`
                      : 'Сховати виконані'}
                  </button>
                )}
              </div>
            </div>
            <div className="bandAllThTableWrap">
              <table className="bandAllThTable">
                <thead>
                  <tr>
                    <th>Товщина</th>
                    <th>Знято</th>
                    <th>Залишилось</th>
                    <th className="bandAlongLogTh" title="Деталей кожної довжини з 1 колоди по осі (пропил циркулярки)">
                      З колоди по довжині
                    </th>
                    <th>Перерізів по довжині</th>
                    <th>Статус</th>
                    <th title="Скільки фізичних смуг (на всю довжину колоди) зняти за цей запис; до «Знято» додається деталей = смуги × коеф. з «З колоди по довжині». Підставляється з торця (дощок на зріз) у межах норми.">
                      Смуг на зріз
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bandTableRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="bandTableEmptyRow">
                        Усі позиції за цим завданням уже виконані за нормою ленточної — натисніть «Показати
                        виконані», щоб знову побачити рядки, або переходьте до закриття на станку 2.
                      </td>
                    </tr>
                  ) : null}
                  {bandTableRows.map((b) => {
                    const ok = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
                    const rDisp = selectedLog?.radius ?? selectedTask.radiusMm
                    const done = b.qtyDone ?? 0
                    const left = bandRemainingQty(b)
                    const rowCompleteActual = left === 0
                    const per = selectedLog
                      ? (boardsPerStripByThickness.get(b.thicknessMm) ?? 1)
                      : 1
                    const draftRaw = Number(bandCutDraft[b.thicknessMm])
                    const draftStrips =
                      Number.isFinite(draftRaw) && draftRaw > 0 ? Math.round(draftRaw) : 0
                    const draftBoards = selectedLog ? draftStrips * per : 0
                    const afterDraftLeft = Math.max(0, b.qtyNeeded - done - draftBoards)
                    const previewDone = Math.min(b.qtyNeeded, done + draftBoards)
                    const previewLeft = Math.max(0, left - draftBoards)
                    const effectiveLeft = draftStrips > 0 ? previewLeft : left
                    const maxStripsForRow =
                      selectedLog && per > 0 ? Math.ceil(left / per) : left
                    const crossPreview =
                      ok && (b.boardsFromOneCrossSection ?? 0) > 0
                        ? afterDraftLeft > 0
                          ? Math.ceil(afterDraftLeft / (b.boardsFromOneCrossSection ?? 1))
                          : 0
                        : null
                    const lengthsForTh =
                      taskOrderLines && taskOrderLines.length > 0
                        ? orderPieceLengthsForThicknessMm(taskOrderLines, b.thicknessMm)
                        : []
                    const alongLogParts =
                      selectedLog && lengthsForTh.length > 0
                        ? lengthsForTh.map((lenMm) => {
                            const n = workpiecesAlongOneLog(
                              selectedLog.length,
                              lenMm,
                              selectedTask.kerfCircMm,
                            )
                            return `${fmtCm(lenMm)} → ${n} шт`
                          })
                        : []
                    return (
                      <tr key={b.thicknessMm} className={rowCompleteActual ? 'bandRowComplete' : undefined}>
                        <td>
                          <strong>{fmtCm(b.thicknessMm)}</strong>
                          {rowCompleteActual ? (
                            <span className="bandRowCompleteBadge" title="Норма зібрана">
                              {' '}
                              ✓
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <strong>
                            {draftStrips > 0 ? previewDone : done} з {b.qtyNeeded}
                          </strong>
                          {draftStrips > 0 ? (
                            <span className="bandDraftPiecesHint">
                              {' '}
                              ({draftStrips} смуг × {per} дет.)
                            </span>
                          ) : null}
                        </td>
                        <td>{effectiveLeft}</td>
                        <td className="bandAlongLogCell">
                          {!selectedLog ? (
                            <span className="bandAlongLogMuted">оберіть колоду</span>
                          ) : alongLogParts.length > 0 ? (
                            alongLogParts.join('; ')
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{crossPreview == null ? '—' : crossPreview}</td>
                        <td>
                          {left === 0 ? (
                            <div className="bandDoneStatus">
                              <span className="bandStatusDone">Виконано</span>
                              <span className="bandDoneForCloseHint">
                                дошки готові — закрийте позицію на станку 2
                              </span>
                            </div>
                          ) : draftStrips > 0 && previewLeft === 0 ? (
                            <div className="bandDoneStatus">
                              <span className="bandStatusDone">Буде виконано</span>
                              <span className="bandDoneForCloseHint">
                                після натискання «Передати на станок 2»
                              </span>
                            </div>
                          ) : ok ? (
                            <span className="bandStatusOk">OK</span>
                          ) : (
                            <span className="bandStatusBad">
                              не вміщається при R={fmtCm(rDisp)} (макс. ~{' '}
                              {maxThHintMm != null ? fmtCm(maxThHintMm) : '—'})
                            </span>
                          )}
                        </td>
                        <td>
                          {ok && left > 0 ? (
                            <input
                              type="number"
                              min={1}
                              step={1}
                              max={Math.max(1, maxStripsForRow)}
                              className="bandCutQtyInput"
                              value={bandCutDraft[b.thicknessMm] ?? ''}
                              onChange={(e) =>
                                setBandCutDraft((prev) => ({
                                  ...prev,
                                  [b.thicknessMm]: e.target.value,
                                }))
                              }
                              placeholder="0"
                              title={
                                selectedLog
                                  ? `Смуг на зріз: з кожної смуги ~${per} дет. по довжині (колода ${fmtCm(selectedLog.length)}). На торці ${b.boardsFromOneCrossSection ?? 0} дощ. у шарі; залишилось ${left} дет., макс. ${maxStripsForRow} смуг.`
                                  : `Залишилось ${left} дет. Оберіть колоду для коефіцієнта.`
                              }
                            />
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {selectedLog && (
              <div className="bandCutPanel panelHint">
                {bandCutMsg && (
                  <p className={bandCutErr ? 'birkaMsgErr' : 'bandCutOk'}>{bandCutMsg}</p>
                )}
                <button
                  type="button"
                  className="bandCutSubmit"
                  disabled={bandCutBusy || !user}
                  onClick={async () => {
                    setBandCutMsg(null)
                    setBandCutErr(false)
                    if (!selectedTask || !selectedLog) {
                      setBandCutErr(true)
                      setBandCutMsg('Оберіть завдання та колоду.')
                      return
                    }
                    const cuts = bandSortedForLog
                      .filter(
                        (b) =>
                          bandRemainingQty(b) > 0 &&
                          b.feasible !== false &&
                          (b.boardsFromOneCrossSection ?? 0) > 0,
                      )
                      .map((b) => {
                        const raw = Number(bandCutDraft[b.thicknessMm])
                        if (!Number.isFinite(raw) || raw <= 0) return null
                        const remBoards = bandRemainingQty(b)
                        const perStrip = boardsPerStripByThickness.get(b.thicknessMm) ?? 1
                        const maxStrips =
                          perStrip > 0 ? Math.ceil(remBoards / perStrip) : remBoards
                        const stripQty = Math.min(maxStrips, Math.round(raw))
                        if (stripQty <= 0) return null
                        return { thicknessMm: b.thicknessMm, stripQty }
                      })
                      .filter((x): x is { thicknessMm: number; stripQty: number } => x != null)
                    if (cuts.length === 0) {
                      setBandCutErr(true)
                      setBandCutMsg('Додайте хоча б одну позицію з кількістю більше нуля.')
                      return
                    }
                    setBandCutBusy(true)
                    try {
                      const stripWidthsByThicknessMm: Record<string, number[]> = {}
                      for (const cut of cuts) {
                        const available =
                          stripWidthsByThicknessForCurrentMap.get(cut.thicknessMm) ?? []
                        const widths = available.slice(0, cut.stripQty)
                        if (widths.length < cut.stripQty) {
                          const fallbackW = Math.max(
                            1,
                            Math.round(
                              orderWidthByThickness.get(cut.thicknessMm)?.avg ?? cut.thicknessMm,
                            ),
                          )
                          while (widths.length < cut.stripQty) widths.push(fallbackW)
                        }
                        stripWidthsByThicknessMm[String(cut.thicknessMm)] = widths
                      }
                      const updated = await recordBandCut(selectedTask.id, {
                        cuts,
                        logLengthMm: selectedLog.length,
                        stripWidthsByThicknessMm,
                      })
                      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
                      setBandCutDraft({})
                      let roundwoodConsumeFailed = false
                      try {
                        await consumeRoundwoodLog({
                          logId: selectedLog.id,
                          taskId: selectedTask.id,
                          taskTitle: selectedTask.title,
                        })
                        const rw = await fetchRoundwoodState()
                        setLogs(rw.stock)
                      } catch (ce) {
                        roundwoodConsumeFailed = true
                        setBandCutErr(true)
                        setBandCutMsg(
                          `Записано на завданні, але колода не знята зі складу: ${
                            ce instanceof Error ? ce.message : 'помилка'
                          }. Спробуйте кнопку ще раз або зверніться до адміна.`,
                        )
                        try {
                          const rw = await fetchRoundwoodState()
                          setLogs(rw.stock)
                        } catch {
                          /* ignore */
                        }
                      }
                      setSelectedLogId(null)
                      if (!roundwoodConsumeFailed) {
                        const allDone = updated.plan.band.every(
                          (row) => (row.qtyDone ?? 0) >= row.qtyNeeded,
                        )
                        setBandCutMsg(
                          allDone
                            ? 'Записано. Усі позиції ленточної за завданням закриті — можна передати в роботу далі.'
                            : 'Записано. Смуги додані до завдання для станка 2.',
                        )
                      }
                    } catch (e) {
                      setBandCutErr(true)
                      setBandCutMsg(e instanceof Error ? e.message : 'Помилка')
                    } finally {
                      setBandCutBusy(false)
                    }
                  }}
                >
                  {bandCutBusy ? (
                    'Відправка…'
                  ) : (
                    <span className="bandCutBtnLines">
                      <span>Передати на станок 2</span>
                      <span className="bandCutBtnSub">(колода розпущена)</span>
                    </span>
                  )}
                </button>
              </div>
            )}
            <p className="panelHint">
              {(() => {
                const active = bandSortedForLog.filter((b) => bandRemainingQty(b) > 0)
                if (active.length === 0) {
                  return 'Усі товщини за цим завданням закриті за нормою (знято = потрібно).'
                }
                return (
                  <>
                    {bandCrossFit === 'min_waste' ? (
                      <>За режимом «мінімум відходів» рядки з </>
                    ) : (
                      <>За режимом «смуги в колі» рядки з </>
                    )}
                    <strong>незакритим залишком</strong> йдуть у порядку:{' '}
                    <strong>{active.map((b) => fmtCm(b.thicknessMm)).join(' → ')}</strong>.
                  </>
                )
              })()}
            </p>
          </>
        )}

        {(!selectedTaskId || !selectedTask?.plan.band.length) && (
          <div className="row">
            <label>
              Товщина смуги для торця (см)
              <input
                value={boardThickness === '' ? '' : String((Number(boardThickness) || 0) / 10)}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v === '') {
                    setBoardThickness('')
                    return
                  }
                  const cm = Number(v.replace(',', '.'))
                  if (!Number.isFinite(cm) || cm <= 0) return
                  setBoardThickness(String(Math.round(cm * 10)))
                }}
                type="number"
                min={0.1}
                step={0.1}
              />
            </label>
          </div>
        )}

        {selectedLog && (
          <>
            <div className="row bandCrossFitRow">
              <span className="bandCrossFitLegend">Розрахунок торця</span>
              <label className="bandCrossFitOption">
                <input
                  type="radio"
                  name="bandCrossFit"
                  checked={bandCrossFit === 'min_waste'}
                  onChange={() => setBandCrossFit('min_waste')}
                />
                Мінімум відходів (ширше смуги, можливі «обрізані» кути в колі)
              </label>
              <label className="bandCrossFitOption">
                <input
                  type="radio"
                  name="bandCrossFit"
                  checked={bandCrossFit === 'max_inscribed'}
                  onChange={() => setBandCrossFit('max_inscribed')}
                />
                Смуги в колі (вузьша хорда — прямокутник уписаний у коло)
              </label>
            </div>
            {activeBandRow &&
              (activeBandRow.feasible === false || (activeBandRow.boardsFromOneCrossSection ?? 0) <= 0) && (
                <p className="birkaMsgErr">
                  Для цієї товщини при R={fmtCm(selectedLog.radius)} не виходить жодної смуги в торці —
                  оберіть іншу товщину кнопками вище або колоду з більшим радіусом (макс. товщ. ~{' '}
                  {maxThHintMm != null ? fmtCm(maxThHintMm) : '—'}).
                </p>
              )}
            {selectedTask && crossDiagramHasSurplus && (
              <p className="panelHint crossSvgSurplusHint">
                Темніші прямокутники — смуги за <strong>нормою завдання</strong> (залишок до
                «потрібно»). Світліші з пунктиром — комірки в цьому торці понад норму (типовий
                надлишок одного перерізу по довжині).
              </p>
            )}
            <div className="bandCrossAndRuler">
            <div className="crossWrap">
              <svg viewBox="0 0 240 240" className="crossSvg">
                <defs>
                  <clipPath id="bandCrossClip">
                    <circle cx="120" cy="120" r={SVG_LOG_RADIUS} />
                  </clipPath>
                </defs>
                <circle cx="120" cy="120" r={SVG_LOG_RADIUS} className="crossCircle" />
                <g clipPath="url(#bandCrossClip)">
                  {crossRows.map((row, idx) => {
                    const logR = selectedLog.radius
                    const scale = SVG_LOG_RADIUS / logR
                    const scaledY = (row.y / logR) * SVG_LOG_RADIUS
                    const halfChord = (row.chord / (2 * logR)) * SVG_LOG_RADIUS
                    const rowT = row.thicknessMm
                    const halfBoard = ((rowT || 1) / (2 * logR)) * SVG_LOG_RADIUS
                    const yTop = 120 + scaledY - halfBoard
                    const hRow = halfBoard * 2
                    const boardWSvg = row.boardWidth * scale
                    const kerfWSvg = effectiveKerfMm * scale
                    const leftStart = 120 - halfChord
                    const isWidestRow = rowIdxMaxChord != null && idx === rowIdxMaxChord
                    const rowOrderWidth = orderWidthByThickness.get(rowT)

                    const pieces: ReactNode[] = []
                    let x = leftStart
                    const surplusFlags = crossRowStripSurplus?.[idx]
                    for (let j = 0; j < row.boards; j += 1) {
                      const isSurplus = surplusFlags?.[j] ?? false
                      pieces.push(
                        <rect
                          key={`b-${idx}-${j}`}
                          x={x}
                          y={yTop}
                          width={boardWSvg}
                          height={hRow}
                          className={
                            isSurplus
                              ? 'crossBoardPiece crossBoardPieceSurplus'
                              : 'crossBoardPiece'
                          }
                        >
                          <title>
                            {isSurplus
                              ? 'Надлишок у торці: за нормою цю смугу не зараховуємо'
                              : 'Смуга в межах залишку за завданням'}
                          </title>
                        </rect>,
                      )
                      x += boardWSvg
                      if (j < row.boards - 1) {
                        pieces.push(
                          <rect
                            key={`k-${idx}-${j}`}
                            x={x}
                            y={yTop}
                            width={kerfWSvg}
                            height={hRow}
                            className="crossKerfSlice"
                          />,
                        )
                        x += kerfWSvg
                      }
                    }

                    return (
                      <g key={`row-${idx}`}>
                        {pieces}
                        {rowOrderWidth &&
                          isWidestRow &&
                          rowOrderWidth.avg > 0 &&
                          rowOrderWidth.avg <= row.chord && (
                            <line
                              x1={120 - (rowOrderWidth.avg * scale) / 2}
                              x2={120 + (rowOrderWidth.avg * scale) / 2}
                              y1={120 + scaledY}
                              y2={120 + scaledY}
                              className="crossOrderWidthGuide"
                            />
                          )}
                        <text x={120} y={120 + scaledY + 2} className="crossText">
                          {`товщ. ${rowT} мм`}
                        </text>
                      </g>
                    )
                  })}
                  {southPoleCapPathD && <path d={southPoleCapPathD} className="crossPoleRemainder" />}
                </g>
              </svg>
            </div>
            <aside className="bandResawRuler">
              <h4 className="bandResawRulerTitle">Лінійка розпилу (торець)</h4>
              <p className="panelHint bandResawRulerHint">
                Шкала <strong>від низу</strong> торця: останній різ — <strong>0,0 мм</strong>, зовнішній
                (1-й) — найбільше; показання на спад, округлення до <strong>0,1 мм</strong>. Колонка «−
                лінійки» — на скільки зменшити від попереднього різу.
              </p>
              <label className="bandResawRulerField">
                Показання 1-го (зовнішнього) різу (мм)
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  placeholder="лише геометрія"
                  value={resawFirstCutMm}
                  onChange={(e) => setResawFirstCutMm(e.target.value)}
                  title="Фактичне показання на зовнішньому різі, мм (0,1); решта з тим же округленням, останній ряд = 0,0"
                />
              </label>
              {resawRulerSteps.length > 0 ? (
                <div className="bandResawRulerTableWrap">
                  <table className="bandResawRulerTable">
                    <thead>
                      <tr>
                        <th>Різ</th>
                        <th>Товщ.</th>
                        <th>Від низу, мм</th>
                        <th>− лінійки, мм</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resawRulerSteps.map((s) => (
                        <tr key={s.cutIndex}>
                          <td>{s.cutIndex}</td>
                          <td>{fmtCm(s.thicknessMm)}</td>
                          <td>{fmtMmOneDecimal(s.heightFromBottomMm)}</td>
                          <td>
                            {s.decreaseScaleByMm == null ? '—' : fmtMmOneDecimal(s.decreaseScaleByMm)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="panelHint">Оберіть колоду та товщини — з’являться кроки лінійки.</p>
              )}
            </aside>
            </div>
          </>
        )}
      </section>

      {bandCalcOpen && selectedTask && selectedLog && (
        <div
          className="bandCalcModalBackdrop"
          role="presentation"
          onClick={() => setBandCalcOpen(false)}
        >
          <div
            className="bandCalcModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bandCalcTitle"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bandCalcModalHeader">
              <h3 id="bandCalcTitle">Розрахунок смуг і деталей</h3>
              <button type="button" className="ghost" onClick={() => setBandCalcOpen(false)}>
                Закрити
              </button>
            </div>
            <p className="panelHint bandCalcIntro">
              Одна <strong>фізична смуга</strong> — зріз уздовж усієї колоди заданої товщини. З неї
              циркуляркою по довжині виходить стільки деталей, скільки в колонці «З колоди по
              довжині» (для домінантної довжини з замовлення). На <strong>торці</strong> у схемі
              видно, скільки <strong>дощок у одному шарі</strong> — це «з торця» для цієї товщини.
              У полі «Смуг на зріз» підставляється{' '}
              <strong>min(макс. смуг за нормою, дощок на торці)</strong> — щоб одним вводом
              орієнтуватись на картку розкрою, не перевищуючи залишок.
            </p>
            <p className="panelHint bandCalcExample">
              Приклад: якщо на торці <strong>4</strong> дошки в шарі, а з однієї смуги по довжині
              виходить по <strong>4</strong> деталі, то <strong>4</strong> смуги дають до{' '}
              <strong>4 × 4 = 16</strong> деталей (фактично не більше залишку в завданні — зайве не
              зараховується).
            </p>
            <div className="bandCalcModalTableWrap">
              <table className="bandCalcModalTable">
                <thead>
                  <tr>
                    <th>Товщина</th>
                    <th>Залишок дет.</th>
                    <th>Дощок на торці (шар)</th>
                    <th>Дет. з 1 смуги</th>
                    <th>Макс. смуг</th>
                    <th>Підставка</th>
                    <th>≈ дет. від підставки</th>
                  </tr>
                </thead>
                <tbody>
                  {bandCalcBreakdown.length === 0 ? (
                    <tr>
                      <td colSpan={7}>
                        Немає рядків з залишком або оберіть колоду для коефіцієнтів.
                      </td>
                    </tr>
                  ) : (
                    bandCalcBreakdown.map((row) => (
                      <tr key={row.thicknessMm}>
                        <td>{fmtCm(row.thicknessMm)}</td>
                        <td>{row.left}</td>
                        <td>{row.faceBoards > 0 ? row.faceBoards : '—'}</td>
                        <td>{row.per}</td>
                        <td>{row.ok ? row.maxStrips : '—'}</td>
                        <td>{row.ok ? row.suggested : '—'}</td>
                        <td>{row.ok ? row.piecesIfSuggested : '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {bandCalcBreakdown.some((r) => r.lengthsForTh.length > 0) && (
              <p className="panelHint bandCalcFootnote">
                Довжини з замовлення для товщин:{' '}
                {bandCalcBreakdown
                  .filter((r) => r.lengthsForTh.length > 0)
                  .map((r, idx) => (
                    <span key={r.thicknessMm} className="bandCalcLenSpan">
                      {idx > 0 ? '; ' : ''}
                      <strong>{fmtCm(r.thicknessMm)}</strong>:{' '}
                      {r.lengthsForTh.map((len) => fmtCm(len)).join(', ')}
                    </span>
                  ))}
                . Кількість заготовок по кожній довжині з однієї колоди — у колонці таблиці «З колоди
                по довжині».
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
