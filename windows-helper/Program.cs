using System.Text.Json;
using LocalBard.WindowsHelper;

// Fixed, argv-driven CLI surface: exactly two modes, no freeform input.
//   --list            -> print JSON array of {pid, name, processName} to stdout, exit.
//   --capture <pid>    -> stream raw s16le/48kHz/stereo PCM to stdout until killed.

if (args.Length == 1 && args[0] == "--list")
{
    try
    {
        var processes = SessionEnumerator.ListAudioActiveProcesses();
        var json = JsonSerializer.Serialize(processes.Select(p => new
        {
            pid = p.Pid,
            name = p.Name,
            processName = p.ProcessName,
        }));
        Console.Out.Write(json);
        return 0;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Failed to list audio sessions: {ex}");
        return 1;
    }
}

if (args.Length == 2 && args[0] == "--capture" && uint.TryParse(args[1], out var pid))
{
    using var stdout = Console.OpenStandardOutput();
    using var cts = new CancellationTokenSource();

    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;
        cts.Cancel();
    };

    try
    {
        ProcessLoopbackCapture.CaptureToStream(pid, stdout, cts.Token);
        return 0;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Capture failed: {ex}");
        return 1;
    }
}

Console.Error.WriteLine("Usage: LocalBard.WindowsHelper.exe --list | --capture <pid>");
return 2;
