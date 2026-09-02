# Local Bard

A local desktop app (Windows + Linux) that captures a single, user-chosen
application's audio output and streams it into a Discord voice channel via a
bot the app itself controls. See [`SECURITY.md`](./SECURITY.md) for the
security model.

> **Just want to use it?** Start here: [`GETTING-STARTED.md`](./GETTING-STARTED.md)
> -- a no-coding-required guide to downloading a release and getting it
> running. This README is for building the app from source.

## How it works

1. You run the app and paste your Discord bot token once (encrypted at rest
   via your OS keychain -- see `SECURITY.md`).
2. In Discord, someone with `ManageGuild` (or a configured role) runs
   `/join #some-voice-channel`.
3. In the Local Bard window, you pick a currently-running application from
   the list and click **Start streaming**.
4. That application's audio -- and only that application's audio -- is
   captured, Opus-encoded, and played into the voice channel the bot joined.
5. `/stop` stops streaming (bot stays connected); `/leave` disconnects
   entirely; `/status` reports current state.

## Project layout

```
src/
  main/       Electron main process: window, IPC handlers, bot client,
              audio capture orchestration, secure token storage.
  preload/    contextBridge API exposed to the renderer (the only bridge).
  renderer/   Plain HTML/CSS/TS GUI.
  shared/     Types and IPC channel constants shared across processes.
windows-helper/   .NET console helper for Windows WASAPI process-loopback
                  capture (see "Windows" section below).
```

## Requirements

- Node.js 20+
- Linux: PipeWire (`pw-dump`, `pw-record`) or PulseAudio (`pactl`, `parec`)
  command-line tools on `PATH`.
- Windows: Windows 10 2004 (build 19041) or later, and the published
  `windows-helper` executable (see below) -- per-process capture is not
  possible on older Windows versions.
- A Discord application + bot token
  (<https://discord.com/developers/applications>).

## Setup

```bash
npm install
cp .env.example .env   # optional, dev convenience only -- see .env.example
npm run dev
```

On first launch, paste your bot token into the in-app prompt (or set
`DISCORD_BOT_TOKEN` in `.env` before `npm run dev` to skip that in dev only
-- this env var is never read in a packaged build).

### Inviting the bot to your server

The Local Bard window walks you through this as a guided wizard (Bot setup
card), but here's the same steps written out:

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application, add a **Bot** to it, and copy its token into Local
   Bard. Under **Bot**, make sure **Message Content Intent** is left **off**
   -- this bot never reads message text, only slash commands.
2. Once Local Bard connects with that token, it reads the bot's own
   application id from Discord and builds the invite link itself -- no
   manual OAuth2 -> URL Generator step needed. Click **Invite to your
   server** (or copy the link) and add the bot to your server.
3. In Discord, run `/join <voice channel>` (you need `Connect` permission in
   that channel, and either `ManageGuild` or the configured control role to
   use the command at all).

Slash commands are registered per-guild (not globally), so they show up
immediately in every server the bot is in -- no waiting for Discord's
up-to-an-hour global command propagation.

## Configuring the server (Guild ID)

The GUI can show you the configured server's name and voice channels --
letting you pick one and join directly from the app window, instead of
typing `/join` in Discord. This just points the app at a server by ID; it
uses the bot's own connection to resolve it (`client.guilds.cache`), not a
separate user login.

To find your server's Guild ID:

1. In Discord, open **User Settings -> Advanced** and enable **Developer
   Mode**.
2. Right-click your server's icon in the server list and choose **Copy
   Server ID**.
3. Paste that ID into the **Discord server** card in the Local Bard window
   and click **Save**.

If the bot is already a member of that server, the card immediately shows
its name and voice channels as a clickable list -- click one to join it
(equivalent to running `/join` for that channel). If the bot hasn't been
invited to that server yet, the card shows a clear error instead until it
is.

## Restricting who can control the bot

By default, only members with the `ManageGuild` permission can use `/join`,
`/leave`, `/status`, `/stop`. To also allow a specific role, set
`controlRoleId` in the app's local config file (written to your OS's
userData directory, e.g. `~/.config/local-bard/config.json` on Linux) to
that role's ID. This is a local, non-secret setting -- it is never read from
Discord input.

## Build / package

```bash
npm run build        # compile main + preload + renderer, copy static assets
npm run dist:linux    # AppImage + .deb (electron-builder)
npm run dist:win      # NSIS installer (electron-builder) -- see Windows section
```

