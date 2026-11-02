/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PersistentTerminal, type TerminalData } from 'ghostty-opentui'
import { renderTerminalToImage } from 'ghostty-opentui/image'
import { createSession, Session } from './session.js'
import { spawnNative as spawn } from './pty-native.js'
import { Recorder, exportRecording, parseRecording, planRecording, sourceTimeAtFrame, createFramePool, type FramePool } from './recording.js'

describe('recorder and session', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'tuistory-recording-test-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  async function cast(file: string): Promise<unknown[]> {
    return (await readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
  }

  test('manual stop preserves a quiet tail and never records later output or a fake exit', async () => {
    const file = path.join(directory, 'interval.cast')
    const recorder = await Recorder.prepare({ path: file, cols: 80, rows: 24 })
    recorder.start()
    recorder.output('hello😀')
    recorder.resize(40, 10)
    recorder.mark('ready')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const first = recorder.stop()
    expect(recorder.stop()).toBe(first)
    recorder.output('must not be present')
    expect(await first).toMatchObject({ kind: 'saved', extent: 'interval' })
    const lines = await cast(file)
    expect(lines.slice(1).map((event) => Array.isArray(event) ? event.slice(1) : event)).toEqual([
      ['o', 'hello😀'], ['r', '40x10'], ['m', 'ready'], ['m', ''],
    ])
    const end = lines.at(-1)
    expect(Array.isArray(end) && end[0]).toBeGreaterThan(0.02)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test('overflow permanently preserves a contiguous prefix and does not publish', async () => {
    const file = path.join(directory, 'overflow.cast')
    const recorder = await Recorder.prepare({ path: file, cols: 80, rows: 24, maxQueuedBytes: 512 })
    recorder.output('prefix')
    recorder.output('\0'.repeat(1000))
    recorder.output('after overflow')
    const result = await recorder.stop()
    expect(result).toMatchObject({ kind: 'partial', reason: 'Recording queue capacity exceeded' })
    expect(await cast(result.partialPath)).toHaveLength(2)
    expect(await readFile(result.partialPath, 'utf8')).toContain('prefix')
    expect(await readFile(result.partialPath, 'utf8')).not.toContain('after overflow')
    await expect(stat(file)).rejects.toThrow()
  })

  test('publication never replaces a file created after preparation', async () => {
    const file = path.join(directory, 'race.cast')
    const recorder = await Recorder.prepare({ path: file, cols: 80, rows: 24 })
    recorder.output('recorded')
    await writeFile(file, 'winner')
    expect(await recorder.stop()).toMatchObject({ kind: 'partial' })
    expect(await readFile(file, 'utf8')).toBe('winner')
    expect(await cast(`${file}.partial`)).toHaveLength(3)
  })

  test('native PTY drains trailing output after the main process exits', async () => {
    const pty = spawn('sh', ['-c', "(trap '' HUP; sleep .08; printf TAIL) & printf HEAD; sleep .02; exit 7"], { cols: 80, rows: 24 })
    let output = ''
    const events: string[] = []
    pty.onData((data) => { output += data; events.push(data) })
    pty.onExit(() => events.push('exit'))
    expect(await pty.exited).toEqual({ exitCode: 7, signal: 0 })
    expect(await pty.drained).toEqual({ kind: 'eof' })
    expect(output).toBe('HEADTAIL')
    expect(events.indexOf('exit')).toBeLessThan(events.findIndex((event) => event.includes('TAIL')))
    pty.dispose()
  })

  test('native PTY preserves a large final burst and split UTF-8', async () => {
    const pty = spawn('sh', ['-c', "head -c 131072 /dev/zero | tr '\\000' x; printf '\\360\\237'; sleep .01; printf '\\230\\200'; exit 9"], { cols: 80, rows: 24 })
    let output = ''
    pty.onData((data) => { output += data })
    expect(await pty.exited).toEqual({ exitCode: 9, signal: 0 })
    expect(await pty.drained).toEqual({ kind: 'eof' })
    expect(output).toBe('x'.repeat(131072) + '😀')
    pty.dispose()
  })

  test('forced output disposal is an error and never an EOF', async () => {
    const pty = spawn('sh', ['-c', 'sleep 5'], { cols: 80, rows: 24 })
    pty.dispose()
    expect(await pty.drained).toMatchObject({ kind: 'error' })
    pty.kill()
    await pty.exited
  })

  test('recorded session captures immediate output, actual exit, and shares close', async () => {
    const file = path.join(directory, 'session.cast')
    const session = await createSession({ command: 'sh', args: ['-c', 'printf immediate; exit 7'], record: { path: file } })
    await session.waitForData()
    expect(await session.waitForExit()).toBe(true)
    const first = session.closeAsync()
    expect(session.closeAsync()).toBe(first)
    await first
    expect(session.recording?.status()).toMatchObject({ kind: 'saved', extent: 'process' })
    const lines = await cast(file)
    expect(lines.slice(1).map((event) => Array.isArray(event) ? event.slice(1) : event)).toEqual([
      ['o', 'immediate'], ['x', '7'],
    ])
  })

  test('manual recording stop keeps the child alive and close captures graceful final output', async () => {
    const stopped = await createSession({ command: 'sh', args: ['-c', 'printf ready; sleep 5'], record: { path: path.join(directory, 'stopped.cast') } })
    await stopped.waitForData()
    expect(await stopped.recording?.stop()).toMatchObject({ kind: 'saved', extent: 'interval' })
    expect(stopped.isDead).toBe(false)
    await stopped.closeAsync()

    const file = path.join(directory, 'closing.cast')
    const closing = await createSession({ command: 'sh', args: ['-c', "trap 'printf FINAL; exit 4' TERM; printf ready; while :; do sleep .05; done"], record: { path: file } })
    await closing.waitForData()
    await closing.closeAsync()
    const text = await readFile(file, 'utf8')
    expect(text).toContain('FINAL')
    expect((await cast(file)).at(-1)).toEqual(expect.arrayContaining(['x', '4']))
  })

  test('legacy synchronous construction rejects raw recording intent before spawning', () => {
    const options = { command: 'sh', record: { path: path.join(directory, 'raw.cast') } }
    expect(() => new Session(options)).toThrow('Recording requires')
  })

  test('session waiters accept output arriving after the process result', async () => {
    const session = await createSession({ command: 'sh', args: ['-c', "(trap '' HUP; sleep .08; printf TAIL) & sleep .02; exit 7"], record: { path: path.join(directory, 'tail.cast') } })
    try {
      expect(await session.waitForText('TAIL')).toContain('TAIL')
      await session.waitForData()
    } finally {
      await session.closeAsync()
    }
  })

  test('repeated native PTY drain and disposal releases file descriptors', async () => {
    if (process.platform !== 'linux') return
    const run = async () => {
      const pty = spawn('sh', ['-c', 'printf done'], { cols: 80, rows: 24 })
      pty.onData(() => {})
      await Promise.all([pty.exited, pty.drained])
      pty.dispose()
    }
    await run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const before = (await readdir('/proc/self/fd')).length
    for (let count = 0; count < 30; count++) await run()
    const deadline = Date.now() + 1000
    let after = (await readdir('/proc/self/fd')).length
    while (after > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      after = (await readdir('/proc/self/fd')).length
    }
    expect(after).toBeLessThanOrEqual(before)
  })

  test('closing rejects new input immediately and shares reentrant close calls', async () => {
    const session = await createSession({ command: 'sh', args: ['-c', 'printf ready; sleep 5'] })
    await session.waitForData()
    let reentrant: Promise<void> | undefined
    session.onClosing(() => { reentrant = session.closeAsync() })
    const closing = session.closeAsync()
    expect(() => session.writeRaw('input')).toThrow('session is closed')
    await closing
    expect(reentrant).toBe(closing)
  })

  test('native recording accepts a compatible patch version selected by the package manager', () => {
    const adapter = fileURLToPath(new URL(process.versions.bun ? './pty-native.ts' : '../dist/pty-native.js', import.meta.url))
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync;
fs.readFileSync=function(file,...args){
 const contents=read.call(this,file,...args);
 if(String(file).endsWith('/zigpty/package.json')) {
  const metadata=JSON.parse(String(contents));
  return JSON.stringify({...metadata,version:'0.2.2'});
 }
 return contents;
};
syncBuiltinESMExports();
const {spawnNative}=await import(${JSON.stringify(adapter)});
const pty=spawnNative('sh',['-c','printf READY; exit 7'],{cols:80,rows:24});
let output='';
pty.onData(data=>output+=data);
try {
 assert.deepEqual(await pty.exited,{exitCode:7,signal:0});
 assert.deepEqual(await pty.drained,{kind:'eof'});
 assert.equal(output,'READY');
 console.log('recording completed');
} finally {pty.kill();pty.dispose()}
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('recording completed')
  }, 15000)
})

describe('recording boundaries', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'tuistory-boundary-test-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  for (const dimensions of [{ cols: 401, rows: 24 }, { cols: 80, rows: 121 }, { cols: 80, rows: 150 }]) {
    test(`recorded startup rejects ${dimensions.cols}x${dimensions.rows} before creating a file or process`, async () => {
      await expect(createSession({
        command: 'sh', args: ['-c', 'touch should-not-start'], cwd: directory,
        ...dimensions, record: { path: path.join(directory, 'invalid.cast') },
      })).rejects.toThrow('Recording geometry must be 1..400 columns and 1..120 rows')
      expect(await readdir(directory)).toEqual([])
    })
  }

  test('rejected recording resize preserves geometry and subsequent exportable events', async () => {
    const file = path.join(directory, 'session.cast')
    const session = await createSession({ command: 'sh', args: ['-c', 'printf READY; sleep 100'], cols: 80, rows: 24, record: { path: file } })
    try {
      await session.waitForData()
      expect(() => session.resize({ cols: 80, rows: 150 })).toThrow('Recording geometry')
      expect([session.currentCols, session.currentRows]).toEqual([80, 24])
      expect([session.getTerminalData().cols, session.getTerminalData().rows]).toEqual([80, 24])
      session.resize({ cols: 100, rows: 30 })
      expect(await session.recording?.stop()).toMatchObject({ kind: 'saved' })
      const parsed = parseRecording(await readFile(file))
      expect(parsed.events.filter(event => event.kind === 'resize')).toEqual([
        expect.objectContaining({ kind: 'resize', cols: 100, rows: 30 }),
      ])
      expect([parsed.maxCols, parsed.maxRows]).toEqual([100, 30])
    } finally { await session.closeAsync() }
  })

  test('unrecorded sessions retain larger terminal geometry', async () => {
    const session = await createSession({ command: 'sh', args: ['-c', 'printf READY; sleep 100'], rows: 150 })
    try {
      await session.waitForData()
      expect(session.currentRows).toBe(150)
      session.resize({ cols: 80, rows: 160 })
      expect(session.currentRows).toBe(160)
    } finally { await session.closeAsync() }
  })

  test('queue admits an event larger than one third of capacity and counts its encoded bytes', async () => {
    const file = path.join(directory, 'budget.cast')
    const recorder = await Recorder.prepare({ path: file, cols: 80, rows: 24, maxQueuedBytes: 512 })
    const payload = 'x'.repeat(250)
    recorder.output(payload)
    const status = recorder.status()
    expect(status.kind).toBe('active')
    expect(status.queuedBytes).toBeGreaterThan(250)
    expect(status.queuedBytes).toBeLessThanOrEqual(512 - 128)
    expect(await recorder.stop()).toMatchObject({ kind: 'saved', extent: 'interval' })
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    expect(status.queuedBytes).toBe(Buffer.byteLength(lines[1] + '\n'))
    expect(JSON.parse(lines[1]).slice(1)).toEqual(['o', payload])
  })
})

