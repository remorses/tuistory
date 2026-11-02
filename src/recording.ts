import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, link, unlink, lstat, mkdtemp, readFile, rm, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PersistentTerminal, type TerminalData, type TerminalLine, type TerminalSpan } from 'ghostty-opentui'
import { renderTerminalToSvg, type RenderImageOptions } from 'ghostty-opentui/image'
import wcwidth from 'wcwidth'
import { z } from 'zod'

export const MAX_RECORDING_COLS = 400
export const MAX_RECORDING_ROWS = 120

export function recordingGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (typeof cols !== 'number' || !Number.isSafeInteger(cols) || cols < 1 || cols > MAX_RECORDING_COLS ||
    typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_RECORDING_ROWS) {
    throw new Error(`Recording geometry must be 1..${MAX_RECORDING_COLS} columns and 1..${MAX_RECORDING_ROWS} rows`)
  }
  return { cols, rows }
}

export interface RecordOptions {
  path: string
  /** Includes encoded events and the in-flight file write. Default 4 MiB. */
  maxQueuedBytes?: number
}

interface StatusFields {
  recordingId: string
  path: string
  partialPath: string
  elapsedSeconds: number
  queuedBytes: number
  maxQueuedBytes: number
}

export type RecordingStatus = StatusFields & (
  | { kind: 'active' }
  | { kind: 'finishing' }
  | { kind: 'saved'; extent: 'process' | 'interval' }
  | { kind: 'partial'; reason: string }
)

export interface RecordingHandle {
  mark(label: string): void
  status(): RecordingStatus
  stop(): Promise<RecordingStatus>
}

type RecorderState =
  | { kind: 'active' }
  | { kind: 'finishing'; extent: 'process' | 'interval' }
  | { kind: 'saved'; extent: 'process' | 'interval' }
  | { kind: 'partial'; reason: string }

export const DEFAULT_RECORDING_QUEUE_BYTES = 4 * 1024 * 1024
const MAX_QUEUE_BYTES = 64 * 1024 * 1024
const CONTROL_RESERVE_BYTES = 128

export class Recorder implements RecordingHandle {
  readonly recordingId = randomUUID()
  readonly path: string
  readonly partialPath: string
  private state: RecorderState = { kind: 'active' }
  private queue: Buffer[] = []
  private queuedBytes = 0
  private pumpPromise: Promise<void> | undefined
  private finishPromise: Promise<RecordingStatus> | undefined
  private writtenBytes = 0
  private startedNs = process.hrtime.bigint()
  private lastUs = 0n
  private cutoffUs: bigint | undefined
  private fileIdentity: { dev: bigint; ino: bigint } | undefined
  private linked = false

  private constructor(
    private file: FileHandle,
    options: RecordOptions,
    private maxQueuedBytes: number,
  ) {
    this.path = path.resolve(options.path)
    this.partialPath = `${this.path}.partial`
  }

  static async prepare(options: RecordOptions & {
    cols: number
    rows: number
    sessionId?: string
  }): Promise<Recorder> {
    if (!options.path || options.path.includes('\0')) throw new Error('Recording path is required')
    recordingGeometry(options.cols, options.rows)
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_RECORDING_QUEUE_BYTES
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 128 || maxQueuedBytes > MAX_QUEUE_BYTES) {
      throw new Error(`Recording queue must be an integer from 128 to ${MAX_QUEUE_BYTES} bytes`)
    }
    const target = path.resolve(options.path)
    try {
      await lstat(target)
      throw new Error(`Recording already exists: ${target}. Choose a new --record path for another run; existing recordings are never overwritten.`)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const file = await open(`${target}.partial`, 'wx', 0o600)
    const recorder = new Recorder(file, options, maxQueuedBytes)
    try {
      recorder.fileIdentity = await file.stat({ bigint: true })
      const header = JSON.stringify({
        version: 3,
        term: { cols: options.cols, rows: options.rows, type: 'xterm-truecolor' },
        tuistory: { recordingId: recorder.recordingId, sessionId: options.sessionId },
      }) + '\n'
      await file.writeFile(header)
      recorder.writtenBytes = Buffer.byteLength(header)
      return recorder
    } catch (error) {
      await file.close()
      throw error
    }
  }

  start(): void {
    this.startedNs = process.hrtime.bigint()
  }

  status(): RecordingStatus {
    const fields: StatusFields = {
      recordingId: this.recordingId,
      path: this.path,
      partialPath: this.partialPath,
      elapsedSeconds: Number(this.cutoffUs ?? this.elapsedUs()) / 1e6,
      queuedBytes: this.queuedBytes,
      maxQueuedBytes: this.maxQueuedBytes,
    }
    switch (this.state.kind) {
      case 'active': return { ...fields, kind: 'active' }
      case 'finishing': return { ...fields, kind: 'finishing' }
      case 'saved': return { ...fields, ...this.state }
      case 'partial': return { ...fields, ...this.state }
    }
  }

