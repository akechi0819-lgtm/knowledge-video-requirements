#include "release/release_engine.h"

#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <string>

namespace {
namespace fs = std::filesystem;
using namespace jiangjie::release;

fs::path SelfDir() {
    std::wstring exe(32768, L'\0');
    const DWORD len = GetModuleFileNameW(nullptr, exe.data(), static_cast<DWORD>(exe.size()));
    if (!len || len == exe.size()) return {};
    exe.resize(len);
    return fs::path(exe).parent_path();
}

bool LaunchTarget(const fs::path& exe, const std::wstring& extraArgs, bool waitAndForwardExit, DWORD* exitCodeOut) {
    std::wstring cmd = L"\"" + exe.native() + L"\"";
    if (!extraArgs.empty()) cmd += L" " + extraArgs;
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, exe.parent_path().c_str(), &si, &pi)) {
        return false;
    }
    CloseHandle(pi.hThread);
    if (waitAndForwardExit) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD code = 0;
        GetExitCodeProcess(pi.hProcess, &code);
        if (exitCodeOut) *exitCodeOut = code;
    }
    CloseHandle(pi.hProcess);
    return true;
}

std::wstring RawArgs() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return {};
    std::wstring out;
    for (int i = 1; i < argc; ++i) {
        if (!out.empty()) out += L" ";
        out += L"\"";
        for (const wchar_t* p = argv[i]; *p; ++p) {
            if (*p == L'"') out += L"\\\"";
            else out.push_back(*p);
        }
        out += L"\"";
    }
    LocalFree(argv);
    return out;
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    const fs::path root = SelfDir();
    if (root.empty()) return 1;
    const std::wstring passArgs = RawArgs();
    std::error_code ec;

    // Flat staging / development layout: sibling JiangjieApp.exe without current.json
    const fs::path currentJson = root / L"current.json";
    const fs::path siblingApp = root / L"JiangjieApp.exe";
    if (!fs::is_regular_file(currentJson, ec) && fs::is_regular_file(siblingApp, ec)) {
        DWORD code = 0;
        if (!LaunchTarget(siblingApp, passArgs, true, &code)) {
            MessageBoxW(nullptr, L"无法启动讲界视频工坊主程序（JiangjieApp.exe）。请检查安装文件完整性。",
                        L"讲界视频工坊", MB_OK | MB_ICONERROR);
            return 1;
        }
        return static_cast<int>(code);
    }

    const InstallLayout layout = ResolveInstallLayout(root);
    const fs::path logFile = layout.logsDir / L"launcher.log";

    // Attempt pending update activation when acquiring the user lock succeeds and no desktop window is alive
    if (fs::is_regular_file(layout.pendingJson, ec)) {
        const std::wstring singleInstanceMutex = L"Local\\Jiangjie.Desktop." + CurrentUserSidString();
        HANDLE probe = OpenMutexW(SYNCHRONIZE, FALSE, singleInstanceMutex.c_str());
        const bool desktopRunning = (probe != nullptr);
        if (probe) CloseHandle(probe);

        if (!desktopRunning) {
            UserUpdateLock lock;
            if (lock.Acquire(3000)) {
                std::string activateErr;
                if (ActivatePendingUpdate(layout, &activateErr)) {
                    LogReleaseEvent(logFile, "launcher", "pending_update_activated");
                } else if (!activateErr.empty()) {
                    LogReleaseEvent(logFile, "launcher", "pending_update_failed", activateErr, 1);
                }
            }
        }
    }

    // Automatic rollback if the newly activated version repeatedly failed before becoming healthy
    {
        UserUpdateLock lock;
        if (lock.Acquire(2000)) {
            std::string rollbackReason;
            if (CheckAndRollbackIfUnhealthy(layout, 2, &rollbackReason)) {
                LogReleaseEvent(logFile, "launcher", "rollback_triggered", rollbackReason);
            }
        }
    }

    auto state = ReadCurrentState(layout);
    if (!state) {
        if (fs::is_regular_file(siblingApp, ec)) {
            DWORD code = 0;
            return LaunchTarget(siblingApp, passArgs, true, &code) ? static_cast<int>(code) : 1;
        }
        MessageBoxW(nullptr, L"未找到有效的版本清单（current.json）。请重新运行安装程序修复。",
                    L"讲界视频工坊", MB_OK | MB_ICONERROR);
        return 1;
    }

    fs::path targetExe = layout.versionsDir / std::to_wstring(state->releaseSequence) / L"JiangjieApp.exe";
    if (!fs::is_regular_file(targetExe, ec)) {
        // Fallback to previous verified version if target is missing
        if (state->previousSequence > 0) {
            const fs::path prevExe = layout.versionsDir / std::to_wstring(state->previousSequence) / L"JiangjieApp.exe";
            if (fs::is_regular_file(prevExe, ec)) {
                LogReleaseEvent(logFile, "launcher", "missing_target_fallback_previous", std::to_string(state->previousSequence));
                state->releaseSequence = state->previousSequence;
                state->version = state->previousVersion;
                state->healthySequence = state->previousSequence;
                state->previousSequence = 0;
                state->unverifiedAttempts = 0;
                WriteCurrentStateAtomic(layout, *state);
                targetExe = prevExe;
            }
        }
    }

    if (!fs::is_regular_file(targetExe, ec)) {
        MessageBoxW(nullptr, L"讲界视频工坊主程序缺失或已被安全软件隔离，请重新安装。",
                    L"讲界视频工坊", MB_OK | MB_ICONERROR);
        return 1;
    }

    // Track unverified startup attempts so Launcher can automatically roll back if this sequence crashes before ready
    if (state->healthySequence != state->releaseSequence) {
        state->unverifiedAttempts += 1;
        WriteCurrentStateAtomic(layout, *state);
    }

    // Inform JiangjieApp of its active sequence & install root
    SetEnvironmentVariableW(L"JIANGJIE_INSTALL_ROOT", layout.installRoot.c_str());
    SetEnvironmentVariableW(L"JIANGJIE_ACTIVE_SEQUENCE", std::to_wstring(state->releaseSequence).c_str());

    LogReleaseEvent(logFile, "launcher", "launch_version", state->version + " (seq " + std::to_string(state->releaseSequence) + ")");
    if (!LaunchTarget(targetExe, passArgs, false, nullptr)) {
        LogReleaseEvent(logFile, "launcher", "launch_failed", WideToUtf8(targetExe.native()), GetLastError());
        MessageBoxW(nullptr, L"无法启动讲界视频工坊，请检查安全软件拦截记录或重新安装。",
                    L"讲界视频工坊", MB_OK | MB_ICONERROR);
        return 1;
    }
    return 0;
}
