using System.Drawing;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32;
using static ArenaRemote.Native;

namespace ArenaRemote;

/// <summary>
/// Runs in the interactive session as SYSTEM (started by the service). It can attach to the secure desktop, so it is the
/// only component able to type into UAC prompts / elevated windows and to see the login and UAC screens.
/// Speaks length-prefixed messages over a named pipe: [type:1][len:4 LE][payload]; 'J' = JSON, 'F' = JPEG frame.
/// </summary>
sealed class Helper
{
    readonly string pipeName;
    readonly bool dev;
    readonly object writeLock = new();
    volatile bool frames;
    volatile int boundsX, boundsY, boundsW, boundsH;
    volatile bool control;

    public Helper(string pipeName, bool dev) { this.pipeName = pipeName; this.dev = dev; }

    public void Run()
    {
        using (new Bitmap(1, 1)) { } // starts GDI+ on this thread
        Jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        SetProcessDPIAware(); // physical pixels, so normalized viewer coordinates map correctly
        while (true)
        {
            using var p = Create();
            p.WaitForConnection();
            if (!Trusted(p)) { Log("rejected untrusted pipe client"); continue; }
            Log("client connected");
            try { Serve(p); } catch (Exception e) { Log("session ended: " + e.Message); }
            frames = false; control = false;
            ReleaseAll();
        }
    }

