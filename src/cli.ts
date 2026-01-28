#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cac } from 'cac'
import pc from 'picocolors'
import { Session, type Key } from './session.js'

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
  const cli = cac('tuistory')

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
    .command('launch <command>', 'Launch a terminal session')
    .option('-s, --session <name>', 'Session name', { default: 'default' })
    .option('--cols <n>', 'Terminal columns', { default: 80 })
    .option('--rows <n>', 'Terminal rows', { default: 24 })
    .option('--cwd <path>', 'Working directory')
    .option('--env <key=value>', 'Environment variable (can be used multiple times)', { type: [] })
    .option('--no-wait', "Don't wait for initial data")
    .option('--timeout <ms>', 'Wait timeout in milliseconds', { default: 5000 })
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
          cols: Number(options.cols),
          rows: Number(options.rows),
          cwd: options.cwd,
          env,
        })

        sessions.set(options.session, session)

        if (options.wait) {
          await session.waitForData({ timeout: Number(options.timeout) })
        }

        ctx.stdout = `Session "${options.session}" started`
        logger.log(`Session "${options.session}" started: ${command}`)
      } catch (e) {
        ctx.stderr = `Failed to launch: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('snapshot', 'Get terminal text content')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--json', 'Output as JSON with metadata')
    .option('--trim', 'Trim trailing whitespace and empty lines')
    .option('--immediate', "Don't wait for idle state")
    .option('--bold', 'Only bold text')
    .option('--italic', 'Only italic text')
    .option('--underline', 'Only underlined text')
    .option('--fg <color>', 'Only text with foreground color')
    .option('--bg <color>', 'Only text with background color')
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
    .command('type <text>', 'Type text character by character')
    .option('-s, --session <name>', 'Session name (required)')
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
    .command('press <key> [...keys]', 'Press key(s)')
    .option('-s, --session <name>', 'Session name (required)')
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
        const allKeys = [key, ...keys] as Key[]
        await session.press(allKeys)
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to press: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('click <pattern>', 'Click on text matching pattern')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--first', 'Click first match if multiple found')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 5000 })
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
          timeout: Number(options.timeout),
        })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to click: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('click-at <x> <y>', 'Click at coordinates')
    .option('-s, --session <name>', 'Session name (required)')
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
    .command('wait <pattern>', 'Wait for text to appear')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 5000 })
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
          timeout: Number(options.timeout),
        })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to wait: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('wait-idle', 'Wait for terminal to become idle')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 500 })
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
        await session.waitIdle({ timeout: Number(options.timeout) })
        ctx.stdout = 'OK'
      } catch (e) {
        ctx.stderr = `Failed to wait: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('scroll <direction> [lines]', 'Scroll up or down')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--x <n>', 'X coordinate')
    .option('--y <n>', 'Y coordinate')
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
    .command('resize <cols> <rows>', 'Resize terminal')
    .option('-s, --session <name>', 'Session name (required)')
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
    .command('capture-frames <key> [...keys]', 'Capture multiple frames after keypress')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--count <n>', 'Number of frames to capture', { default: 5 })
    .option('--interval <ms>', 'Interval between frames in ms', { default: 10 })
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
        const allKeys = [key, ...keys] as Key[]
        const frames = await session.captureFrames(allKeys, {
          frameCount: Number(options.count),
          intervalMs: Number(options.interval),
        })
        ctx.stdout = JSON.stringify(frames)
      } catch (e) {
        ctx.stderr = `Failed to capture frames: ${(e as Error).message}`
        ctx.exitCode = 1
      }
    })

  cli
    .command('close', 'Close a session')
    .option('-s, --session <name>', 'Session name (required)')
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
    .command('sessions', 'List active sessions')
    .action(() => {
      const sessionList = Array.from(sessions.keys())
      if (sessionList.length === 0) {
        ctx.stdout = 'No active sessions'
      } else {
        ctx.stdout = sessionList.join('\n')
      }
    })

  cli
    .command('logfile', 'Print the path to the log file')
    .action(() => {
      ctx.stdout = LOG_FILE_PATH
    })

  cli
    .command('daemon-stop', 'Stop the relay daemon')
    .action(async () => {
      ctx.stdout = 'Daemon stopping...'
      // Delay exit to allow HTTP response to be sent
      setTimeout(() => {
        process.exit(0)
      }, 100)
    })

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
    // Use lsof on unix, netstat on windows
    const isWindows = os.platform() === 'win32'
    if (isWindows) {
      const { execSync } = await import('node:child_process')
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| find ":${RELAY_PORT}"') do taskkill /F /PID %a`, { stdio: 'ignore' })
    } else {
      const { execSync } = await import('node:child_process')
      execSync(`lsof -ti :${RELAY_PORT} | xargs kill 2>/dev/null || true`, { stdio: 'ignore' })
    }
    // Wait a bit for process to die
    await new Promise((resolve) => setTimeout(resolve, 500))
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

