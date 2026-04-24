import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { fetchTasks, patchStripSawRemainder, recordStripSawCut } from '../api'
import { AssignedTasksPanel } from '../components/AssignedTasksPanel'
import { useAuth } from '../context/AuthContext'
import {
  computeBoardsAcrossWidth,
  greedyMixedCutsAcrossWidth,
  layoutStripCutsAcrossWidth,
  minimalStripWidthForMixedDemand,
  mixedCutsResultFromKnifePlan,
  planMixedCutsMinKnifeSetups,
  type MixedKnifePlan,
  type StripCutSegment,
} from '../helpers/circularWaste'
import {
  BAND_CROSS_FIT_STORAGE_KEY,
  maxStripChordMmForBandThickness,
  type BandCrossFitMode,
} from '../helpers/crossSection'
import { workpiecesAlongOneLog } from '../helpers/alongLogPieces'
import {
  boardWidthAcrossStripForThickness,
  dominantBoardWidthMmForThickness,
  dominantPieceLengthMmForThickness,
  parseForemanOrderText,
} from '../helpers/parseForemanOrders'
import { undressedStripWidthMmForTask } from '../helpers/stripStockRows'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { WorkTask } from '../types/task'
import './StripSawPage.css'

/** Найтиповіша довжина колоди (мм) серед записів складу для цієї висоти смуги. */
function dominantLogLengthFromStripInventory(
  inv: { thicknessMm: number; qty: number; logLengthMm: number }[],
  th: number,
): number | null {
  const m = new Map<number, number>()
  for (const e of inv) {
    if (Math.round(e.thicknessMm) !== th) continue
    const L = Math.round(Number(e.logLengthMm))
    if (L <= 0) continue
    m.set(L, (m.get(L) ?? 0) + Math.round(e.qty))
  }
  let bestL: number | null = null
  let bestQ = -1
  for (const [L, q] of m) {
    if (q > bestQ || (q === bestQ && bestL != null && L > bestL)) {
      bestQ = q
      bestL = L
    }
  }
  return bestL
}

function fmtCmFromMm(mm: number): string {
  const cm = mm / 10
  const r = Math.round(cm * 10) / 10
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1).replace(/\.0$/, '')
  return `${s} см`
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

function MixedStripDiagram({
  stripMm,
  segments,
  kerfMm,
}: {
  stripMm: number
  segments: StripCutSegment[]
  kerfMm: number
}): ReactNode {
  const vbW = Math.max(stripMm, 80)
  const h = 44
  let x = 0
  const pieces: ReactNode[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i]!
    const w = s.mm
    const cls =
      s.kind === 'board' ? 'stripSegBoard' : s.kind === 'kerf' ? 'stripSegKerf' : 'stripSegWaste'
    pieces.push(<rect key={i} x={x} y={4} width={w} height={h - 8} className={cls} />)
    if (s.kind === 'board' && w > 10) {
      pieces.push(
        <text key={`t-${i}`} x={x + w / 2} y={h / 2 + 4} className="stripSegLabel">
          {Math.round(s.mm)}
        </text>,
      )
    }
    x += w
  }
  return (
    <div className="stripCutDiagramWrap">
      <svg
        className="stripCutSvg"
        viewBox={`0 0 ${vbW} ${h}`}
        preserveAspectRatio="xMinYMid meet"
      >
        <rect x={0} y={4} width={vbW} height={h - 8} className="stripSegTrack" />
        {pieces}
      </svg>
      <p className="panelHint stripCutLegend">
        <span className="stripLeg stripLegBoard">дошка</span>
        <span className="stripLeg stripLegKerf">пропил</span>
        <span className="stripLeg stripLegWaste">залишок</span>
        · смуга <strong>{stripMm.toFixed(0)} мм</strong> по ширині, пропил <strong>{kerfMm} мм</strong>.
        Схема для <strong>обраної висоти</strong> (крок 1), змішані ширини брусів при цій висоті
        (ширші першими, у межах «потрібно» з таблиці).
      </p>
    </div>
  )
}

function SingleWidthStripDiagram({
  stripMm,
  boardMm,
  kerfMm,
}: {
  stripMm: number
  boardMm: number
  kerfMm: number
}): ReactNode {
  const { segments } = layoutStripCutsAcrossWidth(stripMm, boardMm, kerfMm)
  return <MixedStripDiagram stripMm={stripMm} segments={segments} kerfMm={kerfMm} />
}

