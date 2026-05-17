import type { buildForemanPlan } from '../helpers/foremanPlan'

export type TaskKind = 'resaw' | 'circular' | 'pallets'

export type TaskPalletTarget = {
  palletTypeId: string
  palletTypeName: string
  qty: number
}

export type ForemanPlanResult = ReturnType<typeof buildForemanPlan>

/** Смуги після стрічкової пили — облік для багатопилу (ширина). */
export type StripInventoryEntry = {
  thicknessMm: number
  qty: number
  logLengthMm: number
  /** Фактична ширина конкретної смуги після станка 1 (мм). */
  stripWidthMm?: number
  recordedAt: string
}

/** Облік розпилу по ширині (багатопил): списання смуг + ручний залишок. */
export type StripSawCutEntry = {
  thicknessMm: number
  stripQty: number
  /** Введено оператором: скільки дощок знято з смуг за цей запис */
  boardsTotal?: number
  /** Фактично зараховано в план (не більше залишку замовлення) */
  boardsCredited?: number
  /** Дошки по ширинах, мм → кількість (як у схемі × кількість смуг) */
  boardsByWidthMm?: Record<string, number>
  recordedBy?: { id?: string; username?: string }
  recordedAt: string
}

export type StripSawState = {
  cuts: StripSawCutEntry[]
  /** Абсолютний залишок смуг (мм висоти як ключ у JSON — рядок). Якщо немає — фактично мінус сума розпилів. */
  remainderOverrideByThicknessMm?: Record<string, number>
}

export type CircularSawCutEntry = {
  thicknessMm: number
  widthMm: number
  lengthMm: number
  qty: number
  recordedBy?: { id?: string; username?: string }
  recordedAt: string
}

export type CircularSawState = {
  cuts: CircularSawCutEntry[]
}

export type PalletMaterialLine = {
  thicknessMm: number
  widthMm: number
  lengthMm: number
  qty: number
}

export type PalletBuildEntry = {
  palletTypeId: string
  palletTypeName: string
  qty: number
  materials: PalletMaterialLine[]
  recordedAt: string
}

export type PalletAssemblyState = {
  builds: PalletBuildEntry[]
}

export type TaskStationAssignments = {
  band_saw: string[]
  strip_saw: string[]
  circular_saw: string[]
  pallets: string[]
}

export type TaskDimensionRow = {
  kind: 'main' | 'secondary'
  /** Для `secondary` може бути порожнім: рядок лише в `dimensionRows`, без фіксованого попиту в плані. */
  qty: string
  height: string
  width: string
  length: string
}

export type WorkTask = {
  id: string
  title: string
  /** Тип ланцюга: розпил (стрічка+багатопил), окрема циркулярка, або збірка піддонів. Для старих даних вважається resaw. */
  taskKind?: TaskKind
  /** Лише для taskKind «Збірка піддонів»: тип та кількість. */
  palletTarget?: TaskPalletTarget
  orderText: string
  /** Рядки форми бригадира, щоб залишки/другорядні не змішувалися з основними при редагуванні. */
  dimensionRows?: TaskDimensionRow[]
  unit: 'mm' | 'cm'
  radiusMm: number
  kerfBandMm: number
  kerfCircMm: number
  assignTo: string[]
  /** Персональні призначення: ID працівників по кожному станку/ділянці. */
  stationAssignments?: TaskStationAssignments
  plan: ForemanPlanResult & { dimensionRows?: TaskDimensionRow[] }
  /** Накопичені смуги по завданню (передаються на багатопил). */
  stripInventory?: StripInventoryEntry[]
  /** Списані смуги на багатопилі та ручний залишок. */
  stripSaw?: StripSawState
  /** Факт розкрою бруса по довжині на циркулярці. */
  circularSaw?: CircularSawState
  /** Зібрані піддони та списаний матеріал. */
  palletAssembly?: PalletAssemblyState
  status: 'pending' | 'in_progress' | 'done'
  createdAt: string
  createdBy: { id: string; username: string }
  updatedAt?: string
}
