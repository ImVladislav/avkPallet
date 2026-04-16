import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
}

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
  const seq = useRef(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [deletingId, setDeletingId] = useState<number | null>(null)

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

  const addLogByLabel = () => {
    const labelNumber = Math.round(Number(labelNumberInput.trim()))
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
        if (!Number.isFinite(diameter) || diameter <= 0 || !Number.isFinite(length) || length <= 0) {
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
        })
        await reload()
        setLabelSuccessInfo({
          labelNumber,
          diameter,
          length,
          radiusMm,
          lengthMm,
        })
        setMsg('Записано за біркою, список оновлено.')
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Помилка запису за біркою')
      } finally {
        setBusy(false)
      }
    })()
  }

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
    </section>
  )
}
