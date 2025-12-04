import { spawn as bunSpawn, type IPty as BunIPty } from 'bun-pty'

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
  const pty = bunSpawn(command, args, {
    name: 'xterm-truecolor',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
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
      pty.onData(callback)
    },
  }
}
