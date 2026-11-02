export { Session, type LaunchOptions, type RecordedLaunchOptions, type TextOptions, type Key } from './session.js'

import { Session, createSession, type RecordedLaunchOptions } from './session.js'
import type { RecordOptions, RecordingHandle } from './recording.js'

type LaunchTerminalOptions = RecordedLaunchOptions & { waitForData?: boolean; waitForDataTimeout?: number }

export function launchTerminal(options: LaunchTerminalOptions & { record: RecordOptions }): Promise<Session & { readonly recording: RecordingHandle }>
export function launchTerminal(options: LaunchTerminalOptions): Promise<Session>
export async function launchTerminal(options: LaunchTerminalOptions): Promise<Session> {
  const session = await createSession(options)
  try {
    if (options.waitForData !== false) {
      await session.waitForData({ timeout: options.waitForDataTimeout ?? 5000 })
      await session.waitIdle()
    }
    return session
  } catch (error) {
    try { await session.closeAsync() } catch {}
    throw error
  }
}

export type { RecordOptions, RecordingHandle, RecordingStatus } from './recording.js'
export { exportRecording, type ExportRecordingOptions } from './recording.js'
export type ExportRecordingResult = Awaited<ReturnType<typeof import('./recording.js').exportRecording>>
