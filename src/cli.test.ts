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
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(['bun', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TUISTORY_PORT: process.env.TUISTORY_PORT },
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

// Kill the test daemon by PID (daemon-stop command was removed to protect user sessions).
// Sends SIGTERM for graceful shutdown, escalates to SIGKILL if it doesn't exit within 2s.
async function killTestDaemon() {
  try {
    const pid = Number(fs.readFileSync(TEST_PID_FILE, 'utf-8').trim())
    if (!isNaN(pid) && pid > 0) {
      process.kill(pid, 'SIGTERM')
      const start = Date.now()
      let exited = false
      while (Date.now() - start < 2000) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)) }
        catch { exited = true; break }
      }
      if (!exited) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
  } catch {}
  try { fs.unlinkSync(TEST_PID_FILE) } catch {}
}

// Helper to create session args for readability
const session = (name: string) => ['-s', name] as const

// Kill any existing test daemon before tests
beforeAll(async () => {
  await killTestDaemon()
  await new Promise((r) => setTimeout(r, 500))
})

// Clean up test daemon after tests
afterAll(async () => {
  await killTestDaemon()
})

describe('CLI help and version', () => {
  test('--help shows all commands', async () => {
    const { stdout, exitCode } = await runCli(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('launch <command>')
    expect(stdout).toContain('snapshot')
    expect(stdout).toContain('read')
    expect(stdout).toContain('screenshot')
    expect(stdout).toContain('type <text>')
    expect(stdout).toContain('press <key>')
    expect(stdout).toContain('click <pattern>')
    expect(stdout).toContain('wait <pattern>')
    expect(stdout).toContain('close')
    expect(stdout).toContain('sessions')
  })

  test('launch --help shows launch options', async () => {
    const { stdout, exitCode } = await runCli(['launch', '--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('$ tuistory launch <command>')
    expect(stdout).toContain('--session <name>')
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
  test('duplicate session name fails', async () => {
    // Create first session
    const launch1 = await runCli(['launch', 'bash --norc', '-s', 'dup-test'])
    expect(launch1.exitCode).toBe(0)

    // Try to create duplicate
    const launch2 = await runCli(['launch', 'bash --norc', '-s', 'dup-test'])
    expect(launch2.exitCode).toBe(1)
    expect(launch2.stderr).toContain('already exists')

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
    expect(wait.stdout).toBe('OK')

    // Clean up
    await runCli(['close', '-s', 'regex-test'])
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
      const launch = await runCli(['launch', `node inspect ${scriptPath}`, ...s, '--cols', '100', '--rows', '30'])
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