describe('offline export', () => {
  const header = { version: 3, term: { cols: 12, rows: 3 } }
  function cast(events: unknown[] = [], term = header.term): Buffer {
    return Buffer.from([JSON.stringify({ ...header, term }), ...events.map(event => JSON.stringify(event))].join('\n') + '\n')
  }

  let directory: string
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'tuistory-export-test-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  async function fixture(events: unknown[] = [], term = header.term): Promise<{ inputPath: string; outputPath: string }> {
    const inputPath = path.join(directory, 'source.cast')
    const outputPath = path.join(directory, 'video.mp4')
    await writeFile(inputPath, cast(events, term))
    return { inputPath, outputPath }
  }

  function pixels(video: string, frame: number): Buffer {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', video,
      '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { maxBuffer: 16 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(result.stderr.toString())
    return result.stdout
  }

  function pixel(bytes: Buffer, width: number, x: number, y: number): number[] {
    const offset = (y * width + x) * 3
    return [...bytes.subarray(offset, offset + 3)]
  }

  function countBright(bytes: Buffer, width: number, yStart: number, yEnd: number): number {
    let count = 0
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3
        if (bytes[offset] > 100 && bytes[offset + 1] > 100 && bytes[offset + 2] > 100) count++
      }
    }
    return count
  }

  function glyphColumns(bytes: Buffer, width: number, start = 0, end = 17, yStart = 0, yEnd = 21): number {
    let columns = 0
    for (let x = start; x < end; x++) {
      for (let y = yStart; y < yEnd; y++) {
        const rgb = pixel(bytes, width, x, y)
        if (rgb.every(value => value > 100)) {
          columns++
          break
        }
      }
    }
    return columns
  }

  const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0
  const videoTest = ffmpegAvailable ? test : test.skip

  videoTest('screenshot and export initialize safely in either order', async () => {
    const order = process.env.TUISTORY_EXPORT_INIT_ORDER
    if (!order) {
      for (const first of ['screenshot', 'export']) {
        const testPath = fileURLToPath(import.meta.url)
        const args = process.versions.bun
          ? ['test', testPath, '-t', 'screenshot and export initialize safely in either order']
          : ['run', 'test:node', testPath, '-t', 'screenshot and export initialize safely in either order']
        const child = spawnSync('bun', args, {
          env: { ...process.env, TUISTORY_EXPORT_INIT_ORDER: first },
          encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        })
        if (child.status !== 0) throw new Error(`${first} first failed\n${child.stdout}\n${child.stderr}`)
      }
      return
    }
    if (order !== 'screenshot' && order !== 'export') throw new Error('Unknown initialization order')
    const terminal = new PersistentTerminal({ cols: 12, rows: 3 })
    try {
      terminal.feed('é € 漢字 😀')
      const screenshot = () => renderTerminalToImage(terminal.getJson(), { width: 102, height: 64 })
      const before = order === 'screenshot' ? await screenshot() : undefined
      const options = await fixture([[0, 'o', 'PACKAGE é € 漢字 😀\r\n\x1b[41m&<>😀Z\x1b[0m']], { cols: 40, rows: 6 })
      const first = await exportRecording(options)
      expect(countBright(pixels(first.path, 0), first.width, 0, 21)).toBeGreaterThan(200)
      const after = await screenshot()
      expect(after.readUInt32BE(16)).toBe(102)
      expect(after.readUInt32BE(20)).toBe(64)
      if (before) expect(after).toEqual(before)
      const second = await exportRecording({ ...options, outputPath: path.join(directory, 'again.mp4') })
      expect(await screenshot()).toEqual(after)
      expect(pixels(second.path, 0)).toEqual(pixels(first.path, 0))
    } finally {
      terminal.destroy()
    }
  }, 65_000)

  videoTest('keeps all printable ASCII styles stable after Unicode fallback and clip warmup', async () => {
    const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('')
    const ascii = [0, 1, 2, 3, 4, 7, 9].map(style => `\x1b[${style};31;44m${printable}\x1b[0m\r\n`).join('')
    const options = await fixture([
      [0, 'o', ascii],
      [1, 'o', '\x1b[2J\x1b[H漢字 かな 한글 é € 😀 🧑‍💻 ☀️'],
      [1, 'o', `\x1b[2J\x1b[H${ascii}`],
    ], { cols: 95, rows: 10 })
    const first = await exportRecording({ ...options, from: 0, to: 0 })
    const unicode = await exportRecording({ ...options, outputPath: path.join(directory, 'unicode.mp4'), from: 1, to: 1 })
    const restored = await exportRecording({ ...options, outputPath: path.join(directory, 'restored.mp4'), from: 2, to: 2 })
    const originalPixels = pixels(first.path, 0)
    expect(first.frames).toBe(1)
    expect(unicode.frames).toBe(1)
    expect(restored.frames).toBe(1)
    expect(countBright(pixels(unicode.path, 0), unicode.width, 0, 21)).toBeGreaterThan(100)
    expect(pixels(restored.path, 0)).toEqual(originalPixels)
    expect(pixels(unicode.path, 0)).not.toEqual(originalPixels)
  }, 20_000)

  videoTest('keeps combining mark overhang without copying it into unrelated blank rows', async () => {
    const options = await fixture([[0, 'o', '\x1b[3;1Ha\u0301\u0302\u0303\u0301\u0302\u0303']], { cols: 40, rows: 6 })
    const result = await exportRecording(options)
    const frame = pixels(result.path, 0)
    expect(countBright(frame, result.width, 0, 21)).toBe(0)
    expect(countBright(frame, result.width, 21, 42)).toBeGreaterThan(0)
    expect(countBright(frame, result.width, 42, 63)).toBeGreaterThan(0)
    expect(countBright(frame, result.width, 63, 126)).toBe(0)
  }, 20_000)

  test('v3 parsing keeps extension timing and rejects invalid known events and hostile geometry', () => {
    expect(parseRecording(cast([[1, 'z', 'extension'], [2, 'o', 'ok'], [0, 'x', '7']]))).toEqual({
      cols: 12, rows: 3, maxCols: 12, maxRows: 3, durationUs: 3_000_000,
      events: [{ timeUs: 1_000_000, kind: 'other' }, { timeUs: 3_000_000, kind: 'output', data: 'ok' }, { timeUs: 3_000_000, kind: 'other' }],
    })
    for (const event of [[-1, 'o', 'a'], [0, 'r', '0x2'], [0, 'r', '2x121'], [0, 'x', '256'], [0, 'm', 1], [0, 'o', '\ud800']]) {
      expect(() => parseRecording(cast([event]))).toThrow()
    }
    expect(() => parseRecording(Buffer.from('{"version":3,"cols":12,"rows":3}\n'))).toThrow('term.cols')
    expect(() => parseRecording(cast([], { cols: 401, rows: 3 }))).toThrow('geometry')
    expect(() => parseRecording(Buffer.from([0xff]))).toThrow('UTF-8')
    expect(() => parseRecording(cast([[86401, 'm', '']]))).toThrow('24 hour')
    expect(() => parseRecording(cast([[0, 'o', 'a'.repeat(256 * 1024)]]))).toThrow('256 KiB')
    expect(() => parseRecording(Buffer.alloc(32 * 1024 * 1024 + 1))).toThrow('32 MiB')
    expect(() => parseRecording(cast(Array.from({ length: 20001 }, () => [0, 'm', ''])))).toThrow('20000 event')
    expect(() => parseRecording(Buffer.from(JSON.stringify(header) + '\n' + '#\n'.repeat(50000)))).toThrow('50000 line')
    expect(parseRecording(Buffer.from(JSON.stringify(header) + '\n# comment\n[1,"o","A"]\n#tail\n[2,"m",""]\n')).durationUs).toBe(3_000_000)
    expect(() => parseRecording(Buffer.from('#not a header\n' + JSON.stringify(header)))).toThrow('line 1')
  })

  test('timing maps original clip bounds through speed and capped idle intervals', () => {
    const source = parseRecording(cast([[0, 'o', 'prefix'], [10, 'z', 'extension'], [10, 'o', 'after'], [10, 'm', '']]))
    const plan = planRecording(source, { fps: 2, speed: 2, idleLimit: 2, from: 5, to: 25 })
    expect({ frames: plan.frames, duration: plan.duration, width: plan.width, height: plan.height }).toEqual({ frames: 5, duration: 2.5, width: 102, height: 64 })
    expect(Array.from({ length: plan.frames }, (_, index) => sourceTimeAtFrame(plan, index))).toEqual([5_000_000, 10_000_000, 15_000_000, 20_000_000, 25_000_000])
    expect(() => planRecording(source, { from: 31 })).toThrow('Clip bounds')
    expect(() => planRecording(source, { to: 31 })).toThrow('Clip bounds')
    for (const options of [{ fps: 0 }, { fps: 2.5 }, { fps: 61 }, { speed: NaN }, { speed: Number.MIN_VALUE }, { idleLimit: 0 }, { idleLimit: Number.MIN_VALUE, speed: 1000 }, { from: -1 }, { to: Infinity }]) {
      expect(() => planRecording(source, options)).toThrow()
    }
    expect(() => planRecording(source, { speed: 0.00001 })).toThrow('frame limit')
    expect(() => planRecording(parseRecording(cast([], { cols: 400, rows: 120 })))).toThrow('canvas')
    expect(() => planRecording(parseRecording(cast([[2000, 'm', '']], { cols: 100, rows: 30 })))).toThrow('pixel limit')
    const ordinaryDemo = planRecording(parseRecording(cast([[300, 'm', '']], { cols: 120, rows: 36 })))
    expect({ frames: ordinaryDemo.frames, width: ordinaryDemo.width, height: ordinaryDemo.height }).toEqual({ frames: 9001, width: 1008, height: 756 })
  })

  test('CFR sampling ignores output chunk count and explicitly samples the final endpoint', () => {
    const joined = parseRecording(cast([[0, 'o', 'hello'], [0.26, 'o', 'final']]))
    const split = parseRecording(cast([[0, 'o', 'he'], [0, 'o', 'llo'], [0.26, 'o', 'fi'], [0, 'o', 'nal']]))
    const first = planRecording(joined, { fps: 2 })
    const second = planRecording(split, { fps: 2 })
    expect(first.frames).toBe(2)
    expect(first.duration).toBe(1)
    expect([sourceTimeAtFrame(first, 0), sourceTimeAtFrame(first, 1)]).toEqual([0, 260_000])
    expect([sourceTimeAtFrame(second, 0), sourceTimeAtFrame(second, 1)]).toEqual([0, 260_000])
    expect(planRecording(parseRecording(cast())).frames).toBe(1)
    expect(planRecording(parseRecording(cast([[0.000001, 'm', '']])), { fps: 1, speed: 1000 }).frames).toBe(2)
    expect(planRecording(parseRecording(cast([[0.1, 'm', ''], [0.2, 'm', '']]))).frames).toBe(10)
  })

  videoTest('encodes a blank initial screen, visible color and the final cleared screen', async () => {
    const options = await fixture([[0.5, 'o', '\x1b[41m RED \x1b[0m'], [0.5, 'o', '\x1b[2J\x1b[H'], [0, 'x', '0']])
    const original = await readFile(options.inputPath)
    const result = await exportRecording({ ...options, fps: 2 })
    expect(result).toEqual({ path: options.outputPath, frames: 3, width: 102, height: 64, duration: 1.5 })
    const metadata = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_frames,r_frame_rate,duration', '-of', 'json', result.path])
    const stream = JSON.parse(metadata.stdout.toString()).streams[0]
    expect(stream).toEqual({ codec_name: 'h264', width: 102, height: 64, pix_fmt: 'yuv420p', r_frame_rate: '2/1', duration: '1.500000', nb_frames: '3' })
    const blank = pixels(result.path, 0)
    const visible = pixels(result.path, 1)
    const cleared = pixels(result.path, 2)
    expect(blank.length).toBe(102 * 64 * 3)
    expect(countBright(blank, 102, 0, 64)).toBe(0)
    expect(countBright(visible, 102, 0, 21)).toBeGreaterThan(25)
    expect(countBright(cleared, 102, 0, 64)).toBe(0)
    const red = pixel(visible, 102, 3, 3)
    expect(red[0]).toBeGreaterThan(red[1] + 40)
    const untouched = pixel(visible, 102, 80, 3)
    expect(Math.max(...untouched) - Math.min(...untouched)).toBeLessThan(20)
    expect(await readFile(options.inputPath)).toEqual(original)
    expect((await stat(result.path)).mode & 0o777).toBe(0o600)
    expect((await readdir(directory)).sort()).toEqual(['source.cast', 'video.mp4'])
  }, 30_000)

  videoTest('warms up before trimming, renders final output and takes only the visible scrollback viewport', async () => {
    const options = await fixture([[0, 'o', 'HISTORY\r\nFIRST\r\nSECOND\r\nTHIRD'], [0.5, 'o', '\r\nFINAL'], [0.5, 'm', '']])
    const result = await exportRecording({ ...options, fps: 2, from: 0.5, to: 0.5 })
    expect(result.frames).toBe(1)
    const frame = pixels(result.path, 0)
    expect(countBright(frame, result.width, 0, 21)).toBeGreaterThan(25)
    expect(countBright(frame, result.width, 21, 42)).toBeGreaterThan(25)
    expect(countBright(frame, result.width, 42, 63)).toBeGreaterThan(25)
    const expected = await fixture([[0, 'o', 'SECOND\r\nTHIRD\r\nFINAL']])
    expected.outputPath = path.join(directory, 'expected.mp4')
    const comparison = await exportRecording({ ...expected, fps: 2 })
    expect(frame).toEqual(pixels(comparison.path, 0))
  }, 30_000)

  videoTest('keeps cell widths on resize and leaves the unused canvas background blank', async () => {
    const options = await fixture([[0, 'o', '\x1b[41m\x1b[2J\x1b[HXX'], [0.5, 'r', '6x2'], [0, 'o', '\x1b[2J\x1b[HXX'], [0.5, 'm', '']])
    const result = await exportRecording({ ...options, fps: 2 })
    expect([result.width, result.height]).toEqual([102, 64])
    const first = pixels(result.path, 0)
    const resized = pixels(result.path, 1)
    const firstRed = pixel(first, result.width, 80, 5)
    expect(firstRed[0]).toBeGreaterThan(firstRed[1] + 40)
    const unused = pixel(resized, result.width, 80, 5)
    expect(Math.max(...unused) - Math.min(...unused)).toBeLessThan(20)
    expect(countBright(first, result.width, 0, 21)).toBeGreaterThan(10)
    expect(countBright(resized, result.width, 0, 21)).toBeGreaterThan(10)
  }, 30_000)

  videoTest('preserves an explicit erase-to-end background without coloring untouched cells', async () => {
    const options = await fixture([[0, 'o', '\x1b[44mX\x1b[0m'], [0.5, 'o', '\r\x1b[44m\x1b[K'], [0.5, 'm', '']])
    const result = await exportRecording({ ...options, fps: 2 })
    const cell = pixels(result.path, 0)
    const erased = pixels(result.path, 1)
    const blueCell = pixel(cell, result.width, 3, 3)
    const darkRest = pixel(cell, result.width, 80, 3)
    const blueRest = pixel(erased, result.width, 80, 3)
    expect(blueCell[2]).toBeGreaterThan(blueCell[0] + 40)
    expect(Math.max(...darkRest) - Math.min(...darkRest)).toBeLessThan(20)
    expect(blueRest[2]).toBeGreaterThan(blueRest[0] + 40)
  }, 30_000)

  videoTest('renders mixed combining-accent euro and CJK text with bundled fonts', async () => {
    const options = await fixture([[0, 'o', 'PACKAGE é € 漢字 😀\r\nFINAL installed font']], { cols: 40, rows: 6 })
    const result = await exportRecording(options)
    const mixed = pixels(result.path, 0)
    expect(countBright(mixed, result.width, 0, 21)).toBeGreaterThan(250)
    expect(countBright(mixed, result.width, 21, 42)).toBeGreaterThan(150)
  }, 30_000)

  videoTest('preserves adjacent ASCII CJK XML text and colored backgrounds around unsupported emoji', async () => {
    const text = 'A😀B é😀漢字😀Z\r\n&<>"\'😀&<>\r\n\x1b[41mA😀B\x1b[0m Z'
    const options = await fixture([[0, 'o', text]], { cols: 40, rows: 6 })
    const result = await exportRecording(options)
    const image = pixels(result.path, 0)
    expect(glyphColumns(image, result.width, 25, 34)).toBeGreaterThanOrEqual(5)
    expect(glyphColumns(image, result.width, 117, 126)).toBeGreaterThanOrEqual(5)
    expect(glyphColumns(image, result.width, 0, 42, 21, 42)).toBeGreaterThan(20)
    for (const x of [2, 8, 16, 25, 31]) {
      const red = pixel(image, result.width, x, 43)
      expect(red[0]).toBeGreaterThan(red[1] + 40)
    }
    const dark = pixel(image, result.width, 45, 43)
    expect(Math.max(...dark) - Math.min(...dark)).toBeLessThan(20)
  }, 30_000)

  videoTest('publishes without replacing a target created during encoding', async () => {
    const options = await fixture([[0, 'o', 'hello']])
    const realFfmpeg = (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'ffmpeg')).find(existsSync)
    if (!realFfmpeg) throw new Error('FFmpeg disappeared')
    const original = await readFile(options.inputPath)
    const savedPath = process.env.PATH
    const savedTarget = process.env.TUISTORY_EXPORT_TEST_RACE_TARGET
    const savedEncoder = process.env.TUISTORY_EXPORT_TEST_REAL_FFMPEG
    try {
      await writeFile(path.join(directory, 'ffmpeg'), '#!/bin/sh\nprintf "racing output" > "$TUISTORY_EXPORT_TEST_RACE_TARGET"\nexec "$TUISTORY_EXPORT_TEST_REAL_FFMPEG" "$@"\n')
      await chmod(path.join(directory, 'ffmpeg'), 0o700)
      process.env.PATH = directory + path.delimiter + savedPath
      process.env.TUISTORY_EXPORT_TEST_RACE_TARGET = options.outputPath
      process.env.TUISTORY_EXPORT_TEST_REAL_FFMPEG = realFfmpeg
      await expect(exportRecording(options)).rejects.toThrow('EEXIST')
      expect(await readFile(options.outputPath, 'utf8')).toBe('racing output')
      expect(await readFile(options.inputPath)).toEqual(original)
      expect((await readdir(directory)).sort()).toEqual(['ffmpeg', 'source.cast', 'video.mp4'])
    } finally {
      process.env.PATH = savedPath
      if (savedTarget === undefined) delete process.env.TUISTORY_EXPORT_TEST_RACE_TARGET
      else process.env.TUISTORY_EXPORT_TEST_RACE_TARGET = savedTarget
      if (savedEncoder === undefined) delete process.env.TUISTORY_EXPORT_TEST_REAL_FFMPEG
      else process.env.TUISTORY_EXPORT_TEST_REAL_FFMPEG = savedEncoder
    }
  }, 30_000)

  test('rejects existing outputs, invalid paths and invalid options without changing original bytes', async () => {
    const options = await fixture([[0, 'o', 'hello']])
    const original = await readFile(options.inputPath)
    await writeFile(options.outputPath, 'keep me')
    await writeFile(options.outputPath + '.partial', 'user partial')
    await expect(exportRecording(options)).rejects.toThrow('already exists')
    await expect(exportRecording({ ...options, outputPath: options.inputPath })).rejects.toThrow('different paths')
    await expect(exportRecording({ ...options, outputPath: 'bad\0path' })).rejects.toThrow('NUL')
    await expect(exportRecording({ ...options, fps: 0 })).rejects.toThrow('fps')
    expect(await readFile(options.inputPath)).toEqual(original)
    expect(await readFile(options.outputPath, 'utf8')).toBe('keep me')
    expect(await readFile(options.outputPath + '.partial', 'utf8')).toBe('user partial')
  })

  test('cleans its partial on missing FFmpeg and encoder failure while preserving the cast', async () => {
    const options = await fixture([[0, 'o', 'hello']])
    const original = await readFile(options.inputPath)
    const savedPath = process.env.PATH
    try {
      process.env.PATH = directory
      await expect(exportRecording(options)).rejects.toThrow('Unable to start FFmpeg')
      const shim = path.join(directory, 'ffmpeg')
      await writeFile(shim, '#!/bin/sh\nprintf "fixture encoder failure" >&2\nexit 7\n')
      await chmod(shim, 0o700)
      await expect(exportRecording(options)).rejects.toThrow('fixture encoder failure')
      expect((await readdir(directory)).sort()).toEqual(['ffmpeg', 'source.cast'])
      expect(await readFile(options.inputPath)).toEqual(original)
    } finally {
      process.env.PATH = savedPath
    }
  }, 30_000)

  videoTest('stops replay when native scrollback exceeds its cell budget', async () => {
    const options = await fixture([[0, 'o', '\n'.repeat(5100)]], { cols: 400, rows: 1 })
    await expect(exportRecording(options)).rejects.toThrow('native scrollback')
    expect((await readdir(directory)).sort()).toEqual(['source.cast'])
  }, 30_000)

  test('rejects host font overrides for the bundled rendering profile', async () => {
    const options = await fixture()
    const key = 'GHOSTTY_OPENTUI_FALLBACK_FONT_PATH'
    const saved = process.env[key]
    try {
      process.env[key] = '/does/not/exist.ttf'
      await expect(exportRecording(options)).rejects.toThrow(`Unset ${key}`)
      expect((await readdir(directory)).sort()).toEqual(['source.cast'])
    } finally {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
  })
})

