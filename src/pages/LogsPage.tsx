import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import {
  deleteRoundwoodStockItem,
  fetchRoundwoodState,
  fetchLabelByNumber,
  receiveRoundwoodLog,
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
  readLengthUnit,
  persistLengthUnit,
  parseDisplayValueToMm,
  writeDefaultLengthMm,
  type LengthUnit,
} from '../helpers/lengthUnits'
import './LogsPage.css'

const DEFAULT_RADIUS_MM = 180
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
  const [logs, setLogs] = useState<LogItem[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [lengthUnitState, setLengthUnitState] = useState<LengthUnit>(() => readLengthUnit())
  const [radiusInput, setRadiusInput] = useState(() =>
    formatLengthInput(DEFAULT_RADIUS_MM, readLengthUnit()),
  )
  const [lengthInput, setLengthInput] = useState(() =>
    formatLengthInput(readDefaultLengthMm(), readLengthUnit()),
  )
  const [labelNumberInput, setLabelNumberInput] = useState('')
  const [labelSuccessInfo, setLabelSuccessInfo] = useState<LabelSuccessInfo | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerBusy, setScannerBusy] = useState(false)
  const [scannerError, setScannerError] = useState<string | null>(null)
  const seq = useRef(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null)
  const scannerFileInputRef = useRef<HTMLInputElement | null>(null)
  const scannerStreamRef = useRef<MediaStream | null>(null)
  const scannerLoopIdRef = useRef<number | null>(null)
  const barcodeDetectorRef = useRef<BarcodeDetectorLike | null>(null)
  const zxingReaderRef = useRef<BrowserMultiFormatReader | null>(null)
  const zxingControlsRef = useRef<IScannerControls | null>(null)

  const canEditStock =
    user?.role === 'sawyer' || user?.role === 'foreman' || user?.role === 'admin'
  const legacy = readLegacyLocalLogs()

  const reload = useCallback(() => {
    const n = ++seq.current
    void (async () => {
      try {
        const { stock } = await fetchRoundwoodState()
        if (seq.current !== n) return
        setLogs(stock)
        setLoadErr(null)
      } catch (e) {
        if (seq.current !== n) return
        setLogs([])
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

  const addLog = () => {
    const r = parseDisplayValueToMm(radiusInput, lengthUnitState)
    const l = parseDisplayValueToMm(lengthInput, lengthUnitState)
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
        setMsg('Записано, список оновлено.')
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка запису')
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
          await receiveRoundwoodLog({
            // Диаметр у см -> радіус/діаметр-поле складу в мм (як у поточній моделі складу)
            radiusMm,
            // Длина у м -> мм
            lengthMm,
            id: Date.now(),
            ...(volumeOk ? { volumeM3 } : {}),
          })
          await reload()
          setLabelSuccessInfo({
            labelNumber,
            diameter,
            length,
            radiusMm,
            lengthMm,
            ...(volumeOk ? { volumeM3 } : {}),
          })
          setMsg('Записано за біркою, список оновлено.')
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

  const onLengthUnitChange = (next: LengthUnit) => {
    const lenMm = parseDisplayValueToMm(lengthInput, lengthUnitState) ?? readDefaultLengthMm()
    const radMm = parseDisplayValueToMm(radiusInput, lengthUnitState) ?? DEFAULT_RADIUS_MM
    setLengthUnitState(next)
    persistLengthUnit(next)
    setLengthInput(formatLengthInput(lenMm, next))
    setRadiusInput(formatLengthInput(radMm, next))
  }

  const onLengthBlur = () => {
    const mm = parseDisplayValueToMm(lengthInput, lengthUnitState)
    if (mm != null) {
      writeDefaultLengthMm(mm)
      setLengthInput(formatLengthInput(mm, lengthUnitState))
    }
  }

  const onRadiusBlur = () => {
    const mm = parseDisplayValueToMm(radiusInput, lengthUnitState)
    if (mm != null) {
      setRadiusInput(formatLengthInput(mm, lengthUnitState))
    }
  }

  const removeRowFromServer = (id: number) => {
    setMsg(null)
    setDeletingId(id)
    void (async () => {
      try {
        await deleteRoundwoodStockItem(id)
        await reload()
        setMsg('Запис видалено.')
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка видалення')
      } finally {
        setDeletingId(null)
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
        setMsg(`Перенесено ${legacy.length} запис(ів) з браузера на сервер.`)
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка перенесення')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section className="panel">
      <h2 className="logsPageTitle">Прийом кругляка</h2>
      <p className="logsLead">
        Розміри за перемикачем м/см, у базі мм. Повне очищення у «Склад». Журнал у «Журнал робіт».
      </p>
      {loadErr && <p className="birkaMsgErr">{loadErr}</p>}
      {msg && <p className="panelHint">{msg}</p>}
      {legacy.length > 0 && (
        <p className="logsLegacy panelHint">
          Локально: {legacy.length} шт.{' '}
          <button type="button" className="btnSecondary" disabled={busy} onClick={importLegacy}>
            На сервер
          </button>
        </p>
      )}
      <div className="logsFormCard">
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
        <div className="row" style={{ marginTop: 12 }}>
          <label>
            R ({lengthUnitState === 'm' ? 'м' : 'см'})
            <input
              value={radiusInput}
              onChange={(e) => setRadiusInput(e.target.value)}
              onBlur={onRadiusBlur}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder={lengthUnitState === 'm' ? 'напр. 0,18' : 'напр. 18'}
            />
          </label>
          <div className="lengthField">
            <span className="lengthFieldLabel">L ({lengthUnitState === 'm' ? 'м' : 'см'})</span>
            <div className="unitToggle" role="group" aria-label="Одиниці довжини">
              <button
                type="button"
                className={lengthUnitState === 'm' ? 'active' : ''}
                onClick={() => onLengthUnitChange('m')}
              >
                м
              </button>
              <button
                type="button"
                className={lengthUnitState === 'cm' ? 'active' : ''}
                onClick={() => onLengthUnitChange('cm')}
              >
                см
              </button>
            </div>
            <input
              value={lengthInput}
              onChange={(e) => setLengthInput(e.target.value)}
              onBlur={onLengthBlur}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder={lengthUnitState === 'm' ? 'напр. 4' : 'напр. 400'}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" onClick={addLog} disabled={busy}>
            Записати
          </button>
        </div>
      </div>

      <div className="logsTableWrap">
        <h3>Залишок на сервері</h3>
        {loadErr ? (
          <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
            Не завантажено.
          </p>
        ) : sortedLogs.length === 0 ? (
          <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
            Порожньо.
          </p>
        ) : (
          <table className="logsTable">
            <thead>
              <tr>
                <th>Час</th>
                <th>R</th>
                <th>L</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedLogs.map((item) => {
                const leftMs = msUntilCancelDeadline(item.createdAt, nowTick)
                const showCancel = canEditStock && leftMs > 0
                return (
                  <tr key={item.id}>
                    <td>{new Date(item.createdAt).toLocaleString('uk-UA')}</td>
                    <td>{formatLengthInput(item.radius, lengthUnitState)}</td>
                    <td>{formatLengthInput(item.length, lengthUnitState)}</td>
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
