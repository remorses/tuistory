import * as nodePty from 'node-pty'

export interface IPty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): void
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

  const pty = nodePty.spawn(command, args, {
    name: 'xterm-truecolor',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
  })

  // Register callback immediately to capture all data
  pty.onData((data) => {
    if (dataCallback) {
      dataCallback(data)
    } else {
      // Buffer data until callback is registered
      dataBuffer.push(data)
    }
  })

  return {
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill() {
      pty.kill()
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
  }
}
