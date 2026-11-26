
#include "workbench_process.h"
#include "release/release_engine.h"
#include "build_config.h"
#include <shellapi.h>
#include <shobjidl.h>
#include <wrl.h>
#include <WebView2.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <system_error>

namespace {
using namespace jiangjie;
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

constexpr auto title = L"讲界视频工坊";
constexpr UINT_PTR timer = 1;
constexpr UINT exportCommand = 1001;
constexpr UINT checkUpdateCommand = 1002;
constexpr UINT activate = WM_APP + 1;
constexpr UINT browserFailure = WM_APP + 2;
constexpr ULONGLONG startupTimeout = 60000, shutdownTimeout = 4000, exportTimeout = 30000;
constexpr ULONGLONG updateCheckDelayMs = 10000, updateRecheckIntervalMs = 4ULL * 60ULL * 60ULL * 1000ULL;
struct CloseHandleDeleter { void operator()(void* value) const { CloseHandle(value); } };
using Handle = std::unique_ptr<void, CloseHandleDeleter>;
using CoString = std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)>;

class Desktop {
public:
    Desktop(DesktopPaths paths, std::wstring windowClass) : paths_(std::move(paths)), windowClass_(std::move(windowClass)) {}
    int Run(HINSTANCE instance) {
        WNDCLASSW definition{};
        definition.lpfnWndProc = Dispatch;
        definition.hInstance = instance;
        definition.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        definition.lpszClassName = windowClass_.c_str();
        if (!RegisterClassW(&definition)) return 1;
        window_ = CreateWindowExW(0, windowClass_.c_str(), title, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT, CW_USEDEFAULT, 1200, 800, nullptr, nullptr, instance, this);
        if (!window_) return 1;
        const auto menu = CreateMenu(), help = CreatePopupMenu();
        AppendMenuW(help, MF_STRING, checkUpdateCommand, L"检查更新(&U)");
        AppendMenuW(help, MF_STRING, exportCommand, L"导出诊断包(&D)");
        AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(help), L"帮助(&H)");
        SetMenu(window_, menu);
        exportButton_ = CreateWindowW(L"BUTTON", L"一键导出诊断包", WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
            0, 0, 0, 0, window_, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(exportCommand)), instance, nullptr);
        SendMessageW(exportButton_, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
        ShowWindow(window_, SW_SHOWNORMAL);
        UpdateWindow(window_);
        if (!SetTimer(window_, timer, 100, nullptr)) { DestroyWindow(window_); return 1; }
        started_ = GetTickCount64();
        try {
            LogMain(paths_, "startup");
            RecordNativeCrashes(paths_);
            AttachDesktopJob();
            token_ = CreateSessionToken();
            backend_.Start(paths_, token_);
            Check(StartBrowser(), L"无法初始化内置浏览器。请检查应用文件和系统运行策略。");
        } catch (const std::system_error& error) {
            Fail(L"无法启动本地服务。请检查应用文件、安全软件的拦截记录和用户目录权限。", error.code().value());
        } catch (...) {
            Fail(L"无法初始化本地服务。请检查磁盘空间与用户目录的写入权限。");
        }

        MSG message{};
        int result;
        while ((result = GetMessageW(&message, nullptr, 0, 0)) > 0) {
            if (state_ == State::Failed && IsDialogMessageW(window_, &message)) continue;
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        state_ = State::Closing;
        CloseBrowser();
        return result < 0 ? 1 : static_cast<int>(message.wParam);
    }

private:
    enum class State { Starting, Ready, Failed, Closing };

    static LRESULT CALLBACK Dispatch(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
        if (message == WM_NCCREATE) {
            auto self = static_cast<Desktop*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            self->window_ = hwnd;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        auto self = reinterpret_cast<Desktop*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        return self ? self->OnMessage(message, wp, lp) : DefWindowProcW(hwnd, message, wp, lp);
    }
    LRESULT OnMessage(UINT message, WPARAM wp, LPARAM lp) {
        switch (message) {
        case WM_GETMINMAXINFO: {
            auto info = reinterpret_cast<MINMAXINFO*>(lp);
            const auto dpi = GetDpiForWindow(window_);
            info->ptMinTrackSize = {MulDiv(540, dpi, 96), MulDiv(440, dpi, 96)};
            return 0;
        }
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: Paint(); return 0;
        case WM_SIZE: Resize(); return 0;
        case WM_MOVE: if (controller_) controller_->NotifyParentWindowPositionChanged(); return 0;
        case WM_COMMAND:
            if (LOWORD(wp) == exportCommand) Export();
            else if (LOWORD(wp) == checkUpdateCommand) StartUpdateCheck(true);
            return 0;
        case WM_TIMER: if (wp == timer) Tick(); return 0;
        case browserFailure: Fail(L"内置浏览器意外停止。请导出诊断包后重启应用。", static_cast<unsigned long>(wp)); return 0;
        case activate:
            if (state_ == State::Closing) return 0;
            ShowWindow(window_, IsIconic(window_) ? SW_RESTORE : SW_SHOW);
            if (!SetForegroundWindow(window_)) FlashWindow(window_, TRUE);
            if (state_ == State::Ready) controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            return 0;
        case WM_CLOSE:
            if (state_ != State::Closing) {
                state_ = State::Closing;
                CloseBrowser();
                BeginStop();
                ShowWindow(window_, SW_HIDE);
                Tick();
            }
            return 0;
        case WM_QUERYENDSESSION: return TRUE;
        case WM_ENDSESSION: if (wp) { backend_.RequestStop(); backend_.Stop(shutdownTimeout); } return 0;
        case WM_DESTROY:
            KillTimer(window_, timer);
            LogMain(paths_, "shutdown");
            PostQuitMessage(0);
            return 0;
        default: return DefWindowProcW(window_, message, wp, lp);
        }
    }

    void Paint() const {
        PAINTSTRUCT paint{};
        const auto dc = BeginPaint(window_, &paint);
        RECT area{};
        GetClientRect(window_, &area);
        FillRect(dc, &area, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
        SetBkMode(dc, TRANSPARENT);
        const auto center = area.bottom / 2;
        const auto width = area.right;
        const auto dpi = GetDpiForWindow(window_);
        const auto draw = [&](const wchar_t* value, RECT bounds, int size, COLORREF color) {
            const auto font = CreateFontW(-MulDiv(size, dpi, 96), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
            const auto previous = SelectObject(dc, font);
            SetTextColor(dc, color);
            DrawTextW(dc, value, -1, &bounds, DT_CENTER | DT_WORDBREAK | DT_NOPREFIX);
            SelectObject(dc, previous);
            DeleteObject(font);
        };
        draw(L"☀", {0, center - MulDiv(140, dpi, 96), width, center}, 45, RGB(237, 183, 94));
        draw(state_ == State::Failed ? L"工作台暂时无法打开" : title,
            {24, center - MulDiv(65, dpi, 96), width - 24, area.bottom}, 29, RGB(250, 246, 234));
        draw(state_ == State::Failed ? failure_.c_str() : L"正在启动工作台…",
            {28, center - MulDiv(15, dpi, 96), width - 28, area.bottom}, 16, RGB(213, 205, 190));
        EndPaint(window_, &paint);
    }

    void Resize() const {
        RECT bounds{};
        GetClientRect(window_, &bounds);
        if (controller_) controller_->put_Bounds(bounds);
        if (exportButton_) {
            const auto dpi = GetDpiForWindow(window_);
            const auto width = MulDiv(190, dpi, 96);
            MoveWindow(exportButton_, (bounds.right - width) / 2, bounds.bottom / 2 + MulDiv(80, dpi, 96),
                width, MulDiv(36, dpi, 96), TRUE);
        }
        InvalidateRect(window_, nullptr, FALSE);
    }
    void CloseBrowser() {
        if (controller_) controller_->Close();
        view_.Reset();
        controller_.Reset();
        environment_.Reset();
    }
    void BeginStop() {
        backend_.RequestStop();
        if (!stopping_) stopping_ = GetTickCount64();
    }
    void Fail(const wchar_t* description, unsigned long code = 0) {
        if (state_ == State::Closing || state_ == State::Failed) return;
        state_ = State::Failed;
        failure_ = description;
        if (code) failure_ += L"\n错误代码 " + std::to_wstring(code);
        LogMain(paths_, "desktop_failure", code);
        CloseBrowser();
        BeginStop();
        ShowWindow(exportButton_, SW_SHOW);
        Resize();
    }
    bool Check(HRESULT result, const wchar_t* description) {
        if (SUCCEEDED(result)) return true;
        Fail(description, static_cast<unsigned long>(result));
        return false;
    }
    bool WorkbenchUri(std::wstring_view uri) const {
        return !origin_.empty() && uri.starts_with(origin_) && uri.substr(origin_.size()).starts_with(L"/bohack/");
    }
    HRESULT StartBrowser() {
        const auto browser = paths_.app / L"runtime/webview2";
        if (!fs::is_regular_file(browser / L"msedgewebview2.exe")) return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
        fs::create_directories(paths_.webview);
        for (auto name : {L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", L"WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
            L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", L"WEBVIEW2_USER_DATA_FOLDER", L"WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
            L"WEBVIEW2_CHANNEL_SEARCH_KIND", L"WEBVIEW2_RELEASE_CHANNELS"}) SetEnvironmentVariableW(name, nullptr);
        return CreateCoreWebView2EnvironmentWithOptions(browser.c_str(), paths_.webview.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [this](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
                    if (state_ != State::Starting) return S_OK;
                    if (!Check(result, L"无法加载内置 WebView2。请检查安装完整性和系统权限。")) return S_OK;
                    environment_ = environment;
                    Check(environment_->CreateCoreWebView2Controller(window_,
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [this](HRESULT status, ICoreWebView2Controller* controller) -> HRESULT {
                                if (state_ != State::Starting) { if (controller) controller->Close(); return S_OK; }
                                if (SUCCEEDED(status)) status = Attach(controller);
                                if (Check(status, L"无法打开内置浏览器窗口。请检查系统策略或重新安装应用。")) Navigate();
                                return S_OK;
                            }).Get()), L"无法创建内置浏览器窗口。");
                    return S_OK;
                }).Get());
    }
    HRESULT Attach(ICoreWebView2Controller* controller) {
        if (!controller) return E_POINTER;
        controller_ = controller;
        controller_->put_IsVisible(FALSE);
        Resize();
        auto result = controller_->get_CoreWebView2(&view_);
        if (FAILED(result)) return result;
        UINT32 pid = 0;
        result = view_->get_BrowserProcessId(&pid);
        if (FAILED(result)) return result;
        const Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
        std::wstring browser(32768, L'\0');
        DWORD length = static_cast<DWORD>(browser.size());
        if (!process || !QueryFullProcessImageNameW(process.get(), 0, browser.data(), &length)) return E_ACCESSDENIED;
        browser.resize(length);
        std::error_code error;
        if (!fs::equivalent(browser, paths_.app / L"runtime/webview2/msedgewebview2.exe", error)) return E_ACCESSDENIED;
        ComPtr<ICoreWebView2Settings> settings;
        result = view_->get_Settings(&settings);
        if (FAILED(result)) return result;
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsBuiltInErrorPageEnabled(FALSE);
        settings->put_IsWebMessageEnabled(TRUE);
        ComPtr<ICoreWebView2Settings4> autofill;
        if (SUCCEEDED(settings.As(&autofill))) {
            autofill->put_IsPasswordAutosaveEnabled(FALSE);
            autofill->put_IsGeneralAutofillEnabled(FALSE);
        }
        return RestrictBrowser();
    }
    HRESULT RestrictBrowser() {
        ComPtr<ICoreWebView2_22> filter;
        auto result = view_.As(&filter);
        if (FAILED(result)) return result;
        result = filter->AddWebResourceRequestedFilterWithRequestSourceKinds(L"*",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL);
        if (FAILED(result)) return result;
        EventRegistrationToken event{};
        result = view_->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                if (!environment_) return E_ABORT;
                ComPtr<ICoreWebView2WebResourceRequest> request;
                wchar_t* uri = nullptr;
                if (SUCCEEDED(args->get_Request(&request)) && SUCCEEDED(request->get_Uri(&uri))) {
                    const CoString owned(uri, CoTaskMemFree);
                    if (uri && WorkbenchUri(uri)) {
                        ComPtr<ICoreWebView2HttpRequestHeaders> headers;
                        if (SUCCEEDED(request->get_Headers(&headers)) &&
                            SUCCEEDED(headers->SetHeader(L"X-Dsh-Internal-Token", token_.c_str()))) return S_OK;
                    } else if (uri && (std::wstring_view(uri).starts_with(L"blob:") || std::wstring_view(uri).starts_with(L"data:"))) {
                        return S_OK;
                    }
                }
                ComPtr<ICoreWebView2WebResourceResponse> denied;
                const auto status = environment_->CreateWebResourceResponse(nullptr, 403, L"Forbidden", L"Cache-Control: no-store", &denied);
                return FAILED(status) ? status : args->put_Response(denied.Get());
            }).Get(), &event);
        if (FAILED(result)) return result;

        const auto navigation = Callback<ICoreWebView2NavigationStartingEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                wchar_t* uri = nullptr;
                const auto status = args->get_Uri(&uri);
                const CoString owned(uri, CoTaskMemFree);
                return args->put_Cancel(FAILED(status) || !uri || !WorkbenchUri(uri));
            });
        result = view_->add_NavigationStarting(navigation.Get(), &event);
        if (FAILED(result)) return result;
        result = view_->add_FrameNavigationStarting(navigation.Get(), &event);
        if (FAILED(result)) return result;
        result = view_->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                wchar_t* source = nullptr;
                const auto status = args->get_Source(&source);
                const CoString sender(source, CoTaskMemFree);
                const auto base = origin_ + L"/bohack/";
                const std::wstring_view sourceUri(source ? source : L"");
                const bool sameWorkbench = sourceUri == base ||
                    (sourceUri.starts_with(base) && (sourceUri[base.size()] == L'?' || sourceUri[base.size()] == L'#'));
                if (FAILED(status) || !sameWorkbench) return S_OK;
                wchar_t* raw = nullptr;
                const auto message = args->TryGetWebMessageAsString(&raw);
                const CoString value(raw, CoTaskMemFree);
                if (SUCCEEDED(message) && raw) {
                    const std::wstring_view msg(raw);
                    if (msg == L"export-diagnostics") {
                        PostMessageW(window_, WM_COMMAND, exportCommand, 0);
                    } else if (msg == L"apply-update-restart") {
                        TryApplyPendingUpdateAndRestart();
                    }
                }
                return S_OK;
            }).Get(), &event);
        if (FAILED(result)) return result;
        result = view_->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                BOOL userInitiated = FALSE;
                wchar_t* uri = nullptr;
                args->get_IsUserInitiated(&userInitiated);
                if (userInitiated && SUCCEEDED(args->get_Uri(&uri)) && uri) {
                    const CoString external(uri, CoTaskMemFree);
                    if (std::wstring_view(uri).starts_with(L"https://")) {
                        ShellExecuteW(window_, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
                    }
                }
                return args->put_Handled(TRUE);
            }).Get(), &event);
        if (FAILED(result)) return result;
        result = view_->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                return args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
            }).Get(), &event);
        if (FAILED(result)) return result;
        result = view_->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
                if (SUCCEEDED(args->get_ProcessFailedKind(&kind)) &&
                    (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED ||
                     kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED)) {
                    PostMessageW(window_, browserFailure, static_cast<WPARAM>(kind), 0);
                }
                return S_OK;
            }).Get(), &event);
        if (FAILED(result)) return result;
        return view_->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                if (state_ != State::Starting || !navigating_) return S_OK;
                BOOL success = FALSE;
                args->get_IsSuccess(&success);
                ComPtr<ICoreWebView2NavigationCompletedEventArgs2> extended;
                int status = 0;
                if (SUCCEEDED(args->QueryInterface(IID_PPV_ARGS(&extended)))) extended->get_HttpStatusCode(&status);
                if (!success || status != 200) {
                    PostMessageW(window_, browserFailure, status, 0);
                    return S_OK;
                }
                if (SUCCEEDED(controller_->put_IsVisible(TRUE))) {
                    state_ = State::Ready;
                    readyAt_ = GetTickCount64();
                    MarkCurrentVersionHealthy();
                    LogMain(paths_, "workbench_ready");
                    if (GetForegroundWindow() == window_) controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                } else PostMessageW(window_, browserFailure, 0, 0);
                return S_OK;
            }).Get(), &event);
    }
    void Navigate() {
        if (state_ != State::Starting || !view_ || origin_.empty() || navigating_) return;
        navigating_ = true;
        Check(view_->Navigate((origin_ + L"/bohack/").c_str()), L"无法导航到本地工作台。");
    }

    void Export() {
        if (export_ || choosingExport_ || state_ == State::Closing) return;
        choosingExport_ = true;
        try {
            ComPtr<IFileSaveDialog> dialog;
            if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
                throw std::runtime_error("IFileSaveDialog");
            }
            const COMDLG_FILTERSPEC filter{L"诊断包 (*.zip)", L"*.zip"};
            dialog->SetTitle(L"导出诊断包");
            dialog->SetFileTypes(1, &filter);
            dialog->SetDefaultExtension(L"zip");
            dialog->SetFileName(L"Jiangjie-diagnostics.zip");
            const auto result = dialog->Show(window_);
            if (result != HRESULT_FROM_WIN32(ERROR_CANCELLED) && state_ != State::Closing) {
                ComPtr<IShellItem> item;
                wchar_t* destination = nullptr;
                if (FAILED(result) || FAILED(dialog->GetResult(&item)) || FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &destination))) {
                    throw std::runtime_error("diagnostic destination");
                }
                const CoString selected(destination, CoTaskMemFree);
                try {
                    export_.reset(StartDiagnosticsExport(paths_, selected.get()));
                    exportStarted_ = GetTickCount64();
                    SetExportEnabled(false);
                } catch (...) {
                    ExportNativeFallbackDiagnostics(paths_, selected.get());
                    LogMain(paths_, "diagnostics_exported_fallback");
                    MessageBoxW(window_, L"诊断包已保存（原生降级模式）。", L"导出诊断包", MB_OK | MB_ICONINFORMATION);
                }
            }
        } catch (...) {
            LogMain(paths_, "diagnostics_start_failed");
            MessageBoxW(window_, L"无法启动诊断导出。请检查应用文件和保存位置的写入权限。", L"导出诊断包", MB_OK | MB_ICONWARNING);
        }
        choosingExport_ = false;
    }
    void SetExportEnabled(bool enabled) const {
        EnableWindow(exportButton_, enabled);
        EnableMenuItem(GetMenu(window_), exportCommand, MF_BYCOMMAND | (enabled ? MF_ENABLED : MF_GRAYED));
    }
    void MarkCurrentVersionHealthy() const noexcept {
        try {
            wchar_t seqBuf[32]{};
            if (GetEnvironmentVariableW(L"JIANGJIE_ACTIVE_SEQUENCE", seqBuf, static_cast<DWORD>(std::size(seqBuf))) > 0) {
                const uint64_t seq = std::wcstoull(seqBuf, nullptr, 10);
                if (seq > 0) {
                    const auto layout = jiangjie::release::ResolveInstallLayout();
                    jiangjie::release::RecordVersionHealthy(layout, seq);
                }
            }
        } catch (...) {}
    }
    fs::path LocateUpdaterExe() const {
        std::error_code ec;
        const auto layout = jiangjie::release::ResolveInstallLayout();
        const auto installed = layout.installRoot / L"JiangjieUpdater.exe";
        if (fs::is_regular_file(installed, ec)) return installed;
        const auto sibling = paths_.app / L"JiangjieUpdater.exe";
        if (fs::is_regular_file(sibling, ec)) return sibling;
        const auto grandParent = paths_.app.parent_path().parent_path() / L"JiangjieUpdater.exe";
        if (fs::is_regular_file(grandParent, ec)) return grandParent;
        return {};
    }
    void NotifyUpdateReady(const jiangjie::release::PendingUpdateState& pending) {
        if (!view_ || notifiedUpdateSeq_ == pending.releaseSequence) return;
        notifiedUpdateSeq_ = pending.releaseSequence;
        const std::string json = "{\"type\":\"update-ready\",\"version\":" +
                                 jiangjie::release::JsonEscape(pending.version) +
                                 ",\"releaseSequence\":" + std::to_string(pending.releaseSequence) +
                                 ",\"notesUrl\":" + jiangjie::release::JsonEscape(pending.notesUrl) + "}";
        view_->PostWebMessageAsJson(jiangjie::release::Utf8ToWide(json).c_str());
    }
    void StartUpdateCheck(bool manual) {
        if (updater_ || state_ != State::Ready) return;
        const auto updaterExe = LocateUpdaterExe();
        if (updaterExe.empty()) {
            if (manual) MessageBoxW(window_, L"当前为开发目录模式，未安装独立更新助手。", L"检查更新", MB_OK | MB_ICONINFORMATION);
            return;
        }
        manualUpdateCheck_ = manual;
        lastUpdateCheckAt_ = GetTickCount64();
        std::wstring cmd = L"\"" + updaterExe.native() + L"\" --check --stage --quiet";
        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi{};
        if (CreateProcessW(updaterExe.c_str(), cmd.data(), nullptr, nullptr, FALSE,
                           CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS, nullptr, updaterExe.parent_path().c_str(), &si, &pi)) {
            CloseHandle(pi.hThread);
            updater_.reset(pi.hProcess);
            LogMain(paths_, manual ? "update_check_manual" : "update_check_background");
        } else if (manual) {
            MessageBoxW(window_, L"无法启动更新检查程序，请稍后重试。", L"检查更新", MB_OK | MB_ICONWARNING);
        }
    }
    void TryApplyPendingUpdateAndRestart() {
        if (state_ != State::Ready) return;
        bool busy = false;
        std::string reason;
        if (workbenchPort_ && jiangjie::release::QueryWorkbenchBusy(workbenchPort_, token_, &busy, &reason) && busy) {
            LogMain(paths_, "update_restart_deferred_busy");
            if (view_) view_->PostWebMessageAsJson(L"{\"type\":\"update-blocked-busy\"}");
            return;
        }
        const auto updaterExe = LocateUpdaterExe();
        if (updaterExe.empty()) return;
        std::wstring cmd = L"\"" + updaterExe.native() + L"\" --apply --wait-pid " +
                           std::to_wstring(GetCurrentProcessId()) + L" --relaunch";
        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi{};
        if (CreateProcessW(updaterExe.c_str(), cmd.data(), nullptr, nullptr, FALSE,
                           CREATE_NO_WINDOW, nullptr, updaterExe.parent_path().c_str(), &si, &pi)) {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            LogMain(paths_, "update_apply_restarting");
            PostMessageW(window_, WM_CLOSE, 0, 0);
        }
    }
    void Tick() {
        const auto now = GetTickCount64();
        if (state_ == State::Starting || state_ == State::Ready) {
            const auto port = backend_.PollReady();
            if (backend_.Exited()) {
                Fail(L"本地服务已停止。请检查安装文件、安全软件拦截记录和本地网络策略。", backend_.ExitCode());
            } else if (state_ == State::Starting) {
                if (port && origin_.empty()) {
                    workbenchPort_ = port;
                    origin_ = L"http://127.0.0.1:" + std::to_wstring(port);
                }
                if (now - started_ >= startupTimeout) {
                    Fail(L"等候本地工作台超时。请检查安全软件是否拦截了本地端口或应用进程。");
                } else Navigate();
            }
        }
        if (state_ == State::Ready && readyAt_ > 0) {
            if (!updater_) {
                if (!initialUpdateChecked_ && now - readyAt_ >= updateCheckDelayMs) {
                    initialUpdateChecked_ = true;
                    // If an update was already staged earlier, surface it right away
                    const auto layout = jiangjie::release::ResolveInstallLayout();
                    if (const auto pending = jiangjie::release::ReadPendingUpdate(layout)) {
                        NotifyUpdateReady(*pending);
                    } else {
                        StartUpdateCheck(false);
                    }
                } else if (initialUpdateChecked_ && lastUpdateCheckAt_ > 0 && now - lastUpdateCheckAt_ >= updateRecheckIntervalMs) {
                    StartUpdateCheck(false);
                }
            } else if (WaitForSingleObject(updater_.get(), 0) == WAIT_OBJECT_0) {
                DWORD code = 1;
                GetExitCodeProcess(updater_.get(), &code);
                updater_.reset();
                const bool wasManual = manualUpdateCheck_;
                manualUpdateCheck_ = false;
                if (code == 0) {
                    const auto layout = jiangjie::release::ResolveInstallLayout();
                    if (const auto pending = jiangjie::release::ReadPendingUpdate(layout)) {
                        LogMain(paths_, "update_ready_notified");
                        NotifyUpdateReady(*pending);
                    }
                } else if (wasManual) {
                    MessageBoxW(window_,
                        code == 10 ? L"当前已是最新版本。" : L"暂时无法连接更新服务器，请检查网络后稍后重试。",
                        L"检查更新", MB_OK | MB_ICONINFORMATION);
                }
            }
        }
        if (stopping_ && !stopped_) {
            backend_.PollReady();
            if (backend_.Exited() || now - stopping_ >= shutdownTimeout) { backend_.Stop(0); stopped_ = true; }
        }
        if (state_ == State::Closing) {
            if (export_) { TerminateProcess(export_.get(), 1); export_.reset(); }
            if (updater_) { updater_.reset(); }
            if (stopped_ && !choosingExport_) DestroyWindow(window_);
            return;
        }
        if (export_) {
            const auto wait = WaitForSingleObject(export_.get(), 0);
            if (wait == WAIT_TIMEOUT && now - exportStarted_ < exportTimeout) return;
            DWORD result = 1;
            if (wait == WAIT_OBJECT_0) GetExitCodeProcess(export_.get(), &result);
            else TerminateProcess(export_.get(), 1);
            export_.reset();
            SetExportEnabled(true);
            LogMain(paths_, result ? "diagnostics_export_failed" : "diagnostics_exported", result);
            MessageBoxW(window_, result ? L"导出失败。请检查保存位置的权限和磁盘空间后重试。" :
                L"诊断包已保存。", L"导出诊断包", MB_OK | (result ? MB_ICONWARNING : MB_ICONINFORMATION));
        }
    }

    DesktopPaths paths_;
    std::wstring windowClass_;
    WorkbenchProcess backend_;
    HWND window_ = nullptr, exportButton_ = nullptr;
    ComPtr<ICoreWebView2Environment> environment_;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> view_;
    Handle export_, updater_;
    State state_ = State::Starting;
    std::wstring token_, origin_, failure_;
    unsigned workbenchPort_ = 0;
    uint64_t notifiedUpdateSeq_ = 0;
    ULONGLONG started_ = 0, readyAt_ = 0, lastUpdateCheckAt_ = 0, stopping_ = 0, exportStarted_ = 0;
    bool navigating_ = false, stopped_ = false, choosingExport_ = false, initialUpdateChecked_ = false, manualUpdateCheck_ = false;
};
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    try {
        const auto windowClass = L"Jiangjie.Desktop." + CurrentUserSid();
        const Handle lock(CreateMutexW(nullptr, FALSE, (L"Local\\" + windowClass).c_str()));
        if (!lock) throw std::runtime_error("single instance lock");
        const auto deadline = GetTickCount64() + shutdownTimeout + 1000;
        for (;;) {
            const auto wait = WaitForSingleObject(lock.get(), 0);
            if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) break;
            if (wait != WAIT_TIMEOUT) return 1;
            const auto existing = FindWindowW(windowClass.c_str(), nullptr);
            if (existing && IsWindowVisible(existing)) {
                DWORD pid = 0;
                GetWindowThreadProcessId(existing, &pid);
                AllowSetForegroundWindow(pid);
                PostMessageW(existing, activate, 0, 0);
                return 0;
            }
            if (GetTickCount64() >= deadline) return 0;
            Sleep(40);
        }
        std::optional<Desktop> desktop;
        struct Apartment { ~Apartment() { CoUninitialize(); } };
        const auto result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        if (FAILED(result)) throw std::system_error(static_cast<int>(result), std::system_category(), "COM initialization");
        const Apartment apartment;
        desktop.emplace(ResolveDesktopPaths(), windowClass);
        return desktop->Run(instance);
    } catch (const std::system_error& error) {
        const auto message = L"无法初始化讲界视频工坊。请检查应用安装和当前账户的权限。\n错误代码 " +
            std::to_wstring(static_cast<unsigned long>(error.code().value()));
        MessageBoxW(nullptr, message.c_str(), title, MB_OK | MB_ICONERROR);
        return 1;
    } catch (...) {
        MessageBoxW(nullptr, L"无法初始化讲界视频工坊。请检查应用安装和当前账户的权限。", title, MB_OK | MB_ICONERROR);
        return 1;
    }
}
