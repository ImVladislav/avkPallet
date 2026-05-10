import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchRoundwoodState } from '../api'
import { useAuth } from '../context/AuthContext'
import { useRoundwoodReload } from '../hooks/useRoundwoodReload'
import type { RoundwoodJournalEntry } from '../types/roundwood'
import './WorkJournalPage.css'

type JournalTabId = 'receiving' | 'roundwood_ops'

function kindLabel(k: RoundwoodJournalEntry['kind']): string {
  switch (k) {
    case 'received':
      return 'Прийом кругляка на склад'
    case 'receive_cancelled':
      return 'Скасування прийому кругляка'
    case 'brus_received':
      return 'Прийом бруса на склад'
    case 'brus_receive_cancelled':
      return 'Скасування прийому бруса'
    case 'band_consumed':
      return 'Розпил стрічкової пили (колода знята)'
    case 'stock_updated':
      return 'Зміна розмірів колоди'
    case 'stock_cleared':
      return 'Очистка складу кругляка'
    default:
      return k
  }
}

function isReceivingKind(k: RoundwoodJournalEntry['kind']): boolean {
  return (
    k === 'received' ||
    k === 'receive_cancelled' ||
    k === 'brus_received' ||
    k === 'brus_receive_cancelled'
  )
}

function isRoundwoodOpsKind(k: RoundwoodJournalEntry['kind']): boolean {
  return k === 'band_consumed' || k === 'stock_updated' || k === 'stock_cleared'
}

function fmtMm(mm: number | undefined): string {
  if (mm == null || !Number.isFinite(mm)) return '—'
  return `${Math.round(mm)} мм`
}

function JournalDetails({ row }: { row: RoundwoodJournalEntry }) {
  if (row.kind === 'stock_cleared') {
    return (
      <>
        Знято зі складу записів: <strong>{row.clearedCount ?? 0}</strong>
      </>
    )
  }

  if (row.kind === 'brus_received' || row.kind === 'brus_receive_cancelled') {
    return (
      <>
        {row.logId != null && <>id {row.logId} · </>}
        {fmtMm(row.sideAMm)} × {fmtMm(row.sideBMm)}
        {' · '}L {fmtMm(row.lengthMm)}
        {row.qty != null && (
          <>
            {' '}
            · {row.qty} шт
          </>
        )}
      </>
    )
  }

  if (
    row.kind === 'received' ||
    row.kind === 'receive_cancelled' ||
    row.kind === 'band_consumed' ||
    row.kind === 'stock_updated'
  ) {
    return (
      <>
        {row.logId != null && <>id {row.logId} · </>}
        R {fmtMm(row.radiusMm)}
        {row.kind === 'stock_updated' &&
          row.previousRadiusMm != null &&
          ` (було ${fmtMm(row.previousRadiusMm)})`}
        {' · '}L {fmtMm(row.lengthMm)}
        {row.kind === 'stock_updated' &&
          row.previousLengthMm != null &&
          ` (було ${fmtMm(row.previousLengthMm)})`}
        {row.volumeM3 != null && row.kind === 'received' && (
          <>
            {' '}
            · об&apos;єм (бірка){' '}
            {row.volumeM3.toLocaleString('uk-UA', { maximumFractionDigits: 4 })} м³
          </>
        )}
        {row.taskTitle && (
          <>
            {' '}
            · завд. <strong>{row.taskTitle}</strong>
          </>
        )}
      </>
    )
  }

  return <>—</>
}

export function WorkJournalPage() {
  const { user } = useAuth()
  const [journal, setJournal] = useState<RoundwoodJournalEntry[]>([])
  const [tab, setTab] = useState<JournalTabId>('receiving')
  const [err, setErr] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(() => {
    const n = ++seq.current
    void (async () => {
      try {
        const { journal: j } = await fetchRoundwoodState()
        if (seq.current !== n) return
        setJournal(j)
        setErr(null)
      } catch (e) {
        if (seq.current !== n) return
        setJournal([])
        setErr(e instanceof Error ? e.message : 'Не вдалося завантажити журнал')
      }
    })()
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useRoundwoodReload(reload)

  const receivingRows = useMemo(
    () => journal.filter((row) => isReceivingKind(row.kind)),
    [journal],
  )

  const roundwoodOpsRows = useMemo(
    () => journal.filter((row) => isRoundwoodOpsKind(row.kind)),
    [journal],
  )

  const visibleRows = tab === 'receiving' ? receivingRows : roundwoodOpsRows

  if (!user) return null

  return (
    <section className="panel">
      <h2>Журнал робіт</h2>
      <p className="panelHint">
        Єдиний журнал подій із сервера (<code>roundwood.json</code> для всіх користувачів). Оберіть
        розділ: прийом деревини (кругляк і брус) або операції зі складом кругляка.
      </p>

      <div className="workJournalTabs" role="tablist" aria-label="Розділи журналу">
        <button
          type="button"
          className={tab === 'receiving' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'receiving'}
          onClick={() => setTab('receiving')}
        >
          Прийом деревини
        </button>
        <button
          type="button"
          className={tab === 'roundwood_ops' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'roundwood_ops'}
          onClick={() => setTab('roundwood_ops')}
        >
          Роботи з кругляком
        </button>
      </div>

      {tab === 'receiving' && (
        <p className="panelHint" style={{ marginTop: 0 }}>
          Прийом колод і бруса на склад, скасування прийому протягом 5 хв.
        </p>
      )}
      {tab === 'roundwood_ops' && (
        <p className="panelHint" style={{ marginTop: 0 }}>
          Зміна розмірів колоди, списання після стрічкової пили, очищення складу (бригадир / адмін).
        </p>
      )}

      {err && <p className="birkaMsgErr">{err}</p>}
      {!err && journal.length === 0 ? (
        <p>Поки немає записів.</p>
      ) : !err && visibleRows.length === 0 ? (
        <p>Поки немає записів у цьому розділі.</p>
      ) : !err ? (
        <div className="workJournalTableWrap">
          <table>
            <thead>
              <tr>
                <th>Час</th>
                <th>Подія</th>
                <th>Хто</th>
                <th>Деталі</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.at).toLocaleString('uk-UA')}</td>
                  <td>{kindLabel(row.kind)}</td>
                  <td>{row.recordedBy?.username ?? '—'}</td>
                  <td>
                    <JournalDetails row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
