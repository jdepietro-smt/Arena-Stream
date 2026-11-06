using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ArenaRemote;

static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public nuint extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public nuint extra; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO { public int cb; public string? lpReserved, lpDesktop, lpTitle; public int x, y, xSize, ySize, xCount, yCount, fill, flags; public short showWindow, reserved2; public nint reserved2p, hStdIn, hStdOut, hStdErr; }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public nint hProcess, hThread; public int pid, tid; }

    public const uint GENERIC_ALL = 0x10000000;
    public const int UOI_NAME = 2;

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] public static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(nint hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(nint hDesktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetUserObjectInformationW(nint h, int index, char[] info, int len, out int needed);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] public static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(nint h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(nint h, uint flags, char[] name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);

    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(nint token, uint access, nint attrs, int impersonation, int tokenType, out nint dup);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(nint token, int cls, ref uint info, int len);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessAsUserW(nint token, string? app, string cmd, nint pa, nint ta, bool inherit, uint flags, nint env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out nint env, nint token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] public static extern bool DestroyEnvironmentBlock(nint env);

    /// <summary>Attaches the calling thread to the desktop currently receiving input (Default, Winlogon for UAC/login, screensaver).</summary>
    public static string? AttachInputDesktop(ref nint current)
    {
        var h = OpenInputDesktop(0, false, GENERIC_ALL);
        if (h == 0) return null;
        if (!SetThreadDesktop(h)) { CloseDesktop(h); return null; }
        if (current != 0) CloseDesktop(current);
        current = h;
        return DesktopName(h);
    }

    public static string DesktopName(nint h)
    {
        var buf = new char[256];
        return GetUserObjectInformationW(h, UOI_NAME, buf, buf.Length * 2, out _) ? new string(buf).TrimEnd('\0') : "?";
    }

    public static string? ImagePath(uint pid)
    {
        var h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
        if (h == 0) return null;
        try { var buf = new char[1024]; int n = buf.Length; return QueryFullProcessImageNameW(h, 0, buf, ref n) ? new string(buf, 0, n) : null; }
        finally { CloseHandle(h); }
    }
}
