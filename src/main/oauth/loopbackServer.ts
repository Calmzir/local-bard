import { createServer, type Server } from 'node:http';

/**
 * Fixed loopback redirect URI for the OAuth2 login flow. See SECURITY.md
 * ("Narrow, intentional exception: the OAuth login callback") for why a
 * short-lived, single-use, loopback-only HTTP server is safe here.
 */
const HOST = '127.0.0.1';
const PORT = 47115;
export const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;

export interface LoopbackCallbackResult {
  code: string;
}

const CLOSE_TAB_HTML = (message: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Local Bard</title>
  </head>
  <body style="font-family: system-ui, sans-serif; background: #1e1f22; color: #f2f3f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
    <p>${message} You can close this tab and go back to Local Bard.</p>
  </body>
</html>`;

const SUCCESS_HTML = CLOSE_TAB_HTML('Signed in.');
const ERROR_HTML = CLOSE_TAB_HTML('Something went wrong with sign-in.');

/**
 * Starts a plain `node:http` server bound explicitly to 127.0.0.1 (never
 * 0.0.0.0), handles exactly ONE callback request (whether it turns out
 * valid or not), then closes the server immediately -- it never stays
 * listening beyond that single request, and it self-closes on timeout too.
 *
 * Resolves with the authorization `code` once a request arrives whose
 * `state` matches `expectedState`. Rejects (and closes the server) on a
 * `state` mismatch, a missing `code`, an explicit `error` query param, a
 * server error, or after `timeoutMs` with nothing received.
 */
export function runLoopbackCallbackServer(
  expectedState: string,
  timeoutMs: number,
): Promise<LoopbackCallbackResult> {
  return new Promise<LoopbackCallbackResult>((resolve, reject) => {
    let settled = false;
    let server: Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const shutdown = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const s = server;
      server = null;
      if (s) {
        s.close();
      }
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      shutdown();
      fn();
    };

    server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }

      // Validate/sanitize before using anything from the request: only a
      // GET to exactly /callback is accepted at all, and query params are
      // read as plain strings (never interpolated into a command or eval'd).
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const oauthError = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (oauthError) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
        settle(() => reject(new Error(`Discord declined the authorization request: ${oauthError}`)));
        return;
      }

      if (typeof state !== 'string' || state.length === 0 || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
        settle(() => reject(new Error('OAuth callback failed CSRF state validation.')));
        return;
      }

      if (typeof code !== 'string' || code.length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
        settle(() => reject(new Error('OAuth callback did not include an authorization code.')));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
      settle(() => resolve({ code }));
    });

    server.on('error', (err) => {
      settle(() => reject(err));
    });

    server.listen(PORT, HOST);

    timer = setTimeout(() => {
      settle(() => reject(new Error('Login timed out waiting for the Discord callback.')));
    }, timeoutMs);
  });
}
