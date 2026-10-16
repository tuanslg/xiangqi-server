import type { FastifyInstance } from 'fastify'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * True if a request's Origin may talk to us: absent (non-browser client), allow-listed, or our own host.
 * `host` is the Host the request was addressed to.
 */
export function originAllowed(origin: string | undefined, host: string, allowedOrigins: string[]): boolean {
  if (!origin) return true
  if (allowedOrigins.includes(origin)) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * CSRF defence for cookie-authenticated APIs, on top of SameSite=Lax: a browser always sends
 * `Origin` on cross-site writes, so reject any whose origin is neither allow-listed nor our own host.
 * Requests without an Origin (curl, server-to-server) carry no ambient browser credentials, so pass.
 */
export function registerOriginCheck(app: FastifyInstance, allowedOrigins: string[]): void {
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return
    if (!originAllowed(req.headers.origin, req.host, allowedOrigins)) return reply.code(403).send({ error: 'bad_origin' })
  })
}
