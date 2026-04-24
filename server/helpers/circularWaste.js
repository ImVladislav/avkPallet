export function computeBoardsAcrossWidth(stripWidthMm, boardThicknessMm, kerfMm) {
  const W = stripWidthMm
  const B = boardThicknessMm
  const K = Math.max(0, kerfMm)
  if (!Number.isFinite(W) || W <= 0 || !Number.isFinite(B) || B <= 0) {
    return { boards: 0, usedMm: 0, kerfLossMm: 0, wasteMm: 0 }
  }

  let boards = 0
  let used = 0
  let kerfLoss = 0

  while (true) {
    if (boards > 0) {
      if (used + K > W) break
      used += K
      kerfLoss += K
    }
    if (used + B > W) break
    used += B
    boards++
  }

  return {
    boards,
    usedMm: used,
    kerfLossMm: kerfLoss,
    wasteMm: Math.max(0, W - used),
  }
}
