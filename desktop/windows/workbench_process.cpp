#include "workbench_process.h"
#include "build_config.h"

#include <bcrypt.h>
#include <sddl.h>
#include <shlobj.h>
#include <winver.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <system_error>

namespace jiangjie {
namespace {
struct HandleDeleter {
    void operator()(void* value) const { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
using Handle = std::unique_ptr<void, HandleDeleter>;

[[noreturn]] void Fail(const char* operation) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), operation);
}

fs::path KnownFolder(const KNOWNFOLDERID& id) {
    PWSTR value = nullptr;
    const auto result = SHGetKnownFolderPath(id, 0, nullptr, &value);
    const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> owned(value, CoTaskMemFree);
    if (FAILED(result)) throw std::system_error(static_cast<int>(result), std::system_category(), "SHGetKnownFolderPath");
    return value;
}

struct CaseInsensitive {
    bool operator()(const std::wstring& left, const std::wstring& right) const {
        return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_LESS_THAN;
    }
};

std::vector<wchar_t> ChildEnvironment(const DesktopPaths& paths, const std::wstring& token) {
    std::map<std::wstring, std::wstring, CaseInsensitive> values;
    auto block = GetEnvironmentStringsW();
    if (!block) Fail("GetEnvironmentStringsW");
    const std::unique_ptr<wchar_t, decltype(&FreeEnvironmentStringsW)> original(block, FreeEnvironmentStringsW);
    for (auto entry = block; *entry; entry += wcslen(entry) + 1) {
        const std::wstring line(entry);
        const auto offset = line.find(L'=', 1);
        if (offset != std::wstring::npos) values.emplace(line.substr(0, offset), line.substr(offset + 1));
    }
    for (auto name : {L"NODE_OPTIONS", L"NODE_PATH", L"PYTHONHOME", L"PYTHONPATH", L"JIANGJIE_WORKBENCH_WORKSPACE",
        L"DSH_CLI", L"JIANGJIE_READY_ID", L"ELECTRON_RUN_AS_NODE", L"SSLKEYLOGFILE", L"NODE_TLS_REJECT_UNAUTHORIZED"}) values.erase(name);
    std::erase_if(values, [](const auto& pair) {
        auto name = pair.first;
        std::transform(name.begin(), name.end(), name.begin(), [](wchar_t ch) {
            return ch >= L'a' && ch <= L'z' ? static_cast<wchar_t>(ch - (L'a' - L'A')) : ch;
        });
        return name.starts_with(L"BOHACK_CLOUD_") || name.starts_with(L"WORKBENCH_MODEL_") ||
            name.starts_with(L"SCENE_") || name.starts_with(L"VIDEO_TTS_");
    });
    const auto runtime = paths.app / L"runtime";
    const auto base = paths.app / L"dsh-workbench-fix/dsh-base";
    const auto temp = paths.cache / L"tmp";
    const auto set = [&](const wchar_t* key, const fs::path& value) { values[key] = value.native(); };
    set(L"JIANGJIE_APP_ROOT", paths.app);
    set(L"JIANGJIE_DATA_DIR", paths.data);
    set(L"JIANGJIE_CACHE_DIR", paths.cache);
    set(L"JIANGJIE_DESKTOP_DATA", paths.data);
    set(L"JIANGJIE_DESKTOP_LOG_DIR", paths.logs);
    set(L"JIANGJIE_DESKTOP_WORKSPACE", paths.workspace);
    set(L"APPDATA", paths.data.parent_path());
    set(L"LOCALAPPDATA", paths.local.parent_path());
    set(L"JIANGJIE_SKILLS_DIR", paths.app / L".project-skills");
    set(L"JIANGJIE_NODE", paths.node);
    set(L"JIANGJIE_DESKTOP_DSH_PATCH", paths.app / L"desktop-agent.patch.yml");
    set(L"DSH_HOME", paths.data / L"dsh");
    set(L"DSH_CLI", base / L"node_modules/@deepseek-ai/dsh/lib/bin.js");
    set(L"BOHACK_DESKTOP_KEYCHAIN_HELPER", paths.app / L"BohackCredentialStore.exe");
    set(L"VIDEO_KIT_DIR", paths.app / L"video-kit");
    set(L"VIDEO_PLAYWRIGHT", paths.app / L"video-kit/node_modules/playwright-core");
    set(L"VIDEO_PYTHON", runtime / L"python/python.exe");
    set(L"VIDEO_FFMPEG", runtime / L"codecs/ffmpeg.exe");
    set(L"VIDEO_FFPROBE", runtime / L"codecs/ffprobe.exe");
    set(L"VIDEO_BROWSER", paths.browser);
    set(L"VIDEO_EDGE_PATH", paths.browser);
    set(L"XDG_CACHE_HOME", paths.cache);
    for (auto name : {L"TEMP", L"TMP", L"TMPDIR"}) set(name, temp);
    wchar_t system[MAX_PATH]{};
    if (!GetSystemDirectoryW(system, MAX_PATH)) Fail("GetSystemDirectoryW");
    values[L"PATH"] = paths.node.parent_path().native() + L";" + (runtime / L"python").native() + L";" +
        (runtime / L"codecs").native() + L";" + system + L";" + fs::path(system).parent_path().native() + L";" +
        (fs::path(system) / L"WindowsPowerShell/v1.0").native();
    values[L"WORKBENCH_PORT"] = L"0";
    values[L"JIANGJIE_DESKTOP_AGENT_MARKER"] = L"local-desktop-route";
    values[L"JIANGJIE_WINDOWS_DESKTOP"] = L"1";
    values[L"JIANGJIE_MEMBER_URL"] = JIANGJIE_MEMBER_URL;
    values[L"JIANGJIE_MEMBER_AGENT_API"] = JIANGJIE_MEMBER_AGENT_API;
    for (auto name : {L"PYTHONUTF8", L"PYTHONNOUSERSITE", L"PYTHONDONTWRITEBYTECODE", L"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"}) values[name] = L"1";
    values[L"PYTHONIOENCODING"] = L"utf-8";
    values.erase(L"DSH_INTERNAL_TOKEN");
    if (!token.empty()) values[L"DSH_INTERNAL_TOKEN"] = token;
    std::vector<wchar_t> result;
    for (const auto& [key, value] : values) {
        const auto entry = key + L"=" + value;
        result.insert(result.end(), entry.begin(), entry.end());
        result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}

std::wstring CommandLine(const fs::path& exe, const std::vector<std::wstring>& args) {
    auto command = process_detail::QuoteArgument(exe.native());
    for (const auto& arg : args) command += L" " + process_detail::QuoteArgument(arg);
    return command;
}

void Close(HANDLE& handle) {
    if (handle) CloseHandle(handle);
    handle = nullptr;
}

Handle KillOnCloseJob() {
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) Fail("CreateJobObjectW");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) Fail("SetInformationJobObject");
    return job;
}

