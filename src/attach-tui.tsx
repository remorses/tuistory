// Fullscreen TUI for attaching to a running tuistory session.
// Uses React + OpenTUI + ghostty-opentui to render the session's PTY output
// and forward keyboard input via WebSocket to the relay daemon.
//
// The component is designed as a composable <AttachView> so that a future
// grid view can render N instances side by side, each with its own WebSocket.
//
// This file runs exclusively under Bun (the CLI re-spawns under Bun if needed),
// so we use the native WebSocket API available in Bun's global scope.

import { createCliRenderer, TextAttributes, type MouseEvent as OpenTUIMouseEvent } from '@opentui/core'
import { createRoot, useKeyboard, useTerminalDimensions, useOnResize, extend } from '@opentui/react'
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer'
import { useRef, useState, useEffect, useCallback } from 'react'

// Register the ghostty-terminal component for JSX use
extend({ 'ghostty-terminal': GhosttyTerminalRenderable })

const DOUBLE_CTRL_TIMEOUT_MS = 450

// Augment JSX types so TypeScript recognizes <ghostty-terminal>
declare module '@opentui/react' {
  interface OpenTUIComponents {
    'ghostty-terminal': typeof GhosttyTerminalRenderable
  }
}

function Button({ label, shortcut, onPress }: {
  label: string
  shortcut?: string
  onPress: () => void
}) {
  const [hovered, setHovered] = useState(false)

  const handleMouseDown = useCallback(
    (event: OpenTUIMouseEvent) => {
      event.stopPropagation()
      onPress()
    },
    [onPress],
  )

  return (
    <box
      onMouseDown={handleMouseDown}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{ flexDirection: 'row' }}
    >
      <text
        fg={hovered ? '#ffffff' : '#1a1a1a'}
        bg={hovered ? '#8b4513' : undefined}
        attributes={hovered ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE}
      >
        {shortcut ? ` [${shortcut}] ${label} ` : ` ${label} `}
      </text>
    </box>
  )
}

interface AttachViewProps {
  sessionName: string
  ws: WebSocket
  /** Called when user wants to detach (session keeps running) */
  onDetach: () => void
  /** Called when user wants to kill the process and detach */
  onKill: () => void
}

/**
 * Self-contained terminal view for a single session. Composable — a future
 * grid view renders N of these in a flex layout, each with its own WebSocket.
 */
