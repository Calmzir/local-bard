# Security

Local Bard runs entirely on your machine and only talks to Discord's own
servers. This document is a plain-English list of the specific choices made
so you can answer "does this have a backdoor?" with evidence, not vibes.

## No remote access into the app

- Local Bard opens **zero listening network ports** during normal
  operation. All network traffic is outbound-only: the Discord gateway
  (WebSocket) and Discord voice (UDP), both initiated by the app itself.
- There is no persistent HTTP server, no debug/RPC endpoint, and no
  auto-updater. The packaged app cannot be reached from the network, and it
  cannot silently pull and run new code from anywhere.
- **One narrow, intentional exception: the OAuth login callback.** When you
  click "Sign in with Discord", the app starts a plain `node:http` server
  bound explicitly to `127.0.0.1` (never `0.0.0.0`, so nothing outside your
  own machine can ever reach it) on port 47115, right before opening your
  browser to Discord's consent screen. It handles exactly **one** request --
  Discord's redirect back with the authorization code -- verifies that
  request's `state` parameter matches the one this login attempt generated
  (CSRF protection), then closes itself immediately, whether that one
  request was valid or not. If you cancel the login or it sits idle for 5
  minutes, it closes itself the same way. At every other moment -- including
  while the app is otherwise fully running -- this port is not listening.
  This is safe because it is loopback-only, single-use, short-lived, and
  CSRF-checked: even in the narrow window it is up, nothing but this exact
  login attempt on this exact machine can complete it.
- Renderer devtools and any Electron remote-debugging surface are disabled
  in packaged production builds (`webPreferences.devTools: !app.isPackaged`
  in `src/main/index.ts`). Devtools are only ever available when running
  from source in dev mode.

## Renderer is sandboxed and cannot touch your system directly

- Every `BrowserWindow` is created with `contextIsolation: true`,
  `nodeIntegration: false`, and `sandbox: true`.
- The `remote` module is never used (it no longer exists in modern Electron
  and nothing here re-adds an equivalent).
- The renderer (the GUI you see) has **no** access to Node.js, `require`, or
  raw `ipcRenderer`. It only sees a narrow, fully-typed API object exposed
  via `contextBridge.exposeInMainWorld('bard', ...)` in `src/preload/index.ts`
  -- a fixed list of async methods like "list apps" and "start streaming",
  each mapped to exactly one fixed IPC channel. There is no channel or
  method that accepts a shell command, a file path to execute, or arbitrary
  code.
- The renderer's `index.html` ships a strict Content-Security-Policy
  (`default-src 'self'`, no inline scripts, no remote origins).

## No shell execution, ever

Every place this app spawns a child process (`pw-record`, `pw-dump`,
`pactl`, `parec` on Linux; the Windows audio helper .exe on Windows) uses
Node's `child_process.spawn` with:

- a **fixed** executable name (never built from user/Discord input), and
- a **fixed argv array** (arguments passed as separate array elements).

`shell: true` is never used anywhere in this codebase, and no command is
ever built by concatenating strings together. This means there is no way for
an application name, a Discord username, or any other piece of
attacker-influenced text to be interpreted as shell syntax.

## Discord commands cannot execute arbitrary input

The bot's slash commands (`/join`, `/leave`, `/status`, `/stop`) are fixed,
structured Discord slash command definitions with typed options (e.g.
`/join` takes a Discord channel picker, not free text). None of them accept
or evaluate freeform text as code. All four commands are additionally
restricted server-side to members with the `ManageGuild` permission, or a
specific role ID read from local (non-secret) config -- everyone else gets
an ephemeral "you do not have permission" reply and nothing runs.

## Secrets are never stored in plaintext

- The Discord bot token is entered once through a first-run GUI prompt and
  stored using Electron's `safeStorage` API, which defers to your OS's own
  secret storage: DPAPI on Windows, libsecret/kwallet on Linux. Local Bard
  never writes the raw token to disk.
- There is no token, password, or config file with secrets committed to this
  repository. `.gitignore` excludes `.env`, any `*.token` files, and the
  local encrypted token/config files the app writes to its userData
  directory at runtime.
- `.env.example` documents optional dev-only convenience env vars
  (`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`) that
  are only ever read when running from source in an unpackaged dev build,
  and even then they're immediately routed through the same `safeStorage`
  encryption as their respective GUI paths -- never read directly by
  anything else.

## Discord login (OAuth2) is scoped to be nearly harmless if leaked

- The "Sign in with Discord" feature requests only the `identify` and
  `guilds` scopes -- both **read-only**. Neither one lets Local Bard (or
  whoever holds the resulting token) post messages, change server settings,
  kick/ban members, or otherwise act as you. `guilds` only returns the list
  of servers you're in plus your permission bitfield in each; `identify`
  only returns your basic profile (id, username).
- The bot's own actions (joining voice, streaming audio) continue to go
  exclusively through the bot's own token and Discord's normal per-command
  permission checks (see "Discord commands cannot execute arbitrary input"
  above) -- this login flow never grants it anything extra. The GUI's "join
  this channel" button re-checks `MANAGE_GUILD` server-side against the
  cached OAuth guild list before joining; it never trusts a guild/channel id
  sent from the renderer as an authorization decision on its own.
- Even though Discord's token endpoint requires a `client_id` +
  `client_secret` on every exchange (there is no secretless/public-client
  PKCE option -- confirmed against Discord's own OAuth2 documentation),
  Local Bard still generates and sends a PKCE `code_verifier`/`code_challenge`
  (S256) on every login attempt as defense-in-depth against authorization-code
  interception, on top of the CSRF `state` check.
- **Practical worst case if the locally-stored OAuth secrets or session
  tokens were ever extracted from this machine:** whoever has them could
  re-run this same read-only login and see the same read-only data
  (identify + guild list) this app already sees. They could not send
  messages, join voice, change any server, or otherwise act as you or as
  the bot -- there is no code path anywhere that would let them.
- The OAuth Client ID/Secret and the resulting login session tokens are
  stored the same `safeStorage`-encrypted-at-rest way as the bot token, but
  in **separate files, separate from the bot token and from each other**
  (`oauth-client.enc`, `oauth-tokens.enc` vs. `bot-token.enc`, all under the
  OS userData directory -- see `src/main/secureStorage.ts`). "Log out" in
  the GUI clears only `oauth-tokens.enc` (the session); the Client
  ID/Secret in `oauth-client.enc` are left in place so you don't have to
  re-enter them to sign in again.

## Packaging

- `electron-builder` is configured with `asar: true`.
- **No auto-updater is wired up in v1, on purpose.** An unsigned or
  improperly-verified auto-update channel is a real supply-chain attack
  vector (it lets whoever controls the update feed run code on every
  installed copy of the app). If auto-update is ever added later, it must
  verify update package signatures before applying anything -- see the
  comment left in `package.json`'s `build` config.

## What this means practically

If someone asks "could this bot be turned into a backdoor into my machine or
my Discord server?" -- there is no listening port to attack, no code-eval
surface in the IPC bridge, no shell-interpreted command anywhere in the
capture pipeline, and no unauthenticated (or unauthorized-role) path to any
Discord command. The worst a malicious server member can do is get an
ephemeral "you don't have permission" message.
