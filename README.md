<div align='center'>
    <br/>
    <br/>
    <h3>tuistory</h3>
    <p>Agent browser for TUIs and CLI processes</p>
    <p>Control terminals, capture output, take screenshots — designed for AI agents</p>
    <br/>
    <br/>
</div>

tuistory is a CLI and library to control and capture terminal applications and process outputs. Like how [agent browsers](https://github.com/AiAgent-Browser/AiAgent-Browser) let AI agents drive web pages — launch, click, type, wait, screenshot — tuistory does the same for terminal apps.

- **Launch** processes in named background sessions (replaces tmux for automation)
- **Type** text and **press** keys (Enter, Ctrl+C, arrow keys, chords)
- **Wait** for specific output with regex patterns and timeouts (replaces `sleep`)
- **Read** new process output since last call (streaming log access)
- **Snapshot** the current terminal screen as text
- **Screenshot** the terminal as JPEG/PNG/WebP images
- **Click** on text patterns or coordinates (mouse events)

## Installation

```bash
# As a library
bun add tuistory
npm install tuistory

# As a CLI (global)
bun add -g tuistory
npm install -g tuistory

# Or use directly with npx/bunx
npx tuistory --help
```

## Running processes in background (replaces tmux)

tuistory can replace tmux for running background processes in automation scripts. The key advantage: **no more `sleep` and guessing** — tuistory waits for actual output reactively.

### Before: tmux

```bash
# Start dev server
tmux new-session -d -s dev
tmux send-keys -t dev "pnpm dev" Enter

# Guess how long to wait...
sleep 5

# Hope it's ready, grab whatever is on screen
tmux capture-pane -t dev -p | grep "ready"

# Check logs later (only visible screen, no scrollback)
tmux capture-pane -t dev -p

# Stop
tmux send-keys -t dev C-c
tmux kill-session -t dev
```

**Problems:** `sleep 5` is a blind guess. Too short and the server isn't ready. Too long and you waste time. `capture-pane` only shows what fits on screen — if the server logged 500 lines, you only see the last 36.

### After: tuistory

```bash
# Start dev server
tuistory launch "pnpm dev" -s dev

# Option 1: Wait for output to stabilize (when you don't know what to expect)
tuistory -s dev wait-idle --timeout 30000

# Option 2: Wait for specific text (when you know what "ready" looks like)
tuistory -s dev wait "ready on" --timeout 30000

# Read ALL output the process has printed (not just visible screen)
tuistory read -s dev

# Later, read only NEW output since last read
tuistory read -s dev

# Read entire buffered log (up to 1MB)
tuistory read -s dev --all

# Stop
tuistory -s dev press ctrl c
tuistory -s dev close
```

**How `wait-idle` and `wait` replace `sleep`:** Instead of sleeping for a fixed duration, `wait-idle` waits until the terminal stops receiving data (~60ms of silence), meaning the process finished its output burst. `wait` goes further — it polls reactively until a specific pattern appears. Both react as fast as the terminal updates (~75ms), with no guessing. If the timeout expires, you get a clear error with the current screen content.

**How `read` replaces `capture-pane`:** `snapshot` shows the current visible screen (like taking a photo of a monitor). `read` gives you the full output stream — everything the process printed since your last `read` call, with ANSI escape codes stripped. If a dev server logged 500 lines, `read` returns all 500 as clean text.

## CLI Usage

### Quick Start

```bash
# Launch Claude Code
tuistory launch "claude" -s claude --cols 150 --rows 45

# Wait for it to load
tuistory -s claude wait "Claude Code" --timeout 15000

# Type a prompt
tuistory -s claude type "what is 2+2? reply with just the number"
tuistory -s claude press enter

# Wait for Claude's response using regex (matches any digit)
tuistory -s claude wait "/[0-9]+/" --timeout 30000

# Get terminal snapshot
tuistory -s claude snapshot --trim

# Read all process output (full log, not just visible screen)
tuistory read -s claude --all

# Close the session
tuistory -s claude close
```

### Debugging Node.js with tuistory

```bash
# Launch Node.js debugger (assuming app.js has a debugger statement)
tuistory launch "node inspect app.js" -s debug --cols 120

# Wait for debugger to start and continue to breakpoint
tuistory -s debug wait "Break on start"
tuistory -s debug type "cont"
tuistory -s debug press enter
tuistory -s debug wait "break in"
tuistory -s debug snapshot --trim

# Print stack trace with bt (backtrace)
tuistory -s debug type "bt"
tuistory -s debug press enter
tuistory -s debug snapshot --trim
# Output:
# #0 getPrice app.js:13:2
# #1 calculateTotal app.js:7:15
# #2 processOrder app.js:2:16

# Enter REPL mode to inspect variables
tuistory -s debug type "repl"
tuistory -s debug press enter
tuistory -s debug type "item"
tuistory -s debug press enter
tuistory -s debug snapshot --trim
# Output:
# > item
# { name: 'Widget', price: 25, quantity: 2 }

# Clean up
tuistory -s debug close
```

### CLI Commands Reference

```bash
tuistory launch <command>     # Start a terminal session
tuistory snapshot             # Get current terminal screen as text
tuistory read                 # Get new process output since last read
tuistory screenshot           # Capture terminal as image (JPEG/PNG/WebP)
tuistory type <text>          # Type text character by character
tuistory press <key> [keys]   # Press key(s): enter, ctrl c, alt f4
tuistory click <pattern>      # Click on text matching pattern
tuistory wait <pattern>       # Wait for text (supports /regex/)
tuistory wait-idle            # Wait for terminal to stabilize
tuistory scroll <up|down>     # Scroll the terminal
tuistory resize <cols> <rows> # Resize terminal
tuistory close                # Close a session
tuistory sessions             # List active sessions
```

### Options

```bash
-s, --session <name>  # Session name (required for most commands)
--cols <n>            # Terminal columns (default: 120)
--rows <n>            # Terminal rows (default: 36)
--env <key=value>     # Environment variable (repeatable)
--timeout <ms>        # Wait timeout in milliseconds
--trim                # Trim whitespace from snapshot
--json                # Output as JSON
--all                 # For read: return entire buffer
--follow              # For read: block until new output
```

### Tips for Successful Automation

**Run `snapshot` after every action** — Terminal applications are stateful and may show dialogs, prompts, or errors. Always check the current state:

```bash
tuistory -s mysession press enter
tuistory -s mysession snapshot --trim  # See what happened
```

**Use `read` for log-heavy processes** — When a process outputs more than fits on screen, `snapshot` only shows the visible portion. Use `read` to get the full output stream:

```bash
tuistory launch "npm test" -s test
tuistory -s test wait "Tests:" --timeout 60000
tuistory read -s test  # Get ALL test output, not just last screenful
```

**Use `wait-idle` when you don't know what to wait for** — If you just need the process to finish its initial burst of output before reading, `wait-idle` waits until the terminal stops receiving data:

```bash
tuistory launch "npm test" -s test
tuistory -s test wait-idle --timeout 10000  # Wait for output to stabilize
tuistory read -s test                       # Read everything it printed
```

**Use `wait` for async operations** — Don't assume commands complete instantly:

```bash
tuistory -s mysession type "long-running-command"
tuistory -s mysession press enter
tuistory -s mysession wait "Done" --timeout 60000  # Wait for completion
tuistory -s mysession snapshot --trim
```

## Library Usage (Playwright for terminals)

Use tuistory programmatically in your tests or scripts — like Playwright, but for terminal apps:

```ts
import { launchTerminal } from 'tuistory'

const session = await launchTerminal({
  command: 'claude',
  args: [],
  cols: 150,
  rows: 45,
})

await session.waitForText('claude', { timeout: 10000 })

const initialText = await session.text()
expect(initialText).toMatchInlineSnapshot(`
  "
  ╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ Welcome to Claude Code                                                                           │
  ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  "
`)

await session.type('/help')
await session.press('enter')

// Read all process output (full stream, not just visible screen)
const output = session.read()

// Read entire buffered output
const allOutput = session.readAll()

await session.press(['ctrl', 'c'])
session.close()
```

## API

### `launchTerminal(options)`

Launch a terminal session.

```ts
const session = await launchTerminal({
  command: 'my-cli',
  args: ['--flag'],
  cols: 120,
  rows: 36,
  cwd: '/path/to/dir',
  env: { MY_VAR: 'value' },
})
```

### `session.type(text)`

Type a string character by character.

```ts
await session.type('hello world')
```

### `session.press(keys)`

Press a single key or a chord (multiple keys simultaneously).

```ts
await session.press('enter')
await session.press('tab')
await session.press(['ctrl', 'c'])
await session.press(['ctrl', 'shift', 'a'])
```

**Available keys:** `enter`, `esc`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`

**Modifiers:** `ctrl`, `alt`, `shift`, `meta`

### `session.text(options?)`

Get the current terminal screen text.

```ts
const text = await session.text()

// Filter by style
const boldText = await session.text({ only: { bold: true } })
const coloredText = await session.text({ only: { foreground: '#ff0000' } })
```

### `session.read()`

Read new process output since the last `read()` call. Returns clean text with ANSI codes stripped. Each call advances the cursor — the next call only returns newer output.

```ts
const newOutput = session.read()   // new since last read
const allOutput = session.readAll() // entire buffer (up to 1MB)
```

### `session.waitForText(pattern, options?)`

Wait for text or regex to appear.

```ts
await session.waitForText('Ready')
await session.waitForText(/Loading\.\.\./, { timeout: 10000 })
```

### `session.click(pattern, options?)`

Click on text matching a pattern.

```ts
await session.click('Submit')
await session.click(/Button \d+/, { first: true })
```

### `session.close()`

Close the terminal session.

```ts
session.close()
```

## Projects using tuistory

- [Termcast](https://github.com/remorses/termcast): A Raycast API re-implementation for the terminal. Turns raycast extensions into TUIs. Agents use tuistory to autonomously convert Raycast extensions into TUIs and fix any missing termcast APIs.
- [Kimaki](https://github.com/remorses/kimaki): Discord bots agents that can use Tuistory to control TTY processes like opencode, claude code and debuggers.

## License

MIT
