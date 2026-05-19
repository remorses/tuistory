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

## always use bun, never tsx

always use `bun` to run typescript files, never `tsx`. the cli daemon spawns using `process.execPath` so it uses the same runtime. using tsx can cause issues with wrong module resolution paths.
