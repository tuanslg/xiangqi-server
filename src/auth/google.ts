import { OAuth2Client } from 'google-auth-library'
import type { GoogleIdentity } from './users'

export interface VerifiedGoogleToken extends GoogleIdentity {
  nonce: string | null
}

/** Verifies a Google ID token and returns the identity inside it; rejects if invalid or expired. */
export type GoogleVerifier = (credential: string) => Promise<VerifiedGoogleToken>

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

export function createGoogleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client()
  return async (credential) => {
    // Checks signature (Google's rotating certs), issuer, audience and expiry.
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId })
    const p = ticket.getPayload()
    if (!p?.sub) throw new Error('token has no subject')
    const picture = p.picture && /^https:\/\//.test(p.picture) ? clamp(p.picture, 500) : null
    return {
      sub: p.sub,
      email: p.email && p.email_verified ? clamp(p.email, 320) : null,
      name: clamp((p.name ?? p.email ?? 'Người chơi').trim() || 'Người chơi', 100),
      picture,
      nonce: p.nonce ?? null,
    }
  }
}
