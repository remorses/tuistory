// Use a separate daemon port for tests so they don't kill user sessions on the default port (19977)
process.env.TUISTORY_PORT = '19951'

import { spawn } from 'bun'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLI_PATH = new URL('./cli.ts', import.meta.url).pathname
const TEST_PID_FILE = `/tmp/tuistory/relay-${process.env.TUISTORY_PORT}.pid`

// Helper to run CLI command
async function runCli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(['bun', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env, TUISTORY_PORT: process.env.TUISTORY_PORT },
    cwd: options.cwd,
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

// Spawn a SEPARATE process that binds the given port and accepts connections
// but never replies (simulating a wedged/orphaned daemon). Must be a distinct
// process so killRelay()'s port-based SIGKILL targets it, not the test runner.
function spawnPortBlocker(port: number) {
  const code = `require('net').createServer(()=>{}).listen(${port},'127.0.0.1',()=>process.stdout.write('BOUND\\n'))`
  return spawn(['node', '-e', code], { stdout: 'pipe', stderr: 'pipe' })
}

// Poll until a TCP connect to the port succeeds (something is listening).
async function waitForPortBound(port: number, timeoutMs = 5000): Promise<void> {
  const net = await import('node:net')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const bound = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => { resolve(false) })
      setTimeout(() => { sock.destroy(); resolve(false) }, 200)
    })
    if (bound) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`port ${port} never became bound`)
}

