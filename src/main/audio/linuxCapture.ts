import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import type { AudioCaptureSource } from '../../shared/audioCapture';
import type { CapturableApp } from '../../shared/types';

/**
 * Linux audio capture, backed by PipeWire (`pw-dump` + `pw-record` +
 * `pw-link`) with a PulseAudio (`pactl` + `parec`) fallback for systems that
 * don't run PipeWire's `pw-*` CLI tools (or run PipeWire only through its
 * PulseAudio compatibility layer).
 *
 * Every child process is spawned with a fixed executable name and a fixed
 * argv array -- never `shell: true`, never string-concatenated commands --
 * so nothing from app names or user input can be interpreted as shell
 * syntax.
 *
 * `listApps()` enumerates currently RUNNING processes (via `/proc`), not
 * just ones already producing sound -- PipeWire only creates a
 * `Stream/Output/Audio` node once audio is actively flowing, which is too
 * late for "pick an app, then start playback" workflows. `startCapture()`
 * instead waits (polling) for a matching stream to appear once the user has
 * made their pick.
 *
 * The match between "the process the user picked" and "the eventual audio
 * stream" is done by EXECUTABLE/BINARY NAME, never by PID: multi-process
 * apps (every modern browser) run many OS processes under one binary, and
 * the specific child process that ends up owning the PipeWire stream is
 * very often not the PID the user sees as the app's main process. Binary
 * name is the one identity PipeWire's `application.process.binary` prop and
 * `/proc/<pid>/exe` agree on, so app ids and the running-process list are
 * both built around it (`proc:<binary>`, deduped to one entry per binary).
 *
 * ## PipeWire link management (why this isn't just `pw-record --target`)
 *
 * An earlier version of this file spawned
 * `pw-record --target <object.serial> --format s16 ...` to capture one
 * app's stream. `--target` only works through wireplumber's normal
 * auto-connect policy: it's a hint for where to link *at startup*, not a
 * pin. Verified empirically with `pw-link -l` on this machine: once the
 * target app's `Stream/Output/Audio` node is destroyed (PipeWire tears it
 * down after a period of silence -- normal, expected, not an error) and
 * later reappears, wireplumber's auto-connect silently RE-LINKS
 * `pw-record`'s now-orphaned input ports to the system's DEFAULT AUDIO
 * SOURCE -- the microphone. `pw-record` itself does not exit or error when
 * this happens; it keeps running and now feeds live microphone audio into
 * the pipeline, indistinguishable from normal operation. That's a
 * privacy/correctness bug, not a UX rough edge.
 *
 * The fix: disable auto-connect entirely for the capture node
 * (`node.autoconnect = false`, no `--target`) and manage the exact port
 * links ourselves via `pw-link`:
 *
 *   1. Spawn one long-lived `pw-record` process per capture session with a
 *      unique `node.name` and autoconnect off. It is never respawned for a
 *      transient target loss -- only `stopCapture()` kills it.
 *   2. Discover that process's own input ports (`input_FL`/`input_FR`) via
 *      `pw-dump`, matched by the unique node name we passed it.
 *   3. Discover the target app's `Stream/Output/Audio` node (matched by
 *      `application.process.binary`, same logic as before) and its output
 *      ports (`output_FL`/`output_FR`).
 *   4. Link them explicitly with `pw-link <output-port-id> <input-port-id>`
 *      using the bare numeric port ids from the same `pw-dump` snapshot.
 *
 * With autoconnect off, when the target's node disappears its ports (and
 * therefore our links) are destroyed by PipeWire itself -- our
 * `pw-record` process's input ports simply go unlinked (true silence,
 * zero-filled buffers) and are NOT auto-rerouted to anything. A ~1s
 * link-health poll watches for that and for the target reappearing (see
 * `runPipewireCaptureLoop`), re-linking as needed, while the single
 * `pw-record` process keeps running throughout.
 */
