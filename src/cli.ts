#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { goke } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import pc from 'picocolors'
import { Session, type Key, isValidKey, VALID_KEYS } from './session.js'

// Constants
export const RELAY_PORT = 19977
const LOG_BASE_DIR = os.platform() === 'win32' ? os.tmpdir() : '/tmp'
export const LOG_FILE_PATH = process.env.TUISTORY_LOG_FILE_PATH || path.join(LOG_BASE_DIR, 'tuistory', 'relay-server.log')

const __filename = fileURLToPath(import.meta.url)

const packageJsonPath = path.join(path.dirname(__filename), '..', 'package.json')
const VERSION = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).version as string

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

// Command result interface
interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
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

// Create CLI with commands - actions write to ctx
function createCliWithActions(
  ctx: CommandResult,
  sessions: Map<string, Session>,
  logger: Logger,
) {
  const cli = goke('tuistory')

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

  cli
    .command('launch <command>', dedent`
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
    `)
    .option('-s, --session <name>', z.string().default('default').describe('Session name'))
    .option('--cols <n>', z.number().default(80).describe('Terminal columns'))
    .option('--rows <n>', z.number().default(24).describe('Terminal rows'))
    .option('--cwd <path>', 'Working directory')
    .option('--env <key=value>', z.array(z.string()).describe('Environment variable (repeatable)'))
    .option('--no-wait', "Don't wait for initial data")
    .option('--timeout <ms>', z.number().default(5000).describe('Wait timeout in milliseconds'))
    .example('tuistory launch "claude" -s claude --cols 120 --rows 30')
    .example('tuistory launch "node" -s repl --cols 80')
    .example('tuistory launch "bash --norc" -s sh --env PS1="$ " --env FOO=bar')
    .example(dedent`
      # Launch and immediately check what the app shows:
      tuistory launch "claude" -s ai && tuistory -s ai snapshot --trim
    `)
    .action(async (command: string, options: {
      session: string
      cols: number
      rows: number
      cwd?: string
      env?: string[]
      wait: boolean
      timeout: number
    }) => {
      try {
        // Check for duplicate session name
        if (sessions.has(options.session)) {
          ctx.stderr = `Session "${options.session}" already exists. Use a different name or close it first.`
          ctx.exitCode = 1
          return
        }

        // Parse command - split by spaces but respect quotes
        const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command]
        const cmd = parts[0].replace(/^["']|["']$/g, '')
        const args = parts.slice(1).map(p => p.replace(/^["']|["']$/g, ''))

        const env = parseEnvOptions(options.env)

        const session = new Session({
          command: cmd,
          args,
          cols: options.cols,
          rows: options.rows,
          cwd: options.cwd,
          env,
        })

        sessions.set(options.session, session)

        if (options.wait) {
          await session.waitForData({ timeout: options.timeout })
        }

        ctx.stdout = `Session "${options.session}" started`
        logger.log(`Session "${options.session}" started: ${command}`)
      } catch (e) {
        ctx.stderr = `Failed to launch: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

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
      cursor: boolean
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) {
        return
      }

      const session = getSession(sessionName)
      if (!session) {
        return
      }

      try {
        const only: Record<string, boolean | string> = {}
        if (options.bold) {
          only.bold = true
        }
        if (options.italic) {
          only.italic = true
        }
        if (options.underline) {
          only.underline = true
        }
        if (options.fg) {
          only.foreground = options.fg
        }
        if (options.bg) {
          only.background = options.bg
        }

        const text = await session.text({
          trimEnd: options.trim,
          immediate: options.immediate,
          showCursor: options.cursor,
          only: Object.keys(only).length > 0 ? only as any : undefined,
        })

        if (options.json) {
          ctx.stdout = JSON.stringify({ text, session: sessionName })
        } else {
          ctx.stdout = text
        }
      } catch (e) {
        ctx.stderr = `Failed to get snapshot: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      Using tuistory is preferable over tmux background sessions
      because you can programmatically control the terminal (type,
      press keys, wait for text, resize) and capture pixel-perfect
      screenshots — designed from first principles for agents.

      Waits for the terminal to become idle before capturing unless
      \`--immediate\` is passed.
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
    .option('--immediate', "Don't wait for idle state")
    .example('tuistory -s claude screenshot -o screenshot.jpg')
    .example('tuistory -s claude screenshot --format png --font-size 20')
    .example('tuistory -s claude screenshot --background "#ffffff" --foreground "#24292e"')
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
      immediate?: boolean
    }) => {
      const sessionName = requireSession(options)
      if (!sessionName) return

      const session = getSession(sessionName)
      if (!session) return

      try {
        // Wait for idle unless --immediate
        if (!options.immediate) {
          await session.text({ immediate: false, timeout: 2000 })
        }

        const data = session.getTerminalData()

        const { renderTerminalToImage } = await import('ghostty-opentui/image')

        const image = await renderTerminalToImage(data, {
          width: options.width,
          fontSize: options.fontSize,
          lineHeight: options.lineHeight,
          theme: {
            background: options.background,
            text: options.foreground,
          },
          format: options.format,
          quality: options.quality,
        })

        const { writeFileSync } = await import('fs')
        const outputPath = options.output ?? (await import('path')).join(
          (await import('os')).tmpdir(),
          `tuistory-screenshot-${Date.now()}.${options.format}`,
        )

        writeFileSync(outputPath, image)
        ctx.stdout = outputPath
      } catch (e) {
        ctx.stderr = `Failed to take screenshot: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        await session.type(text)
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to type: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        const allKeys = [key, ...keys]
        const invalidKeys = allKeys.filter((k) => !isValidKey(k))
        if (invalidKeys.length > 0) {
          ctx.stderr = `Invalid key(s): ${invalidKeys.join(', ')}\nValid keys: ${Array.from(VALID_KEYS).sort().join(', ')}`
          ctx.exitCode = 1
          return
        }
        await session.press(allKeys as Key[])
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to press: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        const parsedPattern = parsePattern(pattern)
        await session.click(parsedPattern, {
          first: options.first,
          timeout: options.timeout,
        })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to click: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        await session.clickAt(Number(x), Number(y))
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to click: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        const parsedPattern = parsePattern(pattern)
        await session.waitForText(parsedPattern, {
          timeout: options.timeout,
        })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to wait: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        await session.waitIdle({ timeout: options.timeout })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to wait: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        const lineCount = lines ? Number(lines) : 1
        const x = options.x ? Number(options.x) : undefined
        const y = options.y ? Number(options.y) : undefined

        if (direction === 'up') {
          await session.scrollUp(lineCount, x, y)
        } else if (direction === 'down') {
          await session.scrollDown(lineCount, x, y)
        } else {
          ctx.stderr = `Invalid direction: ${direction}. Use "up" or "down"`
          ctx.exitCode = 1
          return
        }
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to scroll: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        session.resize({ cols: Number(cols), rows: Number(rows) })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to resize: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        const allKeys = [key, ...keys]
        const invalidKeys = allKeys.filter((k) => !isValidKey(k))
        if (invalidKeys.length > 0) {
          ctx.stderr = `Invalid key(s): ${invalidKeys.join(', ')}\nValid keys: ${Array.from(VALID_KEYS).sort().join(', ')}`
          ctx.exitCode = 1
          return
        }
        const frames = await session.captureFrames(allKeys as Key[], {
          frameCount: options.count,
          intervalMs: options.interval,
        })
        ctx.stdout = JSON.stringify(frames)
      } catch (e) {
        ctx.stderr = `Failed to capture frames: ${(e as Error).message}`
        ctx.exitCode = 1
      }
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

      try {
        session.close()
        sessions.delete(sessionName)
        ctx.stdout = `Session "${sessionName}" closed`
        logger.log(`Session "${sessionName}" closed`)
      } catch (e) {
        ctx.stderr = `Failed to close: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('sessions', dedent`
      List all active session names.

      Shows one session name per line. Sessions are created with
      \`launch\` and persist until \`close\` or \`daemon-stop\`.
    `)
    .example('tuistory sessions')
    .action(() => {
      const sessionList = Array.from(sessions.keys())
      if (sessionList.length === 0) {
        ctx.stdout = 'No active sessions'
      } else {
        ctx.stdout = sessionList.join('\n')
      }
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

  cli
    .command('daemon-stop', dedent`
      Stop the background relay daemon.

      The daemon runs as a detached process that holds all
      sessions in memory. Stopping it closes all active sessions.

      A new daemon is started automatically on the next command.
    `)
    .example('tuistory daemon-stop')
    .action(async () => {
      ctx.stdout = 'Daemon stopping...'
      // Delay exit to allow HTTP response to be sent
      setTimeout(() => {
        process.exit(0)
      }, 100)
    })

  // Global examples showing the full workflow pattern
  cli.example(dedent`
    # Full workflow: launch, interact, snapshot, close
    tuistory launch "claude" -s ai --cols 100 --rows 30
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
  try {
    const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/version`, {
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) {
      return null
    }
    const data = await response.json() as { version: string }
    return data.version
  } catch {
    return null
  }
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

// Kill relay server on port
async function killRelay(): Promise<void> {
  try {
    const { killPortProcess } = await import('kill-port-process')
    await killPortProcess(RELAY_PORT)
  } catch {
    // Ignore errors
  }
}

// Wait for relay server to start
async function waitForRelay(timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    const version = await getRelayVersion()
    if (version !== null) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// Start relay server (daemon mode)
async function startRelayServer() {
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')

  const logger = createFileLogger()
  const sessions = new Map<string, Session>()

  const app = new Hono()

  app.get('/version', (c) => {
    return c.json({ version: VERSION })
  })

  app.post('/cli', async (c) => {
    const { argv } = await c.req.json() as { argv: string[] }

    const ctx: CommandResult = { stdout: '', stderr: '', exitCode: 0 }
    const cli = createCliWithActions(ctx, sessions, logger)

    try {
      cli.parse(argv, { run: false })
      await cli.runMatchedCommand()
    } catch (e) {
      ctx.stderr = (e as Error).message
      ctx.exitCode = 1
    }

    return c.json(ctx)
  })

  const server = serve({
    fetch: app.fetch,
    port: RELAY_PORT,
    hostname: '127.0.0.1',
  })

  logger.log(`Relay server started on port ${RELAY_PORT}`)
  logger.log(`Version: ${VERSION}`)

  process.on('SIGINT', () => {
    logger.log('Relay server shutting down (SIGINT)')
    for (const [name, session] of sessions) {
      session.close()
      logger.log(`Session "${name}" closed on shutdown`)
    }
    server.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    logger.log('Relay server shutting down (SIGTERM)')
    for (const [name, session] of sessions) {
      session.close()
      logger.log(`Session "${name}" closed on shutdown`)
    }
    server.close()
    process.exit(0)
  })

  console.log(`tuistory relay server running on port ${RELAY_PORT}`)
  console.log(`Logs: ${logger.logFilePath}`)
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

// CLI thin client - forwards to relay
async function runCliClient() {
  // Handle --help and --version locally (they don't need the relay)
  // goke handles these flags in parse() before running any action
  const hasHelp = process.argv.includes('--help') || process.argv.includes('-h')
  const hasVersion = process.argv.includes('--version') || process.argv.includes('-v')

  if (hasHelp || hasVersion) {
    const dummyCtx: CommandResult = { stdout: '', stderr: '', exitCode: 0 }
    const cli = createCliWithActions(dummyCtx, new Map(), dummyLogger)
    cli.parse()
    return
  }

  // Check relay server version
  const serverVersion = await getRelayVersion()

  if (serverVersion === null) {
    // Server not running, start it
    spawnRelayServer()

    const started = await waitForRelay()
    if (!started) {
      console.error(pc.red(`Failed to start relay server. Check logs at: ${LOG_FILE_PATH}`))
      process.exit(1)
    }
  } else if (serverVersion !== VERSION) {
    // Version mismatch - check if we should restart
    const comparison = compareVersions(serverVersion, VERSION)

    if (comparison < 0) {
      // Server is older than client - restart it
      console.error(pc.yellow(`Relay server version mismatch (server: ${serverVersion}, client: ${VERSION}), restarting...`))
      await killRelay()
      spawnRelayServer()

      const started = await waitForRelay()
      if (!started) {
        console.error(pc.red(`Failed to restart relay server. Check logs at: ${LOG_FILE_PATH}`))
        process.exit(1)
      }
    }
    // If server is newer, just use it (don't kill a newer server)
  }

  // Forward argv to relay
  try {
    const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argv: process.argv }),
    })

    const result = await response.json() as CommandResult

    if (result.stdout) {
      console.log(result.stdout)
    }
    if (result.stderr) {
      console.error(pc.red(result.stderr))
    }

    process.exit(result.exitCode)
  } catch (e) {
    console.error(pc.red(`Failed to connect to relay: ${(e as Error).message}`))
    console.error(pc.red(`Check logs at: ${LOG_FILE_PATH}`))
    process.exit(1)
  }
}

// Main entry point
const isRelayServer = process.env.TUISTORY_RELAY === '1'

if (isRelayServer) {
  process.title = 'tuistory-relay'
  startRelayServer()
} else {
  runCliClient()
}