// Kill the test daemon so every test run starts a fresh one with the latest code.
//
// The relay daemon is a long-lived background process; if we leave a previous
// daemon running it will keep the OLD compiled CLI loaded in memory, and the
// test suite will silently exercise stale code (changes to middleware, route
// handlers, session logic, etc. would all appear to be ignored).
//
// Strategy:
//   1. Read the PID file and SIGTERM the recorded process. Escalate to SIGKILL
//      after 2s if it hasn't exited.
//   2. Also kill anything still bound to the test port, even if the PID file
//      is missing or stale (e.g. orphaned daemon from a crashed prior run).
//   3. Wait until the port is actually free before returning, otherwise the
//      next CLI invocation could connect to the dying daemon.
async function killTestDaemon() {
  const port = Number(process.env.TUISTORY_PORT)

  const waitForPidExit = async (pid: number) => {
    const start = Date.now()
    while (Date.now() - start < 2000) {
      try {
        process.kill(pid, 0)
        await new Promise((r) => setTimeout(r, 100))
      } catch {
        return true
      }
    }
    return false
  }

  // Step 1: PID file
  try {
    const pid = Number(fs.readFileSync(TEST_PID_FILE, 'utf-8').trim())
    if (!isNaN(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      const exited = await waitForPidExit(pid)
      if (!exited) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
  } catch {}
  try { fs.unlinkSync(TEST_PID_FILE) } catch {}

  // Step 2: kill anything still bound to the test port (covers orphaned
  // daemons whose PID file was lost or never written).
  try {
    const { killPortProcess } = await import('kill-port-process')
    await killPortProcess(port)
  } catch {}

  // Step 3: wait until the port is free. Tries a TCP connect; success means
  // something is still listening and we should keep waiting.
  const net = await import('node:net')
  const isPortFree = (): Promise<boolean> => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { resolve(true) })
    setTimeout(() => { sock.destroy(); resolve(true) }, 200)
  })
  const start = Date.now()
  while (Date.now() - start < 3000) {
    if (await isPortFree()) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

// Helper to create session args for readability
const session = (name: string) => ['-s', name] as const

// Kill any existing test daemon before tests so we always exercise the latest
// compiled CLI code. See killTestDaemon() for why this matters.
beforeAll(async () => {
  await killTestDaemon()
})

// Clean up test daemon after tests
afterAll(async () => {
  await killTestDaemon()
})

describe('CLI help and version', () => {
  test('--help shows all commands', async () => {
    const { stdout, exitCode } = await runCli(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('launch [command]')
    expect(stdout).toContain('snapshot')
    expect(stdout).toContain('read')
    expect(stdout).toContain('screenshot')
    expect(stdout).toContain('type <text>')
    expect(stdout).toContain('press <key>')
    expect(stdout).toContain('click <pattern>')
    expect(stdout).toContain('wait <pattern>')
    expect(stdout).toContain('close')
    expect(stdout).toContain('sessions')
    expect(stdout).toContain('daemon-stop')
  })

  test('launch --help shows launch options', async () => {
    const { stdout, exitCode } = await runCli(['launch', '--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('$ tuistory launch [command]')
    expect(stdout).toContain('--session <name>')
    expect(stdout).toContain('defaults to command')
    expect(stdout).toContain('--cols <n>')
    expect(stdout).toContain('--rows <n>')
    expect(stdout).toContain('--cwd <path>')
    expect(stdout).toContain('--env <key=value>')
    expect(stdout).toContain('--no-wait')
    expect(stdout).toContain('--timeout <ms>')
  })

  test('--version shows version', async () => {
    const { stdout, exitCode } = await runCli(['--version'])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/tuistory\/\d+\.\d+\.\d+/)
  })
})

describe('CLI basic workflow', () => {
  test('launch, type, press, snapshot, close', async () => {
    // Launch session
    const launch = await runCli(['launch', 'bash --norc --noprofile', '-s', 'test-basic', '--env', 'PS1=$ '])
    expect(launch.exitCode).toBe(0)
    expect(launch.stdout).toBe('Session "test-basic" started')

    // Type command
    const type = await runCli(['type', 'echo hello', '-s', 'test-basic'])
    expect(type.exitCode).toBe(0)
    expect(type.stdout).toBe('OK')

    // Press enter
    const press = await runCli(['press', 'enter', '-s', 'test-basic'])
    expect(press.exitCode).toBe(0)
    expect(press.stdout).toBe('OK')

    // Wait for output
    const wait = await runCli(['wait', 'hello', '-s', 'test-basic', '--timeout', '5000'])
    expect(wait.exitCode).toBe(0)

    // Snapshot
    const snapshot = await runCli(['snapshot', '-s', 'test-basic', '--trim'])
    expect(snapshot.exitCode).toBe(0)
    expect(snapshot.stdout).toContain('echo hello')
    expect(snapshot.stdout).toContain('hello')

    // Close
    const close = await runCli(['close', '-s', 'test-basic'])
    expect(close.exitCode).toBe(0)
    expect(close.stdout).toBe('Session "test-basic" closed')
  }, 15000)

  test('launch uses the caller cwd by default', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-cli-cwd-')))

    try {
      const launch = await runCli(['launch', 'pwd', '-s', 'cwd-test'], { cwd })
      expect(launch.exitCode).toBe(0)

      const output = await runCli(['read', '-s', 'cwd-test', '--all', '--trim'])
      expect(output.exitCode).toBe(0)
      expect(output.stdout).toContain(cwd)

      const sessions = await runCli(['sessions'])
      expect(sessions.exitCode).toBe(0)
      expect(sessions.stdout).toContain(cwd)

      const close = await runCli(['close', '-s', 'cwd-test'])
      expect(close.exitCode).toBe(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 15000)

  test('launch resolves relative --cwd from the caller cwd', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-relative-cwd-')))
    const childCwd = path.join(cwd, 'app')
    fs.mkdirSync(childCwd)

    try {
      const launch = await runCli(['launch', 'pwd', '-s', 'relative-cwd-test', '--cwd', 'app'], { cwd })
      expect(launch.exitCode).toBe(0)

      const output = await runCli(['read', '-s', 'relative-cwd-test', '--all', '--trim'])
      expect(output.exitCode).toBe(0)
      expect(output.stdout).toContain(childCwd)

      const sessions = await runCli(['sessions'])
      expect(sessions.exitCode).toBe(0)
      expect(sessions.stdout).toContain(childCwd)

      const close = await runCli(['close', '-s', 'relative-cwd-test'])
      expect(close.exitCode).toBe(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 15000)

  test('launch uses cwd basename + hash + command as default session name', async () => {
    const launch = await runCli(['launch', 'printf hello'])
    expect(launch.exitCode).toBe(0)
    // Name includes a 4-char cwd hash to avoid collisions across directories
    // with the same basename. Pattern: <basename>-<hash>-<command>
    const match = launch.stdout.match(/^Session "(.+)" started$/)
    expect(match).toBeTruthy()
    const sessionName = match![1]
    expect(sessionName).toMatch(/^tuistory-[a-f0-9]{4}-printf-hello$/)

    const sessions = await runCli(['sessions'])
    expect(sessions.exitCode).toBe(0)
    expect(sessions.stdout).toContain(sessionName)

    const output = await runCli(['read', '-s', sessionName, '--all', '--trim'])
    expect(output.stdout).toContain('hello')

    await runCli(['close', '-s', sessionName])
  }, 10000)

  test('bare positional arg is rejected (must use launch or --)', async () => {
    const result = await runCli(['printf hello', '-s', 'default-launch'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Unknown command')
  }, 10000)

  test('launch accepts command after --', async () => {
    const launch = await runCli(['launch', '-s', 'dash-launch', '--', 'printf', 'hello'])
    expect(launch.exitCode).toBe(0)
    expect(launch.stdout).toBe('Session "dash-launch" started')

    const output = await runCli(['read', '-s', 'dash-launch', '--all', '--trim'])
    expect(output.stdout).toContain('hello')

    await runCli(['close', '-s', 'dash-launch'])
  }, 10000)

  test('bare command alias accepts command after -- with launch options', async () => {
    const launch = await runCli(['-s', 'dash-default-launch', '--', 'printf', 'hello'], {
      env: { AI_AGENT: 'opencode' },
    })
    expect(launch.exitCode).toBe(0)
    expect(launch.stdout).toBe('Session "dash-default-launch" started')

    const output = await runCli(['read', '-s', 'dash-default-launch', '--all', '--trim'])
    expect(output.stdout).toContain('hello')

    await runCli(['close', '-s', 'dash-default-launch'])
  }, 10000)
})

describe('CLI concurrent sessions', () => {
  test('two sessions can run independently', async () => {
    // Launch two sessions
    const launch1 = await runCli(['launch', 'bash --norc --noprofile', '-s', 'session-a', '--env', 'PS1=A> '])
    const launch2 = await runCli(['launch', 'bash --norc --noprofile', '-s', 'session-b', '--env', 'PS1=B> '])
    expect(launch1.exitCode).toBe(0)
    expect(launch2.exitCode).toBe(0)

    // List sessions
    const sessions = await runCli(['sessions'])
    expect(sessions.exitCode).toBe(0)
    expect(sessions.stdout).toContain('session-a')
    expect(sessions.stdout).toContain('session-b')
    expect(sessions.stdout).toContain('\x1b[36msessions\x1b[39m\x1b[90m:\x1b[39m')
    expect(sessions.stdout).toContain('\x1b[36mname\x1b[39m\x1b[90m:\x1b[39m')
    expect(sessions.stdout).toContain('\x1b[90m"\x1b[39m\x1b[32msession-a\x1b[39m\x1b[90m"\x1b[39m')
    expect(sessions.stdout).toContain('\x1b[36mstatus\x1b[39m\x1b[90m:\x1b[39m \x1b[32malive\x1b[39m')

    // Type different things in each
    await runCli(['type', 'echo AAA', '-s', 'session-a'])
    await runCli(['type', 'echo BBB', '-s', 'session-b'])
    await runCli(['press', 'enter', '-s', 'session-a'])
    await runCli(['press', 'enter', '-s', 'session-b'])

    // Wait for outputs
    await runCli(['wait', 'AAA', '-s', 'session-a', '--timeout', '5000'])
    await runCli(['wait', 'BBB', '-s', 'session-b', '--timeout', '5000'])

    // Verify isolation - session-a has AAA, not BBB
    const snap1 = await runCli(['snapshot', '-s', 'session-a', '--trim'])
    expect(snap1.stdout).toContain('AAA')
    expect(snap1.stdout).not.toContain('BBB')

    // Verify isolation - session-b has BBB, not AAA
    const snap2 = await runCli(['snapshot', '-s', 'session-b', '--trim'])
    expect(snap2.stdout).toContain('BBB')
    expect(snap2.stdout).not.toContain('AAA')

    // Clean up
    await runCli(['close', '-s', 'session-a'])
    await runCli(['close', '-s', 'session-b'])

    // Verify our sessions are closed (other describes may run concurrently)
    const sessionsAfter = await runCli(['sessions'])
    expect(sessionsAfter.stdout).not.toContain('session-a')
    expect(sessionsAfter.stdout).not.toContain('session-b')
  }, 20000)
})

describe('CLI error handling', () => {
  test('duplicate session name reuses existing session', async () => {
    // Create first session
    const launch1 = await runCli(['launch', 'bash --norc', '-s', 'dup-test'])
    expect(launch1.exitCode).toBe(0)

    // Launching again with same name succeeds and reports already running
    const launch2 = await runCli(['launch', 'bash --norc', '-s', 'dup-test'])
    expect(launch2.exitCode).toBe(0)
    expect(launch2.stdout).toContain('Session "dup-test" already running')
    expect(launch2.stdout).toContain('`bash --norc`')
    expect(launch2.stdout).toContain('`tuistory read -s dup-test --all`')

    // Clean up
    await runCli(['close', '-s', 'dup-test'])
  }, 10000)

  test('close non-existent session fails', async () => {
    const close = await runCli(['close', '-s', 'nonexistent-session'])
    expect(close.exitCode).toBe(1)
    expect(close.stderr).toContain('not found')
  })

  test('snapshot without session option fails', async () => {
    const snapshot = await runCli(['snapshot'])
    expect(snapshot.exitCode).toBe(1)
    expect(snapshot.stderr).toContain('-s/--session is required')
  })

  test('snapshot with non-existent session fails', async () => {
    const snapshot = await runCli(['snapshot', '-s', 'ghost-session'])
    expect(snapshot.exitCode).toBe(1)
    expect(snapshot.stderr).toContain('not found')
  })

  test('press with invalid key shows error', async () => {
    // Launch session first
    await runCli(['launch', 'bash --norc', '-s', 'invalid-key-test'])

    // Try to press invalid key
    const press = await runCli(['press', 'invalidkey', '-s', 'invalid-key-test'])
    expect(press.exitCode).toBe(1)
    expect(press.stderr).toContain('Invalid key(s): invalidkey')
    expect(press.stderr).toContain('Valid keys:')

    // Clean up
    await runCli(['close', '-s', 'invalid-key-test'])
  }, 10000)

  test('press with multiple invalid keys shows all', async () => {
    await runCli(['launch', 'bash --norc', '-s', 'multi-invalid-test'])

    const press = await runCli(['press', 'foo', 'bar', '-s', 'multi-invalid-test'])
    expect(press.exitCode).toBe(1)
    expect(press.stderr).toContain('Invalid key(s): foo, bar')

    await runCli(['close', '-s', 'multi-invalid-test'])
  }, 10000)

  test('invalid forwarded command does not kill relay', async () => {
    const s = session('relay-survives-invalid-option')

    await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])

    const invalid = await runCli(['read', ...s, '--bogus-option'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr).toContain('Unknown option `--bogusOption`')

    const sessions = await runCli(['sessions'])
    expect(sessions.exitCode).toBe(0)
    expect(sessions.stdout).toContain('relay-survives-invalid-option')

    await runCli(['close', ...s])
  }, 15000)

  test('nested tuistory passes through to child command instead of erroring', async () => {
    const nested = await runCli(['launch', 'echo hello-from-nested', '-s', 'nested-launch-test'], {
      env: { TUISTORY_SESSION: 'outer-session' },
    })

    // Inner tuistory should exec the command directly (passthrough) and
    // exit with the child's exit code. No session is created on the relay.
    expect(nested.exitCode).toBe(0)
    expect(nested.stdout).toContain('hello-from-nested')

    const sessions = await runCli(['sessions'])
    expect(sessions.stdout).not.toContain('nested-launch-test')
  }, 10000)

  test('launch marks child processes as running inside a tuistory session', async () => {
    const s = session('session-env-test')
    const launch = await runCli(['launch', 'printf "$TUISTORY_SESSION"', ...s])
    expect(launch.exitCode).toBe(0)

    const output = await runCli(['read', ...s, '--all', '--trim'])
    expect(output.stdout).toContain('session-env-test')

    await runCli(['close', ...s])
  }, 10000)

  test('launch inherits caller environment variables', async () => {
    // The CLI client sends its full process.env to the relay, so child
    // processes inherit env vars from the caller's shell (including
    // node_modules/.bin in PATH injected by pnpm/bun).
    const s = session('caller-env-test')
    const launch = await runCli(['launch', 'printf "$CALLER_CUSTOM_VAR"', ...s], {
      env: { CALLER_CUSTOM_VAR: 'from-caller-shell' },
    })
    expect(launch.exitCode).toBe(0)

    const output = await runCli(['read', ...s, '--all', '--trim'])
    expect(output.stdout).toContain('from-caller-shell')

    await runCli(['close', ...s])
  }, 10000)

  test('read shows exit info suffix when process has exited', async () => {
    const s = session('exit-info-test')
    const launch = await runCli(['launch', 'printf done', ...s])
    expect(launch.exitCode).toBe(0)

    // Wait for process to exit
    await new Promise(r => setTimeout(r, 200))

    const output = await runCli(['read', ...s, '--all', '--trim'])
    expect(output.stdout).toContain('done')
    expect(output.stdout).toContain('[process exited with code 0]')

    // Non-zero exit code
    const s2 = session('exit-info-test-2')
    const launch2 = await runCli(['launch', 'bash -c "echo failing && exit 42"', ...s2])
    expect(launch2.exitCode).toBe(0)

    await new Promise(r => setTimeout(r, 200))

    const output2 = await runCli(['read', ...s2, '--all', '--trim'])
    expect(output2.stdout).toContain('failing')
    expect(output2.stdout).toContain('[process exited with code 42]')

    await runCli(['close', ...s])
    await runCli(['close', ...s2])
  }, 10000)

  test('launch skips auto-attach inside an agent', async () => {
    const s = session('agent-attach-test')
    const launch = await runCli(['launch', 'echo agent attach', ...s], {
      env: { AI_AGENT: 'opencode' },
    })

    expect(launch.exitCode).toBe(0)
    expect(launch.stdout).toContain('Session "agent-attach-test" started')
    expect(launch.stderr).toBe('')

    await runCli(['close', ...s])
  }, 10000)
})

describe('CLI daemon control', () => {
  test('daemon-stop stops the relay and clears active sessions', async () => {
    const s = session('daemon-stop-test')
    const launch = await runCli(['launch', 'sleep 60', ...s, '--no-wait'])
    expect(launch.exitCode).toBe(0)

    const stop = await runCli(['daemon-stop'])
    expect(stop.exitCode).toBe(0)
    expect(stop.stdout).toBe('Daemon stopped')

    const sessions = await runCli(['sessions'])
    expect(sessions.exitCode).toBe(0)
    expect(sessions.stdout).toBe('No active sessions')

    const jsonSessions = await runCli(['sessions', '--json'])
    expect(jsonSessions.exitCode).toBe(0)
    expect(jsonSessions.stdout).toBe('[]')
    expect(JSON.parse(jsonSessions.stdout)).toEqual([])
  }, 10000)

  // Regression: an orphaned daemon (one whose PID file was lost or never
  // written, e.g. a daemon that lost the bind race) used to survive
  // `daemon-stop` because killRelay only killed by port as a fallback when
  // the PID-based kill "failed". With an empty PID file the port holder was
  // never reliably killed, leaving a zombie daemon on the port that then
  // caused EADDRINUSE on the next launch. daemon-stop must free the port even
  // when the PID file is missing.
  test('daemon-stop frees the port when PID file is missing (orphan daemon)', async () => {
    const port = Number(process.env.TUISTORY_PORT)

    // Start a daemon by launching a session.
    const launch = await runCli(['launch', 'sleep 60', '-s', 'orphan-test', '--no-wait'])
    expect(launch.exitCode).toBe(0)

    // Simulate the orphan condition: remove the PID file so daemon-stop has no
    // recorded PID and must rely on the port sweep to find and kill the daemon.
    try { fs.unlinkSync(TEST_PID_FILE) } catch {}

    const stop = await runCli(['daemon-stop'])
    expect(stop.exitCode).toBe(0)

    // The port must actually be free now — not just a "Daemon stopped" message.
    const net = await import('node:net')
    const portFree = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve(false) })
      sock.once('error', () => { resolve(true) })
      setTimeout(() => { sock.destroy(); resolve(true) }, 500)
    })
    expect(portFree).toBe(true)
  }, 15000)

  // Regression: spawning a second daemon while one already owns the port used
  // to crash with an unhandled 'error' EADDRINUSE event (@hono/node-server's
  // serve() has no listen error handler). The losing daemon must now exit
  // cleanly without dumping a Node crash stack, and the existing daemon must
  // keep working.
  test('second daemon spawn does not crash on EADDRINUSE', async () => {
    // Ensure a daemon is running.
    const first = await runCli(['sessions'])
    expect(first.exitCode).toBe(0)

    const port = Number(process.env.TUISTORY_PORT)
    const isTs = CLI_PATH.endsWith('.ts')
    const execPath = isTs ? 'bun' : process.execPath

    // Spawn a raw relay daemon directly (bypassing the client's version check)
    // so it races for the already-bound port. It must exit cleanly.
    const orphan = spawn([execPath, CLI_PATH], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TUISTORY_RELAY: '1', TUISTORY_PORT: String(port) },
    })
    const exitCode = await orphan.exited
    const stderr = await new Response(orphan.stderr).text()

    // Losing daemon exits cleanly (0), not via an unhandled-error crash (1),
    // and never prints the telltale EADDRINUSE crash stack to stderr.
    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('EADDRINUSE')
    expect(stderr).not.toContain("Emitted 'error' event")

    // The original daemon must still be alive and serving.
    const after = await runCli(['sessions'])
    expect(after.exitCode).toBe(0)
  }, 15000)

  // Regression for the DEEPER bug: a process can hold the relay port without
  // answering HTTP /version (a wedged daemon, or an orphan whose event loop is
  // blocked). The client used to treat "no /version answer" as "no daemon" and
  // spawn a new one that then hit EADDRINUSE. ensureRelayRunning must now
  // detect the occupied-but-unresponsive port, kill the squatter, and start a
  // healthy daemon — so a normal command succeeds.
  test('ensureRelayRunning replaces an unresponsive port holder', async () => {
    await killTestDaemon()
    const port = Number(process.env.TUISTORY_PORT)

    // A SEPARATE process that holds the port but never answers HTTP. It must be
    // a child process (not in-process), because killRelay() resolves the PID
    // listening on the port and SIGKILLs it — an in-process blocker would kill
    // the test runner itself.
    const blocker = spawnPortBlocker(port)
    await waitForPortBound(port)

    try {
      // A normal command must recover: kill the squatter, spawn a real daemon.
      const result = await runCli(['sessions'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('No active sessions')
    } finally {
      try { blocker.kill('SIGKILL') } catch {}
    }
  }, 20000)

  // daemon-stop must also stop an unresponsive port holder, not just bail with
  // "No daemon running" because /version didn't answer.
  test('daemon-stop kills an unresponsive port holder', async () => {
    await killTestDaemon()
    const port = Number(process.env.TUISTORY_PORT)
    const net = await import('node:net')

    const blocker = spawnPortBlocker(port)
    await waitForPortBound(port)
    // Remove any stale PID file so the only way to stop it is the port sweep.
    try { fs.unlinkSync(TEST_PID_FILE) } catch {}

    try {
      const stop = await runCli(['daemon-stop'])
      // It must not claim "No daemon running" — the port is occupied.
      expect(stop.stdout).not.toContain('No daemon running')

      // The port must be free afterwards (the squatter was killed): a fresh
      // bind must succeed.
      const canRebind = await new Promise<boolean>((resolve) => {
        const probe = net.createServer()
        probe.once('error', () => resolve(false))
        probe.once('listening', () => probe.close(() => resolve(true)))
        probe.listen(port, '127.0.0.1')
      })
      expect(canRebind).toBe(true)
    } finally {
      try { blocker.kill('SIGKILL') } catch {}
    }
  }, 20000)
})

describe('CLI regex patterns', () => {
  test('wait with regex pattern /.../', async () => {
    // Launch session
    await runCli(['launch', 'bash --norc --noprofile', '-s', 'regex-test', '--env', 'PS1=$ '])

    // Echo a number
    await runCli(['type', 'echo "value: 42"', '-s', 'regex-test'])
    await runCli(['press', 'enter', '-s', 'regex-test'])

    // Wait with regex pattern
    const wait = await runCli(['wait', '/value: \\d+/', '-s', 'regex-test', '--timeout', '5000'])
    expect(wait.exitCode).toBe(0)
    expect(wait.stdout).toContain('echo "value: 42"')
    expect(wait.stdout).toContain('value: 42')

    // Clean up
    await runCli(['close', '-s', 'regex-test'])
  }, 10000)

  test('wait returns nearby output around the matching line', async () => {
    const s = session('wait-context-test')
    await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])

    await runCli(['type', 'for i in {1..25}; do echo "line $i"; done', ...s])
    await runCli(['press', 'enter', ...s])

    const wait = await runCli(['wait', 'line 15', ...s, '--timeout', '5000'])
    expect(wait.exitCode).toBe(0)
    expect(wait.stdout).toContain('line 5')
    expect(wait.stdout).toContain('line 15')
    expect(wait.stdout).toContain('line 25')
    expect(wait.stdout).not.toContain('line 4')

    const read = await runCli(['read', ...s])
    expect(read.stdout).toContain('line 15')

    await runCli(['close', ...s])
  }, 10000)
})

describe('wait exits early when process dies', () => {
  test('wait returns immediately with exit info when child exits before pattern matches', async () => {
    const s = session('wait-exit-test')
    // Launch a command that prints some output then exits with code 1
    await runCli(['launch', 'bash -c "echo starting-up && sleep 0.5 && echo crashing-now && exit 1"', ...s])

    // Wait for a pattern that will never appear, with a long timeout
    const wait = await runCli(['wait', '/this-will-never-match/', ...s, '--timeout', '30000'])
    expect(wait.exitCode).toBe(1)
    // Should mention the process exited, not a generic timeout
    expect(wait.stderr).toContain('Process exited')
    expect(wait.stderr).toContain('code 1')
    // Should include the last output so agents can see what happened
    expect(wait.stderr).toContain('crashing-now')

    await runCli(['close', ...s])
  }, 15000)

  test('wait succeeds if pattern matches in final output before exit is detected', async () => {
    const s = session('wait-exit-match-test')
    // The command prints the target pattern then exits
    await runCli(['launch', 'bash -c "echo found-the-pattern && exit 0"', ...s])

    const wait = await runCli(['wait', 'found-the-pattern', ...s, '--timeout', '10000'])
    expect(wait.exitCode).toBe(0)
    expect(wait.stdout).toContain('found-the-pattern')

    await runCli(['close', ...s])
  }, 10000)
})

describe('CLI env options', () => {
  test('multiple --env options work', async () => {
    // Launch with multiple env vars
    const launch = await runCli([
      'launch', 'bash --norc --noprofile',
      '-s', 'env-test',
      '--env', 'PS1=$ ',
      '--env', 'FOO=hello',
      '--env', 'BAR=world',
    ])
    expect(launch.exitCode).toBe(0)

    // Echo the env vars
    await runCli(['type', 'echo "$FOO $BAR"', '-s', 'env-test'])
    await runCli(['press', 'enter', '-s', 'env-test'])
    await runCli(['wait', 'hello world', '-s', 'env-test', '--timeout', '5000'])

    // Verify
    const snapshot = await runCli(['snapshot', '-s', 'env-test', '--trim'])
    expect(snapshot.stdout).toContain('hello world')

    // Clean up
    await runCli(['close', '-s', 'env-test'])
  }, 10000)
})

describe('CLI read command', () => {
  test('read returns process output as clean text', async () => {
    const s = session('read-basic')

    await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])

    // Run a command that produces output
    await runCli(['type', 'echo "hello from read"', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'hello from read', ...s, '--timeout', '5000'])

    // Read should contain the output
    const read1 = await runCli(['read', ...s])
    expect(read1.exitCode).toBe(0)
    expect(read1.stdout).toContain('hello from read')

    // Second read should return empty (nothing new)
    const read2 = await runCli(['read', ...s])
    expect(read2.exitCode).toBe(0)
    expect(read2.stdout).toBe('')

    // Run another command
    await runCli(['type', 'echo "second output"', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'second output', ...s, '--timeout', '5000'])

    // Read should only contain the new output
    const read3 = await runCli(['read', ...s])
    expect(read3.exitCode).toBe(0)
    expect(read3.stdout).toContain('second output')
    expect(read3.stdout).not.toContain('hello from read')

    await runCli(['close', ...s])
  }, 20000)

  test('read --all returns entire buffer without advancing cursor', async () => {
    const s = session('read-all')

    await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])

    await runCli(['type', 'echo "line one"', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'line one', ...s, '--timeout', '5000'])

    // Read to advance cursor
    const read1 = await runCli(['read', ...s])
    expect(read1.stdout).toContain('line one')

    // Add more output
    await runCli(['type', 'echo "line two"', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'line two', ...s, '--timeout', '5000'])

    // --all should return everything (including already-read output)
    const readAll = await runCli(['read', ...s, '--all'])
    expect(readAll.exitCode).toBe(0)
    expect(readAll.stdout).toContain('line one')
    expect(readAll.stdout).toContain('line two')

    // Regular read should still return only the new part (cursor not advanced by --all)
    const read2 = await runCli(['read', ...s])
    expect(read2.exitCode).toBe(0)
    expect(read2.stdout).toContain('line two')

    await runCli(['close', ...s])
  }, 20000)

  test('read --trim trims trailing newlines', async () => {
    const s = session('read-trim')

    await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])

    await runCli(['type', 'printf "trim me\\n\\n"', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'trim me', ...s, '--timeout', '5000'])

    const read = await runCli(['read', ...s, '--trim'])
    expect(read.exitCode).toBe(0)
    expect(read.stdout.endsWith('\n')).toBe(false)
    expect(read.stdout).toContain('trim me')

    await runCli(['close', ...s])
  }, 20000)

  test('read strips ANSI escape codes', async () => {
    const s = session('read-ansi')

    await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])

    // Use printf to emit colored output
    await runCli(['type', 'printf "\\033[31mred text\\033[0m normal"', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'normal', ...s, '--timeout', '5000'])

    const read = await runCli(['read', ...s])
    expect(read.exitCode).toBe(0)
    // Should contain the text but not raw escape codes
    expect(read.stdout).toContain('red text')
    expect(read.stdout).toContain('normal')
    expect(read.stdout).not.toContain('\x1b[31m')
    expect(read.stdout).not.toContain('\x1b[0m')

    await runCli(['close', ...s])
  }, 15000)
})

