import jwt from 'jsonwebtoken'
import { JWT_EXPIRES_IN, JWT_SECRET } from '../config/env.js'

/**
 * @param {{ sub: string, username: string, role: string }} payload
 */
export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

/**
 * @param {string} token
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}
