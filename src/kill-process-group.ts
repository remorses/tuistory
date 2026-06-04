// Kill an entire PTY process group instead of only the leader process.
//
// A PTY child spawned by zigpty / Bun is a session and process-group leader,
// so its process-group id equals its pid. Signaling the negative pid
// (`process.kill(-pid)`) delivers the signal to every process in that group,
// including grandchildren like `pnpm` and `vite` that a `sh -c` wrapper
// spawned. Signaling only the positive leader pid (what the underlying PTY
// libraries do) leaves those grandchildren orphaned, still holding their
// ports — which causes EADDRINUSE on the next launch/restart.

const isWindows = process.platform === 'win32'

/**
 * Terminate the process group led by `pid`.
 *
 * 1. SIGTERM the group so children can clean up.
 * 2. After `graceMs`, SIGKILL the group in case anything ignored SIGTERM.
 *
 * If the group signal fails (e.g. the leader already exited, or on Windows
 * where process groups don't work this way), `fallbackLeaderKill` is invoked
 * so the caller's single-process kill still runs.
 */
export function killProcessGroup(
  pid: number | undefined,
  fallbackLeaderKill: () => void,
  graceMs = 2000,
): void {
  // Windows has no POSIX process groups; defer entirely to the PTY's own kill.
  if (isWindows || !pid || pid <= 1) {
    fallbackLeaderKill()
    return
  }

  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }

  const reachedGroup = signalGroup('SIGTERM')
  if (!reachedGroup) {
    // Group is gone or unreachable — make sure the leader itself is killed.
    fallbackLeaderKill()
    return
  }

  // Escalate to SIGKILL for anything that ignored SIGTERM. The group may
  // already be gone by then, in which case the kill is a harmless no-op.
  const timer = setTimeout(() => {
    signalGroup('SIGKILL')
  }, graceMs)
  // Don't keep the event loop (or the daemon) alive just for the escalation.
  // tuistory's primary caller is the long-lived daemon, where this is correct:
  // the daemon stays up long past graceMs so the SIGKILL always fires, and we
  // avoid pinning the loop for 2s after every session close. Trade-off: a
  // direct library caller that invokes close() and immediately lets the
  // process exit may skip the SIGKILL — for a SIGTERM-ignoring grandchild,
  // close() is then best-effort. Such callers should keep the process alive
  // (or await exit) if they need a hard guarantee.
  timer.unref?.()
}
