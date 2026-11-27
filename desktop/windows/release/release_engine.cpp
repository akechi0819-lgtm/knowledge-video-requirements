#include "release_engine.h"

#include <bcrypt.h>
#include <sddl.h>
#include <shlobj.h>
#include <softpub.h>
#include <winhttp.h>
#include <wintrust.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>

namespace jiangjie::release {
namespace {

struct HandleDeleter {
    void operator()(HANDLE h) const {
        if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
};
using UniqueHandle = std::unique_ptr<void, HandleDeleter>;

struct WinHttpDeleter {
    void operator()(HINTERNET h) const {
        if (h) WinHttpCloseHandle(h);
    }
};
using UniqueHttp = std::unique_ptr<void, WinHttpDeleter>;

fs::path KnownFolderPath(const KNOWNFOLDERID& id) {
    PWSTR raw = nullptr;
    const HRESULT hr = SHGetKnownFolderPath(id, 0, nullptr, &raw);
    const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> owned(raw, CoTaskMemFree);
    if (FAILED(hr) || !raw) return {};
    return fs::path(raw);
}

std::string ReadWholeFile(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) return {};
    return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

bool AtomicWriteString(const fs::path& target, const std::string& content) {
    std::error_code ec;
    fs::create_directories(target.parent_path(), ec);
    const auto suffix = Sha256HexBytes(&target, sizeof(target)).substr(0, 8) + "-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64());
    const fs::path tmp = target.parent_path() / (target.filename().native() + L"." + Utf8ToWide(suffix) + L".tmp");
    {
        UniqueHandle fh(CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!fh || fh.get() == INVALID_HANDLE_VALUE) return false;
        const char* p = content.data();
        size_t rem = content.size();
        while (rem > 0) {
            DWORD written = 0;
            const DWORD chunk = static_cast<DWORD>(std::min<size_t>(rem, 1024 * 1024));
            if (!WriteFile(fh.get(), p, chunk, &written, nullptr) || written == 0) {
                fh.reset();
                DeleteFileW(tmp.c_str());
                return false;
            }
            p += written;
            rem -= written;
        }
        if (!FlushFileBuffers(fh.get())) {
            fh.reset();
            DeleteFileW(tmp.c_str());
            return false;
        }
    }
    if (!MoveFileExW(tmp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    return true;
}

std::string ToLowerAscii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

// ---------------------------------------------------------------------------
// Minimal RFC 8259 JSON parser
// ---------------------------------------------------------------------------
class JsonParser {
public:
    explicit JsonParser(std::string_view input) : s_(input) {}

    std::optional<JsonValue> Parse(std::string* err) {
        SkipWs();
        auto v = ParseValue(err);
        if (!v) return std::nullopt;
        SkipWs();
        if (pos_ != s_.size()) {
            if (err) *err = "Unexpected trailing data in JSON";
            return std::nullopt;
        }
        return v;
    }

private:
    std::string_view s_;
    size_t pos_ = 0;
    int depth_ = 0;

    void SkipWs() {
        while (pos_ < s_.size() && (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\r' || s_[pos_] == '\n')) ++pos_;
    }

    std::optional<JsonValue> ParseValue(std::string* err) {
        if (++depth_ > 64) {
            if (err) *err = "JSON nesting too deep";
            return std::nullopt;
        }
        struct Guard { int& d; ~Guard() { --d; } } guard{depth_};
        SkipWs();
        if (pos_ >= s_.size()) {
            if (err) *err = "Unexpected end of JSON";
            return std::nullopt;
        }
        const char ch = s_[pos_];
        if (ch == '{') return ParseObject(err);
        if (ch == '[') return ParseArray(err);
        if (ch == '"') {
            auto str = ParseString(err);
            if (!str) return std::nullopt;
            JsonValue v;
            v.type = JsonValue::Type::String;
            v.strVal = std::move(*str);
            return v;
        }
        if (ch == 't' && s_.substr(pos_, 4) == "true") {
            pos_ += 4;
            JsonValue v;
            v.type = JsonValue::Type::Bool;
            v.boolVal = true;
            return v;
        }
        if (ch == 'f' && s_.substr(pos_, 5) == "false") {
            pos_ += 5;
            JsonValue v;
            v.type = JsonValue::Type::Bool;
            v.boolVal = false;
            return v;
        }
        if (ch == 'n' && s_.substr(pos_, 4) == "null") {
            pos_ += 4;
            return JsonValue{};
        }
        if (ch == '-' || (ch >= '0' && ch <= '9')) return ParseNumber(err);
        if (err) *err = "Invalid JSON token";
        return std::nullopt;
    }

    std::optional<std::string> ParseString(std::string* err) {
        if (pos_ >= s_.size() || s_[pos_] != '"') {
            if (err) *err = "Expected '\"'";
            return std::nullopt;
        }
        ++pos_;
        std::string out;
        while (pos_ < s_.size()) {
            char ch = s_[pos_++];
            if (ch == '"') return out;
            if (static_cast<unsigned char>(ch) < 0x20) {
                if (err) *err = "Unescaped control char in JSON string";
                return std::nullopt;
            }
            if (ch != '\\') {
                out.push_back(ch);
                continue;
            }
            if (pos_ >= s_.size()) {
                if (err) *err = "Unterminated JSON escape";
                return std::nullopt;
            }
            char esc = s_[pos_++];
            switch (esc) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case '/': out.push_back('/'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u': {
                if (pos_ + 4 > s_.size()) {
                    if (err) *err = "Short \\u escape";
                    return std::nullopt;
                }
                uint32_t cp = 0;
                for (int i = 0; i < 4; ++i) {
                    char h = s_[pos_++];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp |= static_cast<uint32_t>(h - '0');
                    else if (h >= 'a' && h <= 'f') cp |= static_cast<uint32_t>(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') cp |= static_cast<uint32_t>(h - 'A' + 10);
                    else {
                        if (err) *err = "Invalid hex in \\u escape";
                        return std::nullopt;
                    }
                }
                if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 6 <= s_.size() && s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
                    uint32_t low = 0;
                    bool ok = true;
                    for (int i = 0; i < 4; ++i) {
                        char h = s_[pos_ + 2 + i];
                        low <<= 4;
                        if (h >= '0' && h <= '9') low |= static_cast<uint32_t>(h - '0');
                        else if (h >= 'a' && h <= 'f') low |= static_cast<uint32_t>(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') low |= static_cast<uint32_t>(h - 'A' + 10);
                        else ok = false;
                    }
                    if (ok && low >= 0xDC00 && low <= 0xDFFF) {
                        pos_ += 6;
                        cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
                    }
                }
                if (cp < 0x80) out.push_back(static_cast<char>(cp));
                else if (cp < 0x800) {
                    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
                    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                } else if (cp < 0x10000) {
                    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
                    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
                    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                } else {
                    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
                    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
                    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
                    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                }
                break;
            }
            default:
                if (err) *err = "Invalid JSON escape";
                return std::nullopt;
            }
        }
        if (err) *err = "Unterminated JSON string";
        return std::nullopt;
    }

    std::optional<JsonValue> ParseNumber(std::string* err) {
        const size_t start = pos_;
        if (s_[pos_] == '-') ++pos_;
        if (pos_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[pos_]))) {
            if (err) *err = "Invalid JSON number";
            return std::nullopt;
        }
        if (s_[pos_] == '0') ++pos_;
        else while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        bool isFloat = false;
        if (pos_ < s_.size() && s_[pos_] == '.') {
            isFloat = true;
            ++pos_;
            if (pos_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[pos_]))) {
                if (err) *err = "Invalid fractional JSON number";
                return std::nullopt;
            }
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }
        if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
            isFloat = true;
            ++pos_;
            if (pos_ < s_.size() && (s_[pos_] == '+' || s_[pos_] == '-')) ++pos_;
            if (pos_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[pos_]))) {
                if (err) *err = "Invalid exponent in JSON number";
                return std::nullopt;
            }
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }
        const std::string token(s_.substr(start, pos_ - start));
        JsonValue v;
        if (!isFloat) {
            int64_t iv = 0;
            const auto [endPtr, ec] = std::from_chars(token.data(), token.data() + token.size(), iv);
            if (ec == std::errc{} && endPtr == token.data() + token.size()) {
                v.type = JsonValue::Type::Int;
                v.intVal = iv;
                v.doubleVal = static_cast<double>(iv);
                return v;
            }
        }
        char* endD = nullptr;
        const double dv = std::strtod(token.c_str(), &endD);
        if (!endD || *endD != '\0' || !std::isfinite(dv)) {
            if (err) *err = "Out-of-range JSON number";
            return std::nullopt;
        }
        v.type = JsonValue::Type::Double;
        v.doubleVal = dv;
        return v;
    }

    std::optional<JsonValue> ParseArray(std::string* err) {
        ++pos_; // '['
        JsonValue arr;
        arr.type = JsonValue::Type::Array;
        SkipWs();
        if (pos_ < s_.size() && s_[pos_] == ']') { ++pos_; return arr; }
        for (;;) {
            auto item = ParseValue(err);
            if (!item) return std::nullopt;
            arr.arrVal.push_back(std::move(*item));
            SkipWs();
            if (pos_ >= s_.size()) { if (err) *err = "Unterminated JSON array"; return std::nullopt; }
            if (s_[pos_] == ']') { ++pos_; return arr; }
            if (s_[pos_] != ',') { if (err) *err = "Expected ',' or ']' in JSON array"; return std::nullopt; }
            ++pos_;
        }
    }

