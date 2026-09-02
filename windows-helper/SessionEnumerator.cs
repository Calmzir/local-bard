using System.Diagnostics;
using NAudio.CoreAudioApi;

namespace LocalBard.WindowsHelper;

public sealed record AudioProcessInfo(int Pid, string Name, string ProcessName);

/// <summary>
/// Enumerates processes that currently have an active audio session, by
/// walking every render endpoint's <see cref="AudioSessionManager2"/> and
/// reading each session's owning process id. This part uses NAudio's public,
/// well-exercised CoreAudioApi surface (no raw COM interop), so it should be
/// reliable, but has still only been exercised by static review here, not on
/// a real Windows machine -- see TODO(windows-verify) below.
/// </summary>
public static class SessionEnumerator
{
    public static List<AudioProcessInfo> ListAudioActiveProcesses()
    {
        var byPid = new Dictionary<int, AudioProcessInfo>();

        using var enumerator = new MMDeviceEnumerator();
        var devices = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);

        foreach (var device in devices)
        {
            AudioSessionManager? sessionManager;
            try
            {
                sessionManager = device.AudioSessionManager;
            }
            catch (Exception)
            {
                // A device can legitimately fail to hand back a session
                // manager (in use exclusively elsewhere, disabled, etc).
                // Skip it rather than aborting the whole listing.
                continue;
            }

            if (sessionManager is null) continue;

            var sessions = sessionManager.Sessions;
            for (int i = 0; i < sessions.Count; i++)
            {
                using var session = sessions[i];

                // Deliberately NOT filtering on session.State here: Local
                // Bard wants to list an app the moment it has initialized an
                // audio client, even if it hasn't started playback yet
                // (State == AudioSessionStateInactive), not just apps
                // already producing sound (State == AudioSessionStateActive).
                //
                // TODO(windows-verify): confirm on real hardware that
                // AudioSessionControl.GetProcessID reliably returns the
                // owning process id for every session state (Active,
                // Inactive, Expired), that Inactive ("initialized but
                // silent") sessions are actually enumerated here rather than
                // only appearing once playback starts, and that sessions
                // belonging to the system sounds / audio service host
                // process (pid 0 or the "audiodg.exe" mixer) are filtered
                // out sensibly here rather than showing up as a confusing
                // phantom entry.
                int pid;
                try
                {
                    pid = (int)session.GetProcessID;
                }
                catch (Exception)
                {
                    continue;
                }

                if (pid <= 0 || byPid.ContainsKey(pid)) continue;

                string processName;
                string displayName;
                try
                {
                    using var process = Process.GetProcessById(pid);
                    processName = process.ProcessName;
                    displayName = string.IsNullOrWhiteSpace(session.DisplayName)
                        ? process.MainWindowTitle is { Length: > 0 } title ? title : process.ProcessName
                        : session.DisplayName;
                }
                catch (ArgumentException)
                {
                    // Process exited between enumeration and lookup.
                    continue;
                }

                byPid[pid] = new AudioProcessInfo(pid, displayName, processName);
            }
        }

        return byPid.Values.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }
}
