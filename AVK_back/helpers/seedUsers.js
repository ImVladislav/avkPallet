import { hashPassword } from './password.js'
import { readJson, writeJson } from './jsonStore.js'
import { USERS_FILE } from './paths.js'

const DEFAULT_PASSWORD = '1'

/** @type {{ id: string, username: string, passwordHash: string, role: string, displayName: string }[]} */
const SEED = [
  {
    id: 'u-sawyer',
    username: 'rozpyl',
    passwordHash: '',
    role: 'sawyer',
    displayName: 'Розпиловщик',
  },
  {
    id: 'u-circular',
    username: 'cyrkul',
    passwordHash: '',
    role: 'circular_operator',
    displayName: 'Циркулярка (дошки)',
  },
  {
    id: 'u-pallet',
    username: 'zbirka',
    passwordHash: '',
    role: 'pallet_assembly',
    displayName: 'Збірка піддонів',
  },
  {
    id: 'u-foreman',
    username: 'brygadyr',
    passwordHash: '',
    role: 'foreman',
    displayName: 'Бригадир',
  },
  {
    id: 'u-admin',
    username: 'admin',
    passwordHash: '',
    role: 'admin',
    displayName: 'Адміністратор',
  },
  {
    id: 'u-super-admin',
    username: 'S',
    passwordHash: '',
    role: 'super_admin',
    displayName: 'Супер адмін',
  },
]

export async function ensureSeedUsers() {
  const users = await readJson(USERS_FILE, [])
  const hash = hashPassword(DEFAULT_PASSWORD)
  if (Array.isArray(users) && users.length > 0) {
    if (!users.some((u) => String(u.username) === 'S')) {
      await writeJson(USERS_FILE, [
        ...users,
        {
          id: 'u-super-admin',
          username: 'S',
          passwordHash: hash,
          role: 'super_admin',
          displayName: 'Супер адмін',
        },
      ])
    }
    return
  }

  const seeded = SEED.map((u) => ({ ...u, passwordHash: hash }))
  await writeJson(USERS_FILE, seeded)
}
