import { spawn } from 'bun'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLI_PATH = new URL('./cli.ts', import.meta.url).pathname

// Helper to run CLI command
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(['bun', CLI_PATH, ...args], {
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
"tuistory/0.0.13

Usage:
  $ tuistory <command> [options]

Commands:
  launch <command>                Launch a new terminal session with a PTY (pseudo-terminal).
                                  
                                  Spawns the given command in a virtual terminal with configurable
                                  dimensions. The command string is parsed like a shell — spaces
                                  separate arguments, quotes group them.
                                  
                                  The session runs inside a background daemon so it persists
                                  across multiple tuistory invocations. Use \`-s\` to name
                                  sessions for easy reference.
                                  
                                  **Tip:** Always run \`snapshot --trim\` after launch to see
                                  the initial terminal state — many apps show first-run dialogs
                                  or login prompts you need to handle.
    -s, --session <name>          Session name (default: default)
    --cols <n>                    Terminal columns (default: 80)
    --rows <n>                    Terminal rows (default: 24)
    --cwd <path>                  Working directory
    --env <key=value>             Environment variable (repeatable)
    --no-wait                     Don't wait for initial data
    --timeout <ms>                Wait timeout in milliseconds (default: 5000)

  snapshot                        Capture the current terminal screen as text.
                                  
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
    -s, --session <name>          Session name (required)
    --json                        Output as JSON with metadata
    --trim                        Trim trailing whitespace and empty lines
    --immediate                   Don't wait for idle state
    --bold                        Only bold text
    --italic                      Only italic text
    --underline                   Only underlined text
    --fg <color>                  Only text with foreground color
    --bg <color>                  Only text with background color
    --no-cursor                   Hide cursor in snapshot output

  screenshot                      Capture the terminal screen as an image file (JPEG/PNG/WebP).
                                  
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
    -s, --session <name>          Session name (required)
    -o, --output <path>           Output file path (default: temp file)
    --width <px>                  Image width in pixels (auto from cols)
    --font-size <px>              Font size in pixels (default: 14)
    --line-height <n>             Line height multiplier (default: 1.5)
    --background <color>          Background color (default: #1a1b26)
    --foreground <color>          Text color (default: #c0caf5)
    --format <fmt>                Image format (default: jpeg)
    --quality <n>                 Quality for lossy formats (0-100) (default: 90)
    --immediate                   Don't wait for idle state

  type <text>                     Type text into the terminal character by character.
                                  
                                  Sends each character individually with a small delay between
                                  them, simulating real user typing. This triggers per-keystroke
                                  events in the target application (autocomplete, search-as-you-type,
                                  input validation, etc.).
                                  
                                  The text is sent as-is — no shell escaping or interpretation.
                                  For special keys like Enter or Ctrl+C, use \`press\` instead.
    -s, --session <name>          Session name (required)

  press <key> [...keys]           Press one or more keys simultaneously (key chord).
                                  
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
    -s, --session <name>          Session name (required)

  click <pattern>                 Click on text matching a pattern in the terminal.
                                  
                                  Searches the terminal screen for text matching the given
                                  pattern and sends a mouse click event at its position.
                                  Supports plain text and regex patterns (use /pattern/ syntax).
                                  
                                  If multiple matches are found, the command fails unless
                                  \`--first\` is passed. Use a more specific pattern or regex
                                  to match exactly one element.
                                  
                                  Waits up to \`--timeout\` ms for the pattern to appear,
                                  polling the terminal contents.
    -s, --session <name>          Session name (required)
    --first                       Click first match if multiple found
    --timeout <ms>                Timeout in milliseconds (default: 5000)

  click-at <x> <y>                Click at specific terminal coordinates (column, row).
                                  
                                  Sends a mouse click event at the given (x, y) position.
                                  Coordinates are 0-based: (0, 0) is the top-left corner.
                                  
                                  Useful when the target element doesn't have unique text
                                  to match with \`click\`, or for clicking on UI chrome
                                  like borders, scrollbars, or status bars.
    -s, --session <name>          Session name (required)

  wait <pattern>                  Wait for text or regex pattern to appear in the terminal.
                                  
                                  Polls the terminal content until the pattern is found or
                                  timeout is reached. Useful for waiting on async operations
                                  like command output, loading screens, or API responses.
                                  
                                  Supports regex patterns with /pattern/flags syntax.
                                  Plain strings are matched literally.
                                  
                                  Returns "OK" when pattern is found, exits with error on timeout.
    -s, --session <name>          Session name (required)
    --timeout <ms>                Timeout in milliseconds (default: 5000)

  wait-idle                       Wait for the terminal to stop receiving data (become idle).
                                  
                                  Waits until no new data has been received for ~60ms,
                                  indicating the application has finished rendering.
                                  
                                  Useful between rapid actions to ensure the terminal has
                                  settled before taking a snapshot. Most commands already
                                  wait for idle internally, but this is helpful when you
                                  need explicit synchronization.
    -s, --session <name>          Session name (required)
    --timeout <ms>                Timeout in milliseconds (default: 500)

  scroll <direction> [lines]      Scroll the terminal up or down using mouse wheel events.
                                  
                                  Sends SGR mouse scroll events at the center of the terminal
                                  (or at specific coordinates with --x/--y). The number of
                                  scroll events can be controlled with the [lines] argument.
                                  
                                  Direction must be "up" or "down".
    -s, --session <name>          Session name (required)
    --x <n>                       X coordinate for scroll event
    --y <n>                       Y coordinate for scroll event

  resize <cols> <rows>            Resize the terminal to new dimensions.
                                  
                                  Changes the terminal width (columns) and height (rows).
                                  The PTY and the virtual terminal emulator are both resized,
                                  triggering a SIGWINCH signal in the running application.
                                  
                                  Applications that handle terminal resize (like vim, htop,
                                  or TUI frameworks) will re-render to fit the new size.
    -s, --session <name>          Session name (required)

  capture-frames <key> [...keys]  Capture multiple rapid terminal snapshots after a keypress.
                                  
                                  Sends the key(s) and then captures N frames at a fixed
                                  interval. Useful for detecting layout shifts, animations,
                                  or transitions that happen in the frames immediately after
                                  a key event.
                                  
                                  Output is a JSON array of text snapshots.
    -s, --session <name>          Session name (required)
    --count <n>                   Number of frames to capture (default: 5)
    --interval <ms>               Interval between frames in ms (default: 10)

  close                           Close a terminal session and kill its process.
                                  
                                  Terminates the PTY process and removes the session from
                                  the daemon. The session name can be reused after closing.
    -s, --session <name>          Session name (required)

  sessions                        List all active session names.
                                  
                                  Shows one session name per line. Sessions are created with
                                  \`launch\` and persist until \`close\` or \`daemon-stop\`.

  logfile                         Print the path to the daemon log file.
                                  
                                  The relay daemon writes logs to this file. Useful for
                                  debugging when commands fail or the daemon won't start.

  daemon-stop                     Stop the background relay daemon.
                                  
                                  The daemon runs as a detached process that holds all
                                  sessions in memory. Stopping it closes all active sessions.
                                  
                                  A new daemon is started automatically on the next command.

Options:
  -h, --help     Display this message
  -v, --version  Display version number

Examples:
# Full workflow: launch, interact, snapshot, close
tuistory launch "claude" -s ai --cols 100 --rows 30
tuistory -s ai wait "Claude" --timeout 15000
tuistory -s ai type "what is 2+2?"
tuistory -s ai press enter
tuistory -s ai wait "/[0-9]+/" --timeout 30000
tuistory -s ai snapshot --trim
tuistory -s ai close"
`)
  })

  test('launch --help shows launch options', async () => {
    const { stdout, exitCode } = await runCli(['launch', '--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toMatchInlineSnapshot(`
"tuistory/0.0.13

Usage:
  $ tuistory launch <command>

Options:
  -s, --session <name>  Session name (default: default)
  --cols <n>            Terminal columns (default: 80)
  --rows <n>            Terminal rows (default: 24)
  --cwd <path>          Working directory
  --env <key=value>     Environment variable (repeatable)
  --no-wait             Don't wait for initial data
  --timeout <ms>        Wait timeout in milliseconds (default: 5000)
  -h, --help            Display this message

Description:
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

Examples:
tuistory launch "claude" -s claude --cols 120 --rows 30
tuistory launch "node" -s repl --cols 80
tuistory launch "bash --norc" -s sh --env PS1="$ " --env FOO=bar
# Launch and immediately check what the app shows:
tuistory launch "claude" -s ai && tuistory -s ai snapshot --trim"
`)
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
      // Launch node inspect
      await runCli(['launch', `node inspect ${scriptPath}`, ...s, '--cols', '100', '--rows', '30'])
      await runCli(['wait', 'Break on start', ...s, '--timeout', '10000'])

      // Continue to debugger statement
      await runCli(['type', 'cont', ...s])
      await runCli(['press', 'enter', ...s])
      await runCli(['wait', 'break in', ...s, '--timeout', '5000'])

      // Check we hit the debugger statement
      const breakSnapshot = await runCli(['snapshot', ...s, '--trim'])
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
      // Verify REPL mode shows variable values
      expect(replSnapshot.stdout).toContain('debug> repl')
      expect(replSnapshot.stdout).toContain('Press Ctrl+C to leave debug repl')
      expect(replSnapshot.stdout).toContain('> greeting')
      expect(replSnapshot.stdout).toContain("'hello'")
      expect(replSnapshot.stdout).toContain('> count')
      expect(replSnapshot.stdout).toContain('42')

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
