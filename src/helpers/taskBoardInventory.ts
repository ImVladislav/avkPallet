import type { WorkTask } from '../types/task'
import type { OrderLine } from './parseForemanOrders'
import { orderLengthMmForThicknessAndBoardWidth } from './parseForemanOrders'

export type TaskBoardFromInventoryRow = {
  id: string
  n: number
  thicknessMm: number
  widthMm: number
  /** Довжина заготовки за текстом замовлення (мм), якщо знайдено відповідний рядок */
  orderLengthMm: number | null
  /** Довжини смуг, списаних у цьому записі розпилу ст.2 (мм), по одній на кожну смугу */
  stripFactLengthsMm: number[]
  /** Короткий підпис для колонки: одне число або кілька через « / » */
  stripLengthsLabel: string
  /** Орієнтир для поля «довжина бруса»: мінімум серед смуг цього запису (консервативно) */
  stripLengthPrimaryMm: number
  cutRecordedAt: string
}

type StripQueue = { logLengthMm: number; qty: number }[]

function buildInitialStripQueues(task: WorkTask): Map<number, StripQueue> {
  const byTh = new Map<number, StripQueue>()
  const inv = [...(task.stripInventory ?? [])].sort((a, b) =>
    String(a.recordedAt).localeCompare(String(b.recordedAt)),
  )
  for (const e of inv) {
    const th = Math.round(Number(e.thicknessMm))
    const q = Math.round(Number(e.qty))
    const L = Math.round(Number(e.logLengthMm))
    if (!Number.isFinite(th) || th <= 0 || !Number.isFinite(q) || q <= 0 || !Number.isFinite(L) || L <= 0)
      continue
    if (!byTh.has(th)) byTh.set(th, [])
    byTh.get(th)!.push({ logLengthMm: L, qty: q })
  }
  return byTh
}

function popStripLengths(
  queueByTh: Map<number, StripQueue>,
  thicknessMm: number,
  stripQty: number,
): number[] {
  const th = Math.round(thicknessMm)
  const q = queueByTh.get(th)
  const lengths: number[] = []
  let need = Math.max(0, Math.round(stripQty))
  if (!q || q.length === 0) {
    return Array.from({ length: need }, () => 0)
  }
  while (need > 0) {
    if (q.length === 0) {
      lengths.push(lengths[lengths.length - 1] ?? 0)
      need -= 1
      continue
    }
    const head = q[0]!
    if (head.qty <= 0) {
      q.shift()
      continue
    }
    head.qty -= 1
    lengths.push(head.logLengthMm)
    need -= 1
    if (head.qty <= 0) q.shift()
  }
  return lengths
}

function formatStripLengthsLabel(lengths: number[]): string {
  const pos = lengths.filter((x) => x > 0)
  if (pos.length === 0) return '—'
  const uniq = [...new Set(pos)]
  if (uniq.length === 1) return String(uniq[0])
  return pos.join(' / ')
}

function primaryLengthFromStrips(lengths: number[]): number {
  const pos = lengths.filter((x) => x > 0)
  if (pos.length === 0) return 0
  return Math.min(...pos)
}

/**
 * Розгортає записи розпилу станка 2 у список окремих брусів: товщина, ширина, довжина за замовленням,
 * фактична довжина смуги (зі складу після ленточної, FIFO по журналу смуг).
 */
export function boardsFromTaskStripCuts(
  task: WorkTask,
  orderLines: OrderLine[] | null,
): TaskBoardFromInventoryRow[] {
  const cuts = [...(task.stripSaw?.cuts ?? [])].sort((a, b) =>
    String(a.recordedAt).localeCompare(String(b.recordedAt)),
  )
  if (cuts.length === 0) return []

  const queueByTh = buildInitialStripQueues(task)
  const out: TaskBoardFromInventoryRow[] = []
  let n = 0

  for (let ci = 0; ci < cuts.length; ci += 1) {
    const cut = cuts[ci]!
    const th = Math.round(Number(cut.thicknessMm))
    const stripQty = Math.round(Number(cut.stripQty))
    if (!Number.isFinite(th) || th <= 0) continue

    const stripLens = popStripLengths(queueByTh, th, stripQty)
    const stripLabel = formatStripLengthsLabel(stripLens)
    const primaryLen = primaryLengthFromStrips(stripLens)

    const circ = task.plan?.circular?.find((c) => Math.round(Number(c.thicknessMm)) === th)
    const fallbackW =
      circ?.avgBoardWidthMm != null && Number.isFinite(circ.avgBoardWidthMm)
        ? Math.round(circ.avgBoardWidthMm)
        : null

    const widthBuckets: { w: number; q: number }[] = []
    const byW = cut.boardsByWidthMm
    if (byW && typeof byW === 'object' && !Array.isArray(byW)) {
      for (const [k, v] of Object.entries(byW)) {
        const w = Math.round(Number(k))
        const qn = Math.round(Number(v))
        if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(qn) || qn <= 0) continue
        widthBuckets.push({ w, q: qn })
      }
      widthBuckets.sort((a, b) => b.w - a.w)
    }

    if (widthBuckets.length === 0) {
      const bt = Math.round(Number(cut.boardsTotal))
      if (!Number.isFinite(bt) || bt <= 0 || fallbackW == null || fallbackW <= 0) continue
      widthBuckets.push({ w: fallbackW, q: bt })
    }

    for (const bucket of widthBuckets) {
      for (let i = 0; i < bucket.q; i += 1) {
        n += 1
        const orderL =
          orderLines && orderLines.length > 0
            ? orderLengthMmForThicknessAndBoardWidth(orderLines, th, bucket.w)
            : null
        out.push({
          id: `${cut.recordedAt}-${ci}-${bucket.w}-${i}`,
          n,
          thicknessMm: th,
          widthMm: bucket.w,
          orderLengthMm: orderL,
          stripFactLengthsMm: stripLens,
          stripLengthsLabel: stripLabel,
          stripLengthPrimaryMm: primaryLen,
          cutRecordedAt: cut.recordedAt,
        })
      }
    }
  }

  return out
}
