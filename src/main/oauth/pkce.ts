import { randomBytes, createHash } from 'node:crypto';

/**
 * PKCE (RFC 7636) + CSRF `state` generation for the OAuth2 login flow.
 *
 * Discord's token endpoint requires `client_id` + `client_secret` on every
 * exchange -- there is no secretless/public-client PKCE support, so PKCE
 * here does not remove that requirement. It is still generated and sent as
 * defense-in-depth against authorization-code interception (a stolen code
 * is useless without the verifier that only this app instance holds).
 */

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh, unguessable value used both as PKCE `code_verifier` input and the CSRF `state`. */
export function generateRandomToken(byteLength = 32): string {
  return base64url(randomBytes(byteLength));
}

export interface PkcePair {
  codeVerifier: string;
  /** SHA-256 S256 challenge derived from `codeVerifier`. */
  codeChallenge: string;
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}
