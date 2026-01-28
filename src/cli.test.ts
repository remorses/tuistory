import { spawn } from 'bun'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLI_PATH = new URL('./cli.ts', import.meta.url).pathname

// Helper to run CLI command
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(['tsx', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

// Helper to create session args for readability
const session = (name: string) => ['-s', name] as const

// Kill any existing daemon before tests
beforeAll(async () => {
  await runCli(['daemon-stop']).catch(() => {})
  await new Promise((r) => setTimeout(r, 500))
})

// Clean up daemon after tests
afterAll(async () => {
  await runCli(['daemon-stop']).catch(() => {})
})

describe('CLI help and version', () => {
  test('--help shows all commands', async () => {
    const { stdout, exitCode } = await runCli(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toMatchInlineSnapshot(`
"tuistory/0.0.7

Usage:
  $ tuistory <command> [options]

Commands:
  launch <command>                Launch a terminal session
  snapshot                        Get terminal text content
  type <text>                     Type text character by character
  press <key> [...keys]           Press key(s)
  click <pattern>                 Click on text matching pattern
  click-at <x> <y>                Click at coordinates
  wait <pattern>                  Wait for text to appear
  wait-idle                       Wait for terminal to become idle
  scroll <direction> [lines]      Scroll up or down
  resize <cols> <rows>            Resize terminal
  capture-frames <key> [...keys]  Capture multiple frames after keypress
  close                           Close a session
  sessions                        List active sessions
  logfile                         Print the path to the log file
  daemon-stop                     Stop the relay daemon

For more info, run any command with the \`--help\` flag:
  $ tuistory launch --help
  $ tuistory snapshot --help
  $ tuistory type --help
  $ tuistory press --help
  $ tuistory click --help
  $ tuistory click-at --help
  $ tuistory wait --help
  $ tuistory wait-idle --help
  $ tuistory scroll --help
  $ tuistory resize --help
  $ tuistory capture-frames --help
  $ tuistory close --help
  $ tuistory sessions --help
  $ tuistory logfile --help
  $ tuistory daemon-stop --help

Options:
  -h, --help     Display this message 
  -v, --version  Display version number"
`)
  })

  test('launch --help shows launch options', async () => {
    const { stdout, exitCode } = await runCli(['launch', '--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toMatchInlineSnapshot(`
"tuistory/0.0.7

Usage:
  $ tuistory launch <command>

Options:
  -s, --session <name>  Session name (default: default)
  --cols <n>            Terminal columns (default: 80)
  --rows <n>            Terminal rows (default: 24)
  --cwd <path>          Working directory 
  --env <key=value>     Environment variable (can be used multiple times) 
  --no-wait             Don't wait for initial data (default: true)
  --timeout <ms>        Wait timeout in milliseconds (default: 5000)
  -h, --help            Display this message"
`)
  })

  test('--version shows version', async () => {
    const { stdout, exitCode } = await runCli(['--version'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tuistory/0.0.7')
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

    // Verify sessions closed
    const sessionsAfter = await runCli(['sessions'])
    expect(sessionsAfter.stdout).toBe('No active sessions')
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
    expect(snapshot.stdout).toMatchInlineSnapshot(`
"Welcome to Node.js v22.21.1.
Type ".help" for more information.
> 1 + 1
2
> Math.PI.toFixed(4)
'3.1416'
>"
`)

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
      // Launch node inspect
      await runCli(['launch', `node inspect ${scriptPath}`, ...s, '--cols', '100', '--rows', '30'])
      await runCli(['wait', 'Break on start', ...s, '--timeout', '10000'])

      // Continue to debugger statement
      await runCli(['type', 'cont', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', 'break in', ...s, '--timeout', '5000'])

      // Check we hit the debugger statement
      const breakSnapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(breakSnapshot.stdout).toMatchInlineSnapshot(`
"< Debugger listening on ws://127.0.0.1:9229/bed09949-1934-41f7-8749-dbafd86def44
< For help, see: https://nodejs.org/en/docs/inspector
<
< Debugger attached.
<
 ok
Break on start in /private/var/folders/8w/wvmrpgms5hngywvs8s99xnmm0000gn/T/tuistory-debug-test.js:1
> 1 const greeting = 'hello';
  2 const count = 42;
  3 debugger; // breakpoint
debug> cont
break in /private/var/folders/8w/wvmrpgms5hngywvs8s99xnmm0000gn/T/tuistory-debug-test.js:3
  1 const greeting = 'hello';
  2 const count = 42;
> 3 debugger; // breakpoint
  4 const result = greeting + ' ' + count;
  5 console.log(result);
debug>"
`)

      // Enter REPL mode to inspect variables
      await runCli(['type', 'repl', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', 'Press Ctrl', ...s])

      // Inspect greeting variable
      await runCli(['type', 'greeting', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', 'hello', ...s])

      // Inspect count variable
      await runCli(['type', 'count', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', '42', ...s])

      const replSnapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(replSnapshot.stdout).toMatchInlineSnapshot(`
"< Debugger listening on ws://127.0.0.1:9229/bed09949-1934-41f7-8749-dbafd86def44
< For help, see: https://nodejs.org/en/docs/inspector
<
< Debugger attached.
<
 ok
Break on start in /private/var/folders/8w/wvmrpgms5hngywvs8s99xnmm0000gn/T/tuistory-debug-test.js:1
> 1 const greeting = 'hello';
  2 const count = 42;
  3 debugger; // breakpoint
debug> cont
break in /private/var/folders/8w/wvmrpgms5hngywvs8s99xnmm0000gn/T/tuistory-debug-test.js:3
  1 const greeting = 'hello';
  2 const count = 42;
> 3 debugger; // breakpoint
  4 const result = greeting + ' ' + count;
  5 console.log(result);
debug> repl
Press Ctrl+C to leave debug repl
> greeting
'hello'
> count
42
>"
`)

      // Exit REPL and continue
      await runCli(['press', 'ctrl', 'c', ...s])
      await runCli(['wait', 'debug>', ...s])
      await runCli(['type', 'cont', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', 'hello 42', ...s])

      // Get backtrace before exit
      const finalSnapshot = await runCli(['snapshot', ...s, '--trim'])
      expect(finalSnapshot.stdout).toContain('hello 42')

      await runCli(['close', ...s])
    } finally {
      // Clean up temp file
      fs.unlinkSync(scriptPath)
    }
  }, 30000)
})
