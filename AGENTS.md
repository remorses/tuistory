this project uses bun to install and test

this package is supposed to run both in node and bun. to test node.js features we use test:node to run the test in node.js too

## running cli locally

use `bun src/cli.ts` instead of tuistory to run the cli locally for testing.

**ALWAYS stop the daemon before manually testing any code change.** the relay daemon is a long-lived background process that keeps the **old compiled code** in memory across CLI invocations. so `bun src/cli.ts launch ...` will silently exercise the previous version of your code, and changes to middleware, route handlers, session logic, CLI flags, parsing, or anything else in the daemon process will appear to be ignored.

run this before every local smoke test:

```bash
bun src/cli.ts daemon-stop
# also stop the test daemon if you've been running the test suite
TUISTORY_PORT=19951 bun src/cli.ts daemon-stop
```

the next `bun src/cli.ts <command>` will spawn a fresh daemon with your updated code.

the test suite already handles this automatically: `src/cli.test.ts` uses port `19951` (separate from the default `19977` so it never touches user sessions) and `killTestDaemon()` runs in `beforeAll` / `afterAll`. that function kills the recorded PID, also kills anything still bound to port `19951` (covers orphans whose PID file was lost), and waits for the port to be free before tests start. you do **not** need to manually stop daemons before running `bun test`; just remember to stop them before manual `bun src/cli.ts ...` invocations.

## relay daemon lifecycle

the CLI is a thin client. all sessions live in a long-lived **relay daemon** (an HTTP + WebSocket server on `127.0.0.1:19977`, override with `TUISTORY_PORT`). the daemon is spawned detached with `stdio: 'ignore'` and `TUISTORY_RELAY=1`. every CLI invocation first runs `ensureRelayRunning()` before forwarding the command to the daemon over `POST /cli`.

**the port is the source of truth, not the `/version` HTTP probe.** a daemon can hold the port while being unable to answer HTTP (wedged event loop, mid-startup, or an orphan whose parent died and left it on `PPID 1`). trusting `/version` alone made the client think "no daemon" and spawn a second one that crashed on bind with `EADDRINUSE`. so `probeRelay()` classifies the port into exactly three states:

```
probeRelay()
   │
   ├─ GET /version answers ─────────────────────► healthy(version)
   ├─ /version silent && port is bindable ──────► no-listener
   └─ /version silent && port is occupied ──────► occupied-unresponsive
```

### ensureRelayRunning flow

every "the daemon is not what we want" case (stale version, wedged, orphan) collapses into ONE kill-and-spawn transition, guarded by a restart-lock file so two concurrent clients can't kill each other's daemons.

```
ensureRelayRunning()
   │
   ├─ probeRelay()
   │     └─ healthy && version >= ours ?  ──────► YES: use it, return (fast path)
   │                                               (a newer daemon is fine; never downgrade)
   ▼ NO
   acquireRestartLock()
   │     ├─ lock NOT acquired (another client is fixing it)
   │     │        └─ waitForRelay(15s) ──► ready ? ─► return │ timeout ─► fail
   │     │
   │     └─ lock acquired ▼
   │         re-probe under lock (winner may have already upgraded it)
   │           └─ healthy && version >= ours ?  ────────► YES: return
   │         ▼ NO
   │         current.kind ?
   │           ├─ healthy (older)        ─► log "version mismatch ... restarting"
   │           ├─ occupied-unresponsive  ─► log "occupied but not answering ... wedged"
   │           └─ no-listener            ─► (skip kill, nothing owns the port)
   │         │
   │         ├─ if not no-listener: killRelay() ──► returns portFreed
   │         │        └─ portFreed === false ? ──► fail (port stuck, do not spawn)
   │         │
   │         ├─ spawnRelayServer()  (detached, TUISTORY_PORT pinned)
   │         └─ waitForRelay(5s, ours) ──► ready ? ─► return  │ timeout ─► fail
   │     finally: releaseRestartLock()
```

key rule: **a healthy daemon at an equal-or-newer version is never killed.** killing the daemon destroys all in-memory PTY sessions, so a version match (or newer) always reuses the running daemon.

### version mismatch / update case

when you publish a new version and run any command with the updated CLI while an OLD daemon is still running:

1. `probeRelay()` returns `healthy(oldVersion)`. `isUsableVersion(oldVersion)` is `oldVersion >= ourVersion`, which is false, so the fast path is skipped.
2. the client takes the restart lock, logs `Relay server version mismatch (server: X, client: Y), restarting...`.
3. `killRelay()` SIGTERMs the old daemon by PID → it runs `gracefulShutdown()`: **closes every session, kills their child process groups, unlinks its PID file**. then a port-kill fallback covers orphans, and it waits for the port to be free.
4. `spawnRelayServer()` starts a fresh daemon on the same port; it writes the PID file only on `listening`.
5. `waitForRelay(5s, ourVersion)` confirms the new daemon answers with the new version, then the command is forwarded.

**updating the daemon wipes running sessions.** this is intentional and unavoidable: sessions live in the old process's memory, and running new code requires killing it. after an update `tuistory sessions` is empty and you relaunch.

direction matters: **old daemon + new CLI ⇒ restart** (new wins); **new daemon + old CLI ⇒ reuse** the newer daemon as-is (never downgrade).

### daemon-stop

`runDaemonStopCommand()` also treats the port as truth: it stops whatever holds the port (via `killRelay()`), and prints `No daemon running` only when `probeRelay()` returns `no-listener`. if the port can't be freed it exits non-zero instead of falsely reporting success.

### startup is bind-safe

`startRelayServer()` builds the server with `createAdaptorServer()` and attaches `error` / `listening` handlers **before** calling `listen()`. `@hono/node-server`'s `serve()` helper binds with no error handler, so a lost bind race used to surface as an unhandled `'error'` event and crash with a confusing `EADDRINUSE` stack. now a daemon that loses the race exits cleanly (code 0); any other listen error exits 1. the PID file is written only after a successful bind and removed only by its owner, so a failed-to-bind daemon can never clobber the real listener's PID file.

## prefer `--` over `launch`

always use `tuistory -- <command>` instead of `tuistory launch "<command>"`. the `--` form is shorter and avoids quoting issues with nested commands. `launch` is a hidden alias for the same thing but `--` is the canonical syntax.

```bash
# good
tuistory -s myapp -- pnpm dev
tuistory -s dev -- kimaki tunnel -- pnpm dev

# avoid
tuistory launch "pnpm dev" -s myapp
tuistory launch "kimaki tunnel -- pnpm dev" -s dev
```

**bun strips `--` from process.argv** ([bun#13984](https://github.com/oven-sh/bun/issues/13984)). when testing locally with `bun src/cli.ts`, use `launch` with a quoted string instead of `--`:

```bash
# local dev testing (bun strips --)
bun src/cli.ts launch 'echo hello world'

# NOT: bun src/cli.ts -- echo hello world
# bun eats -- and only "echo" reaches the CLI, "hello world" is lost
```

the installed `tuistory` binary does not have this issue because it runs as a shebang script.

## always use bun, never tsx

always use `bun` to run typescript files, never `tsx`. the cli daemon spawns using `process.execPath` so it uses the same runtime. using tsx can cause issues with wrong module resolution paths.
