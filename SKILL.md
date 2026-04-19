---
name: tuistory
description: |
  Playwright for terminal apps. Like tmux but designed for agents — virtual terminals you can
  type into, press keys, wait for text, take snapshots, and screenshot as images.

  tuistory has **2 modes**:

  - **CLI** (`tuistory` command) — shell-based. Launch sessions, type, press keys, snapshot, screenshot.
    Runs a background daemon that persists sessions across commands. Install globally or use `npx`/`bunx`.
    **You MUST run `tuistory --help` before using the CLI** to see the latest commands and options.
  - **JS/TS API** (`import { launchTerminal } from 'tuistory'`) — programmatic. Use in vitest/bun:test
    to write Playwright-style tests for CLIs and TUIs with inline snapshots.

  Use tuistory when you need to:
  - Write e2e tests for CLI/TUI apps (vitest, bun:test) with inline snapshots
  - Automate terminal interactions (launch a REPL, debugger, or TUI and drive it)
  - Screenshot terminal as images to send to users (Discord bots, agent UIs like kimaki/openclaw)
  - Reproduce bugs in interactive CLIs by scripting the exact steps
  - Explore TUI apps progressively with observe-act-observe loops
---

# tuistory

Playwright for terminal user interfaces. Write end-to-end tests for CLI and TUI applications.

Every time you use tuistory, you MUST run these two commands first. NEVER pipe to head/tail, read the full output:

```bash
# CLI help — source of truth for commands, options, and syntax
tuistory --help

# Full README with API docs, examples, and testing patterns
curl -s https://raw.githubusercontent.com/remorses/termcast/refs/heads/main/tuistory/README.md
```

## Key rules

- Always run `snapshot --trim` after every CLI action to see the current terminal state
- Always set a timeout on `waitForText` for async operations
- Use `trimEnd: true` in `session.text()` to avoid trailing whitespace in snapshots
- Close sessions in test teardown to avoid leaked processes
- Use `--cols` and `--rows` to control terminal size — affects TUI layout
- Use `--pixel-ratio 2` for sharp screenshot images
