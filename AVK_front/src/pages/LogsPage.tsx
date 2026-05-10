import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import {
  deleteBrusStockItem,
  deleteRoundwoodStockItem,
  fetchRoundwoodState,
  fetchLabelByNumber,
  receiveBrusStock,
  receiveRoundwoodLog,
  receiveRoundwoodLogByLabel,
} from '../api'
import { useAuth } from '../context/AuthContext'
import { useRoundwoodReload } from '../hooks/useRoundwoodReload'
import {
  clearLegacyLocalLogs,
  readLegacyLocalLogs,
  sortLogsLargeFirst,
  type LogItem,
} from '../helpers/logsStorage'
import {
  formatLengthInput,
  readDefaultLengthMm,
  parseDisplayValueToMm,
  writeDefaultLengthMm,
} from '../helpers/lengthUnits'
import type { BrusStockItem } from '../types/roundwood'
import './LogsPage.css'

const DEFAULT_RADIUS_MM = 180
const INPUT_RADIUS_UNIT = 'cm' as const
const INPUT_LENGTH_UNIT = 'm' as const
/** Після прийому можна скасувати запис на сервері (мс), перевірка й на бекенді. */
const RECEIVE_CANCEL_WINDOW_MS = 5 * 60 * 1000

type LabelSuccessInfo = {
  labelNumber: number
  diameter: number
  length: number
  radiusMm: number
  lengthMm: number
  /** Об'єм з бірки (м³), поле API «Объем». */
  volumeM3?: number
}

type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>
}

type BarcodeDetectorConstructorLike = new (options?: {
  formats?: string[]
}) => BarcodeDetectorLike

function msUntilCancelDeadline(createdAt: string, nowMs: number): number {
  const start = new Date(createdAt).getTime()
  if (!Number.isFinite(start)) return 0
  return Math.max(0, start + RECEIVE_CANCEL_WINDOW_MS - nowMs)
}

