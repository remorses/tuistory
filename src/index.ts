export { Session, type LaunchOptions, type TextOptions } from './session.js'

import { Session, type LaunchOptions } from './session.js'

export async function launchTerminal(options: LaunchOptions): Promise<Session> {
  const session = new Session(options)
  await session.waitIdle()
  return session
}