  output(text: string): void {
    this.admit('o', text)
  }

  resize(cols: number, rows: number): void {
    if (this.state.kind === 'active') recordingGeometry(cols, rows)
    this.admit('r', `${cols}x${rows}`)
  }

  mark(label: string): void {
    if (typeof label !== 'string' || Buffer.byteLength(label) > 4096) {
      throw new Error('Recording marker must be a string of at most 4096 bytes')
    }
    if (this.state.kind !== 'active') throw new Error(`Recording is ${this.state.kind}`)
    this.admit('m', label)
  }

  stop(): Promise<RecordingStatus> {
    if (this.finishPromise) return this.finishPromise
    if (this.state.kind === 'active') {
      this.admit('m', '', true)
      if (this.state.kind === 'active') this.state = { kind: 'finishing', extent: 'interval' }
    }
    this.cutoffUs ??= this.elapsedUs()
    this.finishPromise = this.complete()
    return this.finishPromise
  }

  finishProcess(info: { exitCode: number; signal: number }): Promise<RecordingStatus> {
    if (this.finishPromise) return this.finishPromise
    if (this.state.kind === 'active') {
      const status = info.signal > 0 ? 128 + info.signal : info.exitCode
      if (!Number.isSafeInteger(status) || status < 0 || status > 255) {
        return this.abort('Main process exit status is unavailable')
      }
      this.admit('x', String(status), true)
      if (this.state.kind === 'active') this.state = { kind: 'finishing', extent: 'process' }
    }
    this.cutoffUs ??= this.elapsedUs()
    this.finishPromise = this.complete()
    return this.finishPromise
  }

  abort(reason: string): Promise<RecordingStatus> {
    if (this.state.kind === 'saved') return this.finishPromise ?? Promise.resolve(this.status())
    if (this.state.kind !== 'partial') this.state = { kind: 'partial', reason }
    this.cutoffUs ??= this.elapsedUs()
    this.finishPromise ??= this.complete()
    return this.finishPromise
  }

  private elapsedUs(): bigint {
    return (process.hrtime.bigint() - this.startedNs) / 1000n
  }

  private admit(code: 'o' | 'r' | 'm' | 'x', data: string, control = false): void {
    if (this.state.kind !== 'active') return
    try {
      const limit = this.maxQueuedBytes - (control ? 0 : CONTROL_RESERVE_BYTES)
      const atUs = this.elapsedUs()
      const delta = Number(atUs - this.lastUs) / 1e6
      const serialized = JSON.stringify([delta, code, data]) + '\n'
      const bytes = Buffer.byteLength(serialized)
      if (bytes > limit - this.queuedBytes) {
        void this.abort('Recording queue capacity exceeded')
        return
      }
      const line = Buffer.from(serialized)
      this.lastUs = atUs
      this.queue.push(line)
      this.queuedBytes += line.length
      this.pumpPromise ??= this.pump()
    } catch (error) {
      void this.abort(`Recording serialization failed: ${String(error)}`)
    }
  }

  private async pump(): Promise<void> {
    try {
      for (let line = this.queue[0]; line; line = this.queue[0]) {
        let offset = 0
        while (offset < line.length) {
          const { bytesWritten } = await this.file.write(line, offset, line.length - offset, this.writtenBytes + offset)
          if (bytesWritten === 0) throw new Error('Recording write made no progress')
          offset += bytesWritten
        }
        this.writtenBytes += line.length
        this.queue.shift()
        this.queuedBytes -= line.length
      }
    } catch (error) {
      this.state = { kind: 'partial', reason: `Recording write failed: ${String(error)}` }
      this.cutoffUs ??= this.elapsedUs()
      this.queue = []
      this.queuedBytes = 0
      try { await this.file.truncate(this.writtenBytes) } catch {}
      void this.abort(this.state.reason)
    } finally {
      this.pumpPromise = undefined
    }
  }

  private async finalize(): Promise<RecordingStatus> {
    try {
      await this.pumpPromise
      await this.file.sync()
      await this.file.close()
      if (this.state.kind === 'finishing') {
        const extent = this.state.extent
        await link(this.partialPath, this.path)
        this.linked = true
        if (this.status().kind === 'partial') {
          await this.cleanupPublished()
          return this.status()
        }
        const directory = await open(path.dirname(this.path), 'r')
        try { await directory.sync() } finally { await directory.close() }
        if (this.status().kind === 'partial') {
          await this.cleanupPublished()
          return this.status()
        }
        this.state = { kind: 'saved', extent }
        this.linked = false
        try { await unlink(this.partialPath) } catch {}
      }
    } catch (error) {
      this.state = { kind: 'partial', reason: `Recording finalization failed: ${String(error)}` }
      await this.cleanupPublished()
      try { await this.file.close() } catch {}
    }
    return this.status()
  }

