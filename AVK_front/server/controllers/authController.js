import { readJson } from '../helpers/jsonStore.js'
import { USERS_FILE } from '../helpers/paths.js'
import { signToken } from '../helpers/jwt.js'
import { verifyPassword } from '../helpers/password.js'
import { publicUser } from '../helpers/userTabs.js'

export async function login(req, res) {
  const { username, password } = req.body ?? {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Вкажіть логін і пароль' })
  }

  const users = await readJson(USERS_FILE, [])
  const user = users.find((u) => u.username === String(username).trim())
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Невірний логін або пароль' })
  }

  const token = signToken({
    sub: user.id,
    username: user.username,
    role: user.role,
  })

  return res.json({ token, user: publicUser(user) })
}

export async function me(req, res) {
  const users = await readJson(USERS_FILE, [])
  const user = users.find((u) => u.id === req.user.sub)
  if (!user) {
    return res.status(404).json({ error: 'Користувача не знайдено' })
  }
  return res.json({ user: publicUser(user) })
}
