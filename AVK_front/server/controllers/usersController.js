import { readJson, writeJson } from '../helpers/jsonStore.js'
import { USERS_FILE } from '../helpers/paths.js'
import { hashPassword } from '../helpers/password.js'
import { ROLE_TABS } from '../helpers/roles.js'
import { publicUser, sanitizeTabs } from '../helpers/userTabs.js'

const ROLES = Object.keys(ROLE_TABS)

function newUserId() {
  return `u-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function listUsers(req, res) {
  const users = await readJson(USERS_FILE, [])
  const list = users.map((u) => publicUser(u))
  return res.json({ users: list })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function createUser(req, res) {
  const { username, displayName, role, tabs, password } = req.body ?? {}
  const u = String(username ?? '').trim()
  const name = String(displayName ?? '').trim()
  const pwd = String(password ?? '')

  if (!u || !name) {
    return res.status(400).json({ error: 'Вкажіть логін і ім’я' })
  }
  if (!pwd) {
    return res.status(400).json({ error: 'Вкажіть пароль' })
  }
  const roleNorm = String(role ?? 'sawyer').trim().toLowerCase()
  if (!ROLES.includes(roleNorm)) {
    return res.status(400).json({ error: 'Невідома роль' })
  }
  const tabsClean = sanitizeTabs(tabs)
  if (tabsClean.length === 0) {
    return res.status(400).json({ error: 'Оберіть хоча б один доступ (вкладку)' })
  }
  const users = await readJson(USERS_FILE, [])
  if (users.some((x) => x.username === u)) {
    return res.status(409).json({ error: 'Користувач з таким логіном уже є' })
  }

  const row = {
    id: newUserId(),
    username: u,
    passwordHash: hashPassword(pwd),
    role: roleNorm,
    displayName: name,
    tabs: tabsClean,
  }
  users.push(row)
  await writeJson(USERS_FILE, users)
  return res.status(201).json({ user: publicUser(row) })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function updateUser(req, res) {
  const id = String(req.params.id ?? '').trim()
  const { username, displayName, role, tabs, password } = req.body ?? {}
  const name = String(displayName ?? '').trim()
  const uLogin = String(username ?? '').trim()
  const pwd = password != null ? String(password) : ''

  if (!id) {
    return res.status(400).json({ error: 'Некоректний id' })
  }
  if (!name) {
    return res.status(400).json({ error: 'Вкажіть ім’я' })
  }
  const roleNorm = String(role ?? '').trim().toLowerCase()
  if (!ROLES.includes(roleNorm)) {
    return res.status(400).json({ error: 'Невідома роль' })
  }
  const tabsClean = sanitizeTabs(tabs)
  if (tabsClean.length === 0) {
    return res.status(400).json({ error: 'Оберіть хоча б один доступ (вкладку)' })
  }

  const users = await readJson(USERS_FILE, [])
  const idx = users.findIndex((x) => x.id === id)
  if (idx < 0) {
    return res.status(404).json({ error: 'Користувача не знайдено' })
  }
  const existing = users[idx]
  if (uLogin && uLogin !== existing.username) {
    return res.status(400).json({ error: 'Логін не можна змінити після створення' })
  }

  const next = {
    ...existing,
    username: existing.username,
    displayName: name,
    role: roleNorm,
    tabs: tabsClean,
  }
  if (pwd.trim().length > 0) {
    next.passwordHash = hashPassword(pwd.trim())
  }
  users[idx] = next
  await writeJson(USERS_FILE, users)
  return res.json({ user: publicUser(next) })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function deleteUser(req, res) {
  const id = String(req.params.id ?? '').trim()
  if (!id) {
    return res.status(400).json({ error: 'Некоректний id' })
  }
  if (id === req.user.sub) {
    return res.status(400).json({ error: 'Не можна видалити власний обліковий запис' })
  }

  const users = await readJson(USERS_FILE, [])
  const idx = users.findIndex((x) => x.id === id)
  if (idx < 0) {
    return res.status(404).json({ error: 'Користувача не знайдено' })
  }
  const target = users[idx]
  if (target.role === 'admin') {
    const adminCount = users.filter((x) => x.role === 'admin').length
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Неможливо видалити останнього адміністратора' })
    }
  }

  users.splice(idx, 1)
  await writeJson(USERS_FILE, users)
  return res.status(204).send()
}
