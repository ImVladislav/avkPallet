import { useEffect, useMemo, useState } from 'react'
import { fetchRoundwoodState, fetchSalaryManualEntries, fetchSalaryRates, fetchTasks, type SalaryManualEntry, type SalaryRates } from '../api'
import { useAuth } from '../context/AuthContext'
import type { RoundwoodJournalEntry } from '../types/roundwood'
import type { TaskStationAssignments, WorkTask } from '../types/task'

type StationKey = keyof TaskStationAssignments

type SalaryRow = {
  taskId: string
  taskTitle: string
  station: StationKey | 'manual'
  stationLabel: string
  updatedAt: string
  amountUah: number
  basisQty: number
  basisUnit: 'm3' | 'task'
}

const STATION_LABELS: Record<StationKey, string> = {
  band_saw: 'Стрічкова пила',
  strip_saw: 'Багатопил',
  circular_saw: 'Циркулярка',
  pallets: 'Піддони / склад',
}

function monthKey(isoDate: string): string {
  const d = new Date(isoDate)
  if (!Number.isFinite(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function stationsForUser(role: string, tabs: string[]): StationKey[] {
  const out = new Set<StationKey>()
  if (role === 'sawyer') out.add('band_saw')
  if (role === 'circular_operator') {
    out.add('strip_saw')
    out.add('circular_saw')
  }
  if (role === 'pallet_assembly') out.add('pallets')
  if (tabs.includes('band_saw')) out.add('band_saw')
  if (tabs.includes('strip_saw')) out.add('strip_saw')
  if (tabs.includes('circular_saw')) out.add('circular_saw')
  if (tabs.includes('pallets')) out.add('pallets')
  return [...out]
}

function roundwoodVolumeM3(entry: RoundwoodJournalEntry): number {
  if (entry.volumeM3 != null && Number.isFinite(entry.volumeM3) && entry.volumeM3 > 0) return entry.volumeM3
  const radiusMm = Number(entry.radiusMm)
  const lengthMm = Number(entry.lengthMm)
  if (!Number.isFinite(radiusMm) || radiusMm <= 0 || !Number.isFinite(lengthMm) || lengthMm <= 0) {
    return 0
  }
  return (Math.PI * radiusMm * radiusMm * lengthMm) / 1_000_000_000
}

function roundwoodVolumeByTask(journal: RoundwoodJournalEntry[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const entry of journal) {
    if (entry.kind !== 'band_consumed' || !entry.taskId) continue
    map.set(entry.taskId, (map.get(entry.taskId) ?? 0) + roundwoodVolumeM3(entry))
  }
  return map
}

function salaryBasisForStation(station: StationKey, task: WorkTask, roundwoodByTask: Map<string, number>) {
  if (station === 'band_saw' || station === 'strip_saw') {
    return { qty: roundwoodByTask.get(task.id) ?? 0, unit: 'm3' as const }
  }
  return { qty: 1, unit: 'task' as const }
}

function fallbackStationsForTask(
  role: string,
  tabs: string[],
  task: WorkTask,
): StationKey[] {
  const availableStations = stationsForUser(role, tabs)
  if (role === 'circular_operator' && availableStations.includes('circular_saw')) {
    return ['circular_saw']
  }
  const taskHasStripFact = (task.stripSaw?.cuts ?? []).length > 0
  if (taskHasStripFact && availableStations.includes('strip_saw')) {
    return ['strip_saw']
  }
  return availableStations
}

function salaryRowsForUser(
  tasks: WorkTask[],
  userId: string,
  role: string,
  tabs: string[],
  rates: SalaryRates,
  roundwoodByTask: Map<string, number>,
): SalaryRow[] {
  const rows: SalaryRow[] = []
  for (const task of tasks) {
    if (task.status !== 'done') continue
    const stamp = task.updatedAt ?? task.createdAt
    const stationAssignments = task.stationAssignments
    const paidStations = new Set<StationKey>()
    const hasOwnStripFact = (task.stripSaw?.cuts ?? []).some((cut) => cut.recordedBy?.id === userId)
    const hasOwnCircularFact = (task.circularSaw?.cuts ?? []).some((cut) => cut.recordedBy?.id === userId)

    if (hasOwnStripFact) {
      const basis = salaryBasisForStation('strip_saw', task, roundwoodByTask)
      if (basis.qty > 0) {
        const ownCuts = (task.stripSaw?.cuts ?? []).filter((cut) => cut.recordedBy?.id === userId)
        rows.push({
          taskId: task.id,
          taskTitle: task.title,
          station: 'strip_saw',
          stationLabel: STATION_LABELS.strip_saw,
          updatedAt: ownCuts[ownCuts.length - 1]?.recordedAt || stamp,
          amountUah: Number(rates.strip_saw ?? 0) * basis.qty,
          basisQty: basis.qty,
          basisUnit: basis.unit,
        })
      }
      continue
    }

    if (hasOwnCircularFact) {
      const basis = salaryBasisForStation('circular_saw', task, roundwoodByTask)
      const ownCuts = (task.circularSaw?.cuts ?? []).filter((cut) => cut.recordedBy?.id === userId)
      rows.push({
        taskId: task.id,
        taskTitle: task.title,
        station: 'circular_saw',
        stationLabel: STATION_LABELS.circular_saw,
        updatedAt: ownCuts[ownCuts.length - 1]?.recordedAt || stamp,
        amountUah: Number(rates.circular_saw ?? 0) * basis.qty,
        basisQty: basis.qty,
        basisUnit: basis.unit,
      })
      continue
    }

    if (stationAssignments) {
      for (const station of Object.keys(STATION_LABELS) as StationKey[]) {
        const workers = stationAssignments[station] ?? []
        if (!workers.includes(userId)) continue
        const basis = salaryBasisForStation(station, task, roundwoodByTask)
        if (basis.qty <= 0) continue
        const splitBy = Math.max(1, workers.length)
        rows.push({
          taskId: task.id,
          taskTitle: task.title,
          station,
          stationLabel: STATION_LABELS[station],
          updatedAt: stamp,
          amountUah: (Number(rates[station] ?? 0) * basis.qty) / splitBy,
          basisQty: basis.qty,
          basisUnit: basis.unit,
        })
        paidStations.add(station)
      }
    }

    if (paidStations.size > 0) continue

    // Старі завдання або ручні доступи без персонального призначення.
    const fallbackStations = fallbackStationsForTask(role, tabs, task)

    for (const station of fallbackStations) {
      if (paidStations.has(station)) continue
      const roleKey =
        station === 'band_saw'
          ? 'sawyer'
          : station === 'pallets'
            ? 'pallet_assembly'
            : 'circular_operator'
      if (!task.assignTo.includes(roleKey)) continue
      const basis = salaryBasisForStation(station, task, roundwoodByTask)
      if (basis.qty <= 0) continue
      rows.push({
        taskId: task.id,
        taskTitle: task.title,
        station,
        stationLabel: STATION_LABELS[station],
        updatedAt: stamp,
        amountUah: Number(rates[station] ?? 0) * basis.qty,
        basisQty: basis.qty,
        basisUnit: basis.unit,
      })
      break
    }
  }
  return rows.sort((a, b) => {
    const ta = new Date(a.updatedAt).getTime()
    const tb = new Date(b.updatedAt).getTime()
    return tb - ta
  })
}

export function MySalaryPage() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [roundwoodJournal, setRoundwoodJournal] = useState<RoundwoodJournalEntry[]>([])
  const [manualEntries, setManualEntries] = useState<SalaryManualEntry[]>([])
  const [rates, setRates] = useState<SalaryRates>({
    band_saw: 900,
    strip_saw: 700,
    circular_saw: 700,
    pallets: 600,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const [list, ratesRes, roundwood, manual] = await Promise.all([
          fetchTasks(),
          fetchSalaryRates(),
          fetchRoundwoodState(),
          fetchSalaryManualEntries(false),
        ])
        setTasks(list)
        setRates(ratesRes)
        setRoundwoodJournal(roundwood.journal)
        setManualEntries(manual)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не вдалося завантажити задачі для розрахунку ЗП')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const roundwoodByTask = useMemo(() => roundwoodVolumeByTask(roundwoodJournal), [roundwoodJournal])

  const taskSalaryRows = useMemo(
    () => (user ? salaryRowsForUser(tasks, user.id, user.role, user.tabs, rates, roundwoodByTask) : []),
    [tasks, user, rates, roundwoodByTask],
  )

  const manualSalaryRows = useMemo<SalaryRow[]>(
    () =>
      manualEntries.map((e) => ({
        taskId: e.id,
        taskTitle: e.note,
        station: 'manual',
        stationLabel: 'Додатково (адмін)',
        updatedAt: e.at,
        amountUah: e.amountUah,
        basisQty: 1,
        basisUnit: 'task',
      })),
    [manualEntries],
  )

  const salaryRows = useMemo(
    () =>
      [...taskSalaryRows, ...manualSalaryRows].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [taskSalaryRows, manualSalaryRows],
  )

  const monthOptions = useMemo(() => {
    const uniq = new Set<string>()
    for (const row of salaryRows) {
      const k = monthKey(row.updatedAt)
      if (k) uniq.add(k)
    }
    return Array.from(uniq).sort((a, b) => b.localeCompare(a))
  }, [salaryRows])

  const [monthFilter, setMonthFilter] = useState<string>('all')

  useEffect(() => {
    if (monthFilter !== 'all' && !monthOptions.includes(monthFilter)) {
      setMonthFilter('all')
    }
  }, [monthFilter, monthOptions])

  const visibleRows = useMemo(
    () =>
      monthFilter === 'all'
        ? salaryRows
        : salaryRows.filter((row) => monthKey(row.updatedAt) === monthFilter),
    [monthFilter, salaryRows],
  )

  const totalUah = useMemo(
    () => visibleRows.reduce((sum, row) => sum + row.amountUah, 0),
    [visibleRows],
  )

  return (
    <section className="panel">
      <h2 className="logsPageTitle">Моя ЗП</h2>
      <p className="logsLead">
        Стрічкова та багатопил рахуються по кубатурі кругляка, взятого в роботу. Інші етапи
        рахуються по ставці за виконане завдання. Якщо на станку кілька працівників — сума ділиться порівну.
        Додаткові нарахування від адміністратора показані окремим рядком.
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <label>
          Період
          <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
            <option value="all">Усі місяці</option>
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="panelHint">Завантаження…</p>}
      {error && <p className="birkaMsgErr">{error}</p>}
      {!loading && !error && (
        <>
          <p className="panelHint">
            Нараховано: <strong>{totalUah.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} грн</strong>
          </p>
          {visibleRows.length === 0 ? (
            <p className="panelHint">Поки немає нарахувань за вибраний період.</p>
          ) : (
            <div className="logsTableWrap">
              <h3>Деталізація нарахувань</h3>
              <table className="logsTable">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Завдання</th>
                    <th>Станок</th>
                    <th>Обсяг</th>
                    <th>Сума</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={`${row.taskId}:${row.station}:${row.updatedAt}`}>
                      <td>{new Date(row.updatedAt).toLocaleString('uk-UA')}</td>
                      <td>{row.taskTitle}</td>
                      <td>{row.stationLabel}</td>
                      <td>
                        {row.station === 'manual'
                          ? '—'
                          : row.basisUnit === 'm3'
                            ? `${row.basisQty.toLocaleString('uk-UA', { maximumFractionDigits: 3 })} м³`
                            : '1 завдання'}
                      </td>
                      <td>{row.amountUah.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} грн</td>
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
