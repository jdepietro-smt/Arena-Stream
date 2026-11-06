using System.Diagnostics;
using System.ServiceProcess;
using static ArenaRemote.Native;

namespace ArenaRemote;

/// <summary>
/// Session-0 service. Keeps one helper alive inside whichever session owns the physical console (including the
/// login screen), running as SYSTEM so it can reach the secure desktop. Restarts it on crash or session change.
/// </summary>
sealed class LauncherService : ServiceBase
{
    public const string Name = "ArenaRemoteHelper";
    public const string PipeName = "arena-remote-helper";
    readonly CancellationTokenSource stop = new();
    Thread? loop;

    public LauncherService() { ServiceName = Name; CanStop = true; }

    protected override void OnStart(string[] args)
    {
        loop = new Thread(Loop) { IsBackground = true };
        loop.Start();
    }

    protected override void OnStop() { stop.Cancel(); loop?.Join(5000); }

    void Loop()
    {
        nint proc = 0; uint session = uint.MaxValue;
        while (!stop.IsCancellationRequested)
        {
            var sid = WTSGetActiveConsoleSessionId();
            var alive = proc != 0 && WaitForSingleObject(proc, 0) == 0x102; // WAIT_TIMEOUT: still running
            if (sid != uint.MaxValue && (!alive || sid != session))
            {
                if (proc != 0) { TerminateProcess(proc, 0); CloseHandle(proc); proc = 0; }
                proc = Launch(sid);
                session = sid;
            }
            stop.Token.WaitHandle.WaitOne(1000);
        }
        if (proc != 0) { TerminateProcess(proc, 0); CloseHandle(proc); }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern uint WaitForSingleObject(nint h, uint ms);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool TerminateProcess(nint h, uint code);

    /// <summary>Starts the helper in <paramref name="sessionId"/> with a copy of this service's SYSTEM token.</summary>
    static nint Launch(uint sessionId)
    {
        if (!OpenProcessToken(GetCurrentProcess(), 0xF01FF /* TOKEN_ALL_ACCESS */, out var tok)) return 0;
        try
        {
            if (!DuplicateTokenEx(tok, 0x2000000 /* MAXIMUM_ALLOWED */, 0, 2, 1 /* primary */, out var dup)) return 0;
            try
            {
                if (!SetTokenInformation(dup, 12 /* TokenSessionId */, ref sessionId, 4)) return 0;
                if (!CreateEnvironmentBlock(out var env, dup, false)) env = 0;
                var si = new STARTUPINFO { lpDesktop = @"winsta0\default" };
                si.cb = System.Runtime.InteropServices.Marshal.SizeOf(si);
                var cmd = $"\"{Environment.ProcessPath}\" helper --pipe {PipeName}";
                // CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
                var ok = CreateProcessAsUserW(dup, null, cmd, 0, 0, false, 0x400 | 0x08000000, env, null, ref si, out var pi);
                if (env != 0) DestroyEnvironmentBlock(env);
                if (!ok) return 0;
                CloseHandle(pi.hThread);
                return pi.hProcess;
            }
            finally { CloseHandle(dup); }
        }
        finally { CloseHandle(tok); }
    }
}
