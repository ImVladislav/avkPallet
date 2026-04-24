import { buildCrossSectionRows } from './crossSection.js'
import { computeBoardsAcrossWidth } from './circularWaste.js'

function alongLogFromOrders(orders, kerfBandMm) {
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

  return { band, circular, alongLog: alongLogFromOrders(orders, kerfBandMm) }
}