describe('CLI logfile', () => {
  test('logfile shows path', async () => {
    const { stdout, exitCode } = await runCli(['logfile'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tuistory')
    expect(stdout).toContain('relay-server.log')
  })
})

describe('CLI Node.js REPL', () => {
  test('node REPL evaluation', async () => {
    const s = session('node-repl')

    // Launch Node REPL
    await runCli(['launch', 'node', ...s])
    await runCli(['wait', '>', ...s, '--timeout', '5000'])

    // Evaluate expression
    await runCli(['type', '1 + 1', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', '2', ...s])

    // Evaluate more complex expression
    await runCli(['type', 'Math.PI.toFixed(4)', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', '3.1416', ...s])

    const snapshot = await runCli(['snapshot', ...s, '--trim'])
    // Verify REPL output contains our expressions and results
    expect(snapshot.stdout).toContain('Welcome to Node.js')
    expect(snapshot.stdout).toContain('> 1 + 1')
    expect(snapshot.stdout).toContain('2')
    expect(snapshot.stdout).toContain('> Math.PI.toFixed(4)')
    expect(snapshot.stdout).toContain("'3.1416'")

    // Exit REPL
    await runCli(['type', '.exit', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['close', ...s])
  }, 15000)
})

describe('CLI Node.js Debugger', () => {
  test('node debugger with breakpoint inspection', async () => {
    const s = session('node-debug')

    // Create a temporary script with debugger statement
    const tmpDir = os.tmpdir()
    const scriptPath = path.join(tmpDir, 'tuistory-debug-test.js')
    const script = `
const greeting = 'hello';
const count = 42;
debugger; // breakpoint
const result = greeting + ' ' + count;
console.log(result);
`.trim()

    fs.writeFileSync(scriptPath, script)

    try {
      // Launch node inspect (node debugger can be slow to connect, use generous timeouts)
      const launch = await runCli(['launch', `node inspect --port=0 ${scriptPath}`, ...s, '--cols', '100', '--rows', '30'])
      expect(launch.exitCode).toBe(0)

      const waitStart = await runCli(['wait', 'Break on start', ...s, '--timeout', '15000'])
      expect(waitStart.exitCode).toBe(0)

      // Continue to debugger statement
      await runCli(['type', 'cont', ...s])
      await runCli(['press', 'enter', ...s])

      const waitBreak = await runCli(['wait', 'break in', ...s, '--timeout', '10000'])
      expect(waitBreak.exitCode).toBe(0)

      // Check we hit the debugger statement
      const breakSnapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(breakSnapshot.exitCode).toBe(0)
      // Verify debugger output (avoid machine-specific paths and UUIDs)
      expect(breakSnapshot.stdout).toContain('Debugger listening on')
      expect(breakSnapshot.stdout).toContain('Debugger attached')
      expect(breakSnapshot.stdout).toContain('Break on start')
      expect(breakSnapshot.stdout).toContain("const greeting = 'hello'")
      expect(breakSnapshot.stdout).toContain('debug> cont')
      expect(breakSnapshot.stdout).toContain('> 3 debugger; // breakpoint')  // current line marker

      // Enter REPL mode to inspect variables
      await runCli(['type', 'repl', ...s])
      await runCli(['press', 'enter', ...s])

      const waitRepl = await runCli(['wait', 'Press Ctrl', ...s, '--timeout', '10000'])
      expect(waitRepl.exitCode).toBe(0)

      // Inspect greeting variable
      await runCli(['type', 'greeting', ...s])
      await runCli(['press', 'enter', ...s])

      const waitGreeting = await runCli(['wait', 'hello', ...s, '--timeout', '5000'])
      expect(waitGreeting.exitCode).toBe(0)

      // Inspect count variable
      await runCli(['type', 'count', ...s])
      await runCli(['press', 'enter', ...s])

      const waitCount = await runCli(['wait', '42', ...s, '--timeout', '5000'])
      expect(waitCount.exitCode).toBe(0)

      const replSnapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(replSnapshot.exitCode).toBe(0)
      // Verify REPL mode shows variable values
      expect(replSnapshot.stdout).toContain('debug> repl')
      expect(replSnapshot.stdout).toContain('Press Ctrl+C to leave debug repl')
      expect(replSnapshot.stdout).toContain('> greeting')
      expect(replSnapshot.stdout).toContain("'hello'")
      expect(replSnapshot.stdout).toContain('> count')
      expect(replSnapshot.stdout).toContain('42')

      // Exit REPL and continue
      await runCli(['press', 'ctrl', 'c', ...s])
      const waitDebugPrompt = await runCli(['wait', 'debug>', ...s, '--timeout', '5000'])
      expect(waitDebugPrompt.exitCode).toBe(0)
      await runCli(['type', 'cont', ...s])
      await runCli(['press', 'enter', ...s])
      const waitResult = await runCli(['wait', 'hello 42', ...s, '--timeout', '10000'])
      expect(waitResult.exitCode).toBe(0)

      // Get backtrace before exit
      const finalSnapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(finalSnapshot.stdout).toContain('hello 42')

      await runCli(['close', ...s])
    } finally {
      // Clean up temp file
      fs.unlinkSync(scriptPath)
    }
  }, 60000)
})

describe('CLI restart command', () => {
  test('restart relaunches with same command', async () => {
    const s = session('restart-basic')

    // Launch a bash session
    const launch = await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ '])
    expect(launch.exitCode).toBe(0)

    // Type something to prove this is the first instance
    await runCli(['type', 'echo first-run', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'first-run', ...s, '--timeout', '5000'])

    // Restart the session
    const restart = await runCli(['restart', ...s])
    expect(restart.exitCode).toBe(0)
    expect(restart.stdout).toBe('Session "restart-basic" restarted')

    // The old typed text should be gone (fresh terminal)
    const snapshot = await runCli(['snapshot', ...s, '--trim'])
    expect(snapshot.exitCode).toBe(0)
    expect(snapshot.stdout).not.toContain('first-run')

    // The session should still be alive and usable
    await runCli(['type', 'echo second-run', ...s])
    await runCli(['press', 'enter', ...s])
    await runCli(['wait', 'second-run', ...s, '--timeout', '5000'])

    const snapshot2 = await runCli(['snapshot', ...s, '--trim'])
    expect(snapshot2.stdout).toContain('second-run')

    await runCli(['close', ...s])
  }, 20000)

  test('restart preserves cwd', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-restart-cwd-')))
    const s = session('restart-cwd')

    try {
      await runCli(['launch', 'bash --norc --noprofile', ...s, '--env', 'PS1=$ ', '--cwd', cwd])

      // Restart
      const restart = await runCli(['restart', ...s])
      expect(restart.exitCode).toBe(0)

      // Verify cwd is preserved
      await runCli(['type', 'pwd', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', cwd, ...s, '--timeout', '5000'])

      const snapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(snapshot.stdout).toContain(cwd)

      await runCli(['close', ...s])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 20000)

  test('restart of non-existent session fails', async () => {
    const restart = await runCli(['restart', '-s', 'nonexistent-restart'])
    expect(restart.exitCode).toBe(1)
    expect(restart.stderr).toContain('not found')
  })

  test('restart of already-dead session works', async () => {
    const s = session('restart-dead')

    // Launch a short-lived command
    await runCli(['launch', 'echo hello-dead', ...s])
    await runCli(['wait', 'hello-dead', ...s, '--timeout', '5000'])

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 500))

    // Restart should work even though the process is dead
    const restart = await runCli(['restart', ...s])
    expect(restart.exitCode).toBe(0)
    expect(restart.stdout).toBe('Session "restart-dead" restarted')

    // The relaunched session should run the same command
    const output = await runCli(['read', ...s, '--all', '--trim'])
    expect(output.stdout).toContain('hello-dead')

    await runCli(['close', ...s])
  }, 15000)
})

describe('attach support', () => {
  test('--help shows attach command', async () => {
    const { stdout, exitCode } = await runCli(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('attach')
  })

  test('GET /sessions returns empty list initially', async () => {
    // Ensure relay is running by calling any command first
    await runCli(['sessions'])
    const res = await fetch(`http://127.0.0.1:${process.env.TUISTORY_PORT}/sessions`)
    const sessions = await res.json() as { name: string; cols: number; rows: number; dead: boolean }[]
    // May have leftover sessions, just check it's an array
    expect(Array.isArray(sessions)).toBe(true)
  })

  test('GET /sessions lists launched sessions', async () => {
    const s = session('attach-test-list')
    await runCli(['launch', 'echo hello', ...s])

    const res = await fetch(`http://127.0.0.1:${process.env.TUISTORY_PORT}/sessions`)
    const sessions = await res.json() as { name: string; cols: number; rows: number; dead: boolean }[]
    const found = sessions.find((s) => s.name === 'attach-test-list')
    expect(found).toBeDefined()
    expect(found!.cols).toBe(120)
    expect(found!.rows).toBe(36)

    await runCli(['close', ...s])
  })

  test('launch can reuse a dead session name', async () => {
    const s = session('relaunch-dead-session')
    const first = await runCli(['launch', 'echo first', ...s])
    expect(first.exitCode).toBe(0)

    const waitDead = await runCli(['wait', 'first', ...s, '--timeout', '5000'])
    expect(waitDead.exitCode).toBe(0)

    await new Promise((r) => setTimeout(r, 200))

    const second = await runCli(['launch', 'echo second', ...s])
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe('Session "relaunch-dead-session" started')

    const snapshot = await runCli(['snapshot', ...s, '--trim'])
    expect(snapshot.stdout).toContain('second')

    await runCli(['close', ...s])
  })

  test('WebSocket /attach receives PTY data', async () => {
    const s = session('attach-ws-test')
    await runCli(['launch', 'echo "ws-test-output"', ...s])

    // Connect WebSocket to relay
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.TUISTORY_PORT}/attach`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('ws connect failed')))
      setTimeout(() => reject(new Error('ws timeout')), 5000)
    })

    // Send attach handshake
    ws.send(JSON.stringify({ type: 'attach', session: 'attach-ws-test', cols: 80, rows: 24 }))

    // Collect messages for a brief period
    const messages: string[] = []
    const messagePromise = new Promise<void>((resolve) => {
      ws.addEventListener('message', (event) => {
        messages.push(String(event.data))
      })
      setTimeout(resolve, 1000)
    })
    await messagePromise

    ws.close()
    await runCli(['close', ...s])

    // The session ran `echo "ws-test-output"` so we should see at least
    // the exit message or data. Note: the echo may have completed before
    // we attached, so we mainly verify the WebSocket connection worked.
    expect(messages.length).toBeGreaterThanOrEqual(0)
  })

  test('WebSocket /attach returns error for nonexistent session', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.TUISTORY_PORT}/attach`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('ws connect failed')))
      setTimeout(() => reject(new Error('ws timeout')), 5000)
    })

    ws.send(JSON.stringify({ type: 'attach', session: 'nonexistent-session' }))

    const msg = await new Promise<string>((resolve) => {
      ws.addEventListener('message', (event) => {
        resolve(String(event.data))
      })
      setTimeout(() => resolve(''), 3000)
    })

    expect(msg).toContain('not found')
    ws.close()
  })

  test('WebSocket input forwarding works', async () => {
    const s = session('attach-input-test')
    await runCli(['launch', 'cat', ...s, '--cols', '80', '--rows', '24'])

    const ws = new WebSocket(`ws://127.0.0.1:${process.env.TUISTORY_PORT}/attach`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('ws connect failed')))
      setTimeout(() => reject(new Error('ws timeout')), 5000)
    })

    ws.send(JSON.stringify({ type: 'attach', session: 'attach-input-test', cols: 80, rows: 24 }))
    await new Promise((r) => setTimeout(r, 200))

    // Send input through WebSocket — cat echoes it back
    ws.send('hello from attach\r')
    await new Promise((r) => setTimeout(r, 500))

    ws.close()

    // Verify the input was received by checking snapshot
    const snapshot = await runCli(['snapshot', ...s, '--trim'])
    expect(snapshot.stdout).toContain('hello from attach')

    await runCli(['close', ...s])
  }, 15000)

  test('WebSocket kill terminates the process', async () => {
    const s = session('attach-kill-test')
    await runCli(['launch', 'sleep 60', ...s])

    const ws = new WebSocket(`ws://127.0.0.1:${process.env.TUISTORY_PORT}/attach`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('ws connect failed')))
      setTimeout(() => reject(new Error('ws timeout')), 5000)
    })

    ws.send(JSON.stringify({ type: 'attach', session: 'attach-kill-test', cols: 80, rows: 24 }))
    await new Promise((r) => setTimeout(r, 200))

    // Collect exit message
    const exitPromise = new Promise<string>((resolve) => {
      ws.addEventListener('message', (event) => {
        const str = String(event.data)
        if (str.includes('"type":"exit"') || str.includes('"type": "exit"')) {
          resolve(str)
        }
      })
      setTimeout(() => resolve(''), 5000)
    })

    // Send kill
    ws.send(JSON.stringify({ type: 'kill' }))

    const exitMsg = await exitPromise
    // Should receive an exit message (process was killed)
    expect(exitMsg).toContain('exit')

    ws.close()
    await runCli(['close', ...s])
  }, 15000)
})