    std::optional<JsonValue> ParseObject(std::string* err) {
        ++pos_; // '{'
        JsonValue obj;
        obj.type = JsonValue::Type::Object;
        SkipWs();
        if (pos_ < s_.size() && s_[pos_] == '}') { ++pos_; return obj; }
        for (;;) {
            SkipWs();
            auto key = ParseString(err);
            if (!key) return std::nullopt;
            SkipWs();
            if (pos_ >= s_.size() || s_[pos_] != ':') {
                if (err) *err = "Expected ':' in JSON object";
                return std::nullopt;
            }
            ++pos_;
            auto val = ParseValue(err);
            if (!val) return std::nullopt;
            obj.objVal[std::move(*key)] = std::move(*val);
            SkipWs();
            if (pos_ >= s_.size()) { if (err) *err = "Unterminated JSON object"; return std::nullopt; }
            if (s_[pos_] == '}') { ++pos_; return obj; }
            if (s_[pos_] != ',') { if (err) *err = "Expected ',' or '}' in JSON object"; return std::nullopt; }
            ++pos_;
        }
    }
};

struct ParsedUrl {
    bool isHttps = true;
    std::string host;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    std::string pathAndQuery;
};

bool CrackUrl(std::string_view url, ParsedUrl& out, std::string* errorOut) {
    const std::wstring wurl = Utf8ToWide(url);
    URL_COMPONENTSW comps{};
    comps.dwStructSize = sizeof(comps);
    std::wstring host(512, L'\0');
    std::wstring path(4096, L'\0');
    std::wstring extra(2048, L'\0');
    comps.lpszHostName = host.data();
    comps.dwHostNameLength = static_cast<DWORD>(host.size());
    comps.lpszUrlPath = path.data();
    comps.dwUrlPathLength = static_cast<DWORD>(path.size());
    comps.lpszExtraInfo = extra.data();
    comps.dwExtraInfoLength = static_cast<DWORD>(extra.size());
    if (!WinHttpCrackUrl(wurl.c_str(), static_cast<DWORD>(wurl.size()), 0, &comps)) {
        if (errorOut) *errorOut = "Invalid URL syntax";
        return false;
    }
    if (comps.nScheme != INTERNET_SCHEME_HTTPS && comps.nScheme != INTERNET_SCHEME_HTTP) {
        if (errorOut) *errorOut = "Unsupported URL scheme";
        return false;
    }
    host.resize(comps.dwHostNameLength);
    path.resize(comps.dwUrlPathLength);
    extra.resize(comps.dwExtraInfoLength);
    out.isHttps = (comps.nScheme == INTERNET_SCHEME_HTTPS);
    out.host = ToLowerAscii(WideToUtf8(host));
    out.port = comps.nPort;
    out.pathAndQuery = WideToUtf8(path) + WideToUtf8(extra);
    if (out.pathAndQuery.empty()) out.pathAndQuery = "/";
    return !out.host.empty();
}

std::string QueryHeaderUtf8(HINTERNET request, DWORD infoLevel) {
    DWORD bytes = 0;
    WinHttpQueryHeaders(request, infoLevel, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &bytes, WINHTTP_NO_HEADER_INDEX);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes < sizeof(wchar_t)) return {};
    std::wstring buf(bytes / sizeof(wchar_t), L'\0');
    if (!WinHttpQueryHeaders(request, infoLevel, WINHTTP_HEADER_NAME_BY_INDEX, buf.data(), &bytes, WINHTTP_NO_HEADER_INDEX)) return {};
    while (!buf.empty() && buf.back() == L'\0') buf.pop_back();
    return WideToUtf8(buf);
}

std::optional<ArtifactInfo> ParseArtifact(const JsonValue* node) {
    if (!node || node->type != JsonValue::Type::Object) return std::nullopt;
    ArtifactInfo info;
    if (const auto* v = node->Get("url")) info.url = v->AsString().value_or("");
    if (const auto* v = node->Get("fileName")) info.fileName = v->AsString().value_or("");
    if (const auto* v = node->Get("sizeBytes")) info.sizeBytes = v->AsUInt().value_or(0);
    if (const auto* v = node->Get("sha256")) info.sha256 = ToLowerAscii(v->AsString().value_or(""));
    if (const auto* v = node->Get("publisherHint")) info.publisherHint = v->AsString().value_or("");
    if (info.url.empty() || info.sha256.size() != 64) return std::nullopt;
    return info;
}

bool RunProcessWait(const fs::path& exe, const std::wstring& args, DWORD timeoutMs, DWORD* exitCodeOut = nullptr) {
    std::wstring cmd = L"\"" + exe.native() + L"\" " + args;
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        return false;
    }
    CloseHandle(pi.hThread);
    const DWORD wait = WaitForSingleObject(pi.hProcess, timeoutMs);
    DWORD code = 1;
    if (wait == WAIT_OBJECT_0) {
        GetExitCodeProcess(pi.hProcess, &code);
    } else {
        TerminateProcess(pi.hProcess, 1);
    }
    CloseHandle(pi.hProcess);
    if (exitCodeOut) *exitCodeOut = code;
    return wait == WAIT_OBJECT_0 && code == 0;
}

bool CopyOrHardLinkTree(const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    if (!fs::exists(src, ec)) return false;
    if (ContainsReparsePoint(src)) return false;
    fs::create_directories(dst, ec);
    if (ec) return false;
    for (const auto& entry : fs::recursive_directory_iterator(src, fs::directory_options::skip_permission_denied, ec)) {
        if (ec) return false;
        const auto rel = fs::relative(entry.path(), src, ec);
        if (ec || !IsSafeRelativePath(rel)) return false;
        const auto target = dst / rel;
        if (entry.is_directory()) {
            fs::create_directories(target, ec);
            if (ec) return false;
        } else if (entry.is_regular_file()) {
            fs::create_directories(target.parent_path(), ec);
            if (ec) return false;
            if (!CreateHardLinkW(target.c_str(), entry.path().c_str(), nullptr)) {
                fs::copy_file(entry.path(), target, fs::copy_options::overwrite_existing, ec);
                if (ec) return false;
            }
        }
    }
    return true;
}

bool ValidateArchiveEntriesSafe(const fs::path& archivePath, std::string* errorOut) {
    wchar_t sysDir[MAX_PATH]{};
    if (!GetSystemDirectoryW(sysDir, MAX_PATH)) return false;
    const fs::path tarExe = fs::path(sysDir) / L"tar.exe";
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE readPipe = nullptr, writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) return false;
    UniqueHandle rd(readPipe), wr(writePipe);
    SetHandleInformation(rd.get(), HANDLE_FLAG_INHERIT, 0);

    std::wstring cmd = L"\"" + tarExe.native() + L"\" -tf \"" + archivePath.native() + L"\"";
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = wr.get();
    si.hStdError = wr.get();
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(tarExe.c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        if (errorOut) *errorOut = "Unable to run tar.exe to inspect component archive";
        return false;
    }
    CloseHandle(pi.hThread);
    wr.reset();

    std::string listing;
    char buf[4096];
    DWORD read = 0;
    while (ReadFile(rd.get(), buf, sizeof(buf), &read, nullptr) && read > 0) {
        listing.append(buf, read);
        if (listing.size() > 32 * 1024 * 1024) break;
    }
    WaitForSingleObject(pi.hProcess, 60000);
    DWORD exitCode = 1;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hProcess);
    if (exitCode != 0) {
        if (errorOut) *errorOut = "tar.exe failed to list component archive";
        return false;
    }

    std::istringstream iss(listing);
    std::string line;
    size_t count = 0;
    while (std::getline(iss, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
        if (line.empty()) continue;
        ++count;
        if (count > 200000) {
            if (errorOut) *errorOut = "Component archive exceeds file count limit";
            return false;
        }
        if (!IsSafeRelativePath(Utf8ToWide(line))) {
            if (errorOut) *errorOut = "Unsafe archive entry detected: " + line;
            return false;
        }
    }
    return count > 0;
}

} // namespace

// ---------------------------------------------------------------------------
// JsonValue helpers
// ---------------------------------------------------------------------------
const JsonValue* JsonValue::Get(const std::string& key) const {
    if (type != Type::Object) return nullptr;
    const auto it = objVal.find(key);
    return it == objVal.end() ? nullptr : &it->second;
}

std::optional<std::string> JsonValue::AsString() const {
    return type == Type::String ? std::optional<std::string>(strVal) : std::nullopt;
}

std::optional<int64_t> JsonValue::AsInt() const {
    if (type == Type::Int) return intVal;
    if (type == Type::Double) return static_cast<int64_t>(doubleVal);
    return std::nullopt;
}

std::optional<uint64_t> JsonValue::AsUInt() const {
    auto v = AsInt();
    if (!v || *v < 0) return std::nullopt;
    return static_cast<uint64_t>(*v);
}

