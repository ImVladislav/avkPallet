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
  maxThicknessFeasibleForRadius,
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
  orderPieceLengthsForThicknessMm,
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
    if (row) rows.push(row)
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
  const [bandCalcOpen, setBandCalcOpen] = useState(false)
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

  const crossRows = useMemo(() => {
    if (!selectedLog || !stackThicknessesMm.length) return []
    return buildPitagoBandCrossSection(
      selectedLog.radius,
      stackThicknessesMm,
      effectiveKerfMm,
      bandCrossFit,
    )
  }, [selectedLog, stackThicknessesMm, effectiveKerfMm, bandCrossFit])

  const bandAutoCutByThickness = useMemo(() => {
    const m = new Map<number, number>()
    for (const row of crossRows) {
      m.set(row.thicknessMm, (m.get(row.thicknessMm) ?? 0) + 1)
    }
    return m
  }, [crossRows])

  const suggestedBandCutDraft = useMemo(() => {
    if (!selectedLog || !selectedTask || bandSortedForLog.length === 0) return null
    const out: Record<number, string> = {}
    for (const b of bandSortedForLog) {
      const left = bandRemainingQty(b)
      const autoCut = bandAutoCutByThickness.get(b.thicknessMm) ?? 0
      const per = Math.max(1, boardsPerStripByThickness.get(b.thicknessMm) ?? 1)
      const maxStripsByNorm = left > 0 ? Math.max(1, Math.ceil(left / per)) : 0
      if (left <= 0 || autoCut <= 0 || maxStripsByNorm <= 0) continue
      out[b.thicknessMm] = String(Math.min(maxStripsByNorm, autoCut))
    }
    return Object.keys(out).length > 0 ? out : null
  }, [
    selectedLog,
    selectedTask,
    bandSortedForLog,
    bandAutoCutByThickness,
    boardsPerStripByThickness,
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
    return buildResawRulerSteps(crossRows, selectedLog.radius, resawFirstCutMm)
  }, [selectedLog, crossRows, resawFirstCutMm])

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
            {(selectedLog || bandCompletedCount > 0) && (
              <div className="bandTableActionsOnly">
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
                  >
                    {hideCompletedBandRows
                      ? `Показати виконані (${bandCompletedCount})`
                      : 'Сховати виконані'}
                  </button>
                )}
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
                  {bandTableRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="bandTableEmptyRow">
                        Усі позиції за цим завданням уже виконані за нормою стрічкової пили — натисніть «Показати
                        виконані», щоб знову побачити рядки, або переходьте до закриття на багатопилі.
                      </td>
                    </tr>
                  ) : null}
                  {bandTableRows.map((b) => {
                    const ok = b.feasible !== false && (b.boardsFromOneCrossSection ?? 0) > 0
                    const rDisp = selectedLog?.radius ?? selectedTask.radiusMm
                    const done = b.qtyDone ?? 0
                    const left = bandRemainingQty(b)
                    const rowCompleteActual = left === 0
                    const perStrip = Math.max(1, boardsPerStripByThickness.get(b.thicknessMm) ?? 1)
                    const maxStripsForLeft = left > 0 ? Math.max(1, Math.ceil(left / perStrip)) : 0
                    const draftRaw = Number(bandCutDraft[b.thicknessMm])
                    const draftBoards =
                      Number.isFinite(draftRaw) && draftRaw > 0 ? Math.round(draftRaw) : 0
                    const previewBoards =
                      draftBoards > 0 ? Math.min(left, draftBoards * perStrip) : 0
                    const previewLeft = Math.max(0, left - previewBoards)
                    const effectiveLeft = draftBoards > 0 ? previewLeft : left
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
                          <strong>{b.qtyNeeded}</strong>
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
                          {ok && left > 0 ? (
                            <input
                              type="number"
                              min={0}
                              step={1}
                              max={Math.max(1, maxStripsForLeft)}
                              className="bandCutQtyInput"
                              value={bandCutDraft[b.thicknessMm] ?? ''}
                              onChange={(e) =>
                                setBandCutDraft((prev) => ({
                                  ...prev,
                                  [b.thicknessMm]: e.target.value,
                                }))
                              }
                              placeholder="0"
                              title={`Залишилось дощок (норма): ${left}. 1 смуга ≈ ${perStrip} шт. по довжині; макс. смуг за раз: ${maxStripsForLeft}.`}
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
                        const doneQty = Math.round(raw)
                        if (doneQty <= 0) return null
                        return { thicknessMm: b.thicknessMm, doneQty }
                      })
                      .filter((x): x is { thicknessMm: number; doneQty: number } => x != null)
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

                    return (
                      <g key={`board-col-${idx}`} className="crossBoardCutGroup">
                        <rect
                          x={x}
                          y={y}
                          width={boardWSvg}
                          height={boardHSvg}
                          className="crossBoardPiece crossBoardPiecePrimary crossBoardPiecePitago"
                        >
                          <title>
                            Дошка {idx + 1}: {Math.round(row.chord)} × {row.thicknessMm} мм.
                            {' '}Основна дошка.
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
                {crossRows.slice(0, -1).map((row, idx) => {
                  const next = crossRows[idx + 1]
                  const cutYmm = row.y + row.thicknessMm / 2 + effectiveKerfMm / 2
                  const cutYSvg = 120 + (cutYmm / selectedLog.radius) * SVG_LOG_RADIUS
                  const heightFromBottom = Math.max(0, selectedLog.radius - cutYmm)
                  return (
                    <g key={`cut-height-${idx}`}>
                      <line x1={-46} x2={-18} y1={cutYSvg} y2={cutYSvg} className="crossPitagoCutHeightTick" />
                      <text x={-50} y={cutYSvg + 2.5} className="crossPitagoCutHeightText">
                        {fmtMmOneDecimal(heightFromBottom)}
                      </text>
                      <title>
                        Різ між {row.thicknessMm} мм і {next?.thicknessMm ?? ''} мм: висота від низу {fmtMmOneDecimal(heightFromBottom)} мм
                      </title>
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
