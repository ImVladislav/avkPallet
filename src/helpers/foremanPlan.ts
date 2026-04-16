import { buildCrossSectionRows, type BandCrossFitMode } from './crossSection'
import { computeBoardsAcrossWidth } from './circularWaste'
import type { OrderLine } from './parseForemanOrders'

export type BandThicknessPlan = {
  thicknessMm: number
  qtyNeeded: number
  /** Смуги (заготовки після ленточної), уже зняті по завданню */
  qtyDone?: number
  rowsAlongDiameter: number
  boardsFromOneCrossSection: number
  /** Скільки повних «торців» колоди (перерізів по довжині) треба, щоб набрати кількість дощок */
  crossSectionsNeeded: number
  /** Рядів смуг по висоті кола (етап ленточної по торцю) */
  rowsAlongHeight: number
  /** Чи вміщається хоч одна дошка цієї товщини в торці при даному R */
  feasible?: boolean
  /** Надлишок дощок після ceil(кількість/з торця): мінімізація відходів */
  overshootBoards?: number
}

export type CircularThicknessPlan = {
  thicknessMm: number
  qtyNeeded: number
  /** Готові дошки (бруси) після нарізу поперек смуги на станку 2 */
  qtyDone?: number
  /** Середня ширина смуги (хорда) по рядах — для оцінки нарізу */
  avgChordMm: number
  /** Середня ширина дошки з замовлення (вагове середнє) */
  avgBoardWidthMm: number
  /** Пропилів циркулярки на один повний переріз (усі ряди торця) */
  circularCutsPerCrossSection: number
  /** Оцінка всього пропилів циркулярки */
  circularCutsTotalEstimate: number
}

export type AlongLogEstimate = {
  totalPieces: number
  sumQtyTimesLengthMm: number
  kerfAlongLogMm: number
  /** Мінімальна довжина колоди вздовж осі (оцінка, з пропилами між заготовками) */
  minLogLengthMm: number
}

function alongLogFromOrders(orders: OrderLine[], kerfBandMm: number): AlongLogEstimate {
  const kb = Math.max(0, kerfBandMm)
  let totalPieces = 0
  let sumQtyTimesLengthMm = 0
  for (const o of orders) {
    totalPieces += o.qty
    const len = o.lengthMm ?? 0
    sumQtyTimesLengthMm += o.qty * Math.max(0, len)
  }
  const kerfAlongLogMm = totalPieces > 1 ? (totalPieces - 1) * kb : 0
  return {
    totalPieces,
    sumQtyTimesLengthMm,
    kerfAlongLogMm,
    minLogLengthMm: sumQtyTimesLengthMm + kerfAlongLogMm,
  }
}

export function buildForemanPlan(
  orders: OrderLine[],
  radiusMm: number,
  kerfBandMm: number,
  kerfCircularMm: number,
  bandCrossFit: BandCrossFitMode = 'min_waste',
): {
  band: BandThicknessPlan[]
  circular: CircularThicknessPlan[]
  alongLog: AlongLogEstimate
} {
  const byTh = new Map<number, { qty: number; widthMm: number }[]>()

  for (const o of orders) {
    const t = Math.round(o.aMm)
    const w = Math.round(o.bMm)
    if (!byTh.has(t)) byTh.set(t, [])
    byTh.get(t)!.push({ qty: o.qty, widthMm: w })
  }

  const band: BandThicknessPlan[] = []
  const circular: CircularThicknessPlan[] = []

  const sortedT = [...byTh.keys()].sort((a, b) => b - a)

  for (const thicknessMm of sortedT) {
    const items = byTh.get(thicknessMm)!
    const qtyNeeded = items.reduce((s, x) => s + x.qty, 0)
    let wSum = 0
    for (const it of items) wSum += it.widthMm * it.qty
    const avgBoardWidthMm = qtyNeeded > 0 ? wSum / qtyNeeded : thicknessMm

    const rows = buildCrossSectionRows(radiusMm, thicknessMm, kerfBandMm, bandCrossFit)
    const boardsFromOneCrossSection = rows.reduce((s, r) => s + r.boards, 0)
    const feasible = boardsFromOneCrossSection > 0
    const crossSectionsNeeded = feasible
      ? Math.ceil(qtyNeeded / boardsFromOneCrossSection)
      : 0
    const overshootBoards = feasible
      ? boardsFromOneCrossSection * crossSectionsNeeded - qtyNeeded
      : 0

    let circularCutsPerCrossSection = 0
    let chordSum = 0
    for (const row of rows) {
      chordSum += row.chord
      const cut = computeBoardsAcrossWidth(row.chord, avgBoardWidthMm, kerfCircularMm)
      if (cut.boards > 1) circularCutsPerCrossSection += cut.boards - 1
    }

    const avgChordMm = rows.length > 0 ? chordSum / rows.length : 0

    band.push({
      thicknessMm,
      qtyNeeded,
      qtyDone: 0,
      rowsAlongDiameter: rows.length,
      boardsFromOneCrossSection,
      crossSectionsNeeded,
      rowsAlongHeight: rows.length,
      feasible,
      overshootBoards,
    })

    circular.push({
      thicknessMm,
      qtyNeeded,
      qtyDone: 0,
      avgChordMm,
      avgBoardWidthMm,
      circularCutsPerCrossSection,
      circularCutsTotalEstimate: circularCutsPerCrossSection * Math.max(1, crossSectionsNeeded),
    })
  }

  return { band, circular, alongLog: alongLogFromOrders(orders, kerfBandMm) }
}