std::optional<bool> JsonValue::AsBool() const {
    return type == Type::Bool ? std::optional<bool>(boolVal) : std::nullopt;
}

std::optional<JsonValue> ParseJson(std::string_view input, std::string* errorOut) {
    JsonParser parser(input);
    return parser.Parse(errorOut);
}

std::string JsonEscape(std::string_view value) {
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

std::string WideToUtf8(std::wstring_view value) {
    if (value.empty()) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), needed, nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(std::string_view value) {
    if (value.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), needed);
    return out;
}

std::string IsoUtcNow() {
    SYSTEMTIME st{};
    GetSystemTime(&st);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02uZ",
                  st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    return buf;
}

std::optional<int64_t> ParseIso8601UtcEpochSeconds(std::string_view iso) {
    if (iso.size() < 20) return std::nullopt;
    int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
    auto parsePart = [&](size_t off, size_t len, int& dst) {
        const auto [ptr, ec] = std::from_chars(iso.data() + off, iso.data() + off + len, dst);
        return ec == std::errc{} && ptr == iso.data() + off + len;
    };
    if (!parsePart(0, 4, y) || iso[4] != '-' || !parsePart(5, 2, mo) || iso[7] != '-' ||
        !parsePart(8, 2, d) || (iso[10] != 'T' && iso[10] != 't') ||
        !parsePart(11, 2, h) || iso[13] != ':' || !parsePart(14, 2, mi) || iso[16] != ':' ||
        !parsePart(17, 2, s)) {
        return std::nullopt;
    }
    if (iso.back() != 'Z' && iso.back() != 'z') return std::nullopt;
    std::tm tm{};
    tm.tm_year = y - 1900;
    tm.tm_mon = mo - 1;
    tm.tm_mday = d;
    tm.tm_hour = h;
    tm.tm_min = mi;
    tm.tm_sec = s;
    const auto t = _mkgmtime(&tm);
    if (t == static_cast<time_t>(-1)) return std::nullopt;
    return static_cast<int64_t>(t);
}

InstallLayout ResolveInstallLayout(const fs::path& overrideInstallRoot, const fs::path& overrideLocalRoot) {
    InstallLayout layout;
    const auto localAppData = KnownFolderPath(FOLDERID_LocalAppData);
    const auto roamingAppData = KnownFolderPath(FOLDERID_RoamingAppData);

    wchar_t envInstall[32768]{};
    const DWORD envInstallLen = GetEnvironmentVariableW(L"JIANGJIE_INSTALL_ROOT", envInstall, static_cast<DWORD>(std::size(envInstall)));
    if (!overrideInstallRoot.empty()) layout.installRoot = overrideInstallRoot;
    else if (envInstallLen > 0 && envInstallLen < std::size(envInstall)) layout.installRoot = fs::path(envInstall);
    else layout.installRoot = localAppData / L"Programs" / L"Jiangjie";

    wchar_t envLocal[32768]{};
    const DWORD envLocalLen = GetEnvironmentVariableW(L"JIANGJIE_LOCAL_DIR", envLocal, static_cast<DWORD>(std::size(envLocal)));
    if (!overrideLocalRoot.empty()) layout.localData = overrideLocalRoot;
    else if (envLocalLen > 0 && envLocalLen < std::size(envLocal)) layout.localData = fs::path(envLocal);
    else layout.localData = localAppData / L"Jiangjie";

    layout.roamingData = roamingAppData / L"Jiangjie";
    layout.versionsDir = layout.installRoot / L"versions";
    layout.currentJson = layout.installRoot / L"current.json";
    layout.pendingJson = layout.installRoot / L"pending-update.json";
    layout.failedJson = layout.installRoot / L"failed-sequences.json";
    layout.cacheDir = layout.localData / L"cache";
    layout.downloadsDir = layout.cacheDir / L"downloads";
    layout.componentsCache = layout.cacheDir / L"components";
    layout.logsDir = layout.localData / L"logs";
    return layout;
}

std::wstring CurrentUserSidString() {
    HANDLE raw = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return L"S-1-0-0";
    UniqueHandle token(raw);
    DWORD bytes = 0;
    GetTokenInformation(token.get(), TokenUser, nullptr, 0, &bytes);
    if (!bytes) return L"S-1-0-0";
    std::vector<uint8_t> buf(bytes);
    if (!GetTokenInformation(token.get(), TokenUser, buf.data(), bytes, &bytes)) return L"S-1-0-0";
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buf.data())->User.Sid, &sid)) return L"S-1-0-0";
    std::unique_ptr<wchar_t, decltype(&LocalFree)> owned(sid, LocalFree);
    return sid;
}

uint32_t CurrentWindowsBuildNumber() {
    DWORD bytes = 0;
    constexpr auto subkey = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    if (RegGetValueW(HKEY_LOCAL_MACHINE, subkey, L"CurrentBuildNumber", RRF_RT_REG_SZ, nullptr, nullptr, &bytes) != ERROR_SUCCESS || bytes < sizeof(wchar_t)) {
        return 19045;
    }
    std::wstring buf(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(HKEY_LOCAL_MACHINE, subkey, L"CurrentBuildNumber", RRF_RT_REG_SZ, nullptr, buf.data(), &bytes) != ERROR_SUCCESS) {
        return 19045;
    }
    return static_cast<uint32_t>(std::wcstoul(buf.c_str(), nullptr, 10));
}

UserUpdateLock::~UserUpdateLock() { Release(); }

bool UserUpdateLock::Acquire(DWORD timeoutMs) {
    if (mutex_) return true;
    const std::wstring name = L"Local\\Jiangjie.InstallUpdate." + CurrentUserSidString();
    HANDLE m = CreateMutexW(nullptr, FALSE, name.c_str());
    if (!m) return false;
    const DWORD wait = WaitForSingleObject(m, timeoutMs);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) {
        mutex_ = m;
        return true;
    }
    CloseHandle(m);
    return false;
}

void UserUpdateLock::Release() {
    if (mutex_) {
        ReleaseMutex(mutex_);
        CloseHandle(mutex_);
        mutex_ = nullptr;
    }
}

void LogReleaseEvent(const fs::path& logFile, const char* source, const char* event,
                     const std::string& detail, unsigned long code) noexcept {
    try {
        std::error_code ec;
        fs::create_directories(logFile.parent_path(), ec);
        if (fs::exists(logFile, ec) && fs::file_size(logFile, ec) >= 256 * 1024) {
            MoveFileExW(logFile.c_str(), (logFile.native() + L".1").c_str(), MOVEFILE_REPLACE_EXISTING);
        }
        std::string line = "{\"ts\":" + JsonEscape(IsoUtcNow()) +
                           ",\"source\":" + JsonEscape(source) +
                           ",\"event\":" + JsonEscape(event) +
                           ",\"code\":" + std::to_string(code);
        if (!detail.empty()) line += ",\"detail\":" + JsonEscape(detail);
        line += "}\n";
        std::ofstream(logFile, std::ios::binary | std::ios::app) << line;
    } catch (...) {}
}

std::string Sha256HexBytes(const void* data, size_t size) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return {};
    struct AlgGuard { BCRYPT_ALG_HANDLE h; ~AlgGuard() { if (h) BCryptCloseAlgorithmProvider(h, 0); } } ag{alg};
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) != 0) return {};
    struct HashGuard { BCRYPT_HASH_HANDLE h; ~HashGuard() { if (h) BCryptDestroyHash(h); } } hg{hash};

    const auto* ptr = static_cast<const uint8_t*>(data);
    size_t remaining = size;
    while (remaining > 0) {
        const ULONG chunk = static_cast<ULONG>(std::min<size_t>(remaining, 1024 * 1024));
        if (BCryptHashData(hash, const_cast<PUCHAR>(ptr), chunk, 0) != 0) return {};
        ptr += chunk;
        remaining -= chunk;
    }
    uint8_t digest[32]{};
    if (BCryptFinishHash(hash, digest, sizeof(digest), 0) != 0) return {};
    static constexpr char hex[] = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (uint8_t b : digest) {
        out.push_back(hex[b >> 4]);
        out.push_back(hex[b & 0x0F]);
    }
    return out;
}

std::string Sha256HexFile(const fs::path& file) {
    UniqueHandle fh(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
    if (!fh || fh.get() == INVALID_HANDLE_VALUE) return {};

    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return {};
    struct AlgGuard { BCRYPT_ALG_HANDLE h; ~AlgGuard() { if (h) BCryptCloseAlgorithmProvider(h, 0); } } ag{alg};
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) != 0) return {};
    struct HashGuard { BCRYPT_HASH_HANDLE h; ~HashGuard() { if (h) BCryptDestroyHash(h); } } hg{hash};

    std::vector<uint8_t> buf(256 * 1024);
    DWORD read = 0;
    while (ReadFile(fh.get(), buf.data(), static_cast<DWORD>(buf.size()), &read, nullptr) && read > 0) {
        if (BCryptHashData(hash, buf.data(), read, 0) != 0) return {};
    }
    uint8_t digest[32]{};
    if (BCryptFinishHash(hash, digest, sizeof(digest), 0) != 0) return {};
    static constexpr char hex[] = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (uint8_t b : digest) {
        out.push_back(hex[b >> 4]);
        out.push_back(hex[b & 0x0F]);
    }
    return out;
}