std::pair<Handle, Handle> Pipe(bool inheritRead) {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE reader = nullptr, writer = nullptr;
    if (!CreatePipe(&reader, &writer, &security, 0)) Fail("CreatePipe");
    std::pair<Handle, Handle> pipe{Handle(reader), Handle(writer)};
    if (!SetHandleInformation(inheritRead ? writer : reader, HANDLE_FLAG_INHERIT, 0)) Fail("SetHandleInformation");
    return pipe;
}

class Attributes {
public:
    explicit Attributes(DWORD count) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, count, 0, &size);
        data_ = std::make_unique<unsigned char[]>(size);
        list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(data_.get());
        if (!InitializeProcThreadAttributeList(list_, count, 0, &size)) Fail("InitializeProcThreadAttributeList");
    }
    ~Attributes() { DeleteProcThreadAttributeList(list_); }
    LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }
    template<class T> void Set(DWORD_PTR attribute, T& value) {
        if (!UpdateProcThreadAttribute(list_, 0, attribute, &value, sizeof(value), nullptr, nullptr)) Fail("UpdateProcThreadAttribute");
    }
private:
    std::unique_ptr<unsigned char[]> data_;
    LPPROC_THREAD_ATTRIBUTE_LIST list_;
};

wchar_t crashMarker[32768]{};
LONG WINAPI NativeCrash(EXCEPTION_POINTERS* exception) {
    const auto file = CreateFileW(crashMarker, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        const auto code = exception->ExceptionRecord->ExceptionCode;
        WriteFile(file, &code, sizeof(code), &written, nullptr);
        CloseHandle(file);
    }
    return EXCEPTION_CONTINUE_SEARCH;
}
}

