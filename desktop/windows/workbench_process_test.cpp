
#include "workbench_process.h"

#include <array>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string_view>

namespace {
using namespace jiangjie;
using namespace jiangjie::process_detail;

void Require(bool value, const char* context) {
    if (!value) throw std::runtime_error(context);
}

fs::path Executable() {
    std::array<wchar_t, 32768> name{};
    const auto length = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
    Require(length && length < name.size(), "locate test executable");
    return name.data();
}

HANDLE Spawn(const fs::path& exe, const std::wstring& args) {
    auto command = QuoteArgument(exe.native()) + L" " + args;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    Require(CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child) != 0, "start subprocess");
    CloseHandle(child.hThread);
    return child.hProcess;
}

DesktopPaths Paths(const fs::path& root) {
    DesktopPaths p;
    p.app = root / L"应用 ' space";
    p.data = root / L"data";
    p.logs = root / L"logs";
    p.cache = root / L"cache";
    p.workspace = root / L"workspace";
    p.node = Executable();
    p.browser = p.app / L"runtime/chromium/chrome.exe";
    return p;
}

constexpr auto ready = "{\"event\":\"ready\",\"port\":49152,\"healthUrl\":\"http://127.0.0.1:49152/bohack/api/health\"}";

int FakeNode(int argc, wchar_t** argv) {
    Require(argc == 4 && std::wstring_view(argv[2]) == L"--port" && std::wstring_view(argv[3]) == L"0", "dynamic port args");
    Require(GetConsoleWindow() == nullptr, "no console");
    std::array<wchar_t, 32768> env{};
    Require(GetEnvironmentVariableW(L"DSH_INTERNAL_TOKEN", env.data(), static_cast<DWORD>(env.size())) &&
        std::wstring_view(env.data()) == L"unit-test-token", "internal token");
    Require(!GetEnvironmentVariableW(L"NODE_OPTIONS", env.data(), static_cast<DWORD>(env.size())), "Node options sanitized");
    Require(GetEnvironmentVariableW(L"JIANGJIE_APP_ROOT", env.data(), static_cast<DWORD>(env.size())), "app root");
    Require(fs::path(argv[1]) == fs::path(env.data()) / L"dsh-workbench-fix/dsh-base/start-dsh.mjs", "Unicode script path");
    Require(GetEnvironmentVariableW(L"JIANGJIE_CACHE_DIR", env.data(), static_cast<DWORD>(env.size())), "cache root");
    auto leaf = Spawn(Executable(), L"--leaf");
    { std::ofstream(fs::current_path() / L"pids") << GetCurrentProcessId() << ' ' << GetProcessId(leaf) << '\n'; }
    CloseHandle(leaf);
    std::cout << ready << std::endl;
    char value = 0;
    DWORD count = 0;
    const auto ok = ReadFile(GetStdHandle(STD_INPUT_HANDLE), &value, sizeof(value), &count, nullptr);
    Require(!ok ? GetLastError() == ERROR_BROKEN_PIPE : count == 0, "close sends EOF");
    { std::ofstream(fs::current_path() / L"graceful") << '1'; }
    return 0;
}

std::pair<HANDLE, HANDLE> WaitForTree(const fs::path& workspace, WorkbenchProcess* process = nullptr) {
    bool received = !process;
    const auto deadline = GetTickCount64() + 8000;
    for (; GetTickCount64() < deadline; Sleep(20)) {
        if (process && process->PollReady() == 49152) received = true;
        DWORD root = 0, leaf = 0;
        if (!received || !(std::ifstream(workspace / L"pids") >> root >> leaf)) continue;
        auto first = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, root);
        auto second = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, leaf);
        Require(first && second, "acquire process handles");
        Require(WaitForSingleObject(first, 0) == WAIT_TIMEOUT && WaitForSingleObject(second, 0) == WAIT_TIMEOUT,
            "root and descendant are alive");
        return {first, second};
    }
    throw std::runtime_error("process tree did not become ready");
}