## Platform notes

### Linux -- fully functional today

Per-application capture runs a single long-lived `pw-record` process with
PipeWire's auto-connect disabled (`node.autoconnect = false`), and links its
input ports to the target app's `Stream/Output/Audio` output ports
explicitly with `pw-link`, re-linking whenever the target reappears (falling
back to `pactl`/`parec --monitor-stream=<id>` if PipeWire's CLI tools aren't
present). This isn't just style: `pw-record --target <node>` alone only
sets an auto-connect *hint* -- once the target's node is torn down (normal
after a period of silence) and PipeWire's auto-connect policy re-links the
orphaned input ports, it silently picks the system's default source (the
microphone) instead, with no error. Disabling auto-connect and managing the
exact links ourselves is what keeps a period of silence from ever leaking
into the microphone. If neither backend is available, the GUI shows a clear
error instead of crashing or silently capturing nothing.

### Windows -- native helper required

There is no mature npm package for per-process audio capture on Windows; it
requires the WASAPI "process loopback" API
(`AUDIOCLIENT_ACTIVATION_PARAMS_TYPE_PROCESS_LOOPBACK`, Windows 10 2004+).
`windows-helper/` is a small self-contained .NET console app that does this
native interop and streams raw PCM on stdout; `src/main/audio/windowsCapture.ts`
spawns it with a fixed path + argv array, same pattern as the Linux path.

The process-loopback capture path has now been run and fixed on real
Windows hardware (event-driven capture, a PROPVARIANT marshaling bug, and a
`GetMixFormat` assumption were all corrected as a result -- see
`windows-helper/ProcessLoopbackCapture.cs`'s class doc comment and git
history). One piece remains genuinely unverified: activating capture
against a process that hasn't produced any audio yet, marked with a
`// TODO(windows-verify):` comment in that same file. Session listing
(`SessionEnumerator.cs`, the `--list` path) also hasn't been specifically
re-verified since -- see its own TODO markers.

To build the helper (Windows machine or CI with the .NET 8 SDK, and
`dotnet` on `PATH`):

```powershell
cd windows-helper
dotnet publish -r win-x64 --self-contained -o publish/win-x64
```

`electron-builder`'s `extraResources` config (`package.json`) bundles
`windows-helper/publish/win-x64/*` into the packaged app's resources
directory, so `npm run dist:win` expects that publish step to have already
run.

## Dependency notes / deviations from the original plan

- **Opus encoding uses `opusscript` (pure JS) only, not `@discordjs/opus`.**
  The original plan was `@discordjs/opus` with `opusscript` as a fallback.
  `@discordjs/opus`'s native-build toolchain (`@discordjs/node-pre-gyp` ->
  `tar`) currently pulls in `tar` versions with multiple high/critical
  advisories (path traversal / arbitrary file write during extraction) that
  have **no fix available** upstream as of this writing. Given security is a
  hard requirement here, `@discordjs/opus` was dropped entirely rather than
  installed as an optional dependency. `opusscript` is a little slower
  (pure JS Opus) but has no such install-time native-binary supply-chain
  risk. If `@discordjs/opus`'s dependency chain is fixed upstream later, it
  can be re-added as an `optionalDependencies` entry -- `prism-media`
  auto-detects whichever encoder is installed, so no code change would be
  needed beyond `npm install @discordjs/opus`.
- `electron`, `electron-builder`, `discord.js`, and `@discordjs/voice` are
  pinned to current major versions specifically to close known CVEs present
  in the versions this project would otherwise have defaulted to -- run
  `npm audit` periodically and re-pin as new advisories land.
- **`build:preload` bundles with `esbuild` instead of plain `tsc`.** A
  sandboxed preload script (`sandbox: true`) runs under Electron's restricted
  preload loader, which only resolves the preload script's own file and a
  curated set of built-ins -- it cannot `require()` other project files by
  relative path (e.g. `../shared/ipcChannels`), even though that works fine
  under plain Node/`tsc` output. Bundling inlines everything the preload
  script needs into one self-contained file, which is what the sandbox
  actually requires. `tsconfig.preload.json` is still used for type-checking
  (`npm run typecheck`), just not for emitting the runtime file anymore.

## What is explicitly out of scope for v1

- Auto-update (see `SECURITY.md` for why).
- macOS support (per-app audio capture would need a different, unrelated
  native approach there).
- Multi-guild / multi-channel simultaneous streaming from one app instance.
