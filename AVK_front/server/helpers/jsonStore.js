import fs from 'fs/promises'
import path from 'path'

/**
 * @param {string} filePath
 * @param {unknown} defaultValue
 */
export async function readJson(filePath, defaultValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8')
      return defaultValue
    }
    throw err
  }
}

/**
 * @param {string} filePath
 * @param {unknown} data
 */
export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
}