/** Перерахунок плану ленточної під фактичний радіус колоди (на екрані розпиловщика). */
export function recomputeBandPlanForRadius(
  radiusMm: number,
  kerfBandMm: number,
  band: BandThicknessPlan[],
  bandCrossFit: BandCrossFitMode = 'min_waste',
): BandThicknessPlan[] {
  return band.map((b) => {
    const rows = buildCrossSectionRows(radiusMm, b.thicknessMm, kerfBandMm, bandCrossFit)
    const boardsFromOneCrossSection = rows.reduce((s, r) => s + r.boards, 0)
    const feasible = boardsFromOneCrossSection > 0
    const qtyDone = b.qtyDone ?? 0
    const remaining = Math.max(0, b.qtyNeeded - qtyDone)
    const crossSectionsNeeded =
      feasible && remaining > 0 ? Math.ceil(remaining / boardsFromOneCrossSection) : 0
    const overshootBoards =
      feasible && remaining > 0
        ? boardsFromOneCrossSection * crossSectionsNeeded - remaining
        : 0
    return {
      ...b,
      rowsAlongDiameter: rows.length,
      boardsFromOneCrossSection,
      crossSectionsNeeded,
      rowsAlongHeight: rows.length,
      feasible,
      overshootBoards,
    }
  })
}

function bandFeasible(b: BandThicknessPlan): boolean {
  if (b.feasible === false) return false
  if (b.feasible === true) return true
  return (b.boardsFromOneCrossSection ?? 0) > 0
}

/** Скільки смуг цієї товщини ще треба зняти за планом (не нижче нуля). */
export function bandRemainingQty(b: BandThicknessPlan): number {
  return Math.max(0, b.qtyNeeded - (b.qtyDone ?? 0))
}

/** Менше перерізів по довжині колоди, потім менший надлишок дощок на торці. Закриті позиції — в кінці. */
export function sortBandByLeastWaste(band: BandThicknessPlan[]): BandThicknessPlan[] {
  return [...band].sort((a, b) => {
    const remA = bandRemainingQty(a)
    const remB = bandRemainingQty(b)
    if ((remA === 0) !== (remB === 0)) return remA === 0 ? 1 : -1

    if (bandFeasible(a) !== bandFeasible(b)) return bandFeasible(a) ? -1 : 1
    const ca = a.crossSectionsNeeded ?? 0
    const cb = b.crossSectionsNeeded ?? 0
    if (ca !== cb) return ca - cb
    const oa = a.overshootBoards ?? 0
    const ob = b.overshootBoards ?? 0
    if (oa !== ob) return oa - ob
    return a.thicknessMm - b.thicknessMm
  })
}

/**
 * Порядок різання на одній колоді: спочатку зовнішні (товстіші) смуги, далі тонші — типово для
 * знімання шарів до центру. Позиції без залишку за планом не включаються (шар уже знятий).
 */
export function bandPhysicalCutOrderThicknesses(band: BandThicknessPlan[]): BandThicknessPlan[] {
  const active = band.filter((b) => bandRemainingQty(b) > 0)
  return [...active].sort((a, b) => {
    if (bandFeasible(a) !== bandFeasible(b)) return bandFeasible(a) ? -1 : 1
    return b.thicknessMm - a.thicknessMm
  })
}
