# Getting Started with Local Bard

This guide is for anyone who just wants to **use** Local Bard — no coding
knowledge needed. If you're a developer looking to build the app from
source, see [`README.md`](./README.md) instead.

## The one rule: never share your bot token

Local Bard doesn't have a shared server or a shared bot that everyone
connects to. Instead, **you create your own Discord bot** and run your own
copy of the app on your own computer. Your bot, your server, your session —
completely separate from anyone else using Local Bard.

That separation only holds if you keep your bot's **token** to yourself.
A token is like a password that lets whoever holds it fully control that
bot. If two people ever used the *same* token, both copies of the app would
be fighting to control the exact same bot at the same time, and things would
break in confusing ways.

So:

- **Never share your bot token with anyone, for any reason.**
- **Never paste in a token someone else gave you.** Always create your own
  (step 4 below shows you how — it takes two minutes and it's free).

Keep this in mind and everything else in this guide is just clicking
buttons.

## 1. Download Local Bard

Go to the [Releases page](https://github.com/Calmzir/local-bard/releases)
and download the file for your operating system:

| Your system | Download |
|---|---|
| Windows | the `.exe` file |
| Linux | `.AppImage` or `.deb` (see below) |

**Which Linux file do I want?**

- **`.AppImage`** — no installation required. Download it, right-click the
  file and make it executable (or run `chmod +x filename.AppImage` in a
  terminal), then double-click it to run.
- **`.deb`** — for Debian/Ubuntu-based systems (Ubuntu, Mint, Pop!_OS, etc.).
  Install it the way you'd install any `.deb` file, e.g. double-click it to
  open it in your software installer, or `sudo apt install ./filename.deb`.

## 2. Windows: the blue "Windows protected your PC" screen

The first time you run the `.exe`, Windows SmartScreen will likely show a
blue warning screen. This isn't a sign that anything is broken or unsafe —
it just means this app hasn't paid for a code-signing certificate yet,
which is common for small, independently-built apps. Windows shows this
warning for *any* unsigned app, regardless of what it actually does.

To continue:

1. Click **More info**.
2. Click **Run anyway**.

## 3. Create your own Discord bot

This takes about two minutes on Discord's own website (the "Developer
Portal") and is completely free.

1. Go to <https://discord.com/developers/applications> and log in with your
   normal Discord account.
2. Click **New Application**, give it any name you like (this is just the
   bot's display name), and create it.
3. In the left sidebar, click **Bot**.
4. Click **Reset Token**, then copy the token that appears. This is the
   secret from "the one rule" above — treat it like a password. You'll paste
   it into Local Bard in step 5.
5. On that same **Bot** page, make sure **Message Content Intent** is left
   **OFF**. Local Bard never needs to read message text, only slash
   commands, so this should stay off.
6. In the left sidebar, click **OAuth2 -> URL Generator**.
7. Under **Scopes**, check `bot` and `applications.commands`.
8. Under **Bot Permissions** (which appears once you check `bot`), check
   `Connect` and `Speak`.
9. Scroll down and copy the generated URL at the bottom, then open it in
   your browser.
10. Pick your Discord server from the dropdown and click **Authorize**.

Your bot now exists and is a member of your server.

## 4. First launch: paste in your token

Open Local Bard. On first launch it will ask for a bot token — paste in the
token you copied in step 3.4.

## 5. Point it at your server

Next, tell Local Bard which Discord server (technically called a "guild") to
use:

1. In Discord, open **User Settings -> Advanced** and turn on **Developer
   Mode**.
2. Right-click your server's icon in the server list on the left and choose
   **Copy Server ID**.
3. In the Local Bard window, paste that ID into the **Discord server** card
   and click **Save**.

The card should now show your server's name and its voice channels.

## 6. Use it

1. In Discord, join a voice channel, then run `/join #that-channel` (you
   need the **Connect** permission in that channel).
2. In the Local Bard window, pick a currently-running application from the
   list.
3. Click **Start streaming**.

That's it — that application's audio now plays into the voice channel. Run
`/stop` to stop streaming, or `/leave` to disconnect the bot entirely.

## Something not working?

- Platform-specific setup details (Linux audio backends, Windows version
  requirements) are covered in `README.md`'s **Platform notes** section.
- For questions about how tokens are stored, what data the app touches, or
  the overall security model, see [`SECURITY.md`](./SECURITY.md).