DesktopPaths ResolveDesktopPaths() {
    std::wstring executable(32768, L'\0');
    const auto length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    if (!length || length == executable.size()) Fail("GetModuleFileNameW");
    executable.resize(length);
    DesktopPaths paths;
    paths.app = fs::path(executable).parent_path();
    paths.data = KnownFolder(FOLDERID_RoamingAppData) / L"Jiangjie";
    paths.local = KnownFolder(FOLDERID_LocalAppData) / L"Jiangjie";
    paths.logs = paths.local / L"logs";
    paths.cache = paths.local / L"cache";
    paths.workspace = paths.data / L"workspace";
    paths.webview = paths.local / L"webview2";
    paths.node = paths.app / L"runtime/node/node.exe";
    paths.browser = paths.app / L"runtime/chromium/chrome.exe";
    return paths;
}

std::wstring CurrentUserSid() {
    HANDLE raw = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) Fail("OpenProcessToken");
    const Handle token(raw);
    DWORD bytes = 0;
    GetTokenInformation(token.get(), TokenUser, nullptr, 0, &bytes);
    if (!bytes) Fail("GetTokenInformation");
    std::vector<unsigned char> buffer(bytes);
    if (!GetTokenInformation(token.get(), TokenUser, buffer.data(), bytes, &bytes)) Fail("GetTokenInformation");
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid)) Fail("ConvertSidToStringSidW");
    const std::unique_ptr<wchar_t, decltype(&LocalFree)> owned(sid, LocalFree);
    return sid;
}

std::wstring CreateSessionToken() {
    unsigned char bytes[32];
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        throw std::runtime_error("BCryptGenRandom");
    }
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring token;
    for (const auto value : bytes) {
        token.push_back(hex[value >> 4]);
        token.push_back(hex[value & 15]);
    }
    return token;
}

void LogMain(const DesktopPaths& paths, const char* event, unsigned long code) noexcept {
    // Only call with fixed event names. Keep native startup logs available even without Node.
    try {
        fs::create_directories(paths.logs);
        SYSTEMTIME time{};
        GetSystemTime(&time);
        char day[16];
        std::snprintf(day, sizeof(day), "%04u-%02u-%02u", time.wYear, time.wMonth, time.wDay);
        const auto file = paths.logs / "main.log";
        const auto previous = paths.logs / "main.log.1";
        if (fs::exists(file)) {
            char currentDay[11]{};
            { std::ifstream first(file, std::ios::binary); first.seekg(7); first.read(currentDay, 10); }
            if (std::string_view(currentDay) != day || fs::file_size(file) >= 128 * 1024) {
                if (!MoveFileExW(file.c_str(), previous.c_str(), MOVEFILE_REPLACE_EXISTING)) return;
            }
        }
        char line[320];
        std::snprintf(line, sizeof(line), "{\"ts\":\"%sT%02u:%02u:%02u.%03uZ\",\"source\":\"main\",\"event\":\"%s\",\"code\":%lu}\n",
            day, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds, event, code);
        std::ofstream(file, std::ios::binary | std::ios::app) << line;
    } catch (...) {}
}

void RecordNativeCrashes(const DesktopPaths& paths) {
    fs::create_directories(paths.logs);
    const auto marker = (paths.logs / L"main-crash.marker").native();
    if (marker.size() >= std::size(crashMarker)) throw std::runtime_error("Native crash marker path is too long");
    std::copy(marker.begin(), marker.end(), crashMarker);
    SetUnhandledExceptionFilter(NativeCrash);
}

void AttachDesktopJob() {
    auto job = KillOnCloseJob();
    if (!AssignProcessToJobObject(job.get(), GetCurrentProcess())) Fail("AssignProcessToJobObject(desktop)");
    // Lifetime is the desktop process itself. Closing this handle earlier
    // would kill the desktop along with the WebView and helper processes.
    job.release();
}

