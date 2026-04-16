import type { buildForemanPlan } from '../helpers/foremanPlan'

export type ForemanPlanResult = ReturnType<typeof buildForemanPlan>

/** Смуги після ленточної — облік для станка 2 (ширина). */
export type StripInventoryEntry = {
  thicknessMm: number
  qty: number
  logLengthMm: number
  /** Фактична ширина конкретної смуги після станка 1 (мм). */
  stripWidthMm?: number
  recordedAt: string
}

/** Облік розпилу по ширині (станок 2): списання смуг + ручний залишок. */
export type StripSawCutEntry = {
  thicknessMm: number
  stripQty: number
  /** Введено оператором: скільки дощок знято з смуг за цей запис */
  boardsTotal?: number
  /** Фактично зараховано в план (не більше залишку замовлення) */
  boardsCredited?: number
  /** Дошки по ширинах, мм → кількість (як у схемі × кількість смуг) */
  boardsByWidthMm?: Record<string, number>
  recordedAt: string
}

export type StripSawState = {
  cuts: StripSawCutEntry[]
  /** Абсолютний залишок смуг (мм висоти як ключ у JSON — рядок). Якщо немає — фактично мінус сума розпилів. */
  remainderOverrideByThicknessMm?: Record<string, number>
}

export type WorkTask = {
  id: string
  title: string
  orderText: string
  unit: 'mm' | 'cm'
  radiusMm: number
  kerfBandMm: number
  kerfCircMm: number
  assignTo: string[]
  plan: ForemanPlanResult
  /** Накопичені смуги по завданню (передаються на станок 2). */
  stripInventory?: StripInventoryEntry[]
  /** Списані смуги на станку 2 та ручний залишок. */
  stripSaw?: StripSawState
  status: 'pending' | 'in_progress' | 'done'
  createdAt: string
  createdBy: { id: string; username: string }
  updatedAt?: string
}
