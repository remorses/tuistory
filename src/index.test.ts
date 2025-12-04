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

test('opencode ctrl+p', async () => {
  const session = await launchTerminal({
    command: 'opencode',
    args: [],
    cols: 80,
    rows: 24,
  })

  await session.waitForText('opencode', { timeout: 10000 })

  await session.press(['ctrl', 'p'])

  const text = await session.text()
  expect(text).toMatchInlineSnapshot(`
    "




                                                        ▄
                       █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█

                Commands                                         esc

                Search

     ┃          Session
     ┃  Buil    Open editor                                 ctrl+x e
     ┃          Switch session                              ctrl+x l
     ┃  Buil    New session                                 ctrl+x n
     ╹▀▀▀▀▀▀                                                            ▀▀▀▀▀▀▀▀
                Agent                                                   commands





    ~/Documents/GitHub/termcast/tuistory:main  ⊙ 1 MCP /status"
  `)

  await session.press(['ctrl', 'c'])
  session.close()
}, 15000)