std::wstring process_detail::QuoteArgument(const std::wstring& arg) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (const auto ch : arg) {
        if (ch == L'\\') { ++slashes; continue; }
        result.append(ch == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
        result.push_back(ch);
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L'\"';
}

unsigned process_detail::ParseReadyPort(const std::string& line) {
    constexpr std::string_view prefix = "{\"event\":\"ready\",\"port\":";
    if (!line.starts_with(prefix)) return 0;
    const char* start = line.data() + prefix.size();
    unsigned port = 0;
    const auto [end, error] = std::from_chars(start, line.data() + line.size(), port);
    if (error != std::errc{} || port == 0 || port > 65535) return 0;
    const auto expected = ",\"healthUrl\":\"http://127.0.0.1:" + std::to_string(port) + "/bohack/api/health\"}";
    return std::string_view(end, line.data() + line.size()) == expected ? port : 0;
}

void WorkbenchProcess::Start(const DesktopPaths& paths, const std::wstring& token) {
    if (job_) throw std::logic_error("Workbench already started");
    fs::create_directories(paths.workspace);
    fs::create_directories(paths.cache / L"tmp");
    auto job = KillOnCloseJob();
    auto [readInput, writeInput] = Pipe(true);
    auto [readOutput, writeOutput] = Pipe(false);
    HANDLE jobs[]{job.get()};
    HANDLE inherited[]{readInput.get(), writeOutput.get()};
    Attributes attributes(2);
    attributes.Set(PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs);
    attributes.Set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited);
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = readInput.get();
    startup.StartupInfo.hStdOutput = writeOutput.get();
    startup.StartupInfo.hStdError = writeOutput.get();
    startup.lpAttributeList = attributes.get();
    const auto script = paths.app / L"dsh-workbench-fix/dsh-base/start-dsh.mjs";
    auto cmd = CommandLine(paths.node, {script.native(), L"--port", L"0"});
    auto env = ChildEnvironment(paths, token);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(paths.node.c_str(), cmd.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        env.data(), paths.workspace.c_str(), &startup.StartupInfo, &child)) Fail("CreateProcessW(workbench)");
    CloseHandle(child.hThread);
    process_ = child.hProcess;
    job_ = job.release();
    input_ = writeInput.release();
    output_ = readOutput.release();
    pending_.clear();
}

unsigned WorkbenchProcess::PollReady() {
    if (!output_) return 0;
    unsigned port = 0;
    for (int chunks = 0; chunks < 16; ++chunks) {
        char data[4096];
        DWORD available = 0, count = 0;
        if (!PeekNamedPipe(output_, nullptr, 0, nullptr, &available, nullptr) || available == 0) break;
        if (!ReadFile(output_, data, std::min<DWORD>(available, sizeof(data)), &count, nullptr) || count == 0) break;
        pending_.append(data, count);
        for (auto end = pending_.find('\n'); end != std::string::npos; end = pending_.find('\n')) {
            auto line = pending_.substr(0, end);
            pending_.erase(0, end + 1);
            if (line.ends_with('\r')) line.pop_back();
            if (const auto value = process_detail::ParseReadyPort(line)) port = value;
        }
        if (pending_.size() > 65536) pending_.clear();
    }
    return port;
}

bool WorkbenchProcess::Exited() const { return process_ && WaitForSingleObject(process_, 0) == WAIT_OBJECT_0; }
DWORD WorkbenchProcess::ExitCode() const {
    DWORD code = 0;
    if (process_) GetExitCodeProcess(process_, &code);
    return code;
}

void WorkbenchProcess::RequestStop() { Close(input_); }

void WorkbenchProcess::Stop(DWORD graceMs) {
    RequestStop();
    if (process_ && graceMs) WaitForSingleObject(process_, graceMs);
    // Only this process owns the job handle. Closing it terminates any remaining descendants.
    Close(job_);
    Close(process_);
    Close(output_);
}

WorkbenchProcess::~WorkbenchProcess() { Stop(); }

HANDLE StartDiagnosticsExport(const DesktopPaths& paths, const fs::path& destination) {
    fs::create_directories(paths.cache / L"tmp");
    const auto script = paths.app / L"desktop/windows/diagnostics.mjs";
    auto cmd = CommandLine(paths.node, {script.native(), L"export", destination.native()});
    auto env = ChildEnvironment(paths, L"");
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(paths.node.c_str(), cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        env.data(), paths.cache.c_str(), &startup, &child)) Fail("CreateProcessW(diagnostics)");
    CloseHandle(child.hThread);
    return child.hProcess;
}

namespace {
std::string Utf8(std::wstring_view text) {
    if (text.empty()) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), needed, nullptr, nullptr);
    return out;
}

