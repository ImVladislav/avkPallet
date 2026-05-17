import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  createTask,
  deleteTask,
  fetchTasks,
  patchTaskStatus,
  updateTask,
} from '../api'
import { useAuth } from '../context/AuthContext'
import { useAppDialog } from '../context/AppDialogContext'
import { PALLET_RECIPES } from '../helpers/palletRecipes'
import {
  formatOrderLinesAsTextCm,
  formatOrderTextAsHumanLines,
  orderLinesFromDimensionRows,
  parseForemanOrderText,
  type OrderLine,
} from '../helpers/parseForemanOrders'
import { formatOpenSecondariesForCard } from '../helpers/taskOrderDisplay'
import type { TaskDimensionRow, TaskKind, WorkTask } from '../types/task'
import './TasksPage.css'

/** Технічні параметри плану (торець + пропили) — без полів у формі; типові для цеху. */
type ForemanTechFields = {
  radiusMm: number
  kerfBandMm: number
  kerfCircMm: number
}

const DEFAULT_TECH: ForemanTechFields = {
  radiusMm: 180,
  kerfBandMm: 4,
  kerfCircMm: 3,
}

const ASSIGN_LABELS: Record<string, string> = {
  sawyer: 'Станок 1 (стрічкова)',
  circular_operator: 'Станок 2 / циркулярка',
  pallet_assembly: 'Збірка піддонів',
}

const TASK_KIND_LABELS: Record<TaskKind, string> = {
  resaw: 'Розпил',
  circular: 'Циркулярка',
  pallets: 'Збірка піддонів',
}

const FORM_TABS: { id: TaskKind; hint: string }[] = [
  { id: 'resaw', hint: '' },
  { id: 'circular', hint: '' },
  { id: 'pallets', hint: 'Збірка піддонів: тип та кількість (окремо від циркулярки).' },
]

function taskKindOf(task: WorkTask): TaskKind {
  return task.taskKind ?? 'resaw'
}

/** Малюнок перетину: сторона 1 і сторона 2 як у таблиці (не змішуємо 20×40 із 40×20); підписи збоку прямокутника. */
function BoardCrossPreview({ sideACm, sideBCm }: { sideACm: string; sideBCm: string }) {
  const pa = Number(String(sideACm).replace(',', '.'))
  const pb = Number(String(sideBCm).replace(',', '.'))
  const a = Number.isFinite(pa) && pa > 0 ? pa : 0
  const b = Number.isFinite(pb) && pb > 0 ? pb : 0
  if (a <= 0 || b <= 0) {
    return (
      <span className="foremanBoardPreviewEmpty" title="Введіть дві сторони перетину, см">
        —
      </span>
    )
  }
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1))))
  const fa = fmt(a)
  const fb = fmt(b)
  const pad = 12
  const inner = 44
  const maxDim = Math.max(a, b)
  const scale = inner / maxDim
  const rw = a * scale
  const rh = b * scale
  const vb = pad * 2 + inner
  const ox = pad + (inner - rw) / 2
  const oy = pad + (inner - rh) / 2
  return (
    <div
      className="foremanBoardPreview"
      title={`Перетин дошки: сторона 1 — ${fa} см, сторона 2 — ${fb} см`}
    >
      <svg
        viewBox={`0 0 ${vb} ${vb}`}
        width={52}
        height={52}
        className="foremanBoardPreviewSvg"
        aria-hidden
      >
        <rect x={ox} y={oy} width={rw} height={rh} className="foremanBoardPreviewRect" rx={1.5} />
        <text
          x={ox + rw / 2}
          y={Math.max(9, oy - 2)}
          textAnchor="middle"
          className="foremanBoardPreviewDimText"
          fontSize="9"
        >
          {fa}
        </text>
        <text
          x={Math.max(6, ox - 2)}
          y={oy + rh / 2}
          textAnchor="end"
          dominantBaseline="central"
          className="foremanBoardPreviewDimText"
          fontSize="9"
        >
          {fb}
        </text>
      </svg>
      <span className="foremanBoardPreviewLabel">
        {fa}×{fb} см
      </span>
    </div>
  )
}

type DimRow = {
  id: string
  kind: 'main' | 'secondary'
  qty: string
  height: string
  width: string
  length: string
}

function newRow(kind: 'main' | 'secondary' = 'main', withBoardLength = true): DimRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    qty: kind === 'secondary' ? '' : '1',
    height: '5',
    width: '5',
    length: withBoardLength ? '120' : '',
  }
}

