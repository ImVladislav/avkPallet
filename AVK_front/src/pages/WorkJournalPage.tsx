import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
      return 'Розпил стрічкової пили (колода знята зі складу)'
    case 'stock_updated':
      return 'Коригування розмірів колоди на складі'
    case 'stock_cleared':
      return 'Повне очищення складу кругляка'
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

function journalChronoOrder(a: RoundwoodJournalEntry, b: RoundwoodJournalEntry): number {
  const ta = new Date(a.at).getTime()
  const tb = new Date(b.at).getTime()
  if (ta !== tb) return ta - tb
  return String(a.id).localeCompare(String(b.id))
}

/** Орієнтовний залишок після кожної події (відтворення журналу хронологічно). */
function buildStockSnapshots(journal: RoundwoodJournalEntry[]) {
  const sorted = [...journal].sort(journalChronoOrder)
  const roundwoodIds = new Set<number>()
  const brusIds = new Set<number>()
  const roundwoodAfter = new Map<string, number>()
  const brusAfter = new Map<string, number>()

  for (const row of sorted) {
    switch (row.kind) {
      case 'received':
        if (row.logId != null) roundwoodIds.add(row.logId)
        break
      case 'receive_cancelled':
      case 'band_consumed':
        if (row.logId != null) roundwoodIds.delete(row.logId)
        break
      case 'stock_updated':
        break
      case 'stock_cleared':
        roundwoodIds.clear()
        break
      case 'brus_received':
        if (row.logId != null) brusIds.add(row.logId)
        break
      case 'brus_receive_cancelled':
        if (row.logId != null) brusIds.delete(row.logId)
        break
      default:
        break
    }
    roundwoodAfter.set(row.id, roundwoodIds.size)
    brusAfter.set(row.id, brusIds.size)
  }
  return { roundwoodAfter, brusAfter }
}

function cylinderVolumeM3(radiusMm: number, lengthMm: number): number {
  const r = radiusMm / 1000
  const l = lengthMm / 1000
  return Math.PI * r * r * l
}

function fmtVolUk(m3: number): string {
  return `${m3.toLocaleString('uk-UA', { maximumFractionDigits: 4 })} м³`
}

function whereLabel(tab: JournalTabId, row: RoundwoodJournalEntry): string {
  if (tab === 'receiving') {
    if (row.kind === 'brus_received' || row.kind === 'brus_receive_cancelled') return 'Склад бруса'
    return 'Прийом деревини / склад кругляка'
  }
  return 'Склад кругляка, цех стрічкової пили'
}

function fmtMmNum(mm: number | undefined): string {
  if (mm == null || !Number.isFinite(mm)) return '—'
  return String(Math.round(mm))
}