std::string JsonString(std::string_view value) {
    std::string out = "\"";
    for (unsigned char ch : value) {
        if (ch == '\"') out += "\\\"";
        else if (ch == '\\') out += "\\\\";
        else if (ch == '\b') out += "\\b";
        else if (ch == '\f') out += "\\f";
        else if (ch == '\n') out += "\\n";
        else if (ch == '\r') out += "\\r";
        else if (ch == '\t') out += "\\t";
        else if (ch < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
            out += buf;
        } else out.push_back(static_cast<char>(ch));
    }
    out.push_back('\"');
    return out;
}

std::string JsonNullable(const std::optional<std::string>& value) {
    return value ? JsonString(*value) : "null";
}

std::string JsonNullableU64(const std::optional<uint64_t>& value) {
    return value ? std::to_string(*value) : "null";
}

std::optional<std::wstring> RegWideString(HKEY root, const wchar_t* subkey, const wchar_t* name, DWORD flags = RRF_RT_REG_SZ) {
    DWORD bytes = 0;
    if (RegGetValueW(root, subkey, name, flags, nullptr, nullptr, &bytes) != ERROR_SUCCESS || bytes < sizeof(wchar_t)) {
        return std::nullopt;
    }
    std::wstring buf(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(root, subkey, name, flags, nullptr, buf.data(), &bytes) != ERROR_SUCCESS) return std::nullopt;
    while (!buf.empty() && buf.back() == L'\0') buf.pop_back();
    if (buf.empty()) return std::nullopt;
    return buf;
}

std::optional<uint64_t> RegDwordValue(HKEY root, const wchar_t* subkey, const wchar_t* name) {
    DWORD val = 0, bytes = sizeof(val);
    if (RegGetValueW(root, subkey, name, RRF_RT_REG_DWORD, nullptr, &val, &bytes) != ERROR_SUCCESS) return std::nullopt;
    return static_cast<uint64_t>(val);
}

std::optional<uint64_t> DiskFreeBytes(const fs::path& start) {
    std::error_code ec;
    auto probe = start;
    while (!probe.empty() && !fs::exists(probe, ec)) {
        auto parent = probe.parent_path();
        if (parent == probe) break;
        probe = std::move(parent);
    }
    ULARGE_INTEGER avail{};
    if (!probe.empty() && GetDiskFreeSpaceExW(probe.c_str(), &avail, nullptr, nullptr)) {
        return static_cast<uint64_t>(avail.QuadPart);
    }
    return std::nullopt;
}

std::optional<std::string> FileProductVersion(const fs::path& exe) {
    DWORD handle = 0;
    const DWORD size = GetFileVersionInfoSizeW(exe.c_str(), &handle);
    if (!size) return std::nullopt;
    std::vector<unsigned char> data(size);
    if (!GetFileVersionInfoW(exe.c_str(), 0, size, data.data())) return std::nullopt;
    VS_FIXEDFILEINFO* info = nullptr;
    UINT len = 0;
    if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &len) || !info || len < sizeof(VS_FIXEDFILEINFO)) {
        return std::nullopt;
    }
    char version[64];
    std::snprintf(version, sizeof(version), "%u.%u.%u.%u",
        HIWORD(info->dwProductVersionMS), LOWORD(info->dwProductVersionMS),
        HIWORD(info->dwProductVersionLS), LOWORD(info->dwProductVersionLS));
    return std::string(version);
}

std::pair<std::optional<std::string>, std::optional<std::string>> DetectEdge() {
    std::vector<std::wstring> candidates;
    constexpr auto appPath = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe";
    for (HKEY hive : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
        for (DWORD view : {RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY}) {
            if (auto v = RegWideString(hive, appPath, L"", RRF_RT_REG_SZ | view)) candidates.push_back(*v);
        }
    }
    for (const wchar_t* var : {L"ProgramFiles(x86)", L"ProgramFiles", L"LOCALAPPDATA"}) {
        wchar_t buf[32768]{};
        const DWORD len = GetEnvironmentVariableW(var, buf, static_cast<DWORD>(std::size(buf)));
        if (len > 0 && len < std::size(buf)) {
            candidates.push_back((fs::path(buf) / L"Microsoft\\Edge\\Application\\msedge.exe").native());
        }
    }
    std::error_code ec;
    for (auto candidate : candidates) {
        while (!candidate.empty() && candidate.front() == L'\"') candidate.erase(candidate.begin());
        while (!candidate.empty() && candidate.back() == L'\"') candidate.pop_back();
        const fs::path p(candidate);
        if (!p.is_absolute()) continue;
        const auto name = p.filename().native();
        if (CompareStringOrdinal(name.c_str(), -1, L"msedge.exe", -1, TRUE) != CSTR_EQUAL) continue;
        if (fs::is_regular_file(p, ec)) {
            return {Utf8(p.native()), FileProductVersion(p)};
        }
    }
    return {std::nullopt, std::nullopt};
}

