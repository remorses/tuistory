import { PersistentTerminal, StyleFlags, type TerminalData } from 'ghostty-opentui'
import { spawn, type IPty } from 'tuistory/pty'

export interface LaunchOptions {
  command: string
  args?: string[]
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
  /** If true, include cursor marker in text snapshots. Default: false */
  showCursor?: boolean
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
  /** If true, trim trailing whitespace/empty lines. Default: false */
  trimEnd?: boolean
  /** If true, return text immediately without waiting for idle. Useful for capturing intermediate frames. */
  immediate?: boolean
  /** Override session-level cursor visibility for this snapshot call. */
  showCursor?: boolean
}

/** Unicode character used to indicate cursor position in snapshots. */
export const CURSOR_CHAR = '█'

// Define key arrays as const to derive types from them
const LETTERS = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
  'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't',
  'u', 'v', 'w', 'x', 'y', 'z',
] as const

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

const SPECIAL_KEYS = [
  'enter', 'return', 'esc', 'escape', 'tab', 'space', 'backspace', 'delete',
  'insert', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'clear', 'linefeed', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9',
  'f10', 'f11', 'f12',
] as const

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const

const PUNCTUATION = [
  '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`',
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+',
  '{', '}', '|', ':', '"', '<', '>', '?', '~',
] as const

// Derive types from arrays
type Letter = typeof LETTERS[number]
type Digit = typeof DIGITS[number]
type SpecialKey = typeof SPECIAL_KEYS[number]
type Modifier = typeof MODIFIERS[number]
type Punctuation = typeof PUNCTUATION[number]

export type Key = SpecialKey | Modifier | Letter | Digit | Punctuation

// Build VALID_KEYS set from the arrays (always in sync with types)
export const VALID_KEYS = new Set<string>([
  ...LETTERS,
  ...DIGITS,
  ...SPECIAL_KEYS,
  ...MODIFIERS,
  ...PUNCTUATION,
])

export function isValidKey(key: string): key is Key {
  return VALID_KEYS.has(key.toLowerCase())
}

const CSI_U_KEYCODES: Record<string, number> = {
  enter: 13,
  return: 13,
  tab: 9,
  backspace: 127,
  escape: 27,
  esc: 27,
}

