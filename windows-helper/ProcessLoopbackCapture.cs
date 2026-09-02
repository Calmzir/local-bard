using System.Runtime.InteropServices;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace LocalBard.WindowsHelper;

/// <summary>
/// Captures the audio rendered by a single process (and its child processes)
/// using the WASAPI "process loopback" activation path introduced in
/// Windows 10 2004 (build 19041), via
/// AUDIOCLIENT_ACTIVATION_PARAMS_TYPE_PROCESS_LOOPBACK.
///
/// There is no managed (NAudio or otherwise) wrapper for this activation
/// path as of writing, so this class does the raw COM interop itself,
/// following the shape of Microsoft's public "ApplicationLoopback" C++
/// sample (activate a virtual "VAD\Process_Loopback" endpoint with a
/// PROPVARIANT-wrapped AUDIOCLIENT_ACTIVATION_PARAMS blob targeting a PID).
///
/// Verified on real Windows 10/11 hardware (see git history for the fixes
/// that came out of that first real run):
///   1. The virtual device path string ("VAD\Process_Loopback") is correct
///      -- activation reaches the completion callback.
///   2. The PROPVARIANT/AUDIOCLIENT_ACTIVATION_PARAMS blob marshaling is
///      accepted by ActivateAudioInterfaceAsync -- fixed a real bug here:
///      pBlobData sits at byte offset 16 of the PROPVARIANT on x64 (8-byte
///      header + 4 bytes of alignment padding after the BLOB's cbSize
///      field), not 12; the wrong offset overflowed the 16-byte allocation
///      and corrupted the heap.
///   3. IActivateAudioInterfaceCompletionHandler is invokable from native
///      code under .NET 8's built-in COM interop -- confirmed, the
///      completion callback does fire.
///   4. GetMixFormat is NOT implemented for process-loopback virtual
///      clients (returns E_NOTIMPL, confirmed on hardware) -- worked
///      around by building the format manually: 32-bit IEEE float, stereo,
///      48kHz, matching Microsoft's own "ApplicationLoopback" sample and
///      how the shared-mode engine actually mixes for this endpoint.
///   5. Switched from a fixed poll loop to event-driven capture
///      (AUDCLNT_STREAMFLAGS_EVENTCALLBACK + SetEventHandle +
///      WaitForSingleObject) for lower, steadier latency, with delivery
///      paced back out to real time so a burst (e.g. after a scheduling
///      delay) doesn't feed the downstream consumer faster than 1x.
///
/// TODO(windows-verify): item 6 is still open -- activating against a
/// target process that hasn't produced any audio yet (no WASAPI session
/// initialized at all) has not specifically been exercised. Local Bard's
/// Node-side wrapper assumes this succeeds immediately and just yields
/// silence via GetNextPacketSize()==0 until the process starts rendering,
/// with no separate wait-and-retry step (see windowsCapture.ts). If
/// activation actually requires an existing/active session, this needs the
/// same poll-and-wait treatment LinuxAudioCapture uses.
/// </summary>
internal static class ProcessLoopbackCapture
{
    // Well-known virtual audio endpoint device path used to request a
    // process-loopback activation instead of a real hardware/software
    // rendering endpoint.
    private const string VirtualAudioDeviceProcessLoopback = "VAD\\Process_Loopback";

    private static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    private const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
    private const ushort VT_BLOB = 65;

    // Event-driven capture, as Microsoft's own "ApplicationLoopback" sample
    // uses, lets the audio engine wake this thread only when a real packet
    // is ready, instead of guessing a poll interval.
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateEventW(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string? lpName);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    private const uint WAIT_OBJECT_0 = 0;