std::optional<std::string> ReadBoundedLogTail(const fs::path& file, size_t limit = 256 * 1024) {
    std::error_code ec;
    const auto status = fs::symlink_status(file, ec);
    if (ec || !fs::is_regular_file(status)) return std::nullopt;
    const auto total = fs::file_size(file, ec);
    if (ec || total == 0) return std::nullopt;
    const uint64_t start = total > limit ? total - limit : 0;
    const size_t toRead = static_cast<size_t>(total - start);
    std::ifstream in(file, std::ios::binary);
    if (!in) return std::nullopt;
    if (start) in.seekg(static_cast<std::streamoff>(start));
    std::string text(toRead, '\0');
    in.read(text.data(), static_cast<std::streamsize>(toRead));
    text.resize(static_cast<size_t>(in.gcount()));
    if (start) {
        const auto nl = text.find('\n');
        text = nl == std::string::npos ? std::string{} : text.substr(nl + 1);
    }
    return text.empty() ? std::nullopt : std::optional<std::string>(std::move(text));
}

uint32_t Crc32(std::string_view data) {
    uint32_t crc = 0xFFFFFFFFu;
    for (unsigned char byte : data) {
        crc ^= byte;
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc & 1u) ? ((crc >> 1) ^ 0xEDB88320u) : (crc >> 1);
        }
    }
    return ~crc;
}

void AppendU16(std::string& out, uint16_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>((v >> 8) & 0xFF));
}
void AppendU32(std::string& out, uint32_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>((v >> 8) & 0xFF));
    out.push_back(static_cast<char>((v >> 16) & 0xFF));
    out.push_back(static_cast<char>((v >> 24) & 0xFF));
}

std::string BuildStoreZip(const std::vector<std::pair<std::string, std::string>>& entries) {
    std::string files, central;
    for (const auto& [name, content] : entries) {
        const uint32_t offset = static_cast<uint32_t>(files.size());
        const uint32_t crc = Crc32(content);
        const uint32_t size = static_cast<uint32_t>(content.size());
        const uint16_t nameLen = static_cast<uint16_t>(name.size());
        AppendU32(files, 0x04034B50u);
        AppendU16(files, 20);
        AppendU16(files, 0x0800);
        AppendU16(files, 0); // Store
        AppendU16(files, 0);
        AppendU16(files, 0x0021);
        AppendU32(files, crc);
        AppendU32(files, size);
        AppendU32(files, size);
        AppendU16(files, nameLen);
        AppendU16(files, 0);
        files.append(name);
        files.append(content);

        AppendU32(central, 0x02014B50u);
        AppendU16(central, 20);
        AppendU16(central, 20);
        AppendU16(central, 0x0800);
        AppendU16(central, 0);
        AppendU16(central, 0);
        AppendU16(central, 0x0021);
        AppendU32(central, crc);
        AppendU32(central, size);
        AppendU32(central, size);
        AppendU16(central, nameLen);
        AppendU16(central, 0);
        AppendU16(central, 0);
        AppendU16(central, 0);
        AppendU16(central, 0);
        AppendU32(central, 0);
        AppendU32(central, offset);
        central.append(name);
    }
    const uint32_t centralOffset = static_cast<uint32_t>(files.size());
    const uint32_t centralSize = static_cast<uint32_t>(central.size());
    const uint16_t count = static_cast<uint16_t>(entries.size());
    std::string zip;
    zip.reserve(files.size() + central.size() + 22);
    zip.append(files);
    zip.append(central);
    AppendU32(zip, 0x06054B50u);
    AppendU16(zip, 0);
    AppendU16(zip, 0);
    AppendU16(zip, count);
    AppendU16(zip, count);
    AppendU32(zip, centralSize);
    AppendU32(zip, centralOffset);
    AppendU16(zip, 0);
    return zip;
}
} // namespace

