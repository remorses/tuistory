import { spawn as zigSpawn } from 'zigpty'
import { killProcessGroup } from './kill-process-group.js'

export interface IPty {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): void
  onExit(callback: (info: { exitCode: number; signal: number }) => void): void
}

export interface SpawnOptions {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string | undefined>
}

export function spawn(command: string, args: string[], options: SpawnOptions): IPty {
  // Buffer to store data received before callback is registered
  const dataBuffer: string[] = []
  let dataCallback: ((data: string) => void) | null = null
  let exitCallback: ((info: { exitCode: number; signal: number }) => void) | null = null
  let exitInfo: { exitCode: number; signal: number } | null = null

  const pty = zigSpawn(command, args, {
    name: 'xterm-truecolor',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
  })

  // Register callback immediately to capture all data
  pty.onData((data) => {
    const str = typeof data === 'string' ? data : data.toString()
    if (dataCallback) {
      dataCallback(str)
    } else {
      // Buffer data until callback is registered
      dataBuffer.push(str)
    }
  })

  // Listen for process exit from zigpty
  pty.onExit((info) => {
    exitInfo = info
    if (exitCallback) {
      exitCallback(info)
    }
  })

  return {
    pid: pty.pid,
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill() {
      // Kill the whole foreground process group, not just the PTY leader.
      // zigpty.kill() only signals the leader pid (e.g. a `sh -c` wrapper),
      // which leaves grandchildren like `vite`/`pnpm` orphaned and holding
      // their ports. The PTY child is a session/group leader (pgid == pid),
      // so signaling -pid reaches the entire tree. Falls back to the leader.
      killProcessGroup(pty.pid, () => pty.kill())
    },
    onData(callback) {
      dataCallback = callback
      // Flush any buffered data
      if (dataBuffer.length > 0) {
        const buffered = dataBuffer.splice(0)
        for (const data of buffered) {
          callback(data)
        }
      }
    },
    onExit(callback) {
      exitCallback = callback
      // If process already exited before callback was registered, fire immediately
      if (exitInfo) {
        callback(exitInfo)
      }
    },
  }
}
