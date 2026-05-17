<div align="center">
    <br />
    <br />
    <h3>tuistory</h3>
    <p>Run dev servers and TUIs that AI agents can read, wait on, and type into.</p>
    <br />
    <br />
</div>

**tmux for AI agents.** tuistory wraps any terminal command in a named background session. Agents can read logs, wait for specific output, take screenshots, and type into the process. Humans can attach to the same session at any time to see exactly what the agent sees, interact with the process, then detach and let the agent continue. Both share the same terminal state.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ package.json: "dev": "tuistory -- next dev"                                            │
│                                                                                        │
│ Human runs `pnpm dev`             Agent runs `pnpm dev`                                │
│       │                                 │                                              │
│       ▼                                 ▼                                              │
│ ┌────────────────┐             ┌─────────────────────────────────────┐                 │
│ │ Auto-attaches  │             │ Session starts in background        │                 │
│ │ to the terminal│             │                                     │                 │
│ │ (like running  │             │ If already running:                 │                 │
│ │  next dev      │             │   "next dev already running.        │                 │
│ │  directly)     │             │    read with: tuistory read -s …"   │                 │
│ └────────────────┘             │                                     │                 │
│                                │ Agent can then:                     │                 │
│                                │   tuistory read -s myapp-next-dev   │                 │
│                                │   tuistory -s … wait "ready"        │                 │
│                                │   tuistory -s … snapshot --trim     │                 │
│                                └─────────────────────────────────────┘                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Add tuistory to your dev script

The simplest way to use tuistory: replace your `dev` command in `package.json`.

```json
{
  "scripts": {
    "dev": "tuistory -- next dev"
  }
}
```

The session name is auto-derived from `<cwd-basename>-<command>` in kebab-case. A project in `~/myapp` running `next dev` gets session name `myapp-next-dev`.

That's it. This one change gives you three things:

1. **Humans get the same experience.** `pnpm dev` auto-attaches your terminal to the session. It looks and feels identical to running `next dev` directly. Press `Ctrl+C` to detach (the session keeps running in the background).

2. **Agents don't hang.** Without tuistory, an agent running `pnpm dev` starts a long-lived process that blocks its tool call until timeout. With tuistory, the dev server launches in the background and the command returns immediately. The agent can move on to other work.

3. **Agents can inspect the server.** Once the session exists, agents read logs, wait for "ready" strings, check for errors, and even type commands into REPLs. All through simple CLI calls that return instantly.

### What agents can do with a running session

```bash
# Read recent output (like checking server logs)
tuistory read -s myapp-next-dev

# Read the entire output buffer
tuistory read -s myapp-next-dev --all

# Wait for the server to be ready (replaces sleep)
tuistory -s myapp-next-dev wait "ready on" --timeout 30000

# Wait for output to stabilize (when you don't know what to expect)
tuistory -s myapp-next-dev wait-idle --timeout 10000

# See the current terminal screen
tuistory -s myapp-next-dev snapshot --trim

# Capture terminal as a PNG image
tuistory -s myapp-next-dev screenshot

# Restart the dev server after code changes
tuistory -s myapp-next-dev restart

# Type into the process (for REPLs, debuggers, interactive CLIs)
tuistory -s myapp-next-dev type "rs"
tuistory -s myapp-next-dev press enter

# Stop the server
tuistory -s myapp-next-dev press ctrl c
tuistory -s myapp-next-dev close
```

### Reuse and idempotency

Running `pnpm dev` again while the session is alive **reattaches** (for humans) or prints session info (for agents) instead of failing. Agents never get "port already in use" errors; they get a message telling them the session is already running and how to read its output.

### Attach to a running session (humans only)

<!-- Agents: do not run tuistory attach. Use read, snapshot, and wait instead. -->

Use `tuistory attach` to connect your terminal to any running session. This works like `tmux attach`: you see the full terminal output exactly as if you ran the command yourself. You can type, scroll, and interact normally. Press `Ctrl+C` to detach without stopping the process.

