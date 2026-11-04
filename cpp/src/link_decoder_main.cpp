// link_decoder — Arena Link decoder front end.
//
// Polls the directory, picks the best path to the chosen encoder (LAN direct when it is on
// our network, otherwise the relay), and runs the decode/SDI engine (sdi_decoder.exe, next
// to this file) on it. If the stream drops or the encoder restarts, it re-resolves and
// reconnects; if a path fails to go live, it falls through to the next one.
//
//   link_decoder --directory http://HOST:PORT --key KEY --list
//   link_decoder --directory ... --key ... [--select NAME|ID] [--lan-latency MS] [--relay-latency MS]
//                [-- <extra sdi_decoder args, e.g. --backend aja --device 0 --conn 1 | --preview-only>]
//
// stdout belongs to the engine (binary preview frames). Everything this program says is a JSON
// line on stderr:  {"type":"link_state",...}.  The engine's own stderr lines pass through.
// stdin: "select NAME" switches encoder, "quit" exits (EOF also exits).
#ifndef _WIN32
#include <cstdio>
int main() { std::fputs("link_decoder: Windows only for now\n", stderr); return 1; }
#else

#include "http_post.h"
#include "link_paths.h"

#include <windows.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <functional>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace std::chrono_literals;
using sdi::link::EncoderInfo;
using sdi::link::Path;

std::atomic<bool> g_stop{false};
std::mutex        g_sel_mtx;
std::string       g_select;
std::atomic<bool> g_select_changed{false};

void on_signal(int) { g_stop = true; }

std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
        else if (c >= 0x20)        { o += char(c); }
    }
    return o + "\"";
}

void state(const std::string& st, const std::string& enc = "", const std::string& path = "", const std::string& note = "") {
    std::fprintf(stderr, "{\"type\":\"link_state\",\"state\":%s,\"encoder\":%s,\"path\":%s,\"note\":%s}\n",
                 jstr(st).c_str(), jstr(enc).c_str(), jstr(path).c_str(), jstr(note).c_str());
    std::fflush(stderr);
}

struct Opts {
    std::string directory, key, select;
    bool        list = false;
    int         lan_latency = 40, relay_latency = 100;
    std::vector<std::string> engine_args;
};

bool parse(int argc, char** argv, Opts& o) {
    for (int i = 1; i < argc; ++i) {
        const std::string k = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) { std::fprintf(stderr, "missing value for %s\n", k.c_str()); std::exit(2); }
            return argv[++i];
        };
        if      (k == "--directory")     o.directory = next();
        else if (k == "--key")           o.key = next();
        else if (k == "--select")        o.select = next();
        else if (k == "--list")          o.list = true;
        else if (k == "--lan-latency")   o.lan_latency = std::atoi(next().c_str());
        else if (k == "--relay-latency") o.relay_latency = std::atoi(next().c_str());
        else if (k == "--")              { for (++i; i < argc; ++i) o.engine_args.push_back(argv[i]); }
        else { std::fprintf(stderr, "unknown argument: %s\n", k.c_str()); return false; }
    }
    if (o.key.empty()) if (const char* e = std::getenv("LINK_KEY")) o.key = e;   // keeps it out of process listings
    if (o.directory.empty()) { std::fprintf(stderr, "--directory is required\n"); return false; }
    return true;
}

std::string quote(const std::string& a) {
    if (!a.empty() && a.find_first_of(" \t\"") == std::string::npos) return a;
    std::string q = "\"";
    for (char c : a) { if (c == '"') q += '\\'; q += c; }
    return q + "\"";
}

std::string exe_dir() {
    char b[MAX_PATH];
    const DWORD n = GetModuleFileNameA(nullptr, b, MAX_PATH);
    std::string p(b, n);
    return p.substr(0, p.find_last_of("\\/") + 1);
}

// One engine process. Returns when it exits (or we are told to stop / switch).
// `went_live` is set once it printed its first stats line.
struct EngineResult { bool went_live = false; DWORD exit_code = 0; bool killed = false; };

EngineResult run_engine(const std::string& exe, const std::vector<std::string>& args, HANDLE job,
                        const std::function<void()>& on_live) {
    EngineResult res;
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return res;
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);   // binary preview frames go straight through
    si.hStdError  = wr;

    std::string cmd = quote(exe);
    for (const auto& a : args) cmd += " " + quote(a);
    PROCESS_INFORMATION pi{};
    std::vector<char> mutable_cmd(cmd.begin(), cmd.end());
    mutable_cmd.push_back('\0');
    const BOOL ok = CreateProcessA(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(wr);
    if (!ok) { CloseHandle(rd); res.exit_code = GetLastError(); return res; }
    if (job) AssignProcessToJobObject(job, pi.hProcess);

    std::atomic<bool> live{false};
    std::thread reader([&] {
        std::string line;
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) {
            for (DWORD i = 0; i < n; ++i) {
                if (buf[i] != '\n') { line += buf[i]; continue; }
                if (!live && line.find("\"decoder_stats\"") != std::string::npos) { live = true; on_live(); }
                std::fprintf(stderr, "%s\n", line.c_str());
                std::fflush(stderr);
                line.clear();
            }
        }
    });

    while (WaitForSingleObject(pi.hProcess, 100) == WAIT_TIMEOUT) {
        if (g_stop || g_select_changed) { TerminateProcess(pi.hProcess, 0); res.killed = true; break; }
    }
    WaitForSingleObject(pi.hProcess, 3000);
    GetExitCodeProcess(pi.hProcess, &res.exit_code);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    reader.join();
    CloseHandle(rd);
    res.went_live = live;
    return res;
}