    [DllImport("Mmdevapi.dll", PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams, // pointer to a PROPVARIANT
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [ComImport]
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport]
    [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        int GetBufferSize(out uint bufferFrameCount);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr ppFormat);
        int GetDevicePeriod(out long hnsDefaultDevicePeriod, out long hnsMinimumDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr dataBuffer, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        int ReleaseBuffer(uint numFramesRead);
        int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public int ActivationType;
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    private sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler
    {
        private readonly ManualResetEventSlim _signal = new(false);
        public int HResult { get; private set; }
        public object? Interface { get; private set; }

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            activateOperation.GetActivateResult(out var hr, out var iface);
            HResult = hr;
            Interface = iface;
            _signal.Set();
        }

        public bool Wait(TimeSpan timeout) => _signal.Wait(timeout);
    }

    /// <summary>
    /// Activates process-loopback capture for <paramref name="pid"/> and
    /// writes raw s16le/48kHz/stereo PCM to <paramref name="output"/>
    /// continuously until <paramref name="cancellationToken"/> is signaled.
    /// </summary>
    public static void CaptureToStream(uint pid, Stream output, CancellationToken cancellationToken)
    {
        var activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS
        {
            ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            ProcessLoopbackParams = new AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
            {
                TargetProcessId = pid,
                ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        };

        // PROPVARIANT layout: an 8-byte header (vt + 3 reserved WORDs)
        // followed by the BLOB union member { ULONG cbSize; BYTE *pBlobData; }.
        // On x64, pBlobData (8 bytes) is pointer-aligned, so it sits at
        // offset 16 (4 bytes of padding after cbSize at offset 8) -- total
        // struct size 24 bytes, not 16. Getting this wrong overflows the
        // allocation and corrupts the heap, crashing inside
        // ActivateAudioInterfaceAsync with an AccessViolationException.
        var paramsPtr = Marshal.AllocHGlobal(Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>());
        var propvariantPtr = Marshal.AllocHGlobal(24);
        try
        {
            Marshal.StructureToPtr(activationParams, paramsPtr, false);

            Marshal.WriteInt16(propvariantPtr, 0, (short)VT_BLOB);
            Marshal.WriteInt16(propvariantPtr, 2, 0);
            Marshal.WriteInt16(propvariantPtr, 4, 0);
            Marshal.WriteInt16(propvariantPtr, 6, 0);
            Marshal.WriteInt32(propvariantPtr, 8, Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>());
            Marshal.WriteIntPtr(propvariantPtr, 16, paramsPtr);

            var handler = new CompletionHandler();
            var hr = ActivateAudioInterfaceAsync(
                VirtualAudioDeviceProcessLoopback,
                IID_IAudioClient,
                propvariantPtr,
                handler,
                out var operation);
            Marshal.ThrowExceptionForHR(hr);

            if (!handler.Wait(TimeSpan.FromSeconds(5)))
            {
                throw new TimeoutException(
                    "Timed out waiting for ActivateAudioInterfaceAsync completion callback. " +
                    "See TODO(windows-verify) notes in ProcessLoopbackCapture.cs.");
            }
            Marshal.ThrowExceptionForHR(handler.HResult);

            if (handler.Interface is not IAudioClient audioClient)
            {
                throw new InvalidOperationException("Activated interface was not an IAudioClient.");
            }

            RunCaptureLoop(audioClient, output, cancellationToken);
        }
        finally
        {
            Marshal.FreeHGlobal(propvariantPtr);
            Marshal.FreeHGlobal(paramsPtr);
        }
    }

    private static void RunCaptureLoop(IAudioClient audioClient, Stream output, CancellationToken cancellationToken)
    {
        // Process-loopback virtual audio clients (VAD\Process_Loopback) do
        // not implement GetMixFormat -- it returns E_NOTIMPL. Build the
        // format ourselves: 32-bit IEEE float, stereo, 48kHz is the fixed
        // format Windows' shared-mode audio engine mixes in, per
        // Microsoft's "ApplicationLoopback" sample.
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        var mixFormat = new WAVEFORMATEX
        {
            wFormatTag = WAVE_FORMAT_IEEE_FLOAT,
            nChannels = 2,
            nSamplesPerSec = 48000,
            wBitsPerSample = 32,
            nBlockAlign = 2 * (32 / 8),
            nAvgBytesPerSec = 48000 * 2u * (32u / 8u),
            cbSize = 0,
        };
        var mixFormatPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEFORMATEX>());

        const long refTimesPerSecond = 10_000_000;
        const long bufferDurationHns = refTimesPerSecond; // 1 second buffer.

        IAudioCaptureClient captureClient;
        WaveFormat sourceFormat;
        try
        {
            Marshal.StructureToPtr(mixFormat, mixFormatPtr, false);

            var hrInit = audioClient.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                bufferDurationHns,
                0,
                mixFormatPtr,
                IntPtr.Zero);
            Marshal.ThrowExceptionForHR(hrInit);

            var hrService = audioClient.GetService(IID_IAudioCaptureClient, out var captureClientObj);
            Marshal.ThrowExceptionForHR(hrService);
            captureClient = (IAudioCaptureClient)captureClientObj;

            sourceFormat = ToNAudioWaveFormat(mixFormat);
        }
        finally
        {
            Marshal.FreeHGlobal(mixFormatPtr);
        }

        var targetFormat = new WaveFormat(48000, 16, 2);
        var resampler = BuildResampler(sourceFormat, targetFormat);

        var packetEvent = CreateEventW(IntPtr.Zero, false, false, null);
        if (packetEvent == IntPtr.Zero)
        {
            throw new InvalidOperationException("CreateEventW failed for the audio packet-ready event.");
        }

        try
        {
            var hrEvent = audioClient.SetEventHandle(packetEvent);
            Marshal.ThrowExceptionForHR(hrEvent);

            var startHr = audioClient.Start();
            Marshal.ThrowExceptionForHR(startHr);

            // ponytail: a burst delivery from the engine (e.g. the thread
            // gets scheduled late and several packets have queued up) is
            // paced back out to real time here, so a downstream real-time
            // consumer (Discord) always gets audio at 1x instead of bursts.
            // Source and target are both 48kHz, so 1 source frame == 1
            // target frame with no resampling needed to compare counts.
            var realTime = System.Diagnostics.Stopwatch.StartNew();
            long framesWritten = 0;

            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    var waitResult = WaitForSingleObject(packetEvent, 200);
                    if (waitResult != WAIT_OBJECT_0)
                    {
                        continue; // timeout -- just recheck cancellation.
                    }

                    // Drain everything the engine handed us this wake-up.
                    while (!cancellationToken.IsCancellationRequested)
                    {
                        var hrNext = captureClient.GetNextPacketSize(out var framesAvailable);
                        Marshal.ThrowExceptionForHR(hrNext);
                        if (framesAvailable == 0)
                        {
                            break;
                        }

                        var expectedElapsedMs = framesWritten * 1000 / sourceFormat.SampleRate;
                        var actualElapsedMs = realTime.ElapsedMilliseconds;
                        if (expectedElapsedMs > actualElapsedMs)
                        {
                            Thread.Sleep((int)(expectedElapsedMs - actualElapsedMs));
                        }

                        var hrBuf = captureClient.GetBuffer(out var dataPtr, out var numFrames, out var flags, out _, out _);
                        Marshal.ThrowExceptionForHR(hrBuf);
                        framesWritten += numFrames;

                        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
                        var byteCount = (int)(numFrames * sourceFormat.BlockAlign);
                        if (byteCount > 0)
                        {
                            var buffer = new byte[byteCount];
                            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0)
                            {
                                Marshal.Copy(dataPtr, buffer, 0, byteCount);
                            }
                            // else: leave as zeroed silence.

                            resampler.Feed(buffer, output);
                        }

                        captureClient.ReleaseBuffer(numFrames);
                    }
                }
            }
            finally
            {
                audioClient.Stop();
            }
        }
        finally
        {
            CloseHandle(packetEvent);
        }
    }

    private static WaveFormat ToNAudioWaveFormat(WAVEFORMATEX fmt)
    {
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

        if (fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT)
        {
            return WaveFormat.CreateIeeeFloatWaveFormat((int)fmt.nSamplesPerSec, fmt.nChannels);
        }
        if (fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE)
        {
            // TODO(windows-verify): WAVEFORMATEXTENSIBLE carries the real
            // sub-format GUID after the base WAVEFORMATEX fields; this
            // helper only reads the base fields, so it assumes float samples
            // for extensible formats (true for the vast majority of modern
            // WASAPI shared-mode mix formats, but not guaranteed). Confirm
            // against the actual sub-format GUID on real hardware.
            return WaveFormat.CreateIeeeFloatWaveFormat((int)fmt.nSamplesPerSec, fmt.nChannels);
        }
        return new WaveFormat((int)fmt.nSamplesPerSec, fmt.wBitsPerSample, fmt.nChannels);
    }

    private static StreamingResampler BuildResampler(WaveFormat source, WaveFormat target)
    {
        return new StreamingResampler(source, target);
    }

    /// <summary>
    /// Feeds raw captured bytes through NAudio's sample-provider chain to
    /// resample/convert to the target format and writes the result out.
    /// </summary>
    private sealed class StreamingResampler
    {
        private readonly BufferedWaveProvider _input;
        private readonly ISampleProvider _resampled;
        private readonly WaveFormat _targetFormat;

        public StreamingResampler(WaveFormat sourceFormat, WaveFormat targetFormat)
        {
            _targetFormat = targetFormat;
            _input = new BufferedWaveProvider(sourceFormat)
            {
                BufferDuration = TimeSpan.FromSeconds(5),
                DiscardOnBufferOverflow = true,
                // BufferedWaveProvider.ReadFully defaults to true, which pads
                // short reads with silence instead of returning fewer bytes
                // -- Read() then never returns 0, so the drain loop in Feed()
                // below never terminates once any data has been buffered
                // (observed: an unbounded stream of manufactured silence).
                ReadFully = false,
            };

            ISampleProvider samples = _input.ToSampleProvider();
            if (sourceFormat.Channels != targetFormat.Channels)
            {
                samples = sourceFormat.Channels == 1
                    ? new MonoToStereoSampleProvider(samples)
                    : new StereoToMonoSampleProvider(samples);
            }
            if (sourceFormat.SampleRate != targetFormat.SampleRate)
            {
                samples = new WdlResamplingSampleProvider(samples, targetFormat.SampleRate);
            }
            _resampled = samples;
        }

        public void Feed(byte[] buffer, Stream output)
        {
            _input.AddSamples(buffer, 0, buffer.Length);

            var floatBuffer = new float[4096];
            int read;
            while ((read = _resampled.Read(floatBuffer, 0, floatBuffer.Length)) > 0)
            {
                var pcm16 = new byte[read * 2];
                for (int i = 0; i < read; i++)
                {
                    var sample = Math.Clamp(floatBuffer[i], -1f, 1f);
                    short s = (short)(sample * short.MaxValue);
                    pcm16[i * 2] = (byte)(s & 0xFF);
                    pcm16[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
                }
                output.Write(pcm16, 0, pcm16.Length);
            }
        }
    }
}