describe('render worker pool', () => {
  let directory: string
  const pools: FramePool[] = []
  const exits: Promise<void>[] = []
  const data: TerminalData = { cols: 1, rows: 1, cursor: [0, 0], cursorVisible: false, cursorStyle: 'default', offset: 0, totalLines: 1,
    lines: [{ spans: [{ text: 'A', fg: null, bg: null, flags: 0, width: 1 }] }] }
  const profile = { width: 2, height: 2 }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'tuistory-worker-test-'))
    await writeFile(path.join(directory, 'worker.mjs'), `
import { parentPort as port, workerData as settings } from 'node:worker_threads';
if (settings.mode === 'startup-error') throw Error('initialization failed');
if (settings.mode !== 'startup-hang') port.postMessage({kind:'ready'});
port.on('message', ({id, data}) => {
  if (settings.mode === 'crash') throw Error('raster crash');
  if (settings.mode === 'exit') process.exit(0);
  if (settings.mode === 'hang' || settings.mode === 'startup-hang') return;
  if (settings.mode === 'render-error') { port.postMessage({kind:'error',message:'raster rejected'}); return; }
  const send = () => {
    const pixels = new Uint8Array(settings.mode === 'bad-length' ? 12 : 16).fill(settings.index);
    port.postMessage(settings.mode === 'malformed' ? 'wrong' : {kind:'frame', id:settings.mode==='bad-id'?id+1:id, width:2,height:2,pixels},[pixels.buffer]);
    if (settings.mode === 'duplicate') port.postMessage({kind:'ready'});
  };
  setTimeout(send, settings.mode === 'slow' ? 100 : 0);
});
`)
  })
  afterEach(async () => {
    await Promise.all(pools.splice(0).map(pool => pool.close().catch(() => {})))
    await Promise.all(exits.splice(0))
    await rm(directory, { recursive: true, force: true })
  })

  function factory(modes: string[]) {
    let index = 0
    return () => {
      const mode = modes[index++] ?? 'normal'
      if (mode === 'constructor-error') throw new Error('constructor rejected')
      const worker = new Worker(path.join(directory, 'worker.mjs'), { workerData: { mode, index } })
      exits.push(new Promise(resolve => worker.once('exit', () => resolve())))
      return worker
    }
  }

  async function pool(modes: string[]) {
    const result = await createFramePool(profile, modes.length === 1 ? 1 : 2, { spawnWorker: factory(modes), renderMs: 1000 })
    pools.push(result)
    return result
  }

  test('dispatches to an idle worker and keeps independent result buffers alive through close', async () => {
    const renderer = await pool(['slow', 'normal'])
    const first = renderer.render(data)
    const second = await renderer.render(data)
    expect([...second]).toEqual(Array(16).fill(2))
    expect([...(await renderer.render(data))]).toEqual(Array(16).fill(2))
    expect([...(await first)]).toEqual(Array(16).fill(1))
    const closing = renderer.close()
    expect(renderer.close()).toBe(closing)
    await closing
    expect([...second]).toEqual(Array(16).fill(2))
    await expect(renderer.render(data)).rejects.toThrow('closed')
  })

  for (const mode of ['crash', 'exit', 'render-error', 'bad-id', 'bad-length', 'malformed']) {
    test(`${mode} rejects both active jobs and preserves failure after close`, async () => {
      const renderer = await pool(['hang', mode])
      const outcomes = await Promise.allSettled([renderer.render(data), renderer.render(data)])
      expect(outcomes.map(value => value.status)).toEqual(['rejected', 'rejected'])
      await expect(renderer.waitFor(new Promise<never>(() => {}))).rejects.toThrow()
      await expect(renderer.close()).rejects.toThrow()
      await Promise.all(exits)
    })
  }

  test('rejects duplicate replies even after the first frame was returned', async () => {
    const renderer = await pool(['duplicate'])
    await renderer.render(data)
    const error = await renderer.waitFor(new Promise<never>(() => {})).catch(error => error)
    expect(error.message).toContain('Unsolicited')
    await expect(renderer.close()).rejects.toThrow('Unsolicited')
  })

  for (const mode of ['startup-error', 'constructor-error']) {
    test(`${mode} closes an already-owned sibling before creation rejects`, async () => {
      await expect(createFramePool(profile, 2, { spawnWorker: factory(['startup-hang', mode]) })).rejects.toThrow()
      await Promise.all(exits)
    })
  }

  test('startup deadline terminates a worker that never becomes ready', async () => {
    await expect(createFramePool(profile, 1, { spawnWorker: factory(['startup-hang']), startupMs: 100 })).rejects.toThrow('startup timed out')
    await Promise.all(exits)
  })

  test('render deadline rejects a stuck frame and terminates its worker', async () => {
    const renderer = await createFramePool(profile, 1, { spawnWorker: factory(['hang']), renderMs: 100 })
    pools.push(renderer)
    await expect(renderer.render(data)).rejects.toThrow('timed out')
    await expect(renderer.close()).rejects.toThrow('timed out')
    await Promise.all(exits)
  })

  test('closing with pending work settles it and does not turn failure into success', async () => {
    const renderer = await pool(['hang'])
    const pixels = renderer.render(data)
    await expect(renderer.close()).rejects.toThrow('pending')
    await expect(pixels).rejects.toThrow('pending')
    await expect(renderer.close()).rejects.toThrow('pending')
  })

  test('one failing export pool cannot terminate another pool', async () => {
    const failed = await pool(['crash'])
    const healthy = await pool(['normal'])
    await expect(failed.render(data)).rejects.toThrow('raster crash')
    expect([...(await healthy.render(data))]).toEqual(Array(16).fill(1))
    await healthy.close()
  })

  test('real WASM workers initialize fonts and preserve complete-frame pixels', async () => {
    const renderer = await createFramePool({ width: 18, height: 22 }, 2)
    pools.push(renderer)
    const [first, second] = await Promise.all([renderer.render(data), renderer.render(data)])
    expect(first.byteLength).toBe(18 * 22 * 4)
    expect(first).toEqual(second)
    expect(first.some((value, index) => index % 4 !== 3 && value > 100)).toBe(true)
    await renderer.close()
  })


  test('encoder abort interrupts partial worker startup without waiting for the startup deadline', async () => {
    const abort = new AbortController()
    const starting = createFramePool(profile, 2, { spawnWorker: factory(['normal', 'startup-hang']), signal: abort.signal })
    abort.abort(new Error('encoder stopped'))
    await expect(starting).rejects.toThrow('encoder stopped')
    await Promise.all(exits)
  })

  test('encoder abort settles a busy pool and preserves the first failure', async () => {
    const abort = new AbortController()
    const renderer = await createFramePool(profile, 1, { spawnWorker: factory(['hang']), signal: abort.signal })
    pools.push(renderer)
    const pixels = renderer.render(data)
    abort.abort(new Error('encoder write failed'))
    await expect(pixels).rejects.toThrow('encoder write failed')
    await expect(renderer.close()).rejects.toThrow('encoder write failed')
  })


  test('a non-cloneable snapshot rejects every outstanding result and closes the pool', async () => {
    const renderer = await pool(['hang', 'normal'])
    const pending = renderer.render(data)
    const invalid = { ...data, notCloneable: () => {} }
    const rejected = renderer.render(invalid)
    expect((await Promise.allSettled([pending, rejected])).map(result => result.status)).toEqual(['rejected', 'rejected'])
    await expect(renderer.close()).rejects.toThrow()
  })

  test('shutdown acknowledgement timeout cannot report successful close', async () => {
    const spawn = factory(['normal'])
    const renderer = await createFramePool(profile, 1, { shutdownMs: 100, spawnWorker: () => {
      const worker = spawn()
      const terminate = worker.terminate.bind(worker)
      worker.terminate = async () => { await terminate(); return new Promise<number>(() => {}) }
      return worker
    } })
    pools.push(renderer)
    await expect(renderer.close()).rejects.toThrow('shutdown timed out')
    await Promise.all(exits)
    await expect(renderer.close()).rejects.toThrow('shutdown timed out')
  })


  test('completed external waits detach before later failure and close rejects a live wait', async () => {
    const renderer = await pool(['normal'])
    expect(await renderer.waitFor(Promise.resolve('encoded'))).toBe('encoded')
    await expect(renderer.waitFor(Promise.reject(new Error('write rejected')))).rejects.toThrow('write rejected')
    const waiting = renderer.waitFor(new Promise<never>(() => {}))
    await renderer.close()
    await expect(waiting).rejects.toThrow('closed')
  })
})

