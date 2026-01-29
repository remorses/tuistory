this project uses bun to install and test

this package is supposed to run both in node and bun. to test node.js features we use test:node to run the test in node.js too

## running cli locally

use `bun src/cli.ts` instead of tuistory to run the cli locally for testing

## always use bun, never tsx

always use `bun` to run typescript files, never `tsx`. the cli daemon spawns using `process.execPath` so it uses the same runtime. using tsx can cause issues with wrong module resolution paths.
