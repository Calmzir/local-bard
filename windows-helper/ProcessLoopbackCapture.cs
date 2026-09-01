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
/// TODO(windows-verify): this entire class is unverified native interop --
/// it has been written from documented struct/interface layouts and public
/// sample code, but has NOT been run against the real Windows audio stack.
/// Before shipping, a maintainer on real Windows 10 (2004+) or Windows 11
/// hardware must verify, at minimum:
///   1. The exact virtual device path string ("VAD\Process_Loopback") is
///      still correct for the target Windows build.
///   2. The PROPVARIANT/AUDIOCLIENT_ACTIVATION_PARAMS blob marshaling below
///      (byte layout, VT_BLOB tag, struct sizes) is accepted by
///      ActivateAudioInterfaceAsync without HRESULT failure.
///   3. The managed IActivateAudioInterfaceCompletionHandler implementation
///      is actually invokable from native code under .NET 8's default COM
///      interop (built-in COM interop, not source-generated ComWrappers) --
///      if it silently never fires, the ManualResetEventSlim wait below will
///      time out and this needs a different interop strategy (e.g. a
///      classic COM class factory registration, or moving this piece to a
///      tiny native shim).
///   4. GetMixFormat's actual returned format on real hardware (bit depth,
///      float vs PCM, channel count, sample rate) matches the assumptions
///      in ConvertToTargetFormat below, and that the WdlResamplingSampleProvider
///      chain produces glitch-free, correctly-timed 48kHz/stereo/s16le audio.
///   5. Capture latency and buffer sizing (currently a fixed 20ms poll loop)
///      is acceptable for real-time Discord streaming, and does not need an
///      event-driven (AUDCLNT_STREAMFLAGS_EVENTCALLBACK) redesign.
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
    private const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    private const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
    private const ushort VT_BLOB = 65;

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

        // TODO(windows-verify): PROPVARIANT construction. VT_BLOB expects
        // { cbSize: uint, pBlobData: pointer } at offset 8 of a 16-byte
        // PROPVARIANT (the first 8 bytes are vt + reserved words). This is
        // built manually with AllocHGlobal below rather than via
        // System.Runtime.InteropServices.ComTypes because that namespace has
        // no ready-made VT_BLOB helper; double-check the offsets against a
        // real `propidl.h` PROPVARIANT definition if activation fails.
        var paramsPtr = Marshal.AllocHGlobal(Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>());
        var propvariantPtr = Marshal.AllocHGlobal(16);
        try
        {
            Marshal.StructureToPtr(activationParams, paramsPtr, false);

            Marshal.WriteInt16(propvariantPtr, 0, (short)VT_BLOB);
            Marshal.WriteInt16(propvariantPtr, 2, 0);
            Marshal.WriteInt16(propvariantPtr, 4, 0);
            Marshal.WriteInt16(propvariantPtr, 6, 0);
            Marshal.WriteInt32(propvariantPtr, 8, Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>());
            Marshal.WriteIntPtr(propvariantPtr, 12, paramsPtr);

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
        var hrMix = audioClient.GetMixFormat(out var mixFormatPtr);
        Marshal.ThrowExceptionForHR(hrMix);
        var mixFormat = Marshal.PtrToStructure<WAVEFORMATEX>(mixFormatPtr);

        const long refTimesPerSecond = 10_000_000;
        const long bufferDurationHns = refTimesPerSecond; // 1 second buffer.

        var hrInit = audioClient.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            bufferDurationHns,
            0,
            mixFormatPtr,
            IntPtr.Zero);
        Marshal.ThrowExceptionForHR(hrInit);

        var hrService = audioClient.GetService(IID_IAudioCaptureClient, out var captureClientObj);
        Marshal.ThrowExceptionForHR(hrService);
        var captureClient = (IAudioCaptureClient)captureClientObj;

        var sourceFormat = ToNAudioWaveFormat(mixFormat);
        var targetFormat = new WaveFormat(48000, 16, 2);
        var resampler = BuildResampler(sourceFormat, targetFormat);

        var startHr = audioClient.Start();
        Marshal.ThrowExceptionForHR(startHr);

        try
        {
            // Polling loop rather than event-driven capture -- see
            // TODO(windows-verify) item 5 on the class doc comment about
            // revisiting this for lower/steadier latency.
            while (!cancellationToken.IsCancellationRequested)
            {
                captureClient.GetNextPacketSize(out var framesAvailable);
                if (framesAvailable == 0)
                {
                    Thread.Sleep(10);
                    continue;
                }

                var hrBuf = captureClient.GetBuffer(out var dataPtr, out var numFrames, out var flags, out _, out _);
                Marshal.ThrowExceptionForHR(hrBuf);

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
        finally
        {
            audioClient.Stop();
            Marshal.FreeCoTaskMem(mixFormatPtr);
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
