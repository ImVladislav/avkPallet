import { useEffect, useMemo, useState } from 'react'
import {
  createSalaryManual,
  fetchSalaryManualEntries,
  fetchSalaryReport,
  fetchSalaryRates,
  fetchUsers,
  fetchWorkersDirectory,
  updateSalaryRates,
  type ManagedUser,
  type SalaryManualEntry,
  type WorkerDirectoryEntry,
  type SalaryRates,
  type SalaryReportRow,
  type SalaryReportTotal,
} from '../api'
import './AdminSalaryPage.css'

const RATE_FIELD_LABELS: Record<keyof SalaryRates, string> = {
  band_saw: 'Стрічкова, грн/м³',
  strip_saw: 'Багатопил, грн/м³',
  circular_saw: 'Циркулярка, грн',
  pallets: 'Піддони, грн',
}

function mergeWorkerLists(users: ManagedUser[], directory: WorkerDirectoryEntry[]): ManagedUser[] {
  const byId = new Map<string, ManagedUser>()
  for (const u of users) {
    if (u?.id) byId.set(u.id, u)
  }
  for (const w of directory) {
    if (!w?.id || byId.has(w.id)) continue
    byId.set(w.id, {
      id: w.id,
      username: w.username,
      displayName: w.displayName,
      role: w.role,
      tabs: [],
    })
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'uk', { sensitivity: 'base' }),
  )
}

const STATION_LABELS: Record<SalaryReportRow['station'], string> = {
  band_saw: 'Стрічкова пила',
  strip_saw: 'Багатопил',
  circular_saw: 'Циркулярка',
  pallets: 'Піддони / збірка',
  manual: 'Додатково (адмін)',
}

