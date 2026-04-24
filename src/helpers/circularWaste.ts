/**
 * Смуга після стрічкової пили (ширина ребра), ріжемо на дошки товщиною B з пропилом K між різами.
 * Повертає кількість дощок, використану ширину, суму пропилів і залишок (відходи).
 */
export function computeBoardsAcrossWidth(stripWidthMm: number, boardThicknessMm: number, kerfMm: number) {
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

export type StripCutSegment = { kind: 'board' | 'kerf' | 'waste'; mm: number }

/** Розклад смуги вздовж ширини: дошки, пропили, залишок — для схеми. */
export function layoutStripCutsAcrossWidth(
  stripWidthMm: number,
  boardWidthMm: number,
  kerfMm: number,
): { segments: StripCutSegment[]; boards: number } {
  const W = stripWidthMm
  const B = boardWidthMm
  const K = Math.max(0, kerfMm)
  const segments: StripCutSegment[] = []
  if (!Number.isFinite(W) || W <= 0 || !Number.isFinite(B) || B <= 0) {
    return { segments, boards: 0 }
  }

  let boards = 0
  let used = 0
  while (true) {
    if (boards > 0) {
      if (used + K > W) break
      used += K
      segments.push({ kind: 'kerf', mm: K })
    }
    if (used + B > W) break
    used += B
    boards++
    segments.push({ kind: 'board', mm: B })
  }
  const waste = Math.max(0, W - used)
  if (waste > 0.01) {
    segments.push({ kind: 'waste', mm: waste })
  }
  return { segments, boards }
}

export type MixedCutTarget = { boardWidthMm: number; maxCount: number }

/**
 * Жадібний змішаний поріз: однакова «висота» смуги — послідовно ставимо найширшу дошку, що ще
 * потрібна і вміщається (потім наступну). Не гарантує глобальний оптимум, але дає реалістичний
 * порядок різів для одного проходу по ширині смуги.
 */
export function greedyMixedCutsAcrossWidth(
  stripWidthMm: number,
  targets: MixedCutTarget[],
  kerfMm: number,
): {
  countsByWidth: Map<number, number>
  segments: StripCutSegment[]
  usedMm: number
  wasteMm: number
} {
  const W = stripWidthMm
  const K = Math.max(0, kerfMm)
  const counts = new Map<number, number>()
  const segments: StripCutSegment[] = []

  if (!Number.isFinite(W) || W <= 0 || !targets.length) {
    return { countsByWidth: counts, segments, usedMm: 0, wasteMm: W }
  }

  for (const t of targets) {
    counts.set(t.boardWidthMm, 0)
  }

  const sorted = [...targets].sort((a, b) => b.boardWidthMm - a.boardWidthMm)
  let used = 0
  let placedBoards = 0

  while (true) {
    let placed = false
    for (const t of sorted) {
      const got = counts.get(t.boardWidthMm) ?? 0
      if (got >= t.maxCount) continue
      const needKerf = placedBoards > 0
      const add = (needKerf ? K : 0) + t.boardWidthMm
      if (used + add > W + 1e-6) continue
      if (needKerf) {
        used += K
        segments.push({ kind: 'kerf', mm: K })
      }
      used += t.boardWidthMm
      segments.push({ kind: 'board', mm: t.boardWidthMm })
      counts.set(t.boardWidthMm, got + 1)
      placedBoards += 1
      placed = true
      break
    }
    if (!placed) break
  }

  const wasteMm = Math.max(0, W - used)
  if (wasteMm > 0.01) {
    segments.push({ kind: 'waste', mm: wasteMm })
  }

  return { countsByWidth: counts, segments, usedMm: used, wasteMm }
}

function mixedCutFulfillsAll(
  stripWidthMm: number,
  targets: MixedCutTarget[],
  kerfMm: number,
): boolean {
  const r = greedyMixedCutsAcrossWidth(stripWidthMm, targets, kerfMm)
  for (const t of targets) {
    if ((r.countsByWidth.get(t.boardWidthMm) ?? 0) < t.maxCount) return false
  }
  return true
}

/**
 * Мінімальна ширина смуги (мм), при якій жадібний змішаний поріз уміщує всі бруси з targets.
 * Якщо хорда з плану колоди недоступна — орієнтир для схеми нарізу на багатопилу.
 */
export function minimalStripWidthForMixedDemand(
  targets: MixedCutTarget[],
  kerfMm: number,
): number {
  const active = targets.filter((t) => t.maxCount > 0)
  if (!active.length) return 0
  const K = Math.max(0, kerfMm)
  let lo = Math.max(...active.map((t) => t.boardWidthMm))
  let pieces = 0
  let sumW = 0
  for (const t of active) {
    pieces += t.maxCount
    sumW += t.boardWidthMm * t.maxCount
  }
  let hi = sumW + K * Math.max(0, pieces - 1)
  if (hi < lo) hi = lo

  if (mixedCutFulfillsAll(lo, active, kerfMm)) return Math.ceil(lo)

  let guard = 0
  while (!mixedCutFulfillsAll(hi, active, kerfMm) && guard < 24) {
    hi = Math.ceil(hi * 1.25) + 50
    guard += 1
  }
  if (!mixedCutFulfillsAll(hi, active, kerfMm)) return Math.ceil(hi)

  while (lo + 0.5 < hi) {
    const mid = (lo + hi) / 2
    if (mixedCutFulfillsAll(mid, active, kerfMm)) hi = mid
    else lo = mid
  }
  return Math.ceil(hi)
}

/** Один «налаштування ножів»: однаковий поріз на кількох смугах. */
export type KnifeSetupEntry = {
  /** Короткий опис для робітника */
  setupLabel: string
  /** Скільки смуг пройти з цим налаштуванням */
  stripCount: number
  segments: StripCutSegment[]
  /** Скільки брусів кожної ширини з однієї смуги */
  countsPerStrip: Map<number, number>
  usedMm: number
  wasteMm: number
}

export type MixedKnifePlan = {
  setups: KnifeSetupEntry[]
  /** Схема однієї смуги для першого кроку (найчастіше — змішаний блок) */
  diagramSegments: StripCutSegment[]
  /** Копія жадібного результату для сумісності з таблицею / записом однієї смуги */
  primaryStripCounts: Map<number, number>
  primaryUsedMm: number
  primaryWasteMm: number
}

function segmentsFromOrderedBoardWidths(
  boardWidthsMm: number[],
  kerfMm: number,
  stripWidthMm: number,
): { segments: StripCutSegment[]; usedMm: number; wasteMm: number } {
  const K = Math.max(0, kerfMm)
  const W = stripWidthMm
  const segments: StripCutSegment[] = []
  let used = 0
  for (let i = 0; i < boardWidthsMm.length; i += 1) {
    if (i > 0) {
      used += K
      segments.push({ kind: 'kerf', mm: K })
    }
    const b = boardWidthsMm[i]!
    used += b
    segments.push({ kind: 'board', mm: b })
  }
  const wasteMm = Math.max(0, W - used)
  if (wasteMm > 0.01) segments.push({ kind: 'waste', mm: wasteMm })
  return { segments, usedMm: used, wasteMm }
}

function bestTwoWidthBlockOnStrip(
  stripWidthMm: number,
  wHi: number,
  wLo: number,
  capHi: number,
  capLo: number,
  kerfMm: number,
): { nHi: number; nLo: number } | null {
  const W = stripWidthMm
  const K = Math.max(0, kerfMm)
  let best: { nHi: number; nLo: number; bal: number; tot: number } | null = null
  for (let nHi = 1; nHi <= capHi; nHi += 1) {
    for (let nLo = 1; nLo <= capLo; nLo += 1) {
      const used = nHi * wHi + nLo * wLo + (nHi + nLo - 1) * K
      if (used > W + 1e-9) continue
      const bal = Math.min(nHi, nLo)
      const tot = nHi + nLo
      if (
        !best ||
        bal > best.bal ||
        (bal === best.bal && tot > best.tot) ||
        (bal === best.bal && tot === best.tot && nHi > best.nHi)
      ) {
        best = { nHi, nLo, bal, tot }
      }
    }
  }
  return best ? { nHi: best.nHi, nLo: best.nLo } : null
}

function mapToTargets(dem: Map<number, number>): MixedCutTarget[] {
  return [...dem.entries()]
    .filter(([, q]) => q > 0)
    .map(([boardWidthMm, maxCount]) => ({ boardWidthMm, maxCount }))
    .sort((a, b) => b.boardWidthMm - a.boardWidthMm)
}

/**
 * План порізу з мінімальною кількістю перестановок ножів: однакові смуги групуються в «кроки».
 * Для двох ширин спочатку шукає блок (n×ширша + m×вужча) з максимальним min(n,m), потім залишок — окремі кроки.
 * Для трьох і більше — покроково жадібний поріз однієї смуги, поки є потреба.
 */
export function planMixedCutsMinKnifeSetups(
  stripWidthMm: number,
  targets: MixedCutTarget[],
  kerfMm: number,
): MixedKnifePlan | null {
  const W = stripWidthMm
  const K = Math.max(0, kerfMm)
  if (!Number.isFinite(W) || W <= 0) return null

  const dem = new Map<number, number>()
  for (const t of targets) {
    if (t.maxCount > 0) dem.set(t.boardWidthMm, t.maxCount)
  }
  if (dem.size === 0) return null

  const setups: KnifeSetupEntry[] = []
  let guard = 0

  while (mapToTargets(dem).length > 0) {
    guard += 1
    if (guard > 500) break

    const active = [...dem.entries()]
      .filter(([, q]) => q > 0)
      .sort((a, b) => b[0] - a[0])

    if (active.length === 1) {
      const [w, need] = active[0]!
      const lay = layoutStripCutsAcrossWidth(W, w, K)
      if (lay.boards <= 0) break
      const strips = Math.ceil(need / lay.boards)
      const produced = strips * lay.boards
      const usedInner = lay.segments
        .filter((s) => s.kind === 'board' || s.kind === 'kerf')
        .reduce((s, x) => s + x.mm, 0)
      const wasteInner = Math.max(0, W - usedInner)
      setups.push({
        setupLabel: `${lay.boards}×${w} мм`,
        stripCount: strips,
        segments: lay.segments,
        countsPerStrip: new Map([[w, lay.boards]]),
        usedMm: usedInner,
        wasteMm: wasteInner,
      })
      dem.set(w, Math.max(0, need - produced))
      continue
    }

    if (active.length === 2) {
      const [wHi, qHi] = active[0]!
      const [wLo, qLo] = active[1]!
      const pat = bestTwoWidthBlockOnStrip(W, wHi, wLo, qHi, qLo, K)
      if (pat) {
        const k = Math.min(Math.floor(qHi / pat.nHi), Math.floor(qLo / pat.nLo))
        if (k > 0) {
          const widths: number[] = []
          for (let i = 0; i < pat.nHi; i += 1) widths.push(wHi)
          for (let i = 0; i < pat.nLo; i += 1) widths.push(wLo)
          const { segments, usedMm, wasteMm } = segmentsFromOrderedBoardWidths(widths, K, W)
          setups.push({
            setupLabel: `${pat.nHi}×${wHi} + ${pat.nLo}×${wLo} мм`,
            stripCount: k,
            segments,
            countsPerStrip: new Map([
              [wHi, pat.nHi],
              [wLo, pat.nLo],
            ]),
            usedMm,
            wasteMm,
          })
          dem.set(wHi, qHi - k * pat.nHi)
          dem.set(wLo, qLo - k * pat.nLo)
          continue
        }
      }
    }

    const g = greedyMixedCutsAcrossWidth(W, mapToTargets(dem), K)
    let placed = 0
    for (const c of g.countsByWidth.values()) placed += c
    if (placed === 0) break

    const usedInner = g.usedMm
    const wasteInner = g.wasteMm
    setups.push({
      setupLabel: 'змішано (1 смуга за прохід)',
      stripCount: 1,
      segments: g.segments,
      countsPerStrip: new Map(g.countsByWidth),
      usedMm: usedInner,
      wasteMm: wasteInner,
    })
    for (const [bw, got] of g.countsByWidth) {
      dem.set(bw, Math.max(0, (dem.get(bw) ?? 0) - got))
    }
  }

  if (setups.length === 0) return null

  const first = setups[0]!
  return {
    setups,
    diagramSegments: first.segments,
    primaryStripCounts: new Map(first.countsPerStrip),
    primaryUsedMm: first.usedMm,
    primaryWasteMm: first.wasteMm,
  }
}

/** Обгортка під існуючі виклики: один «рядок» як після greedyMixedCutsAcrossWidth. */
export function mixedCutsResultFromKnifePlan(plan: MixedKnifePlan): {
  countsByWidth: Map<number, number>
  segments: StripCutSegment[]
  usedMm: number
  wasteMm: number
} {
  return {
    countsByWidth: new Map(plan.primaryStripCounts),
    segments: plan.diagramSegments,
    usedMm: plan.primaryUsedMm,
    wasteMm: plan.primaryWasteMm,
  }
}
