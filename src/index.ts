export { Session, type LaunchOptions, type TextOptions } from './session.js'

import { Session, type LaunchOptions } from './session.js'

export async function launchTerminal(
  options: LaunchOptions & { waitForData?: boolean },
): Promise<Session> {
  const session = new Session(options)
  if (options.waitForData !== false) {
    await session.waitForData()
    await session.waitIdle()
  }
  return session
}