function orderLinesToDimRows(lines: OrderLine[]): DimRow[] {
  return lines.map((l, i) => ({
    id: `row-${i}-${Math.random().toString(36).slice(2, 9)}`,
    kind: 'main',
    qty: String(l.qty),
    height: String(l.aMm / 10),
    width: String(l.bMm / 10),
    length: l.lengthMm > 0 ? String(l.lengthMm / 10) : '',
  }))
}

function storedRowsToDimRows(rows: TaskDimensionRow[]): DimRow[] {
  return rows.map((r, i) => ({
    id: `stored-${i}-${Math.random().toString(36).slice(2, 9)}`,
    kind: r.kind === 'secondary' ? 'secondary' : 'main',
    qty: String(r.qty ?? ''),
    height: String(r.height ?? ''),
    width: String(r.width ?? ''),
    length: String(r.length ?? ''),
  }))
}

function dimRowsToStoredRows(rows: DimRow[]): TaskDimensionRow[] {
  return rows.map((r) => ({
    kind: r.kind,
    qty: r.qty,
    height: r.height,
    width: r.width,
    length: r.length,
  }))
}

/** Ключ для порівняння «ті самі розміри» (см у формі). */
function dimRowComparisonKey(r: DimRow, withBoardLength: boolean): string | null {
  const h = Number(String(r.height).replace(',', '.').trim())
  const w = Number(String(r.width).replace(',', '.').trim())
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) return null

  const round = (x: number) => Math.round(x * 1000) / 1000
  const hr = round(h)
  const wr = round(w)

  if (withBoardLength) {
    const L = Number(String(r.length).replace(',', '.').trim())
    if (!Number.isFinite(L) || L <= 0) return null
    return `${hr}|${wr}|${round(L)}`
  }

  const Lraw = String(r.length ?? '').trim()
  if (Lraw === '') {
    return `${hr}|${wr}|`
  }
  const L = Number(Lraw.replace(',', '.'))
  if (!Number.isFinite(L) || L <= 0) return null
  return `${hr}|${wr}|${round(L)}`
}

/** id рядків, що входять у групи з однаковими розмірами (≥ 2 рядки на ключ). */
function duplicateDimRowIds(rows: DimRow[], withBoardLength: boolean): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const r of rows) {
    const key = dimRowComparisonKey(r, withBoardLength)
    if (key == null) continue
    const list = byKey.get(key) ?? []
    list.push(r.id)
    byKey.set(key, list)
  }
  const out = new Set<string>()
  for (const ids of byKey.values()) {
    if (ids.length > 1) for (const id of ids) out.add(id)
  }
  return out
}

const SESSION_TAB_KEY = 'avk_tasks_formTab'
const SESSION_DRAFT_KEY = 'avk_tasks_page_draft'

type TasksPageDraftV1 = {
  v: 1
  formTab: TaskKind
  resawTitle: string
  resawRows: DimRow[]
  circTitle: string
  circRows: DimRow[]
  palTitle: string
  palPalletTypeId: string
  palPalletQty: string
  tech: ForemanTechFields
}

function readStoredFormTab(): TaskKind | null {
  try {
    const t = sessionStorage.getItem(SESSION_TAB_KEY)
    if (t === 'resaw' || t === 'circular' || t === 'pallets') return t
  } catch {
    /* ignore */
  }
  return null
}

