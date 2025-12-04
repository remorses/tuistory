import { test, expect } from 'vitest'
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
    hello world"
  `)

  session.close()
}, 10000)

test('cat interactive', async () => {
  const session = await launchTerminal({
    command: 'cat',
    args: [],
    cols: 40,
    rows: 10,
  })

  await session.type('hello')
  await session.press('enter')

  const text = await session.text()
  expect(text).toMatchInlineSnapshot(`
    "
    hello
    hello"
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
    $"
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
    $"
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
    $"
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

test.skip('opencode ctrl+p', async () => {
  const session = await launchTerminal({
    command: 'opencode',
    args: [],
    cols: 100,
    rows: 30,
  })

  await session.waitForText('opencode', { timeout: 10000 })

  const initialText = await session.text()
  expect(initialText).toMatchInlineSnapshot(`
    "







                                                                  ▄
                                 █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
                                 █░░█ █░░█ █▀▀▀ █░░█ █░░░ █░░█ █░░█ █▀▀▀
                                 ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀
                                                                 1.0.132


               ┃
               ┃  Build anything...
               ┃
               ┃15Build  Anthropic Claude Opus 4.5 (latest)
               ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                                                         tab switch agent  ctrl+p commands








    ~/Documents/GitHub/tuistory-new:main  ⊙ 1 MCP /status"
  `)

  await session.press(['ctrl', 'p'])

  const text = await session.text()
  expect(text).toMatchInlineSnapshot(`
    "







                                                                  ▄

                          Commands                                         esc

                          Search

                          Session
               ┃          Open editor                                 ctrl+x e
               ┃  Buil    Switch session                              ;20;20;2
               ┃          New session                                 ctrl+x n
               ┃  Buil
               ╹▀▀▀▀▀▀    Agent                                                   ▀▀▀▀▀▀▀▀
                          Switch model                                ctrl+x m    commands
                          Model cycle                                       f2
                          Model cycle reverse                         shift+f2






    ~/Documents/GitHub/tuistory-new:main  ⊙ 1 MCP /status"
  `)

  await session.press(['ctrl', 'c'])
  session.close()
}, 15000)

test.skip('claude slash command', async () => {
  const session = await launchTerminal({
    command: 'claude',
    args: [],
    cols: 60,
    rows: 30,
  })

  await session.waitForText('claude', { timeout: 10000 })

  const initialText = await session.text()
  expect(initialText).toMatchInlineSnapshot(`
    "
    ╭──────────────────────────────────────────────────────────╮
    │                                                          │
    │ New MCP server found in .mcp.json: framer                │
    │                                                          │
    │ MCP servers may execute code or access system resources. │
    │  All tool calls require approval. Learn more in the MCP  │
    │ documentation                                            │
    │ (https://docs.claude.com/s/claude-code-mcp).           │
    │                                                          │
    │ ❯ 1. Use this and all future MCP servers in this project │
    │   2. Use this MCP server                                 │
    │   3. Continue without using this MCP server              │
    │                                                          │
    ╰──────────────────────────────────────────────────────────╯
       Enter to confirm · Esc to reject"
  `)

  await session.type('/help')
  await session.press('enter')

  const helpText = await session.text()
  expect(helpText).toMatchInlineSnapshot(`
    "
    ╭─ Claude Code ────────────────────────────────────────────╮
    │                                                          │
    │                   Welcome back Tommy!                    │
    │                                                          │
    │                                                          │
    │                          ▐▛███▜▌                         │
    │                         ▝▜█████▛▘                        │
    │                           ▘▘ ▝▝                          │
    │                                                          │
    │                                                          │
    │                         Opus 4.5                         │
    │                        Claude Max                        │
    │             ~/Documents/GitHub/tuistory-new              │
    │                                                          │
    ╰──────────────────────────────────────────────────────────╯

    ────────────────────────────────────────────────────────────
    > Try "refactor pnpm-lock.yaml"
    ────────────────────────────────────────────────────────────
      ? for shortcuts             Thinking off (tab to toggle)"
  `)

  await session.press(['ctrl', 'c'])
  session.close()
}, 20000)