export class LinuxAudioCapture implements AudioCaptureSource {
  private captureProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private waitAbortController: AbortController | null = null;

  async listApps(): Promise<CapturableApp[]> {
    const pids = await listOwnedUserPids();

    const binaries = new Set<string>();
    for (const pid of pids) {
      const binary = await resolveProcessBinary(pid);
      if (binary !== null) binaries.add(binary);
    }

    const desktopNames = await buildDesktopNameIndex();

    const apps: CapturableApp[] = [];
    for (const binary of binaries) {
      apps.push({
        id: `proc:${binary}`,
        name: desktopNames.get(binary) ?? binary,
        processName: binary,
      });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return apps;
  }

  startCapture(appId: string): Readable {
    this.stopCapture();

    const binary = parseAppId(appId);
    const output = new PassThrough();
    const abortController = new AbortController();
    this.waitAbortController = abortController;

    void this.runCaptureLoop(binary, output, abortController.signal);

    return output;
  }

  stopCapture(): void {
    if (this.waitAbortController) {
      this.waitAbortController.abort();
      this.waitAbortController = null;
    }
    if (this.captureProcess) {
      this.captureProcess.kill('SIGTERM');
      this.captureProcess = null;
    }
  }

  /**
   * Picks a backend once per capture session (PipeWire if `pw-dump` is
   * available, otherwise the PulseAudio fallback) and hands off to that
   * backend's own long-running loop. The overall lifecycle in both cases is
   * `'waiting'` <-> `'live'` until `stopCapture()` aborts `signal` -- the
   * only thing that should end this stream. A genuinely fatal condition (no
   * supported audio backend at all, or a required CLI tool failing to
   * spawn) ends the loop with an `'error'` event instead.
   */
  private async runCaptureLoop(binary: string, output: PassThrough, signal: AbortSignal): Promise<void> {
    let pwAvailable: boolean;
    try {
      await runCapturingStdout('pw-dump', []);
      pwAvailable = true;
    } catch (err) {
      if (!isMissingBinary(err)) {
        if (!signal.aborted) output.emit('error', new Error(`Failed to run "pw-dump": ${(err as Error).message}`));
        return;
      }
      pwAvailable = false; // pw-dump not installed -- fall through to the pactl fallback below.
    }
    if (signal.aborted) return;

    if (pwAvailable) {
      await this.runPipewireCaptureLoop(binary, output, signal);
    } else {
      await this.runPulseAudioCaptureLoop(binary, output, signal);
    }
  }

  /**
   * PipeWire capture loop: spawns one long-lived autoconnect-off
   * `pw-record` process, discovers its input ports, then polls `pw-dump`
   * roughly once a second to (re-)link the target app's output ports to
   * them, emitting `'waiting'`/`'live'` as the target's node comes and
   * goes. See the class doc comment for the full rationale.
   */
  private async runPipewireCaptureLoop(binary: string, output: PassThrough, signal: AbortSignal): Promise<void> {
    const nodeName = `local-bard-capture-${process.pid}-${Date.now()}`;

    const child = spawn(
      'pw-record',
      [
        '-P',
        `{ node.autoconnect = false node.name = ${nodeName} }`,
        '--format',
        's16',
        '--rate',
        '48000',
        '--channels',
        '2',
        '--raw',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.captureProcess = child;

    // `pw-record` is reused for the whole session -- only a spawn failure or
    // an unexpected exit (not caused by our own stopCapture()) is fatal; a
    // transient loss of the *target* stream is handled entirely by the
    // link-health poll below, without touching this process.
    const fatalController = new AbortController();
    let fatalError: Error | null = null;
    const failFatal = (err: Error): void => {
      if (fatalError) return;
      fatalError = err;
      fatalController.abort();
    };

    let stderrTail = '';
    child.stdout.pipe(output, { end: false });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-2000);
      output.emit('capture-stderr', text);
    });
    child.on('error', (err) => {
      if (this.captureProcess === child) this.captureProcess = null;
      failFatal(err);
    });
    child.on('exit', (code, sig) => {
      if (this.captureProcess === child) this.captureProcess = null;
      if (signal.aborted) return; // stopCapture() killed it on purpose.
      const detail = stderrTail.trim();
      const suffix = detail.length > 0 ? `: ${detail.split('\n')[0]}` : '';
      failFatal(
        new Error(`"pw-record" exited unexpectedly with code ${code ?? 'null'} (signal ${sig ?? 'none'})${suffix}`),
      );
    });

    const waitSignals = [signal, fatalController.signal];

    let ownPorts: { inputFL: number; inputFR: number } | undefined;
    try {
      ownPorts = await this.discoverOwnPorts(nodeName, waitSignals);
    } catch (err) {
      failFatal(err as Error);
    }
    if (signal.aborted) return;
    if (fatalError || !ownPorts) {
      if (this.captureProcess === child) {
        this.captureProcess = null;
        child.kill('SIGTERM');
      }
      output.emit('error', fatalError ?? new Error('Failed to discover capture node ports.'));
      return;
    }

    let waitingAnnounced = false;
    let linkedNodeId: number | null = null;

    while (!signal.aborted && !fatalController.signal.aborted) {
      let raw: string;
      try {
        raw = await runCapturingStdout('pw-dump', []);
      } catch (err) {
        if (signal.aborted) return;
        failFatal(new Error(`Failed to run "pw-dump": ${(err as Error).message}`));
        break;
      }
      if (signal.aborted) return;

      const objects = parsePwDump(raw);
      const targetNode = findStreamNode(objects, binary);

      if (!targetNode) {
        // Target's node is gone (or never appeared) -- our ports, if linked,
        // were already unlinked by PipeWire itself when the node was
        // destroyed. Nothing to unlink on our side; just report waiting and
        // keep polling for a new match.
        linkedNodeId = null;
        if (!waitingAnnounced) {
          output.emit('waiting');
          waitingAnnounced = true;
        }
        await delay(1000, waitSignals);
        continue;
      }

      if (linkedNodeId === targetNode.id) {
        // Still linked to the same node -- nothing to do this tick.
        await delay(1000, waitSignals);
        continue;
      }

      const targetPorts = findNodePorts(objects, targetNode.id, 'output_FL', 'output_FR');
      if (!targetPorts) {
        // The node object exists but hasn't published its output ports yet
        // -- try again on the next tick.
        if (!waitingAnnounced) {
          output.emit('waiting');
          waitingAnnounced = true;
        }
        await delay(1000, waitSignals);
        continue;
      }

      try {
        await runCapturingStdout('pw-link', [String(targetPorts.first), String(ownPorts.inputFL)]);
        await runCapturingStdout('pw-link', [String(targetPorts.second), String(ownPorts.inputFR)]);
      } catch (err) {
        if (signal.aborted) return;
        if (isMissingBinary(err)) {
          failFatal(new Error(`Failed to run "pw-link": ${(err as Error).message}`));
          break;
        }
        // Transient -- e.g. the target's ports disappeared between
        // discovery and linking. Log it and retry on the next tick rather
        // than ending the session.
        output.emit('capture-stderr', `pw-link failed: ${(err as Error).message}`);
        if (!waitingAnnounced) {
          output.emit('waiting');
          waitingAnnounced = true;
        }
        await delay(1000, waitSignals);
        continue;
      }

      linkedNodeId = targetNode.id;
      waitingAnnounced = false;
      output.emit('live');
      await delay(1000, waitSignals);
    }

    if (signal.aborted) return;
    if (fatalError) {
      if (this.captureProcess === child) {
        this.captureProcess = null;
        child.kill('SIGTERM');
      }
      output.emit('error', fatalError);
    }
  }