std::optional<std::vector<uint8_t>> Base64UrlDecode(std::string_view input) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '-' || c == '+') return 62;
        if (c == '_' || c == '/') return 63;
        return -1;
    };
    while (!input.empty() && input.back() == '=') input.remove_suffix(1);
    std::vector<uint8_t> out;
    out.reserve((input.size() * 3) / 4);
    uint32_t acc = 0;
    int bits = 0;
    for (char c : input) {
        const int v = val(c);
        if (v < 0) return std::nullopt;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
        }
    }
    return out;
}

bool VerifyEcdsaP256Raw(const void* message, size_t messageLen,
                        const uint8_t* signature64, size_t sigLen,
                        const uint8_t* pubKeyXY64, size_t pubKeyLen) {
    if (!message || !signature64 || !pubKeyXY64 || sigLen != 64 || pubKeyLen != 64) return false;

    // Hash message with SHA-256
    BCRYPT_ALG_HANDLE hashAlg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptOpenAlgorithmProvider(&hashAlg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return false;
    struct AlgG1 { BCRYPT_ALG_HANDLE h; ~AlgG1() { if (h) BCryptCloseAlgorithmProvider(h, 0); } } g1{hashAlg};
    if (BCryptCreateHash(hashAlg, &hash, nullptr, 0, nullptr, 0, 0) != 0) return false;
    struct HashG { BCRYPT_HASH_HANDLE h; ~HashG() { if (h) BCryptDestroyHash(h); } } hg{hash};
    if (BCryptHashData(hash, const_cast<PUCHAR>(static_cast<const uint8_t*>(message)), static_cast<ULONG>(messageLen), 0) != 0) return false;
    uint8_t digest[32]{};
    if (BCryptFinishHash(hash, digest, sizeof(digest), 0) != 0) return false;

    BCRYPT_ALG_HANDLE ecAlg = nullptr;
    if (BCryptOpenAlgorithmProvider(&ecAlg, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) != 0) return false;
    struct AlgG2 { BCRYPT_ALG_HANDLE h; ~AlgG2() { if (h) BCryptCloseAlgorithmProvider(h, 0); } } g2{ecAlg};

    std::vector<uint8_t> blob(sizeof(BCRYPT_ECCKEY_BLOB) + 64);
    auto* header = reinterpret_cast<BCRYPT_ECCKEY_BLOB*>(blob.data());
    header->dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
    header->cbKey = 32;
    std::copy(pubKeyXY64, pubKeyXY64 + 64, blob.data() + sizeof(BCRYPT_ECCKEY_BLOB));

    BCRYPT_KEY_HANDLE key = nullptr;
    if (BCryptImportKeyPair(ecAlg, nullptr, BCRYPT_ECCPUBLIC_BLOB, &key, blob.data(), static_cast<ULONG>(blob.size()), 0) != 0) return false;
    struct KeyG { BCRYPT_KEY_HANDLE h; ~KeyG() { if (h) BCryptDestroyKey(h); } } kg{key};

    const NTSTATUS status = BCryptVerifySignature(key, nullptr, digest, sizeof(digest),
                                                  const_cast<PUCHAR>(signature64), static_cast<ULONG>(sigLen), 0);
    return status == 0;
}

bool VerifyAuthenticode(const fs::path& file, std::string* errorOut) {
    WINTRUST_FILE_INFO fileInfo{};
    fileInfo.cbStruct = sizeof(fileInfo);
    fileInfo.pcwszFilePath = file.c_str();

    WINTRUST_DATA trust{};
    trust.cbStruct = sizeof(trust);
    trust.dwUIChoice = WTD_UI_NONE;
    trust.fdwRevocationChecks = WTD_REVOKE_NONE;
    trust.dwUnionChoice = WTD_CHOICE_FILE;
    trust.pFile = &fileInfo;
    trust.dwStateAction = WTD_STATEACTION_VERIFY;
    trust.dwProvFlags = WTD_SAFER_FLAG;

    GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    const LONG status = WinVerifyTrust(nullptr, &policy, &trust);
    trust.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(nullptr, &policy, &trust);
    if (status != ERROR_SUCCESS) {
        if (errorOut) *errorOut = "Authenticode verification failed (status " + std::to_string(static_cast<unsigned long>(status)) + ")";
        return false;
    }
    return true;
}

bool IsAllowedDownloadUrl(std::string_view url, const std::vector<std::string>& allowedHosts,
                          bool allowLocalHttp, std::string* errorOut) {
    ParsedUrl parsed;
    if (!CrackUrl(url, parsed, errorOut)) return false;
    if (!parsed.isHttps) {
        if (allowLocalHttp && (parsed.host == "127.0.0.1" || parsed.host == "localhost" || parsed.host == "::1")) {
            return true;
        }
        if (errorOut) *errorOut = "Only HTTPS URLs are allowed";
        return false;
    }
    if (allowedHosts.empty()) return true;
    for (const auto& allowed : allowedHosts) {
        const auto low = ToLowerAscii(allowed);
        if (parsed.host == low) return true;
        if (low.size() > 2 && low.starts_with("*.") && parsed.host.ends_with(low.substr(1))) return true;
    }
    if (errorOut) *errorOut = "Host not in HTTPS allowlist: " + parsed.host;
    return false;
}

std::string HttpGetText(std::string_view url, const std::vector<std::string>& allowedHosts,
                        bool allowLocalHttp, std::string* errorOut) {
    if (!IsAllowedDownloadUrl(url, allowedHosts, allowLocalHttp, errorOut)) return {};
    ParsedUrl parsed;
    if (!CrackUrl(url, parsed, errorOut)) return {};

    const bool isLoopback = (parsed.host == "127.0.0.1" || parsed.host == "localhost" || parsed.host == "::1");
    UniqueHttp session(WinHttpOpen(L"JiangjieReleaseClient/1.0",
                                   isLoopback ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                   WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session) { if (errorOut) *errorOut = "WinHttpOpen failed"; return {}; }
    WinHttpSetTimeouts(session.get(), 10000, 15000, 30000, 30000);

    UniqueHttp connect(WinHttpConnect(session.get(), Utf8ToWide(parsed.host).c_str(), parsed.port, 0));
    if (!connect) { if (errorOut) *errorOut = "WinHttpConnect failed"; return {}; }

    DWORD flags = parsed.isHttps ? WINHTTP_FLAG_SECURE : 0;
    UniqueHttp request(WinHttpOpenRequest(connect.get(), L"GET", Utf8ToWide(parsed.pathAndQuery).c_str(),
                                          nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
    if (!request) { if (errorOut) *errorOut = "WinHttpOpenRequest failed"; return {}; }
    DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
    WinHttpSetOption(request.get(), WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));

    if (!WinHttpSendRequest(request.get(), L"Cache-Control: no-cache\r\n", static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request.get(), nullptr)) {
        if (errorOut) *errorOut = "Network request failed (WinHTTP error " + std::to_string(GetLastError()) + ")";
        return {};
    }

    DWORD statusCode = 0, statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200) {
        if (errorOut) *errorOut = "HTTP error " + std::to_string(statusCode);
        return {};
    }

    std::string body;
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(request.get(), &avail)) {
            if (errorOut) *errorOut = "WinHttpQueryDataAvailable failed";
            return {};
        }
        if (avail == 0) break;
        if (body.size() + avail > 16 * 1024 * 1024) {
            if (errorOut) *errorOut = "Response body exceeds 16 MiB limit";
            return {};
        }
        const size_t offset = body.size();
        body.resize(offset + avail);
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), body.data() + offset, avail, &read)) {
            if (errorOut) *errorOut = "WinHttpReadData failed";
            return {};
        }
        body.resize(offset + read);
    }
    return body;
}

