import { buildCrossSectionRows } from './crossSection.js'
import { computeBoardsAcrossWidth } from './circularWaste.js'
import { mergeOrderLines, crossSectionMmFromDimensionRow } from './parseForemanOrders.js'
import { workpiecesAlongOneLog } from './alongLogPlan.js'

const DEFAULT_REFERENCE_LOG_LENGTH_MM = 4000

function alongLogFromOrders(orders, kerfCircularMm, referenceLogLengthMm = DEFAULT_REFERENCE_LOG_LENGTH_MM) {
  const kc = Math.max(0, kerfCircularMm)
  const refL = Math.max(1, Math.round(referenceLogLengthMm))
  let totalPieces = 0
  let sumQtyTimesLengthMm = 0
  const byLen = new Map()
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

export function buildForemanPlan(orders, radiusMm, kerfBandMm, kerfCircularMm) {
  const byTh = new Map()

  for (const o of orders) {
    const t = Math.round(o.aMm)
    const w = Math.round(o.bMm)
    if (!byTh.has(t)) byTh.set(t, [])
    byTh.get(t).push({ qty: o.qty, widthMm: w })
  }

  const band = []
  const circular = []
  const sortedT = [...byTh.keys()].sort((a, b) => b - a)

  for (const thicknessMm of sortedT) {
    const items = byTh.get(thicknessMm)
    const qtyNeeded = items.reduce((s, x) => s + x.qty, 0)
    let wSum = 0
    for (const it of items) wSum += it.widthMm * it.qty
    const avgBoardWidthMm = qtyNeeded > 0 ? wSum / qtyNeeded : thicknessMm

    const rows = buildCrossSectionRows(radiusMm, thicknessMm, kerfBandMm)
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
      avgChordMm,
      avgBoardWidthMm,
      circularCutsPerCrossSection,
      circularCutsTotalEstimate: circularCutsPerCrossSection * Math.max(1, crossSectionsNeeded),
    })
  }

  return { band, circular, alongLog: alongLogFromOrders(orders, kerfCircularMm) }
}

function minChordAcrossBandRows(radiusMm, stripThicknessMm, kerfBandMm) {
  const rows = buildCrossSectionRows(radiusMm, stripThicknessMm, kerfBandMm)
  if (!rows.length) return 0
  return Math.min(...rows.map((r) => r.chord))
}

/**
 * Побічні рядки без кількості в `dimensionRows` → додаткові лінії плану, якщо вміщуються
 * (надлишок торця або залишок ширини ряду після основних різів).
 */
export function mergeOpenSecondaryDimensionRowsIntoPlanOrders(
  baseLines,
  dimensionRows,
  unit,
  radiusMm,
  kerfBandMm,
  kerfCircularMm,
) {
  if (!dimensionRows?.length) return mergeOrderLines(baseLines)

  const plan0 = buildForemanPlan(baseLines, radiusMm, kerfBandMm, kerfCircularMm)
  const spareByTh = new Map()
  for (const b of plan0.band) {
    spareByTh.set(Math.round(b.thicknessMm), Math.max(0, Math.round(b.overshootBoards ?? 0)))
  }

  const dominantL = Math.max(0, Math.round(plan0.alongLog.dominantLengthMm ?? 0))
  const kc = Math.max(0, kerfCircularMm)
  const added = []
  const wasteRowKeysUsed = new Set()

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

    const tryPlace = (T, W) => {
      const th = Math.round(T)
      const w = Math.round(W)
      if (th <= 0 || w <= 0) return false

      const bandT = plan0.band.find((b) => Math.round(b.thicknessMm) === th)
      const circT = plan0.circular.find((c) => Math.round(c.thicknessMm) === th)
      if (!bandT || bandT.feasible === false || !circT) return false

      const minChord = minChordAcrossBandRows(radiusMm, th, kerfBandMm)
      if (minChord <= 0) return false
      if (computeBoardsAcrossWidth(minChord, w, kc).boards < 1) return false

      const spare = spareByTh.get(th) ?? 0
      if (spare >= 1) {
        added.push({ qty: 1, aMm: th, bMm: w, lengthMm })
        spareByTh.set(th, spare - 1)
        return true
      }

      const B = Math.max(1, Math.round(circT.avgBoardWidthMm))
      const rows = buildCrossSectionRows(radiusMm, th, kerfBandMm)
      for (let i = 0; i < rows.length; i++) {
        const key = `${th}|${i}`
        if (wasteRowKeysUsed.has(key)) continue
        const { wasteMm } = computeBoardsAcrossWidth(rows[i].chord, B, kc)
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