// Create a CLI for help/version display (client-side)
function createHelpCli() {
  const cli = cac('tuistory')

  cli.command('launch <command>', 'Launch a terminal session')
    .option('-s, --session <name>', 'Session name', { default: 'default' })
    .option('--cols <n>', 'Terminal columns', { default: 80 })
    .option('--rows <n>', 'Terminal rows', { default: 24 })
    .option('--cwd <path>', 'Working directory')
    .option('--env <key=value>', 'Environment variable (can be used multiple times)', { type: [] })
    .option('--no-wait', "Don't wait for initial data")
    .option('--timeout <ms>', 'Wait timeout in milliseconds', { default: 5000 })

  cli.command('snapshot', 'Get terminal text content')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--json', 'Output as JSON with metadata')
    .option('--trim', 'Trim trailing whitespace and empty lines')
    .option('--immediate', "Don't wait for idle state")
    .option('--bold', 'Only bold text')
    .option('--italic', 'Only italic text')
    .option('--underline', 'Only underlined text')
    .option('--fg <color>', 'Only text with foreground color')
    .option('--bg <color>', 'Only text with background color')

  cli.command('type <text>', 'Type text character by character')
    .option('-s, --session <name>', 'Session name (required)')

  cli.command('press <key> [...keys]', 'Press key(s)')
    .option('-s, --session <name>', 'Session name (required)')

  cli.command('click <pattern>', 'Click on text matching pattern')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--first', 'Click first match if multiple found')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 5000 })

  cli.command('click-at <x> <y>', 'Click at coordinates')
    .option('-s, --session <name>', 'Session name (required)')

  cli.command('wait <pattern>', 'Wait for text to appear')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 5000 })

  cli.command('wait-idle', 'Wait for terminal to become idle')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 500 })

  cli.command('scroll <direction> [lines]', 'Scroll up or down')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--x <n>', 'X coordinate')
    .option('--y <n>', 'Y coordinate')

  cli.command('resize <cols> <rows>', 'Resize terminal')
    .option('-s, --session <name>', 'Session name (required)')

  cli.command('capture-frames <key> [...keys]', 'Capture multiple frames after keypress')
    .option('-s, --session <name>', 'Session name (required)')
    .option('--count <n>', 'Number of frames to capture', { default: 5 })
    .option('--interval <ms>', 'Interval between frames in ms', { default: 10 })

  cli.command('close', 'Close a session')
    .option('-s, --session <name>', 'Session name (required)')

  cli.command('sessions', 'List active sessions')

  cli.command('logfile', 'Print the path to the log file')

  cli.command('daemon-stop', 'Stop the relay daemon')

  cli.help()
  cli.version(VERSION)

  return cli
}

// Spawn a new relay server in background
function spawnRelayServer(): void {
  const isTs = __filename.endsWith('.ts')
  const execPath = isTs ? 'tsx' : process.execPath

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
  const hasHelp = process.argv.includes('--help') || process.argv.includes('-h')
  const hasVersion = process.argv.includes('--version') || process.argv.includes('-v')

  if (hasHelp || hasVersion) {
    const cli = createHelpCli()
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
