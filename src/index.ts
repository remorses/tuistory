export { Session, type LaunchOptions, type TextOptions, type Key } from './session.js'

import { Session, type LaunchOptions } from './session.js'

export async function launchTerminal(
  options: LaunchOptions & { waitForData?: boolean; waitForDataTimeout?: number },
): Promise<Session> {
  const session = new Session(options)
  if (options.waitForData !== false) {
    await session.waitForData({ timeout: options.waitForDataTimeout ?? 5000 })
    await session.waitIdle()
  }
  return session
}