  private async cleanupPublished(): Promise<void> {
    if (!this.linked) return
    try {
      const current = await lstat(this.path, { bigint: true })
      if (current.dev !== this.fileIdentity?.dev || current.ino !== this.fileIdentity.ino) return
      await unlink(this.path)
      this.linked = false
    } catch {}
  }

  private async complete(): Promise<RecordingStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.finalize(),
        new Promise<RecordingStatus>((resolve) => {
          timer = setTimeout(() => {
            if (this.state.kind !== 'saved') {
              this.state = { kind: 'partial', reason: 'Recording finalization exceeded 5000ms; publication is unconfirmed' }
              void this.cleanupPublished()
            }
            resolve(this.status())
          }, 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface ExportRecordingOptions {
  inputPath: string
  outputPath: string
  fps?: number
  speed?: number
  idleLimit?: number
  from?: number
  to?: number
}

type RecordingEvent =
  | { timeUs: number; kind: 'output'; data: string }
  | { timeUs: number; kind: 'resize'; cols: number; rows: number }
  | { timeUs: number; kind: 'other' }

export interface ParsedRecording {
  cols: number
  rows: number
  maxCols: number
  maxRows: number
  durationUs: number
  events: RecordingEvent[]
}

interface TimelineSegment {
  sourceStart: number
  sourceEnd: number
  videoStart: number
  videoEnd: number
}

export interface RecordingPlan {
  fps: number
  frames: number
  width: number
  height: number
  duration: number
  fromUs: number
  toUs: number
  videoFrom: number
  videoTo: number
  segments: TimelineSegment[]
}

const MAX_BYTES = 32 * 1024 * 1024
const MAX_LINE_BYTES = 256 * 1024
const MAX_EVENTS = 20_000
const MAX_LINES = 50_000
const MAX_SOURCE_SECONDS = 24 * 60 * 60
const MAX_FRAMES = 108_000
const MAX_PIXELS = 4_000_000
const MAX_PIXEL_FRAMES = 20_000_000_000
const MAX_SCROLLBACK_CELLS = 2_000_000
const ENCODER_TIMEOUT = 30_000

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function geometry(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return recordingGeometry(cols, rows)
}

function validText(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) return false
  }
  return true
}

export function parseRecording(bytes: Uint8Array): ParsedRecording {
  if (bytes.byteLength > MAX_BYTES) throw new Error('Recording exceeds the 32 MiB export limit')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Recording must contain valid UTF-8')
  }
  let start = 0
  let lineNumber = 0
  let initial: { cols: number; rows: number } | undefined
  let maxCols = 0
  let maxRows = 0
  let seconds = 0
  let correction = 0
  let durationUs = 0
  const events: RecordingEvent[] = []
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const line = text.slice(start, end).replace(/\r$/, '')
    start = end + 1
    lineNumber++
    if (lineNumber > MAX_LINES) throw new Error('Recording exceeds the 50000 line export limit')
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`Recording line ${lineNumber} exceeds 256 KiB`)
    if (initial && line.startsWith('#')) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Invalid JSON on recording line ${lineNumber}`)
    }
    if (!initial) {
      if (!record(value) || value.version !== 3 || !record(value.term)) {
        throw new Error('Expected an asciicast v3 header with term.cols and term.rows')
      }
      initial = geometry(value.term.cols, value.term.rows)
      maxCols = initial.cols
      maxRows = initial.rows
      continue
    }
    if (events.length >= MAX_EVENTS) throw new Error('Recording exceeds the 20000 event export limit')
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'number' ||
      !Number.isFinite(value[0]) || value[0] < 0 || typeof value[1] !== 'string' ||
      typeof value[2] !== 'string' || !validText(value[1]) || !validText(value[2])) {
      throw new Error(`Invalid asciicast event on line ${lineNumber}`)
    }
    const delta = value[0] - correction
    const next = seconds + delta
    correction = (next - seconds) - delta
    seconds = next
    if (!Number.isFinite(seconds) || seconds > MAX_SOURCE_SECONDS) {
      throw new Error('Recording exceeds the 24 hour source duration limit')
    }
    durationUs = Math.round(seconds * 1_000_000)
    const code = value[1]
    const data = value[2]
    if (code === 'o') {
      events.push({ timeUs: durationUs, kind: 'output', data })
    } else if (code === 'r') {
      const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(data)
      if (!match) throw new Error(`Invalid resize on recording line ${lineNumber}`)
      const size = geometry(Number(match[1]), Number(match[2]))
      maxCols = Math.max(maxCols, size.cols)
      maxRows = Math.max(maxRows, size.rows)
      events.push({ timeUs: durationUs, kind: 'resize', ...size })
    } else {
      if (code === 'x' && (!/^(0|[1-9]\d*)$/.test(data) || Number(data) > 255)) {
        throw new Error(`Invalid exit status on recording line ${lineNumber}`)
      }
      events.push({ timeUs: durationUs, kind: 'other' })
    }
  }
  if (!initial) throw new Error('Recording is empty')
  return { ...initial, maxCols, maxRows, durationUs, events }
}

function optionNumber(value: number | undefined, fallback: number, name: string, allowZero = false): number {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isFinite(result) || (allowZero ? result < 0 : result <= 0)) {
    throw new Error(`${name} must be a finite ${allowZero ? 'nonnegative' : 'positive'} number`)
  }
  return result
}

function mappedTime(segments: TimelineSegment[], sourceUs: number): number {
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (segments[middle].sourceEnd < sourceUs) low = middle + 1
    else high = middle
  }
  const segment = segments[low]
  if (!segment) return segments.at(-1)?.videoEnd ?? 0
  return segment.videoStart + (sourceUs - segment.sourceStart) /
    (segment.sourceEnd - segment.sourceStart) * (segment.videoEnd - segment.videoStart)
}

export function planRecording(recording: ParsedRecording, options: Omit<ExportRecordingOptions, 'inputPath' | 'outputPath'> = {}): RecordingPlan {
  const fps = optionNumber(options.fps, 30, 'fps')
  if (!Number.isInteger(fps) || fps > 60) throw new Error('fps must be an integer from 1 to 60')
  const speed = optionNumber(options.speed, 1, 'speed')
  if (speed > 1000) throw new Error('speed must not exceed 1000')
  const idleLimit = optionNumber(options.idleLimit, MAX_SOURCE_SECONDS, 'idleLimit')
  const from = optionNumber(options.from, 0, 'from', true)
  const to = optionNumber(options.to, recording.durationUs / 1_000_000, 'to', true)
  const fromUs = Math.round(from * 1_000_000)
  const toUs = Math.round(to * 1_000_000)
  if (fromUs > toUs || toUs > recording.durationUs) {
    throw new Error('Clip bounds must satisfy 0 <= from <= to <= recording duration')
  }
  const segments: TimelineSegment[] = []
  let sourceStart = 0
  let videoStart = 0
  for (const event of recording.events) {
    if (event.timeUs === sourceStart) continue
    const videoEnd = videoStart + Math.min((event.timeUs - sourceStart) / 1_000_000, idleLimit) / speed
    if (!Number.isFinite(videoEnd) || videoEnd <= videoStart) throw new Error('Timing options exceed export precision or duration limits')
    segments.push({ sourceStart, sourceEnd: event.timeUs, videoStart, videoEnd })
    sourceStart = event.timeUs
    videoStart = videoEnd
  }
  const videoFrom = mappedTime(segments, fromUs)
  const videoTo = mappedTime(segments, toUs)
  const sampleSpan = (videoTo - videoFrom) * fps
  const rounded = Math.round(sampleSpan)
  const steps = sampleSpan > 0 ? Math.max(1, Math.abs(sampleSpan - rounded) < 1e-9 ? rounded : Math.ceil(sampleSpan)) : 0
  const frames = steps + 1
  const width = Math.ceil(recording.maxCols * FONT_SIZE * 0.6 / 2) * 2
  const height = Math.ceil(recording.maxRows * Math.round(FONT_SIZE * LINE_HEIGHT) / 2) * 2
  if (!Number.isFinite(frames) || frames > MAX_FRAMES || videoTo - videoFrom > 3600) {
    throw new Error('Export exceeds the one hour or 108000 frame limit')
  }
  if (width * height > MAX_PIXELS || width * height * frames > MAX_PIXEL_FRAMES) {
    throw new Error('Export exceeds the canvas or total rendered pixel limit')
  }
  return { fps, frames, width, height, duration: frames / fps, fromUs, toUs, videoFrom, videoTo, segments }
}

// Both endpoints are sampled. The final source state occupies one complete CFR frame.
export function sourceTimeAtFrame(plan: RecordingPlan, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= plan.frames) throw new Error('Frame index out of range')
  if (index === plan.frames - 1) return plan.toUs
  const time = Math.min(plan.videoFrom + index / plan.fps, plan.videoTo)
  let low = 0
  let high = plan.segments.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (plan.segments[middle].videoEnd < time) low = middle + 1
    else high = middle
  }
  const segment = plan.segments[low]
  if (!segment) return plan.toUs
  return Math.max(plan.fromUs, Math.min(plan.toUs, Math.round(segment.sourceStart +
    (time - segment.videoStart) / (segment.videoEnd - segment.videoStart) *
    (segment.sourceEnd - segment.sourceStart))))
}

function viewport(term: PersistentTerminal, maxCols: number): TerminalData {
  const probe = term.getJson({ limit: 1 })
  if (probe.totalLines * maxCols > MAX_SCROLLBACK_CELLS) throw new Error('Recording exceeds the native scrollback export budget')
  const data = term.getJson({ offset: Math.max(0, probe.totalLines - term.rows), limit: term.rows })
  const lines: TerminalLine[] = []
  for (let row = 0; row < term.rows; row++) {
    const spans = data.lines[row]?.spans ?? []
    const used = spans.reduce((sum, span) => sum + span.width, 0)
    // Explicit background cells retain blank rows in Ghostty's content-trimming image helper.
    lines.push({ spans: [...spans,
      { text: '', fg: null, bg: BACKGROUND, flags: 0, width: Math.max(0, term.cols - used) },
      { text: '', fg: null, bg: BACKGROUND, flags: 0, width: maxCols - term.cols },
    ] })
  }
  return { ...data, cols: maxCols, lines, cursorVisible: false }
}

async function readRecording(inputPath: string): Promise<ParsedRecording> {
  const file = await open(inputPath, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Recording input must be a regular file')
    if (stat.size > MAX_BYTES) throw new Error('Recording exceeds the 32 MiB export limit')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1))
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > stat.size) throw new Error('Recording changed while being read')
    return parseRecording(bytes.subarray(0, length))
  } finally {
    await file.close()
  }
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function encoder(partial: string, { fps, width, height }: Pick<RecordingPlan, 'fps' | 'width' | 'height'>): {
  child: ChildProcessWithoutNullStreams
  ready: Promise<void>
  closed: Promise<{ code: number | null; error?: Error }>
  stderr: () => string
} {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-threads', '1', '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-f', 'mp4', partial], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = Buffer.alloc(0)
  let spawnError: Error | undefined
  child.stdout.resume()
  child.stderr.on('data', (data: Buffer) => { stderr = Buffer.concat([stderr, data]).subarray(-65536) })
  child.stdin.on('error', () => {})
  const ready = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', error => { spawnError = error; reject(new Error(`Unable to start FFmpeg: ${error.message}`)) })
  })
  const closed = new Promise<{ code: number | null; error?: Error }>(resolve => {
    child.once('close', code => resolve({ code, error: spawnError }))
  })
  return { child, ready, closed, stderr: () => stderr.toString('utf8').trim() }
}

export async function exportRecording(options: ExportRecordingOptions): Promise<{
  path: string; frames: number; width: number; height: number; duration: number
}> {
  for (const [name, value] of [['inputPath', options.inputPath], ['outputPath', options.outputPath]]) {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`${name} must be a nonempty path without NUL bytes`)
  }
  const inputPath = path.resolve(options.inputPath)
  const outputPath = path.resolve(options.outputPath)
  if (inputPath === outputPath) throw new Error('Recording input and video output must have different paths')
  for (const key of ['GHOSTTY_OPENTUI_FONT_PATH', 'GHOSTTY_OPENTUI_FALLBACK_FONT_PATH', 'GHOSTTY_OPENTUI_EXTRA_FONT_PATHS']) {
    if (process.env[key]) throw new Error(`Unset ${key} to use the bundled export font profile`)
  }
  const recording = await readRecording(inputPath)
  const plan = planRecording(recording, options)
  try {
    await lstat(outputPath)
    throw new Error(`Video output already exists: ${outputPath}`)
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const directory = await mkdtemp(path.join(path.dirname(outputPath), '.tuistory-export-'))
  const partial = path.join(directory, `${randomUUID()}.mp4.partial`)
  let term: PersistentTerminal | undefined
  let encoding: ReturnType<typeof encoder> | undefined
  let pool: FramePool | undefined
  try {
    const preparedFile = await open(partial, 'wx', 0o600)
    await preparedFile.close()
    term = new PersistentTerminal({ cols: recording.cols, rows: recording.rows })
    encoding = encoder(partial, plan)
    await timeout(encoding.ready, ENCODER_TIMEOUT, 'FFmpeg startup timed out')
    let eventIndex = 0
    const size = Math.min(2, Math.max(1, availableParallelism()), plan.frames) === 1 ? 1 : 2
    const abort = new AbortController()
    let inputFinished = false
    void encoding.closed.then(() => {
      if (!inputFinished) abort.abort(new Error('FFmpeg exited before export completed'))
    })
    const renderer = await createFramePool({ width: plan.width, height: plan.height }, size, { signal: abort.signal })
    pool = renderer
    const runs: Array<{ pixels: Promise<Uint8Array>; repeats: number }> = []
    const stream = encoding.child.stdin
    async function drainRun(): Promise<void> {
      const run = runs[0]
      if (!run) return
      const pixels = await renderer.waitFor(run.pixels)
      const buffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      for (let repeat = 0; repeat < run.repeats; repeat++) {
        await renderer.waitFor(timeout(new Promise<void>((resolve, reject) => {
          stream.write(buffer, error => error ? reject(error) : resolve())
        }), ENCODER_TIMEOUT, 'FFmpeg input timed out'))
      }
      runs.shift()
    }
    for (let frame = 0; frame < plan.frames; frame++) {
      const sourceUs = sourceTimeAtFrame(plan, frame)
      let changed = false
      while (eventIndex < recording.events.length && recording.events[eventIndex].timeUs <= sourceUs) {
        const event = recording.events[eventIndex++]
        if (event.kind === 'output') {
          const bytes = Buffer.from(event.data)
          for (let offset = 0; offset < bytes.length; offset += 1024) {
            term.feed(bytes.subarray(offset, offset + 1024))
            if (term.getJson({ limit: 1 }).totalLines * recording.maxCols > MAX_SCROLLBACK_CELLS) {
              throw new Error('Recording exceeds the native scrollback export budget')
            }
          }
          changed = true
        } else if (event.kind === 'resize') {
          term.resize(event.cols, event.rows)
          changed = true
        }
      }
      if (runs.length === 0 || changed) {
        if (runs.length === size) await drainRun()
        const pixels = renderer.render(viewport(term, recording.maxCols))
        void pixels.catch(() => {})
        runs.push({ pixels, repeats: 1 })
      } else {
        runs[runs.length - 1].repeats++
      }
    }
    while (runs.length) await drainRun()
    inputFinished = true
    encoding.child.stdin.end()
    const result = await renderer.waitFor(timeout(encoding.closed, ENCODER_TIMEOUT, 'FFmpeg completion timed out'))
    if (result.error || result.code !== 0) throw new Error(`FFmpeg failed${result.code === null ? '' : ` with exit code ${result.code}`}${result.error ? `: ${result.error.message}` : ''}`)
    await renderer.close()
    const file = await open(partial, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size === 0) throw new Error('FFmpeg produced an empty video')
      await file.sync()
    } finally {
      await file.close()
    }
    await link(partial, outputPath)
    return { path: outputPath, frames: plan.frames, width: plan.width, height: plan.height, duration: plan.duration }
  } catch (error) {
    const stopped = pool?.close().catch(() => {})
    if (encoding) {
      encoding.child.stdin.destroy()
      if (encoding.child.exitCode === null) encoding.child.kill('SIGKILL')
      await timeout(encoding.closed, 2000, 'FFmpeg cleanup timed out').catch(() => {})
      await stopped
      const details = encoding.stderr()
      if (details && error instanceof Error) throw new Error(`${error.message}\nFFmpeg: ${details}`, { cause: error })
    }
    await stopped
    throw error
  } finally {
    term?.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}

export interface FramePool {
  render(snapshot: TerminalData): Promise<Uint8Array>
  waitFor<T>(operation: Promise<T>): Promise<T>
  close(): Promise<void>
}

interface PoolOptions {
  signal?: AbortSignal
  spawnWorker?: (profile: RenderProfile) => Worker
  startupMs?: number
  renderMs?: number
  shutdownMs?: number
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

type PendingFrame = ReturnType<typeof deferred<Uint8Array>> & { id: number; timer: ReturnType<typeof setTimeout> }
type SlotState = { kind: 'starting' | 'idle' | 'stopping' | 'exited' } | { kind: 'busy'; job: PendingFrame }
interface Slot {
  worker: Worker
  state: SlotState
  ready: ReturnType<typeof deferred<void>>
  exited: ReturnType<typeof deferred<void>>
}
type PoolState = { kind: 'starting' | 'active' | 'closing' | 'closed' } | { kind: 'failed'; error: Error }

const replySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('frame'), id: z.number().int().nonnegative(), width: z.number().int(), height: z.number().int(), pixels: z.instanceof(Uint8Array) }),
  z.object({ kind: z.literal('error'), message: z.string().max(4096) }),
])

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export async function createFramePool(profile: RenderProfile, size: 1 | 2, options: PoolOptions = {}): Promise<FramePool> {
  if (![1, 2].includes(size) || !Number.isSafeInteger(profile.width) || !Number.isSafeInteger(profile.height) ||
      profile.width < 1 || profile.height < 1 || profile.width * profile.height > 4_000_000) {
    throw new Error('Invalid render pool geometry or size')
  }
  const spawnWorker = options.spawnWorker ?? (profile => new Worker(new URL(import.meta.resolve('./recording-render-worker.js')), { workerData: profile }))
  const failure = deferred<never>()
  const waiters = new Set<(error: Error) => void>()
  const slots: Slot[] = []
  let state: PoolState = { kind: 'starting' }
  let nextId = 0
  let closing: Promise<void> | undefined

  function fail(reason: unknown): void {
    if (state.kind === 'failed' || state.kind === 'closed') return
    const error = asError(reason)
    state = { kind: 'failed', error }
    failure.reject(error)
    for (const reject of waiters) reject(error)
    waiters.clear()
    for (const slot of slots) {
      slot.ready.reject(error)
      if (slot.state.kind === 'busy') {
        clearTimeout(slot.state.job.timer)
        slot.state.job.reject(error)
      }
      if (slot.state.kind !== 'exited') slot.state = { kind: 'stopping' }
    }
    void close().catch(() => {})
  }

  function close(): Promise<void> {
    closing ??= Promise.resolve().then(async () => {
      if (state.kind !== 'failed' && slots.some(slot => slot.state.kind === 'busy')) fail(new Error('Render pool closed with pending frames'))
      if (state.kind !== 'failed') state = { kind: 'closing' }
      for (const reject of waiters) reject(new Error('Render pool is closed'))
      waiters.clear()
      const stopped = Promise.all(slots.map(async slot => {
        if (slot.state.kind === 'exited') return
        slot.state = { kind: 'stopping' }
        try { await slot.worker.terminate() } catch (error) { fail(error) }
        await slot.exited.promise
      }))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([stopped, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Render worker shutdown timed out')), options.shutdownMs ?? 5000)
        })])
      } catch (error) {
        fail(error)
        throw state.kind === 'failed' ? state.error : error
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      if (state.kind === 'failed') throw state.error
      state = { kind: 'closed' }
    })
    return closing
  }

  function throwIfFailed(): void {
    if (state.kind === 'failed') throw state.error
  }

  const onAbort = () => fail(options.signal?.reason ?? new Error('Render export aborted'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const startupTimer = setTimeout(() => fail(new Error('Render worker startup timed out')), options.startupMs ?? 30_000)
  try {
    for (let index = 0; index < size; index++) {
      throwIfFailed()
      const worker = spawnWorker(profile)
      const slot: Slot = { worker, state: { kind: 'starting' }, ready: deferred<void>(), exited: deferred<void>() }
      slots.push(slot)
      worker.on('error', error => fail(new Error(`Render worker failed: ${asError(error).message}`, { cause: error })))
      worker.on('messageerror', error => fail(new Error('Render worker message could not be decoded', { cause: error })))
      worker.once('exit', code => {
        const expected = slot.state.kind === 'stopping'
        if (!expected) fail(new Error(`Render worker exited unexpectedly with code ${code}`))
        slot.state = { kind: 'exited' }
        slot.exited.resolve()
      })
      worker.on('message', (message: unknown) => {
        if (state.kind === 'failed' || state.kind === 'closing' || state.kind === 'closed') return
        const parsed = replySchema.safeParse(message)
        if (!parsed.success) { fail(new Error('Invalid render worker response')); return }
        const reply = parsed.data
        if (reply.kind === 'error') { fail(new Error(`Render worker failed: ${reply.message}`)); return }
        if (reply.kind === 'ready' && slot.state.kind === 'starting') {
          slot.state = { kind: 'idle' }
          slot.ready.resolve()
          return
        }
        if (reply.kind !== 'frame' || slot.state.kind !== 'busy') { fail(new Error('Unsolicited render worker response')); return }
        const job = slot.state.job
        if (reply.id !== job.id || reply.width !== profile.width || reply.height !== profile.height || reply.pixels.byteLength !== profile.width * profile.height * 4) {
          fail(new Error('Render worker frame does not match its request'))
          return
        }
        clearTimeout(job.timer)
        slot.state = { kind: 'idle' }
        job.resolve(reply.pixels)
      })
    }
    await Promise.race([Promise.all(slots.map(slot => slot.ready.promise)), failure.promise])
    throwIfFailed()
    state = { kind: 'active' }
  } catch (error) {
    fail(error)
    await close().catch(() => {})
    throw error
  } finally { clearTimeout(startupTimer) }

  return {
    waitFor<T>(operation: Promise<T>): Promise<T> {
      const result = deferred<T>()
      const onFailure = (error: Error) => { waiters.delete(onFailure); result.reject(error) }
      waiters.add(onFailure)
      if (state.kind === 'failed') onFailure(state.error)
      else if (state.kind !== 'active') onFailure(new Error('Render pool is closed'))
      operation.then(value => { waiters.delete(onFailure); result.resolve(value) }, error => {
        waiters.delete(onFailure)
        result.reject(error)
      })
      return result.promise
    },
    close,
    render(snapshot) {
      if (state.kind === 'failed') return Promise.reject(state.error)
      if (state.kind !== 'active') return Promise.reject(new Error('Render pool is closed'))
      const slot = slots.find(slot => slot.state.kind === 'idle')
      if (!slot) return Promise.reject(new Error('Render pool has no idle worker'))
      const id = nextId++
      const result = deferred<Uint8Array>()
      const timer = setTimeout(() => fail(new Error(`Render frame ${id} timed out`)), options.renderMs ?? 30_000)
      slot.state = { kind: 'busy', job: { ...result, id, timer } }
      try { slot.worker.postMessage({ id, data: snapshot }) } catch (error) { fail(error) }
      return result.promise
    },
  }
}

// The public CommonJS wrapper has separate WASM state from Ghostty's ESM screenshot renderer.
const { Resvg, initWasm }: typeof import('@resvg/resvg-wasm') = createRequire(import.meta.url)('@resvg/resvg-wasm')

export const BACKGROUND = '#1a1b26'
const TEXT = '#c0caf5'
export const FONT_SIZE = 14
export const LINE_HEIGHT = 1.5
const BUNDLED_FONT = fileURLToPath(new URL('../public/jetbrains-mono-nerd.ttf', import.meta.resolve('ghostty-opentui/image')))
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const measureColumns: (text: string) => number = wcwidth
let imageResources: Promise<Uint8Array[]> | undefined

export interface RenderProfile { width: number; height: number }

function isEmojiGrapheme(text: string): boolean {
  return EMOJI_PRESENTATION.test(text) || text.includes('\ufe0f') && PICTOGRAPHIC.test(text)
}

function emojiFontRuns(span: TerminalSpan): TerminalSpan[] {
  const cells = Array.from(GRAPHEMES.segment(span.text), ({ segment }) => ({
    text: segment, width: Math.max(1, measureColumns(segment)), emoji: isEmojiGrapheme(segment),
  }))
  if (!cells.some(cell => cell.emoji)) return [span]
  // Match Ghostty's span.width reconciliation, including native widths for combined emoji.
  let width = cells.reduce((sum, cell) => sum + cell.width, 0)
  for (let index = cells.length - 1; width > span.width && index >= 0; index--) {
    const cell = cells[index]
    const reduction = Math.min(cell.width - 1, width - span.width)
    cell.width -= reduction
    width -= reduction
  }
  const last = cells.at(-1)
  if (width < span.width && last) last.width += span.width - width
  const runs: TerminalSpan[] = []
  let ordinary: TerminalSpan | undefined
  for (const cell of cells) {
    if (cell.emoji) {
      runs.push({ ...span, text: cell.text, width: cell.width })
      ordinary = undefined
    } else if (ordinary) {
      ordinary.text += cell.text
      ordinary.width += cell.width
    } else {
      ordinary = { ...span, text: cell.text, width: cell.width }
      runs.push(ordinary)
    }
  }
  return runs
}

export async function initializeRenderer(): Promise<Uint8Array[]> {
  imageResources ??= (async () => {
    await initWasm(await readFile(new URL(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))))
    const directory = path.dirname(BUNDLED_FONT)
    return Promise.all([
      BUNDLED_FONT,
      ...['symbols-nerd-font-mono-regular.ttf', 'noto-sans-regular.ttf', 'noto-sans-symbols-regular.ttf',
        'noto-sans-symbols-2-regular.ttf', 'noto-sans-cjk-sc-regular.otf'].map(name => path.join(directory, name)),
    ].map(file => readFile(file)))
  })()
  return imageResources
}

export async function renderFrame(data: TerminalData, profile: RenderProfile): Promise<Uint8Array<ArrayBuffer>> {
  const options: RenderImageOptions = {
    ...profile, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, paddingX: 0, paddingY: 0,
    devicePixelRatio: 1, fontPath: BUNDLED_FONT,
    theme: { background: BACKGROUND, text: TEXT }, frameColor: BACKGROUND,
  }
  const fonts = await initializeRenderer()
  // The primary font covers printable ASCII; every other character keeps the full fallback order.
  const ascii = data.lines.every(line => line.spans.every(span => !/[^\x20-\x7e]/.test(span.text)))
  const fontBuffers = ascii ? fonts.slice(0, 1) : fonts
  // Isolate unsupported emoji so fallback glyph widths cannot shift neighboring text.
  const runs = { ...data, lines: data.lines.map(line => ({ spans: line.spans.flatMap(emojiFontRuns) })) }
  const svg = renderTerminalToSvg(runs, options)
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 1 },
    font: { fontBuffers, defaultFontFamily: 'JetBrainsMono Nerd Font', monospaceFamily: 'JetBrainsMono Nerd Font' },
  })
  try {
    const image = renderer.render()
    try {
      return new Uint8Array(image.pixels)
    } finally {
      image.free()
    }
  } finally {
    renderer.free()
  }
}