function taskTrunc(s: string, max = 40): string {
  const t = s.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

/** Коротка назва типу — перший рядок клітинки. */
function kindShort(k: RoundwoodJournalEntry['kind']): string {
  switch (k) {
    case 'received':
      return 'Прийом кругляка'
    case 'receive_cancelled':
      return 'Скасовано прийом'
    case 'brus_received':
      return 'Прийом бруса'
    case 'brus_receive_cancelled':
      return 'Скасовано брус'
    case 'band_consumed':
      return 'Списання після стрічки'
    case 'stock_updated':
      return 'Зміна розмірів'
    case 'stock_cleared':
      return 'Очищення складу'
    default:
      return k
  }
}

/** Компактний рядок характеристик (без «хто»). */
function factsLine(row: RoundwoodJournalEntry): string {
  switch (row.kind) {
    case 'received': {
      const p: string[] = []
      if (row.labelNumber != null) p.push(`бірка ${row.labelNumber}`)
      p.push(`R${fmtMmNum(row.radiusMm)} L${fmtMmNum(row.lengthMm)}`)
      if (row.volumeM3 != null) p.push(fmtVolUk(row.volumeM3))
      return p.join(' · ')
    }
    case 'receive_cancelled': {
      const p: string[] = []
      if (row.labelNumber != null) p.push(`бірка ${row.labelNumber}`)
      p.push(`було R${fmtMmNum(row.radiusMm)} L${fmtMmNum(row.lengthMm)}`)
      return p.join(' · ')
    }
    case 'brus_received': {
      const p = [
        `${fmtMmNum(row.sideAMm)}×${fmtMmNum(row.sideBMm)} L${fmtMmNum(row.lengthMm)}`,
      ]
      if (row.qty != null) p.push(`${row.qty} шт`)
      return p.join(' · ')
    }
    case 'brus_receive_cancelled': {
      const p: string[] = []
      if (row.sideAMm != null && row.sideBMm != null)
        p.push(`${fmtMmNum(row.sideAMm)}×${fmtMmNum(row.sideBMm)} L${fmtMmNum(row.lengthMm)}`)
      if (row.qty != null) p.push(`${row.qty} шт`)
      return p.length ? p.join(' · ') : '—'
    }
    case 'band_consumed': {
      const p: string[] = []
      if (row.labelNumber != null) p.push(`бірка ${row.labelNumber}`)
      p.push(`R${fmtMmNum(row.radiusMm)} L${fmtMmNum(row.lengthMm)}`)
      if (row.volumeM3 != null) p.push(fmtVolUk(row.volumeM3))
      else if (row.radiusMm != null && row.lengthMm != null)
        p.push(`≈${fmtVolUk(cylinderVolumeM3(row.radiusMm, row.lengthMm))}`)
      if (row.taskTitle) p.push(`«${taskTrunc(row.taskTitle)}»`)
      return p.join(' · ')
    }
    case 'stock_updated':
      return `R ${fmtMmNum(row.previousRadiusMm)}→${fmtMmNum(row.radiusMm)} · L ${fmtMmNum(row.previousLengthMm)}→${fmtMmNum(row.lengthMm)}`
    case 'stock_cleared':
      return `знято ${row.clearedCount ?? 0} кл`
    default:
      return ''
  }
}

function fmtDateTimeCompact(at: string): string {
  const d = new Date(at)
  return d.toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function remainderShort(
  tab: JournalTabId,
  row: RoundwoodJournalEntry,
  roundwoodAfter: Map<string, number>,
  brusAfter: Map<string, number>,
): string {
  const rw = roundwoodAfter.get(row.id)
  const br = brusAfter.get(row.id)
  if (tab === 'receiving') {
    if (row.kind === 'brus_received' || row.kind === 'brus_receive_cancelled') {
      return `залишок бруса: ${br ?? '—'} поз`
    }
    return `залишок кругляка: ${rw ?? '—'} кл`
  }
  if (row.kind === 'stock_cleared') return 'залишок: 0 кл'
  if (row.kind === 'stock_updated') return `без змін по кількості · ${rw ?? '—'} кл`
  return `залишок кругляка: ${rw ?? '—'} кл`
}

function DetailDl({
  row,
  tab,
  roundwoodAfter,
  brusAfter,
}: {
  row: RoundwoodJournalEntry
  tab: JournalTabId
  roundwoodAfter: Map<string, number>
  brusAfter: Map<string, number>
}) {
  const calculated =
    row.radiusMm != null &&
    row.lengthMm != null &&
    Number.isFinite(row.radiusMm) &&
    Number.isFinite(row.lengthMm)
      ? cylinderVolumeM3(row.radiusMm, row.lengthMm)
      : null

  const entries: { k: string; v: string }[] = [
    { k: 'Місце', v: whereLabel(tab, row) },
    { k: 'Подія', v: kindLabel(row.kind) },
    { k: 'Час', v: new Date(row.at).toLocaleString('uk-UA') },
    { k: 'Хто', v: row.recordedBy?.username ?? '—' },
  ]

  if (row.labelNumber != null) entries.push({ k: 'Бірка', v: String(row.labelNumber) })
  if (row.radiusMm != null) entries.push({ k: 'R, мм', v: String(Math.round(row.radiusMm)) })
  if (row.previousRadiusMm != null)
    entries.push({ k: 'Було R', v: String(Math.round(row.previousRadiusMm)) })
  if (row.lengthMm != null) entries.push({ k: 'L, мм', v: String(Math.round(row.lengthMm)) })
  if (row.previousLengthMm != null)
    entries.push({ k: 'Було L', v: String(Math.round(row.previousLengthMm)) })
  if (row.sideAMm != null && row.sideBMm != null)
    entries.push({
      k: 'Брус',
      v: `${Math.round(row.sideAMm)}×${Math.round(row.sideBMm)} мм`,
    })
  if (row.qty != null) entries.push({ k: 'Шт', v: String(row.qty) })
  if (row.volumeM3 != null) entries.push({ k: 'Обʼєм', v: fmtVolUk(row.volumeM3) })
  if (calculated != null) entries.push({ k: 'Циліндр', v: fmtVolUk(calculated) })
  if (row.taskTitle) entries.push({ k: 'Завд.', v: row.taskTitle })
  if (row.clearedCount != null) entries.push({ k: 'Знято кл', v: String(row.clearedCount) })
  entries.push({
    k: 'Залишок після',
    v: remainderShort(tab, row, roundwoodAfter, brusAfter),
  })

  return (
    <div className="workJournalDetailGrid" role="list">
      {entries.map(({ k, v }) => (
        <Fragment key={k}>
          <span className="workJournalDK">{k}</span>
          <span className="workJournalDV">{v}</span>
        </Fragment>
      ))}
    </div>
  )
}

function JournalEventMain({ row }: { row: RoundwoodJournalEntry }) {
  const facts = factsLine(row)
  return (
    <div className="workJournalEvent">
      <div className="workJournalEventTitle">{kindShort(row.kind)}</div>
      {facts ? <div className="workJournalEventFacts">{facts}</div> : null}
    </div>
  )
}

export function WorkJournalPage() {
  const { user } = useAuth()
  const [journal, setJournal] = useState<RoundwoodJournalEntry[]>([])
  const [tab, setTab] = useState<JournalTabId>('receiving')
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
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

  const { roundwoodAfter, brusAfter } = useMemo(() => buildStockSnapshots(journal), [journal])

  const receivingRows = useMemo(
    () => journal.filter((row) => isReceivingKind(row.kind)),
    [journal],
  )

  const roundwoodOpsRows = useMemo(
    () => journal.filter((row) => isRoundwoodOpsKind(row.kind)),
    [journal],
  )

  const visibleRows = tab === 'receiving' ? receivingRows : roundwoodOpsRows

  const toggle = (id: string) => {
    setOpen((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  if (!user) return null

  return (
    <section className="panel workJournalPageRoot">
      <h2 className="workJournalH2">Журнал робіт</h2>
      <p className="workJournalIntro">
        Хто, коли і що зробив з прийомом або складом кругляка. Натисніть стрілку для повних полів. Залишок після
        події — орієнтовно з історії журналу.
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

      <p className="workJournalTabHint">
        {tab === 'receiving'
          ? 'Прийом колод і бруса; скасування — до 5 хв після прийому.'
          : 'Розміри на складі, списання після стрічки, очищення складу.'}
      </p>

      {err && <p className="birkaMsgErr">{err}</p>}
      {!err && journal.length === 0 ? (
        <p>Поки немає записів.</p>
      ) : !err && visibleRows.length === 0 ? (
        <p>Поки немає записів у цьому розділі.</p>
      ) : !err ? (
        <div className="workJournalGrid">
          {visibleRows.map((row) => {
            const expanded = !!open[row.id]
            const who = row.recordedBy?.username ?? '—'
            return (
              <article
                key={row.id}
                className={`workJournalCard${expanded ? ' workJournalCardOpen' : ''}`}
              >
                <div className="workJournalCardHead">
                  <button
                    type="button"
                    className="workJournalToggle"
                    onClick={() => toggle(row.id)}
                    aria-expanded={expanded}
                    aria-controls={`journal-detail-${row.id}`}
                    id={`journal-trigger-${row.id}`}
                    aria-label={expanded ? 'Згорнути деталі події' : 'Розгорнути деталі події'}
                    title={expanded ? 'Згорнути' : 'Деталі'}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                  <time className="workJournalCardTime" dateTime={row.at}>
                    {fmtDateTimeCompact(row.at)}
                  </time>
                </div>
                <div className="workJournalCardCore">
                  <div className="workJournalCardLeft">
                    <JournalEventMain row={row} />
                  </div>
                  <dl className="workJournalCardStats">
                    <div className="workJournalStat">
                      <dt>Хто</dt>
                      <dd>{who}</dd>
                    </div>
                    <div className="workJournalStat">
                      <dt>Залишок після</dt>
                      <dd>{remainderShort(tab, row, roundwoodAfter, brusAfter)}</dd>
                    </div>
                  </dl>
                </div>
                {expanded ? (
                  <div
                    className="workJournalCardDetail"
                    id={`journal-detail-${row.id}`}
                    role="region"
                    aria-labelledby={`journal-trigger-${row.id}`}
                  >
                    <span className="srOnly">Усі поля події</span>
                    <DetailDl
                      row={row}
                      tab={tab}
                      roundwoodAfter={roundwoodAfter}
                      brusAfter={brusAfter}
                    />
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
