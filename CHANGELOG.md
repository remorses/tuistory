# Changelog

## 0.6.0

1. **Auto-attach in TTY mode** — `tuistory launch` now automatically attaches to the session when running in an interactive terminal. Agents and non-TTY environments still get the session running in the background. The `--attach` flag is deprecated (kept as a hidden no-op for backwards compatibility).

2. **Session reuse instead of duplicate errors** — launching with a name that already exists no longer fails. If the session is alive, tuistory reports it's already running and shows the command, cwd, and how to read its output. In TTY mode it attaches to the existing session:

   ```bash
   tuistory launch "pnpm dev" -s dev
   # later...
   tuistory launch "pnpm dev" -s dev
   # → Session "dev" already running
   ```

3. **`wait` returns match context** — instead of printing just "OK", `wait` now returns ~20 lines around the first matching line (10 before, 10 after). Agents can extract URLs, codes, or prompts from the match context without running a separate `read`:

   ```bash
   tuistory -s login wait "/https?:\/\//i" --timeout 15000
   # prints the lines surrounding the URL match
   ```

4. **Security: block browser-origin and DNS-rebinding requests** — the relay daemon now rejects any request with an `Origin` header (browsers always send it; legitimate CLI clients never do), mismatched `Host` headers (blocks DNS rebinding), and cross-site `Sec-Fetch-Site` values. This prevents a malicious webpage from sending commands to the local daemon.

5. **Exit info in `read` output** — when a session's process has exited, `read` appends `[process exited with code N]` to the output. JSON mode includes `dead` and `exitCode` fields. Agents no longer need a separate check to know the process is done.

6. **Better default session names** — session names now default to `<cwd-basename>-<command>` in kebab-case instead of using the raw command string. For example, launching `pnpm dev` from a folder called `my-app` creates session `my-app-pnpm-dev`.

7. **Caller environment inheritance** — child processes now inherit the full environment from the caller's shell (including `PATH` with `node_modules/.bin` entries injected by pnpm/bun). Explicit `--env` flags still override inherited values.

8. **Improved attach UX** — the status bar turns red when the process exits, showing exit code and signal. Single Ctrl+C detaches from a dead process (no double-press needed). The session picker now shows dead sessions marked with `(exited)`, cwd, and truncated command.

9. **Stale session eviction** — dead sessions older than 24 hours are automatically cleaned up on the next `launch`, preventing unbounded memory growth in long-running daemons.

10. **Screenshots are now PNG only** — removed `--format` and `--quality` options. Screenshots always output PNG, which is lossless and what most tools expect.

## 0.5.0

1. **New `restart` command** — gracefully stop and relaunch a session preserving its original command, working directory, terminal dimensions, and environment variables:

   ```bash
   # Restart a dev server
   tuistory -s dev restart

   # Custom timeout for slow shutdown (default 5s)
   tuistory -s dev restart --timeout 10000
   ```

   The shutdown flow sends SIGINT (Ctrl+C) first, waits up to `--timeout` ms, then escalates to SIGTERM if the process ignores the signal. Already-dead sessions skip the signal phase and relaunch immediately.

2. **Dead sessions no longer block new launches** — if a session with the same name already exited, `tuistory launch` now automatically cleans it up and reuses the name. Previously you had to manually close the dead session before launching again.

3. **`sessions --json` returns `[]` for empty session lists** — the `--json` flag now works correctly when there are no active sessions, returning valid JSON instead of the human-readable "No active sessions" string. Thanks @shpoont for #3!

4. **Bumped `kill-port-process` to 4.x** — removes the older vulnerable transitive dependency chain. Thanks @shpoont for #4!

## 0.4.1

1. **Fixed bare command alias requiring a positional argument** — you can now pass all launch options before `--` without the parser complaining about a missing command:

   ```bash
   tuistory --attach -s my-session -- printf hello
   ```

   Previously this would fail because `<command>` was mandatory; now it's optional since the real command comes after `--`.

## 0.4.0

1. **New `--` syntax for launch** — pass commands after `--` for reliable argument handling, especially for commands with flags or spaces. This is now the recommended style for scripts and AI agents:

   ```bash
   # New preferred syntax
   tuistory -s claude --cols 150 --rows 45 -- claude
   tuistory -s dev -- pnpm dev
   tuistory -s test -- npm test

   # Old style still works
   tuistory launch "pnpm dev" -s dev
   ```

   Using `--` avoids quoting issues and correctly handles commands whose arguments start with `-`.

2. **Bare command syntax** — you can now omit `launch` entirely and pass the command directly:

   ```bash
   tuistory -s dev -- bun run dev
   tuistory -s claude -- claude
   ```

   Both `tuistory launch -- cmd` and `tuistory -- cmd` now work identically.

3. **Improved duplicate session error** — when a session with the same name already exists, the error now shows the existing session's command, working directory, and a ready-to-run `read` command to inspect it:

   ```
   Session "dev" already exists.
   Existing session:
     command: pnpm dev
     cwd: /Users/me/myapp
     read: tuistory read -s dev --all
   ```

