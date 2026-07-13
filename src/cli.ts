import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  statSync,
  createReadStream,
  watch,
} from 'node:fs'
import { config } from './config.js'
import { queryStatus } from './ipc.js'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}

function entryScriptPath(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url))
}

function readPid(): number | null {
  if (!existsSync(config.paths.pidFile)) return null
  const raw = readFileSync(config.paths.pidFile, 'utf-8').trim()
  const pid = parseInt(raw, 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

function cleanupStaleFiles(): void {
  for (const f of [config.paths.pidFile, config.paths.sockFile]) {
    try {
      unlinkSync(f)
    } catch {
      // ignore
    }
  }
}

export async function start(): Promise<void> {
  const existingPid = readPid()
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`feishu-pi-bridge already running, pid=${existingPid}`)
    process.exit(1)
  }
  cleanupStaleFiles()

  const { openSync } = await import('node:fs')
  const out = openSync(config.paths.logFile, 'a')
  const err = openSync(config.paths.logFile, 'a')
  const child = spawn(process.execPath, [entryScriptPath(), 'daemon'], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: process.cwd(),
    env: process.env,
  })
  child.unref()

  await sleep(300)
  if (child.pid && isProcessAlive(child.pid)) {
    console.log(`feishu-pi-bridge started, pid=${child.pid}`)
    console.log(`  log:  ${config.paths.logFile}`)
    console.log(`  sock: ${config.paths.sockFile}`)
  } else {
    console.error('feishu-pi-bridge failed to start; check log:')
    console.error(`  ${config.paths.logFile}`)
    process.exit(1)
  }
}

export async function stop(): Promise<void> {
  const pid = readPid()
  if (!pid) {
    console.log('feishu-pi-bridge not running (no pid file)')
    cleanupStaleFiles()
    return
  }
  if (!isProcessAlive(pid)) {
    console.log('feishu-pi-bridge was not running, cleaned up stale files')
    cleanupStaleFiles()
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    cleanupStaleFiles()
    console.log('feishu-pi-bridge stopped (kill failed, cleaned files)')
    return
  }

  for (let i = 0; i < 50; i++) {
    await sleep(100)
    if (!isProcessAlive(pid)) break
  }

  if (isProcessAlive(pid)) {
    console.error(`daemon did not exit gracefully, SIGKILL pid=${pid}`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
    await sleep(200)
  }

  cleanupStaleFiles()
  console.log('feishu-pi-bridge stopped')
}

export async function restart(): Promise<void> {
  await stop().catch(() => undefined)
  await sleep(300)
  await start()
}

export async function status(): Promise<void> {
  const pid = readPid()
  if (pid && !isProcessAlive(pid)) {
    console.log('feishu-pi-bridge: not running (stale pid file)')
    return
  }

  const resp = await queryStatus()
  if (!resp) {
    console.log('feishu-pi-bridge: not running')
    return
  }

  const uptimeMs = Date.now() - resp.startedAt
  console.log('feishu-pi-bridge: running')
  console.log(`  PID:          ${resp.pid}`)
  console.log(
    `  Started:      ${new Date(resp.startedAt).toLocaleString()} (running ${formatDuration(uptimeMs)})`,
  )
  console.log(`  Log:          ${config.paths.logFile}`)
  console.log(`  Active chats: ${resp.chats.length}`)
  for (const c of resp.chats) {
    const idleMs = Date.now() - c.lastActiveAt
    console.log(
      `    - ${c.chatId} (rpc pid ${c.pid ?? 'n/a'}, last active ${formatDuration(idleMs)} ago)`,
    )
  }
}

export async function logs(opts: { follow: boolean; lines: number }): Promise<void> {
  const logPath = config.paths.logFile
  if (!existsSync(logPath)) {
    console.error(`log file not found: ${logPath}`)
    process.exit(1)
  }

  const content = readFileSync(logPath, 'utf-8')
  const allLines = content.split('\n').filter(Boolean)
  const tail = allLines.slice(-opts.lines)
  for (const line of tail) console.log(line)

  if (!opts.follow) return

  let size = statSync(logPath).size
  const watcher = watch(logPath, () => {
    try {
      const newSize = statSync(logPath).size
      if (newSize > size) {
        const stream = createReadStream(logPath, { start: size, end: newSize })
        stream.on('data', (chunk) => process.stdout.write(chunk))
        size = newSize
      } else if (newSize < size) {
        size = 0
      }
    } catch {
      // file rotated or transient — ignore
    }
  })

  process.on('SIGINT', () => {
    watcher.close()
    process.exit(0)
  })

  return new Promise<void>(() => {
    // runs forever until Ctrl+C
  })
}

export function printHelp(): void {
  console.log(`feishu-pi-bridge - Feishu long-connection bridge to pi RPC

Usage:
  feishu-pi-bridge start              Start daemon (background)
  feishu-pi-bridge stop               Stop daemon
  feishu-pi-bridge restart            Restart daemon
  feishu-pi-bridge status             Show daemon status
  feishu-pi-bridge logs [-f] [-n N]   Tail logs (default 50, -f follow)
  feishu-pi-bridge daily-report       Trigger /daily-report and push to FEISHU_DAILY_REPORT_CHAT_ID
                                      (默认新会话；--keep-session 复用历史 session)
  feishu-pi-bridge help               Show this help

Files:
  PID:   ${config.paths.pidFile}
  Log:   ${config.paths.logFile}
  Sock:  ${config.paths.sockFile}
`)
}

// silence unused-import warnings for writeFileSync (kept for symmetry / future use)
void writeFileSync
