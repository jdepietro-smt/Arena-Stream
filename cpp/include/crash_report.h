#pragma once
//
// Crash report for the Arena Link programs (Windows).
//
// An access violation normally just ends the process with exit code 0xC0000005 and no clue where.
// This installs an unhandled-exception filter that writes, to stderr (which the app shows in its
// LOG and puts in COPY REPORT):
//   CRASH: exception 0xC0000005 (reading address 0x0) in DeckLinkAPI64.dll+0x1A2B3
//   CRASH:   #0 DeckLinkAPI64.dll+0x1A2B3
//   CRASH:   #1 sdi_decoder.exe+0x5F10
//   ...
// and saves a minidump (%TEMP%\arena-link-<program>-<time>.dmp) for a debugger. The module name is
// usually enough: our own exe means our code, a driver DLL means the driver (or a call into it).

#ifdef _WIN32

#include <windows.h>
#include <dbghelp.h>

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <string>

namespace sdi::crash {

inline const char* g_program = "arena-link";

inline std::string where(DWORD64 addr) {
    HMODULE mod = nullptr;
    char name[MAX_PATH] = "?";
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCSTR>(addr), &mod) && mod) {
        GetModuleFileNameA(mod, name, MAX_PATH);
        const char* base = name;
        for (const char* p = name; *p; ++p) if (*p == '\\' || *p == '/') base = p + 1;
        char buf[MAX_PATH + 32];
        std::snprintf(buf, sizeof(buf), "%s+0x%llX", base, (unsigned long long)(addr - reinterpret_cast<DWORD64>(mod)));
        return buf;
    }
    char buf[48];
    std::snprintf(buf, sizeof(buf), "0x%llX", (unsigned long long)addr);
    return buf;
}

inline LONG WINAPI filter(EXCEPTION_POINTERS* ep) {
    static volatile LONG once = 0;
    if (InterlockedExchange(&once, 1)) return EXCEPTION_CONTINUE_SEARCH;   // a crash while reporting: give up

    const EXCEPTION_RECORD* r = ep->ExceptionRecord;
    char detail[96] = "";
    if (r->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && r->NumberParameters >= 2)
        std::snprintf(detail, sizeof(detail), " (%s address 0x%llX)",
                      r->ExceptionInformation[0] == 0 ? "reading" : r->ExceptionInformation[0] == 1 ? "writing" : "executing",
                      (unsigned long long)r->ExceptionInformation[1]);
    std::fprintf(stderr, "CRASH: %s exception 0x%08lX%s in %s\n", g_program, r->ExceptionCode, detail,
                 where(reinterpret_cast<DWORD64>(r->ExceptionAddress)).c_str());

    // Call stack from the faulting context.
    CONTEXT ctx = *ep->ContextRecord;
    STACKFRAME64 sf{};
    sf.AddrPC.Mode = sf.AddrFrame.Mode = sf.AddrStack.Mode = AddrModeFlat;
#ifdef _M_X64
    const DWORD machine = IMAGE_FILE_MACHINE_AMD64;
    sf.AddrPC.Offset = ctx.Rip; sf.AddrFrame.Offset = ctx.Rbp; sf.AddrStack.Offset = ctx.Rsp;
#else
    const DWORD machine = IMAGE_FILE_MACHINE_I386;
    sf.AddrPC.Offset = ctx.Eip; sf.AddrFrame.Offset = ctx.Ebp; sf.AddrStack.Offset = ctx.Esp;
#endif
    HANDLE proc = GetCurrentProcess(), thr = GetCurrentThread();
    SymInitialize(proc, nullptr, TRUE);
    for (int i = 0; i < 24; ++i) {
        if (!StackWalk64(machine, proc, thr, &sf, &ctx, nullptr, SymFunctionTableAccess64, SymGetModuleBase64, nullptr)) break;
        if (!sf.AddrPC.Offset) break;
        std::fprintf(stderr, "CRASH:   #%d %s\n", i, where(sf.AddrPC.Offset).c_str());
    }

    // Minidump for a debugger.
    char dir[MAX_PATH];
    const DWORD n = GetTempPathA(MAX_PATH, dir);
    if (n > 0 && n < MAX_PATH - 80) {
        char path[MAX_PATH];
        std::snprintf(path, sizeof(path), "%sarena-link-%s-%lld.dmp", dir, g_program, (long long)std::time(nullptr));
        HANDLE f = CreateFileA(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (f != INVALID_HANDLE_VALUE) {
            MINIDUMP_EXCEPTION_INFORMATION mei{GetCurrentThreadId(), ep, FALSE};
            if (MiniDumpWriteDump(proc, GetCurrentProcessId(), f, MiniDumpWithIndirectlyReferencedMemory, &mei, nullptr, nullptr))
                std::fprintf(stderr, "CRASH: dump saved to %s\n", path);
            CloseHandle(f);
        }
    }
    std::fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;   // end the process with the exception code, as before
}

inline void install(const char* program) {
    g_program = program;
    SetUnhandledExceptionFilter(filter);
    // ARENA_LINK_TEST_CRASH=1 crashes on purpose, to check this report on a given PC.
    if (std::getenv("ARENA_LINK_TEST_CRASH")) { volatile int* p = nullptr; *p = 1; }
}

} // namespace sdi::crash

#else
namespace sdi::crash { inline void install(const char*) {} }
#endif
