import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRoundwoodState } from '../api'
import { useAuth } from '../context/AuthContext'
import { useRoundwoodReload } from '../hooks/useRoundwoodReload'
import type { RoundwoodJournalEntry } from '../types/roundwood'

function kindLabel(k: RoundwoodJournalEntry['kind']): string {
  switch (k) {
    case 'received':
      return 'Прийом на склад'
    case 'receive_cancelled':
      return 'Скасування прийому (до 5 хв)'
    case 'band_consumed':
      return 'Розпил ленточної (колода знята)'
    case 'stock_updated':
      return 'Зміна розмірів колоди'
    case 'stock_cleared':
      return 'Очистка складу'
    default:
      return k
  }
}

function fmtMm(mm: number | undefined): string {
  if (mm == null || !Number.isFinite(mm)) return '—'
  return `${Math.round(mm)} мм`
}

export function WorkJournalPage() {
  const { user } = useAuth()
  const [journal, setJournal] = useState<RoundwoodJournalEntry[]>([])
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

  if (!user) return null

  return (
    <section className="panel">
      <h2>Журнал робіт (кругляк)</h2>
      <p className="panelHint">
        Хронологія подій: прийом колод на серверний склад, зміни розмірів, розпил на ленточній
        (списання колоди), очистка складу бригадиром/адміном. Файл даних на сервері: roundwood.json
        — спільний для всіх користувачів.
      </p>
      {err && <p className="birkaMsgErr">{err}</p>}
      {journal.length === 0 ? (
        <p>Поки немає записів.</p>
      ) : (
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
            {journal.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.at).toLocaleString('uk-UA')}</td>
                <td>{kindLabel(row.kind)}</td>
                <td>{row.recordedBy?.username ?? '—'}</td>
                <td>
                  {row.kind === 'stock_cleared' && (
                    <>Знято зі складу записів: <strong>{row.clearedCount ?? 0}</strong></>
                  )}
                  {(row.kind === 'received' ||
                    row.kind === 'receive_cancelled' ||
                    row.kind === 'band_consumed' ||
                    row.kind === 'stock_updated') && (
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
                      {row.taskTitle && (
                        <>
                          {' '}
                          · завд. <strong>{row.taskTitle}</strong>
                        </>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