```bash
# Attach to a specific session
tuistory attach -s myapp-next-dev

# Pick from a list of running sessions
tuistory attach
```

While attached, press `Ctrl+C` twice to **detach** (the process keeps running), or `Ctrl+X` twice to **kill** the process and close the session.

This is useful when an agent started a dev server or a long-running process and you want to see what's happening. `tuistory sessions` lists all active sessions, then `tuistory attach` connects you to one.

## Installation

```bash
npm install tuistory
```

As a global CLI:

```bash
npm install -g tuistory

# Or use directly
npx tuistory --help
bunx tuistory --help
```

## Agent Skill

This package ships a skill file that teaches AI coding agents how and when to
use it. Install it with:

```bash
npx -y skills add remorses/tuistory
```

## CLI Quick Start

A full workflow controlling Claude Code:

```bash
# Launch Claude Code
tuistory -s claude --cols 150 --rows 45 -- claude

# Wait for it to load
tuistory -s claude wait "Claude Code" --timeout 15000

# Type a prompt
tuistory -s claude type "what is 2+2? reply with just the number"
tuistory -s claude press enter

# Wait for the response
tuistory -s claude wait "/[0-9]+/" --timeout 30000

# Get terminal snapshot
tuistory -s claude snapshot --trim

# Read all process output
tuistory read -s claude --all

# Close the session
tuistory -s claude close
```

## CLI Commands

```
tuistory -- <command>         Launch a terminal session
tuistory snapshot             Current terminal screen as text
tuistory read                 Process output since last read
tuistory screenshot           Capture terminal as PNG image
tuistory type <text>          Type text character by character
tuistory press <key> [keys]   Press key(s): enter, ctrl c, alt f4
tuistory click <pattern>      Click on text matching pattern
tuistory wait <pattern>       Wait for text (supports /regex/)
tuistory wait-idle            Wait for terminal to stabilize
tuistory scroll <up|down>     Scroll the terminal
tuistory resize <cols> <rows> Resize terminal
tuistory attach               Attach interactively to a session (humans only)
tuistory restart              Restart session (same command/cwd/env)
tuistory close                Close a session
tuistory sessions             List active sessions
```

### Common Options

```
-s, --session <name>  Session name (defaults to <cwd-basename>-<command>)
--cols <n>            Terminal columns (default: 120)
--rows <n>            Terminal rows (default: 36)
--env <key=value>     Environment variable (repeatable)
--timeout <ms>        Wait timeout in milliseconds
--trim                Trim whitespace from snapshot
--json                Output as JSON
--all                 For read: return entire buffer
--follow              For read: block until new output
```

### Option ordering with `--`

Everything after `--` is the command to run. tuistory options **must come before** `--`, not after it. Anything after `--` is passed verbatim to the child process.

```bash
# Correct: options before --, command after
tuistory -s myserver --cols 150 -- node server.js --port 3000

# Wrong: tuistory options after -- are ignored
tuistory -- node server.js -s myserver --cols 150
```

When no `-s` is given, the session name is auto-derived from `<cwd-basename>-<command>` in kebab-case. For most use cases (especially `package.json` scripts) you don't need to pass `-s` at all.

## Background Processes (replaces tmux)

tuistory replaces tmux for running background processes. The key advantage: **reactive waiting** instead of blind `sleep`.

### Before: tmux

```bash
tmux new-session -d -s dev
tmux send-keys -t dev "pnpm dev" Enter
sleep 5  # blind guess
tmux capture-pane -t dev -p | grep "ready"
tmux send-keys -t dev C-c
tmux kill-session -t dev
```

`sleep 5` is a blind guess. Too short and the server isn't ready. Too long and you waste time. `capture-pane` only shows the last screenful.

### After: tuistory

```bash
tuistory -- pnpm dev
tuistory -s myapp-pnpm-dev wait "ready on" --timeout 30000
tuistory read -s myapp-pnpm-dev
tuistory -s myapp-pnpm-dev press ctrl c
tuistory -s myapp-pnpm-dev close
```

