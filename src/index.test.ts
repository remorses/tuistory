/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import { launchTerminal } from './index.js'

test('echo command', async () => {
  const session = await launchTerminal({
    command: 'echo',
    args: ['hello world'],
    cols: 40,
    rows: 10,
  })

  const text = await session.text()
  expect(text).toMatchInlineSnapshot(`
    "
    hello world








    "
  `)

  session.close()
}, 10000)

test('cat interactive', async () => {
  const session = await launchTerminal({
    command: 'cat',
    args: [],
    cols: 40,
    rows: 10,
    waitForData: false,
  })

  await session.type('hello')
  await session.press('enter')

  const text = await session.waitForText('hello', { timeout: 5000 })
  expect(text).toMatchInlineSnapshot(`
    "
    hello
    hello







    "
  `)

  await session.press(['ctrl', 'c'])
  session.close()
}, 10000)

test('bash with commands', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  await session.type('echo "testing tuistory"')
  await session.press('enter')

  const text = await session.text()
  expect(text).toMatchInlineSnapshot(`
    "
    $ echo "testing tuistory"
    testing tuistory
    $






    "
  `)

  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)

test('waitForText with string', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  await session.type('echo "hello world"')
  await session.press('enter')

  const text = await session.waitForText('hello world')
  expect(text).toMatchInlineSnapshot(`
    "
    $ echo "hello world"
    hello world
    $






    "
  `)

  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)

test('waitForText with regex', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  await session.type('echo "number 42"')
  await session.press('enter')

  const text = await session.waitForText(/number \d+/)
  expect(text).toMatchInlineSnapshot(`
    "
    $ echo "number 42"
    number 42
    $






    "
  `)

  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)

test('click fails with multiple matches', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  await session.type('echo "aaa bbb aaa"')
  await session.press('enter')
  await session.waitForText('aaa bbb aaa')

  await expect(session.click('aaa')).rejects.toThrow(/found \d+ matches/)

  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)

test('click with first option', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  await session.type('echo "aaa bbb aaa"')
  await session.press('enter')
  await session.waitForText('aaa bbb aaa')

  await session.click('aaa', { first: true })

  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)

test('click with unique text', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  await session.type('echo "uniquetext123"')
  await session.press('enter')
  await session.waitForText('uniquetext123')

  await session.click('uniquetext123', { first: true })

  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)

test('opencode interactions', async () => {
  const session = await launchTerminal({
    command: 'opencode',
    args: [],
    cols: 100,
    rows: 30,
  })

  await session.waitForText('switch agent', { timeout: 15000 })
  await session.type('hello from tuistory')
  const initialText = await session.text({ timeout: 1000 })
  expect(initialText).toMatchInlineSnapshot(`
    "








                                                                  ▄
                                 █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
                                 █░░█ █░░█ █▀▀▀ █░░█ █░░░ █░░█ █░░█ █▀▀▀
                                 ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀


               ┃
               ┃  hello from tuistory
               ┃
               ┃  Build  Claude Opus 4.5 (latest) Anthropic
               ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                                                         tab switch agent  ctrl+p commands








    ~/Documents/GitHub/termcast/tuistory:HEAD                                                1.0.147"
  `)

  await session.press(['ctrl', 'x'])
  await session.press('m')

  const modelsText = await session.waitForText(/anthropic|claude|gpt|gemini/i, { timeout: 5000 })
  expect(modelsText).toMatchInlineSnapshot(`
    "









                          Select model                                     esc

                          Search

                          Recent
               ┃        ● Claude Opus 4.5 (latest) Anthropic
               ┃  hell    Claude Sonnet 4.5 (latest) Anthropic
               ┃          Gemini 3 Pro Preview Google
               ┃  Buil    Claude Opus 4 (latest) Anthropic
               ╹▀▀▀▀▀▀                                                            ▀▀▀▀▀▀▀▀
                          OpenCode Zen                                            commands
                          Big Pickle                                      Free
                          Grok Code Fast 1                                Free


                          Connect provider ctrl+a  Favorite ctrl+f



    ~/Documents/GitHub/termcast/tuistory:HEAD                                                1.0.147"
  `)

  await session.press('esc')

  await session.press(['ctrl', 'p'])
  const commandsText = await session.waitForText('Commands', { timeout: 5000 })
  expect(commandsText).toMatchInlineSnapshot(`
    "









                          Commands                                         esc

                          Search

                          Suggested
               ┃          Switch session                              ctrl+x l
               ┃  hell    Switch model                                ctrl+x m
               ┃
               ┃  Buil    Session
               ╹▀▀▀▀▀▀    Open editor                                 ctrl+x e    ▀▀▀▀▀▀▀▀
                          Switch session                              ctrl+x l    commands
                          New session                                 ctrl+x n







    ~/Documents/GitHub/termcast/tuistory:HEAD  ⊙ 1 MCP /status                               1.0.147"
  `)

  await session.press('down')
  await session.press('down')
  const navigatedText = await session.text({ timeout: 1000 })
  expect(navigatedText).toMatchInlineSnapshot(`
    "









                          Commands                                         esc

                          Search

                          Suggested
               ┃          Switch session                              ctrl+x l
               ┃  hell    Switch model                                ctrl+x m
               ┃
               ┃  Buil    Session
               ╹▀▀▀▀▀▀    Open editor                                 ctrl+x e    ▀▀▀▀▀▀▀▀
                          Switch session                              ctrl+x l    commands
                          New session                                 ctrl+x n







    ~/Documents/GitHub/termcast/tuistory:HEAD  ⊙ 1 MCP /status                               1.0.147"
  `)

  await session.press('esc')

  const backText = await session.waitForText('switch agent', { timeout: 5000 })
  expect(backText).toMatchInlineSnapshot(`
    "








                                                                  ▄
                                 █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
                                 █░░█ █░░█ █▀▀▀ █░░█ █░░░ █░░█ █░░█ █▀▀▀
                                 ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀


               ┃
               ┃  hello from tuistory
               ┃
               ┃  Build  Claude Opus 4.5 (latest) Anthropic
               ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                                                         tab switch agent  ctrl+p commands








    ~/Documents/GitHub/termcast/tuistory:HEAD  ⊙ 1 MCP /status                               1.0.147"
  `)

  session.close()
}, 30000)

test('claude launch', async () => {
  const session = await launchTerminal({
    command: 'claude',
    args: [],
    cols: 60,
    rows: 30,
  })

  const text = await session.waitForText(/Claude|claude/i, { timeout: 15000 })
  expect(text).toMatchInlineSnapshot(`
    "

    ────────────────────────────────────────────────────────────
     Do you trust the files in this folder?

     /Users/morse/Documents/GitHub/termcast/tuistory

     Claude Code may read, write, or execute files contained in
      this directory. This can pose security risks, so only use
      files and MCP servers from trusted sources.

     Execution allowed by:

       • .mcp.json (framer)

     Learn more

     ❯ 1. Yes, proceed
       2. No, exit

     Enter to confirm · Esc to cancel









    "
  `)
  expect(text.toLowerCase()).toContain('claude')

  await session.press(['ctrl', 'c'])
  session.close()
}, 20000)
