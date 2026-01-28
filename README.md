<div align='center'>
    <br/>
    <br/>
    <h3>tuistory</h3>
    <p>Playwright for terminal user interfaces</p>
    <p>Write end-to-end tests for terminal applications</p>
    <br/>
    <br/>
</div>

## Installation

```bash
bun add tuistory
```

## Usage

```ts
import { launchTerminal } from 'tuistory'

const session = await launchTerminal({
  command: 'claude',
  args: [],
  cols: 100,
  rows: 30,
})

await session.waitForText('claude', { timeout: 10000 })

const initialText = await session.text()
expect(initialText).toMatchInlineSnapshot(`
  "
  ╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ Welcome to Claude Code                                                                           │
  ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  "
`)

await session.type('/help')
await session.press('enter')

const helpText = await session.text()
expect(helpText).toMatchInlineSnapshot(`
  "
   ▐▛███▜▌   Claude Code v2.0.53
  ▝▜█████▛▘  Opus 4.5 · Claude Max
    ▘▘ ▝▝    ~/my-project

  ────────────────────────────────────────────────────────────────────────────────────────────────────
  > Try "create a util logging.py that..."
  ────────────────────────────────────────────────────────────────────────────────────────────────────
  "
`)

await session.press(['ctrl', 'c'])
session.close()
```

## API

### `launchTerminal(options)`

Launch a terminal session.

```ts
const session = await launchTerminal({
  command: 'my-cli',
  args: ['--flag'],
  cols: 80,
  rows: 24,
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

Press a single key or a chord (multiple keys simultaneously).

```ts
await session.press('enter')
await session.press('tab')
await session.press(['ctrl', 'c'])
await session.press(['ctrl', 'shift', 'a'])
```

**Available keys:** `enter`, `esc`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`

**Modifiers:** `ctrl`, `alt`, `shift`, `meta`

### `session.text(options?)`

Get the current terminal text.

```ts
const text = await session.text()

// Filter by style
const boldText = await session.text({ only: { bold: true } })
const coloredText = await session.text({ only: { foreground: '#ff0000' } })
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

- [Termcast](https://github.com/remorses/termcast): A Raycast API re-implementation for the terminal. Turns raycast extensions into TUIs. Agents use tuistory to autonomously convert Raycast extensions into TUIs and fix any missing termcast APIs.
- [Kimaki](https://github.com/remorses/kimaki): Kimaki can use Tuistory to control TTY processes like opencode, claude code and debuggers.

## License

MIT