    NamedPipeServerStream Create()
    {
        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        // Any local user may open the pipe; trust is decided per connection from the client's executable and session (Trusted).
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        if (dev) sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User!, PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, sec);
    }

    /// <summary>
    /// A same-user process must not be able to drive a SYSTEM helper (that would be a UAC bypass). Only the installed
    /// Arena Remote executable, in the same session, may connect. Dev mode (never used by the service) skips the path check.
    /// </summary>
    bool Trusted(NamedPipeServerStream p)
    {
        if (!GetNamedPipeClientProcessId(p.SafePipeHandle, out var pid)) return false;
        if (!ProcessIdToSessionId(pid, out var s) || !ProcessIdToSessionId((uint)Environment.ProcessId, out var mine) || s != mine) return false;
        if (dev) return true;
        var path = ImagePath(pid);
        var allowed = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\ArenaRemote", "ClientExe", null) as string;
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        return path != null && allowed != null && string.Equals(path, allowed, StringComparison.OrdinalIgnoreCase) && path.StartsWith(pf, StringComparison.OrdinalIgnoreCase);
    }

    void Serve(NamedPipeServerStream p)
    {
        new Thread(() => Monitor(p)) { IsBackground = true }.Start();
        new Thread(() => Capture(p)) { IsBackground = true }.Start();
        nint desk = 0; long lastAttach = 0;
        var hdr = new byte[5];
        while (true)
        {
            ReadExact(p, hdr, 5);
            var len = BitConverter.ToInt32(hdr, 1);
            if (len < 0 || len > 65536) throw new InvalidDataException("bad frame");
            var buf = new byte[len];
            ReadExact(p, buf, len);
            if (hdr[0] != (byte)'J') continue;
            using var doc = JsonDocument.Parse(buf);
            var e = doc.RootElement;
            switch (e.GetProperty("t").GetString())
            {
                case "hello":
                    boundsX = e.GetProperty("x").GetInt32(); boundsY = e.GetProperty("y").GetInt32();
                    boundsW = e.GetProperty("w").GetInt32(); boundsH = e.GetProperty("h").GetInt32();
                    break;
                case "frames": frames = e.GetProperty("on").GetBoolean(); break;
                case "control": control = e.GetProperty("on").GetBoolean(); if (!control) ReleaseAll(); break;
                case "in":
                    if (!control) break;
                    if (Environment.TickCount64 - lastAttach > 100) { AttachInputDesktop(ref desk); lastAttach = Environment.TickCount64; }
                    if (!Inject(e)) { AttachInputDesktop(ref desk); Inject(e); }
                    break;
            }
        }
    }

    // ---- input ----
    const uint MOVE = 1, LDOWN = 2, LUP = 4, RDOWN = 8, RUP = 0x10, MDOWN = 0x20, MUP = 0x40, XDOWN = 0x80, XUP = 0x100, WHEEL = 0x800, HWHEEL = 0x1000, VDESK = 0x4000, ABS = 0x8000;
    static readonly (uint down, uint up, uint data)[] Buttons = { (LDOWN, LUP, 0), (MDOWN, MUP, 0), (RDOWN, RUP, 0), (XDOWN, XUP, 1), (XDOWN, XUP, 2) };

    static INPUT Mouse(int dx, int dy, uint data, uint flags) => new() { type = 0, mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags } };
    static INPUT Key(int sc, bool ext, bool up) => new() { type = 1, ki = new KEYBDINPUT { scan = (ushort)sc, flags = 8 | (ext ? 1u : 0) | (up ? 2u : 0) } };
    static bool Send(params INPUT[] i) => SendInput((uint)i.Length, i, System.Runtime.InteropServices.Marshal.SizeOf<INPUT>()) == i.Length;
    static double Clamp01(double v) => double.IsFinite(v) ? Math.Min(1, Math.Max(0, v)) : 0;
    static int Num(double v) => double.IsFinite(v) ? (int)Math.Clamp(Math.Round(v), -120000, 120000) : 0;

    bool Inject(JsonElement e)
    {
        switch (e.GetProperty("k").GetString())
        {
            case "mm":
            {
                int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
                var px = boundsX + Clamp01(e.GetProperty("x").GetDouble()) * (boundsW - 1);
                var py = boundsY + Clamp01(e.GetProperty("y").GetDouble()) * (boundsH - 1);
                return Send(Mouse((int)Math.Round((px - vx) * 65535 / (vw - 1)), (int)Math.Round((py - vy) * 65535 / (vh - 1)), 0, MOVE | ABS | VDESK));
            }
            case "mr": return Send(Mouse(Num(e.GetProperty("dx").GetDouble()), Num(e.GetProperty("dy").GetDouble()), 0, MOVE));
            case "md": case "mu":
            {
                var b = e.GetProperty("b").GetInt32();
                if (b < 0 || b >= Buttons.Length) return true;
                var down = e.GetProperty("k").GetString() == "md";
                return Send(Mouse(0, 0, Buttons[b].data, down ? Buttons[b].down : Buttons[b].up));
            }
            case "wh":
            {
                var list = new List<INPUT>();
                if (e.TryGetProperty("dy", out var dy) && dy.GetDouble() != 0) list.Add(Mouse(0, 0, unchecked((uint)Num(-dy.GetDouble())), WHEEL));
                if (e.TryGetProperty("dx", out var dx) && dx.GetDouble() != 0) list.Add(Mouse(0, 0, unchecked((uint)Num(dx.GetDouble())), HWHEEL));
                return list.Count == 0 || Send(list.ToArray());
            }
            case "kd": case "ku":
                return Send(Key(e.GetProperty("sc").GetInt32() & 0xFF, e.GetProperty("ext").GetBoolean(), e.GetProperty("k").GetString() == "ku"));
            case "ra": ReleaseAll(); return true;
        }
        return true;
    }

    static readonly (int, bool)[] HeldCandidates = Enumerable.Range(1, 0x58).Select(i => (i, false))
        .Concat(new[] { (0x1d, true), (0x38, true), (0x5b, true), (0x5c, true), (0x48, true), (0x50, true), (0x4b, true), (0x4d, true), (0x53, true) }).ToArray();

    static void ReleaseAll()
    {
        var l = new List<INPUT> { Mouse(0, 0, 0, LUP), Mouse(0, 0, 0, MUP), Mouse(0, 0, 0, RUP) };
        foreach (var (sc, ext) in HeldCandidates) l.Add(Key(sc, ext, true));
        Send(l.ToArray());
    }

    // ---- desktop monitor + secure-desktop capture ----
    void Monitor(NamedPipeServerStream p)
    {
        string? last = null;
        try
        {
            while (p.IsConnected)
            {
                var h = OpenInputDesktop(0, false, GENERIC_ALL);
                var name = h == 0 ? "?" : DesktopName(h);
                if (h != 0) CloseDesktop(h);
                if (name != last) { last = name; Write(p, (byte)'J', JsonSerializer.SerializeToUtf8Bytes(new { t = "desktop", name })); }
                Thread.Sleep(100);
            }
        }
        catch { }
    }

    ImageCodecInfo Jpeg = null!; // resolved on the main thread in Run: GDI+ must be warmed up before worker threads use it

    void Capture(NamedPipeServerStream p)
    {
        nint desk = 0;
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
        try
        {
            while (p.IsConnected)
            {
                var t0 = Environment.TickCount64;
                if (!frames || boundsW <= 0) { Thread.Sleep(30); continue; }
                AttachInputDesktop(ref desk);
                int w = boundsW, h = boundsH;
                using var full = new Bitmap(w, h, PixelFormat.Format32bppRgb);
                using (var g = Graphics.FromImage(full)) g.CopyFromScreen(boundsX, boundsY, 0, 0, new Size(w, h));
                // Downscale big displays: this path is a fallback for UAC/login screens, so responsiveness beats sharpness.
                int tw = Math.Min(w, 1920), th = h * tw / w;
                using var small = tw == w ? null : new Bitmap(tw, th, PixelFormat.Format32bppRgb);
                if (small != null) using (var g = Graphics.FromImage(small)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear; g.DrawImage(full, 0, 0, tw, th); }
                using var ms = new MemoryStream();
                (small ?? full).Save(ms, Jpeg, ep);
                Write(p, (byte)'F', ms.ToArray());
                var wait = 33 - (int)(Environment.TickCount64 - t0);
                if (wait > 0) Thread.Sleep(wait);
            }
        }
        catch (Exception e) { Log("capture stopped: " + e.Message); }
    }

    // ---- pipe plumbing ----
    void Write(NamedPipeServerStream p, byte type, byte[] payload)
    {
        var msg = new byte[5 + payload.Length];
        msg[0] = type;
        BitConverter.GetBytes(payload.Length).CopyTo(msg, 1);
        payload.CopyTo(msg, 5);
        lock (writeLock) { p.Write(msg, 0, msg.Length); p.Flush(); }
    }

    static void ReadExact(Stream s, byte[] buf, int n)
    {
        for (int got = 0; got < n;)
        {
            var r = s.Read(buf, got, n - got);
            if (r <= 0) throw new EndOfStreamException();
            got += r;
        }
    }

    static void Log(string m) => Console.Error.WriteLine($"[helper {DateTime.Now:HH:mm:ss}] {m}");
}