void ExportNativeFallbackDiagnostics(const DesktopPaths& paths, const fs::path& destination) {
    const auto ext = destination.extension().native();
    if (CompareStringOrdinal(ext.c_str(), -1, L".zip", -1, TRUE) != CSTR_EQUAL) {
        throw std::invalid_argument("The diagnostics destination must end in .zip");
    }
    SYSTEMTIME t{};
    GetSystemTime(&t);
    char ts[32];
    std::snprintf(ts, sizeof(ts), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    constexpr auto verKey = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    auto toUtf8Opt = [](std::optional<std::wstring> v) -> std::optional<std::string> {
        return v ? std::optional<std::string>(Utf8(*v)) : std::nullopt;
    };
    const auto edition = toUtf8Opt(RegWideString(HKEY_LOCAL_MACHINE, verKey, L"EditionID"));
    const auto displayVersion = toUtf8Opt(RegWideString(HKEY_LOCAL_MACHINE, verKey, L"DisplayVersion"));
    const auto build = toUtf8Opt(RegWideString(HKEY_LOCAL_MACHINE, verKey, L"CurrentBuildNumber"));
    const auto revision = RegDwordValue(HKEY_LOCAL_MACHINE, verKey, L"UBR");
    MEMORYSTATUSEX mem{sizeof(mem)};
    GlobalMemoryStatusEx(&mem);
    const auto dataDisk = DiskFreeBytes(paths.data);
    const auto appDisk = DiskFreeBytes(paths.app);
    const auto [edgePath, edgeVersion] = DetectEdge();

    std::string systemJson = "{";
    systemJson += "\"exportedAt\":" + JsonString(ts);
    systemJson += ",\"fallback\":true,\"reason\":\"node_unavailable\"";
    systemJson += ",\"os\":{\"platform\":\"win32\",\"arch\":\"x64\"";
    systemJson += ",\"edition\":" + JsonNullable(edition);
    systemJson += ",\"displayVersion\":" + JsonNullable(displayVersion);
    systemJson += ",\"build\":" + JsonNullable(build);
    systemJson += ",\"revision\":" + JsonNullableU64(revision) + "}";
    systemJson += ",\"memory\":{\"totalBytes\":" + std::to_string(mem.ullTotalPhys);
    systemJson += ",\"freeBytes\":" + std::to_string(mem.ullAvailPhys) + "}";
    systemJson += ",\"disk\":{\"dataFreeBytes\":" + JsonNullableU64(dataDisk);
    systemJson += ",\"appFreeBytes\":" + JsonNullableU64(appDisk) + "}";
    systemJson += ",\"edge\":{\"path\":" + JsonNullable(edgePath);
    systemJson += ",\"version\":" + JsonNullable(edgeVersion) + "}";
    systemJson += ",\"runtimeBomIncluded\":false}\n";

    std::vector<std::pair<std::string, std::string>> entries;
    entries.emplace_back("system.json", std::move(systemJson));
    for (const char* name : {"main.log", "main.log.1"}) {
        if (auto log = ReadBoundedLogTail(paths.logs / name)) {
            entries.emplace_back(std::string("logs/") + name, std::move(*log));
        }
    }
    const auto zip = BuildStoreZip(entries);
    const auto temp = destination.parent_path() / (L".jiangjie-diagnostics-" + CreateSessionToken() + L".tmp");
    try {
        {
            Handle file(CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
            if (file.get() == INVALID_HANDLE_VALUE) Fail("CreateFileW(diagnostics fallback)");
            const char* ptr = zip.data();
            size_t remaining = zip.size();
            while (remaining > 0) {
                DWORD written = 0;
                const DWORD chunk = static_cast<DWORD>(std::min<size_t>(remaining, 1024 * 1024));
                if (!WriteFile(file.get(), ptr, chunk, &written, nullptr) || written == 0) Fail("WriteFile(diagnostics fallback)");
                ptr += written;
                remaining -= written;
            }
            if (!FlushFileBuffers(file.get())) Fail("FlushFileBuffers(diagnostics fallback)");
        }
        if (!MoveFileExW(temp.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            Fail("MoveFileExW(diagnostics fallback)");
        }
    } catch (...) {
        DeleteFileW(temp.c_str());
        throw;
    }
}
}