bool DownloadFileWithResume(std::string_view url, const fs::path& destination,
                            const DownloadOptions& options, std::string* errorOut) {
    if (!IsAllowedDownloadUrl(url, options.allowedHosts, options.allowLocalHttp, errorOut)) return false;

    std::error_code ec;
    fs::create_directories(destination.parent_path(), ec);
    if (ec) {
        if (errorOut) *errorOut = "Unable to create download directory";
        return false;
    }

    // Fast path: destination already exists and matches expected SHA-256.
    if (!options.expectedSha256.empty() && fs::is_regular_file(destination, ec)) {
        const auto existingSize = fs::file_size(destination, ec);
        if (!ec && (options.expectedSize == 0 || existingSize == options.expectedSize) &&
            Sha256HexFile(destination) == ToLowerAscii(options.expectedSha256)) {
            if (options.onProgress) options.onProgress({existingSize, existingSize, 0.0, true});
            return true;
        }
    }

    const fs::path partPath = destination.native() + L".part";
    const fs::path metaPath = destination.native() + L".part.etag";

    for (int attempt = 0; attempt <= options.maxRetries; ++attempt) {
        if (options.cancelFlag && options.cancelFlag->load()) {
            if (errorOut) *errorOut = "Cancelled by user";
            return false;
        }

        uint64_t existingBytes = 0;
        std::string savedEtag;
        if (fs::is_regular_file(partPath, ec)) {
            existingBytes = fs::file_size(partPath, ec);
            if (ec) existingBytes = 0;
            savedEtag = ReadWholeFile(metaPath);
            while (!savedEtag.empty() && (savedEtag.back() == '\r' || savedEtag.back() == '\n')) savedEtag.pop_back();
        }
        if (options.expectedSize > 0 && existingBytes > options.expectedSize) {
            DeleteFileW(partPath.c_str());
            DeleteFileW(metaPath.c_str());
            existingBytes = 0;
            savedEtag.clear();
        }

        // If .part already has all expected bytes, verify directly!
        if (options.expectedSize > 0 && existingBytes == options.expectedSize) {
            if (options.expectedSha256.empty() || Sha256HexFile(partPath) == ToLowerAscii(options.expectedSha256)) {
                if (MoveFileExW(partPath.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
                    DeleteFileW(metaPath.c_str());
                    if (options.onProgress) options.onProgress({existingBytes, existingBytes, 0.0, true});
                    return true;
                }
            }
            DeleteFileW(partPath.c_str());
            DeleteFileW(metaPath.c_str());
            existingBytes = 0;
            savedEtag.clear();
        }

        ParsedUrl parsed;
        if (!CrackUrl(url, parsed, errorOut)) return false;

        const bool isLoopback = (parsed.host == "127.0.0.1" || parsed.host == "localhost" || parsed.host == "::1");
        UniqueHttp session(WinHttpOpen(L"JiangjieReleaseClient/1.0",
                                       isLoopback ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                       WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
        if (!session) { if (errorOut) *errorOut = "WinHttpOpen failed"; continue; }
        WinHttpSetTimeouts(session.get(), 10000, 15000, 30000, 60000);

        UniqueHttp connect(WinHttpConnect(session.get(), Utf8ToWide(parsed.host).c_str(), parsed.port, 0));
        if (!connect) { if (errorOut) *errorOut = "WinHttpConnect failed"; continue; }

        DWORD flags = parsed.isHttps ? WINHTTP_FLAG_SECURE : 0;
        UniqueHttp request(WinHttpOpenRequest(connect.get(), L"GET", Utf8ToWide(parsed.pathAndQuery).c_str(),
                                              nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
        if (!request) { if (errorOut) *errorOut = "WinHttpOpenRequest failed"; continue; }

        DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
        WinHttpSetOption(request.get(), WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));

        std::wstring reqHeaders;
        if (existingBytes > 0) {
            reqHeaders += L"Range: bytes=" + std::to_wstring(existingBytes) + L"-\r\n";
            if (!savedEtag.empty()) {
                reqHeaders += L"If-Range: " + Utf8ToWide(savedEtag) + L"\r\n";
            }
        }

        if (!WinHttpSendRequest(request.get(), reqHeaders.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : reqHeaders.c_str(),
                                reqHeaders.empty() ? 0 : static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
            !WinHttpReceiveResponse(request.get(), nullptr)) {
            if (errorOut) *errorOut = "Download connection interrupted (WinHTTP " + std::to_string(GetLastError()) + ")";
            Sleep(500);
            continue;
        }

        DWORD statusCode = 0, statusSize = sizeof(statusCode);
        WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);

        if (statusCode == 416) {
            // Range not satisfiable -> clear partial file and retry from 0
            DeleteFileW(partPath.c_str());
            DeleteFileW(metaPath.c_str());
            continue;
        }
        if (statusCode != 200 && statusCode != 206) {
            if (errorOut) *errorOut = "Download HTTP error " + std::to_string(statusCode);
            Sleep(500);
            continue;
        }

        const bool resumed = (statusCode == 206 && existingBytes > 0);
        uint64_t contentLength = 0;
        const auto clStr = QueryHeaderUtf8(request.get(), WINHTTP_QUERY_CONTENT_LENGTH);
        if (!clStr.empty()) {
            std::from_chars(clStr.data(), clStr.data() + clStr.size(), contentLength);
        }
        const uint64_t totalBytes = options.expectedSize > 0
                                        ? options.expectedSize
                                        : (resumed ? existingBytes + contentLength : contentLength);

        const auto etag = QueryHeaderUtf8(request.get(), WINHTTP_QUERY_ETAG);
        if (!etag.empty()) AtomicWriteString(metaPath, etag + "\n");

        UniqueHandle fh(CreateFileW(partPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                    resumed ? OPEN_ALWAYS : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!fh || fh.get() == INVALID_HANDLE_VALUE) {
            if (errorOut) *errorOut = "Unable to open partial download file";
            return false;
        }
        if (resumed) {
            LARGE_INTEGER pos{};
            pos.QuadPart = static_cast<LONGLONG>(existingBytes);
            SetFilePointerEx(fh.get(), pos, nullptr, FILE_BEGIN);
        } else {
            existingBytes = 0;
        }

        uint64_t downloaded = existingBytes;
        const uint64_t startBytes = downloaded;
        const ULONGLONG startTick = GetTickCount64();
        ULONGLONG lastReport = 0;

        std::vector<uint8_t> chunk(64 * 1024);
        bool ioOk = true;
        for (;;) {
            if (options.cancelFlag && options.cancelFlag->load()) {
                if (errorOut) *errorOut = "Cancelled by user";
                return false;
            }
            DWORD read = 0;
            if (!WinHttpReadData(request.get(), chunk.data(), static_cast<DWORD>(chunk.size()), &read)) {
                if (errorOut) *errorOut = "Connection dropped during download";
                ioOk = false;
                break;
            }
            if (read == 0) break;
            DWORD written = 0;
            if (!WriteFile(fh.get(), chunk.data(), read, &written, nullptr) || written != read) {
                if (errorOut) *errorOut = "Disk write failed during download";
                return false;
            }
            downloaded += written;
            const ULONGLONG now = GetTickCount64();
            if (options.onProgress && (now - lastReport >= 100 || downloaded == totalBytes)) {
                lastReport = now;
                const double elapsedSec = std::max(0.05, static_cast<double>(now - startTick) / 1000.0);
                const double speed = static_cast<double>(downloaded - startBytes) / elapsedSec;
                options.onProgress({downloaded, totalBytes, speed, resumed});
            }
        }
        FlushFileBuffers(fh.get());
        fh.reset();
        if (!ioOk) {
            Sleep(500);
            continue;
        }

        if (options.expectedSize > 0 && downloaded != options.expectedSize) {
            if (errorOut) *errorOut = "Downloaded size mismatch (" + std::to_string(downloaded) + " != " + std::to_string(options.expectedSize) + ")";
            if (downloaded > options.expectedSize) {
                DeleteFileW(partPath.c_str());
                DeleteFileW(metaPath.c_str());
            }
            Sleep(300);
            continue;
        }

        if (!options.expectedSha256.empty()) {
            const auto actualHash = Sha256HexFile(partPath);
            if (actualHash != ToLowerAscii(options.expectedSha256)) {
                if (errorOut) *errorOut = "SHA-256 checksum mismatch";
                DeleteFileW(partPath.c_str());
                DeleteFileW(metaPath.c_str());
                continue;
            }
        }

        if (!MoveFileExW(partPath.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            if (errorOut) *errorOut = "Unable to commit verified download";
            return false;
        }
        DeleteFileW(metaPath.c_str());
        if (options.onProgress) options.onProgress({downloaded, totalBytes ? totalBytes : downloaded, 0.0, resumed});
        return true;
    }

    return false;
}

std::optional<ReleaseFeed> ParseAndVerifyReleaseFeed(std::string_view jsonText,
                                                     const FeedVerifyOptions& options,
                                                     std::string* errorOut) {
    auto root = ParseJson(jsonText, errorOut);
    if (!root || root->type != JsonValue::Type::Object) return std::nullopt;

    const JsonValue* payloadObj = &(*root);
    std::optional<JsonValue> decodedPayloadDoc;
    bool signatureVerified = false;
    std::string keyId;

    // Detect ADR-04 signed envelope: { schemaVersion: 1, keyId, payload: "<b64url>", signature: "<b64url>" }
    if (const auto* payloadB64 = root->Get("payload"); payloadB64 && payloadB64->type == JsonValue::Type::String) {
        const auto* sigNode = root->Get("signature");
        const auto* keyNode = root->Get("keyId");
        const auto* svNode = root->Get("schemaVersion");
        if (!svNode || svNode->AsInt().value_or(0) != 1) {
            if (errorOut) *errorOut = "Unsupported signed feed schemaVersion";
            return std::nullopt;
        }
        keyId = keyNode ? keyNode->AsString().value_or("") : "";
        auto payloadBytes = Base64UrlDecode(*payloadB64->AsString());
        if (!payloadBytes || payloadBytes->empty()) {
            if (errorOut) *errorOut = "Invalid base64url payload in signed feed";
            return std::nullopt;
        }
        if (!options.pinnedPublicKeyBase64Url.empty()) {
            if (!sigNode || sigNode->type != JsonValue::Type::String) {
                if (errorOut) *errorOut = "Missing signature in release feed";
                return std::nullopt;
            }
            auto sigBytes = Base64UrlDecode(*sigNode->AsString());
            auto pubBytes = Base64UrlDecode(options.pinnedPublicKeyBase64Url);
            if (!sigBytes || !pubBytes ||
                !VerifyEcdsaP256Raw(payloadBytes->data(), payloadBytes->size(),
                                    sigBytes->data(), sigBytes->size(),
                                    pubBytes->data(), pubBytes->size())) {
                if (errorOut) *errorOut = "Release feed ECDSA P-256 signature verification failed";
                return std::nullopt;
            }
            signatureVerified = true;
        }
        const std::string payloadStr(reinterpret_cast<const char*>(payloadBytes->data()), payloadBytes->size());
        decodedPayloadDoc = ParseJson(payloadStr, errorOut);
        if (!decodedPayloadDoc || decodedPayloadDoc->type != JsonValue::Type::Object) return std::nullopt;
        payloadObj = &(*decodedPayloadDoc);
    } else if (options.requireSignature) {
        if (errorOut) *errorOut = "Unsigned release feed rejected by policy";
        return std::nullopt;
    }

    if (options.requireSignature && !signatureVerified) {
        if (errorOut) *errorOut = "Release feed signature could not be verified";
        return std::nullopt;
    }

    ReleaseFeed feed;
    feed.signatureVerified = signatureVerified;
    feed.keyId = std::move(keyId);
    feed.schemaVersion = static_cast<int>(payloadObj->Get("schemaVersion") ? payloadObj->Get("schemaVersion")->AsInt().value_or(1) : 1);
    if (feed.schemaVersion != 1) {
        if (errorOut) *errorOut = "Unsupported release payload schemaVersion";
        return std::nullopt;
    }

    if (const auto* v = payloadObj->Get("version")) feed.version = v->AsString().value_or("");
    if (const auto* v = payloadObj->Get("releaseSequence")) feed.releaseSequence = v->AsUInt().value_or(0);
    if (const auto* v = payloadObj->Get("channel")) feed.channel = v->AsString().value_or("stable");
    if (const auto* v = payloadObj->Get("platform")) feed.platform = v->AsString().value_or("windows");
    if (const auto* v = payloadObj->Get("arch")) feed.arch = v->AsString().value_or("x64");
    if (const auto* v = payloadObj->Get("minWindowsBuild")) feed.minWindowsBuild = static_cast<uint32_t>(v->AsUInt().value_or(19045));
    if (const auto* v = payloadObj->Get("rolloutPercentage")) feed.rolloutPercentage = static_cast<int>(v->AsInt().value_or(100));
    if (const auto* v = payloadObj->Get("publishedAt")) feed.publishedAt = v->AsString().value_or("");
    if (const auto* v = payloadObj->Get("expiresAt")) feed.expiresAt = v->AsString().value_or("");
    if (const auto* v = payloadObj->Get("releaseNotesUrl")) feed.releaseNotesUrl = v->AsString().value_or("");

    if (feed.version.empty() || feed.releaseSequence == 0) {
        if (errorOut) *errorOut = "Feed missing version or releaseSequence";
        return std::nullopt;
    }
    if (feed.platform != "windows" || feed.arch != "x64") {
        if (errorOut) *errorOut = "Feed platform/arch mismatch";
        return std::nullopt;
    }
    if (feed.rolloutPercentage < 0 || feed.rolloutPercentage > 100) {
        if (errorOut) *errorOut = "Invalid rolloutPercentage";
        return std::nullopt;
    }
    if (options.minSequence > 0 && feed.releaseSequence < options.minSequence) {
        if (errorOut) *errorOut = "Feed releaseSequence is lower than trusted sequence (rollback attack blocked)";
        return std::nullopt;
    }

    const uint32_t hostBuild = options.currentWindowsBuild ? options.currentWindowsBuild : CurrentWindowsBuildNumber();
    if (feed.minWindowsBuild > 0 && hostBuild < feed.minWindowsBuild) {
        if (errorOut) *errorOut = "Windows build " + std::to_string(hostBuild) + " is below required " + std::to_string(feed.minWindowsBuild);
        return std::nullopt;
    }

    if (options.checkExpiry && !feed.expiresAt.empty()) {
        const auto exp = ParseIso8601UtcEpochSeconds(feed.expiresAt);
        if (!exp) {
            if (errorOut) *errorOut = "Invalid expiresAt timestamp";
            return std::nullopt;
        }
        const int64_t now = static_cast<int64_t>(std::time(nullptr));
        constexpr int64_t clockSkewSec = 300;
        if (now > *exp + clockSkewSec) {
            if (errorOut) *errorOut = "Release feed metadata has expired";
            return std::nullopt;
        }
    }

    if (const auto* artifacts = payloadObj->Get("artifacts"); artifacts && artifacts->type == JsonValue::Type::Object) {
        feed.bootstrapper = ParseArtifact(artifacts->Get("bootstrapper"));
        feed.offline = ParseArtifact(artifacts->Get("offline"));
        feed.codecSource = ParseArtifact(artifacts->Get("codecSource"));
    }

    if (const auto* comps = payloadObj->Get("components"); comps && comps->type == JsonValue::Type::Array) {
        for (const auto& item : comps->arrVal) {
            if (item.type != JsonValue::Type::Object) continue;
            ComponentInfo c;
            if (const auto* v = item.Get("id")) c.id = v->AsString().value_or("");
            if (const auto* v = item.Get("url")) c.url = v->AsString().value_or("");
            if (const auto* v = item.Get("sizeBytes")) c.sizeBytes = v->AsUInt().value_or(0);
            if (const auto* v = item.Get("unpackedSizeBytes")) c.unpackedSizeBytes = v->AsUInt().value_or(0);
            if (const auto* v = item.Get("sha256")) c.sha256 = ToLowerAscii(v->AsString().value_or(""));
            if (const auto* v = item.Get("fileManifestSha256")) c.fileManifestSha256 = ToLowerAscii(v->AsString().value_or(""));
            if (const auto* v = item.Get("unpackDir")) c.unpackDir = v->AsString().value_or("");
            if (!c.id.empty() && !c.url.empty() && c.sha256.size() == 64) {
                feed.components.push_back(std::move(c));
            }
        }
    }

    return feed;
}

bool IsEligibleForRollout(std::wstring_view userSid, std::string_view version,
                          uint64_t releaseSequence, int rolloutPercentage) {
    if (rolloutPercentage <= 0) return false;
    if (rolloutPercentage >= 100) return true;
    const std::string key = WideToUtf8(userSid) + ":" + std::string(version) + ":" + std::to_string(releaseSequence);
    const std::string hex = Sha256HexBytes(key.data(), key.size());
    if (hex.size() < 8) return true;
    uint32_t sample = 0;
    std::from_chars(hex.data(), hex.data() + 8, sample, 16);
    const int bucket = static_cast<int>(sample % 100u);
    return bucket < rolloutPercentage;
}

std::string ReadUpdateChannel(const InstallLayout& layout) {
    wchar_t envBuf[64]{};
    const DWORD len = GetEnvironmentVariableW(L"JIANGJIE_UPDATE_CHANNEL", envBuf, static_cast<DWORD>(std::size(envBuf)));
    if (len > 0 && len < std::size(envBuf)) {
        const auto ch = ToLowerAscii(WideToUtf8(envBuf));
        if (ch == "stable" || ch == "beta") return ch;
    }
    const auto fileVal = ToLowerAscii(ReadWholeFile(layout.roamingData / L"update-channel.txt"));
    if (fileVal.find("beta") != std::string::npos) return "beta";
    if (const auto cur = ReadCurrentState(layout)) {
        if (cur->channel == "beta" || cur->channel == "stable") return cur->channel;
    }
    return "stable";
}

std::optional<CurrentInstallState> ReadCurrentState(const InstallLayout& layout) {
    const auto text = ReadWholeFile(layout.currentJson);
    if (text.empty()) return std::nullopt;
    auto doc = ParseJson(text);
    if (!doc || doc->type != JsonValue::Type::Object) return std::nullopt;
    CurrentInstallState st;
    if (const auto* v = doc->Get("schemaVersion")) st.schemaVersion = static_cast<int>(v->AsInt().value_or(1));
    if (const auto* v = doc->Get("channel")) st.channel = v->AsString().value_or("stable");
    if (const auto* v = doc->Get("version")) st.version = v->AsString().value_or("");
    if (const auto* v = doc->Get("releaseSequence")) st.releaseSequence = v->AsUInt().value_or(0);
    if (const auto* v = doc->Get("previousSequence")) st.previousSequence = v->AsUInt().value_or(0);
    if (const auto* v = doc->Get("previousVersion")) st.previousVersion = v->AsString().value_or("");
    if (const auto* v = doc->Get("healthySequence")) st.healthySequence = v->AsUInt().value_or(0);
    if (const auto* v = doc->Get("unverifiedAttempts")) st.unverifiedAttempts = static_cast<int>(v->AsInt().value_or(0));
    if (const auto* v = doc->Get("installedAt")) st.installedAt = v->AsString().value_or("");
    if (st.releaseSequence == 0) return std::nullopt;
    return st;
}

bool WriteCurrentStateAtomic(const InstallLayout& layout, const CurrentInstallState& st) {
    std::string json = "{\n"
                       "  \"schemaVersion\": 1,\n"
                       "  \"channel\": " + JsonEscape(st.channel) + ",\n"
                       "  \"version\": " + JsonEscape(st.version) + ",\n"
                       "  \"releaseSequence\": " + std::to_string(st.releaseSequence) + ",\n"
                       "  \"previousSequence\": " + std::to_string(st.previousSequence) + ",\n"
                       "  \"previousVersion\": " + JsonEscape(st.previousVersion) + ",\n"
                       "  \"healthySequence\": " + std::to_string(st.healthySequence) + ",\n"
                       "  \"unverifiedAttempts\": " + std::to_string(st.unverifiedAttempts) + ",\n"
                       "  \"installedAt\": " + JsonEscape(st.installedAt.empty() ? IsoUtcNow() : st.installedAt) + "\n"
                       "}\n";
    return AtomicWriteString(layout.currentJson, json);
}

std::optional<PendingUpdateState> ReadPendingUpdate(const InstallLayout& layout) {
    const auto text = ReadWholeFile(layout.pendingJson);
    if (text.empty()) return std::nullopt;
    auto doc = ParseJson(text);
    if (!doc || doc->type != JsonValue::Type::Object) return std::nullopt;
    PendingUpdateState p;
    if (const auto* v = doc->Get("schemaVersion")) p.schemaVersion = static_cast<int>(v->AsInt().value_or(1));
    if (const auto* v = doc->Get("channel")) p.channel = v->AsString().value_or("stable");
    if (const auto* v = doc->Get("version")) p.version = v->AsString().value_or("");
    if (const auto* v = doc->Get("releaseSequence")) p.releaseSequence = v->AsUInt().value_or(0);
    if (const auto* v = doc->Get("stagingDir")) p.stagingDir = v->AsString().value_or("");
    if (const auto* v = doc->Get("notesUrl")) p.notesUrl = v->AsString().value_or("");
    if (const auto* v = doc->Get("mode")) p.mode = v->AsString().value_or("incremental");
    if (const auto* v = doc->Get("installerPath")) p.installerPath = v->AsString().value_or("");
    if (const auto* v = doc->Get("installerSha256")) p.installerSha256 = v->AsString().value_or("");
    if (const auto* v = doc->Get("downloadedBytes")) p.downloadedBytes = v->AsUInt().value_or(0);
    if (const auto* v = doc->Get("reusedBytes")) p.reusedBytes = v->AsUInt().value_or(0);
    if (const auto* v = doc->Get("stagedAt")) p.stagedAt = v->AsString().value_or("");
    if (p.releaseSequence == 0 || p.version.empty()) return std::nullopt;
    return p;
}

bool WritePendingUpdateAtomic(const InstallLayout& layout, const PendingUpdateState& p) {
    std::string json = "{\n"
                       "  \"schemaVersion\": 1,\n"
                       "  \"channel\": " + JsonEscape(p.channel) + ",\n"
                       "  \"version\": " + JsonEscape(p.version) + ",\n"
                       "  \"releaseSequence\": " + std::to_string(p.releaseSequence) + ",\n"
                       "  \"stagingDir\": " + JsonEscape(p.stagingDir) + ",\n"
                       "  \"notesUrl\": " + JsonEscape(p.notesUrl) + ",\n"
                       "  \"mode\": " + JsonEscape(p.mode) + ",\n"
                       "  \"installerPath\": " + JsonEscape(p.installerPath) + ",\n"
                       "  \"installerSha256\": " + JsonEscape(p.installerSha256) + ",\n"
                       "  \"downloadedBytes\": " + std::to_string(p.downloadedBytes) + ",\n"
                       "  \"reusedBytes\": " + std::to_string(p.reusedBytes) + ",\n"
                       "  \"stagedAt\": " + JsonEscape(p.stagedAt.empty() ? IsoUtcNow() : p.stagedAt) + "\n"
                       "}\n";
    return AtomicWriteString(layout.pendingJson, json);
}

void ClearPendingUpdate(const InstallLayout& layout) {
    DeleteFileW(layout.pendingJson.c_str());
}

std::vector<uint64_t> ReadFailedSequences(const InstallLayout& layout) {
    std::vector<uint64_t> out;
    const auto text = ReadWholeFile(layout.failedJson);
    if (text.empty()) return out;
    auto doc = ParseJson(text);
    if (!doc || doc->type != JsonValue::Type::Object) return out;
    if (const auto* arr = doc->Get("failedSequences"); arr && arr->type == JsonValue::Type::Array) {
        for (const auto& v : arr->arrVal) {
            if (auto n = v.AsUInt()) out.push_back(*n);
        }
    }
    return out;
}

bool RecordFailedSequence(const InstallLayout& layout, uint64_t sequence) {
    auto list = ReadFailedSequences(layout);
    if (std::find(list.begin(), list.end(), sequence) == list.end()) list.push_back(sequence);
    std::string json = "{\n  \"failedSequences\": [";
    for (size_t i = 0; i < list.size(); ++i) {
        if (i > 0) json += ", ";
        json += std::to_string(list[i]);
    }
    json += "]\n}\n";
    return AtomicWriteString(layout.failedJson, json);
}

bool IsSequenceFailed(const InstallLayout& layout, uint64_t sequence) {
    const auto list = ReadFailedSequences(layout);
    return std::find(list.begin(), list.end(), sequence) != list.end();
}

bool IsSafeRelativePath(const fs::path& rel) {
    if (rel.empty() || rel.is_absolute() || rel.has_root_name() || rel.has_root_directory()) return false;
    const auto native = rel.native();
    if (!native.empty() && (native[0] == L'/' || native[0] == L'\\')) return false;
    if (native.find(L':') != std::wstring::npos) return false;
    for (const auto& part : rel) {
        if (part == L".." || part == L".") {
            if (part == L"..") return false;
        }
    }
    return true;
}

bool ContainsReparsePoint(const fs::path& root) {
    const DWORD rootAttr = GetFileAttributesW(root.c_str());
    if (rootAttr != INVALID_FILE_ATTRIBUTES && (rootAttr & FILE_ATTRIBUTE_REPARSE_POINT)) return true;
    std::error_code ec;
    if (!fs::is_directory(root, ec)) return false;
    for (const auto& entry : fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec)) {
        const DWORD attr = GetFileAttributesW(entry.path().c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_REPARSE_POINT)) return true;
    }
    return false;
}

IncrementalStageResult StageIncrementalComponents(const InstallLayout& layout,
                                                  const ReleaseFeed& feed,
                                                  const DownloadOptions& downloadOptions,
                                                  std::string* errorOut) {
    IncrementalStageResult result;
    std::error_code ec;
    fs::create_directories(layout.versionsDir, ec);
    fs::create_directories(layout.componentsCache, ec);

    const fs::path stagingDir = layout.versionsDir / (std::to_wstring(feed.releaseSequence) + L".staging");
    fs::remove_all(stagingDir, ec);
    fs::create_directories(stagingDir, ec);

    // Load hashes of currently active version to maximize local reuse
    std::map<std::string, std::string> currentHashes;
    fs::path currentVersionDir;
    if (const auto cur = ReadCurrentState(layout)) {
        currentVersionDir = layout.versionsDir / std::to_wstring(cur->releaseSequence);
        const auto hashText = ReadWholeFile(currentVersionDir / L"component-hashes.json");
        if (auto doc = ParseJson(hashText); doc && doc->type == JsonValue::Type::Object) {
            for (const auto& [k, v] : doc->objVal) {
                if (auto s = v.AsString()) currentHashes[k] = ToLowerAscii(*s);
            }
        }
    }

    wchar_t sysDir[MAX_PATH]{};
    GetSystemDirectoryW(sysDir, MAX_PATH);
    const fs::path tarExe = fs::path(sysDir) / L"tar.exe";

    std::string newHashMapJson = "{\n";
    bool firstHashEntry = true;

    for (const auto& comp : feed.components) {
        if (!comp.unpackDir.empty() && !IsSafeRelativePath(Utf8ToWide(comp.unpackDir))) {
            if (errorOut) *errorOut = "Unsafe component unpackDir: " + comp.unpackDir;
            fs::remove_all(stagingDir, ec);
            return result;
        }
        const fs::path targetDir = comp.unpackDir.empty() ? stagingDir : (stagingDir / Utf8ToWide(comp.unpackDir));
        fs::create_directories(targetDir, ec);

        bool reused = false;
        // 1. Try reusing from currently active version if component SHA-256 matches and unpackDir is isolated
        if (!comp.unpackDir.empty() && !currentVersionDir.empty()) {
            const auto it = currentHashes.find(comp.id);
            const fs::path existingSubdir = currentVersionDir / Utf8ToWide(comp.unpackDir);
            if (it != currentHashes.end() && it->second == comp.sha256 && fs::is_directory(existingSubdir, ec)) {
                if (CopyOrHardLinkTree(existingSubdir, targetDir)) {
                    reused = true;
                    result.reusedBytes += comp.sizeBytes;
                    ++result.reusedComponents;
                }
            }
        }

        // 2. Try reusing cached component archive by SHA-256
        const fs::path cachedArchive = layout.componentsCache / (Utf8ToWide(comp.id) + L"-" + Utf8ToWide(comp.sha256.substr(0, 16)) + L".tar.gz");
        if (!reused) {
            bool cacheHit = fs::is_regular_file(cachedArchive, ec) && Sha256HexFile(cachedArchive) == comp.sha256;
            if (!cacheHit) {
                DownloadOptions compOpt = downloadOptions;
                compOpt.expectedSize = comp.sizeBytes;
                compOpt.expectedSha256 = comp.sha256;
                if (!DownloadFileWithResume(comp.url, cachedArchive, compOpt, errorOut)) {
                    fs::remove_all(stagingDir, ec);
                    return result;
                }
                result.downloadedBytes += comp.sizeBytes;
                ++result.downloadedComponents;
            } else {
                result.reusedBytes += comp.sizeBytes;
                ++result.reusedComponents;
            }

            if (!ValidateArchiveEntriesSafe(cachedArchive, errorOut)) {
                DeleteFileW(cachedArchive.c_str());
                fs::remove_all(stagingDir, ec);
                return result;
            }
            const std::wstring tarArgs = L"-xf \"" + cachedArchive.native() + L"\" -C \"" + targetDir.native() + L"\"";
            DWORD exitCode = 1;
            if (!RunProcessWait(tarExe, tarArgs, 300000, &exitCode)) {
                if (errorOut) *errorOut = "Failed to unpack component " + comp.id + " (exit " + std::to_string(exitCode) + ")";
                fs::remove_all(stagingDir, ec);
                return result;
            }
        }

        if (!firstHashEntry) newHashMapJson += ",\n";
        firstHashEntry = false;
        newHashMapJson += "  " + JsonEscape(comp.id) + ": " + JsonEscape(comp.sha256);
    }
    newHashMapJson += "\n}\n";

    if (ContainsReparsePoint(stagingDir)) {
        if (errorOut) *errorOut = "Reparse point detected inside staged version directory";
        fs::remove_all(stagingDir, ec);
        return result;
    }

    if (!AtomicWriteString(stagingDir / L"component-hashes.json", newHashMapJson)) {
        if (errorOut) *errorOut = "Failed to write component-hashes.json";
        fs::remove_all(stagingDir, ec);
        return result;
    }

    PendingUpdateState pending;
    pending.channel = feed.channel;
    pending.version = feed.version;
    pending.releaseSequence = feed.releaseSequence;
    pending.stagingDir = WideToUtf8(stagingDir.native());
    pending.notesUrl = feed.releaseNotesUrl;
    pending.mode = "incremental";
    pending.downloadedBytes = result.downloadedBytes;
    pending.reusedBytes = result.reusedBytes;
    pending.stagedAt = IsoUtcNow();

    if (!WritePendingUpdateAtomic(layout, pending)) {
        if (errorOut) *errorOut = "Failed to write pending-update.json";
        return result;
    }

    result.staged = true;
    result.pending = std::move(pending);
    return result;
}

bool ActivatePendingUpdate(const InstallLayout& layout, std::string* errorOut) {
    const auto pending = ReadPendingUpdate(layout);
    if (!pending) return false;

    if (pending->mode == "offline-installer" && !pending->installerPath.empty()) {
        const fs::path installer = Utf8ToWide(pending->installerPath);
        if (!pending->installerSha256.empty() && Sha256HexFile(installer) != ToLowerAscii(pending->installerSha256)) {
            if (errorOut) *errorOut = "Pending offline installer failed SHA-256 verification";
            ClearPendingUpdate(layout);
            return false;
        }
        DWORD code = 1;
        const std::wstring args = L"/S /NOLAUNCH /D=" + layout.installRoot.native();
        if (!RunProcessWait(installer, args, 600000, &code)) {
            if (errorOut) *errorOut = "Offline installer exited with code " + std::to_string(code);
            return false;
        }
        ClearPendingUpdate(layout);
        return true;
    }

    const fs::path stagingDir = Utf8ToWide(pending->stagingDir);
    const fs::path targetDir = layout.versionsDir / std::to_wstring(pending->releaseSequence);
    std::error_code ec;
    if (!fs::is_directory(stagingDir, ec)) {
        if (errorOut) *errorOut = "Pending staging directory does not exist";
        ClearPendingUpdate(layout);
        return false;
    }
    if (ContainsReparsePoint(stagingDir)) {
        if (errorOut) *errorOut = "Staging directory contains forbidden reparse points";
        ClearPendingUpdate(layout);
        return false;
    }

    if (fs::exists(targetDir, ec)) {
        fs::remove_all(targetDir, ec);
    }
    if (!MoveFileExW(stagingDir.c_str(), targetDir.c_str(), MOVEFILE_WRITE_THROUGH)) {
        if (errorOut) *errorOut = "Failed to atomically move staged version into place";
        return false;
    }

    CurrentInstallState next;
    if (const auto cur = ReadCurrentState(layout)) {
        next.previousSequence = cur->releaseSequence;
        next.previousVersion = cur->version;
        next.healthySequence = cur->healthySequence;
    }
    next.channel = pending->channel;
    next.version = pending->version;
    next.releaseSequence = pending->releaseSequence;
    next.unverifiedAttempts = 0;
    next.installedAt = IsoUtcNow();

    if (!WriteCurrentStateAtomic(layout, next)) {
        if (errorOut) *errorOut = "Failed to commit current.json";
        return false;
    }
    ClearPendingUpdate(layout);
    return true;
}

bool RecordVersionHealthy(const InstallLayout& layout, uint64_t sequence) {
    auto cur = ReadCurrentState(layout);
    if (!cur || cur->releaseSequence != sequence) return false;
    if (cur->healthySequence == sequence && cur->unverifiedAttempts == 0) return true;
    cur->healthySequence = sequence;
    cur->unverifiedAttempts = 0;
    return WriteCurrentStateAtomic(layout, *cur);
}

bool CheckAndRollbackIfUnhealthy(const InstallLayout& layout, int maxUnverifiedAttempts,
                                 std::string* rollbackReasonOut) {
    auto cur = ReadCurrentState(layout);
    if (!cur) return false;
    if (cur->healthySequence == cur->releaseSequence) return false;
    if (cur->unverifiedAttempts < maxUnverifiedAttempts) return false;
    if (cur->previousSequence == 0) return false;

    const fs::path prevDir = layout.versionsDir / std::to_wstring(cur->previousSequence);
    std::error_code ec;
    if (!fs::is_directory(prevDir, ec)) return false;

    const uint64_t badSeq = cur->releaseSequence;
    const std::string badVer = cur->version;
    RecordFailedSequence(layout, badSeq);

    CurrentInstallState rolledBack;
    rolledBack.channel = cur->channel;
    rolledBack.version = cur->previousVersion.empty() ? ("seq-" + std::to_string(cur->previousSequence)) : cur->previousVersion;
    rolledBack.releaseSequence = cur->previousSequence;
    rolledBack.previousSequence = 0;
    rolledBack.previousVersion.clear();
    rolledBack.healthySequence = cur->previousSequence;
    rolledBack.unverifiedAttempts = 0;
    rolledBack.installedAt = IsoUtcNow();

    if (!WriteCurrentStateAtomic(layout, rolledBack)) return false;
    if (rollbackReasonOut) {
        *rollbackReasonOut = "Rolled back unhealthy version " + badVer + " (seq " + std::to_string(badSeq) +
                             ") to seq " + std::to_string(rolledBack.releaseSequence);
    }
    return true;
}

bool QueryWorkbenchBusy(unsigned port, const std::wstring& internalToken, bool* busyOut, std::string* reasonOut) {
    if (!busyOut || port == 0 || port > 65535) return false;
    *busyOut = false;

    UniqueHttp session(WinHttpOpen(L"JiangjieDesktop/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                   WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session) return false;
    WinHttpSetTimeouts(session.get(), 1500, 1500, 1500, 2000);
    UniqueHttp connect(WinHttpConnect(session.get(), L"127.0.0.1", static_cast<INTERNET_PORT>(port), 0));
    if (!connect) return false;
    UniqueHttp request(WinHttpOpenRequest(connect.get(), L"GET", L"/bohack/api/desktop/busy",
                                          nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    if (!request) return false;

    std::wstring headers;
    if (!internalToken.empty()) headers = L"X-Dsh-Internal-Token: " + internalToken + L"\r\n";
    if (!WinHttpSendRequest(request.get(), headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
                            headers.empty() ? 0 : static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request.get(), nullptr)) {
        return false;
    }

    DWORD statusCode = 0, statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200) return false;

    std::string body;
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(request.get(), &avail) || avail == 0) break;
        const size_t off = body.size();
        body.resize(off + avail);
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), body.data() + off, avail, &read)) return false;
        body.resize(off + read);
        if (body.size() > 65536) break;
    }

    auto doc = ParseJson(body);
    if (!doc || doc->type != JsonValue::Type::Object) return false;
    if (const auto* b = doc->Get("busy")) *busyOut = b->AsBool().value_or(false);
    if (reasonOut) {
        if (const auto* r = doc->Get("reason")) *reasonOut = r->AsString().value_or("");
    }
    return true;
}

} // namespace jiangjie::release
