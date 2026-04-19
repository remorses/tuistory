# Changelog

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