void BothExited(const std::pair<HANDLE, HANDLE>& tree) {
    const HANDLE processes[]{tree.first, tree.second};
    Require(WaitForMultipleObjects(2, processes, TRUE, 5000) == WAIT_OBJECT_0, "Job Object reaps child and descendant");
    CloseHandle(tree.first);
    CloseHandle(tree.second);
}

void Test(const fs::path& root) {
    Require(ParseReadyPort(ready) == 49152, "valid readiness event");
    Require(!ParseReadyPort("{\"event\":\"ready\",\"port\":65536}"), "reject out-of-range port");
    Require(!ParseReadyPort(std::string(ready) + "junk"), "reject trailing content");
    Require(QuoteArgument(L"路径 \\\"") == L"\"路径 \\\\\\\"\"", "escape backslashes before a quote");
    Require(QuoteArgument(L"ends\\") == L"\"ends\\\\\"", "escape trailing backslash");

    const auto graceful = Paths(root / L"graceful");
    WorkbenchProcess backend;
    SetEnvironmentVariableW(L"NODE_OPTIONS", L"--invalid");
    backend.Start(graceful, L"unit-test-token");
    const auto gracefulTree = WaitForTree(graceful.workspace, &backend);
    backend.Stop(4000);
    BothExited(gracefulTree);
    Require(fs::exists(graceful.workspace / L"graceful"), "normal exit received EOF");

    const auto forced = Paths(root / L"forced");
    const auto owner = Spawn(Executable(), L"--owner " + QuoteArgument((root / L"forced").native()));
    try {
        const auto forcedTree = WaitForTree(forced.workspace);
        Require(TerminateProcess(owner, 9) != 0, "force-terminate only the owner");
        Require(WaitForSingleObject(owner, 5000) == WAIT_OBJECT_0, "owner exited");
        BothExited(forcedTree);
    } catch (...) {
        TerminateProcess(owner, 9);
        CloseHandle(owner);
        throw;
    }
    CloseHandle(owner);

    const auto diag = Paths(root / L"diag");
    LogMain(diag, "startup");
    LogMain(diag, "desktop_failure", 2);
    const auto zipPath = root / L"原生降级诊断.zip";
    ExportNativeFallbackDiagnostics(diag, zipPath);
    std::ifstream zipIn(zipPath, std::ios::binary);
    const std::string zipBytes((std::istreambuf_iterator<char>(zipIn)), std::istreambuf_iterator<char>());
    Require(zipBytes.size() > 64 && zipBytes.starts_with("PK\x03\x04"), "fallback diagnostics ZIP header");
    Require(zipBytes.find("system.json") != std::string::npos, "fallback ZIP has system.json");
    Require(zipBytes.find("\"fallback\":true") != std::string::npos, "fallback ZIP marks fallback mode");
    Require(zipBytes.find("logs/main.log") != std::string::npos, "fallback ZIP includes main.log");
    Require(zipBytes.find("\"desktop_failure\"") != std::string::npos, "fallback ZIP preserves main.log events");
    bool rejectedBadExt = false;
    try { ExportNativeFallbackDiagnostics(diag, root / L"bad.txt"); } catch (const std::invalid_argument&) { rejectedBadExt = true; }
    Require(rejectedBadExt, "fallback rejects non-zip path");
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc > 1) {
            const std::wstring_view mode(argv[1]);
            if (mode == L"--leaf") { Sleep(INFINITE); return 1; }
            if (mode == L"--owner" && argc == 3) {
                WorkbenchProcess backend;
                backend.Start(Paths(argv[2]), L"unit-test-token");
                Sleep(INFINITE);
                return 1;
            }
            return FakeNode(argc, argv);
        }
        const auto root = fs::temp_directory_path() / (L"jj-wp-" + std::to_wstring(GetCurrentProcessId()) + L"-" + CreateSessionToken().substr(0, 12));
        fs::create_directories(root);
        Test(root);
        fs::remove_all(root);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