function readPendingDraft(): TasksPageDraftV1 | null {
  try {
    const raw = sessionStorage.getItem(SESSION_DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as TasksPageDraftV1
    if (d?.v !== 1) return null
    const ft = d.formTab
    if (ft !== 'resaw' && ft !== 'circular' && ft !== 'pallets') return null
    return d
  } catch {
    return null
  }
}

const DEFAULT_PALLET_TYPE_ID = PALLET_RECIPES[0]?.id ?? ''

/** Один рядок «як після скидання форми» (ігноруємо id — він випадковий). */
function isFreshResawRow(r: DimRow): boolean {
  return (
    r.kind === 'main' &&
    r.qty.trim() === '1' &&
    r.height.trim() === '5' &&
    r.width.trim() === '5' &&
    r.length.trim() === ''
  )
}

function isFreshCircRow(r: DimRow): boolean {
  return (
    r.kind === 'main' &&
    r.qty.trim() === '1' &&
    r.height.trim() === '5' &&
    r.width.trim() === '5' &&
    r.length.trim() === '120'
  )
}

function isDefaultResawSection(d: TasksPageDraftV1): boolean {
  if (!Array.isArray(d.resawRows) || d.resawRows.length !== 1) return false
  return d.resawTitle.trim() === '' && isFreshResawRow(d.resawRows[0]!)
}

function isDefaultCircSection(d: TasksPageDraftV1): boolean {
  if (!Array.isArray(d.circRows) || d.circRows.length !== 1) return false
  return d.circTitle.trim() === '' && isFreshCircRow(d.circRows[0]!)
}

function isDefaultPalSection(d: TasksPageDraftV1): boolean {
  return (
    d.palTitle.trim() === '' &&
    d.palPalletQty.trim() === '1' &&
    d.palPalletTypeId === DEFAULT_PALLET_TYPE_ID
  )
}

function isDefaultSavedTech(t: ForemanTechFields): boolean {
  return (
    t.radiusMm === DEFAULT_TECH.radiusMm &&
    t.kerfBandMm === DEFAULT_TECH.kerfBandMm &&
    t.kerfCircMm === DEFAULT_TECH.kerfCircMm
  )
}

/** Чи відрізняється збережений стан від того, що дає «нова» сторінка (без уведеного тексту). */
function isDraftMeaningful(d: TasksPageDraftV1): boolean {
  const tech = d.tech ?? DEFAULT_TECH
  const sameAsFreshForm =
    isDefaultResawSection(d) &&
    isDefaultCircSection(d) &&
    isDefaultPalSection(d) &&
    isDefaultSavedTech(tech)
  return !sameAsFreshForm
}

export function TasksPage() {
  const { user } = useAuth()
  const { confirm: appConfirm, showAlert } = useAppDialog()
  const canManageTasks =
    user?.role === 'foreman' || user?.role === 'admin' || user?.role === 'super_admin'
  const [list, setList] = useState<WorkTask[]>([])
  const [listErr, setListErr] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)

  const [formTab, setFormTab] = useState<TaskKind>(() => readStoredFormTab() ?? 'resaw')
  const [resawTitle, setResawTitle] = useState('')
  const [resawRows, setResawRows] = useState<DimRow[]>(() => [newRow('main', false)])
  const [circTitle, setCircTitle] = useState('')
  const [circRows, setCircRows] = useState<DimRow[]>(() => [newRow('main')])
  const [palTitle, setPalTitle] = useState('')
  const [palPalletTypeId, setPalPalletTypeId] = useState(PALLET_RECIPES[0]?.id ?? '')
  const [palPalletQty, setPalPalletQty] = useState('1')

  const [techOverride, setTechOverride] = useState<ForemanTechFields | null>(null)
  const [foremanError, setForemanError] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [pendingDraftOffer, setPendingDraftOffer] = useState<TasksPageDraftV1 | null>(() => {
    const d = readPendingDraft()
    return d && isDraftMeaningful(d) ? d : null
  })
  const tabsScrollRef = useRef<HTMLDivElement | null>(null)

  const filteredList = useMemo(() => {
    if (formTab === 'circular') {
      return list.filter((t) => {
        const k = taskKindOf(t)
        return k === 'circular' || k === 'resaw'
      })
    }
    if (formTab === 'resaw') return list.filter((t) => taskKindOf(t) === 'resaw')
    return list.filter((t) => taskKindOf(t) === 'pallets')
  }, [list, formTab])

  const taskPendingDelete = useMemo(
    () => (deleteConfirmId ? list.find((t) => t.id === deleteConfirmId) : undefined),
    [list, deleteConfirmId],
  )

  const listHeading = useMemo(() => {
    if (formTab === 'circular') return 'Циркулярка та розпил'
    return TASK_KIND_LABELS[formTab]
  }, [formTab])

  const activeFormTabHint = useMemo(
    () => FORM_TABS.find((t) => t.id === formTab)?.hint?.trim() ?? '',
    [formTab],
  )

  const resawDuplicateIds = useMemo(() => duplicateDimRowIds(resawRows, false), [resawRows])
  const circDuplicateIds = useMemo(() => duplicateDimRowIds(circRows, true), [circRows])

  useEffect(() => {
    const dup =
      formTab === 'resaw' ? resawDuplicateIds.size : formTab === 'circular' ? circDuplicateIds.size : 0
    if (dup === 0) {
      setForemanError((prev) => (prev?.includes('однаковими розмірами') ? null : prev))
    }
  }, [formTab, resawDuplicateIds.size, circDuplicateIds.size])

  const loadList = useCallback(async () => {
    setListErr(null)
    setLoadingList(true)
    try {
      const tasks = await fetchTasks()
      setList(tasks)
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    if (!deleteConfirmId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleteBusy) setDeleteConfirmId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteConfirmId, deleteBusy])

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_TAB_KEY, formTab)
    } catch {
      /* ignore */
    }
  }, [formTab])

  useEffect(() => {
    if (editingId) return
    const t = window.setTimeout(() => {
      try {
        const draft: TasksPageDraftV1 = {
          v: 1,
          formTab,
          resawTitle,
          resawRows,
          circTitle,
          circRows,
          palTitle,
          palPalletTypeId,
          palPalletQty,
          tech: techOverride ?? DEFAULT_TECH,
        }
        if (!isDraftMeaningful(draft)) {
          sessionStorage.removeItem(SESSION_DRAFT_KEY)
          return
        }
        sessionStorage.setItem(SESSION_DRAFT_KEY, JSON.stringify(draft))
      } catch {
        /* ignore */
      }
    }, 450)
    return () => window.clearTimeout(t)
  }, [
    editingId,
    formTab,
    resawTitle,
    resawRows,
    circTitle,
    circRows,
    palTitle,
    palPalletTypeId,
    palPalletQty,
    techOverride,
  ])

  useEffect(() => {
    const wrap = tabsScrollRef.current
    const active = wrap?.querySelector('.taskFormTabActive') as HTMLElement | undefined
    if (!active) return
    const horizontalTabs = window.matchMedia('(min-width: 641px)').matches
    if (horizontalTabs) {
      active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    } else {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [formTab])

  const resetResawForm = () => {
    setResawTitle('')
    setResawRows([newRow('main', false)])
  }
  const resetCircForm = () => {
    setCircTitle('')
    setCircRows([newRow('main')])
  }
  const resetPalForm = () => {
    setPalTitle('')
    setPalPalletTypeId(PALLET_RECIPES[0]?.id ?? '')
    setPalPalletQty('1')
  }

  const cancelEdit = () => {
    setEditingId(null)
    resetResawForm()
    resetCircForm()
    resetPalForm()
    setTechOverride(null)
    setForemanError(null)
    setSaveErr(null)
  }

  const startEdit = (task: WorkTask, opts?: { openCircularDims?: boolean }) => {
    setSaveErr(null)
    setForemanError(null)
    const kind = taskKindOf(task)
    setTechOverride({
      radiusMm: task.radiusMm,
      kerfBandMm: task.kerfBandMm,
      kerfCircMm: task.kerfCircMm,
    })
    setEditingId(task.id)

    if (kind === 'pallets') {
      setFormTab('pallets')
      setPalTitle(task.title)
      setPalPalletTypeId(task.palletTarget?.palletTypeId ?? PALLET_RECIPES[0]?.id ?? '')
      setPalPalletQty(String(task.palletTarget?.qty ?? 1))
      return
    }

    const storedRows = Array.isArray(task.dimensionRows) ? storedRowsToDimRows(task.dimensionRows) : []
    const orderTrim = String(task.orderText ?? '').trim()

    let baseRows: DimRow[]
    if (orderTrim === '') {
      if (storedRows.length === 0) {
        setSaveErr('Не вдалося відкрити завдання: немає тексту замовлення й збережених рядків розмірів.')
        setEditingId(null)
        return
      }
      baseRows = storedRows
    } else {
      const parsed = parseForemanOrderText(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
      if (!parsed.ok) {
        setSaveErr(`Не вдалося прочитати замовлення: ${parsed.error}`)
        setEditingId(null)
        return
      }
      baseRows = storedRows.length > 0 ? storedRows : orderLinesToDimRows(parsed.lines)
    }

    if (kind === 'circular' || (kind === 'resaw' && opts?.openCircularDims === true)) {
      setFormTab('circular')
      setCircTitle(task.title)
      setCircRows(baseRows.length > 0 ? baseRows : [newRow('main')])
      return
    }

    setFormTab('resaw')
    setResawTitle(task.title)
    setResawRows(baseRows.length > 0 ? baseRows : [newRow('main', false)])
  }

  const confirmDeleteTask = async () => {
    if (!deleteConfirmId) return
    const id = deleteConfirmId
    setDeleteBusy(true)
    try {
      await deleteTask(id)
      setDeleteConfirmId(null)
      if (editingId === id) cancelEdit()
      await loadList()
    } catch (e) {
      void showAlert({
        title: 'Помилка видалення',
        message: e instanceof Error ? e.message : 'Не вдалося видалити завдання.',
      })
    } finally {
      setDeleteBusy(false)
    }
  }

  const saveTask = async () => {
    setSaveErr(null)
    setForemanError(null)
    const tech = techOverride ?? DEFAULT_TECH
    if (tech.radiusMm <= 0) {
      setForemanError('Некоректний радіус у завданні.')
      return
    }

    const techPayload = {
      unit: 'cm' as const,
      radiusMm: tech.radiusMm,
      kerfBandMm: tech.kerfBandMm,
      kerfCircMm: tech.kerfCircMm,
    }

    setSaving(true)
    try {
      if (formTab === 'pallets') {
        const t = palTitle.trim()
        if (!t) {
          setSaveErr('Вкажіть назву завдання.')
          return
        }
        const recipe = PALLET_RECIPES.find((r) => r.id === palPalletTypeId) ?? PALLET_RECIPES[0]
        const q = Math.round(Number(palPalletQty) || 0)
        if (!Number.isFinite(q) || q < 1) {
          setSaveErr('Кількість піддонів має бути ≥ 1.')
          return
        }
        const payload = {
          title: t,
          orderText: '',
          taskKind: 'pallets' as const,
          palletTarget: {
            palletTypeId: recipe.id,
            palletTypeName: recipe.name,
            qty: q,
          },
          ...techPayload,
        }
        if (editingId) {
          await updateTask(editingId, payload)
        } else {
          await createTask(payload)
        }
        await loadList()
        cancelEdit()
        try {
          sessionStorage.removeItem(SESSION_DRAFT_KEY)
        } catch {
          /* ignore */
        }
        return
      }

      const rows = formTab === 'resaw' ? resawRows : circRows
      const titleText = (formTab === 'resaw' ? resawTitle : circTitle).trim()
      if (!titleText) {
        setSaveErr('Вкажіть назву завдання.')
        return
      }

      const duplicateIds = duplicateDimRowIds(rows, formTab === 'circular')
      if (duplicateIds.size > 0) {
        setForemanError(
          'У таблиці є рядки з однаковими розмірами (вони підсвічені). Об’єднайте кількість в одному рядку або змініть розміри — інакше при збереженні вони злилися б у плані без окремого обліку.',
        )
        return
      }

      const parsed = orderLinesFromDimensionRows(
        rows.map((r) => ({
          kind: r.kind,
          qty: r.qty,
          height: r.height,
          width: r.width,
          length: r.length,
        })),
        'cm',
        {
          requireBoardLength: formTab === 'circular',
        },
      )
      if (parsed.ok === false) {
        setForemanError(parsed.error)
        return
      }

      const editedTask = editingId ? list.find((t) => t.id === editingId) : undefined
      const payloadTaskKind: TaskKind =
        formTab === 'resaw'
          ? 'resaw'
          : editedTask && taskKindOf(editedTask) === 'resaw'
            ? 'resaw'
            : 'circular'

      const payload = {
        title: titleText,
        orderText: formatOrderLinesAsTextCm(parsed.lines),
        taskKind: payloadTaskKind,
        dimensionRows: dimRowsToStoredRows(rows),
        ...techPayload,
      }

      if (editingId) {
        await updateTask(editingId, payload)
      } else {
        await createTask(payload)
      }
      await loadList()
      cancelEdit()
      try {
        sessionStorage.removeItem(SESSION_DRAFT_KEY)
      } catch {
        /* ignore */
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Не вдалося зберегти')
    } finally {
      setSaving(false)
    }
  }

  const changeFormTab = async (tab: TaskKind) => {
    if (tab === formTab) return
    if (editingId) {
      const ok = await appConfirm({
        title: 'Закрити редагування?',
        message:
          'Закрити редагування поточного завдання? Незбережені зміни будуть втрачені.',
        confirmLabel: 'Закрити',
        cancelLabel: 'Скасувати',
      })
      if (!ok) return
      cancelEdit()
    }
    setFormTab(tab)
    setForemanError(null)
    setSaveErr(null)
  }

  const restoreForemanDraft = () => {
    const d = pendingDraftOffer
    if (!d) return
    setFormTab(d.formTab)
    setResawTitle(d.resawTitle)
    setResawRows(d.resawRows.length > 0 ? d.resawRows : [newRow('main', false)])
    setCircTitle(d.circTitle)
    setCircRows(d.circRows.length > 0 ? d.circRows : [newRow('main')])
    setPalTitle(d.palTitle)
    setPalPalletTypeId(d.palPalletTypeId || PALLET_RECIPES[0]?.id || '')
    setPalPalletQty(d.palPalletQty || '1')
    setTechOverride(
      d.tech
        ? {
            radiusMm: d.tech.radiusMm ?? DEFAULT_TECH.radiusMm,
            kerfBandMm: d.tech.kerfBandMm ?? DEFAULT_TECH.kerfBandMm,
            kerfCircMm: d.tech.kerfCircMm ?? DEFAULT_TECH.kerfCircMm,
          }
        : null,
    )
    setPendingDraftOffer(null)
  }

  const dismissForemanDraft = () => {
    try {
      sessionStorage.removeItem(SESSION_DRAFT_KEY)
    } catch {
      /* ignore */
    }
    setPendingDraftOffer(null)
  }

  const statusLabel = (s: WorkTask['status']) => {
    if (s === 'pending') return 'Очікує'
    if (s === 'in_progress') return 'В роботі'
    return 'Виконано'
  }

  const statusClass = (s: WorkTask['status']) => s

  type DimSectionOptions = {
    allowSecondaryRows?: boolean
    duplicateRowIds?: Set<string>
  }

  const renderDimSection = (
    rows: DimRow[],
    setRows: Dispatch<SetStateAction<DimRow[]>>,
    lengthHeader: string | null,
    options?: DimSectionOptions,
  ) => {
    const dup = options?.duplicateRowIds
    const allowSecondary = options?.allowSecondaryRows ?? true
    return (
      <div className="foremanDimTableWrap">
        <div className="foremanDimTableScroll">
          <table className="foremanDimTable">
        <thead>
          <tr>
            <th>№</th>
            <th title="У побічному рядку кількість можна не вказувати — позиція тоді не входить у план як фіксоване замовлення (лише розміри для орієнтиру).">
              Скільки шт
            </th>
            <th title="Перша сторона перетину, см">Сторона 1, см</th>
            <th title="Друга сторона перетину, см">Сторона 2, см</th>
            <th>Перетин</th>
            {lengthHeader != null ? <th>{lengthHeader}</th> : null}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={row.id}
              className={
                [
                  row.kind === 'secondary' ? 'foremanDimRowSecondary' : '',
                  dup?.has(row.id) ? 'foremanDimRowDuplicate' : '',
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            >
              <td title={row.kind === 'secondary' ? 'Побічний рядок' : undefined}>{idx + 1}</td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.qty}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, qty: v } : r)))
                  }}
                  inputMode="numeric"
                  placeholder={row.kind === 'secondary' ? "необов'язково" : undefined}
                  title={
                    row.kind === 'secondary'
                      ? 'Залиште порожнім, якщо кількість не фіксується: у плані замовлення цей рядок не збільшує обсяг (скільки вийде за фактом).'
                      : undefined
                  }
                  aria-label={
                    row.kind === 'secondary'
                      ? "Кількість, шт (необов'язково для побічного рядка)"
                      : 'Кількість, шт'
                  }
                />
              </td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.height}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, height: v } : r)))
                  }}
                  inputMode="decimal"
                />
              </td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.width}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, width: v } : r)))
                  }}
                  inputMode="decimal"
                />
              </td>
              <td className="foremanBoardPreviewCell">
                <BoardCrossPreview sideACm={row.height} sideBCm={row.width} />
              </td>
              {lengthHeader != null ? (
                <td>
                  <input
                    className="foremanDimInput"
                    value={row.length}
                    onChange={(e) => {
                      const v = e.target.value
                      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, length: v } : r)))
                    }}
                    inputMode="numeric"
                  />
                </td>
              ) : null}
              <td>
                <button
                  type="button"
                  className="ghost"
                  disabled={rows.length <= 1}
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
        </div>
        <div className="foremanDimTableActions">
        <button
          type="button"
          className="ghost"
          onClick={() => setRows((prev) => [...prev, newRow('main', lengthHeader != null)])}
        >
          + Рядок
        </button>
        {allowSecondary ? (
          <button
            type="button"
            className="ghost"
            onClick={() => setRows((prev) => [...prev, newRow('secondary', lengthHeader != null)])}
          >
            + Побічний рядок
          </button>
        ) : null}
        </div>
    </div>
    );
  }

  return (
    <>
      <section className="panel taskFormPanel">
        <div className="taskFormTabsChrome">
          <div className="taskFormTabsScroll" ref={tabsScrollRef}>
            <div className="taskFormTabsRow" role="tablist" aria-label="Тип завдання">
              {FORM_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={formTab === tab.id}
                  className={`taskFormTab ${formTab === tab.id ? 'taskFormTabActive' : ''}`}
                  title={tab.hint || undefined}
                  onClick={() => void changeFormTab(tab.id)}
                >
                  {TASK_KIND_LABELS[tab.id]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="taskFormBody">
          {pendingDraftOffer && !editingId && (
            <div className="taskDraftBanner" role="status">
              <p className="taskDraftBannerText">
                Знайдено збережену чернетку форми. Відновити введений текст?
              </p>
              <div className="taskDraftBannerActions">
                <button type="button" className="ghost" onClick={restoreForemanDraft}>
                  Відновити
                </button>
                <button type="button" className="ghost" onClick={dismissForemanDraft}>
                  Видалити чернетку
                </button>
              </div>
            </div>
          )}
          {activeFormTabHint ? <p className="panelHint">{activeFormTabHint}</p> : null}

          {formTab === 'resaw' && (
            <>
              <div className="taskFormTitleRow">
                <label className="foremanTaLabel">
                  Назва завдання
                  <input
                    value={resawTitle}
                    onChange={(e) => setResawTitle(e.target.value)}
                    placeholder="Напр. Комплект смуг для замовлення"
                  />
                </label>
              </div>
              <h3 className="taskFormSectionTitle">Розміри</h3>
              {resawDuplicateIds.size > 0 ? (
                <p className="foremanDupWarn" role="alert">
                  Є кілька рядків з <strong>однаковими розмірами</strong> (сторона 1 × сторона 2). Вони підсвічені
                  жовтим. Об’єднайте кількість в одному рядку або змініть розміри — інакше зберегти завдання не
                  вийде (у плані такі рядки зливаються в одну позицію).
                </p>
              ) : null}
              {renderDimSection(resawRows, setResawRows, null, {
                allowSecondaryRows: true,
                duplicateRowIds: resawDuplicateIds,
              })}
            </>
          )}

          {formTab === 'circular' && (
            <>
              <div className="taskFormTitleRow">
                <label className="foremanTaLabel">
                  Назва завдання
                  <input
                    value={circTitle}
                    onChange={(e) => setCircTitle(e.target.value)}
                    placeholder="Напр. Підрізка брусів по довжині"
                  />
                </label>
              </div>
              <h3 className="taskFormSectionTitle">Дошки</h3>
              {circDuplicateIds.size > 0 ? (
                <p className="foremanDupWarn" role="alert">
                  Є кілька рядків з <strong>однаковими розмірами</strong> (сторона 1 × сторона 2 × довжина). Вони
                  підсвічені жовтим. Об’єднайте кількість в одному рядку або змініть розміри — інакше зберегти
                  завдання не вийде (у плані такі рядки зливаються в одну позицію).
                </p>
              ) : null}
              {renderDimSection(circRows, setCircRows, 'Довжина, см', {
                allowSecondaryRows: true,
                duplicateRowIds: circDuplicateIds,
              })}
            </>
          )}

          {formTab === 'pallets' && (
            <>
              <div className="taskFormTitleRow">
                <label className="foremanTaLabel">
                  Назва завдання
                  <input
                    value={palTitle}
                    onChange={(e) => setPalTitle(e.target.value)}
                    placeholder="Напр. Збірка EUR на відвантаження"
                  />
                </label>
              </div>
              <h3 className="taskFormSectionTitle">Піддон та обсяг</h3>
              <div className="taskFormPalletRow foremanPalletPickRow">
                <label>
                  Тип піддону
                  <select
                    value={palPalletTypeId}
                    onChange={(e) => setPalPalletTypeId(e.target.value)}
                  >
                    {PALLET_RECIPES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Кількість піддонів
                  <input
                    value={palPalletQty}
                    onChange={(e) => setPalPalletQty(e.target.value)}
                    inputMode="numeric"
                    min={1}
                  />
                </label>
              </div>
              <p className="panelHint">
                План розпилу для такого завдання порожній — облік лише на сторінці збірки піддонів.
              </p>
            </>
          )}

          <div className="taskFormActions">
            <button type="button" className="taskFormPrimaryBtn" onClick={saveTask} disabled={saving}>
              {saving ? 'Збереження…' : editingId ? 'Зберегти зміни' : 'Зберегти завдання'}
            </button>
            {editingId && (
              <button type="button" className="ghost taskFormSecondaryBtn" onClick={cancelEdit} disabled={saving}>
                Скасувати редагування
              </button>
            )}
          </div>
          {foremanError && <p className="birkaMsgErr">{foremanError}</p>}
          {saveErr && <p className="birkaMsgErr">{saveErr}</p>}
        </div>
      </section>

      <section className="panel taskList">
        <h2>Список: {listHeading}</h2>
        {loadingList && <p>Завантаження…</p>}
        {listErr && <p className="birkaMsgErr">{listErr}</p>}
        {!loadingList && filteredList.length === 0 && !listErr && (
          <p>Немає завдань цього типу. Перемкніть вкладку зверху або створіть нове.</p>
        )}

        {filteredList.map((task) => {
          const unit = task.unit === 'cm' ? 'cm' : 'mm'
          const orderRaw = task.orderText.trim()
          const orderPretty =
            orderRaw.length > 0 ? formatOrderTextAsHumanLines(task.orderText, unit) : null
          const orderDisplay = orderPretty ?? orderRaw
          const openSecText = formatOpenSecondariesForCard(task)
          const hideEditButton = formTab === 'circular' && taskKindOf(task) === 'resaw'
          return (
            <article key={task.id} className="taskCard">
              <div className="taskCardHead">
                <h3>{task.title}</h3>
                <div className="taskCardHeadRight">
                  {canManageTasks && (
                    <div className="taskCardActions">
                      {!hideEditButton ? (
                        <button type="button" className="ghost small" onClick={() => startEdit(task)}>
                          Редагувати
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ghost small"
                          title="Додати довжину або рядок розмірів для роботи на циркулярці; тип завдання «Розпил» не змінюється"
                          onClick={() => startEdit(task, { openCircularDims: true })}
                        >
                          Додати розмір
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost small danger"
                        onClick={() => setDeleteConfirmId(task.id)}
                      >
                        Видалити
                      </button>
                    </div>
                  )}
                  <span className={`taskStatusBadge ${statusClass(task.status)}`}>
                    {statusLabel(task.status)}
                  </span>
                </div>
              </div>
              <p className="taskMeta">
                <span className="taskKindBadge">{TASK_KIND_LABELS[taskKindOf(task)]}</span>
                {' · '}
                {new Date(task.createdAt).toLocaleString()} · автор: {task.createdBy.username}
              </p>
              {taskKindOf(task) === 'pallets' && task.palletTarget && (
                <p className="taskPalletTarget">
                  <strong>Піддони:</strong> {task.palletTarget.palletTypeName} × {task.palletTarget.qty}{' '}
                  шт
                </p>
              )}
              <p className="taskAssign">
                <strong>Вид робіт:</strong>{' '}
                {task.assignTo.map((r) => ASSIGN_LABELS[r] ?? r).join(', ')}
              </p>
              {!!orderDisplay && <pre className="taskOrderPreview">{orderDisplay}</pre>}
              {openSecText && (
                <p
                  className="taskOpenSecondaryNote"
                  title="Не входить у текст замовлення й не збільшує плановий обсяг до появи відповідних смуг."
                >
                  {openSecText}
                </p>
              )}

              <div className="taskStatusRow">
                <label>
                  Статус:
                  <select
                    value={task.status}
                    onChange={async (e) => {
                      const v = e.target.value as WorkTask['status']
                      try {
                        const updated = await patchTaskStatus(task.id, v)
                        setList((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
                      } catch (err) {
                        void showAlert({
                          title: 'Помилка',
                          message: err instanceof Error ? err.message : 'Не вдалося оновити статус.',
                        })
                      }
                    }}
                  >
                    <option value="pending">Очікує</option>
                    <option value="in_progress">В роботі</option>
                    <option value="done">Виконано</option>
                  </select>
                </label>
              </div>
            </article>
          )
        })}
      </section>

      {deleteConfirmId && (
        <div
          className="taskDeleteModalBackdrop"
          role="presentation"
          onClick={() => {
            if (!deleteBusy) setDeleteConfirmId(null)
          }}
        >
          <div
            className="taskDeleteModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="taskDeleteModalTitle"
            aria-describedby="taskDeleteModalDesc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="taskDeleteModalTitle" className="taskDeleteModalTitle">
              Видалити завдання?
            </h2>
            <p id="taskDeleteModalDesc" className="taskDeleteModalLead">
              Цю дію не можна скасувати. Усі пов’язані записи плану та обліку для цього завдання зникнуть зі
              списку.
            </p>
            <p className="taskDeleteModalTaskName">
              {taskPendingDelete?.title?.trim() || 'Без назви'}
            </p>
            <div className="taskDeleteModalActions">
              <button
                type="button"
                className="ghost taskDeleteModalBtnCancel"
                disabled={deleteBusy}
                onClick={() => setDeleteConfirmId(null)}
              >
                Скасувати
              </button>
              <button
                type="button"
                className="taskDeleteModalBtnDanger"
                disabled={deleteBusy}
                onClick={() => void confirmDeleteTask()}
              >
                {deleteBusy ? 'Видалення…' : 'Видалити'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
