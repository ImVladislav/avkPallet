import { getToken } from './auth'
import { apiUrl } from './apiUrl'
import { notifyWorkTasksChanged } from './taskEvents'
import type { WorkTask } from '../types/task'

function headersJson(): HeadersInit {
  const t = getToken()
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

export async function fetchTasks(): Promise<WorkTask[]> {
  const res = await fetch(apiUrl('/api/tasks'), { headers: headersJson() })
  const data = (await res.json().catch(() => ({}))) as { tasks?: WorkTask[]; error?: string }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        'API недоступний (404). Запустіть сервер з папки проєкту: npm run dev:server (порт 3001) або npm run dev:all',
      )
    }
    throw new Error(data.error ?? 'Не вдалося завантажити завдання')
  }
  return data.tasks ?? []
}

export type CreateTaskPayload = {
  title: string
  orderText: string
  unit: 'mm' | 'cm'
  radiusMm: number
  kerfBandMm: number
  kerfCircMm: number
  assignTo?: string[]
}

export async function createTask(payload: CreateTaskPayload): Promise<WorkTask> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { task?: WorkTask; error?: string }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        'API недоступний (404). Запустіть сервер: npm run dev:server або npm run dev:all',
      )
    }
    throw new Error(data.error ?? 'Не вдалося створити завдання')
  }
  if (!data.task) throw new Error('Некоректна відповідь сервера')
  notifyWorkTasksChanged()
  return data.task
}

export async function updateTask(id: string, payload: CreateTaskPayload): Promise<WorkTask> {
  const res = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { task?: WorkTask; error?: string }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(data.error ?? 'Завдання не знайдено')
    }
    throw new Error(data.error ?? 'Не вдалося оновити завдання')
  }
  if (!data.task) throw new Error('Некоректна відповідь сервера')
  notifyWorkTasksChanged()
  return data.task
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: headersJson(),
  })
  if (!res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'Не вдалося видалити завдання')
  }
  notifyWorkTasksChanged()
}

export type BandCutLine = { thicknessMm: number; stripQty: number }

/** Ленточна: зареєструвати зняті смуги (факт), додати до завдання для станка 2. */
export async function recordBandCut(
  taskId: string,
  payload: {
    cuts: BandCutLine[]
    logLengthMm: number
    stripWidthsByThicknessMm?: Record<string, number[]>
  },
): Promise<WorkTask> {
  const res = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/band-cut`), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { task?: WorkTask; error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося записати зріз')
  }
  if (!data.task) throw new Error('Некоректна відповідь сервера')
  notifyWorkTasksChanged()
  return data.task
}

/** Станок 2: зареєструвати розпил (списати смуги + зарахувати дошки в план). */
export async function recordStripSawCut(
  taskId: string,
  payload: {
    thicknessMm: number
    stripQty: number
    boardsTotal: number
    boardsByWidthMm?: Record<string, number>
  },
): Promise<WorkTask> {
  const res = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/strip-saw/cut`), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { task?: WorkTask; error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося записати розпил')
  }
  if (!data.task) throw new Error('Некоректна відповідь сервера')
  notifyWorkTasksChanged()
  return data.task
}

/** Станок 2: ручний залишок або скинути корекцію (remainder: null). */
export async function patchStripSawRemainder(
  taskId: string,
  payload: { thicknessMm: number; remainder: number | null },
): Promise<WorkTask> {
  const res = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/strip-saw/remainder`), {
    method: 'PATCH',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { task?: WorkTask; error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося зберегти залишок')
  }
  if (!data.task) throw new Error('Некоректна відповідь сервера')
  notifyWorkTasksChanged()
  return data.task
}

export async function patchTaskStatus(
  id: string,
  status: 'pending' | 'in_progress' | 'done',
): Promise<WorkTask> {
  const res = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: headersJson(),
    body: JSON.stringify({ status }),
  })
  const data = (await res.json()) as { task?: WorkTask; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося оновити статус')
  if (!data.task) throw new Error('Некоректна відповідь сервера')
  notifyWorkTasksChanged()
  return data.task
}
