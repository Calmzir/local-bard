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
  cannot silently pull and run new code from anywhere. There is no loopback
  server of any kind either: the app has no user-login flow, so it never
  needs to receive a browser redirect.
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

The GUI's own "join this channel" action is scoped the same way: it only
ever joins a voice channel that resolves (via the bot's own connection) as
belonging to the one configured Guild ID, and that Guild ID is a local,
non-secret setting (see below) -- never something read from Discord input.
There is no separate user login or per-user permission check here; local
trust is "whoever can open and use this desktop app", the same model
already used for the bot token and the audio-source selection.

## Secrets are never stored in plaintext

- The Discord bot token is entered once through a first-run GUI prompt and
  stored using Electron's `safeStorage` API, which defers to your OS's own
  secret storage: DPAPI on Windows, libsecret/kwallet on Linux. Local Bard
  never writes the raw token to disk.
- There is no token, password, or config file with secrets committed to this
  repository. `.gitignore` excludes `.env`, any `*.token` files, and the
  local encrypted token/config files the app writes to its userData
  directory at runtime.
- `.env.example` documents an optional dev-only convenience env var
  (`DISCORD_BOT_TOKEN`) that is only ever read when running from source in
  an unpackaged dev build, and even then it's immediately routed through
  the same `safeStorage` encryption as its GUI path -- never read directly
  by anything else.
- The configured Discord server (Guild ID) is **not** a secret -- it's a
  public-ish numeric identifier, the same trust level as a channel name --
  so it is stored as plain local JSON config (`config.json` under the OS
  userData directory, alongside the `controlRoleId` setting), never through
  `safeStorage`. There is no OAuth secret, client ID, or user-login token of
  any kind stored anywhere in this app.

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
