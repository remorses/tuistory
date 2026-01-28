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
  const decoder = new TextDecoder()

  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    terminal: {
      name: 'xterm-truecolor',
      cols: options.cols,
      rows: options.rows,
      data(_terminal, data) {
        const text = decoder.decode(data)
        if (dataCallback) {
          dataCallback(text)
        } else {
          // Buffer data until callback is registered
          dataBuffer.push(text)
        }
      },
    },
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
  }
}
