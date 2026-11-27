#include "release_engine.h"
#include "build_config.h"

#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>

namespace {
namespace fs = std::filesystem;
using namespace jiangjie::release;

constexpr wchar_t kClassName[] = L"JiangjieOnlineBootstrapperWnd";
constexpr wchar_t kTitle[] = L"讲界视频工坊 · 在线安装器";
constexpr UINT kMsgUiUpdate = WM_APP + 10;
constexpr UINT kMsgDone = WM_APP + 11;
constexpr UINT kBtnCancel = 2001;
constexpr UINT kBtnRetry = 2002;

struct Options {
    std::string feedUrl = JIANGJIE_UPDATE_FEED_URL;
    std::string channel = JIANGJIE_UPDATE_CHANNEL;
    std::string pinnedPubKey = JIANGJIE_RELEASE_PUBKEY_B64;
    bool silent = false;
    bool noLaunch = false;
    bool allowLocalHttp = false;
    bool requireAuthenticode = false;
    bool dryRunDownload = false;
    fs::path installRoot;
};

struct UiSnapshot {
    std::wstring headline;
    std::wstring detail;
    int percent = 0; // 0..100, -1 = indeterminate
    bool failed = false;
    bool finished = false;
};

std::wstring FormatSize(uint64_t bytes) {
    wchar_t buf[64]{};
    if (bytes >= 1024ULL * 1024ULL * 1024ULL) {
        std::swprintf(buf, std::size(buf), L"%.2f GB", static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0));
    } else if (bytes >= 1024ULL * 1024ULL) {
        std::swprintf(buf, std::size(buf), L"%.1f MB", static_cast<double>(bytes) / (1024.0 * 1024.0));
    } else if (bytes >= 1024ULL) {
        std::swprintf(buf, std::size(buf), L"%.0f KB", static_cast<double>(bytes) / 1024.0);
    } else {
        std::swprintf(buf, std::size(buf), L"%llu B", static_cast<unsigned long long>(bytes));
    }
    return buf;
}

bool ParseCommandLine(Options& opts) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return true;
    for (int i = 1; i < argc; ++i) {
        const std::wstring arg = argv[i];
        auto next = [&]() -> std::wstring {
            return (i + 1 < argc) ? std::wstring(argv[++i]) : L"";
        };
        if (arg == L"--silent" || arg == L"/S" || arg == L"/s") {
            opts.silent = true;
            opts.noLaunch = true;
        } else if (arg == L"--no-launch" || arg == L"/NOLAUNCH") {
            opts.noLaunch = true;
        } else if (arg == L"--launch") {
            opts.noLaunch = false;
        } else if (arg == L"--allow-local-http") {
            opts.allowLocalHttp = true;
        } else if (arg == L"--require-authenticode") {
            opts.requireAuthenticode = true;
        } else if (arg == L"--dry-run-download") {
            opts.dryRunDownload = true;
        } else if (arg == L"--feed-url") {
            opts.feedUrl = WideToUtf8(next());
        } else if (arg == L"--channel") {
            opts.channel = WideToUtf8(next());
        } else if (arg == L"--install-dir") {
            opts.installRoot = fs::path(next());
        }
    }
    LocalFree(argv);
    return true;
}

class BootstrapperApp {
public:
    explicit BootstrapperApp(Options opts)
        : opts_(std::move(opts)), layout_(ResolveInstallLayout(opts_.installRoot)) {}

    ~BootstrapperApp() {
        cancel_.store(true);
        if (worker_.joinable()) worker_.join();
    }

    int RunHeadless() {
        RunWorkflow();
        return exitCode_.load();
    }

