#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as errore from 'errore'
import { goke, GokeProcessExit, type GokeOptions } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import pc from 'picocolors'
import { isAgent } from 'std-env'
import { Session, type Key, isValidKey, VALID_KEYS } from './session.js'

// Domain errors — errore tagged errors for typed error handling.
// These replace throw/catch patterns with Error | T return types.

class RelayConnectionError extends errore.createTaggedError({
  name: 'RelayConnectionError',
  message: 'Failed to connect to relay on port $port: $reason',
}) {}

class RelayStartError extends errore.createTaggedError({
  name: 'RelayStartError',
  message: 'Failed to $action relay server: $reason',
}) {}

class SessionCommandError extends errore.createTaggedError({
  name: 'SessionCommandError',
  message: 'Failed to $operation session "$session": $reason',
}) {}

class PidFileError extends errore.createTaggedError({
  name: 'PidFileError',
  message: 'PID file operation failed for $path: $reason',
}) {}

// Normalize unknown catch values to a reason string.
// errore.tryAsync catch receives unknown — this safely extracts the message.
function errorReason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Constants
export const RELAY_PORT = Number(process.env.TUISTORY_PORT) || 19977
const LOG_BASE_DIR = os.platform() === 'win32' ? os.tmpdir() : '/tmp'
const TUISTORY_DIR = path.join(LOG_BASE_DIR, 'tuistory')
export const LOG_FILE_PATH = process.env.TUISTORY_LOG_FILE_PATH || path.join(TUISTORY_DIR, 'relay-server.log')
const PID_FILE = path.join(TUISTORY_DIR, `relay-${RELAY_PORT}.pid`)
const RESTART_LOCK_FILE = path.join(TUISTORY_DIR, `restart-${RELAY_PORT}.lock`)

const __filename = fileURLToPath(import.meta.url)

const packageJsonPath = path.join(path.dirname(__filename), '..', 'package.json')
const VERSION = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).version as string
const DEFAULT_SCREENSHOT_PADDING_CELLS = 2
const MONOSPACE_CELL_WIDTH_FACTOR = 0.6

// Logger utility
interface Logger {
  log(...args: unknown[]): Promise<void>
  error(...args: unknown[]): Promise<void>
  logFilePath: string
}

function createFileLogger(logFilePath: string = LOG_FILE_PATH): Logger {
  const logDir = path.dirname(logFilePath)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  // Append mode - don't clear file on restart
  let queue: Promise<void> = Promise.resolve()

  const log = (...args: unknown[]): Promise<void> => {
    const timestamp = new Date().toISOString()
    const message = args.map(arg =>
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    ).join(' ')
    queue = queue.then(() => {
      return fs.promises.appendFile(logFilePath, `[${timestamp}] ${message}\n`)
    })
    return queue
  }

  return {
    log,
    error: log,
    logFilePath,
  }
}

function createCommandResultStream(ctx: CommandResult, key: 'stdout' | 'stderr') {
  return {
    write(data: string) {
      ctx[key] += data
    },
  }
}

// Command result interface
interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface LaunchOptions {
  '--': string[]
  session?: string
  cols: number
  rows: number
  cwd?: string
  env?: string[]
  attach?: boolean
  // `--no-wait` produces `noWait?: boolean` on the inferred type
  noWait?: boolean
  timeout: number
}

// Parse pattern - auto-detect regex from /pattern/flags syntax
function parsePattern(input: string): string | RegExp {
  const match = input.match(/^\/(.+)\/([gimsuy]*)$/)
  if (match) {
    return new RegExp(match[1], match[2])
  }
  return input
}

// Parse env option (array of key=value strings)
function parseEnvOptions(env: string[] | undefined): Record<string, string> {
  if (!env || !Array.isArray(env) || env.length === 0) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const e of env) {
    if (typeof e !== 'string') {
      continue
    }
    const idx = e.indexOf('=')
    if (idx > 0) {
      result[e.slice(0, idx)] = e.slice(idx + 1)
    }
  }
  return result
}

function getDefaultSessionName(command: string): string {
  return command
}

