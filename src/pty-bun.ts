export interface IPty {
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
  const decoder = new TextDecoder()

  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    terminal: {
      name: 'xterm-truecolor',
      cols: options.cols,
      rows: options.rows,
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true })
        if (!text) {
          return
        }
        if (dataCallback) {
          dataCallback(text)
        } else {
          // Buffer data until callback is registered
          dataBuffer.push(text)
        }
      },
    },
  })

  subprocess.exited.then((exitCode) => {
    // Flush any remaining decoder bytes
    const tail = decoder.decode()
    if (tail) {
      if (dataCallback) {
        dataCallback(tail)
      } else {
        dataBuffer.push(tail)
      }
    }

    // Fire exit callback. Bun doesn't expose the signal number directly,
    // so we use 0 (no signal) as default.
    const info = { exitCode: exitCode ?? 0, signal: 0 }
    exitInfo = info
    if (exitCallback) {
      exitCallback(info)
    }
  }).catch(() => {
    // Process spawn/exit errors — fire exit with code 1
    const info = { exitCode: 1, signal: 0 }
    exitInfo = info
    if (exitCallback) {
      exitCallback(info)
    }
  })

  const terminal = subprocess.terminal!

  return {
    write(data) {
      terminal.write(data)
    },
    resize(cols, rows) {
      terminal.resize(cols, rows)
    },
    kill() {
      subprocess.kill()
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
