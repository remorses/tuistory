/*
 * Native loading and PTY I/O adapted from zigpty 0.2.1.
 * MIT License
 * Copyright (c) Pooya Parsa <pooya@pi0.io>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tty from 'node:tty'
import { killProcessGroup } from './kill-process-group.js'
import type { IPty, SpawnOptions } from './pty-node.js'

export type PtyExit = { exitCode: number; signal: number }
export type PtyDrain = { kind: 'eof' } | { kind: 'error'; reason: string }

export interface RecordedPty extends IPty {
  exited: Promise<PtyExit>
  drained: Promise<PtyDrain>
  dispose(): void
}

interface NativeBinding {
  fork(command: string, args: string[], env: string[], cwd: string, cols: number, rows: number,
    uid: number, gid: number, utf8: boolean, exit: (info: unknown) => void): unknown
  resize(fd: number, cols: number, rows: number, pixelWidth: number, pixelHeight: number): void
}

function isBinding(value: unknown): value is NativeBinding {
  return typeof value === 'object' && value !== null && 'fork' in value && typeof value.fork === 'function'
    && 'resize' in value && typeof value.resize === 'function'
}

function isForkResult(value: unknown): value is { pid: number; fd: number } {
  return typeof value === 'object' && value !== null && 'pid' in value && typeof value.pid === 'number'
    && Number.isSafeInteger(value.pid) && value.pid > 1 && 'fd' in value && typeof value.fd === 'number'
    && Number.isSafeInteger(value.fd) && value.fd >= 0
}

function parseExit(value: unknown): PtyExit {
  if (typeof value !== 'object' || value === null || !('exitCode' in value) || !('signal' in value)
    || typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode)
    || typeof value.signal !== 'number' || !Number.isSafeInteger(value.signal) || value.signal < 0) {
    return { exitCode: -1, signal: 0 }
  }
  return { exitCode: value.exitCode, signal: value.signal }
}

let binding: NativeBinding | undefined
function loadBinding(): NativeBinding {
  if (binding) return binding
  const require = createRequire(import.meta.url)
  const directory = path.resolve(path.dirname(require.resolve('zigpty')), '..')
  const platform = os.platform() === 'android' ? 'linux' : os.platform()
  const base = path.join(directory, 'prebuilds', `zigpty.${platform}-${os.arch()}`)
  let loaded: unknown
  try { loaded = require(`${base}.node`) } catch { loaded = require(`${base}-musl.node`) }
  if (!isBinding(loaded)) throw new Error('Unsupported zigpty native binding')
  binding = loaded
  return binding
}

export function spawnNative(command: string, args: string[], options: SpawnOptions): RecordedPty {
  const native = loadBinding()
  const env = { ...process.env, ...options.env, TERM: options.env?.TERM ?? 'xterm-truecolor' }
  const sanitize = new Set(['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'TERMCAP', 'COLUMNS', 'LINES'])
  const pairs = Object.entries(env).flatMap(([key, value]) => value === undefined || sanitize.has(key) ? [] : [`${key}=${value}`])
  let resolveExit: (info: PtyExit) => void = () => {}
  let resolveDrain: (info: PtyDrain) => void = () => {}
  const exited = new Promise<PtyExit>((resolve) => { resolveExit = resolve })
  const drained = new Promise<PtyDrain>((resolve) => { resolveDrain = resolve })
  let exitInfo: PtyExit | undefined
  let exitCallback: ((info: PtyExit) => void) | undefined
  let dataCallback: ((text: string) => void) | undefined
  const buffered: string[] = []
  let drainDone = false
  let disposed = false
  let killed = false
  let writing = false
  const writes: Buffer[] = []
  let writeOffset = 0
  const decoder = new TextDecoder()
  const emit = (text: string) => {
    if (!text) return
    if (dataCallback) { try { dataCallback(text) } catch {} }
    else buffered.push(text)
  }
  const result = native.fork(command, args, pairs, options.cwd ?? process.cwd(), options.cols, options.rows,
    -1, -1, true, (value) => {
      exitInfo = parseExit(value)
      resolveExit(exitInfo)
      try { exitCallback?.(exitInfo) } catch {}
    })
  if (!isForkResult(result)) throw new Error('Invalid zigpty native spawn result')
  let reader: tty.ReadStream
  try { reader = new tty.ReadStream(result.fd) } catch (error) {
    fs.closeSync(result.fd)
    killProcessGroup(result.pid, () => { try { process.kill(result.pid, 'SIGTERM') } catch {} })
    throw error
  }
  const finishDrain = (info: PtyDrain) => {
    if (drainDone) return
    drainDone = true
    emit(decoder.decode())
    resolveDrain(info)
  }
  const destroyReader = () => {
    if (!writing) reader.destroy()
  }
  reader.on('error', (error: NodeJS.ErrnoException) => {
    finishDrain(error.code === 'EIO' ? { kind: 'eof' } : { kind: 'error', reason: error.message })
    disposed = true
    writes.length = 0
    destroyReader()
  })
  reader.on('end', () => {
    finishDrain({ kind: 'eof' })
    disposed = true
    writes.length = 0
    destroyReader()
  })
  reader.on('close', () => finishDrain({ kind: 'error', reason: 'PTY output closed without EOF' }))
  reader.on('data', (data: Buffer) => { if (!drainDone) emit(decoder.decode(data, { stream: true })) })

  const pumpWrites = () => {
    if (writing || disposed || !writes[0]) return
    const data = writes[0]
    writing = true
    fs.write(result.fd, data, writeOffset, data.length - writeOffset, (error, bytes) => {
      writing = false
      if (disposed) { destroyReader(); return }
      if (error?.code === 'EAGAIN') { setImmediate(pumpWrites); return }
      if (error || bytes === 0) { writes.length = 0; writeOffset = 0; return }
      writeOffset += bytes
      if (writeOffset === data.length) { writes.shift(); writeOffset = 0 }
      pumpWrites()
    })
  }
  return {
    pid: result.pid,
    exited,
    drained,
    write(text) {
      if (disposed || exitInfo) return
      const data = Buffer.from(text)
      if (data.length) { writes.push(data); pumpWrites() }
    },
    resize(cols, rows) { if (!disposed) native.resize(result.fd, cols, rows, 0, 0) },
    kill() {
      if (killed) return
      killed = true
      // Signaling only the shell leader leaves grandchildren holding ports.
      // The PTY leader's process group includes those ordinary descendants.
      killProcessGroup(result.pid, () => { try { process.kill(result.pid, 'SIGHUP') } catch {} })
    },
    dispose() {
      finishDrain({ kind: 'error', reason: 'PTY output disposed before EOF' })
      disposed = true
      writes.length = 0
      destroyReader()
    },
    onData(callback) {
      dataCallback = callback
      for (const text of buffered.splice(0)) { try { callback(text) } catch {} }
    },
    onExit(callback) {
      exitCallback = callback
      if (exitInfo) { try { callback(exitInfo) } catch {} }
    },
  }
}