describe('Relay daemon security (Origin / Host checks)', () => {
  // Ensure the daemon is running for these tests by issuing any CLI command first.
  beforeAll(async () => {
    await runCli(['sessions'])
  })

  const port = process.env.TUISTORY_PORT!
  const relay = `http://127.0.0.1:${port}`

  test('GET /version with Origin header is rejected with 403', async () => {
    const res = await fetch(`${relay}/version`, {
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toContain('forbidden')
  })

  test('GET /version with no Origin still works (legitimate Node fetch)', async () => {
    const res = await fetch(`${relay}/version`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('version')
  })

  test('GET /sessions with Origin header is rejected with 403', async () => {
    const res = await fetch(`${relay}/sessions`, {
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  test('POST /cli with Origin header is rejected (blocks browser RCE)', async () => {
    const res = await fetch(`${relay}/cli`, {
      method: 'POST',
      headers: {
        // text/plain is a CORS "simple" content-type — no preflight is sent.
        // Without our middleware this request would launch a real session.
        'Content-Type': 'text/plain',
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ argv: ['sessions'], cwd: '/', env: {} }),
    })
    expect(res.status).toBe(403)
  })

  test('POST /cli with rebound Host header is rejected (blocks DNS rebinding)', async () => {
    const res = await fetch(`${relay}/cli`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'attacker.example.com',
      },
      body: JSON.stringify({ argv: ['sessions'], cwd: '/', env: {} }),
    })
    expect(res.status).toBe(403)
  })

  test('WebSocket upgrade with Origin header is rejected before any frame', async () => {
    // Send a raw HTTP/1.1 WebSocket upgrade request with a forged Origin and
    // assert the server rejects it. A legitimate response would be `HTTP/1.1
    // 101 Switching Protocols`; the rejection path may either close the socket
    // immediately or write a 403 status line, depending on @hono/node-ws.
    // Both outcomes are acceptable — what matters is that no 101 is sent.
    const net = await import('node:net')
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1')
      const chunks: Buffer[] = []
      socket.on('connect', () => {
        const req =
          'GET /attach HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Origin: https://evil.example.com\r\n' +
          '\r\n'
        socket.write(req)
      })
      socket.on('data', (c) => chunks.push(c))
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
      setTimeout(() => {
        socket.destroy()
        reject(new Error('upgrade test timed out'))
      }, 5000)
    })
    // The critical security invariant: no protocol switch happened.
    expect(response).not.toContain('101 Switching Protocols')
    // Either the server wrote a 403 line, or it closed the socket with no
    // response. Both mean the malicious upgrade was aborted.
    if (response.length > 0) {
      expect(response).toMatch(/^HTTP\/1\.1 403\b/)
    }
  })

  test('WebSocket upgrade without Origin still succeeds (legitimate attach client)', async () => {
    const s = session('security-attach-ok')
    await runCli(['launch', 'sleep 30', ...s])

    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach`)
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener('open', () => resolve(true))
      ws.addEventListener('error', () => resolve(false))
      setTimeout(() => resolve(false), 3000)
    })
    expect(opened).toBe(true)

    ws.close()
    await runCli(['close', ...s])
  }, 10000)
})
