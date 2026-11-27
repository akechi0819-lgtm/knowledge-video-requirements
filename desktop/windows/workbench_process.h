#pragma once

#include <windows.h>
#include <filesystem>
#include <string>
#include <vector>

namespace jiangjie {
namespace fs = std::filesystem;

struct DesktopPaths {
    fs::path app, data, local, logs, cache, workspace, webview, node, browser;
};

DesktopPaths ResolveDesktopPaths();
std::wstring CreateSessionToken();
std::wstring CurrentUserSid();
void LogMain(const DesktopPaths& paths, const char* event, unsigned long code = 0) noexcept;
void RecordNativeCrashes(const DesktopPaths& paths);
void AttachDesktopJob();

class WorkbenchProcess {
public:
    ~WorkbenchProcess();
    WorkbenchProcess() = default;
    WorkbenchProcess(const WorkbenchProcess&) = delete;
    WorkbenchProcess& operator=(const WorkbenchProcess&) = delete;

    void Start(const DesktopPaths& paths, const std::wstring& token);
    // Returns the port from the supervisor's identity-verified HTTP 200 readiness event.
    unsigned PollReady();
    bool Exited() const;
    DWORD ExitCode() const;
    void RequestStop();
    void Stop(DWORD graceMs = 4000);

private:
    HANDLE job_ = nullptr, process_ = nullptr, input_ = nullptr, output_ = nullptr;
    std::string pending_;
};

// Launches the exporter without a console and returns an owned process handle.
// The caller checks the exit code and closes the handle.
HANDLE StartDiagnosticsExport(const DesktopPaths& paths, const fs::path& destination);
// Native fallback when the bundled Node runtime is missing or blocked.
// Writes a standard ZIP with system metadata and native main logs only.
void ExportNativeFallbackDiagnostics(const DesktopPaths& paths, const fs::path& destination);

namespace process_detail {
std::wstring QuoteArgument(const std::wstring& arg);
unsigned ParseReadyPort(const std::string& line);
}
}
