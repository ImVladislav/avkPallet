import type { LogItem } from '../types/roundwood'
import type { OrderLine } from './parseForemanOrders'
import { buildForemanPlan } from './foremanPlan'

const R_MAX = 6000

function radiusFits(lines: OrderLine[], R: number, kerfBand: number, kerfCirc: number): boolean {
  const plan = buildForemanPlan(lines, R, kerfBand, kerfCirc)
  if (plan.band.length === 0) return false
  return plan.band.every((b) => b.boardsFromOneCrossSection > 0)
}

/** Мінімальний радіус (мм), при якому торець ще дає смуги під усі товщини в замовленні. */
export function minRadiusMmForOrder(
  lines: OrderLine[],
  kerfBandMm: number,
  kerfCircMm: number,
): number | null {
  let lo = 1
  let hi = R_MAX
  let ans: number | null = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (radiusFits(lines, mid, kerfBandMm, kerfCircMm)) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

export function estimateMinLogLengthMm(lines: OrderLine[], kerfBandMm: number): number {
  const kb = Math.max(0, kerfBandMm)
  let sumPieces = 0
  let sumQtyLen = 0
  for (const o of lines) {
    sumPieces += o.qty
    sumQtyLen += o.qty * Math.max(0, o.lengthMm)
  }
  const kerfAlong = sumPieces > 1 ? (sumPieces - 1) * kb : 0
  return sumQtyLen + kerfAlong
}

export type PickLogResult =
  | {
      ok: true
      log: LogItem
      minRadiusMm: number
      minLengthMm: number
    }
  | { ok: false; reason: string }

/** Спочатку найбільша підходяща колода (R, потім L), без пріоритету менших розмірів. */
export function pickBestLog(
  logs: LogItem[],
  lines: OrderLine[],
  kerfBandMm: number,
  kerfCircMm: number,
): PickLogResult {
  const minR = minRadiusMmForOrder(lines, kerfBandMm, kerfCircMm)
  if (minR == null) {
    return {
      ok: false,
      reason: 'Неможливо підібрати радіус: перевірте товщини дощок (занадто великі для розумного кола).',
    }
  }
  const minL = estimateMinLogLengthMm(lines, kerfBandMm)
  const candidates = logs.filter((l) => l.radius >= minR && l.length >= minL)
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `Потрібно: R ≥ ${minR} мм, довжина колоди ≥ ${Math.ceil(minL)} мм. У базі немає такої колоди — додайте на сторінці «Прийом кругляка».`,
    }
  }
  candidates.sort((a, b) => {
    const dr = b.radius - a.radius
    if (dr !== 0) return dr
    return b.length - a.length
  })
  return { ok: true, log: candidates[0], minRadiusMm: minR, minLengthMm: minL }
}