/** Етап 2: смуга з стрічкової пили має висоту з замовлення; тут нарізка по ширині смуги (поперек). */
export function StripSawPage() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [tasksErr, setTasksErr] = useState<string | null>(null)
  const [stripTaskId, setStripTaskId] = useState('')
  const [stripWidth, setStripWidth] = useState('200')
  const [boardThickness, setBoardThickness] = useState('48')
  const [kerf, setKerf] = useState('3')

  /** plan = хорда з плану стрічкової пили (R завдання); manual = своє поле */
  const [stripWidthMode, setStripWidthMode] = useState<'plan' | 'manual'>('plan')
  const [measuredStripMm, setMeasuredStripMm] = useState('')
  const [stripThicknessMm, setStripThicknessMm] = useState('')
  const [diagramBoardWidthMm, setDiagramBoardWidthMm] = useState('')
  /** Усі ширини в таблиці або лише обрана (з можливістю «Показати всі»). */
  const [stripBoardFocus, setStripBoardFocus] = useState<number | 'mixed'>('mixed')
  const [demandTableShowAll, setDemandTableShowAll] = useState(false)

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

  useWorkTasksReload(reloadTasks)

  const tasksForStrip = useMemo(
    () => tasks.filter((t) => t.assignTo.includes('circular_operator')),
    [tasks],
  )

  const selectedStripTask = useMemo(
    () => tasksForStrip.find((t) => t.id === stripTaskId) ?? null,
    [tasksForStrip, stripTaskId],
  )

  const stripSawStockRows = useMemo(() => {
    if (!selectedStripTask) return []
    const inv = selectedStripTask.stripInventory ?? []
    const orderParsed = parseForemanOrderText(
      selectedStripTask.orderText,
      selectedStripTask.unit === 'cm' ? 'cm' : 'mm',
    )
    const lines = orderParsed.ok ? orderParsed.lines : null
    const kerfCirc = Number(selectedStripTask.kerfCircMm) || 0

    const mInv = new Map<number, number>()
    for (const e of inv) {
      const th = Math.round(e.thicknessMm)
      mInv.set(th, (mInv.get(th) ?? 0) + Math.round(e.qty))
    }
    const cuts = selectedStripTask.stripSaw?.cuts ?? []
    const mCut = new Map<number, number>()
    for (const c of cuts) {
      const th = Math.round(c.thicknessMm)
      mCut.set(th, (mCut.get(th) ?? 0) + Math.round(c.stripQty))
    }
    const ov = selectedStripTask.stripSaw?.remainderOverrideByThicknessMm ?? {}
    const keys = new Set<number>([
      ...mInv.keys(),
      ...mCut.keys(),
      ...Object.keys(ov).map((k) => Math.round(Number(k))),
    ])
    return [...keys]
      .sort((a, b) => b - a)
      .map((th) => {
        const incoming = mInv.get(th) ?? 0
        const cutSum = mCut.get(th) ?? 0
        const k = String(th)
        const rawOv = ov[k]
        const hasOverride = rawOv !== undefined && rawOv !== null
        const remainder = hasOverride
          ? Math.max(0, Math.round(Number(rawOv)))
          : Math.max(0, incoming - cutSum)
        const widthMm = lines ? dominantBoardWidthMmForThickness(lines, th) : null
        const undressedStripMm = undressedStripWidthMmForTask(selectedStripTask, th)
        const pieceLenMm = lines ? dominantPieceLengthMmForThickness(lines, th) : null
        const logLenMm = dominantLogLengthFromStripInventory(inv, th)
        const piecesAlongLog =
          logLenMm != null &&
          logLenMm > 0 &&
          pieceLenMm != null &&
          pieceLenMm > 0
            ? Math.max(1, workpiecesAlongOneLog(logLenMm, pieceLenMm, kerfCirc))
            : null
        return {
          th,
          incoming,
          cutSum,
          remainder,
          hasOverride,
          widthMm,
          undressedStripMm,
          pieceLenMm,
          logLenMm,
          piecesAlongLog,
        }
      })
  }, [selectedStripTask])

  const [stripSawErr, setStripSawErr] = useState<string | null>(null)
  const [stripSawBusy, setStripSawBusy] = useState(false)
  /** Підтвердження після успішного запису (розпил / залишок), щоб було видно, що клік спрацював. */
  const [stripActionOk, setStripActionOk] = useState<string | null>(null)
  const [stripSawQtyDraft, setStripSawQtyDraft] = useState<Record<string, string>>({})
  const [stripRemainderDraft, setStripRemainderDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    setStripSawErr(null)
    setStripActionOk(null)
    setStripSawQtyDraft({})
    setStripRemainderDraft({})
  }, [selectedStripTask?.id])

  useEffect(() => {
    if (!stripActionOk) return
    const t = window.setTimeout(() => setStripActionOk(null), 8000)
    return () => window.clearTimeout(t)
  }, [stripActionOk])

  useEffect(() => {
    if (stripSawErr) setStripActionOk(null)
  }, [stripSawErr])

  const canRecordStripSaw =
    !!user && ['circular_operator', 'foreman', 'admin'].includes(user.role)

  const parsedOrder = useMemo(() => {
    if (!selectedStripTask) return null
    const p = parseForemanOrderText(
      selectedStripTask.orderText,
      selectedStripTask.unit === 'cm' ? 'cm' : 'mm',
    )
    return p.ok ? p.lines : null
  }, [selectedStripTask])

  const thicknessOptionsMm = useMemo(() => {
    if (!parsedOrder?.length) return []
    const s = new Set<number>()
    for (const l of parsedOrder) {
      s.add(Math.round(l.aMm))
      s.add(Math.round(l.bMm))
    }
    return [...s].sort((a, b) => b - a)
  }, [parsedOrder])

  /** Лише висоти, для яких є смуги в залишку (нічого не показуємо «порожні»). */
  const thicknessOptionsWithStripsMm = useMemo(() => {
    if (!thicknessOptionsMm.length) return []
    return thicknessOptionsMm.filter((t) => {
      const r = stripSawStockRows.find((x) => x.th === t)
      return r != null && r.remainder > 0
    })
  }, [thicknessOptionsMm, stripSawStockRows])

  useEffect(() => {
    if (!selectedStripTask) {
      setStripThicknessMm('')
      return
    }
    if (thicknessOptionsWithStripsMm.length === 0) {
      setStripThicknessMm('')
      return
    }
    setStripThicknessMm((prev) => {
      const p = Number(prev) || 0
      if (p && thicknessOptionsWithStripsMm.includes(p)) return prev
      return String(thicknessOptionsWithStripsMm[0])
    })
  }, [selectedStripTask?.id, thicknessOptionsWithStripsMm])

  const thSel = Number(stripThicknessMm) || 0

  const bandCrossFit = readStoredBandCrossFit()

  /**
   * Ширина смуги для схеми: як у колонці «смуга до різу» — спочатку план циркулярки (avgChord),
   * інакше геометрія R×товщина. Лише maxStripChord давав 0 при «неможливому» R, хоча фактичні
   * смуги вже є в завданні (з стрічкової пили).
   */
  const plannedChordMm = useMemo(() => {
    if (!selectedStripTask || !thSel) return 0
    const fromTaskPlan = undressedStripWidthMmForTask(selectedStripTask, thSel)
    if (fromTaskPlan != null && fromTaskPlan > 0) return fromTaskPlan
    const fit = readStoredBandCrossFit()
    return maxStripChordMmForBandThickness(
      selectedStripTask.radiusMm,
      thSel,
      selectedStripTask.kerfBandMm,
      fit,
    )
  }, [selectedStripTask, thSel])


  const demandAtThickness = useMemo(() => {
    if (!parsedOrder || !thSel) return []
    const byW = new Map<number, number>()
    for (const l of parsedOrder) {
      const w = boardWidthAcrossStripForThickness(l, thSel)
      if (w == null) continue
      byW.set(w, (byW.get(w) ?? 0) + l.qty)
    }
    return [...byW.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([boardWidthMm, qtyNeeded]) => ({ boardWidthMm, qtyNeeded }))
  }, [parsedOrder, thSel])

  /** Рядки з нормою > 0 — лише для них рахуємо змішаний поріз у таблиці та запис розпилу. */
  const stripMixedForQty = useMemo(
    () => demandAtThickness.filter((d) => d.qtyNeeded > 0),
    [demandAtThickness],
  )

  /**
   * Цілі для кресленика: при нульовій потребі по всіх ширинах жадібний поріз не ставить жодної дошки
   * (усі maxCount = 0) — тоді показуємо умовний ряд «по 1 шт. кожної ширини з замовлення».
   */
  const stripMixedDiagramTargets = useMemo(() => {
    if (!demandAtThickness.length) return []
    if (stripMixedForQty.length > 0) {
      return stripMixedForQty.map((d) => ({
        boardWidthMm: d.boardWidthMm,
        maxCount: d.qtyNeeded,
      }))
    }
    return demandAtThickness.map((d) => ({
      boardWidthMm: d.boardWidthMm,
      maxCount: 1,
    }))
  }, [demandAtThickness, stripMixedForQty])

  const mixedCutsIsIllustrationOnly =
    stripMixedForQty.length === 0 && stripMixedDiagramTargets.length > 0

  useEffect(() => {
    if (demandAtThickness[0]) {
      setDiagramBoardWidthMm(String(demandAtThickness[0].boardWidthMm))
    } else {
      setDiagramBoardWidthMm('')
    }
  }, [demandAtThickness])

  useEffect(() => {
    if (
      stripBoardFocus !== 'mixed' &&
      !demandAtThickness.some((d) => d.boardWidthMm === stripBoardFocus)
    ) {
      setStripBoardFocus('mixed')
    }
  }, [demandAtThickness, stripBoardFocus])

  useEffect(() => {
    setDemandTableShowAll(false)
  }, [selectedStripTask?.id, stripThicknessMm])

  useEffect(() => {
    if (selectedStripTask) {
      setKerf(String(selectedStripTask.kerfCircMm))
    }
  }, [selectedStripTask?.id, selectedStripTask?.kerfCircMm])

  const kerfEffMm = selectedStripTask ? selectedStripTask.kerfCircMm : Number(kerf) || 0
  const manualW = Number(String(measuredStripMm).replace(',', '.')) || 0

  /** Якщо хорда з плану колоди = 0 — орієнтир тільки з ширин брусів + пропилів (схема для робітника). */
  const orderBasedStripEstimateMm = useMemo(() => {
    if (!stripMixedForQty.length) return 0
    return minimalStripWidthForMixedDemand(
      stripMixedForQty.map((d) => ({
        boardWidthMm: d.boardWidthMm,
        maxCount: d.qtyNeeded,
      })),
      kerfEffMm,
    )
  }, [stripMixedForQty, kerfEffMm])

  const stripWidthUsesOrderEstimate =
    stripWidthMode === 'plan' && plannedChordMm <= 0 && orderBasedStripEstimateMm > 0

  const effectiveStripMm =
    stripWidthMode === 'manual'
      ? manualW
      : plannedChordMm > 0
        ? plannedChordMm
        : orderBasedStripEstimateMm

  /** Для підпису режиму «За планом»: хорда або орієнтир з замовлення. */
  const planSchemeStripMm =
    plannedChordMm > 0 ? plannedChordMm : orderBasedStripEstimateMm

  const knifePlanMixedQty = useMemo((): MixedKnifePlan | null => {
    if (!stripMixedForQty.length || effectiveStripMm <= 0) return null
    return planMixedCutsMinKnifeSetups(
      effectiveStripMm,
      stripMixedForQty.map((d) => ({
        boardWidthMm: d.boardWidthMm,
        maxCount: d.qtyNeeded,
      })),
      kerfEffMm,
    )
  }, [stripMixedForQty, effectiveStripMm, kerfEffMm])

  const knifePlanDiagram = useMemo((): MixedKnifePlan | null => {
    if (!stripMixedDiagramTargets.length || effectiveStripMm <= 0) return null
    return planMixedCutsMinKnifeSetups(
      effectiveStripMm,
      stripMixedDiagramTargets,
      kerfEffMm,
    )
  }, [stripMixedDiagramTargets, effectiveStripMm, kerfEffMm])

  /** План для підказки оператору: спочатку реальна потреба, інакше ілюстрація. */
  const knifePlanForUi = knifePlanMixedQty ?? knifePlanDiagram

  const mixedCuts = useMemo(() => {
    if (!stripMixedForQty.length || effectiveStripMm <= 0) return null
    if (knifePlanMixedQty) return mixedCutsResultFromKnifePlan(knifePlanMixedQty)
    return greedyMixedCutsAcrossWidth(
      effectiveStripMm,
      stripMixedForQty.map((d) => ({
        boardWidthMm: d.boardWidthMm,
        maxCount: d.qtyNeeded,
      })),
      kerfEffMm,
    )
  }, [stripMixedForQty, effectiveStripMm, kerfEffMm, knifePlanMixedQty])

  const mixedCutsDiagram = useMemo(() => {
    if (!stripMixedDiagramTargets.length || effectiveStripMm <= 0) return null
    if (knifePlanDiagram) return mixedCutsResultFromKnifePlan(knifePlanDiagram)
    return greedyMixedCutsAcrossWidth(
      effectiveStripMm,
      stripMixedDiagramTargets,
      kerfEffMm,
    )
  }, [stripMixedDiagramTargets, effectiveStripMm, kerfEffMm, knifePlanDiagram])

  const demandWithCuts = useMemo(() => {
    if (!demandAtThickness.length || effectiveStripMm <= 0) return []
    return demandAtThickness.map((d) => {
      const cut = computeBoardsAcrossWidth(effectiveStripMm, d.boardWidthMm, kerfEffMm)
      const coversSingle = Math.min(cut.boards, d.qtyNeeded)
      const mixedGot = mixedCuts?.countsByWidth.get(d.boardWidthMm) ?? 0
      const coversMixed = Math.min(mixedGot, d.qtyNeeded)
      return {
        ...d,
        fitsSingleWidth: cut.boards,
        coversSingleStrip: coversSingle,
        fitsMixed: mixedGot,
        coversMixedStrip: coversMixed,
        wasteIfSingleMm: cut.wasteMm,
      }
    })
  }, [demandAtThickness, effectiveStripMm, kerfEffMm, mixedCuts])

  const mixedCutsDiagramHasBoard =
    mixedCutsDiagram?.segments.some((s) => s.kind === 'board') ?? false

  /** Скільки брусів (дощок) з однієї смуги: змішаний поріз або лише обрана ширина. */
  const boardsPerStripForRozil = useMemo(() => {
    if (!Number.isFinite(effectiveStripMm) || effectiveStripMm <= 0) return 0
    if (stripBoardFocus === 'mixed') {
      if (!mixedCuts?.segments.length) return 0
      let n = 0
      for (const s of mixedCuts.segments) {
        if (s.kind === 'board') n += 1
      }
      return n
    }
    return computeBoardsAcrossWidth(effectiveStripMm, stripBoardFocus, kerfEffMm).boards
  }, [effectiveStripMm, stripBoardFocus, mixedCuts, kerfEffMm])

  const circularRowForTh = useMemo(() => {
    if (!selectedStripTask?.plan?.circular?.length || !thSel) return null
    return (
      selectedStripTask.plan.circular.find((c) => Math.round(c.thicknessMm) === thSel) ?? null
    )
  }, [selectedStripTask, thSel])

  const brusNeedRemaining =
    circularRowForTh != null
      ? Math.max(
          0,
          (circularRowForTh.qtyNeeded ?? 0) - (circularRowForTh.qtyDone ?? 0),
        )
      : null

  /** Для обраної висоти норма за замовленням уже закрита — розпил не пропонуємо. */
  const stripSawOrderDoneForSelected =
    thSel > 0 &&
    circularRowForTh != null &&
    (circularRowForTh.qtyNeeded ?? 0) > 0 &&
    brusNeedRemaining === 0

  const activeStockRow = useMemo(
    () => stripSawStockRows.find((r) => r.th === thSel) ?? null,
    [stripSawStockRows, thSel],
  )

  const demandRowsForTable = useMemo(() => {
    if (demandTableShowAll || stripBoardFocus === 'mixed') return demandWithCuts
    return demandWithCuts.filter((r) => r.boardWidthMm === stripBoardFocus)
  }, [demandWithCuts, stripBoardFocus, demandTableShowAll])

  const runStripSawForRow = useCallback(
    async (row: { th: number; remainder: number }) => {
      if (!selectedStripTask) return
      const k = String(row.th)
      const useBoardsDefaultLocal = thSel === row.th && boardsPerStripForRozil > 0
      const defaultQtyStrLocal = useBoardsDefaultLocal ? String(boardsPerStripForRozil) : '1'
      const qtyStrLocal = stripSawQtyDraft[k] ?? defaultQtyStrLocal
      const raw = Math.round(Number(String(qtyStrLocal).replace(',', '.')))
      if (!Number.isFinite(raw) || raw <= 0) {
        setStripSawErr('Вкажіть кількість (ціле число > 0)')
        return
      }
      const bpp = thSel === row.th && boardsPerStripForRozil > 0 ? boardsPerStripForRozil : 0
      const stripQty = bpp > 0 ? Math.max(1, Math.ceil(raw / bpp)) : Math.max(1, raw)
      if (stripQty > row.remainder) {
        setStripSawErr(`Потрібно ${stripQty} смуг, у залишку лише ${row.remainder}`)
        return
      }
      let boardsByWidthMm: Record<string, number> | undefined
      if (stripBoardFocus !== 'mixed' && typeof stripBoardFocus === 'number') {
        boardsByWidthMm = { [String(stripBoardFocus)]: raw }
      } else if (bpp > 0 && mixedCuts) {
        const o: Record<string, number> = {}
        for (const [w, c] of mixedCuts.countsByWidth) {
          const n = c * stripQty
          if (n > 0) o[String(w)] = n
        }
        if (Object.keys(o).length) boardsByWidthMm = o
      }
      setStripSawBusy(true)
      setStripSawErr(null)
      setStripActionOk(null)
      try {
        const updated = await recordStripSawCut(selectedStripTask.id, {
          thicknessMm: row.th,
          stripQty,
          boardsTotal: raw,
          ...(boardsByWidthMm ? { boardsByWidthMm } : {}),
        })
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
        setStripSawQtyDraft((p) => {
          const n = { ...p }
          delete n[k]
          return n
        })
        const wPart =
          boardsByWidthMm && Object.keys(boardsByWidthMm).length > 0
            ? ` Ширини: ${Object.entries(boardsByWidthMm)
                .map(([w, q]) => `${w} мм × ${q}`)
                .join(', ')}.`
            : ''
        setStripActionOk(
          `Записано: знято ${stripQty} смуг, у завдання додано ${raw} брусів (товщина ${row.th} мм).${wPart}`,
        )
      } catch (e) {
        setStripSawErr(e instanceof Error ? e.message : 'Помилка запису')
      } finally {
        setStripSawBusy(false)
      }
    },
    [selectedStripTask, thSel, boardsPerStripForRozil, stripSawQtyDraft, mixedCuts, stripBoardFocus],
  )

  const cutManual = useMemo(() => {
    return computeBoardsAcrossWidth(
      Number(stripWidth) || 0,
      Number(boardThickness) || 0,
      Number(kerf) || 0,
    )
  }, [stripWidth, boardThickness, kerf])

  const diagramW = Number(diagramBoardWidthMm) || 0

  const mainRozilKey = thSel > 0 ? String(thSel) : ''
  const mainRozilDefaultQty =
    boardsPerStripForRozil > 0 ? String(boardsPerStripForRozil) : '1'
  const mainRozilQtyStr =
    mainRozilKey && activeStockRow
      ? stripSawQtyDraft[mainRozilKey] ?? mainRozilDefaultQty
      : mainRozilDefaultQty

  return (
    <>
      {user?.role === 'circular_operator' && <AssignedTasksPanel />}
      <section className="panel stripSawPageRoot">
        <h2>Багатопил — з смуги в бруси</h2>

        {tasksErr && <p className="birkaMsgErr">{tasksErr}</p>}
        <div className="row">
          <label className="stripTaskPick">
            Завдання
            <select value={stripTaskId} onChange={(e) => setStripTaskId(e.target.value)}>
              <option value="">— оберіть —</option>
              {tasksForStrip.map((t) => {
                const n = t.stripInventory?.length ?? 0
                return (
                  <option key={t.id} value={t.id}>
                    {t.title}
                    {n > 0 ? ` · записів: ${n}` : ''}
                  </option>
                )
              })}
            </select>
          </label>
        </div>
        {stripSawErr && <p className="birkaMsgErr">{stripSawErr}</p>}
        {stripActionOk && (
          <p className="stripActionOkMsg" role="status" aria-live="polite">
            <span className="stripActionOkText">{stripActionOk}</span>
            <button
              type="button"
              className="stripActionOkDismiss"
              onClick={() => setStripActionOk(null)}
              aria-label="Закрити повідомлення"
            >
              ×
            </button>
          </p>
        )}

        {selectedStripTask && thSel > 0 && (
          <div className="stripHeroGrid">
            <div className="stripHeroCard stripHeroCardAmber">
              <div className="stripHeroCardTitle">Смуги (етап «по ширині»)</div>
              <p className="stripHeroCardSub">
                Висота деталі <strong>{thSel} мм</strong>. <strong>Залишок</strong> — смуги, які ще не
                списали розпилом.
              </p>
              <div className="stripHeroNum">{activeStockRow != null ? activeStockRow.remainder : '—'}</div>
              <div className="stripHeroUnit">шт смуг у залишку</div>
              {activeStockRow != null ? (
                <div className="stripHeroMeta">
                  <span>
                    Розпиляно смуг: <strong>{activeStockRow.cutSum}</strong>
                  </span>
                  <span className="stripHeroMetaSep">·</span>
                  <span>
                    Прийшло з стрічкової пили: <strong>{activeStockRow.incoming}</strong>
                  </span>
                </div>
              ) : (
                <div className="stripHeroMeta panelHint">Немає рядка складу для цієї висоти.</div>
              )}
            </div>
            <div className="stripHeroCard stripHeroCardGreen">
              <div className="stripHeroCardTitle">Деталі за замовленням (бруси)</div>
              <p className="stripHeroCardSub">
                Для висоти <strong>{thSel} мм</strong>
                {circularRowForTh != null ? (
                  <>
                    {' '}
                    — усього треба <strong>{circularRowForTh.qtyNeeded}</strong> шт
                  </>
                ) : (
                  ' (немає рядка в плані — перевірте замовлення)'
                )}
                .
              </p>
              <div className="stripHeroDual">
                <div className="stripHeroDualItem">
                  <div className="stripHeroDualLabel">Напиляно (записано)</div>
                  <div className="stripHeroDualNum">
                    {circularRowForTh != null ? circularRowForTh.qtyDone ?? 0 : '—'}
                  </div>
                  <div className="stripHeroDualUnit">шт деталей</div>
                </div>
                <div className="stripHeroDualItem stripHeroDualItemAccent">
                  <div className="stripHeroDualLabel">Залишилось напиляти</div>
                  <div className="stripHeroDualNum stripHeroDualNumLarge">
                    {brusNeedRemaining != null ? brusNeedRemaining : '—'}
                  </div>
                  <div className="stripHeroDualUnit">шт деталей</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedStripTask && !activeStockRow && stripSawStockRows.length > 0 && thSel > 0 && (
          <p className="panelHint stripWarn">
            Для висоти <strong>{thSel} мм</strong> немає смуг на складі. Оберіть іншу висоту в кроці 1
            або дочекайтесь запису з стрічкової пили.
          </p>
        )}

        {selectedStripTask && stripSawStockRows.length === 0 && (
          <p className="panelHint">По цьому завданню ще немає смуг з стрічкової пили.</p>
        )}

        <details className="stripDetailsAdvanced">
          <summary>Склад по всіх висотах і ручна корекція залишку смуг</summary>
          <p className="panelHint">
            Якщо зламали смугу або рахунок не сходиться — виправте залишок тут. Звичайній роботі цей
            блок не потрібен.
          </p>
          {selectedStripTask && stripSawStockRows.length > 0 && (
            <table className="stripStockTable stripSawStockTable stripAdminTable">
              <thead>
                <tr>
                  <th
                    title="Висота смуги в торці; ширина смуги до різу на багатопилі (хорда); типова ширина готового бруса з замовлення"
                  >
                    Висота / смуга до різу / брус, мм
                  </th>
                  <th
                    title="Скільки заготовок по довжині можна нарізати торцовкою з однієї смуги: довжина смуги з запису стрічкової пили, довжина заготовки та пропил з замовлення"
                  >
                    Торцовка з 1 смуги, шт
                  </th>
                  <th>Було смуг</th>
                  <th>Вже спиляно</th>
                  <th>Залишок</th>
                  <th>Корекція</th>
                </tr>
              </thead>
              <tbody>
                {stripSawStockRows.map((row) => {
                  const k = String(row.th)
                  const remDraft = stripRemainderDraft[k]
                  const remInput = remDraft ?? String(row.remainder)
                  return (
                    <tr key={row.th}>
                      <td>
                        <strong>{row.th}</strong> вис · смуга{' '}
                        <strong>{row.undressedStripMm != null ? row.undressedStripMm : '—'}</strong> до
                        різу · брус <strong>{row.widthMm != null ? row.widthMm : '—'}</strong>
                        {row.logLenMm != null && row.pieceLenMm != null ? (
                          <div className="stripAdminSizeHint">
                            смуга L={row.logLenMm} мм, заготовка L={row.pieceLenMm} мм
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {row.piecesAlongLog != null ? (
                          <strong>{row.piecesAlongLog}</strong>
                        ) : (
                          <span className="panelHint">—</span>
                        )}
                      </td>
                      <td>{row.incoming}</td>
                      <td>{row.cutSum}</td>
                      <td>
                        {row.remainder}
                        {row.hasOverride ? (
                          <span className="stripRemainderOverrideMark" title="Ручна корекція залишку">
                            {' '}
                            *
                          </span>
                        ) : null}
                      </td>
                      <td className="stripSawRemainderCell">
                        {canRecordStripSaw ? (
                          <div className="stripSawInlineActions">
                            <input
                              className="stripSawSmallInput"
                              type="number"
                              min={0}
                              step={1}
                              value={remInput}
                              onChange={(e) =>
                                setStripRemainderDraft((p) => ({ ...p, [k]: e.target.value }))
                              }
                              aria-label={`Залишок вручну для ${row.th} мм`}
                            />
                            <button
                              type="button"
                              className="btnSecondary stripSawMiniBtn"
                              disabled={stripSawBusy}
                              onClick={async () => {
                                if (!selectedStripTask) return
                                const R = Math.round(Number(String(remInput).replace(',', '.')))
                                if (!Number.isFinite(R) || R < 0) {
                                  setStripSawErr('Вкажіть невід’ємний цілий залишок')
                                  return
                                }
                                setStripSawBusy(true)
                                setStripSawErr(null)
                                setStripActionOk(null)
                                try {
                                  const updated = await patchStripSawRemainder(selectedStripTask.id, {
                                    thicknessMm: row.th,
                                    remainder: R,
                                  })
                                  setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
                                  setStripRemainderDraft((p) => {
                                    const n = { ...p }
                                    delete n[k]
                                    return n
                                  })
                                  setStripActionOk(
                                    `Залишок смуг для висоти ${row.th} мм збережено: ${R} шт.`,
                                  )
                                } catch (e) {
                                  setStripSawErr(e instanceof Error ? e.message : 'Помилка збереження')
                                } finally {
                                  setStripSawBusy(false)
                                }
                              }}
                            >
                              Застосувати
                            </button>
                            <button
                              type="button"
                              className="btnSecondary stripSawMiniBtn"
                              disabled={stripSawBusy || !row.hasOverride}
                              onClick={async () => {
                                if (!selectedStripTask) return
                                setStripSawBusy(true)
                                setStripSawErr(null)
                                setStripActionOk(null)
                                try {
                                  const updated = await patchStripSawRemainder(selectedStripTask.id, {
                                    thicknessMm: row.th,
                                    remainder: null,
                                  })
                                  setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
                                  setStripRemainderDraft((p) => {
                                    const n = { ...p }
                                    delete n[k]
                                    return n
                                  })
                                  setStripActionOk(
                                    `Корекцію залишку для висоти ${row.th} мм скинуто — знову рахунок «прийшло − спиляно».`,
                                  )
                                } catch (e) {
                                  setStripSawErr(e instanceof Error ? e.message : 'Помилка')
                                } finally {
                                  setStripSawBusy(false)
                                }
                              }}
                            >
                              Скинути
                            </button>
                          </div>
                        ) : (
                          <span className="panelHint">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </details>

        {selectedStripTask && parsedOrder && thicknessOptionsMm.length > 0 && (
          <div className="stripWorkflow">
            <h3 className="stripStockTitle">Крок 1. Висота смуги (замовлення)</h3>
            <p className="panelHint">
              Одна висота — одна «пачка» смуг зі складу.{' '}
              <strong>Іншу товщину (висоту) дошки</strong> оберіть у списку «Висота деталі» нижче — у
              ньому лише ті товщини, для яких є <strong>смуги в залишку</strong> (без смуг ряд не
              з’явиться). Після зміни висоти кроки 2–4 перерахуються під неї. Якщо потрібної товщини
              немає в списку — дочекайтесь запису з стрічкової пили або оберіть інше завдання.
            </p>
            {thicknessOptionsWithStripsMm.length > 0 ? (
              <div className="row stripMeasureRow stripWidthModeRow">
                <label>
                  Висота деталі (товщина дошки)
                  <select
                    value={stripThicknessMm}
                    onChange={(e) => setStripThicknessMm(e.target.value)}
                    aria-label="Товщина / висота дошки; перемкнути іншу висоту з цього замовлення"
                  >
                    {thicknessOptionsWithStripsMm.map((t) => (
                      <option key={t} value={String(t)}>
                        {fmtCmFromMm(t)} ({t} мм)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <p className="panelHint stripWarn">
                Немає жодної висоти з смугами в залишку. Дочекайтесь запису з стрічкової пили або оберіть інше
                завдання.
              </p>
            )}

            {thicknessOptionsWithStripsMm.length > 0 && stripSawOrderDoneForSelected ? (
              <div className="stripWorkflowDone">
                <h3 className="stripStockTitle">Замовлення для цієї висоти вже закрите</h3>
                <p>
                  Для висоти <strong>{thSel} мм</strong> зроблено{' '}
                  <strong>{circularRowForTh?.qtyDone ?? 0}</strong> з{' '}
                  <strong>{circularRowForTh?.qtyNeeded ?? 0}</strong> деталей за замовленням. Нарізати
                  ще за нормою не потрібно — кроки з кнопками приховані.
                </p>
                {activeStockRow != null && activeStockRow.remainder > 0 ? (
                  <p className="panelHint stripWorkflowDoneExtra">
                    У залишку ще <strong>{activeStockRow.remainder}</strong> смуг цієї висоти (понад
                    норму). За потреби — блок «Склад по всіх висотах» нижче.
                  </p>
                ) : null}
              </div>
            ) : thicknessOptionsWithStripsMm.length > 0 ? (
              <>
            <h3 className="stripStockTitle">Крок 2. Яку ширину бруса ріжете зараз</h3>
            <p className="panelHint">
              Це лише <strong>як показати</strong> рядки та кресленик для поточної висоти: одна ширина
              чи змішаний поріз. Якщо обрати одну ширину — інші згортаються (кнопка «Показати всі
              ширини» розгорне список). <strong>У систему нічого не записується</strong>, доки не
              натиснете «Розпил — записати» в кроці 4.
            </p>
            <div className="row stripBoardFocusRow">
              <label>
                Ширина бруса
                <select
                  value={stripBoardFocus === 'mixed' ? 'mixed' : String(stripBoardFocus)}
                  onChange={(e) => {
                    const v = e.target.value
                    setDemandTableShowAll(false)
                    if (v === 'mixed') setStripBoardFocus('mixed')
                    else setStripBoardFocus(Number(v))
                  }}
                  aria-label="Режим відображення ширин брусів для обраної висоти"
                >
                  <option value="mixed">Усі ширини разом (змішаний поріз)</option>
                  {demandAtThickness.map((d) => (
                    <option key={d.boardWidthMm} value={String(d.boardWidthMm)}>
                      Лише {d.boardWidthMm} мм
                    </option>
                  ))}
                </select>
              </label>
              {stripBoardFocus !== 'mixed' && demandWithCuts.length > 1 ? (
                <button
                  type="button"
                  className="btnSecondary stripExpandWidthsBtn"
                  onClick={() => setDemandTableShowAll((s) => !s)}
                  aria-pressed={demandTableShowAll}
                  title={
                    demandTableShowAll
                      ? 'Залишити лише обрану ширину в таблиці'
                      : 'Показати всі ширини цієї висоти в таблиці'
                  }
                >
                  {demandTableShowAll
                    ? 'Сховати зайві ширини'
                    : `Показати всі ширини (${demandWithCuts.length})`}
                </button>
              ) : null}
            </div>

            <h3 className="stripStockTitle">Крок 3. Ширина смуги для схеми</h3>
            <p className="panelHint">
              Пропил циркулярки: <strong>{kerfEffMm} мм</strong>. Торець як на стрічковій пилі:{' '}
              <strong>{bandCrossFit === 'min_waste' ? 'мінімум відходів' : 'смуги в колі'}</strong>
              {plannedChordMm > 0 ? (
                <>
                  . Макс. ширина смуги з плану (хорда):{' '}
                  <strong>{plannedChordMm.toFixed(0)} мм</strong>
                </>
              ) : stripWidthUsesOrderEstimate ? (
                <>
                  . Хорда в завданні не задана — для схеми взято{' '}
                  <strong>орієнтир з ширин брусів</strong> у замовленні (
                  <strong>{orderBasedStripEstimateMm.toFixed(0)} мм</strong>).
                </>
              ) : null}
              .
            </p>
            {stripWidthUsesOrderEstimate ? (
              <p className="panelHint stripWidthSoftHint">
                Якщо на торці смуга інша — увімкніть «Свій замір» і введіть фактичні міліметри.
              </p>
            ) : null}
            <fieldset className="stripWidthFieldset">
              <legend>Звідки брати ширину смуги для малюнка</legend>
              <label className="stripWidthRadio">
                <input
                  type="radio"
                  name="stripWidthMode"
                  checked={stripWidthMode === 'plan'}
                  onChange={() => setStripWidthMode('plan')}
                />
                За планом стрічкової пили (для схеми:{' '}
                {planSchemeStripMm > 0 ? `${planSchemeStripMm.toFixed(0)} мм` : '—'})
              </label>
              <label className="stripWidthRadio">
                <input
                  type="radio"
                  name="stripWidthMode"
                  checked={stripWidthMode === 'manual'}
                  onChange={() => setStripWidthMode('manual')}
                />
                Свій замір (мм)
                <input
                  className="stripManualWidthInput"
                  value={measuredStripMm}
                  onChange={(e) => {
                    setMeasuredStripMm(e.target.value)
                    setStripWidthMode('manual')
                  }}
                  type="number"
                  min={1}
                  step={1}
                  placeholder="замір"
                  disabled={stripWidthMode !== 'manual'}
                />
              </label>
            </fieldset>

            {effectiveStripMm > 0 && demandRowsForTable.length > 0 && (
              <>
                <p className="panelHint stripSameHeightHint">
                  Усі рядки — це <strong>одна й та сама висота</strong> (крок 1), різняться лише{' '}
                  <strong>ширини брусів</strong> з замовлення — та сторона перетину, яка{' '}
                  <strong>не</strong> дорівнює обраній висоті смуги (різ поперек смуги на багатопилі).
                  Скільки таких брусів треба і
                  скільки виходить з однієї смуги по ширині — у колонках; змішаний поріз рахується окремо
                  (колонка «У змішаному порізі»).
                </p>
                <table className="stripDemandTable">
                  <thead>
                    <tr>
                      <th>Ширина бруса, мм</th>
                      <th>Потрібно, шт</th>
                      <th>З однієї смуги (лише ця шир.)</th>
                      <th>У змішаному порізі, шт</th>
                      <th>До потреби (зміш.)</th>
                      <th>Відходи шир., мм</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demandRowsForTable.map((row, i) => (
                      <tr key={`${i}-${row.boardWidthMm}-${row.qtyNeeded}`}>
                        <td>{row.boardWidthMm}</td>
                        <td>{row.qtyNeeded}</td>
                        <td>{row.fitsSingleWidth}</td>
                        <td>
                          <strong>{row.fitsMixed}</strong>
                        </td>
                        <td>
                          <strong>{row.coversMixedStrip}</strong>
                          {row.fitsMixed > row.qtyNeeded && (
                            <span className="stripExtraHint">
                              {' '}
                              (надлишок {row.fitsMixed - row.qtyNeeded} шт)
                            </span>
                          )}
                        </td>
                        <td>{row.wasteIfSingleMm.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {stripBoardFocus === 'mixed' && mixedCutsDiagram ? (
                  <p className="panelHint stripMixedSummary">
                    {mixedCutsIsIllustrationOnly ? (
                      <>
                        У таблиці для цієї висоти <strong>0 шт</strong> за нормою — показано{' '}
                        <strong>умовний</strong> змішаний ряд (по одній деталі кожної ширини з
                        замовлення).{' '}
                      </>
                    ) : null}
                    Змішаний поріз (схема — перший крок плану ножів): використано{' '}
                    <strong>{mixedCutsDiagram.usedMm.toFixed(0)} мм</strong> з{' '}
                    <strong>{effectiveStripMm.toFixed(0)} мм</strong>, залишок ширини{' '}
                    <strong>{mixedCutsDiagram.wasteMm.toFixed(0)} мм</strong>.
                  </p>
                ) : null}

                {stripBoardFocus === 'mixed' &&
                mixedCutsDiagram &&
                !mixedCutsDiagramHasBoard ? (
                  <p className="panelHint stripNoDiagramHint">
                    Жодна дошка не вміщується у смугу шириною{' '}
                    <strong>{effectiveStripMm.toFixed(0)} мм</strong>. Спробуйте іншу товщину або
                    введіть власну ширину смуги («Свій замір»).
                  </p>
                ) : null}

                {stripBoardFocus === 'mixed' &&
                mixedCutsDiagram &&
                mixedCutsDiagram.segments.length > 0 ? (
                  <MixedStripDiagram
                    stripMm={effectiveStripMm}
                    segments={mixedCutsDiagram.segments}
                    kerfMm={kerfEffMm}
                  />
                ) : null}

                {stripBoardFocus === 'mixed' &&
                knifePlanForUi &&
                knifePlanForUi.setups.length > 0 ? (
                  <div className="stripKnifePlanBox">
                    <p className="panelHint stripKnifePlanTitle">
                      План ножів (мінімум перестановок), кроків:{' '}
                      <strong>{knifePlanForUi.setups.length}</strong>:
                    </p>
                    <ol className="stripKnifeSetupList">
                      {knifePlanForUi.setups.map((s, i) => (
                        <li key={i}>
                          <strong>
                            {i + 1}. {s.setupLabel}
                          </strong>
                          {' — '}
                          смуг за прохід: <strong>{s.stripCount}</strong>
                        </li>
                      ))}
                    </ol>
                    {knifePlanMixedQty && knifePlanMixedQty.setups.length > 1 ? (
                      <p className="panelHint stripKnifePlanRozilNote">
                        Запис розпилу зараз підставляє вироби лише з <strong>першого</strong> кроку ×
                        кількість смуг; при кількох кроках додайте окремі записи або уточніть кількості
                        вручну.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {stripBoardFocus !== 'mixed' && typeof stripBoardFocus === 'number' ? (
                  <>
                    {computeBoardsAcrossWidth(effectiveStripMm, stripBoardFocus, kerfEffMm).boards === 0 ? (
                      <p className="panelHint stripNoDiagramHint">
                        Ширина {stripBoardFocus} мм не вміщується у смугу шириною{' '}
                        <strong>{effectiveStripMm.toFixed(0)} мм</strong>.
                      </p>
                    ) : null}
                    <SingleWidthStripDiagram
                      stripMm={effectiveStripMm}
                      boardMm={stripBoardFocus}
                      kerfMm={kerfEffMm}
                    />
                  </>
                ) : null}

                {demandAtThickness.length > 1 && diagramW > 0 && (
                  <details className="stripSingleDiagramDetails">
                    <summary>Приклад: лише одна ширина ({diagramW} мм)</summary>
                    <label className="stripDiagramPick">
                      Ширина для прикладу
                      <select
                        value={diagramBoardWidthMm}
                        onChange={(e) => setDiagramBoardWidthMm(e.target.value)}
                      >
                        {demandAtThickness.map((d) => (
                          <option key={d.boardWidthMm} value={String(d.boardWidthMm)}>
                            {d.boardWidthMm} мм
                          </option>
                        ))}
                      </select>
                    </label>
                    <SingleWidthStripDiagram
                      stripMm={effectiveStripMm}
                      boardMm={diagramW}
                      kerfMm={kerfEffMm}
                    />
                  </details>
                )}
              </>
            )}

            {demandAtThickness.length > 0 && effectiveStripMm <= 0 ? (
              <div
                className="panelHint stripWidthFailExplain"
                role="status"
                aria-live="polite"
              >
                {stripWidthMode === 'plan' ? (
                  <p className="stripWidthFailLead">
                    Автоматично не вийшло підставити ширину смуги. Оберіть{' '}
                    <strong>«Свій замір»</strong> і введіть ширину з торця (мм), або зверніться до
                    бригадира, щоб оновили завдання.
                  </p>
                ) : (
                  <p>Введіть ширину смуги вручну (мм) у полі вище.</p>
                )}
              </div>
            ) : null}

            {activeStockRow && canRecordStripSaw && mainRozilKey ? (
              <div className="stripRozilHero">
                <h3 className="stripStockTitle">Крок 4. Записати розпил</h3>
                <p className="panelHint stripRozilHeroLead">
                  Після порізу введіть, скільки <strong>брусів</strong> ви зняли (за замовчуванням — як
                  на схемі з <strong>однієї смуги</strong>). Натисніть кнопку — з залишку зникнуть{' '}
                  <strong>смуги</strong>, до завдання додадуться <strong>бруси</strong>. Після успіху
                  з’явиться <strong>зелене повідомлення</strong> з цифрами; якщо його немає — запис не
                  пройшов (див. червоний текст вище).
                </p>
                <p className="stripRozilSchemeHint">
                  За схемою з <strong>однієї</strong> смуги виходить:{' '}
                  <strong>{boardsPerStripForRozil > 0 ? boardsPerStripForRozil : '—'}</strong> брусів
                  {stripBoardFocus === 'mixed' ? ' (усі ширини разом)' : ` (ширина ${stripBoardFocus} мм)`}.
                </p>
                <div className="stripRozilHeroRow">
                  <label className="stripRozilHeroLabel">
                    Скільки брусів записати
                    <input
                      className="stripRozilHeroInput"
                      type="number"
                      min={1}
                      step={1}
                      value={mainRozilQtyStr}
                      onChange={(e) =>
                        setStripSawQtyDraft((p) => ({ ...p, [mainRozilKey]: e.target.value }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="stripRozilHeroBtn"
                    disabled={stripSawBusy || activeStockRow.remainder <= 0}
                    aria-busy={stripSawBusy}
                    onClick={() => void runStripSawForRow(activeStockRow)}
                  >
                    {stripSawBusy ? 'Запис…' : 'Розпил — записати'}
                  </button>
                </div>
              </div>
            ) : null}
              </>
            ) : null}
          </div>
        )}

        {selectedStripTask && parsedOrder == null && (
          <p className="birkaMsgErr">Не вдалося розібрати замовлення в завданні.</p>
        )}

        <details className="stripDetailsAdvanced stripManualCalcDetails">
          <summary>Калькулятор без завдання (для перевірки цифр)</summary>
          <h3 className="stripStockTitle">Ручний розрахунок</h3>
          <div className="row">
            <label>
              Ширина смуги на вході (мм)
              <input
                value={stripWidth}
                onChange={(e) => setStripWidth(e.target.value)}
                type="number"
                min={1}
              />
            </label>
            <label>
              Ширина деталі після порізу (мм)
              <input
                value={boardThickness}
                onChange={(e) => setBoardThickness(e.target.value)}
                type="number"
                min={1}
              />
            </label>
            <label>
              Пропил (мм)
              <input
                value={kerf}
                onChange={(e) => setKerf(e.target.value)}
                type="number"
                min={0}
                disabled={!!selectedStripTask}
                title={selectedStripTask ? 'Береться з завдання' : undefined}
              />
            </label>
          </div>
          <div className="panelHint stripSawResult">
            <p>
              <strong>З однієї смуги виходить дощок (по ширині):</strong> {cutManual.boards} шт.
            </p>
            <p>
              <strong>Використано ширини:</strong> {cutManual.usedMm.toFixed(0)} мм з{' '}
              {Number(stripWidth) || 0} мм
            </p>
            <p>
              <strong>Відходи етапу 2:</strong> пропил <b>{cutManual.kerfLossMm.toFixed(0)} мм</b>
              {' · '}
              залишок <b>{cutManual.wasteMm.toFixed(0)} мм</b>
            </p>
          </div>
        </details>
      </section>
    </>
  )
}
