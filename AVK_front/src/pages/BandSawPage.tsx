import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import {
  consumeRoundwoodLog,
  fetchRoundwoodState,
  fetchTasks,
  recordBandCut,
} from '../api'
import { useAuth } from '../context/AuthContext'
import {
  BAND_CROSS_FIT_STORAGE_KEY,
  buildResawRulerSteps,
  listPitagoResawCuts,
  maxThicknessFeasibleForRadius,
  pitagoCutHeightFromBottomMm,
  rowChordMm,
  type BandCrossFitMode,
  type CrossRowWithThickness,
} from '../helpers/crossSection'
import {
  bandRemainingQty,
  recomputeBandPlanForRadius,
  sortBandByLeastWaste,
} from '../helpers/foremanPlan'
import { boardsPerPhysicalStrip } from '../helpers/alongLogPieces'
import {
  parseForemanOrderTextOrEmpty,
  crossSectionMmFromDimensionRow,
  adHocBandThicknessesFromDimensionRows,
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
const BAND_SAW_KERF_MM = 4

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

function buildPitagoCrossRow(
  radiusMm: number,
  y: number,
  thicknessMm: number,
  kerfMm: number,
  fit: BandCrossFitMode,
): CrossRowWithThickness | null {
  const kerf = Math.max(kerfMm, 0)
  const chord = rowChordMm(radiusMm, y, thicknessMm, fit)
  const boards = Math.floor((chord + kerf) / (thicknessMm + kerf))
  if (boards <= 0) return null
  return {
    y,
    chord,
    boards,
    boardWidth: (chord - kerf * (boards - 1)) / boards,
    thicknessMm,
  }
}

function stackHeightMm(thicknessesMm: number[], kerfMm: number): number {
  if (thicknessesMm.length === 0) return 0
  return thicknessesMm.reduce((sum, thicknessMm) => sum + thicknessMm, 0) +
    kerfMm * (thicknessesMm.length - 1)
}

function buildPitagoBandCrossSection(
  radiusMm: number,
  thicknessesMm: number[],
  kerfMm: number,
  fit: BandCrossFitMode,
  secondaryThicknessMmSet: Set<number> = new Set(),
): CrossRowWithThickness[] {
  const filtered = thicknessesMm.filter((t) => t > 0)
  if (radiusMm <= 0 || !filtered.length) return []

  const [primaryThickness, ...otherThicknessesMm] = filtered
  const kerf = Math.max(kerfMm, 0)
  const maxHeight = radiusMm * 2
  const packedOthers = [...otherThicknessesMm]
  while (
    packedOthers.length > 0 &&
    stackHeightMm([primaryThickness, ...packedOthers], kerf) > maxHeight
  ) {
    packedOthers.pop()
  }

  let primaryCount = 1
  while (
    stackHeightMm(
      [...Array(primaryCount + 1).fill(primaryThickness), ...packedOthers],
      kerf,
    ) <= maxHeight
  ) {
    primaryCount += 1
  }

  const stack = [...Array(primaryCount).fill(primaryThickness), ...packedOthers]
  const totalHeight = stackHeightMm(stack, kerf)
  let cursor = -totalHeight / 2
  const rows: CrossRowWithThickness[] = []
  for (const thicknessMm of stack) {
    const y = cursor + thicknessMm / 2
    const row = buildPitagoCrossRow(radiusMm, y, thicknessMm, kerfMm, fit)
    if (row) {
      const stripKind = secondaryThicknessMmSet.has(thicknessMm) ? 'secondary' : 'primary'
      rows.push({ ...row, thicknessMm, stripKind })
    }
    cursor += thicknessMm + kerf
  }
  return rows
}

type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>
}

type BarcodeDetectorConstructorLike = new (options?: {
  formats?: string[]
}) => BarcodeDetectorLike

