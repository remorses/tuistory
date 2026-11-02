/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSession, type Session } from './session.js'

const linuxTest = process.platform === 'linux' ? test : test.skip
const evidenceRoot = process.env.TUISTORY_SESSION_TEST_EVIDENCE_DIR || undefined
const fixtures: Array<{ directory: string; session?: Session }> = []

function fixtureDirectory(label: string): { directory: string; session?: Session } {
  if (evidenceRoot) fs.mkdirSync(evidenceRoot, { recursive: true })
  const fixture = { directory: fs.mkdtempSync(path.join(evidenceRoot ?? os.tmpdir(), `tuistory-session-${label}-`)) }
  fixtures.push(fixture)
  return fixture
}

async function until(check: () => boolean, timeout = 1500): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition did not settle')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function running(pid: number): boolean {
  try {
    const status = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return status.slice(status.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
  } catch { return false }
}

function fixturePid(directory: string, role: 'leader' | 'descendant'): number {
  const pid = Number(fs.readFileSync(path.join(directory, `${role}.pid`), 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid fixture PID')
  return pid
}

async function escapedFixture(mode: 'running' | 'exited' | 'quiet' | 'tail' | 'late', recorded = false) {
  const fixture = fixtureDirectory(`${process.release.name}-${mode}`)
  const { directory } = fixture
  fs.writeFileSync(path.join(directory, 'descendant.sh'), `
trap '' HUP TERM
echo "$$" > descendant.pid
touch descendant.ready
if [ "$1" = late ]; then
  sleep .8
  printf LATE
  touch late.sent
elif [ "$1" = tail ]; then
  sleep .08
  printf TAIL
else
  while [ ! -f release ]; do sleep .01; done
fi
`)
  fs.writeFileSync(path.join(directory, 'leader.sh'), `
echo "$$" > leader.pid
setsid sh "$PWD/descendant.sh" "$1" &
while [ ! -f descendant.ready ]; do sleep .005; done
if [ "$1" != quiet ]; then printf HEAD; fi
if [ "$1" = running ]; then
  while :; do sleep 1; done
fi
exit 7
`)
  const file = path.join(directory, 'session.cast')
  const session = await createSession({
    command: 'sh', args: [path.join(directory, 'leader.sh'), mode], cwd: directory,
    record: recorded ? { path: file } : undefined,
  })
  fixture.session = session
  await until(() => fs.existsSync(path.join(directory, 'descendant.ready')))
  return { directory, file, session, descendant: fixturePid(directory, 'descendant') }
}

function castEvents(file: string): unknown[][] {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(1).map((line) => {
    const event: unknown = JSON.parse(line)
    if (!Array.isArray(event)) throw new Error('Invalid fixture cast event')
    return event
  })
}

function receipt(directory: string, result: object): void {
  if (evidenceRoot) fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
}

afterEach(async () => {
  for (const { directory, session } of fixtures.splice(0)) {
    try { await session?.closeAsync() } catch {}
    for (const role of ['leader', 'descendant'] as const) {
      try {
        const pid = fixturePid(directory, role)
        if (running(pid)) process.kill(pid, 'SIGKILL')
      } catch {}
    }
    try {
      if (session) await until(() => session.isDead)
    } finally {
      if (!evidenceRoot) fs.rmSync(directory, { recursive: true, force: true })
    }
  }
})

linuxTest('plain close synchronously notifies, disposes, and shares its reentrant close', async () => {
  const { directory, session, descendant } = await escapedFixture('running')
  await session.waitForText('HEAD')
  let notified = false
  let readableDuringClose = false
  let reentrant: Promise<void> | undefined
  session.onClosing(() => {
    notified = true
    readableDuringClose = session.getTerminalData().cols === 120
    reentrant = session.closeAsync()
  })
  const start = performance.now()
  session.close()
  expect(notified).toBe(true)
  expect(readableDuringClose).toBe(true)
  expect(() => session.getTerminalData()).toThrow('Terminal has been destroyed')
  expect(() => session.writeRaw('input')).toThrow('session is closed')
  const closing = session.closeAsync()
  expect(reentrant).toBe(closing)
  await closing
  const elapsedMs = performance.now() - start
  expect(elapsedMs).toBeLessThan(750)
  expect(running(descendant)).toBe(true)
  await until(() => session.isDead)
  expect(session.exitInfo).not.toBeNull()
  receipt(directory, { elapsedMs, descendant, dead: session.isDead, exitInfo: session.exitInfo })
})

linuxTest('plain closeAsync resolves while an escaped descendant still holds the slave', async () => {
  const { directory, session, descendant } = await escapedFixture('running')
  await session.waitForData()
  const start = performance.now()
  const closing = session.closeAsync()
  expect(session.closeAsync()).toBe(closing)
  await closing
  const elapsedMs = performance.now() - start
  expect(elapsedMs).toBeLessThan(750)
  expect(running(descendant)).toBe(true)
  receipt(directory, { elapsedMs, descendant })
})

linuxTest('waitForText reports the real main exit without waiting for descendant EOF', async () => {
  const { directory, session, descendant } = await escapedFixture('exited')
  const start = performance.now()
  await expect(session.waitForText('never-present', { timeout: 30000 }))
    .rejects.toThrow('Process exited with code 7')
  const elapsedMs = performance.now() - start
  expect(elapsedMs).toBeLessThan(1000)
  expect(session.exitInfo).toEqual({ exitCode: 7, signal: 0 })
  expect(running(descendant)).toBe(true)
  receipt(directory, { elapsedMs, descendant, exitInfo: session.exitInfo })
})

linuxTest('waitForData rejects a silent main exit despite a descendant retaining the slave', async () => {
  const { directory, session, descendant } = await escapedFixture('quiet')
  const start = performance.now()
  await expect(session.waitForData({ timeout: 30000 }))
    .rejects.toThrow('PTY process has already exited without producing data')
  const elapsedMs = performance.now() - start
  expect(elapsedMs).toBeLessThan(1000)
  expect(running(descendant)).toBe(true)
  receipt(directory, { elapsedMs, descendant, exitInfo: session.exitInfo })
})

for (const close of [false, true]) {
  linuxTest(`recorded ${close ? 'close' : 'natural exit'} retains a partial cast when descendant output stays open`, async () => {
    const { directory, file, session, descendant } = await escapedFixture(close ? 'running' : 'exited', true)
    await session.waitForData()
    const start = performance.now()
    if (close) await session.closeAsync()
    else await until(() => session.recording?.status().kind === 'partial')
    const elapsedMs = performance.now() - start
    const status = session.recording?.status()
    expect(elapsedMs).toBeLessThan(1000)
    expect(status).toMatchObject({ kind: 'partial', reason: 'PTY output still held by a descendant' })
    expect(running(descendant)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    const events = castEvents(`${file}.partial`)
    expect(events.filter((event) => event[1] === 'o').map((event) => event[2]).join('')).toBe('HEAD')
    expect(events.some((event) => event[1] === 'x')).toBe(false)
    receipt(directory, { elapsedMs, descendant, status, events })
  })
}

for (const recorded of [false, true]) {
  linuxTest(`${recorded ? 'recorded' : 'plain'} close preserves pending and subsequent exit waiters`, async () => {
    const { directory, session, descendant } = await escapedFixture('running', recorded)
    await session.waitForText('HEAD')
    let notifications = 0
    session.onExit(() => { notifications++ })
    const start = performance.now()
    const before = session.waitForExit(5000)
    session.close()
    const after = session.waitForExit(5000)
    expect(await before).toBe(true)
    expect(await after).toBe(true)
    expect(performance.now() - start).toBeLessThan(750)
    expect(session.isDead).toBe(true)
    expect(session.exitInfo).not.toBeNull()
    expect(notifications).toBe(1)
    expect(running(descendant)).toBe(true)
    await session.closeAsync()
    receipt(directory, { exitInfo: session.exitInfo, notifications })
  })
}

linuxTest('recorded discards descendant output after the post-exit window', async () => {
  const { directory, file, session } = await escapedFixture('late', true)
  await session.waitForText('HEAD')
  await until(() => fs.existsSync(path.join(directory, 'late.sent')))
  await expect(session.waitForText('LATE', { timeout: 1500 })).rejects.toThrow('Process exited with code 7')
  expect(session.getRawOutput()).toBe('HEAD')
  expect(session.exitInfo).toEqual({ exitCode: 7, signal: 0 })
  expect(session.recording?.status().kind).toBe('partial')
  const events = castEvents(`${file}.partial`)
  expect(events.filter(event => event[1] === 'o').map(event => event[2]).join('')).toBe('HEAD')
  expect(events.some(event => event[1] === 'x')).toBe(false)
  receipt(directory, { status: session.recording?.status(), events })
})

linuxTest('recorded wait accepts the short final tail after main exit', async () => {
  const { directory, file, session } = await escapedFixture('tail', true)
  expect(await session.waitForText('HEADTAIL')).toContain('HEADTAIL')
  expect(session.exitInfo).toEqual({ exitCode: 7, signal: 0 })
  await until(() => session.recording?.status().kind === 'saved')
  const events = castEvents(file)
  expect(events.filter((event) => event[1] === 'o').map((event) => event[2]).join('')).toBe('HEADTAIL')
  expect(events.filter((event) => event[1] === 'x').map((event) => event[2])).toEqual(['7'])
  receipt(directory, { status: session.recording?.status(), events })
})

for (const recorded of [false, true]) {
  linuxTest(`${recorded ? 'recorded' : 'plain'} close removes generated DB files after the shutdown handler exits`, async () => {
    const fixture = fixtureDirectory(`${process.release.name}-db`)
    const { directory } = fixture
    const session = await createSession({
      command: 'sh', cwd: directory, args: ['-c', `
echo "$$" > leader.pid
mkdir -p .termcast-bundle
base=".termcast-bundle/data-$TERMCAST_DB_SUFFIX.db"
touch "$base" "$base-shm" "$base-wal"
trap 'if [ -f "$base" ]; then echo present; else echo missing; fi > shutdown.txt; printf rewritten > "$base"; exit 4' TERM HUP
printf READY
while :; do sleep .05; done
`],
      record: recorded ? { path: path.join(directory, 'session.cast') } : undefined,
    })
    fixture.session = session
    await session.waitForText('READY')
    if (recorded) await session.closeAsync()
    else session.close()
    await until(() => session.isDead)
    await until(() => fs.readdirSync(path.join(directory, '.termcast-bundle')).length === 0)
    expect(fs.readFileSync(path.join(directory, 'shutdown.txt'), 'utf8')).toBe('present\n')
    expect(fs.readdirSync(path.join(directory, '.termcast-bundle'))).toEqual([])
    receipt(directory, { exitInfo: session.exitInfo, shutdown: 'present', artifacts: [] })
  })
}

const bunTest = process.versions.bun ? test : test.skip
bunTest('plain Bun sessions work without the optional recording PTY dependency', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-no-zigpty-'))
  try {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('tuistory/pty'))))
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'))
  fs.cpSync(path.join(root, 'dist'), path.join(directory, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'node_modules'))
  for (const name of fs.readdirSync(path.join(root, 'node_modules'))) {
    if (name === 'zigpty' || name.startsWith('.')) continue
    fs.symlinkSync(path.join(root, 'node_modules', name), path.join(directory, 'node_modules', name))
  }
  fs.writeFileSync(path.join(directory, 'run.mjs'), `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {launchTerminal} from './dist/index.js';
assert.throws(()=>createRequire(import.meta.url).resolve('zigpty'));
const session=await launchTerminal({command:'sh',args:['-c','stty -echo; printf READY; read line; stty size; printf "GOT:%s" "$line"; while :; do sleep .05; done'],waitForData:false});
try {
 await session.waitForText('READY');
 session.resize({cols:90,rows:30});
 session.writeRaw('hello\\n');
 const text=await session.waitForText('GOT:hello');
 assert.match(text,/30\\s+90/);
 const exit=session.waitForExit(5000);
 await session.closeAsync();
 assert.equal(await exit,true);
 assert.equal(session.recording,undefined);
 console.log('plain session: input, resize, output and close passed without zigpty');
} finally {session.close()}
`)
  const result = spawnSync(process.execPath, [path.join(directory, 'run.mjs')], { encoding: 'utf8', timeout: 15000 })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('plain session: input, resize, output and close passed without zigpty')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}, 20000)