4. **Better nested session guidance** — when `tuistory launch` is refused inside a running session, the error now shows the attempted command and actionable advice for AI agents:

   ```
   Refusing to launch a nested tuistory session inside "outer-session".

   Attempted tuistory command:
     tuistory launch 'echo nope' -s nested

   The command you launched is already running inside its own tuistory session.
   The script will start the tuistory session itself in the background.
   ```

5. **Silent `--attach` skip for AI agents** — when `--attach` is set and tuistory detects it is running inside an AI agent, the process now exits cleanly without printing a warning message to stderr.

## 0.3.0

1. **New `launch --attach` mode for package scripts** — start a named tuistory session and immediately attach your terminal when a human runs the command, while AI agents skip the interactive attach and leave the session running for inspection:

   ```bash
   tuistory launch "bun dev" -s dev --attach
   tuistory read -s dev --all
   tuistory snapshot -s dev --trim
   ```

   Launched processes now receive `TUISTORY_SESSION`, and nested `tuistory launch` calls are refused so you do not accidentally create a session inside another session.

2. **Launch sessions now default to the command name** — `tuistory launch "bun dev"` creates a session named `bun dev` instead of `default`, so ad-hoc sessions and package scripts show useful names without requiring `-s`.

3. **New `daemon-stop` command** — stop a stale relay daemon from the client, including older daemons that cannot parse newer relay commands:

   ```bash
   tuistory daemon-stop
   ```

4. **Improved `sessions` output** — the default `tuistory sessions` view is now a YAML-like list with names, status, command, cwd, columns, and rows. Use `--json` when scripts need machine-readable output.

5. **Simpler attach shortcuts** — inside `tuistory attach`, press `Ctrl+C` twice to detach or `Ctrl+X` twice to kill the session. Single key presses still pass through to the running program.

## 0.2.1

1. **Fixed `launch` using wrong working directory through the relay** — when you run `tuistory launch` from a project directory, the process now starts in that directory instead of the relay's startup directory. The CLI forwards your current working directory to the daemon so launched processes respect the caller's context.

2. **More robust screenshot file writes** — screenshot file writes now use the goke runtime context filesystem, avoiding global process state mutations inside the daemon.

## 0.2.0

1. **New `read --trim` flag** — trim trailing whitespace and empty lines from read output. Useful for cleaner snapshots without post-processing:

   ```bash
   tuistory read -s myapp --trim
   ```

2. **New `sessions --json` flag** — output session metadata as JSON for scripting:

   ```bash
   tuistory sessions --json | jq '.[] | select(.dead == false)'
   ```

   Each entry includes `name`, `command`, `cwd`, `cols`, `rows`, and `dead` fields.

3. **Enhanced `sessions` output** — the default `sessions` command now shows each session's command, working directory, and alive/dead status with color coding, instead of just listing names.

4. **Fixed relay crashes on invalid forwarded commands** — the daemon no longer crashes when a CLI command with invalid options is forwarded through the relay. Invalid commands now return structured error results instead of killing the relay process.

5. **Better error diagnostics on relay failures** — when the relay fails to start or times out, the last 15 lines of the relay log are printed to stderr so you can diagnose the issue without manually opening the log file.

## 0.1.0

1. **New `read` command** — access full process output, not just the visible screen. `snapshot` only shows what fits on the terminal viewport (e.g. 36 lines). `read` returns everything the process printed since the last call, with ANSI escape codes stripped, from a 1MB ring buffer:

   ```bash
   # New output since last read
   tuistory read -s mysession

   # Entire buffered output
   tuistory read -s mysession --all

   # Block until new output arrives
   tuistory read -s mysession --follow --timeout 30000
   ```

   Library API:

   ```ts
   const newOutput = session.read()   // new since last read
   const allOutput = session.readAll() // entire buffer (up to 1MB)
   ```

2. **New `attach` command** — reconnect to a running session in a fullscreen terminal UI. Replay buffered PTY output, stream new data live, and forward keyboard input via WebSocket:

   ```bash
   # Attach to a specific session
   tuistory attach -s mysession

   # Attach interactively (pick from running sessions)
   tuistory attach
   ```

   Includes clickable Detach and Kill buttons in the status bar, and uses `@clack/prompts` for session selection when multiple sessions are running.

3. **Replaced node-pty with zigpty** — no more C++ compilation or node-gyp at install time. zigpty ships prebuilt Zig binaries for all platforms, is 350x smaller (43 KB vs 15.5 MB), and is an API-compatible drop-in replacement.

4. **Fixed daemon crashes from dead PTY processes** — the daemon no longer crashes or hangs when a spawned process exits. All write operations now throw a clear error if the process is dead instead of silently failing. Pending `waitForText`, `waitIdle`, and `waitForData` promises resolve immediately when the process exits instead of hanging forever.

5. **Graceful daemon shutdown** — `server.close()` now properly completes before `process.exit()`, preventing dropped in-flight HTTP responses.

## 0.0.16