bool fetch(const sdi::net::Url& url, const std::string& key, std::vector<EncoderInfo>& out, std::string& my_ip) {
    std::string body;
    if (sdi::net::http_request(url, "GET", "/v1/encoders", key, "", &body) != 200) return false;
    return sdi::link::parse_encoders(body, out, my_ip);
}

} // namespace

int main(int argc, char** argv) {
    Opts o;
    if (!parse(argc, argv, o)) return 2;
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    sdi::net::Url dir;
    if (!sdi::net::parse_url(o.directory, dir)) { std::fprintf(stderr, "bad --directory\n"); return 2; }
    sdi::link::PathPolicy policy;
    policy.directory_host = dir.host;
    policy.lan_latency_ms = o.lan_latency;
    policy.relay_latency_ms = o.relay_latency;

    if (o.list) {   // one-shot: what is out there and how we would reach it
        std::vector<EncoderInfo> list; std::string me;
        if (!fetch(dir, o.key, list, me)) { std::fprintf(stderr, "directory unreachable or rejected the key\n"); return 1; }
        std::printf("{\"yourIp\":%s,\"encoders\":[", jstr(me).c_str());
        for (size_t i = 0; i < list.size(); ++i) {
            const auto& e = list[i];
            const auto paths = sdi::link::choose_paths(e, me, policy);
            std::printf("%s{\"id\":%s,\"name\":%s,\"format\":%s,\"source\":%s,\"codec\":%s,\"kbps\":%d,\"path\":%s}",
                        i ? "," : "", jstr(e.id).c_str(), jstr(e.name).c_str(), jstr(e.format).c_str(), jstr(e.source).c_str(),
                        jstr(e.codec).c_str(), e.kbps, jstr(paths.empty() ? "unreachable" : paths.front().kind).c_str());
        }
        std::printf("]}\n");
        return 0;
    }

    { std::lock_guard<std::mutex> lk(g_sel_mtx); g_select = o.select; }
    std::thread([&] {   // control channel
        std::string line;
        while (std::getline(std::cin, line)) {
            std::istringstream ss(line);
            std::string cmd, arg;
            ss >> cmd;
            std::getline(ss >> std::ws, arg);
            if (cmd == "select") { { std::lock_guard<std::mutex> lk(g_sel_mtx); g_select = arg; } g_select_changed = true; }
            else if (cmd == "quit") break;
        }
        g_stop = true;
    }).detach();

    // Children die with us, however we exit.
    HANDLE job = CreateJobObjectA(nullptr, nullptr);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
        lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim, sizeof(lim));
    }

    const std::string engine = exe_dir() + "sdi_decoder.exe";
    std::string last_waiting;
    while (!g_stop) {
        g_select_changed = false;
        std::string sel;
        { std::lock_guard<std::mutex> lk(g_sel_mtx); sel = g_select; }

        std::vector<EncoderInfo> list; std::string me;
        if (!fetch(dir, o.key, list, me)) {
            if (last_waiting != "dir") state("waiting", "", "", "directory unreachable");
            last_waiting = "dir";
            std::this_thread::sleep_for(1s);
            continue;
        }
        const EncoderInfo* enc = sdi::link::find_encoder(list, sel);
        if (!enc) {
            const std::string note = sel.empty() ? "no encoders on air" : "waiting for " + sel;
            if (last_waiting != note) state("waiting", sel, "", note);
            last_waiting = note;
            std::this_thread::sleep_for(500ms);
            continue;
        }
        last_waiting.clear();

        const auto paths = sdi::link::choose_paths(*enc, me, policy);
        if (paths.empty()) {
            state("waiting", enc->name, "", "no reachable path (encoder is on another network and not on the relay)");
            std::this_thread::sleep_for(1s);
            continue;
        }

        bool live_once = false;
        for (const Path& p : paths) {
            if (g_stop || g_select_changed) break;
            state("connecting", enc->name, p.kind, p.url);
            std::vector<std::string> args{"--src", p.url, "--latency", std::to_string(p.latency_ms)};
            args.insert(args.end(), o.engine_args.begin(), o.engine_args.end());
            const auto t0 = std::chrono::steady_clock::now();
            const EngineResult r = run_engine(engine, args, job, [&] { state("live", enc->name, p.kind, p.url); });
            if (r.killed) break;
            const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            state(r.went_live ? "ended" : "failed", enc->name, p.kind,
                  "engine exit " + std::to_string(r.exit_code) + " after " + std::to_string(int(secs)) + "s");
            if (r.went_live) { live_once = true; break; }   // it worked: retry the same best path first
        }
        std::this_thread::sleep_for(live_once ? 300ms : 1s);
    }
    state("stopped");
    return 0;
}

#endif  // _WIN32
