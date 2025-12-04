import { PersistentTerminal, StyleFlags, type TerminalData } from 'ghostty-opentui'
import { spawn, type IPty } from 'tuistory/pty'

export interface LaunchOptions {
  command: string
  args?: string[]
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface TextOptions {
  only?: {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    foreground?: string
    background?: string
  }
  waitFor?: (text: string) => boolean
  timeout?: number
}

type Key =
  | 'enter'
  | 'esc'
  | 'tab'
  | 'space'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'ctrl'
  | 'alt'
  | 'shift'
  | 'meta'
  | string

const KEY_CODES: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  space: ' ',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
}

const CTRL_CODES: Record<string, string> = {
  a: '\x01',
  b: '\x02',
  c: '\x03',
  d: '\x04',
  e: '\x05',
  f: '\x06',
  g: '\x07',
  h: '\x08',
  i: '\x09',
  j: '\x0a',
  k: '\x0b',
  l: '\x0c',
  m: '\x0d',
  n: '\x0e',
  o: '\x0f',
  p: '\x10',
  q: '\x11',
  r: '\x12',
  s: '\x13',
  t: '\x14',
  u: '\x15',
  v: '\x16',
  w: '\x17',
  x: '\x18',
  y: '\x19',
  z: '\x1a',
}

export class Session {
  private pty: IPty
  private term: PersistentTerminal
  private cols: number
  private rows: number
  private idleResolvers: Array<() => void> = []
  private idleTimer?: ReturnType<typeof setTimeout>