export function LogsPage() {
  const { user } = useAuth()
  const [woodTab, setWoodTab] = useState<'roundwood' | 'brus'>('roundwood')
  const [logs, setLogs] = useState<LogItem[]>([])
  const [brusStock, setBrusStock] = useState<BrusStockItem[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [radiusInput, setRadiusInput] = useState(() => formatLengthInput(DEFAULT_RADIUS_MM, INPUT_RADIUS_UNIT))
  const [lengthInput, setLengthInput] = useState(() => formatLengthInput(readDefaultLengthMm(), INPUT_LENGTH_UNIT))
  const [brusSideAInput, setBrusSideAInput] = useState('10')
  const [brusSideBInput, setBrusSideBInput] = useState('10')
  const [brusLengthInput, setBrusLengthInput] = useState(() => formatLengthInput(readDefaultLengthMm(), INPUT_LENGTH_UNIT))
  const [brusQtyInput, setBrusQtyInput] = useState('1')
  const [labelNumberInput, setLabelNumberInput] = useState('')
  const [labelSuccessInfo, setLabelSuccessInfo] = useState<LabelSuccessInfo | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerBusy, setScannerBusy] = useState(false)
  const [scannerError, setScannerError] = useState<string | null>(null)
  const seq = useRef(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deletingBrusId, setDeletingBrusId] = useState<number | null>(null)
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null)
  const scannerFileInputRef = useRef<HTMLInputElement | null>(null)
  const scannerStreamRef = useRef<MediaStream | null>(null)
  const scannerLoopIdRef = useRef<number | null>(null)
  const barcodeDetectorRef = useRef<BarcodeDetectorLike | null>(null)
  const zxingReaderRef = useRef<BrowserMultiFormatReader | null>(null)
  const zxingControlsRef = useRef<IScannerControls | null>(null)

  const canEditStock =
    user?.role === 'sawyer' ||
    user?.role === 'foreman' ||
    user?.role === 'admin' ||
    user?.role === 'super_admin'
  const canManualReceive = user?.role === 'super_admin'
  const legacy = readLegacyLocalLogs()

  const reload = useCallback(() => {
    const n = ++seq.current
    void (async () => {
      try {
        const { stock, brusStock: nextBrus } = await fetchRoundwoodState()
        if (seq.current !== n) return
        setLogs(stock)
        setBrusStock(nextBrus)
        setLoadErr(null)
      } catch (e) {
        if (seq.current !== n) return
        setLogs([])
        setBrusStock([])
        const raw = e instanceof Error ? e.message : String(e)
        const net =
          /failed to fetch|networkerror|load failed|network request failed/i.test(raw)
        setLoadErr(
          net
            ? 'Немає зв’язку з сервером. Запустіть бекенд (з кореня проєкту: npm run dev:server або npm run dev:all, порт 3001), потім оновіть сторінку.'
            : raw || 'Не вдалося завантажити базу кругляка',
        )
      }
    })()
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 5000)
    return () => window.clearInterval(t)
  }, [])

  useRoundwoodReload(reload)

  const sortedLogs = useMemo(() => sortLogsLargeFirst(logs), [logs])
  const recentLogs = useMemo(() => {
    const threshold = nowTick - RECEIVE_CANCEL_WINDOW_MS
    return sortedLogs.filter((item) => {
      const createdMs = new Date(item.createdAt).getTime()
      return Number.isFinite(createdMs) && createdMs >= threshold
    })
  }, [nowTick, sortedLogs])

  const recentBrus = useMemo(() => {
    const threshold = nowTick - RECEIVE_CANCEL_WINDOW_MS
    return [...brusStock]
      .filter((item) => {
        const createdMs = new Date(item.createdAt).getTime()
        return Number.isFinite(createdMs) && createdMs >= threshold
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [nowTick, brusStock])

  const addLog = () => {
    if (!canManualReceive) {
      setMsg('Ручний прийом кругляка доступний лише супер адміну.')
      return
    }
    const r = parseDisplayValueToMm(radiusInput, INPUT_RADIUS_UNIT)
    const l = parseDisplayValueToMm(lengthInput, INPUT_LENGTH_UNIT)
    if (r == null || l == null) return
    writeDefaultLengthMm(l)
    setBusy(true)
    setMsg(null)
    void (async () => {
      try {
        await receiveRoundwoodLog({
          radiusMm: r,
          lengthMm: l,
          id: Date.now(),
        })
        await reload()
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка запису')
      } finally {
        setBusy(false)
      }
    })()
  }

  const addBrus = () => {
    const sideA = parseDisplayValueToMm(brusSideAInput, 'cm')
    const sideB = parseDisplayValueToMm(brusSideBInput, 'cm')
    const len = parseDisplayValueToMm(brusLengthInput, INPUT_LENGTH_UNIT)
    const qtyRaw = Number(String(brusQtyInput).replace(',', '.'))
    const qty = Math.round(qtyRaw)
    if (sideA == null || sideB == null || len == null) {
      setMsg('Вкажіть сторону 1, сторону 2 та довжину.')
      return
    }
    if (!Number.isFinite(qtyRaw) || qty <= 0 || Math.abs(qtyRaw - qty) > 1e-6) {
      setMsg('Кількість бруса має бути цілим числом > 0.')
      return
    }
    writeDefaultLengthMm(len)
    setBusy(true)
    setMsg(null)
    void (async () => {
      try {
        await receiveBrusStock({
          sideAMm: sideA,
          sideBMm: sideB,
          lengthMm: len,
          qty,
          id: Date.now(),
        })
        await reload()
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка запису бруса')
      } finally {
        setBusy(false)
      }
    })()
  }

  const addLogByLabelValue = useCallback(
    (rawLabelNumber: string) => {
      const labelNumber = Math.round(Number(rawLabelNumber.trim()))
      if (!Number.isFinite(labelNumber) || labelNumber <= 0) {
        setMsg('Вкажіть коректний номер бірки')
        return
      }
      setBusy(true)
      setMsg(null)
      setLabelSuccessInfo(null)
      void (async () => {
        try {
          const src = await fetchLabelByNumber(labelNumber)
          const diameter = Number(src['Диаметр'])
          const length = Number(src['Длина'])
          const volumeRaw = src['Объем']
          const volumeM3 = volumeRaw != null ? Number(volumeRaw) : NaN
          const volumeOk = Number.isFinite(volumeM3) && volumeM3 >= 0
          if (
            !Number.isFinite(diameter) ||
            diameter <= 0 ||
            !Number.isFinite(length) ||
            length <= 0
          ) {
            throw new Error('У відповіді бірки немає коректних Диаметр/Длина')
          }
          const radiusMm = Math.round(diameter * 10)
          const lengthMm = Math.round(length * 1000)
          await receiveRoundwoodLogByLabel({ labelNumber, id: Date.now() })
          await reload()
          setLabelSuccessInfo({
            labelNumber,
            diameter,
            length,
            radiusMm,
            lengthMm,
            ...(volumeOk ? { volumeM3 } : {}),
          })
        } catch (e) {
          setMsg(e instanceof Error ? e.message : 'Помилка запису за біркою')
        } finally {
          setBusy(false)
        }
      })()
    },
    [reload],
  )

  const addLogByLabel = () => {
    addLogByLabelValue(labelNumberInput)
  }

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
    if (zxingReaderRef.current) {
      zxingReaderRef.current = null
    }
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
        const match = rawValue.match(/\d+/)
        if (!match) {
          setScannerError('Скановано код без числового номера бірки')
          scannerLoopIdRef.current = window.requestAnimationFrame(scanFrame)
          return
        }
        const scannedNumber = match[0]
        setLabelNumberInput(scannedNumber)
        closeScanner()
        addLogByLabelValue(scannedNumber)
      })
      .catch(() => {
        scannerLoopIdRef.current = window.requestAnimationFrame(scanFrame)
      })
  }, [addLogByLabelValue, closeScanner])

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
        const rawValue = result.getText().trim()
        const match = rawValue.match(/\d+/)
        if (!match) throw new Error('Скановано код без числового номера бірки')
        const scannedNumber = match[0]
        setLabelNumberInput(scannedNumber)
        closeScanner()
        addLogByLabelValue(scannedNumber)
      } catch (e) {
        setScannerError(e instanceof Error ? e.message : 'Не вдалося зчитати штрихкод з фото')
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
              'Камера недоступна в цьому браузері/контексті. Використайте кнопку "Сканувати з фото" або відкрийте сайт через HTTPS/localhost.',
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
              {
                video: { facingMode: { ideal: 'environment' } },
                audio: false,
              },
              video,
              (result) => {
                const rawValue = result?.getText().trim()
                if (!rawValue) return
                const match = rawValue.match(/\d+/)
                if (!match) {
                  setScannerError('Скановано код без числового номера бірки')
                  return
                }
                const scannedNumber = match[0]
                setLabelNumberInput(scannedNumber)
                closeScanner()
                addLogByLabelValue(scannedNumber)
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
          setScannerError(
            e instanceof Error ? e.message : 'Не вдалося отримати доступ до камери пристрою',
          )
        } finally {
          setScannerBusy(false)
        }
      })()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(start)
    }
  }, [addLogByLabelValue, closeScanner, scanFrame, scannerOpen, stopScanner])

  const onLengthBlur = () => {
    const mm = parseDisplayValueToMm(lengthInput, INPUT_LENGTH_UNIT)
    if (mm != null) {
      writeDefaultLengthMm(mm)
      setLengthInput(formatLengthInput(mm, INPUT_LENGTH_UNIT))
    }
  }

  const onRadiusBlur = () => {
    const mm = parseDisplayValueToMm(radiusInput, INPUT_RADIUS_UNIT)
    if (mm != null) {
      setRadiusInput(formatLengthInput(mm, INPUT_RADIUS_UNIT))
    }
  }

  const removeRowFromServer = (id: number) => {
    setMsg(null)
    setDeletingId(id)
    void (async () => {
      try {
        await deleteRoundwoodStockItem(id)
        await reload()
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка видалення')
      } finally {
        setDeletingId(null)
      }
    })()
  }

  const removeBrusRowFromServer = (id: number) => {
    setMsg(null)
    setDeletingBrusId(id)
    void (async () => {
      try {
        await deleteBrusStockItem(id)
        await reload()
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка видалення')
      } finally {
        setDeletingBrusId(null)
      }
    })()
  }

  const importLegacy = () => {
    if (legacy.length === 0) return
    setBusy(true)
    setMsg(null)
    void (async () => {
      try {
        for (const item of legacy) {
          await receiveRoundwoodLog({
            radiusMm: item.radius,
            lengthMm: item.length,
            id: item.id,
          })
        }
        await reload()
        clearLegacyLocalLogs()
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка перенесення')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section className="panel">
      {loadErr && <p className="birkaMsgErr">{loadErr}</p>}
      {msg && <p className="panelHint">{msg}</p>}
      {canManualReceive && legacy.length > 0 && (
        <p className="logsLegacy panelHint">
          Локально: {legacy.length} шт.{' '}
          <button type="button" className="btnSecondary" disabled={busy} onClick={importLegacy}>
            На сервер
          </button>
        </p>
      )}
      <div className="logsFormCard">
        <div className="logsWoodTabs" role="tablist" aria-label="Тип деревини">
          <button
            type="button"
            className={woodTab === 'roundwood' ? 'active' : ''}
            onClick={() => setWoodTab('roundwood')}
          >
            Кругляк
          </button>
          <button
            type="button"
            className={woodTab === 'brus' ? 'active' : ''}
            onClick={() => setWoodTab('brus')}
          >
            Брус
          </button>
        </div>

        {woodTab === 'roundwood' && (
          <>
            <div className="row">
              <label>
                Номер бірки
                <input
                  value={labelNumberInput}
                  onChange={(e) => setLabelNumberInput(e.target.value)}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="напр. 169483077"
                />
              </label>
              <button type="button" onClick={addLogByLabel} disabled={busy}>
                Записати за біркою
              </button>
              <button type="button" className="btnSecondary" onClick={openScanner} disabled={busy}>
                Сканувати камерою
              </button>
            </div>
            {canManualReceive && (
              <>
                <div className="row" style={{ marginTop: 12 }}>
                  <label>
                    R (см)
                    <input
                      value={radiusInput}
                      onChange={(e) => setRadiusInput(e.target.value)}
                      onBlur={onRadiusBlur}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="напр. 18"
                    />
                  </label>
                  <div className="lengthField">
                    <span className="lengthFieldLabel">L (м)</span>
                    <input
                      value={lengthInput}
                      onChange={(e) => setLengthInput(e.target.value)}
                      onBlur={onLengthBlur}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="напр. 4"
                    />
                  </div>
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button type="button" onClick={addLog} disabled={busy}>
                    Записати вручну
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {woodTab === 'brus' && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <label>
                Сторона 1 (см)
                <input
                  value={brusSideAInput}
                  onChange={(e) => setBrusSideAInput(e.target.value)}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="напр. 10"
                />
              </label>
              <label>
                Сторона 2 (см)
                <input
                  value={brusSideBInput}
                  onChange={(e) => setBrusSideBInput(e.target.value)}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="напр. 8"
                />
              </label>
              <div className="lengthField">
                <span className="lengthFieldLabel">Довжина (м)</span>
                <input
                  value={brusLengthInput}
                  onChange={(e) => setBrusLengthInput(e.target.value)}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="напр. 4"
                />
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <label>
                Кількість
                <input
                  value={brusQtyInput}
                  onChange={(e) => setBrusQtyInput(e.target.value)}
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  placeholder="1"
                />
              </label>
              <button type="button" onClick={addBrus} disabled={busy}>
                Додати брус на склад
              </button>
            </div>
          </>
        )}
      </div>

      <div className="logsTableWrap">
        <h3>Додані за останні 5 хвилин</h3>
        {loadErr ? (
          <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
            Не завантажено.
          </p>
        ) : woodTab === 'roundwood' ? (
          recentLogs.length === 0 ? (
            <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
              Порожньо.
            </p>
          ) : (
            <table className="logsTable">
              <thead>
                <tr>
                  <th>Час</th>
                  <th>R, см</th>
                  <th>L, м</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recentLogs.map((item) => {
                  const leftMs = msUntilCancelDeadline(item.createdAt, nowTick)
                  const showCancel = canEditStock && leftMs > 0
                  return (
                    <tr key={item.id}>
                      <td data-label="Час">{new Date(item.createdAt).toLocaleString('uk-UA')}</td>
                      <td data-label="R, см">{formatLengthInput(item.radius, INPUT_RADIUS_UNIT)}</td>
                      <td data-label="L, м">{formatLengthInput(item.length, INPUT_LENGTH_UNIT)}</td>
                      <td className="logsActionCell">
                        {showCancel ? (
                          <button
                            type="button"
                            className={
                              deletingId === item.id ? 'logsRemoveBtn logsRemoveBtnBusy' : 'logsRemoveBtn'
                            }
                            disabled={deletingId === item.id}
                            onClick={() => removeRowFromServer(item.id)}
                            title="Скасувати прийом"
                            aria-label="Скасувати прийом"
                            aria-busy={deletingId === item.id}
                          >
                            <svg
                              className="logsIconX"
                              viewBox="0 0 24 24"
                              width="20"
                              height="20"
                              aria-hidden
                            >
                              <path
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                d="M6 6l12 12M18 6L6 18"
                              />
                            </svg>
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        ) : recentBrus.length === 0 ? (
          <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
            Порожньо.
          </p>
        ) : (
          <table className="logsTable">
            <thead>
              <tr>
                <th>Час</th>
                <th>А×Б, см</th>
                <th>L, м</th>
                <th>Шт</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recentBrus.map((item) => {
                const leftMs = msUntilCancelDeadline(item.createdAt, nowTick)
                const showCancel = canEditStock && leftMs > 0
                const aCm = formatLengthInput(item.sideAMm, 'cm')
                const bCm = formatLengthInput(item.sideBMm, 'cm')
                return (
                  <tr key={item.id}>
                    <td data-label="Час">{new Date(item.createdAt).toLocaleString('uk-UA')}</td>
                    <td data-label="А×Б, см">
                      {aCm}×{bCm}
                    </td>
                    <td data-label="L, м">{formatLengthInput(item.lengthMm, INPUT_LENGTH_UNIT)}</td>
                    <td data-label="Шт">{item.qty}</td>
                    <td className="logsActionCell">
                      {showCancel ? (
                        <button
                          type="button"
                          className={
                            deletingBrusId === item.id
                              ? 'logsRemoveBtn logsRemoveBtnBusy'
                              : 'logsRemoveBtn'
                          }
                          disabled={deletingBrusId === item.id}
                          onClick={() => removeBrusRowFromServer(item.id)}
                          title="Скасувати прийом"
                          aria-label="Скасувати прийом"
                          aria-busy={deletingBrusId === item.id}
                        >
                          <svg
                            className="logsIconX"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            aria-hidden
                          >
                            <path
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              d="M6 6l12 12M18 6L6 18"
                            />
                          </svg>
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {labelSuccessInfo && (
        <div
          className="logsLabelModalBackdrop"
          role="presentation"
          onClick={() => setLabelSuccessInfo(null)}
        >
          <div
            className="logsLabelModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logsLabelModalTitle"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="logsLabelModalHeader">
              <h3 id="logsLabelModalTitle">Кругляк успішно додано</h3>
              <button
                type="button"
                className="ghost"
                onClick={() => setLabelSuccessInfo(null)}
                aria-label="Закрити вікно"
              >
                Закрити
              </button>
            </div>
            <dl className="logsLabelModalList">
              <div>
                <dt>Номер бірки</dt>
                <dd>{labelSuccessInfo.labelNumber}</dd>
              </div>
              <div>
                <dt>Діаметр (з бірки)</dt>
                <dd>{labelSuccessInfo.diameter}</dd>
              </div>
              <div>
                <dt>Довжина (з бірки)</dt>
                <dd>{labelSuccessInfo.length}</dd>
              </div>
              {labelSuccessInfo.volumeM3 != null && (
                <div>
                  <dt>Об'єм (з бірки), м³</dt>
                  <dd>{labelSuccessInfo.volumeM3.toLocaleString('uk-UA', { maximumFractionDigits: 6 })}</dd>
                </div>
              )}
              <div>
                <dt>Записано у базу (radiusMm)</dt>
                <dd>{labelSuccessInfo.radiusMm} мм</dd>
              </div>
              <div>
                <dt>Записано у базу (lengthMm)</dt>
                <dd>{labelSuccessInfo.lengthMm} мм</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
      {scannerOpen && (
        <div className="logsScannerBackdrop" role="presentation" onClick={closeScanner}>
          <div
            className="logsScannerModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logsScannerTitle"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="logsScannerHeader">
              <h3 id="logsScannerTitle">Сканування штрихкоду</h3>
              <button type="button" className="ghost" onClick={closeScanner} aria-label="Закрити">
                Закрити
              </button>
            </div>
            <p className="panelHint logsScannerHint">
              Наведіть камеру на штрихкод бірки. Після розпізнавання запис буде додано автоматично.
            </p>
            <div className="logsScannerActions">
              <button
                type="button"
                className="btnSecondary"
                onClick={onScanFilePick}
                disabled={scannerBusy}
              >
                Сканувати з фото
              </button>
              <input
                ref={scannerFileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onScanFileChange}
                className="logsScannerFileInput"
              />
            </div>
            {!barcodeDetectorRef.current && (
              <p className="panelHint logsScannerHint">
                У цьому браузері використовується сумісний режим сканування.
              </p>
            )}
            {scannerError && <p className="birkaMsgErr">{scannerError}</p>}
            <div className="logsScannerVideoWrap">
              <video ref={scannerVideoRef} className="logsScannerVideo" playsInline muted />
              {scannerBusy && <div className="logsScannerOverlay">Підключення до камери…</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
