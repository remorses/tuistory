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

## Dev script convention for projects

Projects should wrap their dev server command with `tuistory --` in `package.json` scripts. This ensures agents never hang on an interactive long-lived process, and dev servers started by humans are automatically shared with agents.

```json
{
  "scripts": {
    "dev": "tuistory -- next dev",
    "dev:api": "tuistory -- node api/server.js"
  }
}
```

When a human runs `pnpm dev`, they get auto-attached to the terminal (same experience as running the command directly). When an agent runs `pnpm dev`, the process launches in the background and the command returns immediately. If the session is already running, both humans and agents reuse it instead of fighting over ports.

**Agents MUST never stop or close a session started by another user or agent.** Dev server sessions are shared resources. Only close them when the user explicitly asks to stop the dev server. Default to leaving sessions running. Use `read`, `wait`, and `snapshot` to inspect them without disrupting them.

## Setting up a project to use tuistory

Do this when the user asks to **set up a project for tuistory** (or to make its dev server agent-friendly). It is the same setup used in the Holocron repo: add the dependency, wrap the long-running dev scripts, and document it in `AGENTS.md`.

**The end result is shared dev sessions.** Whoever starts `pnpm dev` first owns one named background session; everyone else joins it instead of spawning a duplicate server.

```
                        pnpm dev
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
   agent starts it                  human starts it
          │                               │
          ▼                               ▼
  background session              auto-attached terminal
  returns immediately             (normal dev experience)
          │                               │
          └──────────────┬────────────────┘
                         ▼
            ONE shared named session
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  human joins &     agent reads logs,  either side sends
  streams logs      waits for "ready"  input / restarts
  live (attach)     (read / wait)      (type / press)
```

So when the **machine** starts the dev server, the **user can join and stream the logs live or send input**, and vice versa. Both collaborate on the same process instead of each running their own.

**Steps:**

1. Add `tuistory` to the project's dev dependencies (or root devDependencies in a monorepo so the binary resolves everywhere):

```bash
pnpm add -D tuistory     # or: bun add -d tuistory
```

2. Wrap dev and long-running commands with `tuistory --` in `package.json` scripts. Keep `tuistory --` on the **outside** of wrappers like `sigillo run` or `kimaki tunnel` (see Passthrough mode below):

```json
{
  "scripts": {
    "dev": "tuistory -- next dev",
    "dev:api": "tuistory -- node api/server.js",
    "dev:worker": "tuistory -- wrangler dev"
  }
}
```

3. Add a dev server section to the project's `AGENTS.md` so other agents know how to use it. Use `pnpm dev` for pnpm projects and `bun dev` for bun projects (check the lock file). Example to add:

```markdown
## dev server

this project uses tuistory for dev server sessions. to start the dev server simply run `pnpm dev` (or `bun dev` for bun projects). this will automatically start a new background session or reuse an existing one if already running. you do not need to use tuistory commands directly.

to restart the dev server after code changes that require a restart:

\`\`\`bash
tuistory -s x restart
\`\`\`

to read the dev server output:

\`\`\`bash
tuistory read -s x
\`\`\`

to wait for the server to be ready:

\`\`\`bash
tuistory -s x wait "/ready|listening/i" --timeout 30000
\`\`\`
```

This way agents treat `pnpm dev` / `bun dev` as a simple command that just works. They don't need to know about tuistory internals unless they need to inspect output or restart.

## Passthrough mode (traforo, sigillo)

When tuistory detects it's running inside **traforo** (`TRAFORO_URL` env var) or **sigillo** (`SIGILLO` env var), it skips the daemon and session management entirely. Instead it spawns the command directly with inherited stdio and forwards signals to the child process group.

This means if your dev script is `"dev": "tuistory -- next dev"` and you wrap it with `kimaki tunnel` or `sigillo run`, tuistory becomes a transparent passthrough. The outer tool controls the process lifecycle.

**Practical consequence:** agents that need a background session for a tunneled dev server must wrap the full command with tuistory themselves, since the inner tuistory (from the dev script) will run in passthrough mode.

```bash
# The inner tuistory (from "pnpm dev") enters passthrough mode because
# kimaki tunnel sets TRAFORO_URL. So you need an outer tuistory for
# background session management:
tuistory -s myapp-dev -- kimaki tunnel -- pnpm dev

# Wait for the tunnel URL to appear
tuistory -s myapp-dev wait "/tunnel/i" --timeout 30000

# Read the output to find the public URL
tuistory read -s myapp-dev
```

Without the outer `tuistory -- ...`, the command would run in the foreground (passthrough mode) and block the agent.

The same applies to sigillo:

```bash
tuistory -s myapp-dev -- sigillo run -- pnpm dev
```

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