  /**
   * Polls `pw-dump` for up to 5 seconds waiting for the just-spawned
   * `pw-record` process to register its own node (matched by the unique
   * `node.name` we passed it) and publish its two input ports. Timing out
   * means something is seriously wrong with the spawned process -- not a
   * normal "app is quiet" condition -- so the caller treats it as fatal.
   */
  private async discoverOwnPorts(
    nodeName: string,
    signals: AbortSignal[],
  ): Promise<{ inputFL: number; inputFR: number }> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (signals.some((s) => s.aborted)) {
        throw new Error('Aborted while waiting for capture node registration.');
      }

      const raw = await runCapturingStdout('pw-dump', []);
      const objects = parsePwDump(raw);
      const ownNode = findNodeByName(objects, nodeName);
      if (ownNode) {
        const ports = findNodePorts(objects, ownNode.id, 'input_FL', 'input_FR');
        if (ports) return { inputFL: ports.first, inputFR: ports.second };
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for "pw-record" to register its capture node ("${nodeName}") in "pw-dump".`);
      }
      await delay(200, signals);
    }
  }

  /**
   * PulseAudio-compatibility capture loop, used only when `pw-dump` isn't
   * installed. This is a DIFFERENT, older mechanism from PipeWire's
   * node/port/link model above: `parec --monitor-stream=<sink-input-index>`
   * has no equivalent of PipeWire's auto-connect-to-default-source
   * behavior, since PulseAudio sink-input monitoring isn't a link-based
   * graph in the same sense.
   *
   * IMPORTANT: the auto-connect/mic-fallback bug fixed above was diagnosed
   * and verified specifically against PipeWire's link/auto-connect
   * behavior (via `pw-link -l` inspection on real hardware). This fallback
   * path has NOT been verified against the same failure mode -- nor has it
   * been verified to be free of it. It is kept functionally equivalent to
   * this file's pre-fix behavior: `parec` exits when its sink-input goes
   * away (e.g. the app went quiet), and this loop treats that as a
   * transient hiccup and respawns once a match reappears, rather than
   * ending the session.
   */
  private async runPulseAudioCaptureLoop(binary: string, output: PassThrough, signal: AbortSignal): Promise<void> {
    let waitingAnnounced = false;

    while (!signal.aborted) {
      let sinkInputIndex: string | null;
      try {
        sinkInputIndex = await this.findPulseAudioMatch(binary);
      } catch (err) {
        if (!signal.aborted) output.emit('error', err as Error);
        return;
      }
      if (signal.aborted) return;

      if (sinkInputIndex === null) {
        if (!waitingAnnounced) {
          output.emit('waiting');
          waitingAnnounced = true;
        }
        await delay(1000, signal);
        continue;
      }

      waitingAnnounced = false;
      output.emit('live');

      const result = await this.runParecUntilExit(sinkInputIndex, output);
      if (signal.aborted) return;
      if (result.fatal) {
        output.emit('error', result.error ?? new Error('Audio capture process failed.'));
        return;
      }
      // Non-fatal exit (target sink-input disappeared, or some other
      // transient hiccup) -- loop back to the top and start waiting/polling
      // again.
    }
  }

  private async findPulseAudioMatch(binary: string): Promise<string | null> {
    let paRaw: string;
    try {
      paRaw = await runCapturingStdout('pactl', ['list', 'sink-inputs']);
    } catch (err) {
      if (isMissingBinary(err)) {
        throw new Error(
          'No supported audio backend found. Local Bard needs either PipeWire ' +
            '("pw-dump"/"pw-record"/"pw-link") or PulseAudio ("pactl"/"parec") ' +
            'command-line tools installed and on PATH to capture per-application audio.',
        );
      }
      throw new Error(`Failed to run "pactl": ${(err as Error).message}`);
    }
    return parsePactlMatch(paRaw, binary);
  }

  /**
   * Spawns `parec` for one matched sink-input and resolves once it exits,
   * for any reason. `output` is reused across multiple `parec` process
   * lifetimes, so this pipes with `{ end: false }` -- one process's stdout
   * ending must never end the shared output stream.
   */
  private runParecUntilExit(sinkInputIndex: string, output: PassThrough): Promise<{ fatal: boolean; error?: Error }> {
    return new Promise((resolve) => {
      const child = spawn(
        'parec',
        ['--format=s16le', '--rate=48000', '--channels=2', `--monitor-stream=${sinkInputIndex}`, '--raw', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.captureProcess = child;

      let stderrTail = '';
      let settled = false;
      const settle = (result: { fatal: boolean; error?: Error }): void => {
        if (settled) return;
        settled = true;
        if (this.captureProcess === child) this.captureProcess = null;
        resolve(result);
      };

      child.stdout.pipe(output, { end: false });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrTail = (stderrTail + text).slice(-2000);
        output.emit('capture-stderr', text);
      });

      child.on('error', (err) => {
        settle({ fatal: true, error: err });
      });
      child.on('exit', (code, sig) => {
        if (code !== 0 && code !== null) {
          const detail = stderrTail.trim();
          const suffix = detail.length > 0 ? `: ${detail.split('\n')[0]}` : '';
          output.emit(
            'capture-stderr',
            `capture process exited with code ${code} (signal ${sig ?? 'none'})${suffix}`,
          );
        }
        settle({ fatal: false });
      });
    });
  }
}

function parseAppId(appId: string): string {
  if (!appId.startsWith('proc:')) throw new Error(`Unrecognized app id: ${appId}`);
  return appId.slice('proc:'.length);
}

/** Resolves after `ms` milliseconds, or immediately once any signal aborts. */
function delay(ms: number, signal: AbortSignal | readonly AbortSignal[]): Promise<void> {
  const signals = Array.isArray(signal) ? signal : [signal as AbortSignal];
  return new Promise((resolve) => {
    if (signals.some((s) => s.aborted)) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  });
}

/** One object from a `pw-dump` JSON array, narrowed to the fields this file uses. */
type PwObject = {
  id: number;
  type?: string;
  info?: { props?: Record<string, unknown> };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parsePwDump(raw: string): PwObject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Failed to parse "pw-dump" JSON output.');
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((obj): obj is PwObject => isRecord(obj) && typeof obj['id'] === 'number') as PwObject[];
}

function propsOf(obj: PwObject): Record<string, unknown> | null {
  const props = obj.info?.props;
  return isRecord(props) ? props : null;
}

/** Finds the `Stream/Output/Audio` node whose `application.process.binary` matches `binary`. */
function findStreamNode(objects: PwObject[], binary: string): PwObject | null {
  for (const obj of objects) {
    const props = propsOf(obj);
    if (!props) continue;
    if (props['media.class'] !== 'Stream/Output/Audio') continue;

    const nodeBinary = stringProp(props, 'application.process.binary');
    if (nodeBinary === undefined || basename(nodeBinary) !== binary) continue;

    return obj;
  }
  return null;
}

/** Finds the node whose `node.name` prop matches `nodeName` exactly (used to find our own capture node). */
function findNodeByName(objects: PwObject[], nodeName: string): PwObject | null {
  for (const obj of objects) {
    const props = propsOf(obj);
    if (!props) continue;
    if (props['node.name'] !== nodeName) continue;
    return obj;
  }
  return null;
}

/**
 * Finds the two `PipeWire:Interface:Port` objects owned by `nodeId` (i.e.
 * `info.props['node.id'] === nodeId`) named `firstPortName` and
 * `secondPortName`, returning their own registry ids. Returns `null` unless
 * both are found.
 */
function findNodePorts(
  objects: PwObject[],
  nodeId: number,
  firstPortName: string,
  secondPortName: string,
): { first: number; second: number } | null {
  let first: number | null = null;
  let second: number | null = null;

  for (const obj of objects) {
    if (obj.type !== 'PipeWire:Interface:Port') continue;
    const props = propsOf(obj);
    if (!props) continue;
    if (props['node.id'] !== nodeId) continue;

    const portName = props['port.name'];
    if (portName === firstPortName) first = obj.id;
    else if (portName === secondPortName) second = obj.id;
  }

  if (first === null || second === null) return null;
  return { first, second };
}

function parsePactlMatch(raw: string, binary: string): string | null {
  const blocks = raw.split(/\n(?=Sink Input #)/g);
  for (const block of blocks) {
    const idMatch = block.match(/^Sink Input #(\d+)/);
    if (!idMatch || !idMatch[1]) continue;

    const binMatch = block.match(/application\.process\.binary = "([^"]*)"/);
    if (!binMatch || !binMatch[1] || basename(binMatch[1]) !== binary) continue;

    return idMatch[1];
  }
  return null;
}

/** Lists pids of running, non-kernel processes owned by the current user. */
async function listOwnedUserPids(): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch (err) {
    throw new Error(`Failed to list "/proc": ${(err as Error).message}`);
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const pids: number[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);

    let cmdline: Buffer;
    try {
      cmdline = await readFile(`/proc/${entry}/cmdline`);
    } catch {
      continue; // process exited between readdir() and now, or unreadable -- skip.
    }
    if (cmdline.length === 0) continue; // empty cmdline => kernel thread, not a user process.

    if (currentUid !== null && !(await isOwnedByUid(pid, currentUid))) continue;

    pids.push(pid);
  }
  return pids;
}

async function isOwnedByUid(pid: number, uid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^Uid:\s+(\d+)/m);
    return match?.[1] !== undefined && Number(match[1]) === uid;
  } catch {
    return false; // gone, or (rarely) unreadable -- treat as "not ours".
  }
}

/**
 * Resolves a pid's binary basename via `/proc/<pid>/exe`, falling back to
 * `/proc/<pid>/comm` when the symlink can't be read (permission-denied is
 * common for other users'/privileged processes and is not an error here).
 */
async function resolveProcessBinary(pid: number): Promise<string | null> {
  try {
    const exePath = await readlink(`/proc/${pid}/exe`);
    // A replaced-on-disk binary shows up as "/path/to/bin (deleted)".
    const cleaned = exePath.replace(/ \(deleted\)$/, '');
    const base = basename(cleaned);
    if (base.length > 0) return base;
  } catch {
    // Fall through to the /proc/<pid>/comm fallback below.
  }

  try {
    const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    return comm.length > 0 ? comm : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort binary -> friendly display name lookup via installed
 * `.desktop` files. Never throws: a missing directory or a malformed
 * `.desktop` file is silently skipped, since this is purely cosmetic
 * polish over the raw binary name.
 */
async function buildDesktopNameIndex(): Promise<Map<string, string>> {
  const dirs = ['/usr/share/applications', join(homedir(), '.local/share/applications')];
  const index = new Map<string, string>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.desktop')) continue;
      try {
        const content = await readFile(join(dir, entry), 'utf8');
        const nameMatch = content.match(/^Name=(.+)$/m);
        const execMatch = content.match(/^Exec=(.+)$/m);
        const name = nameMatch?.[1]?.trim();
        const execLine = execMatch?.[1]?.trim();
        if (!name || !execLine) continue;

        const firstToken = execLine.split(/\s+/)[0]?.replace(/^"+|"+$/g, '');
        if (!firstToken) continue;

        const execBinary = basename(firstToken);
        if (!index.has(execBinary)) index.set(execBinary, name);
      } catch {
        continue;
      }
    }
  }
  return index;
}

function stringProp(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isMissingBinary(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Runs a fixed executable with a fixed argv array and resolves with its stdout. */
function runCapturingStdout(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(new Error(`"${command}" exited with code ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
      }
    });
  });
}