`wait` reacts as fast as the terminal updates (~75ms). `read` returns the full output stream, not just the visible screen.

## Environment Inheritance

tuistory forwards the **full environment** from the calling shell to child processes. `node_modules/.bin` entries injected by pnpm, bun, and npm are preserved, so local binaries work without prefixing:

```bash
# These work because tuistory inherits the caller's PATH
tuistory -- vitest run
tuistory -- tsc --noEmit
```

Explicit `--env` flags override inherited values:

```bash
tuistory --env NODE_ENV=production -- my-server
```

## Tips for Automation

**Run `snapshot` after every action.** Terminal apps are stateful and may show dialogs or errors. Always check the current state:

```bash
tuistory -s mysession press enter
tuistory -s mysession snapshot --trim
```

**Use `read` for log-heavy processes.** `snapshot` only shows the visible screen. `read` gives you the full output stream:

```bash
tuistory -- npm test
tuistory -s myapp-npm-test wait "Tests:" --timeout 60000
tuistory read -s myapp-npm-test
```

**Use `wait-idle` when you don't know what to wait for.** It waits until the terminal stops receiving data (~60ms of silence):

```bash
tuistory -- npm test
tuistory -s myapp-npm-test wait-idle --timeout 10000
tuistory read -s myapp-npm-test
```

**Use `wait` for async operations.** Don't assume commands complete instantly:

```bash
tuistory -s mysession type "long-running-command"
tuistory -s mysession press enter
tuistory -s mysession wait "Done" --timeout 60000
```

## Daemon Architecture

tuistory runs a background **relay daemon** that holds all sessions in memory. The first CLI command auto-starts it; subsequent commands connect to the existing one.

### Auto-restart on version upgrade

When you upgrade tuistory, the next CLI command detects the version mismatch and **automatically restarts the daemon**.

```
┌───────────────┐     GET /version     ┌────────────────┐
│  CLI v1.5.0   │ ──────────────────►  │ Daemon v1.4.0  │
│               │ ◀──────────────────  │                │
│               │   { version: 1.4.0 } │                │
│               │                      │                │
│  v1.5 > v1.4  │                      │                │
│  ► kill old   │ ─── SIGTERM ──────►  │    (dies)      │
│  ► spawn new  │                      └────────────────┘
│               │                      ┌────────────────┐
│               │ ─── spawn ────────►  │ Daemon v1.5.0  │
│               │    poll /version     │                │
│               │ ◀── { version: 1.5 } │                │
│  ► proceed    │                      │   (ready)      │
└───────────────┘                      └────────────────┘
```

The restart is **race-safe**: a file lock prevents two concurrent CLI invocations from both trying to restart. The daemon only restarts when the CLI version is **newer** than the running daemon.

### Manual daemon control

```bash
tuistory daemon-stop    # Stops daemon and closes all sessions
tuistory log-path       # Print the daemon log file path
```

## Library Usage (Playwright for terminals)

Use tuistory programmatically in tests or scripts:

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
  ╭────────────────────────────────────────────────────────────────────────╮
  │ Welcome to Claude Code                                                │
  ╰────────────────────────────────────────────────────────────────────────╯
  "
`)

await session.type('/help')
await session.press('enter')

const output = session.read()
const allOutput = session.readAll()

await session.press(['ctrl', 'c'])
session.close()
```

## Library API

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

Press a single key or a chord.

```ts
await session.press('enter')
await session.press('tab')
await session.press(['ctrl', 'c'])
await session.press(['ctrl', 'shift', 'a'])
```

**Keys:** `enter`, `esc`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`

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

Read new process output since the last `read()` call. Returns clean text with ANSI codes stripped.

```ts
const newOutput = session.read()
const allOutput = session.readAll()
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

- [Termcast](https://github.com/remorses/termcast): A Raycast API re-implementation for the terminal. Agents use tuistory to autonomously convert Raycast extensions into TUIs.
- [Kimaki](https://github.com/remorses/kimaki): Discord bot agents that use tuistory to control TTY processes like opencode, claude code and debuggers.

## License

MIT
