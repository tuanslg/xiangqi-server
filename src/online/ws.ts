import websocket from '@fastify/websocket'
import { parseClientMessage } from '@xiangqi/shared'
import type { ServerMessage } from '@xiangqi/shared'
import type { FastifyInstance } from 'fastify'
import { identityFor } from './guest'
import type { Conn, Hub } from './hub'
import { originAllowed } from '../security'

const MAX_PAYLOAD = 2 * 1024
const HEARTBEAT_MS = 30_000
const MAX_BAD_MESSAGES = 10
/** Token bucket: sustained 10 msgs/s with bursts up to 30. */
const BUCKET_SIZE = 30
const REFILL_PER_S = 10

export interface OnlineOptions {
  hub: Hub
  allowedOrigins: string[]
  maxConnsPerIp: number
}

export async function registerOnline(app: FastifyInstance, { hub, allowedOrigins, maxConnsPerIp }: OnlineOptions): Promise<void> {
  await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD } })
  const perIp = new Map<string, number>()

  app.get(
    '/ws',
    {
      websocket: true,
      // Runs before the HTTP upgrade, so rejected clients get a plain 4xx instead of a socket.
      preValidation: async (req, reply) => {
        // Browsers always send Origin on WebSocket handshakes; this blocks cross-site hijacking.
        if (!originAllowed(req.headers.origin, req.host, allowedOrigins)) return reply.code(403).send({ error: 'bad_origin' })
        if (!identityFor(req)) return reply.code(401).send({ error: 'no_identity' })
        if ((perIp.get(req.ip) ?? 0) >= maxConnsPerIp) return reply.code(429).send({ error: 'too_many_connections' })
      },
    },
    (socket, req) => {
      const identity = identityFor(req)!
      const ip = req.ip
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1)

      const conn: Conn = {
        identity,
        send: (msg: ServerMessage) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
        },
        close: (code, reason) => socket.close(code, reason),
      }

      let alive = true
      socket.on('pong', () => (alive = true))
      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate()
        alive = false
        socket.ping()
      }, HEARTBEAT_MS)

      let tokens = BUCKET_SIZE
      let refilledAt = Date.now()
      let bad = 0

      socket.on('message', (data) => {
        const now = Date.now()
        tokens = Math.min(BUCKET_SIZE, tokens + ((now - refilledAt) / 1000) * REFILL_PER_S)
        refilledAt = now
        if (tokens < 1) return socket.close(1008, 'rate limit')
        tokens -= 1

        let msg
        try {
          msg = parseClientMessage(JSON.parse(data.toString()))
        } catch {
          msg = null
        }
        if (!msg) {
          conn.send({ t: 'error', code: 'bad_message', message: 'Tin nhắn không hợp lệ.' })
          if (++bad > MAX_BAD_MESSAGES) socket.close(1008, 'too many invalid messages')
          return
        }
        try {
          hub.handle(conn, msg)
        } catch (err) {
          req.log.error({ err }, 'ws handler failed')
          conn.send({ t: 'error', code: 'internal', message: 'Lỗi máy chủ.' })
        }
      })

      socket.on('close', () => {
        clearInterval(heartbeat)
        const left = (perIp.get(ip) ?? 1) - 1
        if (left <= 0) perIp.delete(ip)
        else perIp.set(ip, left)
        hub.disconnect(conn)
      })
      socket.on('error', (err) => req.log.warn({ err }, 'ws error'))

      hub.connect(conn)
    },
  )
}