function monthKey(isoDate: string): string {
  const d = new Date(isoDate)
  if (!Number.isFinite(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function formatBasis(row: SalaryReportRow): string {
  if (row.station === 'manual') return 'Додатково'
  if (row.basisUnit === 'm3' && row.basisQty != null && Number.isFinite(row.basisQty)) {
    return `${row.basisQty.toLocaleString('uk-UA', { maximumFractionDigits: 4 })} м³`
  }
  if (row.basisUnit === 'task') return '1 завд.'
  return '—'
}

export function AdminSalaryPage() {
  const [month, setMonth] = useState('all')
  const [monthOptions, setMonthOptions] = useState<string[]>([])
  const [rates, setRates] = useState<SalaryRates>({
    band_saw: 900,
    strip_saw: 700,
    circular_saw: 700,
    pallets: 600,
  })
  const [ratesSaved, setRatesSaved] = useState<SalaryRates | null>(null)
  const [ratesEditing, setRatesEditing] = useState(false)
  const [totals, setTotals] = useState<SalaryReportTotal[]>([])
  const [rows, setRows] = useState<SalaryReportRow[]>([])
  const [workers, setWorkers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const [selectedWorkerId, setSelectedWorkerId] = useState('')
  const [allManualEntries, setAllManualEntries] = useState<SalaryManualEntry[]>([])
  const [manualAmount, setManualAmount] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [manualBusy, setManualBusy] = useState(false)

  const refreshManualHistory = async () => {
    try {
      const manual = await fetchSalaryManualEntries(true)
      setAllManualEntries(manual)
    } catch {
      setAllManualEntries([])
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const report = await fetchSalaryReport('all')
        const months = Array.from(
          new Set(
            report.rows
              .map((row) => monthKey(row.at))
              .filter((x) => x.length > 0),
          ),
        ).sort((a, b) => b.localeCompare(a))
        setMonthOptions(months)
      } catch {
        setMonthOptions([])
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      let merged: ManagedUser[] = []
      try {
        const [fromUsers, fromDir] = await Promise.all([
          fetchUsers().catch(() => [] as ManagedUser[]),
          fetchWorkersDirectory().catch(() => [] as WorkerDirectoryEntry[]),
        ])
        merged = mergeWorkerLists(
          Array.isArray(fromUsers) ? fromUsers : [],
          Array.isArray(fromDir) ? fromDir : [],
        )
      } catch {
        merged = []
      }
      let manual: SalaryManualEntry[] = []
      try {
        manual = await fetchSalaryManualEntries(true)
      } catch {
        manual = []
      }
      setWorkers(merged)
      setAllManualEntries(manual)
    })()
  }, [])

  const reloadReport = async (forMonth: string) => {
    const [ratesRes, report] = await Promise.all([fetchSalaryRates(), fetchSalaryReport(forMonth)])
    setRates(ratesRes)
    setRatesSaved(ratesRes)
    setTotals(report.totals)
    setRows(report.rows)
    return report
  }

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        await reloadReport(month)
        setRatesEditing(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не вдалося завантажити звіт по ЗП')
      } finally {
        setLoading(false)
      }
    })()
  }, [month])

  const totalUah = useMemo(
    () => totals.reduce((sum, row) => sum + row.totalUah, 0),
    [totals],
  )

  const cancelRatesEdit = () => {
    if (ratesSaved) setRates({ ...ratesSaved })
    setRatesEditing(false)
    setMsg(null)
  }

  const saveRates = () => {
    setSaving(true)
    setError(null)
    setMsg(null)
    void (async () => {
      try {
        const next = await updateSalaryRates(rates)
        setRates(next)
        setRatesSaved(next)
        setRatesEditing(false)
        setMsg('Тарифи збережено.')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не вдалося зберегти тарифи')
      } finally {
        setSaving(false)
      }
    })()
  }

  const setRate = (key: keyof SalaryRates, raw: string) => {
    const n = Number(raw.replace(',', '.'))
    setRates((prev) => ({ ...prev, [key]: Number.isFinite(n) && n >= 0 ? n : 0 }))
  }

  const submitManual = () => {
    const amount = Number(String(manualAmount).replace(',', '.'))
    setManualBusy(true)
    setError(null)
    setMsg(null)
    void (async () => {
      try {
        if (!selectedWorkerId) throw new Error('Оберіть працівника зі списку')
        if (!Number.isFinite(amount) || amount === 0) throw new Error('Вкажіть суму (не нуль)')
        if (!manualNote.trim()) throw new Error('Опишіть, за що нарахування')
        await createSalaryManual({
          userId: selectedWorkerId,
          amountUah: Math.round(amount * 100) / 100,
          note: manualNote.trim().slice(0, 500),
        })
        setManualAmount('')
        setManualNote('')
        await refreshManualHistory()
        await reloadReport(month)
        setMsg('Нарахування додано; звіт оновлено. Працівник побачить це в «Моя ЗП».')
        const report = await fetchSalaryReport('all')
        const months = Array.from(
          new Set(
            report.rows
              .map((row) => monthKey(row.at))
              .filter((x) => x.length > 0),
          ),
        ).sort((a, b) => b.localeCompare(a))
        setMonthOptions(months)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не вдалося додати нарахування')
      } finally {
        setManualBusy(false)
      }
    })()
  }

  const selectableWorkers = useMemo(
    () =>
      workers.filter((u) => u.role !== 'admin' && u.role !== 'super_admin').length > 0
        ? workers.filter((u) => u.role !== 'admin' && u.role !== 'super_admin')
        : workers,
    [workers],
  )

  useEffect(() => {
    if (selectableWorkers.length === 0) return
    setSelectedWorkerId((prev) =>
      prev && selectableWorkers.some((w) => w.id === prev) ? prev : selectableWorkers[0].id,
    )
  }, [selectableWorkers])

  const selectedWorker = useMemo(
    () => selectableWorkers.find((w) => w.id === selectedWorkerId) ?? null,
    [selectableWorkers, selectedWorkerId],
  )

  const manualHistoryForSelected = useMemo(() => {
    if (!selectedWorkerId) return []
    return [...allManualEntries]
      .filter((e) => e.userId === selectedWorkerId)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  }, [allManualEntries, selectedWorkerId])

  const manualCountForWorker = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of allManualEntries) {
      m.set(e.userId, (m.get(e.userId) ?? 0) + 1)
    }
    return m
  }, [allManualEntries])

  return (
    <section className="panel usersPage">
      <h2 className="logsPageTitle">ЗП працівників (адмін)</h2>
      <p className="panelHint" style={{ marginTop: 0 }}>
        Деталізація як у «Моя ЗП», плюс ручні суми з коментарем — у «Моя ЗП» вони з’являються як «Додатково
        (адмін)».
      </p>
      {error && <p className="birkaMsgErr">{error}</p>}
      {msg && <p className="panelHint">{msg}</p>}

      <div className="logsFormCard adminSalaryRatesCard">
        <h3 style={{ marginTop: 0 }}>Тарифи</h3>
        <p className="panelHint" style={{ margin: '0 0 8px' }}>
          Натисніть «Редагувати», щоб змінити ставки; «Зберегти» записує їх у базу.
        </p>
        <div className="adminSalaryRatesGrid">
          {(Object.keys(RATE_FIELD_LABELS) as Array<keyof SalaryRates>).map((key) => (
            <label key={key} className="adminSalaryRateField">
              {RATE_FIELD_LABELS[key]}
              <input
                className={ratesEditing ? '' : 'adminSalaryInputReadonly'}
                value={String(rates[key] ?? 0)}
                onChange={(e) => setRate(key, e.target.value)}
                inputMode="decimal"
                disabled={!ratesEditing}
              />
            </label>
          ))}
        </div>
        <div className="adminSalaryRatesActions">
          {!ratesEditing ? (
            <button type="button" onClick={() => setRatesEditing(true)}>
              Редагувати тарифи
            </button>
          ) : (
            <>
              <button type="button" onClick={saveRates} disabled={saving}>
                {saving ? 'Збереження…' : 'Зберегти тарифи'}
              </button>
              <button type="button" className="btnSecondary" onClick={cancelRatesEdit} disabled={saving}>
                Скасувати
              </button>
            </>
          )}
        </div>
      </div>

      <div className="logsFormCard adminSalaryManualCard">
        <h3 style={{ marginTop: 0 }}>Ручне нарахування</h3>
        <p className="panelHint" style={{ margin: 0 }}>
          Виберіть працівника в списку зліва, введіть суму та опис. Нижче для кого обрано — історія усіх
          ручних нарахувань (лише додатки від адміна).
        </p>

        {selectableWorkers.length === 0 ? (
          <p className="panelHint" style={{ marginTop: 12 }}>
            Список порожній: не вдалося отримати користувачів з сервера або в базі ще немає записів. Перевірте
            розділ «Працівники» та оновіть сторінку.
          </p>
        ) : (
          <div className="adminSalaryWorkerLayout">
            <div className="adminSalaryWorkerList" role="listbox" aria-label="Працівники">
              {selectableWorkers.map((w) => {
                const cnt = manualCountForWorker.get(w.id) ?? 0
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="option"
                    aria-selected={w.id === selectedWorkerId}
                    className={`adminSalaryWorkerItem${w.id === selectedWorkerId ? ' active' : ''}`}
                    onClick={() => setSelectedWorkerId(w.id)}
                  >
                    <span className="adminSalaryWorkerName">
                      {w.displayName}{' '}
                      <span style={{ fontWeight: 400, opacity: 0.92 }}>({w.username})</span>
                    </span>
                    <span className="adminSalaryWorkerMeta">
                      Ручних нарахувань: {cnt}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="adminSalaryWorkerPanel">
              {selectedWorker ? (
                <>
                  <p className="panelHint" style={{ margin: '0 0 8px' }}>
                    <strong>{selectedWorker.displayName}</strong> — додайте суму до ЗП чи перегляньте історію.
                  </p>
                  <div className="adminSalaryManualGrid">
                    <div className="adminSalaryManualAmount">
                      <label>
                        Сума, грн
                        <input
                          value={manualAmount}
                          onChange={(e) => setManualAmount(e.target.value)}
                          inputMode="decimal"
                          placeholder="0"
                          disabled={manualBusy}
                        />
                      </label>
                    </div>
                    <div className="adminSalaryManualNote">
                      <label>
                        За що нараховано
                        <textarea
                          value={manualNote}
                          onChange={(e) => setManualNote(e.target.value)}
                          placeholder="Короткий опис для працівника та звіту"
                          disabled={manualBusy}
                          maxLength={500}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="adminSalaryRatesActions">
                    <button type="button" onClick={submitManual} disabled={manualBusy}>
                      {manualBusy ? 'Запис…' : 'Додати нарахування'}
                    </button>
                  </div>

                  <div className="adminSalaryHistory">
                    <h4>Історія ручних нарахувань</h4>
                    {manualHistoryForSelected.length === 0 ? (
                      <p className="adminSalaryHistoryEmpty">Поки немає ручних нарахувань для цього працівника.</p>
                    ) : (
                      <div className="adminSalaryHistoryTableWrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Час</th>
                              <th>Сума, грн</th>
                              <th>Опис</th>
                              <th>Записав</th>
                            </tr>
                          </thead>
                          <tbody>
                            {manualHistoryForSelected.map((e) => (
                              <tr key={e.id}>
                                <td>{new Date(e.at).toLocaleString('uk-UA')}</td>
                                <td>
                                  {e.amountUah.toLocaleString('uk-UA', { maximumFractionDigits: 2 })}
                                </td>
                                <td>{e.note}</td>
                                <td>{e.recordedBy?.username ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <label>
          Період
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">Усі місяці</option>
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <p className="panelHint">Завантаження…</p>
      ) : (
        <>
          <div className="logsTableWrap">
            <h3 style={{ marginTop: 0 }}>
              Нараховано всього:{' '}
              {totalUah.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} грн
            </h3>
            {rows.length === 0 ? (
              <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
                За вибраний період немає нарахувань.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="logsTable">
                  <thead>
                    <tr>
                      <th>Час</th>
                      <th>Працівник</th>
                      <th>Логін</th>
                      <th>Етап</th>
                      <th>Завдання / опис</th>
                      <th>База нарахування</th>
                      <th>Сума, грн</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => (
                      <tr
                        key={`${row.userId}-${row.taskId}-${row.station}-${row.at}-${idx}`}
                      >
                        <td data-label="Час">
                          {new Date(row.at).toLocaleString('uk-UA')}
                        </td>
                        <td data-label="Працівник">{row.displayName}</td>
                        <td data-label="Логін">{row.username}</td>
                        <td data-label="Етап">{STATION_LABELS[row.station] ?? row.station}</td>
                        <td data-label="Опис">{row.taskTitle}</td>
                        <td data-label="База">{formatBasis(row)}</td>
                        <td data-label="Сума">
                          {row.amountUah.toLocaleString('uk-UA', {
                            maximumFractionDigits: 2,
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {totals.length > 0 && (
            <div className="logsTableWrap" style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0 }}>Підсумок по працівниках</h3>
              <table className="logsTable">
                <thead>
                  <tr>
                    <th>Працівник</th>
                    <th>Логін</th>
                    <th>Сума, грн</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.map((row) => (
                    <tr key={row.userId}>
                      <td>{row.displayName}</td>
                      <td>{row.username}</td>
                      <td>
                        {row.totalUah.toLocaleString('uk-UA', { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