  constructor(options: LaunchOptions) {
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24

    this.term = new PersistentTerminal({
      cols: this.cols,
      rows: this.rows,
    })

    const env = {
      ...options.env,
      TERM: 'xterm-truecolor',
      COLORTERM: 'truecolor',
    }

    this.pty = spawn(options.command, options.args ?? [], {
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd,
      env,
    })

    this.pty.onData((data) => {
      this.term.feed(data)
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => {
        const resolvers = this.idleResolvers.splice(0)
        resolvers.forEach((fn) => {
          fn()
        })
      }, 50)
    })
  }

  async waitIdle(options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 500
    return new Promise<void>((resolve) => {
      if (!this.idleTimer) {
        setTimeout(() => {
          resolve()
        }, 100)
        return
      }
      const t = setTimeout(() => {
        resolve()
      }, timeout)
      this.idleResolvers.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async write(data: string): Promise<void> {
    this.pty.write(data)
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    return this.waitIdle()
  }

  async type(text: string): Promise<void> {
    for (const char of text) {
      this.pty.write(char)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  async press(keys: Key | Key[]): Promise<void> {
    const keyArray = Array.isArray(keys) ? keys : [keys]

    const hasCtrl = keyArray.includes('ctrl')
    const hasAlt = keyArray.includes('alt')
    const hasShift = keyArray.includes('shift')

    const mainKeys = keyArray.filter(
      (k) => k !== 'ctrl' && k !== 'alt' && k !== 'shift' && k !== 'meta',
    )

    if (mainKeys.length === 0) {
      return
    }

    for (const key of mainKeys) {
      let code: string

      if (hasCtrl && key.length === 1) {
        const ctrlCode = CTRL_CODES[key.toLowerCase()]
        if (ctrlCode) {
          code = ctrlCode
        } else {
          code = key
        }
      } else if (KEY_CODES[key]) {
        code = KEY_CODES[key]
        if (hasAlt) {
          code = '\x1b' + code
        }
      } else if (key.length === 1) {
        code = hasShift ? key.toUpperCase() : key
        if (hasAlt) {
          code = '\x1b' + code
        }
      } else {
        code = key
      }

      await this.write(code)
    }
  }

  private buildTextFromJson(data: TerminalData, only?: TextOptions['only']): string {
    const lines: string[] = []

    for (const line of data.lines) {
      let lineText = ''

      for (const span of line.spans) {
        if (only) {
          let matches = true

          if (only.bold !== undefined) {
            const isBold = (span.flags & StyleFlags.BOLD) !== 0
            matches = matches && isBold === only.bold
          }
          if (only.italic !== undefined) {
            const isItalic = (span.flags & StyleFlags.ITALIC) !== 0
            matches = matches && isItalic === only.italic
          }
          if (only.underline !== undefined) {
            const isUnderline = (span.flags & StyleFlags.UNDERLINE) !== 0
            matches = matches && isUnderline === only.underline
          }
          if (only.foreground !== undefined) {
            matches = matches && span.fg === only.foreground
          }
          if (only.background !== undefined) {
            matches = matches && span.bg === only.background
          }

          if (matches) {
            lineText += span.text
          } else {
            lineText += ' '.repeat(span.width)
          }
        } else {
          lineText += span.text
        }
      }

      lines.push(lineText)
    }

    let lastNonEmpty = lines.length - 1
    while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === '') {
      lastNonEmpty--
    }
    const trimmed = lines.slice(0, lastNonEmpty + 1)

    const nonEmpty = trimmed.filter((l) => l.trim().length > 0)
    const leadingSpaces = nonEmpty.length
      ? Math.min(
          ...nonEmpty.map((l) => {
            const m = l.match(/^\s*/)
            return m ? m[0].length : 0
          }),
        )
      : 0

    const deindented = trimmed.map((l) =>
      l.length >= leadingSpaces ? l.slice(leadingSpaces) : l.trimStart(),
    )

    const rightTrimmed = deindented.map((l) => l.replace(/\s+$/, ''))
    return '\n' + rightTrimmed.join('\n')
  }

  async text(options?: TextOptions): Promise<string> {
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    const timeout = options?.timeout ?? 5000
    const waitFor = options?.waitFor ?? ((text: string) => text.trim().length > 0)
    const startTime = Date.now()

    const getCurrentText = (): string => {
      const data = this.term.getJson()
      return this.buildTextFromJson(data, options?.only)
    }

    while (Date.now() - startTime < timeout) {
      await this.waitIdle({ timeout: 100 })
      const text = getCurrentText()
      if (waitFor(text)) {
        return text
      }
    }

    return getCurrentText()
  }

  async waitForText(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<string> {
    const timeout = options?.timeout ?? 5000
    const regex =
      typeof pattern === 'string'
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        : pattern

    return this.text({
      timeout,
      waitFor: (text) => regex.test(text),
    })
  }

  async click(
    pattern: string | RegExp,
    options?: { timeout?: number; first?: boolean },
  ): Promise<void> {
    const timeout = options?.timeout ?? 5000
    const first = options?.first ?? false
    const regex =
      typeof pattern === 'string'
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        : pattern

    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      await this.waitIdle({ timeout: 100 })

      const data = this.term.getJson()
      const matches: Array<{ x: number; y: number; text: string }> = []

      for (let y = 0; y < data.lines.length; y++) {
        const line = data.lines[y]
        let lineText = ''
        for (const span of line.spans) {
          lineText += span.text
        }

        let match: RegExpExecArray | null
        const searchRegex = new RegExp(
          regex.source,
          regex.flags.includes('g') ? regex.flags : regex.flags + 'g',
        )

        while ((match = searchRegex.exec(lineText)) !== null) {
          matches.push({ x: match.index, y, text: match[0] })
        }
      }

      if (matches.length === 0) {
        continue
      }

      if (matches.length > 1 && !first) {
        throw new Error(
          `click("${pattern}") found ${matches.length} matches. Use { first: true } to click the first match, or use a more specific pattern.`,
        )
      }

      const target = matches[0]
      await this.clickAt(target.x, target.y)
      return
    }

    throw new Error(`click("${pattern}") timed out after ${timeout}ms - pattern not found`)
  }

  async clickAt(x: number, y: number): Promise<void> {
    const xPos = x + 1
    const yPos = y + 1
    this.pty.write(`\x1b[<0;${xPos};${yPos}M`)
    await this.write(`\x1b[<0;${xPos};${yPos}m`)
  }

  resize(options: { cols: number; rows: number }): void {
    this.cols = options.cols
    this.rows = options.rows
    this.term.resize(options.cols, options.rows)
    this.pty.resize(options.cols, options.rows)
  }

  close(): void {
    this.pty.kill()
    this.term.destroy()
  }
}