describe('export worker lifecycle', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'tuistory-worker-export-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
  const videoTest = spawnSync('ffmpeg', ['-version']).status === 0 ? test : test.skip

  for (const mode of ['crash', 'idle-crash', 'encoder-startup-failure', 'encoder-finish-failure', 'ordered', 'shutdown-error']) {
    videoTest(`${mode} preserves export ordering, publication and worker cleanup contracts`, async () => {
      await writeFile(path.join(directory, 'worker.mjs'), `
import {parentPort as p,workerData as settings} from 'node:worker_threads';
if(settings.mode !== 'encoder-startup-failure') p.postMessage({kind:'ready'});
p.on('message',({id})=>{
 if(settings.mode === 'crash') throw Error('controlled raster crash');
 const pixels=new Uint8Array(settings.width*settings.height*4).fill(10*(id+1));
 const send=()=>p.postMessage({kind:'frame',id,width:settings.width,height:settings.height,pixels},[pixels.buffer]);
 setTimeout(send,settings.mode==='ordered' && id===0?80:0);
 if(settings.mode==='idle-crash') setTimeout(()=>{throw Error('controlled idle crash')},10);
});
`)
      await writeFile(path.join(directory, 'runner.mjs'), `
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url), threads=require('node:worker_threads'), child=require('node:child_process');
const Original=threads.Worker, spawn=child.spawn, mode=${JSON.stringify(mode)};
let created=0,exited=0,pending=0,maxPending=0;const written=[],events=[],publishedAtExit=[];
threads.Worker=class extends Original {
 constructor(url,options){
 super(new URL('./worker.mjs',import.meta.url),{workerData:{...options.workerData,mode}});created++;
 this.once('exit',()=>{exited++;publishedAtExit.push(require('node:fs').existsSync(new URL('./video.mp4',import.meta.url)))});
 if(mode==='shutdown-error'){const stop=this.terminate.bind(this),delay=created===2?75:0;this.terminate=async()=>{if(delay)await new Promise(resolve=>setTimeout(resolve,delay));await stop();throw Error('controlled shutdown failure')};}
 const post=this.postMessage.bind(this);this.postMessage=(message,...rest)=>{events.push('dispatch-'+message.id);return post(message,...rest)};
}
};
child.spawn=(command,args,options)=>{
 const process=mode==='encoder-startup-failure'?spawn(globalThis.process.execPath,['-e','setTimeout(()=>process.exit(2),100)'],options):mode==='encoder-finish-failure'?spawn(globalThis.process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("controlled encoder failure after EOF");process.exitCode=17})'],options):spawn(command,args,options);
 if(mode==='idle-crash' || mode==='ordered'){
  const write=process.stdin.write.bind(process.stdin);
  process.stdin.write=(bytes,callback)=>{written.push(bytes[0]);pending++;maxPending=Math.max(maxPending,pending);return write(bytes,error=>setTimeout(()=>{pending--;events.push('ack-'+written.length);callback(error)},mode==='idle-crash'?200:20))};
 }
 return process;
};
syncBuiltinESMExports();
if(mode==='ordered') {
 const {PersistentTerminal}=await import(pathToFileURL(require.resolve('ghostty-opentui',{paths:[process.cwd()]})));
 const get=PersistentTerminal.prototype.getJson;
 PersistentTerminal.prototype.getJson=function(options){if(options?.limit===2)events.push('snapshot');return get.call(this,options)};
}
const {exportRecording}=await import(pathToFileURL(process.argv[2]));
const input=new URL('./source.cast',import.meta.url).pathname,output=new URL('./video.mp4',import.meta.url).pathname;
const source=JSON.stringify({version:3,term:{cols:8,rows:2}})+'\\n'+JSON.stringify([0,'o','hello'])+'\\n'+(mode==='ordered'?JSON.stringify([0.1,'o','B'])+'\\n'+JSON.stringify([0.1,'o','C'])+'\\n'+JSON.stringify([0.1,'m','end']):JSON.stringify([0.3,'m','end']))+'\\n';
await writeFile(input,source);
let error='';
try {await exportRecording({inputPath:input,outputPath:output})} catch(e){error=e.message}
const files=await readdir(new URL('.',import.meta.url));
console.log(JSON.stringify({error,created,exited,written,events,maxPending,publishedAtExit,unchanged:await readFile(input,'utf8')===source,published:files.includes('video.mp4'),partial:files.some(name=>name.startsWith('.tuistory-export-'))}));
`)
      const exporter = path.resolve('src', 'recording.ts')
      const builtExporter = path.resolve('dist', 'recording.js')
      const result = spawnSync(process.execPath, [path.join(directory, 'runner.mjs'), process.versions.bun ? exporter : builtExporter], { encoding: 'utf8', timeout: 15_000 })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const observation = JSON.parse(result.stdout.trim())
      if (mode === 'ordered') {
        expect(observation.error).toBe('')
        expect(observation.written).toEqual([10, 10, 10, 20, 20, 20, 30, 30, 30, 30])
        expect(observation.maxPending).toBe(1)
        expect(observation.events.indexOf('dispatch-2')).toBeGreaterThan(observation.events.indexOf('ack-3'))
        const snapshots = observation.events.flatMap((value: string, index: number) => value === 'snapshot' ? [index] : [])
        expect(snapshots.length).toBe(3)
        expect(snapshots[2]).toBeGreaterThan(observation.events.indexOf('ack-3'))
        expect(observation.publishedAtExit.every((value: boolean) => !value)).toBe(true)
      } else if (mode === 'encoder-finish-failure') {
        expect(observation.error).toBe('FFmpeg failed with exit code 17\nFFmpeg: controlled encoder failure after EOF')
      } else expect(observation.error).toContain(mode === 'encoder-startup-failure' ? 'FFmpeg' : 'controlled')
      expect(observation.created).toBeGreaterThan(0)
      expect(observation.exited).toBe(observation.created)
      expect(observation.unchanged).toBe(true)
      expect(observation.published).toBe(mode === 'ordered')
      expect(observation.partial).toBe(false)
    }, 20_000)
  }

  test('completed frame waits do not retain earlier frame buffers until pool shutdown', async () => {
    await writeFile(path.join(directory, 'gc-worker.mjs'), `
import {parentPort as port} from 'node:worker_threads';
port.on('message',({id})=>{const pixels=new Uint8Array(16);port.postMessage({kind:'frame',id,width:2,height:2,pixels},[pixels.buffer])});
port.postMessage({kind:'ready'});
`)
    await writeFile(path.join(directory, 'gc-runner.mjs'), `
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
const {createFramePool}=await import(pathToFileURL(process.argv[2]));
const renderer=await createFramePool({width:2,height:2},1,{spawnWorker:()=>new Worker(new URL('./gc-worker.mjs',import.meta.url),{execArgv:[]})});
async function collect() {
 const refs=[];
 for(let i=0;i<32;i++) {
  const frame=await renderer.waitFor(renderer.render({}));
  refs.push(new WeakRef(frame));
 }
 return refs;
}
const refs=await collect();
for(let i=0;i<4;i++) {await new Promise(resolve=>setImmediate(resolve));if(globalThis.Bun)Bun.gc(true);else globalThis.gc();}
const retained=refs.filter(ref=>ref.deref()!==undefined).length;
await renderer.close();
console.log(JSON.stringify({retained}));
`)
    const module = path.resolve(process.versions.bun ? 'src/recording.ts' : 'dist/recording.js')
    const flags = process.versions.bun ? [] : ['--expose-gc']
    const result = spawnSync(process.execPath, [...flags, path.join(directory, 'gc-runner.mjs'), module], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).retained).toBeLessThanOrEqual(2)
  }, 15_000)
})