function AttachView({ sessionName, ws, onDetach, onKill }: AttachViewProps) {
  const termRef = useRef<GhosttyTerminalRenderable>(null)
  const { width, height } = useTerminalDimensions()
  const [status, setStatus] = useState<string | null>(null)

  // Terminal fills everything except the 1-row status bar
  const termCols = Math.max(20, width)
  const termRows = Math.max(5, height - 1)

  // Send initial attach handshake + resize
  useEffect(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'attach', session: sessionName, cols: termCols, rows: termRows }))
    }
  }, [])

  // Handle incoming WebSocket messages
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      const str = typeof data === 'string' ? data : String(data)

      // Check for JSON control messages (exit, error)
      if (str.startsWith('{')) {
        try {
          const msg = JSON.parse(str)
          if (msg.type === 'exit') {
            setStatus(`Process exited (code ${msg.exitCode})`)
            return
          }
          if (msg.type === 'error') {
            setStatus(`Error: ${msg.message}`)
            return
          }
        } catch {
          // Not JSON, treat as PTY data below
        }
      }

      // Feed PTY data to ghostty terminal renderer
      if (termRef.current) {
        termRef.current.feed(str)
      }
    }

    const onClose = () => {
      setStatus('Connection closed')
    }

    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)

    return () => {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
    }
  }, [ws])

  // Handle resize — tell both the terminal component and the relay
  useOnResize((newWidth, newHeight) => {
    const newCols = Math.max(20, newWidth)
    const newRows = Math.max(5, newHeight - 1)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: newCols, rows: newRows }))
    }
  })

  const pendingCtrlKey = useRef<{
    key: 'c' | 'x'
    sequence: string
    timeout: ReturnType<typeof setTimeout>
  } | null>(null)

  const clearPendingCtrlKey = useCallback(() => {
    if (!pendingCtrlKey.current) return
    clearTimeout(pendingCtrlKey.current.timeout)
    pendingCtrlKey.current = null
  }, [])

  const flushPendingCtrlKey = useCallback(() => {
    const pending = pendingCtrlKey.current
    if (!pending) return
    clearPendingCtrlKey()
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(pending.sequence)
    }
  }, [clearPendingCtrlKey, ws])

  useEffect(() => {
    return () => clearPendingCtrlKey()
  }, [clearPendingCtrlKey])

  useKeyboard((key) => {
    if (key.ctrl && (key.name === 'c' || key.name === 'x') && key.sequence) {
      const pending = pendingCtrlKey.current

      if (pending?.key === 'c' && key.name === 'c') {
        clearPendingCtrlKey()
        onDetach()
        return
      }
      if (pending?.key === 'x' && key.name === 'x') {
        clearPendingCtrlKey()
        onKill()
        return
      }

      flushPendingCtrlKey()
      setStatus(`Press Ctrl+${key.name.toUpperCase()} again to ${key.name === 'c' ? 'detach' : 'kill'}`)
      pendingCtrlKey.current = {
        key: key.name,
        sequence: key.sequence,
        timeout: setTimeout(() => {
          if (pendingCtrlKey.current?.key !== key.name) return
          const sequence = pendingCtrlKey.current.sequence
          pendingCtrlKey.current = null
          setStatus(null)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(sequence)
          }
        }, DOUBLE_CTRL_TIMEOUT_MS),
      }
      return
    }

    flushPendingCtrlKey()

    // Forward all other input to the relay PTY
    if (ws.readyState === WebSocket.OPEN && key.sequence) {
      ws.send(key.sequence)
    }
  })

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      {/* Terminal view fills available space */}
      <box height={termRows} overflow="hidden" width={termCols}>
        <ghostty-terminal
          ref={termRef}
          persistent
          cols={termCols}
          rows={termRows}
          height={termRows}
          width={termCols}
          showCursor
        />
      </box>

      {/* Status bar — orange background like neovim/tmux */}
      <box style={{ height: 1, backgroundColor: '#d08050', flexDirection: 'row', justifyContent: 'space-between' }}>
        <box style={{ flexDirection: 'row' }}>
          <text fg="#1a1a1a" attributes={TextAttributes.BOLD}> {sessionName} </text>
          {status && <text fg="#1a1a1a"> {status} </text>}
        </box>
        <box style={{ flexDirection: 'row' }}>
          <Button label="Detach" shortcut="^C ^C" onPress={onDetach} />
          <Button label="Kill" shortcut="^X ^X" onPress={onKill} />
        </box>
      </box>
    </box>
  )
}

export async function runAttachTui({ sessionName, relayPort }: {
  sessionName: string
  relayPort: number
}): Promise<void> {
  // Connect WebSocket to relay using native WebSocket (available in Bun)
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/attach`)

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')))
    setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000)
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  })

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    try { ws.close() } catch {}
    try { renderer.destroy() } catch {}
  }

  const handleDetach = () => {
    cleanup()
    process.exit(0)
  }

  const handleKill = () => {
    try { ws.send(JSON.stringify({ type: 'kill' })) } catch {}
    // Give a moment for the kill message to propagate before exiting
    setTimeout(() => {
      cleanup()
      process.exit(0)
    }, 100)
  }

  process.on('SIGINT', handleDetach)
  process.on('SIGTERM', handleDetach)

  const root = createRoot(renderer)
  root.render(
    <AttachView
      sessionName={sessionName}
      ws={ws}
      onDetach={handleDetach}
      onKill={handleKill}
    />
  )

  // Keep process alive — the event loop stays open due to WebSocket + renderer
  await new Promise<void>(() => {})
}
