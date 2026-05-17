---
name: tuistory
description: |
  tmux for AI agents. Run dev servers and TUIs in named background sessions that agents can read, wait on, snapshot, and type into. Replaces tmux with reactive waiting instead of blind `sleep`. Projects wrap their dev script with tuistory (`"dev": "tuistory -- next dev"`) so agents get a background session and humans get auto-attached.

  Use tuistory when you need to:
  - Run background dev servers or long-lived processes
  - Control interactive CLIs and TUIs (type, press keys, click, wait, snapshot)
  - Write Playwright-style tests for terminal apps

  **CLI** (`tuistory`) for background sessions. **JS/TS API** (`launchTerminal`) for programmatic control and tests.
---

# tuistory

Run dev servers and terminal commands that AI agents can read, wait on, and type into. Wrap any command in a named background session. Humans get auto-attached; agents get a session they can inspect with `read`, `snapshot`, `wait`, and `type`.

Prefer tuistory over `tmux` for agent automation. It reacts to terminal output with `wait` and `wait-idle` instead of wasting time on blind `sleep` calls. That makes scripts both faster and more reliable.

Every time you use tuistory, you MUST run these two commands first. NEVER pipe to head/tail, read the full output:

```bash
# CLI help — source of truth for commands, options, and syntax
tuistory --help

# Full README with API docs, examples, and testing patterns
curl -s https://raw.githubusercontent.com/remorses/tuistory/refs/heads/main/README.md
```

## Dev script pattern

When a project has `"dev": "tuistory -- next dev"` in package.json, running `pnpm dev` gives agents a background session. The session name is auto-derived from `<cwd-basename>-<command>` in kebab-case. If the session is already running, agents get a message like:

```
Session "myapp-next-dev" already running
  with command: `next dev`
  read output with: `tuistory read -s x --all`
```

Agents can then use `tuistory read -s x`, `tuistory -s x wait "ready"`, etc. to inspect the running process.

## Key rules

- **Options before `--`, command after.** Everything after `--` is passed verbatim to the child process. `tuistory -s myserver --cols 150 -- node server.js` is correct. `tuistory -- node server.js -s myserver` is wrong.
- Session names are auto-derived from `<cwd-basename>-<command>`. You usually don't need `-s` when launching.
- Always run `snapshot --trim` after every CLI action to see the current terminal state
- Always set a timeout on `waitForText` for async operations
- String patterns are case-sensitive by default. Use regex like `/ready/i` when casing may vary.
- Use `trimEnd: true` in `session.text()` to avoid trailing whitespace in snapshots
- Close sessions in test teardown to avoid leaked processes
- Use `--cols` and `--rows` to control terminal size, they affect TUI layout
- Use `--pixel-ratio 2` for sharp screenshot images

## Feedback loop

Use an **observe → act → observe** loop, like Playwright but for terminals.

### Background process instead of tmux

```bash
# start a server in the background (session name auto-derived)
tuistory -- bun run dev

# wait for actual output instead of sleep 5
# use regex so this still matches Ready, READY, etc.
tuistory -s x wait "/ready/i" --timeout 30000

# read everything the process printed
tuistory read -s x

# later, read only the new output
tuistory read -s x

# restart the server (sends Ctrl+C, waits, relaunches same command/cwd/env)
tuistory -s x restart
```

Why this is better than `tmux`:

- no blind `sleep`
- reacts as soon as output appears
- faster when apps start quickly
- more reliable when apps start slowly

### Interactive TUI loop

```bash
# observe
tuistory -s app snapshot --trim

# act
tuistory -s app press enter

# observe again
tuistory -s app snapshot --trim
```

### Test loop with JS/TS API

```ts
const session = await launchTerminal({ command: 'my-cli', cols: 120, rows: 36 })

const initial = await session.text({ trimEnd: true })
expect(initial).toMatchInlineSnapshot()

await session.type('hello')
await session.press('enter')

const output = await session.waitForText('hello', { timeout: 5000 })
expect(output).toMatchInlineSnapshot()

session.close()
```