const KEY_CODES: Record<string, string> = {
  enter: '\r',
  return: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  space: ' ',
  backspace: '\x7f',
  delete: '\x1b[3~',
  insert: '\x1b[2~',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  clear: '\x1b[E',
  linefeed: '\n',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
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
  private hasReceivedData = false
  private dataResolvers: Array<() => void> = []
  private closed = false
  private showCursor: boolean

  constructor(options: LaunchOptions) {
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.showCursor = options.showCursor ?? false

    this.term = new PersistentTerminal({
      cols: this.cols,
      rows: this.rows,
    })

    const env = {
      ...process.env,
      ...options.env,
      TERM: 'xterm-truecolor',
      COLORTERM: 'truecolor',
      TERMCAST_DB_SUFFIX:
        options.env?.TERMCAST_DB_SUFFIX ||
        `tuistory-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }

    this.pty = spawn(options.command, options.args ?? [], {
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd ?? process.cwd(),
      env,
    })

    this.pty.onData((data) => {
      if (this.closed) return
      this.term.feed(data)
      if (!this.hasReceivedData) {
        this.hasReceivedData = true
        const dataResolvers = this.dataResolvers.splice(0)
        dataResolvers.forEach((fn) => fn())
      }
      clearTimeout(this.idleTimer)
      // Wait for content to stabilize after last data
      // TUI apps do multiple writes during render, so we need to wait until
      // no more data arrives for a period of time
      this.idleTimer = setTimeout(() => {
        if (this.closed) return
        const resolvers = this.idleResolvers.splice(0)
        resolvers.forEach((fn) => {
          fn()
        })
      }, 60) // Wait 60ms after last data for content to stabilize
    })
  }

  async waitForData(options?: { timeout?: number }): Promise<void> {
    if (this.hasReceivedData) {
      return
    }
    const timeout = options?.timeout ?? 5000
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`waitForData timed out after ${timeout}ms - no data received from PTY`))
      }, timeout)
      this.dataResolvers.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  async waitIdle(options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 500
    return new Promise<void>((resolve) => {
      if (!this.idleTimer) {
        setTimeout(resolve, Math.min(timeout, 20))
        return
      }
      const t = setTimeout(resolve, timeout)
      this.idleResolvers.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async write(data: string): Promise<void> {
    this.pty.write(data)
    return this.waitIdle()
  }

  /**
   * Write raw data to the PTY without waiting for idle.
   * Useful for capturing intermediate frames during layout transitions.
   */
  writeRaw(data: string): void {
    this.pty.write(data)
  }

  async type(text: string): Promise<void> {
    for (const char of text) {
      this.pty.write(char)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await this.waitIdle()
  }

  /**
   * Convert key(s) to their escape code representation.
   */
  private getKeyCode(keys: Key | Key[]): string {
    const keyArray = Array.isArray(keys) ? keys : [keys]

    const hasCtrl = keyArray.includes('ctrl')
    const hasAlt = keyArray.includes('alt')
    const hasShift = keyArray.includes('shift')

    const mainKeys = keyArray.filter(
      (k) => k !== 'ctrl' && k !== 'alt' && k !== 'shift' && k !== 'meta',
    )

    if (mainKeys.length === 0) {
      return ''
    }

    const codes: string[] = []
    for (const key of mainKeys) {
      let code: string

      if (hasCtrl && key.length === 1) {
        const ctrlCode = CTRL_CODES[key.toLowerCase()]
        if (ctrlCode) {
          code = ctrlCode
        } else {
          code = key
        }
      } else if ((hasCtrl || hasAlt || hasShift) && CSI_U_KEYCODES[key]) {
        // Use CSI u encoding for special keys with modifiers: \x1b[keycode;modifiersu
        // Modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
        const keycode = CSI_U_KEYCODES[key]
        const modifier = 1 + (hasShift ? 1 : 0) + (hasAlt ? 2 : 0) + (hasCtrl ? 4 : 0)
        code = `\x1b[${keycode};${modifier}u`
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

      codes.push(code)
    }
    return codes.join('')
  }

  async press(keys: Key | Key[]): Promise<void> {
    const code = this.getKeyCode(keys)
    if (code) {
      await this.write(code)
    }
  }

  /**
   * Send key(s) without waiting for idle. 
   * Useful for capturing intermediate frames during layout transitions.
   */
  sendKey(keys: Key | Key[]): void {
    const code = this.getKeyCode(keys)
    if (code) {
      this.pty.write(code)
    }
  }

  private buildTextFromJson(
    data: TerminalData, 
    only?: TextOptions['only'], 
    trimEnd?: boolean,
    includeCursor: boolean = true,
  ): string {
    const lines: string[] = []
    const [cursorX, cursorYScreen] = data.cursor
    // Cursor Y is screen-relative, but lines array includes scrollback
    // Adjust cursor Y by scrollback offset to get absolute line index
    const scrollbackOffset = data.lines.length - data.rows
    const cursorY = cursorYScreen + scrollbackOffset

    for (let rowIndex = 0; rowIndex < data.lines.length; rowIndex++) {
      const line = data.lines[rowIndex]
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

      // Replace character at cursor position with cursor indicator (only if cursor is visible)
      if (includeCursor && data.cursorVisible && rowIndex === cursorY) {
        const before = lineText.slice(0, cursorX)
        const after = lineText.slice(cursorX + 1)
        lineText = before + CURSOR_CHAR + after
      }

      lines.push(lineText)
    }

    return this.cleanupText(lines, trimEnd)
  }

  private cleanupText(lines: string[], trimEnd: boolean = true): string {
    // Always trimEnd each line.
    const linesTrimmed = lines.map((l) => l.replace(/\s+$/, ''));

    if (!trimEnd) {
      // No trimming of trailing empty lines or deindentation
      return '\n' + linesTrimmed.join('\n');
    }

    let lastNonEmpty = linesTrimmed.length - 1;
    while (lastNonEmpty >= 0 && linesTrimmed[lastNonEmpty].trim() === '') {
      lastNonEmpty--;
    }
    const trimmed = linesTrimmed.slice(0, lastNonEmpty + 1);

    return '\n' + trimmed.join('\n');
  }


  async text(options?: TextOptions): Promise<string> {
    const trimEnd = options?.trimEnd ?? false
    const showCursor = options?.showCursor ?? this.showCursor

    const stripHiddenCursorStyling = (text: string): string => {
      // Some renderers encode the cursor as reverse-video SGR sequences in the
      // captured text stream. When snapshots are taken with showCursor=false
      // (default), strip these to avoid flakey diffs.
      if (showCursor) return text
      return text.replaceAll('\x1b[7m', '').replaceAll('\x1b[27m', '')
    }

    const getCurrentText = (): string => {
      const data = this.term.getJson()
      return stripHiddenCursorStyling(
        this.buildTextFromJson(data, options?.only, trimEnd, showCursor),
      )
    }

    const getCurrentWaitText = (): string => {
      const data = this.term.getJson()
      return stripHiddenCursorStyling(
        this.buildTextFromJson(data, options?.only, trimEnd, false),
      )
    }

    // If immediate, return text without waiting
    if (options?.immediate) {
      return getCurrentText()
    }

    const timeout = options?.timeout ?? 1000
    const waitFor = options?.waitFor ?? ((text: string) => text.trim().length > 0)
    const normalizeForWait = (text: string): string => {
      return text.replaceAll(CURSOR_CHAR, '')
    }
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      await this.waitIdle({ timeout: 15 })
      const text = getCurrentText()
      const waitText = getCurrentWaitText()
      if (waitFor(normalizeForWait(waitText))) {
        // Give the renderer one more idle cycle to settle.
        // Many UIs paint the main content first and footer/overlays right after.
        await this.waitIdle({ timeout: 15 })
        return getCurrentText()
      }
    }

    const finalText = getCurrentText()
    const finalWaitText = getCurrentWaitText()
    if (!waitFor(normalizeForWait(finalWaitText))) {
      throw new Error(`text() timed out after ${timeout}ms waiting for condition. Current terminal content:\n${finalText}`)
    }
    return finalText
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

  /**
   * Capture multiple frames rapidly after sending a key.
   * Useful for detecting layout shifts or transitions.
   * 
   * @param keys - Key(s) to press
   * @param options.frameCount - Number of frames to capture (default: 5)
   * @param options.intervalMs - Milliseconds between frame captures (default: 10)
   * @returns Array of captured frames (text snapshots)
   */
  async captureFrames(
    keys: Key | Key[],
    options?: { frameCount?: number; intervalMs?: number },
  ): Promise<string[]> {
    const frameCount = options?.frameCount ?? 5
    const intervalMs = options?.intervalMs ?? 10
    const frames: string[] = []

    // Send the key without waiting
    this.sendKey(keys)

    // Capture frames at intervals
    for (let i = 0; i < frameCount; i++) {
      frames.push(await this.text({ immediate: true }))
      if (i < frameCount - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }

    // Wait for idle after capturing
    await this.waitIdle()

    return frames
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
      await this.waitIdle({ timeout: 15 })

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

  /**
   * Scroll up at a specific position using mouse wheel events.
   * @param lines Number of scroll events to send (default: 1)
   * @param x X coordinate for the scroll event (default: center of terminal)
   * @param y Y coordinate for the scroll event (default: center of terminal)
   */
  async scrollUp(lines: number = 1, x?: number, y?: number): Promise<void> {
    const xPos = (x ?? Math.floor(this.cols / 2)) + 1
    const yPos = (y ?? Math.floor(this.rows / 2)) + 1
    // SGR mouse scroll up: button 64 (scroll up = 4 | 64 = 64)
    const scrollEvent = `\x1b[<64;${xPos};${yPos}M`
    this.pty.write(scrollEvent.repeat(lines))
    return this.waitIdle()
  }

  /**
   * Scroll down at a specific position using mouse wheel events.
   * @param lines Number of scroll events to send (default: 1)
   * @param x X coordinate for the scroll event (default: center of terminal)
   * @param y Y coordinate for the scroll event (default: center of terminal)
   */
  async scrollDown(lines: number = 1, x?: number, y?: number): Promise<void> {
    const xPos = (x ?? Math.floor(this.cols / 2)) + 1
    const yPos = (y ?? Math.floor(this.rows / 2)) + 1
    // SGR mouse scroll down: button 65 (scroll down = 5 | 64 = 65)
    const scrollEvent = `\x1b[<65;${xPos};${yPos}M`
    this.pty.write(scrollEvent.repeat(lines))
    return this.waitIdle()
  }

  /** Get the raw terminal data for image rendering or other processing */
  getTerminalData(): TerminalData {
    return this.term.getJson()
  }

  resize(options: { cols: number; rows: number }): void {
    this.cols = options.cols
    this.rows = options.rows
    this.term.resize(options.cols, options.rows)
    this.pty.resize(options.cols, options.rows)
  }

  close(): void {
    this.closed = true
    clearTimeout(this.idleTimer)
    this.pty.kill()
    this.term.destroy()
  }
}