    int RunGui(HINSTANCE instance) {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        INITCOMMONCONTROLSEX icc{sizeof(icc), ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES};
        InitCommonControlsEx(&icc);

        WNDCLASSW wc{};
        wc.lpfnWndProc = WndProc;
        wc.hInstance = instance;
        wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        wc.lpszClassName = kClassName;
        if (!RegisterClassW(&wc)) return 1;

        const UINT dpi = GetDpiForSystem();
        const int w = MulDiv(540, dpi, 96);
        const int h = MulDiv(320, dpi, 96);
        const int sx = GetSystemMetrics(SM_CXSCREEN);
        const int sy = GetSystemMetrics(SM_CYSCREEN);
        hwnd_ = CreateWindowExW(0, kClassName, kTitle,
                                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                                (sx - w) / 2, (sy - h) / 2, w, h, nullptr, nullptr, instance, this);
        if (!hwnd_) return 1;

        retryBtn_ = CreateWindowW(L"BUTTON", L"一键重试", WS_CHILD | WS_TABSTOP | BS_DEFPUSHBUTTON,
                                  MulDiv(270, dpi, 96), MulDiv(232, dpi, 96), MulDiv(112, dpi, 96), MulDiv(34, dpi, 96),
                                  hwnd_, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kBtnRetry)), instance, nullptr);
        cancelBtn_ = CreateWindowW(L"BUTTON", L"取消", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                   MulDiv(396, dpi, 96), MulDiv(232, dpi, 96), MulDiv(104, dpi, 96), MulDiv(34, dpi, 96),
                                   hwnd_, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kBtnCancel)), instance, nullptr);

        HFONT btnFont = CreateFontW(-MulDiv(10, dpi, 96), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                    DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
        SendMessageW(retryBtn_, WM_SETFONT, reinterpret_cast<WPARAM>(btnFont), TRUE);
        SendMessageW(cancelBtn_, WM_SETFONT, reinterpret_cast<WPARAM>(btnFont), TRUE);
        btnFont_ = btnFont;

        ShowWindow(hwnd_, SW_SHOWNORMAL);
        UpdateWindow(hwnd_);
        StartWorker();

        MSG msg{};
        while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
            if (!IsDialogMessageW(hwnd_, &msg)) {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        return exitCode_.load();
    }

private:
    Options opts_;
    InstallLayout layout_;
    HWND hwnd_ = nullptr;
    HWND retryBtn_ = nullptr;
    HWND cancelBtn_ = nullptr;
    HFONT btnFont_ = nullptr;
    std::mutex uiMu_;
    UiSnapshot ui_{L"正在连接下载源…", L"全流程免管理员权限，将安装到当前用户目录。", -1, false, false};
    std::atomic<bool> cancel_{false};
    std::atomic<int> exitCode_{1};
    std::thread worker_;

    void UpdateUi(std::wstring headline, std::wstring detail, int percent, bool failed = false, bool finished = false) {
        {
            std::lock_guard<std::mutex> g(uiMu_);
            ui_ = {std::move(headline), std::move(detail), percent, failed, finished};
        }
        if (hwnd_) PostMessageW(hwnd_, kMsgUiUpdate, 0, 0);
    }

    void StartWorker() {
        cancel_.store(false);
        if (worker_.joinable()) worker_.join();
        ShowWindow(retryBtn_, SW_HIDE);
        EnableWindow(cancelBtn_, TRUE);
        SetWindowTextW(cancelBtn_, L"取消");
        worker_ = std::thread([this]() {
            RunWorkflow();
            if (hwnd_) PostMessageW(hwnd_, kMsgDone, 0, 0);
        });
    }

    void RunWorkflow() {
        const fs::path logFile = layout_.logsDir / L"installer.log";
        LogReleaseEvent(logFile, "bootstrapper", "start", opts_.feedUrl);

        UserUpdateLock lock;
        if (!lock.Acquire(10000)) {
            LogReleaseEvent(logFile, "bootstrapper", "lock_busy");
            exitCode_.store(2);
            UpdateUi(L"已有另一个安装或更新任务正在运行", L"请等待当前任务完成后再试。", 0, true);
            return;
        }

        UpdateUi(L"正在获取最新版本信息…", L"验证 HTTPS 发布清单与签名", 5);
        DownloadOptions dlOpts;
        dlOpts.allowLocalHttp = opts_.allowLocalHttp;
        dlOpts.cancelFlag = &cancel_;

        std::string err;
        const std::string feedText = HttpGetText(opts_.feedUrl, dlOpts.allowedHosts, opts_.allowLocalHttp, &err);
        if (feedText.empty()) {
            LogReleaseEvent(logFile, "bootstrapper", "feed_fetch_failed", err, 10);
            exitCode_.store(10);
            UpdateUi(L"无法获取版本清单", L"网络异常：" + Utf8ToWide(err) + L"\n请检查网络连接后点击「一键重试」。", 0, true);
            return;
        }

        FeedVerifyOptions verifyOpts;
        verifyOpts.pinnedPublicKeyBase64Url = opts_.pinnedPubKey;
        verifyOpts.requireSignature = !opts_.pinnedPubKey.empty();
        verifyOpts.checkExpiry = true;

        auto feed = ParseAndVerifyReleaseFeed(feedText, verifyOpts, &err);
        if (!feed || !feed->offline) {
            LogReleaseEvent(logFile, "bootstrapper", "feed_verify_failed", err.empty() ? "missing offline artifact" : err, 11);
            exitCode_.store(11);
            UpdateUi(L"版本清单校验未通过", Utf8ToWide(err.empty() ? "发布清单缺少离线安装包条目" : err), 0, true);
            return;
        }

        const auto& offline = *feed->offline;
        const std::wstring verW = Utf8ToWide(feed->version);
        const fs::path fileName = offline.fileName.empty()
                                      ? (L"Jiangjie-" + verW + L"-Setup-Offline-x64.exe")
                                      : Utf8ToWide(offline.fileName);
        const fs::path downloadedInstaller = layout_.downloadsDir / fileName;

        dlOpts.expectedSize = offline.sizeBytes;
        dlOpts.expectedSha256 = offline.sha256;
        dlOpts.maxRetries = 3;
        dlOpts.onProgress = [this, verW](const DownloadProgress& prog) {
            int pct = 10;
            if (prog.totalBytes > 0) {
                pct = 10 + static_cast<int>((prog.downloadedBytes * 70ULL) / prog.totalBytes);
                pct = std::clamp(pct, 10, 80);
            }
            std::wstring detail = L"版本 v" + verW + L" · " + FormatSize(prog.downloadedBytes);
            if (prog.totalBytes > 0) detail += L" / " + FormatSize(prog.totalBytes);
            if (prog.bytesPerSecond > 1024.0) detail += L" · " + FormatSize(static_cast<uint64_t>(prog.bytesPerSecond)) + L"/s";
            if (prog.resumed) detail += L"（断点续传）";
            UpdateUi(L"正在下载讲界视频工坊完整程序…", detail, pct);
        };

        UpdateUi(L"正在下载讲界视频工坊完整程序…", L"版本 v" + verW + L" · 支持断点续传与 SHA-256 校验", 10);
        if (!DownloadFileWithResume(offline.url, downloadedInstaller, dlOpts, &err)) {
            const bool cancelled = cancel_.load();
            LogReleaseEvent(logFile, "bootstrapper", cancelled ? "download_cancelled" : "download_failed", err, cancelled ? 12 : 13);
            exitCode_.store(cancelled ? 12 : 13);
            UpdateUi(cancelled ? L"安装已取消" : L"下载未完成",
                     cancelled ? L"已保留断点进度，下次打开可继续下载。" : (Utf8ToWide(err) + L"\n点击「一键重试」将继续断点下载。"),
                     0, true);
            return;
        }

        UpdateUi(L"正在校验安装包完整性…", L"SHA-256 校验通过，核验发布者签名", 82);
        if (opts_.requireAuthenticode) {
            if (!VerifyAuthenticode(downloadedInstaller, &err)) {
                LogReleaseEvent(logFile, "bootstrapper", "authenticode_failed", err, 14);
                exitCode_.store(14);
                UpdateUi(L"安装包数字签名校验失败", Utf8ToWide(err), 0, true);
                return;
            }
        }

        if (opts_.dryRunDownload) {
            LogReleaseEvent(logFile, "bootstrapper", "dry_run_download_ok", WideToUtf8(downloadedInstaller.native()));
            exitCode_.store(0);
            UpdateUi(L"下载与 SHA-256 校验通过", L"已缓存至：" + downloadedInstaller.native(), 100, false, true);
            return;
        }

        UpdateUi(L"正在静默安装到当前用户目录…", layout_.installRoot.native(), 88);
        std::wstring installArgs = L"/S /NOLAUNCH /D=" + layout_.installRoot.native();
        std::wstring cmd = L"\"" + downloadedInstaller.native() + L"\" " + installArgs;
        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi{};
        if (!CreateProcessW(downloadedInstaller.c_str(), cmd.data(), nullptr, nullptr, FALSE,
                            CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
            const DWORD lastErr = GetLastError();
            LogReleaseEvent(logFile, "bootstrapper", "installer_spawn_failed", WideToUtf8(downloadedInstaller.native()), lastErr);
            exitCode_.store(20);
            UpdateUi(L"无法启动离线安装程序", L"错误代码 " + std::to_wstring(lastErr) + L"，请检查安全软件拦截记录。", 0, true);
            return;
        }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, 600000);
        DWORD installerCode = 1;
        GetExitCodeProcess(pi.hProcess, &installerCode);
        CloseHandle(pi.hProcess);
        if (installerCode != 0) {
            LogReleaseEvent(logFile, "bootstrapper", "installer_failed", std::to_string(installerCode), installerCode);
            exitCode_.store(static_cast<int>(installerCode));
            UpdateUi(L"安装过程出现错误", L"安装器返回码 " + std::to_wstring(installerCode) + L"\n日志位置：" + logFile.native(), 0, true);
            return;
        }

        LogReleaseEvent(logFile, "bootstrapper", "install_succeeded", feed->version);
        UpdateUi(L"安装完成", L"讲界视频工坊 v" + verW + L" 已安装就绪。", 100, false, true);

        if (!opts_.noLaunch) {
            const fs::path launcherExe = layout_.installRoot / L"Jiangjie.exe";
            std::error_code ec;
            if (fs::is_regular_file(launcherExe, ec)) {
                ShellExecuteW(nullptr, L"open", launcherExe.c_str(), nullptr, layout_.installRoot.c_str(), SW_SHOWNORMAL);
                LogReleaseEvent(logFile, "bootstrapper", "app_launched");
            }
        }
        exitCode_.store(0);
    }

    static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        if (msg == WM_NCCREATE) {
            auto* self = static_cast<BootstrapperApp*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            self->hwnd_ = hwnd;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        auto* self = reinterpret_cast<BootstrapperApp*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        return self ? self->HandleMessage(msg, wp, lp) : DefWindowProcW(hwnd, msg, wp, lp);
    }

    LRESULT HandleMessage(UINT msg, WPARAM wp, LPARAM lp) {
        switch (msg) {
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT:
            Paint();
            return 0;
        case kMsgUiUpdate:
            SyncButtons();
            InvalidateRect(hwnd_, nullptr, FALSE);
            return 0;
        case kMsgDone:
            SyncButtons();
            InvalidateRect(hwnd_, nullptr, FALSE);
            if (exitCode_.load() == 0) {
                SetTimer(hwnd_, 1, 900, nullptr);
            }
            return 0;
        case WM_TIMER:
            if (wp == 1) {
                KillTimer(hwnd_, 1);
                DestroyWindow(hwnd_);
            }
            return 0;
        case WM_COMMAND:
            if (LOWORD(wp) == kBtnCancel) {
                UiSnapshot snap;
                { std::lock_guard<std::mutex> g(uiMu_); snap = ui_; }
                if (snap.failed || snap.finished) {
                    DestroyWindow(hwnd_);
                } else {
                    cancel_.store(true);
                    EnableWindow(cancelBtn_, FALSE);
                    SetWindowTextW(cancelBtn_, L"正在取消…");
                }
                return 0;
            }
            if (LOWORD(wp) == kBtnRetry) {
                StartWorker();
                return 0;
            }
            return 0;
        case WM_CLOSE:
            cancel_.store(true);
            DestroyWindow(hwnd_);
            return 0;
        case WM_DESTROY:
            if (btnFont_) DeleteObject(btnFont_);
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd_, msg, wp, lp);
        }
    }

    void SyncButtons() {
        UiSnapshot snap;
        { std::lock_guard<std::mutex> g(uiMu_); snap = ui_; }
        if (snap.failed) {
            ShowWindow(retryBtn_, SW_SHOW);
            EnableWindow(cancelBtn_, TRUE);
            SetWindowTextW(cancelBtn_, L"关闭");
        } else if (snap.finished) {
            ShowWindow(retryBtn_, SW_HIDE);
            EnableWindow(cancelBtn_, TRUE);
            SetWindowTextW(cancelBtn_, L"完成");
        }
    }

    void Paint() {
        UiSnapshot snap;
        { std::lock_guard<std::mutex> g(uiMu_); snap = ui_; }

        PAINTSTRUCT ps{};
        HDC dc = BeginPaint(hwnd_, &ps);
        RECT rc{};
        GetClientRect(hwnd_, &rc);

        HBRUSH bg = CreateSolidBrush(RGB(14, 14, 16));
        FillRect(dc, &rc, bg);
        DeleteObject(bg);

        const UINT dpi = GetDpiForWindow(hwnd_);
        const auto s = [dpi](int v) { return MulDiv(v, dpi, 96); };
        SetBkMode(dc, TRANSPARENT);

        auto drawText = [&](const std::wstring& txt, RECT r, int pt, int weight, COLORREF color, UINT fmt = DT_LEFT | DT_WORDBREAK | DT_NOPREFIX) {
            HFONT f = CreateFontW(-MulDiv(pt, dpi, 96), 0, 0, 0, weight, FALSE, FALSE, FALSE,
                                  DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
            HGDIOBJ old = SelectObject(dc, f);
            SetTextColor(dc, color);
            DrawTextW(dc, txt.c_str(), -1, &r, fmt);
            SelectObject(dc, old);
            DeleteObject(f);
        };

        drawText(L"☀  讲界视频工坊", {s(32), s(26), rc.right - s(32), s(64)}, 16, FW_BOLD, RGB(246, 174, 98));
        drawText(snap.headline, {s(32), s(74), rc.right - s(32), s(112)}, 13, FW_SEMIBOLD,
                 snap.failed ? RGB(244, 114, 114) : RGB(245, 245, 245));
        drawText(snap.detail, {s(32), s(112), rc.right - s(32), s(172)}, 9, FW_NORMAL, RGB(178, 178, 178));

        // Progress bar track
        RECT track{s(32), s(182), rc.right - s(32), s(194)};
        HBRUSH trackBrush = CreateSolidBrush(RGB(44, 44, 48));
        FillRect(dc, &track, trackBrush);
        DeleteObject(trackBrush);

        const int pct = std::clamp(snap.percent < 0 ? 15 : snap.percent, 0, 100);
        if (pct > 0 && !snap.failed) {
            RECT fill = track;
            fill.right = track.left + ((track.right - track.left) * pct) / 100;
            HBRUSH fillBrush = CreateSolidBrush(RGB(246, 174, 98));
            FillRect(dc, &fill, fillBrush);
            DeleteObject(fillBrush);
        }

        if (snap.percent >= 0) {
            drawText(std::to_wstring(pct) + L"%", {s(32), s(200), rc.right - s(32), s(222)}, 9, FW_NORMAL, RGB(195, 195, 195), DT_RIGHT | DT_NOPREFIX);
        }
        drawText(L"Per-User 免管理员安装 · %LOCALAPPDATA%\\Programs\\Jiangjie",
                 {s(32), s(238), s(260), s(266)}, 8, FW_NORMAL, RGB(120, 120, 125));

        EndPaint(hwnd_, &ps);
    }
};

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    Options opts;
    ParseCommandLine(opts);
    BootstrapperApp app(std::move(opts));
    return opts.silent ? app.RunHeadless() : app.RunGui(instance);
}
