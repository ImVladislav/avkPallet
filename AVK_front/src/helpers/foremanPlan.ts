import { buildCrossSectionRows, type BandCrossFitMode } from './crossSection'
import { computeBoardsAcrossWidth } from './circularWaste'
import type { DimensionRowInput, OrderLine } from './parseForemanOrders'
import { crossSectionMmFromDimensionRow, mergeOrderLines } from './parseForemanOrders'
import { workpiecesAlongOneLog } from './alongLogPieces'

export type BandThicknessPlan = {
  thicknessMm: number
  qtyNeeded: number
  /** Смуги (заготовки після стрічкової пили), уже зняті по завданню */
  qtyDone?: number
  rowsAlongDiameter: number
  boardsFromOneCrossSection: number
  /** Скільки повних «торців» колоди (перерізів по довжині) треба, щоб набрати кількість дощок */
  crossSectionsNeeded: number
  /** Рядів смуг по висоті кола (етап стрічкової пили по торцю) */
  rowsAlongHeight: number
  /** Чи вміщається хоч одна дошка цієї товщини в торці при даному R */
  feasible?: boolean
  /** Надлишок дощок після ceil(кількість/з торця): мінімізація відходів */
  overshootBoards?: number
}

export type CircularThicknessPlan = {
  thicknessMm: number
  qtyNeeded: number
  /** Готові дошки (бруси) після нарізу поперек смуги на багатопилі */
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

export const DEFAULT_REFERENCE_LOG_LENGTH_MM = 4000

export type AlongLogEstimate = {
  totalPieces: number
  sumQtyTimesLengthMm: number
  /** Пропили циркулярки між заготовками, якщо уявно різати всі деталі послід на одній «нескінченній» смузі */
  kerfAlongLogMm: number
  /**
   * Довжина смуги при послідовному нарізі всіх деталей підряд (довідково, не модель реальної колоди).
   */
  minLogLengthMm: number
  /** Найчастіша довжина деталі (мм) */
  dominantLengthMm: number
  /** Еталон L смуги/колоди для оцінки (мм) */
  referenceLogLengthMm: number
  /** Скільки деталей домінантної довжини вміщається в `referenceLogLengthMm` */
  piecesPerStripFromRefLog: number
  /** Орієнтовна кількість смуг, якщо фактична L≈referenceLogLengthMm (по кожній довжині окремо) */
  stripsNeededForRefLog: number
  /** Скільки різних довжин у замовленні */
  lengthGroupsCount: number
}

function alongLogFromOrders(
  orders: OrderLine[],
  kerfCircularMm: number,
  referenceLogLengthMm: number = DEFAULT_REFERENCE_LOG_LENGTH_MM,
): AlongLogEstimate {
  const kc = Math.max(0, kerfCircularMm)
  const refL = Math.max(1, Math.round(referenceLogLengthMm))
  let totalPieces = 0
  let sumQtyTimesLengthMm = 0
  const byLen = new Map<number, number>()
  for (const o of orders) {
    totalPieces += o.qty
    const len = Math.max(0, Math.round(o.lengthMm ?? 0))
    sumQtyTimesLengthMm += o.qty * len
    if (len > 0) byLen.set(len, (byLen.get(len) ?? 0) + o.qty)
  }
  const kerfAlongLogMm = totalPieces > 1 ? (totalPieces - 1) * kc : 0
  const minLogLengthMm = sumQtyTimesLengthMm + kerfAlongLogMm

  let dominantLengthMm = 0
  let bestQ = -1
  for (const [L, q] of byLen) {
    if (q > bestQ || (q === bestQ && L > dominantLengthMm)) {
      bestQ = q
      dominantLengthMm = L
    }
  }

  let stripsNeededForRefLog = 0
  let piecesPerStripFromRefLog = 0
  if (totalPieces <= 0) {
    // leave zeros
  } else if (byLen.size === 0) {
    stripsNeededForRefLog = totalPieces
    piecesPerStripFromRefLog = 1
  } else {
    for (const [L, q] of byLen) {
      const perStrip = Math.max(1, workpiecesAlongOneLog(refL, L, kc))
      stripsNeededForRefLog += Math.ceil(q / perStrip)
    }
    if (dominantLengthMm > 0) {
      piecesPerStripFromRefLog = Math.max(1, workpiecesAlongOneLog(refL, dominantLengthMm, kc))
    }
  }

  return {
    totalPieces,
    sumQtyTimesLengthMm,
    kerfAlongLogMm,
    minLogLengthMm,
    dominantLengthMm,
    referenceLogLengthMm: refL,
    piecesPerStripFromRefLog,
    stripsNeededForRefLog,
    lengthGroupsCount: byLen.size,
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

  return { band, circular, alongLog: alongLogFromOrders(orders, kerfCircularMm) }
}

function minChordAcrossBandRows(
  radiusMm: number,
  stripThicknessMm: number,
  kerfBandMm: number,
  fit: BandCrossFitMode = 'min_waste',
): number {
  const rows = buildCrossSectionRows(radiusMm, stripThicknessMm, kerfBandMm, fit)
  if (!rows.length) return 0
  return Math.min(...rows.map((r) => r.chord))
}

/**
 * Додає в лінії замовлення для плану побічні рядки без кількості, якщо вони вміщуються після розкладу основних:
 * спочатку «надлишкові» слоти торця, інакше — залишок ширини ряду (відходи) під ширину побічної дошки.
 */
export function mergeOpenSecondaryDimensionRowsIntoPlanOrders(
  baseLines: OrderLine[],
  dimensionRows: DimensionRowInput[] | undefined,
  unit: 'mm' | 'cm',
  radiusMm: number,
  kerfBandMm: number,
  kerfCircularMm: number,
  bandCrossFit: BandCrossFitMode = 'min_waste',
): OrderLine[] {
  if (!dimensionRows?.length) return mergeOrderLines(baseLines)

  const plan0 = buildForemanPlan(baseLines, radiusMm, kerfBandMm, kerfCircularMm, bandCrossFit)
  const spareByTh = new Map<number, number>()
  for (const b of plan0.band) {
    spareByTh.set(Math.round(b.thicknessMm), Math.max(0, Math.round(b.overshootBoards ?? 0)))
  }

  const dominantL = Math.max(0, Math.round(plan0.alongLog.dominantLengthMm ?? 0))
  const kc = Math.max(0, kerfCircularMm)
  const added: OrderLine[] = []
  const wasteRowKeysUsed = new Set<string>()

  for (const r of dimensionRows) {
    const rowKind = r.kind === 'secondary' ? 'secondary' : 'main'
    if (rowKind !== 'secondary' || String(r.qty ?? '').trim() !== '') continue

    const cs = crossSectionMmFromDimensionRow(r, unit)
    if (!cs) continue

    const rawL = Number(String(r.length ?? '').replace(',', '.'))
    let lengthMm = 0
    if (Number.isFinite(rawL) && String(r.length ?? '').trim() !== '') {
      lengthMm = unit === 'cm' ? Math.round(rawL * 10) : Math.round(rawL)
    }
    if (lengthMm <= 0) lengthMm = dominantL

    const tryPlace = (T: number, W: number): boolean => {
      const th = Math.round(T)
      const w = Math.round(W)
      if (th <= 0 || w <= 0) return false

      const bandT = plan0.band.find((b) => Math.round(b.thicknessMm) === th)
      const circT = plan0.circular.find((c) => Math.round(c.thicknessMm) === th)
      if (!bandT || bandT.feasible === false || !circT) return false

      const minChord = minChordAcrossBandRows(radiusMm, th, kerfBandMm, bandCrossFit)
      if (minChord <= 0) return false
      if (computeBoardsAcrossWidth(minChord, w, kc).boards < 1) return false

      const spare = spareByTh.get(th) ?? 0
      if (spare >= 1) {
        added.push({ qty: 1, aMm: th, bMm: w, lengthMm })
        spareByTh.set(th, spare - 1)
        return true
      }

      const B = Math.max(1, Math.round(circT.avgBoardWidthMm))
      const rows = buildCrossSectionRows(radiusMm, th, kerfBandMm, bandCrossFit)
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        const key = `${th}|${i}`
        if (wasteRowKeysUsed.has(key)) continue
        const { wasteMm } = computeBoardsAcrossWidth(row.chord, B, kc)
        if (wasteMm + 0.5 < w) continue
        wasteRowKeysUsed.add(key)
        added.push({ qty: 1, aMm: th, bMm: w, lengthMm })
        return true
      }

      return false
    }

    if (tryPlace(cs.aMm, cs.bMm)) continue
    tryPlace(cs.bMm, cs.aMm)
  }

  return mergeOrderLines([...baseLines, ...added])
}

/** Перерахунок плану стрічкової пили під фактичний радіус колоди (на екрані розпиловщика). */
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
