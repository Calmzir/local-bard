import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { app } from 'electron';
import type { AudioCaptureSource } from '../../shared/audioCapture';
import type { CapturableApp } from '../../shared/types';

const HELPER_EXE_NAME = 'LocalBard.WindowsHelper.exe';

/**
 * Windows audio capture. Per-process audio capture on Windows requires the
 * WASAPI "Process Loopback" API, which has no usable Node/npm binding, so
 * this module shells out to a small self-contained .NET helper (see
 * windows-helper/) that does the actual WASAPI work and streams raw PCM
 * (s16le, 48kHz, stereo) on stdout.
 *
 * The helper is invoked with a fixed executable path and a fixed argv array
 * -- never `shell: true`, never string-concatenated commands.
 *
 * TODO(windows-verify): this module has NOT been exercised on real Windows
 * hardware. The C# helper's process-loopback activation, its JSON --list
 * output shape, and its raw PCM --capture stream all need to be verified end
 * to end on Windows 10 2004+ (see windows-helper/Program.cs for the
 * per-call TODO(windows-verify) markers on the native interop itself).
 */
export class WindowsAudioCapture implements AudioCaptureSource {
  private captureProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;

  async listApps(): Promise<CapturableApp[]> {
    const exe = resolveHelperPath();
    if (!existsSync(exe)) {
      throw new Error(
        `Windows audio helper not found at "${exe}". It must be built with ` +
          '"dotnet publish -r win-x64 --self-contained" (see windows-helper/README section ' +
          'in the project README) before per-app audio capture is available.',
      );
    }

    const raw = await runCapturingStdout(exe, ['--list']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Failed to parse windows helper --list JSON output.');
    }
    if (!Array.isArray(parsed)) return [];

    const apps: CapturableApp[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const pid = e['pid'];
      const name = e['name'];
      const processName = e['processName'];
      if (typeof pid !== 'number') continue;
      apps.push({
        id: `win:${pid}`,
        name: typeof name === 'string' && name.length > 0 ? name : `PID ${pid}`,
        processName: typeof processName === 'string' ? processName : 'unknown',
      });
    }
    return apps;
  }

  startCapture(appId: string): Readable {
    this.stopCapture();

    if (!appId.startsWith('win:')) {
      throw new Error(`Unrecognized app id: ${appId}`);
    }
    const pid = appId.slice(4);

    const exe = resolveHelperPath();
    if (!existsSync(exe)) {
      throw new Error(`Windows audio helper not found at "${exe}".`);
    }

    const output = new PassThrough();
    const child = spawn(exe, ['--capture', pid], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.captureProcess = child;

    child.stdout.pipe(output);
    child.stderr.on('data', (chunk: Buffer) => {
      output.emit('capture-stderr', chunk.toString('utf8'));
    });
    child.on('error', (err) => output.emit('error', err));
    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        output.emit('error', new Error(`Windows audio helper exited with code ${code} (signal ${signal ?? 'none'})`));
      }
      output.end();
    });

    return output;
  }

  stopCapture(): void {
    if (this.captureProcess) {
      this.captureProcess.kill();
      this.captureProcess = null;
    }
  }
}

function resolveHelperPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'windows-helper', HELPER_EXE_NAME);
  }
  // Dev-time path: build output of `dotnet publish -r win-x64 --self-contained`
  // run manually inside windows-helper/ (see its README section).
  return join(app.getAppPath(), 'windows-helper', 'publish', 'win-x64', HELPER_EXE_NAME);
}

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
