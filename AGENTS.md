this project uses bun to install and test

this package is supposed to run both in node and bun. to test node.js features we use test:node to run the test in node.js too

## running cli locally

use `bun src/cli.ts` instead of tuistory to run the cli locally for testing

after changing CLI flags, commands, or parsing behavior, restart the relay before local manual testing. the daemon keeps the old CLI code loaded, so tests like `bun src/cli.ts launch ...` can look broken until you run `bun src/cli.ts daemon-stop` and let the next command start a fresh relay.

## always use bun, never tsx

always use `bun` to run typescript files, never `tsx`. the cli daemon spawns using `process.execPath` so it uses the same runtime. using tsx can cause issues with wrong module resolution paths.