- Add `--padding <cells>` flag to `screenshot` command — frame padding in terminal cells (default: 2), converted to pixels based on font size
- Add `--frame-color <color>` flag to `screenshot` command — sets the frame/padding area color; when omitted, auto-detected from terminal edge cells to match the app's background
- Fix UTF-8 multi-byte character decoding across PTY data chunks using streaming `TextDecoder` — prevents garbled output for non-ASCII characters at chunk boundaries
- Fix PTY tail flush on subprocess exit so the final bytes of output are always captured

## 0.0.15

- Add `--pixel-ratio <n>` flag to `screenshot` command for HiDPI rendering (use `--pixel-ratio 2` for sharp images on social media and messaging apps)
- Increase default terminal cols/rows while preserving 10:3 aspect ratio for better readability
- Fix: clean up auto termcast sqlite files on session close to prevent leftover temp files
- Fix: harden daemon against session loss from restarts and crashes
- Fix: isolate test daemon from user sessions via `TUISTORY_PORT` env var to prevent test runs from killing active sessions
- Refactor CLI error handling to use errore (errors as values pattern)

## 0.0.14

- Add `screenshot` CLI command that renders the terminal buffer to a JPEG/PNG/WebP image — useful for AI agents to capture TUI screenshots and share them via messaging apps
- Fix screenshot test ANSI rendering on macOS by using `bash -c printf` instead of `/bin/echo -e`
- Stabilize `Session.text()` snapshots to reduce flakiness in tests
- Downgrade `node-pty` to `0.10.1` to fix `posix_spawnp` errors on some systems
- Expose `getTerminalData()` on `Session` for raw terminal buffer access
- Add SKILL.md — agent guide for using tuistory programmatically

## 0.0.13

- Replaced CLI framework `cac` with `goke` for better type safety and help messages
- Added detailed examples to all CLI commands
- Improved help output with formatted descriptions

## 0.0.12

- Add configurable cursor snapshots with `showCursor` option on `Session.text()` and `launch` options
- Change cursor marker to `█` for clearer visual snapshots when enabled
- Make cursor hidden by default in library snapshots and add CLI `snapshot --no-cursor` flag
- Pin `node-pty` to `0.10.1` for more stable Node PTY behavior
- Add isolated `TERMCAST_DB_SUFFIX` env per session to avoid shared DB collisions in parallel runs

## 0.0.11

- Fix ghostty-opentui dependency version (was incorrectly resolved to 1.3.12)

## 0.0.10

- Added cursor indicator (`⎸`) to snapshot output showing cursor position
- Only show cursor when terminal reports it as visible (DECTCEM mode)
- Fixed cursor Y position by adjusting for scrollback offset
- Updated ghostty-opentui to 1.3.13 (cursor scrollback fix)
- Use bun instead of tsx for daemon spawn to fix module resolution

## 0.0.9

- Added validation for invalid keys in `press` command with helpful error message listing valid keys
- Refactored key types to use `as const` arrays so types and validation are always in sync

## 0.0.8

- Added cac-based CLI with daemon architecture for persistent sessions
- Replaced bun-pty with Bun's built-in spawn terminal for better compatibility
- Added CLI integration tests for launch, snapshot, type, press, wait, and close commands
- Added Node REPL and debugger example tests
- Updated README with comprehensive CLI examples and tips for successful automation
- Fixed tsconfig types configuration

## 0.0.7

- Updated ghostty-opentui to 1.3.12 (fixes tab expansion issues)

## 0.0.6

- Pin bun-pty to version 0.4.3 for consistent builds

## 0.0.5

- Make `press()` method type-safe with explicit `Key` type union
- Export `Key` type for external use
- Organized key types into `Letter`, `Digit`, `SpecialKey`, `Modifier`, `Punctuation` subtypes
- Removed `| string` escape hatch that allowed any string

## 0.0.4

- Fix ANSI escape sequences appearing in text output (now handled correctly by ghostty-opentui 1.3.7)
- Remove aggressive regex workaround in `cleanupText()` that was stripping legitimate text
- Buffer PTY data before callback registration to prevent data loss on fast-starting processes
- Increase idle timeout to 60ms for better TUI render stabilization
- Add `waitForDataTimeout` option to `launchTerminal()`
- Updated ghostty-opentui to 1.3.7

## 0.0.3

- Added `waitForData()` method for explicit PTY data waiting
- Added `waitForData` option to `launchTerminal()` for skipping initial wait
- Reduced idle timer from 50ms to 20ms for faster tests
- Reduced type delay from 5ms to 1ms per character
- Fixed `waitIdle()` to have minimum 20ms wait when no timer active
- Added `closed` flag to prevent errors after session close
- Inherit `process.env` in spawned processes
- Better error messages: `text()` throws with terminal content on timeout
- Added bun-types and vitest globals support
- Updated ghostty-opentui to 1.3.6

## 0.0.2

- Optimized `type()` method performance: reduced per-character delay from 50ms to 5ms
- Reduced `write()` delay from 50ms to 10ms
- Tests now run 8x faster (~4s vs ~32s)

## 0.0.1

- Initial release