/** Етап 1: стрічкова пила знімає смуги заданої товщини (висота в торці), різ вздовж усієї осі колоди — без нарізки по довжині. */
export function BandSawPage() {
  const { user } = useAuth()
  const [logs, setLogs] = useState<LogItem[]>([])
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksErr, setTasksErr] = useState<string | null>(null)
  const [boardThickness, setBoardThickness] = useState('25')
  const [bandCutDraft, setBandCutDraft] = useState<Record<number, string>>({})
  const [bandCutBusy, setBandCutBusy] = useState(false)
  const [bandCutMsg, setBandCutMsg] = useState<string | null>(null)
  const [bandCutErr, setBandCutErr] = useState(false)
  const [bandCrossFit, setBandCrossFit] = useState<BandCrossFitMode>(readStoredBandCrossFit)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerBusy, setScannerBusy] = useState(false)
  const [scannerError, setScannerError] = useState<string | null>(null)
  /** Показання 1-го різу (мм, одна цифра після коми); порожньо — лише геометрія з тим же округленням. */
  const [resawFirstCutMm, setResawFirstCutMm] = useState('')

  const bandCutSeedKeyRef = useRef<string | null>(null)
  const [hideCompletedBandRows, setHideCompletedBandRows] = useState(false)
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null)
  const scannerFileInputRef = useRef<HTMLInputElement | null>(null)
  const scannerStreamRef = useRef<MediaStream | null>(null)
  const scannerLoopIdRef = useRef<number | null>(null)
  const barcodeDetectorRef = useRef<BarcodeDetectorLike | null>(null)
  const zxingReaderRef = useRef<BrowserMultiFormatReader | null>(null)
  const zxingControlsRef = useRef<IScannerControls | null>(null)

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
    () =>
      tasks.filter(
        (t) => t.assignTo.includes('sawyer') && (t.taskKind ?? 'resaw') === 'resaw',
      ),
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

  const effectiveKerfMm = BAND_SAW_KERF_MM

  /** План стрічкової пили під радіус завдання або обраної колоди — сортування: мін. перерізи, мін. надлишок. */
  const bandSortedForLog = useMemo(() => {
    if (!selectedTask?.plan.band.length) return []
    const rMm = selectedLog?.radius ?? selectedTask.radiusMm
    return sortBandByLeastWaste(
      recomputeBandPlanForRadius(rMm, effectiveKerfMm, selectedTask.plan.band, bandCrossFit),
    )
  }, [selectedTask, selectedLog, effectiveKerfMm, bandCrossFit])

  const adHocBandThicknessMmSet = useMemo(() => {
    if (!selectedTask?.dimensionRows?.length) return new Set<number>()
    return adHocBandThicknessesFromDimensionRows(
      selectedTask.dimensionRows,
      selectedTask.unit === 'cm' ? 'cm' : 'mm',
    )
  }, [selectedTask])

  const bandCompletedCount = useMemo(
    () => bandSortedForLog.filter((b) => bandRemainingQty(b) === 0).length,
    [bandSortedForLog],
  )

  const bandTableRows = useMemo(() => {
    if (!hideCompletedBandRows) return bandSortedForLog
    return bandSortedForLog.filter((b) => {
      if (bandRemainingQty(b) > 0) return true
      return adHocBandThicknessMmSet.has(b.thicknessMm)
    })
  }, [bandSortedForLog, hideCompletedBandRows, adHocBandThicknessMmSet])

  const bandUnifiedTableRows = useMemo(() => {
    const planPart = bandTableRows.map((b) => ({ kind: 'plan' as const, b }))
    const planTh = new Set<number>((selectedTask?.plan.band ?? []).map((row) => row.thicknessMm))
    const adhocOnly = [...adHocBandThicknessMmSet]
      .filter((t) => !planTh.has(t))
      .sort((a, b) => b - a)
    const adhocPart = adhocOnly.map((thicknessMm) => ({ kind: 'adhoc' as const, thicknessMm }))
    return [...planPart, ...adhocPart]
  }, [bandTableRows, adHocBandThicknessMmSet, selectedTask?.plan.band])

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

  /** Товщини (мм) з побічних рядків форми бригадира — для орієнтиру на карті торця. */
  const openSecondaryStripCandidatesMm = useMemo(() => {
    if (!selectedTask?.dimensionRows?.length) return []
    const u = selectedTask.unit === 'cm' ? 'cm' : 'mm'
    const uniq = new Set<number>()
    for (const r of selectedTask.dimensionRows) {
      if (r.kind !== 'secondary' || String(r.qty ?? '').trim() !== '') continue
      const cs = crossSectionMmFromDimensionRow(
        { kind: r.kind, qty: r.qty, height: r.height, width: r.width, length: r.length },
        u,
      )
      if (!cs) continue
      const a = Math.round(cs.aMm)
      const b = Math.round(cs.bMm)
      if (a > 0) uniq.add(a)
      if (b > 0) uniq.add(b)
    }
    return [...uniq].sort((x, y) => y - x)
  }, [selectedTask])

  const { stackThicknessesMm, secondaryStripThicknessMmSet } = useMemo(() => {
    const manual = Number(boardThickness) || 0
    const candidates = openSecondaryStripCandidatesMm

    const extrasNotInPlan = (planThicknesses: number[]) => {
      const planSet = new Set(planThicknesses)
      return candidates.filter((t) => !planSet.has(t)).sort((a, b) => b - a)
    }

    if (!selectedTask?.plan.band.length || !bandFullOrderForMap.length) {
      const base: number[] = manual > 0 ? [manual] : []
      const extra = extrasNotInPlan(base)
      const stack =
        base.length && extra.length ? [...base, ...extra] : base.length ? base : extra
      return { stackThicknessesMm: stack, secondaryStripThicknessMmSet: new Set(extra) }
    }

    const seq = bandFullOrderForMap
      .filter((b) => b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0)
      .map((b) => b.thicknessMm)

    if (seq.length === 0) {
      const base: number[] = manual > 0 ? [manual] : []
      const extra = extrasNotInPlan(base)
      const stack =
        base.length && extra.length ? [...base, ...extra] : base.length ? base : extra
      return { stackThicknessesMm: stack, secondaryStripThicknessMmSet: new Set(extra) }
    }

    const extra = extrasNotInPlan(seq)
    const stack = extra.length ? [...seq, ...extra] : seq
    return { stackThicknessesMm: stack, secondaryStripThicknessMmSet: new Set(extra) }
  }, [selectedTask, bandFullOrderForMap, boardThickness, openSecondaryStripCandidatesMm])

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
    const p = parseForemanOrderTextOrEmpty(
      selectedTask.orderText,
      selectedTask.unit === 'cm' ? 'cm' : 'mm',
    )
    return p.ok ? p.lines : null
  }, [selectedTask])

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
    if (!selectedLog || !selectedTask) return m
    const kerf = selectedTask.kerfCircMm
    const lines = taskOrderLines ?? []
    const thSet = new Set<number>()
    for (const row of selectedTask.plan.band) thSet.add(row.thicknessMm)
    for (const t of adHocBandThicknessMmSet) thSet.add(t)
    for (const th of thSet) {
      m.set(
        th,
        lines.length ? boardsPerPhysicalStrip(lines, th, selectedLog.length, kerf) : 1,
      )
    }
    return m
  }, [selectedTask, taskOrderLines, selectedLog, adHocBandThicknessMmSet])

  /**
   * Для товщин, яких немає в plan.band, бекенд не піднімає qtyDone — натомість смуги в stripInventory.
   * Конвертуємо на «дошки по довжині» так само, як при записі recordBandCut.
   */
  const bandBoardsDoneFromStripInventoryByThickness = useMemo(() => {
    const m = new Map<number, number>()
    if (!selectedTask?.stripInventory?.length) return m
    const lines = taskOrderLines ?? []
    const kerf = selectedTask.kerfCircMm
    for (const e of selectedTask.stripInventory) {
      const th = Math.round(Number(e.thicknessMm))
      if (!Number.isFinite(th) || th <= 0) continue
      const qty = Math.round(Number(e.qty))
      if (!Number.isFinite(qty) || qty <= 0) continue
      const L = Math.round(Number(e.logLengthMm))
      const logLen = L > 0 ? L : 4000
      const per = lines.length ? boardsPerPhysicalStrip(lines, th, logLen, kerf) : 1
      m.set(th, (m.get(th) ?? 0) + qty * per)
    }
    return m
  }, [selectedTask, taskOrderLines])

  const crossRows = useMemo(() => {
    if (!selectedLog || !stackThicknessesMm.length) return []
    return buildPitagoBandCrossSection(
      selectedLog.radius,
      stackThicknessesMm,
      effectiveKerfMm,
      bandCrossFit,
      secondaryStripThicknessMmSet,
    )
  }, [selectedLog, stackThicknessesMm, effectiveKerfMm, bandCrossFit, secondaryStripThicknessMmSet])

  const bandAutoCutByThickness = useMemo(() => {
    const m = new Map<number, number>()
    for (const row of crossRows) {
      if (row.stripKind === 'secondary') continue
      m.set(row.thicknessMm, (m.get(row.thicknessMm) ?? 0) + 1)
    }
    return m
  }, [crossRows])

  /** Побічні смуги на карті розкрою (торець) по товщині — для таблиці й чернетки списання. */
  const secondaryStripsOnMapByThickness = useMemo(() => {
    const m = new Map<number, number>()
    for (const row of crossRows) {
      if (row.stripKind !== 'secondary') continue
      m.set(row.thicknessMm, (m.get(row.thicknessMm) ?? 0) + 1)
    }
    return m
  }, [crossRows])

  const suggestedBandCutDraft = useMemo(() => {
    if (!selectedLog || !selectedTask || bandSortedForLog.length === 0) return null
    const out: Record<number, string> = {}
    for (const b of bandSortedForLog) {
      const left = bandRemainingQty(b)
      const per = Math.max(1, boardsPerStripByThickness.get(b.thicknessMm) ?? 1)
      const primaryAuto = bandAutoCutByThickness.get(b.thicknessMm) ?? 0
      const secondaryAuto = secondaryStripsOnMapByThickness.get(b.thicknessMm) ?? 0
      const autoCut = primaryAuto + secondaryAuto
      const maxStripsByNorm = left > 0 ? Math.max(1, Math.ceil(left / per)) : 0
      const adHocTh = adHocBandThicknessMmSet.has(b.thicknessMm)

      if (left > 0 && autoCut > 0 && maxStripsByNorm > 0) {
        out[b.thicknessMm] = String(Math.min(maxStripsByNorm, autoCut))
        continue
      }
      if (left <= 0 && adHocTh && secondaryAuto > 0) {
        out[b.thicknessMm] = String(secondaryAuto)
      }
    }

    const planTh = new Set(bandSortedForLog.map((b) => b.thicknessMm))
    for (const th of adHocBandThicknessMmSet) {
      if (planTh.has(th)) continue
      const sec = secondaryStripsOnMapByThickness.get(th) ?? 0
      if (sec <= 0) continue
      out[th] = String(sec)
    }

    return Object.keys(out).length > 0 ? out : null
  }, [
    selectedLog,
    selectedTask,
    bandSortedForLog,
    bandAutoCutByThickness,
    secondaryStripsOnMapByThickness,
    boardsPerStripByThickness,
    adHocBandThicknessMmSet,
  ])

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

  const resawRulerSteps = useMemo(() => {
    if (!selectedLog || !crossRows.length) return []
    return buildResawRulerSteps(crossRows, selectedLog.radius, effectiveKerfMm, resawFirstCutMm)
  }, [selectedLog, crossRows, effectiveKerfMm, resawFirstCutMm])

  const pitagoResawCutDefs = useMemo(
    () => listPitagoResawCuts(crossRows, effectiveKerfMm),
    [crossRows, effectiveKerfMm],
  )

  const activeBandRow = useMemo(() => {
    if (!bandSortedForLog.length) return null
    return (
      bandSortedForLog.find((b) => b.thicknessMm === displayThicknessMm) ?? bandSortedForLog[0]
    )
  }, [bandSortedForLog, displayThicknessMm])

  const changeSelectedLog = (id: number) => {
    setSelectedLogId(id)
  }

  const selectLogByScannedValue = useCallback(
    (raw: string) => {
      const text = String(raw ?? '').trim()
      const match = text.match(/\d+/)
      if (!match) {
        setScannerError('Скановано код без числового номера')
        return
      }
      const scanned = Number(match[0])
      if (!Number.isFinite(scanned) || scanned <= 0) {
        setScannerError('Некоректний код')
        return
      }
      const byLabel = logs.find((item) => Number(item.labelNumber) === scanned)
      const byId = logs.find((item) => Number(item.id) === scanned)
      const found = byLabel ?? byId ?? null
      if (!found) {
        setScannerError(`Колоду з кодом ${scanned} не знайдено на складі`)
        return
      }
      changeSelectedLog(found.id)
      setBandCutErr(false)
      setBandCutMsg(`Колоду вибрано за кодом: ${scanned}`)
      setScannerOpen(false)
      setScannerError(null)
    },
    [logs],
  )

  const stopScanner = useCallback(() => {
    if (scannerLoopIdRef.current != null) {
      window.cancelAnimationFrame(scannerLoopIdRef.current)
      scannerLoopIdRef.current = null
    }
    if (scannerStreamRef.current) {
      for (const track of scannerStreamRef.current.getTracks()) track.stop()
      scannerStreamRef.current = null
    }
    if (scannerVideoRef.current) {
      scannerVideoRef.current.pause()
      scannerVideoRef.current.srcObject = null
    }
    if (zxingControlsRef.current) {
      zxingControlsRef.current.stop()
      zxingControlsRef.current = null
    }
    zxingReaderRef.current = null
    setScannerBusy(false)
  }, [])

  const closeScanner = useCallback(() => {
    stopScanner()
    setScannerOpen(false)
    setScannerError(null)
  }, [stopScanner])

  const scanFrame = useCallback(() => {
    const detector = barcodeDetectorRef.current
    const video = scannerVideoRef.current
    if (!detector || !video || video.readyState < 2) {
      scannerLoopIdRef.current = window.requestAnimationFrame(scanFrame)
      return
    }
    void detector
      .detect(video)
      .then((codes) => {
        const rawValue = codes[0]?.rawValue?.trim()
        if (!rawValue) {
          scannerLoopIdRef.current = window.requestAnimationFrame(scanFrame)
          return
        }
        selectLogByScannedValue(rawValue)
      })
      .catch(() => {
        scannerLoopIdRef.current = window.requestAnimationFrame(scanFrame)
      })
  }, [selectLogByScannedValue])

  const openScanner = () => {
    const maybeCtor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructorLike })
      .BarcodeDetector
    barcodeDetectorRef.current = maybeCtor
      ? new maybeCtor({
          formats: ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code'],
        })
      : null
    setScannerOpen(true)
    setScannerError(null)
    setScannerBusy(true)
  }

  const onScanFilePick = () => {
    scannerFileInputRef.current?.click()
  }

  const onScanFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setScannerBusy(true)
    setScannerError(null)
    const imageUrl = URL.createObjectURL(file)
    void (async () => {
      try {
        const reader = zxingReaderRef.current ?? new BrowserMultiFormatReader()
        zxingReaderRef.current = reader
        const result = await reader.decodeFromImageUrl(imageUrl)
        selectLogByScannedValue(result.getText().trim())
      } catch (e) {
        setScannerError(e instanceof Error ? e.message : 'Не вдалося зчитати код з фото')
      } finally {
        URL.revokeObjectURL(imageUrl)
        setScannerBusy(false)
      }
    })()
  }

  useEffect(() => stopScanner, [stopScanner])

  useEffect(() => {
    if (!scannerOpen) return
    let cancelled = false
    const start = window.setTimeout(() => {
      void (async () => {
        try {
          const video = scannerVideoRef.current
          if (!video) throw new Error('Не вдалося ініціалізувати відео')
          const mediaDevices = navigator.mediaDevices
          if (!mediaDevices?.getUserMedia) {
            setScannerError(
              'Камера недоступна в цьому браузері/контексті. Використайте "Сканувати з фото" або HTTPS/localhost.',
            )
            return
          }
          if (barcodeDetectorRef.current) {
            const stream = await mediaDevices.getUserMedia({
              video: { facingMode: { ideal: 'environment' } },
              audio: false,
            })
            if (cancelled) {
              for (const track of stream.getTracks()) track.stop()
              return
            }
            scannerStreamRef.current = stream
            video.srcObject = stream
            await video.play()
            if (!cancelled) scanFrame()
          } else {
            const reader = new BrowserMultiFormatReader()
            zxingReaderRef.current = reader
            const controls = await reader.decodeFromConstraints(
              { video: { facingMode: { ideal: 'environment' } }, audio: false },
              video,
              (result) => {
                const rawValue = result?.getText().trim()
                if (!rawValue) return
                selectLogByScannedValue(rawValue)
              },
            )
            if (cancelled) {
              controls.stop()
              return
            }
            zxingControlsRef.current = controls
          }
        } catch (e) {
          stopScanner()
          setScannerError(e instanceof Error ? e.message : 'Не вдалося отримати доступ до камери')
        } finally {
          setScannerBusy(false)
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(start)
    }
  }, [scannerOpen, scanFrame, selectLogByScannedValue, stopScanner])

  return (
    <>
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
            Немає завдань з призначенням «стрічкова пила». Бригадир має зберегти завдання з галочкою
            розпиловщика.
          </p>
        )}

        {selectedTask && (
          <div className="bandTaskSummary panelHint">
            <strong>{selectedTask.title}</strong>
            {selectedTask.plan.alongLog &&
              (() => {
                const along = selectedTask.plan.alongLog
                const isNewAlong =
                  typeof (along as { lengthGroupsCount?: unknown }).lengthGroupsCount === 'number'
                return (
                  <span className="bandTaskAlong">
                    {' '}
                    · наріз по <strong>довжині</strong> — на циркулярці.
                    {isNewAlong ? (
                      <>
                        {' '}
                        Якщо L смуги ≈ {fmtCm(along.referenceLogLengthMm)}, з <strong>однієї</strong> смуги
                        виходить ≈ <strong>{along.piecesPerStripFromRefLog}</strong> дет. довжиною{' '}
                        {along.dominantLengthMm ? fmtCm(along.dominantLengthMm) : '—'}; орієнтовно смуг під
                        усю кількість: <strong>{along.stripsNeededForRefLog}</strong>
                        {along.lengthGroupsCount > 1
                          ? ' (кілька довжин у замовленні — пораховано окремо по кожній).'
                          : '.'}
                      </>
                    ) : (
                      <>
                        {' '}
                        Підказка «скільки деталей з однієї смуги» з’явиться після перезбереження завдання
                        бригадиром (у старих даних була лише сума довжин ≈{' '}
                        {fmtCm((along as { minLogLengthMm: number }).minLogLengthMm)} — це не кількість колод).
                      </>
                    )}
                  </span>
                )
              })()}
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
          <button type="button" className="btnSecondary" onClick={openScanner}>
            Сканувати QR/штрихкод
          </button>
        </div>

        {scannerOpen && (
          <div className="bandScannerBackdrop" role="presentation" onClick={closeScanner}>
            <div
              className="bandScannerModal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="bandScannerTitle"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bandScannerHeader">
                <h3 id="bandScannerTitle">Сканування коду колоди</h3>
                <button type="button" className="ghost" onClick={closeScanner}>
                  Закрити
                </button>
              </div>
              <p className="panelHint">Наведіть камеру на QR/штрихкод бірки або ID колоди.</p>
              <div className="bandScannerActions">
                <button type="button" className="btnSecondary" onClick={onScanFilePick} disabled={scannerBusy}>
                  Сканувати з фото
                </button>
                <input
                  ref={scannerFileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={onScanFileChange}
                  className="bandScannerFileInput"
                />
              </div>
              {scannerError && <p className="birkaMsgErr">{scannerError}</p>}
              <div className="bandScannerVideoWrap">
                <video ref={scannerVideoRef} className="bandScannerVideo" playsInline muted />
                {scannerBusy && <div className="bandScannerOverlay">Підключення до камери…</div>}
              </div>
            </div>
          </div>
        )}

        {selectedTask && bandSortedForLog.length > 0 && (
          <>
            {bandCompletedCount > 0 && (
              <div className="bandTableActionsOnly">
                <button
                  type="button"
                  className="ghost bandHideDoneBtn"
                  onClick={() => setHideCompletedBandRows((v) => !v)}
                >
                  {hideCompletedBandRows
                    ? `Показати виконані (${bandCompletedCount})`
                    : 'Сховати виконані'}
                </button>
              </div>
            )}
            <div className="bandAllThTableWrap">
              <table className="bandAllThTable">
                <thead>
                  <tr>
                    <th data-short="Товщ.">Товщина</th>
                    <th data-short="Потр.">Потрібно</th>
                    <th data-short="Зроб.">Зроблено</th>
                    <th data-short="Зал.">Залишиться</th>
                    <th data-short="Стат.">Статус</th>
                    <th
                      data-short="Спис."
                      title="Кількість знятих смуг по товщині; з кожної смуги ≈ N дощок по довжині колоди (див. норму)"
                    >
                      Ручне списання
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bandUnifiedTableRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="bandTableEmptyRow">
                        Усі позиції за нормою виконані і немає побічних товщин з форми бригадира — натисніть «Показати
                        виконані», щоб знову побачити рядки основного плану, або переходьте до закриття на багатопилі.
                      </td>
                    </tr>
                  ) : null}
                  {bandUnifiedTableRows.map((row) => {
                    if (row.kind === 'adhoc') {
                      const th = row.thicknessMm
                      const perStrip = Math.max(1, boardsPerStripByThickness.get(th) ?? 1)
                      const stripsOnMap = secondaryStripsOnMapByThickness.get(th) ?? 0
                      const needBoards = stripsOnMap * perStrip
                      const done = bandBoardsDoneFromStripInventoryByThickness.get(th) ?? 0
                      const left = Math.max(0, needBoards - done)
                      const draftRaw = Number(bandCutDraft[th])
                      const draftStrips =
                        Number.isFinite(draftRaw) && draftRaw > 0 ? Math.round(draftRaw) : 0
                      const previewBoards =
                        draftStrips > 0 ? Math.min(left, draftStrips * perStrip) : 0
                      const previewLeft = Math.max(0, left - previewBoards)
                      const effectiveLeft = draftStrips > 0 ? previewLeft : left
                      const maxStripsInput = Math.max(stripsOnMap, 500)
                      return (
                        <tr key={`adhoc-${th}`} className="bandRowAdhoc">
                          <td>
                            <strong>{fmtCm(th)}</strong>
                            <span
                              className="bandRowAdhocBadge"
                              title="Товщина з побічного рядка форми (з кількістю або без — лише розмір)"
                            >
                              {' '}
                              побічний
                            </span>
                          </td>
                          <td>
                            <strong>{needBoards}</strong>
                            {stripsOnMap > 0 ? (
                              <span className="bandStripsOnMapHint" title="Смуг на карті розкрою">
                                {' '}
                                ({stripsOnMap} смуг)
                              </span>
                            ) : null}
                          </td>
                          <td>
                            <strong>{done}</strong>
                          </td>
                          <td>{effectiveLeft}</td>
                          <td>
                            {needBoards > 0 && draftStrips > 0 && effectiveLeft === 0 ? (
                              <div className="bandDoneStatus">
                                <span className="bandStatusDone">Буде передано</span>
                                <span className="bandDoneForCloseHint">
                                  після натискання «Передати на багатопил»
                                </span>
                              </div>
                            ) : needBoards > 0 && left === 0 ? (
                              <div className="bandDoneStatus">
                                <span className="bandStatusDone">З норми карти</span>
                                <span className="bandDoneForCloseHint">
                                  смуги передані на багатопил (за обліком дощок)
                                </span>
                              </div>
                            ) : (
                              <span className="bandStatusSecondary">
                                Побічний
                                {stripsOnMap > 0 ? (
                                  <span className="bandStatusSecondarySub"> · на карті {stripsOnMap} смуг</span>
                                ) : null}
                              </span>
                            )}
                          </td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              max={maxStripsInput}
                              className="bandCutQtyInput"
                              value={bandCutDraft[th] ?? ''}
                              onChange={(e) =>
                                setBandCutDraft((prev) => ({
                                  ...prev,
                                  [th]: e.target.value,
                                }))
                              }
                              placeholder="0"
                              title={`Вже знято ≈ ${done} дощ. (облік смуг). З карти: ${stripsOnMap} смуг (~ ${needBoards} дощ. при ${perStrip} шт./смуга). Редагуйте за фактом. Макс. за раз: ${maxStripsInput}.`}
                            />
                          </td>
                        </tr>
                      )
                    }

                    const b = row.b
                    const ok = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
                    const rDisp = selectedLog?.radius ?? selectedTask.radiusMm
                    const done = b.qtyDone ?? 0
                    const left = bandRemainingQty(b)
                    const rowCompleteActual = left === 0
                    const isAdHocThickness = adHocBandThicknessMmSet.has(b.thicknessMm)
                    const stripsSecondaryOnMap =
                      secondaryStripsOnMapByThickness.get(b.thicknessMm) ?? 0
                    const allowManualStrips = (ok && left > 0) || isAdHocThickness
                    const perStrip = Math.max(1, boardsPerStripByThickness.get(b.thicknessMm) ?? 1)
                    const maxStripsForNorm = left > 0 && ok ? Math.max(1, Math.ceil(left / perStrip)) : 0
                    const maxStripsInput = isAdHocThickness
                      ? Math.max(maxStripsForNorm, stripsSecondaryOnMap, 500)
                      : Math.max(maxStripsForNorm, 1)
                    const draftRaw = Number(bandCutDraft[b.thicknessMm])
                    const draftBoards =
                      Number.isFinite(draftRaw) && draftRaw > 0 ? Math.round(draftRaw) : 0
                    const previewBoards =
                      draftBoards > 0 ? Math.min(left, draftBoards * perStrip) : 0
                    const previewLeft = Math.max(0, left - previewBoards)
                    const effectiveLeft = draftBoards > 0 ? previewLeft : left
                    const inputTitle = isAdHocThickness
                      ? `Залишилось дощок (норма): ${left}. З карти: +${stripsSecondaryOnMap} побічних смуг. 1 смуга ≈ ${perStrip} шт. Понад норму / при закритому плані — на склад. Макс. смуг: ${maxStripsInput}.`
                      : `Залишилось дощок (норма): ${left}. 1 смуга ≈ ${perStrip} шт. по довжині; макс. смуг за раз: ${maxStripsInput}.`
                    return (
                      <tr key={b.thicknessMm} className={rowCompleteActual ? 'bandRowComplete' : undefined}>
                        <td>
                          <strong>{fmtCm(b.thicknessMm)}</strong>
                          {isAdHocThickness ? (
                            <span
                              className="bandRowAdhocBadge"
                              title="Є відповідний побічний розмір у формі бригадира"
                            >
                              {' '}
                              побічний
                            </span>
                          ) : null}
                          {rowCompleteActual ? (
                            <span className="bandRowCompleteBadge" title="Норма зібрана">
                              {' '}
                              ✓
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <strong>{b.qtyNeeded}</strong>
                          {stripsSecondaryOnMap > 0 ? (
                            <span className="bandStripsOnMapHint" title="Побічних смуг на карті (додатково до основного плану)">
                              {' '}
                              (+{stripsSecondaryOnMap} поб. смуг)
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <strong>{done}</strong>
                        </td>
                        <td>{effectiveLeft}</td>
                        <td>
                          {left === 0 ? (
                            <div className="bandDoneStatus">
                              <span className="bandStatusDone">Виконано</span>
                              <span className="bandDoneForCloseHint">
                                дошки готові — закрийте позицію на багатопилі
                                {isAdHocThickness
                                  ? ' Побічні смуги з колоди можна внести в «Ручне списання» і передати на склад.'
                                  : ''}
                              </span>
                            </div>
                          ) : draftBoards > 0 && previewLeft === 0 ? (
                            <div className="bandDoneStatus">
                              <span className="bandStatusDone">Буде виконано</span>
                              <span className="bandDoneForCloseHint">
                                після натискання «Передати на багатопил»
                              </span>
                            </div>
                          ) : ok ? (
                            <span className="bandStatusPrimary">Основний</span>
                          ) : (
                            <span className="bandStatusBad">
                              не вміщається при R={fmtCm(rDisp)} (макс. ~{' '}
                              {maxThHintMm != null ? fmtCm(maxThHintMm) : '—'})
                            </span>
                          )}
                        </td>
                        <td>
                          {allowManualStrips ? (
                            <input
                              type="number"
                              min={0}
                              step={1}
                              max={maxStripsInput}
                              className="bandCutQtyInput"
                              value={bandCutDraft[b.thicknessMm] ?? ''}
                              onChange={(e) =>
                                setBandCutDraft((prev) => ({
                                  ...prev,
                                  [b.thicknessMm]: e.target.value,
                                }))
                              }
                              placeholder="0"
                              title={inputTitle}
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
                    const cuts: { thicknessMm: number; doneQty: number }[] = []
                    for (const urow of bandUnifiedTableRows) {
                      if (urow.kind === 'adhoc') {
                        const raw = Number(bandCutDraft[urow.thicknessMm])
                        if (!Number.isFinite(raw) || raw <= 0) continue
                        const doneQty = Math.round(raw)
                        if (doneQty <= 0) continue
                        cuts.push({ thicknessMm: urow.thicknessMm, doneQty })
                        continue
                      }
                      const b = urow.b
                      const left = bandRemainingQty(b)
                      const rowOk = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
                      if (!adHocBandThicknessMmSet.has(b.thicknessMm) && (!rowOk || left <= 0)) continue
                      const raw = Number(bandCutDraft[b.thicknessMm])
                      if (!Number.isFinite(raw) || raw <= 0) continue
                      const doneQty = Math.round(raw)
                      if (doneQty <= 0) continue
                      cuts.push({ thicknessMm: b.thicknessMm, doneQty })
                    }
                    if (cuts.length === 0) {
                      setBandCutErr(true)
                      setBandCutMsg('Додайте хоча б одну позицію з кількістю більше нуля.')
                      return
                    }
                    setBandCutBusy(true)
                    try {
                      const updated = await recordBandCut(selectedTask.id, {
                        cuts,
                        logLengthMm: selectedLog.length,
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
                            ? 'Записано. Усі позиції стрічкової пили за завданням закриті — можна передати в роботу далі.'
                            : 'Записано. Кількість зроблених дощок оновлена.',
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
                      <span>Передати на багатопил</span>
                      <span className="bandCutBtnSub">(колода розпущена)</span>
                    </span>
                  )}
                </button>
              </div>
            )}
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
            <div className="bandCrossAndRuler">
            <div className="crossWrap">
              <svg viewBox="-82 -28 364 292" className="crossSvg crossSvgPitago" role="img">
                <title>
                  Карта розкрою колоди R={selectedLog.radius} мм, L={selectedLog.length} мм
                </title>
                <defs>
                  <clipPath id="bandCrossClip">
                    <circle cx="120" cy="120" r={SVG_LOG_RADIUS} />
                  </clipPath>
                </defs>
                <text x={120} y={-16} className="crossPitagoHeader">
                  AVK BAND CUT MAP
                </text>
                <text x={120} y={-5} className="crossPitagoSubheader">
                  R={selectedLog.radius} мм · L={selectedLog.length} мм · kerf={effectiveKerfMm} мм
                </text>
                <line x1={-18} y1={1} x2={-18} y2={239} className="crossPitagoRulerLine" />
                {Array.from({ length: 11 }, (_, i) => {
                  const y = 1 + i * 23.8
                  const labelMm = Math.round(((10 - i) / 10) * selectedLog.radius * 2)
                  return (
                    <g key={`ruler-${i}`}>
                      <line x1={-30} x2={-18} y1={y} y2={y} className="crossPitagoRulerTick" />
                      <text x={-34} y={y + 3} className="crossPitagoRulerText">
                        {labelMm}
                      </text>
                    </g>
                  )
                })}
                <circle cx="120" cy="120" r={SVG_LOG_RADIUS} className="crossCircle" />
                <g clipPath="url(#bandCrossClip)">
                  {crossRows.map((row, idx) => {
                    const logR = selectedLog.radius
                    const scale = SVG_LOG_RADIUS / logR
                    const scaledY = (row.y / logR) * SVG_LOG_RADIUS
                    const boardWSvg = row.chord * scale
                    const boardHSvg = row.thicknessMm * scale
                    const kerfWSvg = effectiveKerfMm * scale
                    const x = 120 - boardWSvg / 2
                    const y = 120 + scaledY - boardHSvg / 2
                    const boardCanShowText = boardWSvg > 14 && boardHSvg > 28
                    const next = crossRows[idx + 1]
                    const kerfCenterMm = next
                      ? row.y + row.thicknessMm / 2 + effectiveKerfMm / 2
                      : null
                    const kerfY = kerfCenterMm == null ? null : 120 + kerfCenterMm * scale
                    const isSecondary = row.stripKind === 'secondary'

                    return (
                      <g key={`board-col-${idx}`} className="crossBoardCutGroup">
                        <rect
                          x={x}
                          y={y}
                          width={boardWSvg}
                          height={boardHSvg}
                          className={`crossBoardPiece crossBoardPiecePitago ${isSecondary ? 'crossBoardPieceSecondary' : 'crossBoardPiecePrimary'}`}
                        >
                          <title>
                            {isSecondary
                              ? `Побічний орієнтир ${idx + 1}: ${Math.round(row.chord)} × ${row.thicknessMm} мм. У плані стрічкової пилки без фіксованої кількості.`
                              : `Дошка ${idx + 1}: ${Math.round(row.chord)} × ${row.thicknessMm} мм. Основна дошка.`}
                          </title>
                        </rect>
                        <line
                          x1={x + 2}
                          x2={x + boardWSvg - 2}
                          y1={y + boardHSvg * 0.28}
                          y2={y + boardHSvg * 0.28}
                          className="crossBoardInnerLine"
                        />
                        <line
                          x1={x + 2}
                          x2={x + boardWSvg - 2}
                          y1={y + boardHSvg * 0.72}
                          y2={y + boardHSvg * 0.72}
                          className="crossBoardInnerLine"
                        />
                        {boardCanShowText && (
                          <text
                            x={120}
                            y={120 + scaledY + 1.5}
                            className="crossBoardPieceLabel crossBoardPieceLabelVertical"
                          >
                            {Math.round(row.chord)}×{row.thicknessMm}
                          </text>
                        )}
                        <text
                          x={Math.max(8, x - 6)}
                          y={120 + scaledY + 2}
                          className="crossPitagoMainNo"
                        >
                          {idx + 1}
                        </text>
                        {kerfY != null && (
                          <>
                            <rect
                              x={4}
                              y={kerfY - kerfWSvg / 2}
                              width={232}
                              height={kerfWSvg}
                              className="crossKerfSlice"
                            />
                            <line
                              x1={2}
                              x2={238}
                              y1={kerfY}
                              y2={kerfY}
                              className="crossPitagoSawLine"
                            />
                          </>
                        )}
                      </g>
                    )
                  })}
                </g>
                {pitagoResawCutDefs.map((def, idx) => {
                  const cutYSvg = 120 + (def.cutYmm / selectedLog.radius) * SVG_LOG_RADIUS
                  const heightFromBottom = pitagoCutHeightFromBottomMm(def.cutYmm, selectedLog.radius)
                  const title =
                    def.edge === 'top'
                      ? `Верхній різ (над штабелем), поруч смуга ${def.thicknessMm} мм: від низу ${fmtMmOneDecimal(heightFromBottom)} мм`
                      : def.edge === 'bottom'
                        ? `Нижній різ (під штабелем), поруч смуга ${def.thicknessMm} мм: від низу ${fmtMmOneDecimal(heightFromBottom)} мм`
                        : `Різ між ${def.betweenLowerMm ?? ''} мм і ${def.betweenUpperMm ?? ''} мм: від низу ${fmtMmOneDecimal(heightFromBottom)} мм`
                  return (
                    <g key={`cut-height-${idx}-${def.edge ?? 'mid'}`}>
                      <line
                        x1={-46}
                        x2={-18}
                        y1={cutYSvg}
                        y2={cutYSvg}
                        className="crossPitagoCutHeightTick"
                      />
                      <text x={-50} y={cutYSvg + 2.5} className="crossPitagoCutHeightText">
                        {fmtMmOneDecimal(heightFromBottom)}
                      </text>
                      <title>{title}</title>
                    </g>
                  )
                })}
                <circle cx="120" cy="120" r={SVG_LOG_RADIUS} className="crossCircleOutline" />
                <text x={120} y={262} className="crossPitagoFooter">
                  Кожна колода різна. Перевіряйте фактичний діаметр перед першим різом.
                </text>
              </svg>
            </div>
            <aside className="bandResawRuler">
              <h4 className="bandResawRulerTitle">Лінійка розпилу (торець)</h4>
              <label className="bandResawRulerField">
                Показання 1-го (зовнішнього) різу (мм)
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  placeholder="лише геометрія"
                  value={resawFirstCutMm}
                  onChange={(e) => setResawFirstCutMm(e.target.value)}
                  title="Фактичне показання на зовнішньому різі, мм (0,1); решта лінійно між мін. і макс. геометрією; глибокий різ без примусу 0"
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
                        <tr key={`${s.cutIndex}-${s.edge ?? 'between'}`}>
                          <td>{s.cutIndex}</td>
                          <td>
                            {fmtCm(s.thicknessMm)}
                            {s.edge === 'top' ? (
                              <span className="bandResawRulerThEdge" title="Різ над першою смугою (до кори)">
                                {' '}
                                верх
                              </span>
                            ) : s.edge === 'bottom' ? (
                              <span className="bandResawRulerThEdge" title="Різ під останньою смугою">
                                {' '}
                                низ
                              </span>
                            ) : null}
                            {s.stripKind === 'secondary' ? (
                              <span className="bandResawRulerThSecondary" title="Побічна смуга з форми">
                                {' '}
                                поб.
                              </span>
                            ) : null}
                          </td>
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

    </>
  )
}
