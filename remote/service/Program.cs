using System.Diagnostics;
using System.Security.Principal;
using System.ServiceProcess;
using Microsoft.Win32;

namespace ArenaRemote;

static class Program
{
    static int Main(string[] args)
    {
        var cmd = args.FirstOrDefault() ?? "help";
        string Opt(string name, string fallback) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback; }
        switch (cmd)
        {
            case "service": ServiceBase.Run(new LauncherService()); return 0;
            // `helper --dev` runs unelevated in the current session for development: skips the client-path check.
            case "helper": new Helper(Opt("--pipe", LauncherService.PipeName), args.Contains("--dev")).Run(); return 0;
            case "install": return Install(Opt("--client", ""));
            case "uninstall": return Uninstall();
            default:
                Console.WriteLine("ArenaRemoteService install --client <path to Arena Remote.exe> | uninstall | helper [--dev] [--pipe name]");
                return 1;
        }
    }

    static bool IsAdmin() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    static int Sc(string args)
    {
        using var p = Process.Start(new ProcessStartInfo("sc.exe", args) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true })!;
        Console.Write(p.StandardOutput.ReadToEnd());
        p.WaitForExit();
        return p.ExitCode;
    }

    static int Install(string client)
    {
        if (!IsAdmin()) { Console.Error.WriteLine("Run from an elevated (Administrator) prompt."); return 2; }
        if (!File.Exists(client)) { Console.Error.WriteLine("--client must point to the installed Arena Remote.exe"); return 2; }
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!Path.GetFullPath(client).StartsWith(pf, StringComparison.OrdinalIgnoreCase))
        { Console.Error.WriteLine("The app must live under Program Files so ordinary users cannot replace it."); return 2; }
        Registry.SetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\ArenaRemote", "ClientExe", Path.GetFullPath(client));
        var exe = Environment.ProcessPath!;
        Sc($"create {LauncherService.Name} binPath= \"\\\"{exe}\\\" service\" start= auto obj= LocalSystem DisplayName= \"Arena Remote Helper\"");
        Sc($"description {LauncherService.Name} \"Lets Arena Remote operate UAC prompts, elevated windows and the sign-in screen.\"");
        Sc($"failure {LauncherService.Name} reset= 86400 actions= restart/2000/restart/2000/restart/5000");
        return Sc($"start {LauncherService.Name}");
    }

    static int Uninstall()
    {
        if (!IsAdmin()) { Console.Error.WriteLine("Run from an elevated (Administrator) prompt."); return 2; }
        Sc($"stop {LauncherService.Name}");
        Sc($"delete {LauncherService.Name}");
        try { Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\ArenaRemote", false); } catch { }
        return 0;
    }
}
