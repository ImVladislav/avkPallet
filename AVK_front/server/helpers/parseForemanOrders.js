function toMm(n, unit) {
  return unit === 'cm' ? Math.round(n * 10) : Math.round(n)
}

function secondCrossSectionMm(firstRaw, secondRaw, lineUnit, taskUnitDefault) {
  const hMm = toMm(firstRaw, lineUnit)
  const wIfSameUnit = toMm(secondRaw, lineUnit)
  if (
    taskUnitDefault === 'cm' &&
    lineUnit === 'cm' &&
    wIfSameUnit > hMm * 1.75 &&
    secondRaw >= 35 &&
    secondRaw <= 200
  ) {
    return Math.round(secondRaw)
  }
  return wIfSameUnit
}

function mergeOrderLines(lines) {
  const map = new Map()
  for (const l of lines) {
    const aMm = Math.round(l.aMm)
    const bMm = Math.round(l.bMm)
    const L = Math.round(l.lengthMm)
    const key = `${aMm}|${bMm}|${L}`
    const prev = map.get(key)
    if (prev) {
      prev.qty += l.qty
    } else {
      map.set(key, { qty: l.qty, aMm, bMm, lengthMm: l.lengthMm })
    }
  }
  return [...map.values()].sort((x, y) => {
    if (x.aMm !== y.aMm) return y.aMm - x.aMm
    if (x.bMm !== y.bMm) return y.bMm - x.bMm
    return y.lengthMm - x.lengthMm
  })
}

function parseOneLine(line, unitDefault) {
  let unit = unitDefault
  if (/\bсм\b/i.test(line)) unit = 'cm'
  if (/\bмм\b/i.test(line)) unit = 'mm'

  const cleaned = line
    .replace(/шт\.?/gi, '')
    .replace(/[×xх]/gi, ' ')
    .replace(/на/gi, ' ')
    .replace(/(мм|см)\b/gi, '')
    .trim()

  const nums = cleaned.match(/-?\d+(?:[.,]\d+)?/g)
  if (!nums || nums.length < 3) {
    return {
      ok: false,
      error: 'очікується: кількість, висота, ширина та за бажанням довжина (мм), напр. 4 50 50 1200',
    }
  }

  const n1 = Number(nums[1].replace(',', '.'))
  const n2 = Number(nums[2].replace(',', '.'))
  const qty = Math.round(Number(nums[0].replace(',', '.')))
  const a = toMm(n1, unit)
  const b = secondCrossSectionMm(n1, n2, unit, unitDefault)
  const lengthMm = nums.length >= 4 ? toMm(Number(nums[3].replace(',', '.')), unit) : 0

  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'кількість має бути > 0' }
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return { ok: false, error: 'розміри мають бути додатні' }
  }
  if (nums.length >= 4 && (!Number.isFinite(lengthMm) || lengthMm <= 0)) {
    return { ok: false, error: 'довжина має бути > 0, якщо вказана' }
  }

  return { ok: true, line: { qty, aMm: a, bMm: b, lengthMm } }
}

export function parseForemanOrderText(raw, unitDefault) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0) return { ok: false, error: 'Введіть хоча б один рядок замовлення.' }

  const result = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseOneLine(lines[i], unitDefault)
    if (!parsed.ok) return { ok: false, error: `Рядок ${i + 1}: ${parsed.error}` }
    result.push(parsed.line)
  }

  return { ok: true, lines: mergeOrderLines(result) }
}
