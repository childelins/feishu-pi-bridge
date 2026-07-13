import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import { config } from './config.js'
import { logger } from './logger.js'
import type { PoolSnapshot } from './pi-rpc-pool.js'

export interface StatusResponse {
  ok: true
  pid: number
  startedAt: number
  chats: PoolSnapshot[]
}

interface ErrorResponse {
  ok: false
  error: string
}

export interface IpcServerOptions {
  pid: number
  startedAt: number
  getSnapshot: () => PoolSnapshot[]
}

export class IpcServer {
  private server: Server | null = null

  constructor(private readonly opts: IpcServerOptions) {}

  async start(): Promise<void> {
    const sockPath = config.paths.sockFile
    try {
      unlinkSync(sockPath)
    } catch {
      // sock not present, fine
    }

    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConn(socket))
      server.on('error', (err) => {
        logger.error(`ipc server error: ${err.message}`)
        reject(err)
      })
      server.listen(sockPath, () => {
        this.server = server
        logger.info(`ipc listening on ${sockPath}`)
        resolve()
      })
    })
  }

  private handleConn(socket: Socket): void {
    let buf = ''
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const response = this.process(line)
        socket.end(JSON.stringify(response) + '\n')
      }
    })
    socket.on('error', () => {
      // client disconnected abruptly — ignore
    })
  }

  private process(line: string): StatusResponse | ErrorResponse {
    try {
      const req = JSON.parse(line) as { cmd?: string }
      if (req.cmd === 'status') {
        return {
          ok: true,
          pid: this.opts.pid,
          startedAt: this.opts.startedAt,
          chats: this.opts.getSnapshot(),
        }
      }
      return { ok: false, error: `unknown cmd: ${req.cmd ?? '(missing)'}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

export async function queryStatus(): Promise<StatusResponse | null> {
  return new Promise<StatusResponse | null>((resolve) => {
    const sock = createConnection(config.paths.sockFile)
    sock.setEncoding('utf-8')
    let buf = ''

    const finish = (v: StatusResponse | null) => {
      sock.destroy()
      resolve(v)
    }

    sock.on('error', () => finish(null))
    sock.on('connect', () => {
      sock.write(JSON.stringify({ cmd: 'status' }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        try {
          const obj = JSON.parse(buf.slice(0, nl)) as StatusResponse | ErrorResponse
          if (obj.ok) finish(obj)
          else finish(null)
        } catch {
          finish(null)
        }
      }
    })

    setTimeout(() => finish(null), 2_000)
  })
}
