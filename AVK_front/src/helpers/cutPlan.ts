export type RequestItem = {
  id: number
  length: number
  qty: number
}

export type CutPlanPiece = {
  requestId: number
  length: number
}

export function buildBestCutPlan(
  logLength: number,
  requests: RequestItem[],
  kerf: number,
): CutPlanPiece[] {
  const expanded: CutPlanPiece[] = []
  requests.forEach((req) => {
    for (let i = 0; i < req.qty; i += 1) {
      expanded.push({ requestId: req.id, length: req.length })
    }
  })

  const maxLen = Math.floor(logLength)
  const dp = new Array<number>(maxLen + 1).fill(-1)
  const choice = new Array<number>(maxLen + 1).fill(-1)
  dp[0] = 0

  expanded.forEach((piece, idx) => {
    for (let used = maxLen; used >= 0; used -= 1) {
      if (dp[used] < 0) continue
      const cutLoss = used > 0 ? kerf : 0
      const add = piece.length + cutLoss
      const next = used + add
      if (next <= maxLen) {
        const score = dp[used] + piece.length
        if (score > dp[next]) {
          dp[next] = score
          choice[next] = idx * 100000 + used
        }
      }
    }
  })

  let bestIdx = 0
  let bestScore = 0
  for (let i = 0; i < dp.length; i += 1) {
    if (dp[i] > bestScore) {
      bestScore = dp[i]
      bestIdx = i
    }
  }

  const usedIndexes = new Set<number>()
  const selected: CutPlanPiece[] = []
  let pointer = bestIdx
  while (pointer > 0 && choice[pointer] !== -1) {
    const packed = choice[pointer]
    const prevUsed = packed % 100000
    const pieceIdx = (packed - prevUsed) / 100000
    if (!usedIndexes.has(pieceIdx)) {
      selected.push(expanded[pieceIdx])
      usedIndexes.add(pieceIdx)
    }
    pointer = prevUsed
  }

  return selected.reverse()
}

function subtractPlanFromRequests(requests: RequestItem[], plan: CutPlanPiece[]): RequestItem[] {
  const takeById = new Map<number, number>()
  for (const p of plan) {
    takeById.set(p.requestId, (takeById.get(p.requestId) ?? 0) + 1)
  }
  return requests
    .map((r) => {
      const t = takeById.get(r.id) ?? 0
      const used = Math.min(t, r.qty)
      takeById.set(r.id, t - used)
      return { ...r, qty: r.qty - used }
    })
    .filter((r) => r.qty > 0)
}

export type SequentialBoardCutStep = {
  /** Порядковий номер бруса в черзі (1-based) */
  boardIndex: number
  boardLengthMm: number
  cutPlan: CutPlanPiece[]
}

export type SequentialCutResult = {
  steps: SequentialBoardCutStep[]
  /** Потреба, що лишилась після останнього бруса в списку */
  remainingRequests: RequestItem[]
}

/**
 * Послідовний розкрій: брус 1 → оптимальний набір заготовок, зняти з потреби;
 * брус 2 → залишок потреби, і так далі по черзі.
 */
export function buildSequentialCutPlans(
  boardLengthsMm: number[],
  requests: RequestItem[],
  kerf: number,
): SequentialCutResult {
  let working = requests.map((r) => ({ ...r }))
  const steps: SequentialBoardCutStep[] = []

  for (let i = 0; i < boardLengthsMm.length; i += 1) {
    const len = Math.floor(boardLengthsMm[i]!)
    if (len <= 0) continue
    const clean = working.filter((r) => r.qty > 0)
    const plan =
      clean.length === 0 ? [] : buildBestCutPlan(len, clean, kerf)

    steps.push({
      boardIndex: steps.length + 1,
      boardLengthMm: len,
      cutPlan: plan,
    })

    if (plan.length > 0) {
      working = subtractPlanFromRequests(working, plan)
    }
  }

  return { steps, remainingRequests: working.filter((r) => r.qty > 0) }
}