function getLaunchCommandFromArgv(argv: string[]): string | null {
  const launchIndex = argv.indexOf('launch')
  const commandArgs = launchIndex === -1 ? argv.slice(2) : argv.slice(launchIndex + 1)

  for (const arg of commandArgs) {
    if (arg === '--') return null
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}

function yamlKey(key: string): string {
  return `${ansi('36', key)}${ansi('90', ':')}`
}

function yamlString(value: string): string {
  const quote = ansi('90', '"')
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `${quote}${ansi('32', escaped)}${quote}`
}

function yamlNumber(value: number): string {
  return ansi('35', String(value))
}

function ansi(code: string, value: string): string {
  return `\x1b[${code}m${value}\x1b[39m`
}

// Create CLI with commands - actions write to ctx
function createCliWithActions(
  ctx: CommandResult,
  sessions: Map<string, Session>,
  logger: Logger,
  gokeOptions?: GokeOptions,
) {
  const cli = goke('tuistory', gokeOptions)

  // Helper to validate session exists
  const getSession = (sessionName: string): Session | null => {
    const session = sessions.get(sessionName)
    if (!session) {
      ctx.stderr = `Session "${sessionName}" not found`
      ctx.exitCode = 1
      return null
    }
    return session
  }

  // Helper to require session option
  const requireSession = (options: { session?: string }): string | null => {
    if (!options.session) {
      ctx.stderr = 'Error: -s/--session is required'
      ctx.exitCode = 1
      return null
    }
    return options.session
  }

  const launchDescription = dedent`
    Launch a new terminal session with a PTY (pseudo-terminal).

    Spawns the given command in a virtual terminal with configurable
    dimensions. The command string is parsed like a shell — spaces
    separate arguments, quotes group them.

    The session runs inside a background daemon so it persists
    across multiple tuistory invocations. Use \`-s\` to name
    sessions for easy reference.

    **Tip:** Always run \`snapshot --trim\` after launch to see
    the initial terminal state — many apps show first-run dialogs
    or login prompts you need to handle.
  `

  const addLaunchOptions = (command: any) => command
    .option('-s, --session <name>', 'Session name (defaults to command)')
    .option('--cols <n>', z.number().default(120).describe('Terminal columns'))
    .option('--rows <n>', z.number().default(36).describe('Terminal rows'))
    .option('--cwd <path>', 'Working directory')
    .option('--env <key=value>', z.array(z.string()).describe('Environment variable (repeatable)'))
    .option('--attach', 'Attach after launching when not running inside an agent')
    .option('--no-wait', "Don't wait for initial data")
    .option('--timeout <ms>', z.number().default(5000).describe('Wait timeout in milliseconds'))

  const launchAction = async ({ command, options, runtime }: {
    command: string | null | undefined
    options: LaunchOptions
    runtime: { process: { cwd: string } }
  }) => {
    const launchCommand = command ?? (options['--'].length > 0 ? options['--'].join(' ') : null)
    if (!launchCommand) {
      ctx.stderr = 'Error: missing command. Pass one as `tuistory launch "cmd"` or `tuistory launch -- cmd`.'
      ctx.exitCode = 1
      return
    }

    const sessionName = options.session ?? getDefaultSessionName(launchCommand)

    // Check for duplicate session name
    const existingSession = sessions.get(sessionName)
    if (existingSession) {
      ctx.stderr = dedent`
        Session "${sessionName}" already exists.
        Existing session:
          command: ${existingSession.currentCommand}
          cwd: ${existingSession.currentCwd}
          read: tuistory read -s ${shellQuote(sessionName)} --all
      `
      ctx.exitCode = 1
      return
    }

    const env = {
      ...parseEnvOptions(options.env),
      TUISTORY_SESSION: sessionName,
    }

    // Let the shell handle command parsing — supports pipes, env vars, subshells, etc.
    const isWindows = os.platform() === 'win32'
    const session = errore.try(() => new Session({
      command: isWindows ? 'cmd.exe' : 'sh',
      args: isWindows ? ['/c', launchCommand] : ['-c', launchCommand],
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd ?? runtime.process.cwd,
      env,
      label: launchCommand,
    }))
    if (session instanceof Error) {
      ctx.stderr = new SessionCommandError({ operation: 'launch', session: sessionName, reason: errorReason(session), cause: session }).message
      ctx.exitCode = 1
      return
    }

    sessions.set(sessionName, session)

    // Log when PTY process exits so daemon operators can see what happened.
    // Don't auto-remove — the user may still want to read the last snapshot.
    session.onExit((info) => {
      void logger.log(`Session "${sessionName}" PTY exited (code: ${info.exitCode}, signal: ${info.signal})`)
    })

    if (!options.noWait) {
      const waited = await errore.tryAsync({
        try: () => session.waitForData({ timeout: options.timeout }),
        catch: (e) => new SessionCommandError({ operation: 'launch', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (waited instanceof Error) {
        ctx.stderr = waited.message
        ctx.exitCode = 1
        return
      }
    }

    ctx.stdout = `Session "${sessionName}" started`
    void logger.log(`Session "${sessionName}" started: ${launchCommand}`)
  }

  addLaunchOptions(cli.command('launch [command]', launchDescription))
    .example('tuistory launch "claude" -s claude --cols 150 --rows 45')
    .example('tuistory launch "node" -s repl --cols 120')
    .example('tuistory launch "bash --norc" -s sh --env PS1="$ " --env FOO=bar')
    .example(dedent`
      # Launch and immediately check what the app shows:
      tuistory launch "claude" -s ai && tuistory -s ai snapshot --trim
    `)
    .action((command, options, runtime) => launchAction({ command, options, runtime }))

  cli
    .command('snapshot', dedent`
      Capture the current terminal screen as text.

      Returns the full text content of the terminal buffer.
      By default, waits for the terminal to become idle before
      capturing (no new data for ~60ms).

      Use \`--trim\` to strip trailing whitespace and empty lines
      for cleaner output. Use \`--json\` to get structured output
      with session metadata.

      **Style filters:** Use \`--bold\`, \`--italic\`, \`--fg\`,
      \`--bg\` to extract only text matching specific styles.
      Non-matching characters are replaced with spaces to
      preserve layout.

      **Best practice:** Run snapshot after every action (type,
      press, click) to see what happened. Terminal apps are
      stateful and may show unexpected dialogs or errors.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--json', 'Output as JSON with metadata')
    .option('--trim', 'Trim trailing whitespace and empty lines')
    .option('--immediate', "Don't wait for idle state")
    .option('--bold', 'Only bold text')
    .option('--italic', 'Only italic text')
    .option('--underline', 'Only underlined text')
    .option('--fg <color>', 'Only text with foreground color')
    .option('--bg <color>', 'Only text with background color')
    .option('--no-cursor', 'Hide cursor in snapshot output')
    .example('tuistory -s claude snapshot --trim')
    .example('tuistory -s claude snapshot --json')
    .example('tuistory -s claude snapshot --bold --trim')
    .example(dedent`
      # Always snapshot after an action to see the result:
      tuistory -s app press enter && tuistory -s app snapshot --trim
    `)
    .action(async (options: {
      session?: string
      json?: boolean
      trim?: boolean
      immediate?: boolean
      bold?: boolean
      italic?: boolean
      underline?: boolean
      fg?: string
      bg?: string
      // `--no-cursor` produces `noCursor?: boolean` on the inferred type
      noCursor?: boolean
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const only: Record<string, boolean | string> = {}
      if (options.bold) only.bold = true
      if (options.italic) only.italic = true
      if (options.underline) only.underline = true
      if (options.fg) only.foreground = options.fg
      if (options.bg) only.background = options.bg

      const text = await errore.tryAsync({
        try: () => session.text({
          trimEnd: options.trim,
          immediate: options.immediate,
          showCursor: !options.noCursor,
          only: Object.keys(only).length > 0 ? only as any : undefined,
        }),
        catch: (e) => new SessionCommandError({ operation: 'snapshot', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (text instanceof Error) {
        ctx.stderr = text.message
        ctx.exitCode = 1
        return
      }

      ctx.stdout = options.json
        ? JSON.stringify({ text, session: sessionName })
        : text
    })

  cli
    .command('read', dedent`
      Read new process output since the last \`read\` call.

      Returns all text the process has printed since you last called
      \`read\` on this session. ANSI escape codes are stripped — you
      get clean, readable text.

      Unlike \`snapshot\` (which shows the current visible screen),
      \`read\` gives you the full output stream. If a process printed
      500 lines but only 36 fit on screen, \`snapshot\` shows the last
      36 — \`read\` gives you all 500.

      Each call advances a cursor, so the next \`read\` only returns
      newer output. Use \`--all\` to get the entire buffered output
      (up to 1MB) without advancing the cursor.

      Use \`--follow\` to block until new output arrives — like
      \`tail -f\` but for any process managed by tuistory.

      **Replaces \`sleep\` + \`tmux capture-pane\`** — instead of
      guessing how long to wait, \`read --follow\` reacts the moment
      new output appears.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--all', 'Return entire buffered output (up to 1MB), without advancing read cursor')
    .option('--trim', 'Trim trailing whitespace and empty lines')
    .option('--follow', 'Block until new output arrives, then return it')
    .option('--timeout <ms>', z.number().default(5000).describe('Timeout for --follow in milliseconds'))
    .example('tuistory read -s myapp')
    .example('tuistory read -s myapp --all')
    .example('tuistory read -s myapp --follow --timeout 30000')
    .example(dedent`
      # Launch a dev server and read its full startup output:
      tuistory launch "pnpm dev" -s dev
      tuistory -s dev wait "ready" --timeout 30000
      tuistory read -s dev
    `)
    .example(dedent`
      # Run a command, wait for it to stabilize, then read output:
      tuistory launch "npm test" -s test
      tuistory -s test wait-idle --timeout 10000
      tuistory read -s test
    `)
    .action(async (options: {
      session?: string
      all?: boolean
      trim?: boolean
      follow?: boolean
      timeout: number
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) return

      const session = getSession(sessionName)
      if (!session) return

      if (options.all) {
        ctx.stdout = options.trim ? session.readAll().trimEnd() : session.readAll()
        return
      }

      if (options.follow) {
        // If there's already unread output, return it immediately
        if (session.hasUnreadOutput()) {
          const output = session.read()
          ctx.stdout = options.trim ? output.trimEnd() : output
          return
        }
        // Poll for new output until timeout — waitIdle resolves after each
        // batch of PTY data settles (60ms debounce), so we check repeatedly
        const startTime = Date.now()
        while (Date.now() - startTime < options.timeout) {
          await errore.tryAsync({
            try: () => session.waitIdle({ timeout: Math.min(500, options.timeout - (Date.now() - startTime)) }),
            catch: () => new Error('idle timeout'),
          })
          if (session.hasUnreadOutput()) {
            const output = session.read()
            ctx.stdout = options.trim ? output.trimEnd() : output
            return
          }
        }
        // Timed out with no new output
        ctx.stderr = `No new output after ${options.timeout}ms`
        ctx.exitCode = 1
        return
      }

      const output = session.read()
      ctx.stdout = options.trim ? output.trimEnd() : output
    })

  cli
    .command('screenshot', dedent`
      Capture the terminal screen as an image file (JPEG/PNG/WebP).

      Renders the current terminal buffer to a colored image with
      JetBrains Mono Nerd font on a fixed-width character grid.
      Outputs the image file path to stdout.

      **For AI agents and bots:** Use this to screenshot terminal
      TUI applications and share them with users via messaging
      apps. Bots like kimaki or openclaw can show users live
      progress of terminal commands by uploading the image.
      Use \`--pixel-ratio 2\` for sharp images on social media and sharing.

      **Important:** Screenshots are expensive. Always use
      \`snapshot\` or \`wait\` first to confirm the content is on
      screen, then \`screenshot\` only when you're sure.

      Using tuistory is preferable over tmux background sessions
      because you can programmatically control the terminal (type,
      press keys, wait for text, resize) and capture pixel-perfect
      screenshots — designed from first principles for agents.

      Waits for the terminal to become idle before capturing unless
      \`--immediate\` is passed.

      By default, screenshots include a 2-cell frame. If \`--frame-color\`
      is not provided, the frame color is auto-detected from terminal edge
      cells to match the app chrome/background.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('-o, --output <path>', 'Output file path (default: temp file)')
    .option('--width <px>', z.number().describe('Image width in pixels (auto from cols)'))
    .option('--font-size <px>', z.number().default(14).describe('Font size in pixels'))
    .option('--line-height <n>', z.number().default(1.5).describe('Line height multiplier'))
    .option('--background <color>', z.string().default('#1a1b26').describe('Background color'))
    .option('--foreground <color>', z.string().default('#c0caf5').describe('Text color'))
    .option('--format <fmt>', z.enum(['jpeg', 'png', 'webp']).default('jpeg').describe('Image format'))
    .option('--quality <n>', z.number().default(90).describe('Quality for lossy formats (0-100)'))
    .option('--pixel-ratio <n>', z.number().default(1).describe('Device pixel ratio for HiDPI rendering'))
    .option('--padding <cells>', z.number().min(0).default(DEFAULT_SCREENSHOT_PADDING_CELLS).describe('Frame padding in terminal cells (default: 2)'))
    .option('--frame-color <color>', z.string().describe('Color of the frame/padding area (default: auto-detect from terminal edge colors)'))
    .option('--immediate', "Don't wait for idle state")
    .example('tuistory -s claude screenshot -o screenshot.jpg --pixel-ratio 2')
    .example('tuistory -s claude screenshot --format png --font-size 20')
    .example('tuistory -s claude screenshot --background "#ffffff" --foreground "#24292e"')
    .example('tuistory -s claude screenshot --padding 2 --frame-color "#ff6600"')
    .action(async (options: {
      session?: string
      output?: string
      width?: number
      fontSize: number
      lineHeight: number
      background: string
      foreground: string
      format: 'jpeg' | 'png' | 'webp'
      quality: number
      pixelRatio: number
      padding: number
      frameColor?: string
      immediate?: boolean
    }, { fs }) => {
      const sessionName = requireSession(options)
      if (!sessionName) return

      const session = getSession(sessionName)
      if (!session) return

      // Wait for idle unless --immediate
      if (!options.immediate) {
        const idle = await errore.tryAsync({
          try: () => session.text({ immediate: false, timeout: 2000 }),
          catch: (e) => new SessionCommandError({ operation: 'screenshot', session: sessionName, reason: errorReason(e), cause: e }),
        })
        if (idle instanceof Error) {
          ctx.stderr = idle.message
          ctx.exitCode = 1
          return
        }
      }

      const data = session.getTerminalData()
      const { renderTerminalToImage } = await import('ghostty-opentui/image')

      const image = await errore.tryAsync({
        try: () => {
          const paddingPx = Math.round(options.padding * options.fontSize * MONOSPACE_CELL_WIDTH_FACTOR)
          const renderOptions = {
            width: options.width,
            fontSize: options.fontSize,
            lineHeight: options.lineHeight,
            paddingX: paddingPx,
            paddingY: paddingPx,
            theme: { background: options.background, text: options.foreground },
            format: options.format,
            quality: options.quality,
            devicePixelRatio: options.pixelRatio,
            ...(options.frameColor ? { frameColor: options.frameColor } : {}),
          }
          return renderTerminalToImage(data, renderOptions)
        },
        catch: (e) => new SessionCommandError({ operation: 'screenshot', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (image instanceof Error) {
        ctx.stderr = image.message
        ctx.exitCode = 1
        return
      }

      const outputPath = options.output ?? path.join(os.tmpdir(), `tuistory-screenshot-${Date.now()}.${options.format}`)
      const written = await errore.tryAsync({
        try: () => fs.writeFile(outputPath, image),
        catch: (e) => e,
      })
      if (written instanceof Error) {
        ctx.stderr = new SessionCommandError({ operation: 'screenshot', session: sessionName, reason: errorReason(written), cause: written }).message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = outputPath
    })

  cli
    .command('type <text>', dedent`
      Type text into the terminal character by character.

      Sends each character individually with a small delay between
      them, simulating real user typing. This triggers per-keystroke
      events in the target application (autocomplete, search-as-you-type,
      input validation, etc.).

      The text is sent as-is — no shell escaping or interpretation.
      For special keys like Enter or Ctrl+C, use \`press\` instead.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .example('tuistory -s claude type "what is 2+2?"')
    .example(dedent`
      # Type a command and press enter, then snapshot:
      tuistory -s sh type "echo hello" && tuistory -s sh press enter && tuistory -s sh snapshot --trim
    `)
    .action(async (text: string, options: { session?: string }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const result = await errore.tryAsync({
        try: () => session.type(text),
        catch: (e) => new SessionCommandError({ operation: 'type', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('press <key> [...keys]', dedent`
      Press one or more keys simultaneously (key chord).

      Sends a key or key combination to the terminal. Multiple keys
      are pressed together as a chord (e.g. \`ctrl c\` sends Ctrl+C).

      **Available keys:**
      - Modifiers: ctrl, alt, shift, meta
      - Navigation: up, down, left, right, home, end, pageup, pagedown
      - Actions: enter, esc, tab, space, backspace, delete, insert
      - Function: f1-f12
      - Letters: a-z
      - Digits: 0-9

      **Note:** \`enter\` is named "return" internally but both work.
      For typing text, use \`type\` instead.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .example('tuistory -s claude press enter')
    .example('tuistory -s app press ctrl c')
    .example('tuistory -s app press tab')
    .example(dedent`
      # Press enter and see the result:
      tuistory -s claude press enter && tuistory -s claude snapshot --trim
    `)
    .action(async (key: string, keys: string[], options: { session?: string }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const allKeys = [key, ...keys]
      const invalidKeys = allKeys.filter((k) => !isValidKey(k))
      if (invalidKeys.length > 0) {
        ctx.stderr = `Invalid key(s): ${invalidKeys.join(', ')}\nValid keys: ${Array.from(VALID_KEYS).sort().join(', ')}`
        ctx.exitCode = 1
        return
      }
      const result = await errore.tryAsync({
        try: () => session.press(allKeys as Key[]),
        catch: (e) => new SessionCommandError({ operation: 'press', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('click <pattern>', dedent`
      Click on text matching a pattern in the terminal.

      Searches the terminal screen for text matching the given
      pattern and sends a mouse click event at its position.
      Supports plain text and regex patterns (use /pattern/ syntax).

      If multiple matches are found, the command fails unless
      \`--first\` is passed. Use a more specific pattern or regex
      to match exactly one element.

      Waits up to \`--timeout\` ms for the pattern to appear,
      polling the terminal contents.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--first', 'Click first match if multiple found')
    .option('--timeout <ms>', z.number().default(5000).describe('Timeout in milliseconds'))
    .example('tuistory -s app click "Submit"')
    .example('tuistory -s app click "/Button \\d+/" --first')
    .example(dedent`
      # Click a button and see what happens:
      tuistory -s app click "OK" && tuistory -s app snapshot --trim
    `)
    .action(async (pattern: string, options: {
      session?: string
      first?: boolean
      timeout: number
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const parsedPattern = parsePattern(pattern)
      const result = await errore.tryAsync({
        try: () => session.click(parsedPattern, { first: options.first, timeout: options.timeout }),
        catch: (e) => new SessionCommandError({ operation: 'click', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('click-at <x> <y>', dedent`
      Click at specific terminal coordinates (column, row).

      Sends a mouse click event at the given (x, y) position.
      Coordinates are 0-based: (0, 0) is the top-left corner.

      Useful when the target element doesn't have unique text
      to match with \`click\`, or for clicking on UI chrome
      like borders, scrollbars, or status bars.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .example('tuistory -s app click-at 10 5')
    .example(dedent`
      # Click at coordinates and snapshot:
      tuistory -s app click-at 0 0 && tuistory -s app snapshot --trim
    `)
    .action(async (x: string, y: string, options: { session?: string }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const result = await errore.tryAsync({
        try: () => session.clickAt(Number(x), Number(y)),
        catch: (e) => new SessionCommandError({ operation: 'click-at', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('wait <pattern>', dedent`
      Wait for text or regex pattern to appear in the terminal.

      Polls the terminal content until the pattern is found or
      timeout is reached. Useful for waiting on async operations
      like command output, loading screens, or API responses.

      Supports regex patterns with /pattern/flags syntax.
      Plain strings are matched literally.

      Returns "OK" when pattern is found, exits with error on timeout.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--timeout <ms>', z.number().default(5000).describe('Timeout in milliseconds'))
    .example('tuistory -s claude wait "Ready"')
    .example('tuistory -s claude wait "/[0-9]+/" --timeout 30000')
    .example(dedent`
      # Wait for output then snapshot:
      tuistory -s sh wait "Done" --timeout 60000 && tuistory -s sh snapshot --trim
    `)
    .action(async (pattern: string, options: {
      session?: string
      timeout: number
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const parsedPattern = parsePattern(pattern)
      const result = await errore.tryAsync({
        try: () => session.waitForText(parsedPattern, { timeout: options.timeout }),
        catch: (e) => new SessionCommandError({ operation: 'wait', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('wait-idle', dedent`
      Wait for the terminal to stop receiving data (become idle).

      Waits until no new data has been received for ~60ms,
      indicating the application has finished rendering.

      Useful between rapid actions to ensure the terminal has
      settled before taking a snapshot. Most commands already
      wait for idle internally, but this is helpful when you
      need explicit synchronization.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--timeout <ms>', z.number().default(500).describe('Timeout in milliseconds'))
    .example('tuistory -s app wait-idle')
    .example('tuistory -s app wait-idle --timeout 2000')
    .action(async (options: { session?: string; timeout: number }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const result = await errore.tryAsync({
        try: () => session.waitIdle({ timeout: options.timeout }),
        catch: (e) => new SessionCommandError({ operation: 'wait-idle', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('scroll <direction> [lines]', dedent`
      Scroll the terminal up or down using mouse wheel events.

      Sends SGR mouse scroll events at the center of the terminal
      (or at specific coordinates with --x/--y). The number of
      scroll events can be controlled with the [lines] argument.

      Direction must be "up" or "down".
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--x <n>', 'X coordinate for scroll event')
    .option('--y <n>', 'Y coordinate for scroll event')
    .example('tuistory -s app scroll down 5')
    .example('tuistory -s app scroll up 3')
    .example(dedent`
      # Scroll down and snapshot to see new content:
      tuistory -s app scroll down 10 && tuistory -s app snapshot --trim
    `)
    .action(async (direction: string, lines: string | undefined, options: {
      session?: string
      x?: string
      y?: string
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const lineCount = lines ? Number(lines) : 1
      const x = options.x ? Number(options.x) : undefined
      const y = options.y ? Number(options.y) : undefined

      if (direction !== 'up' && direction !== 'down') {
        ctx.stderr = `Invalid direction: ${direction}. Use "up" or "down"`
        ctx.exitCode = 1
        return
      }

      const result = await errore.tryAsync({
        try: () => direction === 'up' ? session.scrollUp(lineCount, x, y) : session.scrollDown(lineCount, x, y),
        catch: (e) => new SessionCommandError({ operation: 'scroll', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (result instanceof Error) {
        ctx.stderr = result.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('resize <cols> <rows>', dedent`
      Resize the terminal to new dimensions.

      Changes the terminal width (columns) and height (rows).
      The PTY and the virtual terminal emulator are both resized,
      triggering a SIGWINCH signal in the running application.

      Applications that handle terminal resize (like vim, htop,
      or TUI frameworks) will re-render to fit the new size.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .example('tuistory -s app resize 120 40')
    .example(dedent`
      # Resize and snapshot to see the new layout:
      tuistory -s app resize 200 50 && tuistory -s app snapshot --trim
    `)
    .action(async (cols: string, rows: string, options: { session?: string }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const result = errore.try(() => session.resize({ cols: Number(cols), rows: Number(rows) }))
      if (result instanceof Error) {
        ctx.stderr = new SessionCommandError({ operation: 'resize', session: sessionName, reason: result.message, cause: result }).message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = 'OK'
    })

  cli
    .command('capture-frames <key> [...keys]', dedent`
      Capture multiple rapid terminal snapshots after a keypress.

      Sends the key(s) and then captures N frames at a fixed
      interval. Useful for detecting layout shifts, animations,
      or transitions that happen in the frames immediately after
      a key event.

      Output is a JSON array of text snapshots.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .option('--count <n>', z.number().default(5).describe('Number of frames to capture'))
    .option('--interval <ms>', z.number().default(10).describe('Interval between frames in ms'))
    .example('tuistory -s app capture-frames enter --count 10 --interval 20')
    .example('tuistory -s app capture-frames tab --count 3')
    .action(async (key: string, keys: string[], options: {
      session?: string
      count: number
      interval: number
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const allKeys = [key, ...keys]
      const invalidKeys = allKeys.filter((k) => !isValidKey(k))
      if (invalidKeys.length > 0) {
        ctx.stderr = `Invalid key(s): ${invalidKeys.join(', ')}\nValid keys: ${Array.from(VALID_KEYS).sort().join(', ')}`
        ctx.exitCode = 1
        return
      }
      const frames = await errore.tryAsync({
        try: () => session.captureFrames(allKeys as Key[], { frameCount: options.count, intervalMs: options.interval }),
        catch: (e) => new SessionCommandError({ operation: 'capture-frames', session: sessionName, reason: errorReason(e), cause: e }),
      })
      if (frames instanceof Error) {
        ctx.stderr = frames.message
        ctx.exitCode = 1
        return
      }
      ctx.stdout = JSON.stringify(frames)
    })

  cli
    .command('close', dedent`
      Close a terminal session and kill its process.

      Terminates the PTY process and removes the session from
      the daemon. The session name can be reused after closing.
    `)
    .option('-s, --session <name>', 'Session name (required)')
    .example('tuistory -s claude close')
    .action(async (options: { session?: string }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      const closed = errore.try(() => session.close())
      if (closed instanceof Error) {
        ctx.stderr = new SessionCommandError({ operation: 'close', session: sessionName, reason: closed.message, cause: closed }).message
        ctx.exitCode = 1
        return
      }
      sessions.delete(sessionName)
      ctx.stdout = `Session "${sessionName}" closed`
      logger.log(`Session "${sessionName}" closed`)
    })

  cli
    .command('sessions', dedent`
      List all active sessions with their commands and working directories.

      Shows session name, command, cwd, and status. Sessions are created with
      \`launch\` and persist until \`close\` or \`daemon-stop\`.
    `)
    .example('tuistory sessions')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const entries = Array.from(sessions.entries())
      if (entries.length === 0) {
        ctx.stdout = 'No active sessions'
        return
      }
      if (options.json) {
        ctx.stdout = JSON.stringify(entries.map(([name, session]) => ({
          name,
          command: session.currentCommand,
          cwd: session.currentCwd,
          cols: session.currentCols,
          rows: session.currentRows,
          dead: session.isDead,
        })), null, 2)
        return
      }
      const lines = [yamlKey('sessions')]
      for (const [name, session] of entries) {
        const status = session.isDead ? ansi('31', 'dead') : ansi('32', 'alive')
        lines.push(`  ${ansi('90', '-')} ${yamlKey('name')} ${yamlString(name)}`)
        lines.push(`    ${yamlKey('status')} ${status}`)
        lines.push(`    ${yamlKey('command')} ${yamlString(session.currentCommand)}`)
        lines.push(`    ${yamlKey('cwd')} ${yamlString(session.currentCwd)}`)
        lines.push(`    ${yamlKey('cols')} ${yamlNumber(session.currentCols)}`)
        lines.push(`    ${yamlKey('rows')} ${yamlNumber(session.currentRows)}`)
      }
      ctx.stdout = lines.join('\n')
    })

  cli
    .command('logfile', dedent`
      Print the path to the daemon log file.

      The relay daemon writes logs to this file. Useful for
      debugging when commands fail or the daemon won't start.
    `)
    .example('tuistory logfile')
    .example('cat $(tuistory logfile)')
    .action(() => {
      ctx.stdout = LOG_FILE_PATH
    })

  // The daemon-stop command is handled client-side so it can stop stale daemons
  // that do not understand newer CLI commands yet.
  cli
    .command('daemon-stop', dedent`
      Stop the background relay daemon.

      The daemon runs as a detached process that holds all sessions in memory.
      Stopping it closes all active sessions. A new daemon starts automatically
      the next time you run a tuistory command.
    `)
    .example('tuistory daemon-stop')
    .action(() => {
      ctx.stdout = 'daemon-stop command must be run client-side, not through relay'
    })

  // The attach command is handled client-side (not through the relay HTTP endpoint)
  // because it needs to run an interactive TUI with direct stdin/stdout access.
  // This definition is only for --help display; the actual implementation is in
  // runAttachCommand() which runs before the relay forwarding path.
  cli
    .command('attach', dedent`
      Attach to a running session with an interactive TUI.

      Opens a fullscreen terminal view (React + OpenTUI) that renders
      the session's PTY output in real-time and forwards all keyboard
      input. When you detach, the session keeps running in the daemon.

      If no session is specified, shows an interactive picker when
      multiple sessions exist, or auto-selects when there's only one.

      **Requires Bun runtime** — if running under Node.js, the command
      re-spawns itself under Bun automatically.
    `)
    .option('-s, --session <name>', 'Session name (auto-selects if only one)')
    .example('tuistory attach -s claude')
    .example('tuistory attach')
    .action(() => {
      // No-op: handled client-side in runAttachCommand()
      ctx.stdout = 'attach command must be run client-side, not through relay'
    })

  addLaunchOptions(cli.command('<command>', launchDescription))
    .hidden()
    .action((command, options, runtime) => launchAction({ command, options, runtime }))

  // Global examples showing the full workflow pattern
  cli.example(dedent`
    # Full workflow: launch, interact, snapshot, close
    tuistory launch "claude" -s ai --cols 150 --rows 45
    tuistory -s ai wait "Claude" --timeout 15000
    tuistory -s ai type "what is 2+2?"
    tuistory -s ai press enter
    tuistory -s ai wait "/[0-9]+/" --timeout 30000
    tuistory -s ai snapshot --trim
    tuistory -s ai close
  `)

  cli.help()
  cli.version(VERSION)

  return cli
}

// Get relay server version (null if not running)
async function getRelayVersion(): Promise<string | null> {
  const response = await errore.tryAsync({
    try: () => fetch(`http://127.0.0.1:${RELAY_PORT}/version`, {
      signal: AbortSignal.timeout(500),
    }),
    catch: (e) => new RelayConnectionError({ port: String(RELAY_PORT), reason: 'connection refused or timeout', cause: e }),
  })
  if (response instanceof Error) return null
  if (!response.ok) return null

  const data = await errore.tryAsync({
    try: () => response.json() as Promise<{ version: string }>,
    catch: (e) => new RelayConnectionError({ port: String(RELAY_PORT), reason: 'invalid JSON response', cause: e }),
  })
  if (data instanceof Error) return null

  return data.version
}

// Compare two semver versions
// Returns: negative if v1 < v2, 0 if equal, positive if v1 > v2
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  const len = Math.max(parts1.length, parts2.length)

  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 !== p2) {
      return p1 - p2
    }
  }
  return 0
}

// Kill relay server using PID file (SIGTERM for graceful shutdown).
// Escalates to SIGKILL if SIGTERM doesn't work, then falls back to kill-port-process.
async function killRelay(): Promise<void> {
  const raw = errore.try(() => fs.readFileSync(PID_FILE, 'utf-8'))
  const pid = raw instanceof Error ? null : (() => {
    const n = Number(raw.trim())
    return isNaN(n) || n <= 0 ? null : n
  })()

  const processExited = pid !== null
    ? await killProcessByPid(pid)
    : false

  // Fallback: kill by port if PID-based kill didn't work or PID file was missing
  if (!processExited) {
    const portKill = await errore.tryAsync({
      try: async () => {
        const { killPortProcess } = await import('kill-port-process')
        await killPortProcess(RELAY_PORT)
      },
      catch: (e) => new PidFileError({ path: String(RELAY_PORT), reason: 'port-based kill failed', cause: e }),
    })
    if (portKill instanceof Error) {
      // Both PID and port-based kill failed — daemon may already be dead
    }
  }

  // Clean up PID file
  errore.try(() => fs.unlinkSync(PID_FILE))
}

// Send SIGTERM to a PID, wait up to 3s, escalate to SIGKILL if needed.
// Returns true if the process exited, false if it couldn't be killed.
async function killProcessByPid(pid: number): Promise<boolean> {
  const sendResult = errore.try(() => process.kill(pid, 'SIGTERM'))
  if (sendResult instanceof Error) return true // Process doesn't exist (stale PID)

  // Wait for process to exit (up to 3s)
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const alive = errore.try(() => process.kill(pid, 0))
    if (alive instanceof Error) return true // Process exited
    await new Promise((r) => setTimeout(r, 100))
  }

  // Escalate to SIGKILL if SIGTERM didn't work
  errore.try(() => process.kill(pid, 'SIGKILL'))
  // SIGKILL always succeeds if process exists; if it throws, process is already dead
  return true
}

// Acquire a file lock for daemon restart (prevents two clients racing to kill+restart).
// Returns true if lock acquired, false if another client is already restarting.
// Lock payload: "pid:timestamp" — only the lock owner (matching PID) can release it.
const RESTART_LOCK_STALE_MS = 10000

function acquireRestartLock(): boolean {
  ensureTuistoryDir()

  const created = errore.try(() => fs.writeFileSync(RESTART_LOCK_FILE, `${process.pid}:${Date.now()}`, { flag: 'wx' }))
  if (!(created instanceof Error)) return true

  // Lock file exists — check if stale (holder crashed)
  const content = errore.try(() => fs.readFileSync(RESTART_LOCK_FILE, 'utf-8'))
  if (content instanceof Error) return false

  const [pidStr, tsStr] = content.split(':')
  const lockPid = Number(pidStr)
  const lockTime = Number(tsStr)

  const isStale = Date.now() - lockTime > RESTART_LOCK_STALE_MS
    || (!isNaN(lockPid) && lockPid > 0 && errore.try(() => process.kill(lockPid, 0)) instanceof Error)

  if (!isStale) return false

  // Stale lock — remove and retry once
  errore.try(() => fs.unlinkSync(RESTART_LOCK_FILE))
  const retried = errore.try(() => fs.writeFileSync(RESTART_LOCK_FILE, `${process.pid}:${Date.now()}`, { flag: 'wx' }))
  return !(retried instanceof Error)
}

function releaseRestartLock(): void {
  // Only release if we own the lock (PID matches)
  const content = errore.try(() => fs.readFileSync(RESTART_LOCK_FILE, 'utf-8'))
  if (content instanceof Error) return

  const [pidStr] = content.split(':')
  if (Number(pidStr) === process.pid) {
    errore.try(() => fs.unlinkSync(RESTART_LOCK_FILE))
  }
}

function ensureTuistoryDir(): void {
  if (!fs.existsSync(TUISTORY_DIR)) {
    errore.try(() => fs.mkdirSync(TUISTORY_DIR, { recursive: true }))
  }
}

// Wait for relay server to start. If minVersion is provided, waits until the
// relay reports a version >= minVersion (prevents connecting to a stale daemon
// that hasn't finished restarting yet).
async function waitForRelay(timeoutMs: number = 5000, minVersion?: string): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    const version = await getRelayVersion()
    if (version !== null) {
      if (!minVersion || compareVersions(version, minVersion) >= 0) {
        return true
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// Start relay server (daemon mode)
async function startRelayServer() {
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { createNodeWebSocket } = await import('@hono/node-ws')

  const logger = createFileLogger()
  const sessions = new Map<string, Session>()

  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.get('/version', (c) => {
    return c.json({ version: VERSION })
  })

  // List all active sessions — used by attach session selector
  app.get('/sessions', (c) => {
    const list = Array.from(sessions.entries()).map(([name, session]) => ({
      name,
      cols: session.currentCols,
      rows: session.currentRows,
      dead: session.isDead,
      cwd: session.currentCwd,
      command: session.currentCommand,
    }))
    return c.json(list)
  })

  // WebSocket endpoint for attach — streams PTY data bidirectionally.
  // Multiple attach clients can connect to the same session simultaneously
  // (needed for future grid view). Each client subscribes independently.
  app.get('/attach', upgradeWebSocket((c) => {
    let unsubscribe: (() => void) | null = null
    let sessionName: string | null = null

    return {
      onMessage(event, ws) {
        const raw = typeof event.data === 'string' ? event.data : ''
        // Try parsing as JSON for control messages
        let parsed: { type: string; session?: string; cols?: number; rows?: number; data?: string } | null = null
        try { parsed = JSON.parse(raw) } catch {}

        if (parsed && parsed.type === 'attach' && parsed.session) {
          // Initial attach handshake
          sessionName = parsed.session
          const session = sessions.get(sessionName)
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: `Session "${sessionName}" not found` }))
            ws.close(1008, 'Session not found')
            return
          }

          // Resize PTY to match client terminal if dimensions provided
          if (parsed.cols && parsed.rows && !session.isDead) {
            errore.try(() => session.resize({ cols: parsed!.cols!, rows: parsed!.rows! }))
          }

          // Send all buffered raw output so the client renders the full
          // terminal history, not just data arriving after attach.
          const buffered = session.getRawOutput()
          if (buffered) {
            try { ws.send(buffered) } catch {}
          }

          // Subscribe to new PTY data and forward to WebSocket client
          unsubscribe = session.subscribe((data) => {
            try { ws.send(data) } catch {}
          })

          // Notify client when PTY exits
          session.onExit((info) => {
            try {
              ws.send(JSON.stringify({ type: 'exit', exitCode: info.exitCode, signal: info.signal }))
            } catch {}
          })

          // If session is already dead, notify immediately
          if (session.isDead && session.exitInfo) {
            ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitInfo.exitCode, signal: session.exitInfo.signal }))
          }

          logger.log(`Attach client connected to session "${sessionName}"`)
          return
        }

        if (parsed && parsed.type === 'resize' && sessionName) {
          const session = sessions.get(sessionName)
          if (session && parsed.cols && parsed.rows && !session.isDead) {
            errore.try(() => session.resize({ cols: parsed!.cols!, rows: parsed!.rows! }))
          }
          return
        }

        if (parsed && parsed.type === 'kill' && sessionName) {
          const session = sessions.get(sessionName)
          if (session) {
            session.killProcess()
            logger.log(`Session "${sessionName}" killed by attach client`)
          }
          return
        }

        // Raw text input — forward to PTY
        if (sessionName) {
          const session = sessions.get(sessionName)
          if (session && !session.isDead) {
            errore.try(() => session.writeRaw(raw))
          }
        }
      },
      onClose() {
        if (unsubscribe) unsubscribe()
        if (sessionName) {
          logger.log(`Attach client disconnected from session "${sessionName}"`)
        }
      },
      onError() {
        if (unsubscribe) unsubscribe()
      },
    }
  }))

  app.post('/cli', async (c) => {
    const { argv, cwd } = await c.req.json() as { argv: string[]; cwd?: string }

    const ctx: CommandResult = { stdout: '', stderr: '', exitCode: 0 }
    const cli = createCliWithActions(ctx, sessions, logger, {
      cwd,
      stdout: createCommandResultStream(ctx, 'stdout'),
      stderr: createCommandResultStream(ctx, 'stderr'),
      exit: (code) => { throw new GokeProcessExit(code) },
    })

    const parsed = errore.try(() => cli.parse(argv, { run: false }))
    if (parsed instanceof GokeProcessExit) {
      ctx.exitCode = parsed.code
      return c.json(ctx)
    }
    if (parsed instanceof Error) {
      ctx.stderr ||= parsed.message
      ctx.exitCode = 1
      return c.json(ctx)
    }

    const ran = await Promise.resolve()
      .then(() => cli.runMatchedCommand())
      .catch((e) => e instanceof Error ? e : new Error(String(e)))
    if (ran instanceof GokeProcessExit) {
      ctx.exitCode = ran.code
      return c.json(ctx)
    }
    if (ran instanceof Error) {
      ctx.stderr ||= ran.message
      ctx.exitCode = 1
    }

    return c.json(ctx)
  })

  const server = serve({
    fetch: app.fetch,
    port: RELAY_PORT,
    hostname: '127.0.0.1',
  })

  // Inject WebSocket support into the HTTP server
  injectWebSocket(server)

  // Write PID file so killRelay() can send SIGTERM instead of kill-by-port
  ensureTuistoryDir()
  const pidWrite = errore.try(() => fs.writeFileSync(PID_FILE, String(process.pid)))
  if (pidWrite instanceof Error) {
    logger.error(`Failed to write PID file: ${pidWrite.message}`)
  }

  logger.log(`Relay server started on port ${RELAY_PORT}`)
  logger.log(`Version: ${VERSION}`)
  logger.log(`PID: ${process.pid}`)

  const gracefulShutdown = async (signal: string) => {
    logger.log(`Relay server shutting down (${signal})`)
    for (const [name, session] of sessions) {
      errore.try(() => session.close())
      logger.log(`Session "${name}" closed on shutdown`)
    }
    sessions.clear()
    errore.try(() => fs.unlinkSync(PID_FILE))
    // Close the HTTP server first so no new requests are accepted,
    // then flush the logger, then exit.
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Give the logger queue a chance to flush final writes
    await logger.log('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => { gracefulShutdown('SIGINT') })
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM') })

  // Prevent unhandled errors from crashing the daemon and killing all sessions.
  // Log and continue — individual sessions may break but others survive.
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception (daemon survived): ${err.stack || err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection (daemon survived): ${reason}`)
  })

  console.log(`tuistory relay server running on port ${RELAY_PORT}`)
  console.log(`Logs: ${logger.logFilePath}`)
}

// Print the last few lines of the relay log file to stderr for diagnostics.
// Called when the relay crashes or fails unexpectedly, so the user doesn't
// have to manually open the log file.
function printRelayLogTail(lines: number = 15): void {
  try {
    const content = fs.readFileSync(LOG_FILE_PATH, 'utf-8')
    const allLines = content.trimEnd().split('\n')
    const tail = allLines.slice(-lines)
    if (tail.length > 0) {
      console.error(pc.dim(`\n--- Last ${tail.length} lines from ${LOG_FILE_PATH} ---`))
      for (const line of tail) {
        console.error(pc.dim(line))
      }
      console.error(pc.dim(`--- end of log ---\n`))
    }
  } catch {
    // Log file doesn't exist or can't be read — nothing to show
  }
}

// Dummy logger for client-side help display
const dummyLogger: Logger = {
  log: async () => {},
  error: async () => {},
  logFilePath: LOG_FILE_PATH,
}

// Spawn a new relay server in background
function spawnRelayServer(): void {
  const isTs = __filename.endsWith('.ts')
  const execPath = isTs ? 'bun' : process.execPath

  const serverProcess = spawn(execPath, [__filename], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TUISTORY_RELAY: '1' },
  })
  serverProcess.unref()
}

// Ensure the relay daemon is running and at the correct version.
// Shared by both normal CLI forwarding and the attach command.
async function ensureRelayRunning(): Promise<void> {
  const serverVersion = await getRelayVersion()

  if (serverVersion === null) {
    spawnRelayServer()
    const started = await waitForRelay()
    if (!started) {
      const err = new RelayStartError({ action: 'start', reason: `timed out waiting for relay on port ${RELAY_PORT}` })
      console.error(pc.red(err.message))
      printRelayLogTail()
      console.error(pc.red(`Check logs at: ${LOG_FILE_PATH}`))
      process.exit(1)
    }
  } else if (serverVersion !== VERSION) {
    const comparison = compareVersions(serverVersion, VERSION)
    if (comparison < 0) {
      const lockAcquired = acquireRestartLock()
      if (lockAcquired) {
        try {
          const currentVersion = await getRelayVersion()
          if (currentVersion !== null && compareVersions(currentVersion, VERSION) >= 0) {
            // Already restarted by another client
          } else {
            console.error(pc.yellow(`Relay server version mismatch (server: ${serverVersion}, client: ${VERSION}), restarting...`))
            await killRelay()
            spawnRelayServer()
            const started = await waitForRelay(5000, VERSION)
            if (!started) {
              const err = new RelayStartError({ action: 'restart', reason: `timed out waiting for relay v${VERSION} on port ${RELAY_PORT}` })
              console.error(pc.red(err.message))
              printRelayLogTail()
              console.error(pc.red(`Check logs at: ${LOG_FILE_PATH}`))
              process.exit(1)
            }
          }
        } finally {
          releaseRestartLock()
        }
      } else {
        const started = await waitForRelay(15000, VERSION)
        if (!started) {
          const err = new RelayStartError({ action: 'restart', reason: `timed out waiting for relay v${VERSION} after another client restarted it` })
          console.error(pc.red(err.message))
          printRelayLogTail()
          console.error(pc.red(`Check logs at: ${LOG_FILE_PATH}`))
          process.exit(1)
        }
      }
    }
  }
}

// Session info returned by GET /sessions
interface SessionInfo {
  name: string
  cols: number
  rows: number
  dead: boolean
  cwd: string
  command: string
}

// Fetch session list from relay
async function getRelaySessions(): Promise<SessionInfo[] | Error> {
  const response = await errore.tryAsync({
    try: () => fetch(`http://127.0.0.1:${RELAY_PORT}/sessions`, {
      signal: AbortSignal.timeout(2000),
    }),
    catch: (e) => new RelayConnectionError({ port: String(RELAY_PORT), reason: errorReason(e), cause: e }),
  })
  if (response instanceof Error) return response
  const data = await errore.tryAsync({
    try: () => response.json() as Promise<SessionInfo[]>,
    catch: (e) => new RelayConnectionError({ port: String(RELAY_PORT), reason: 'invalid JSON', cause: e }),
  })
  return data
}

// Run the attach command client-side. This is handled separately from
// the normal relay forwarding because it needs direct stdin/stdout for
// the interactive TUI.
async function runAttachCommand(options: { session?: string }) {
  // TODO: Remove bun re-spawn when opentui supports Node.js natively.
  // OpenTUI's Zig renderer currently requires Bun's FFI — running under
  // Node.js will fail at createCliRenderer(). Detect runtime and re-spawn.
  const isBun = typeof globalThis.Bun !== 'undefined'
  if (!isBun) {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('bun', [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: process.env,
    })
    process.exit(result.status ?? 1)
    return
  }

  let sessionName = options.session

  // If no session specified, fetch list and auto-select or prompt
  if (!sessionName) {
    const sessions = await getRelaySessions()
    if (sessions instanceof Error) {
      console.error(pc.red(`Failed to list sessions: ${sessions.message}`))
      process.exit(1)
      return
    }

    const alive = sessions.filter(s => !s.dead)
    if (alive.length === 0) {
      console.error(pc.red('No active sessions. Launch one first with: tuistory launch <command>'))
      process.exit(1)
      return
    }

    if (alive.length === 1) {
      sessionName = alive[0].name
      console.log(pc.dim(`Auto-selecting session: ${sessionName}`))
    } else {
      const clack = await import('@clack/prompts')
      const selection = await clack.select({
        message: 'Select a session to attach',
        options: alive.map((s) => ({
          value: s.name,
          label: s.name,
          hint: `${s.cols}x${s.rows}`,
        })),
      })

      if (clack.isCancel(selection)) {
        clack.cancel('Attach cancelled')
        process.exit(0)
        return
      }

      sessionName = selection
    }
  }

  // Dynamically import and run the attach TUI
  const { runAttachTui } = await import('./attach-tui.js')
  await runAttachTui({ sessionName, relayPort: RELAY_PORT })
}

async function runDaemonStopCommand() {
  const serverVersion = await getRelayVersion()
  if (serverVersion === null) {
    console.log('No daemon running')
    return
  }

  await killRelay()
  console.log('Daemon stopped')
}

// CLI thin client - forwards to relay
async function runCliClient() {
  const inspectCtx: CommandResult = { stdout: '', stderr: '', exitCode: 0 }
  const inspectCli = createCliWithActions(inspectCtx, new Map(), dummyLogger)
  inspectCli.parse(process.argv, { run: false })

  // Help/version are handled locally by goke during parse().
  if (inspectCli.options.help || inspectCli.options.version) {
    return
  }

  const passthroughCommand = Array.isArray(inspectCli.options['--']) && inspectCli.options['--'].length > 0
    ? inspectCli.options['--'].join(' ')
    : null
  const launchCommand = typeof inspectCli.args[0] === 'string'
    ? inspectCli.args[0]
    : passthroughCommand ?? getLaunchCommandFromArgv(process.argv)
  const isLaunchCommand = inspectCli.matchedCommandName === 'launch'
    || (inspectCli.matchedCommandName === undefined && launchCommand !== null)

  if (isLaunchCommand && process.env.TUISTORY_SESSION) {
    const attemptedCommand = `tuistory ${process.argv.slice(2).map(shellQuote).join(' ')}`
    console.error(pc.yellow(dedent`
      Refusing to launch a nested tuistory session inside "${process.env.TUISTORY_SESSION}".

      Attempted tuistory command:
        ${attemptedCommand}

      This would create a tuistory session from inside another tuistory session.
      The command you launched is already running inside its own tuistory session.

      Agent fix:
        If you are trying to launch a package.json script or another script that starts
        tuistory, run it normally without wrapping it in tuistory.
        The script will start the tuistory session itself in the background.
    `))
    process.exit(1)
  }

  if (inspectCli.matchedCommandName === 'daemon-stop') {
    await runDaemonStopCommand()
    return
  }

  // Intercept `attach` after goke parses argv for us, so the client-side path
  // can reuse the command definition instead of manually scanning process.argv.
  if (inspectCli.matchedCommandName === 'attach') {
    await ensureRelayRunning()
    await runAttachCommand({ session: inspectCli.options.session })
    return
  }

  // Ensure relay is running before forwarding
  await ensureRelayRunning()

  // Forward argv to relay
  const response = await errore.tryAsync({
    try: () => fetch(`http://127.0.0.1:${RELAY_PORT}/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argv: process.argv, cwd: process.cwd() }),
    }),
    catch: (e) => new RelayConnectionError({ port: String(RELAY_PORT), reason: errorReason(e), cause: e }),
  })
  if (response instanceof Error) {
    console.error(pc.red(response.message))
    printRelayLogTail()
    console.error(pc.red(`Check logs at: ${LOG_FILE_PATH}`))
    process.exit(1)
  }

  const result = await errore.tryAsync({
    try: () => response.json() as Promise<CommandResult>,
    catch: (e) => new RelayConnectionError({ port: String(RELAY_PORT), reason: 'invalid response from relay', cause: e }),
  })
  if (result instanceof Error) {
    console.error(pc.red(result.message))
    process.exit(1)
  }

  if (result.stdout) {
    console.log(result.stdout)
  }
  if (result.stderr) {
    console.error(pc.red(result.stderr))
  }

  if (
    isLaunchCommand
    && inspectCli.options.attach
    && result.exitCode === 0
  ) {
    if (isAgent) {
      process.exit(0)
    }

    await runAttachCommand({ session: inspectCli.options.session ?? (launchCommand ? getDefaultSessionName(launchCommand) : undefined) })
    process.exit(0)
  }

  process.exit(result.exitCode)
}

// Main entry point
const isRelayServer = process.env.TUISTORY_RELAY === '1'

if (isRelayServer) {
  process.title = 'tuistory-relay'
  startRelayServer()
} else {
  runCliClient()
}
