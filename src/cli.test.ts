import { spawn } from 'bun'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

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
