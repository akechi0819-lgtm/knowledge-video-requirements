#include <windows.h>
#include <wincrypt.h>
#include <shellapi.h>

#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {
constexpr DWORD kMaxRequest = 1024 * 1024;

void Require(bool condition) {
  if (!condition) throw std::runtime_error("credential store operation failed");
}

class Handle {
 public:
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() { if (value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

struct Secret {
  std::string text;
  ~Secret() { if (!text.empty()) SecureZeroMemory(text.data(), text.size()); }
};

struct Blob : DATA_BLOB {
  Blob() : DATA_BLOB{} {}
  ~Blob() {
    if (pbData) {
      SecureZeroMemory(pbData, cbData);
      LocalFree(pbData);
    }
  }
};

void ReadBytes(HANDLE stream, std::string& output, size_t limit) {
  char chunk[4096];
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(stream, chunk, sizeof(chunk), &count, nullptr)) {
      Require(GetLastError() == ERROR_BROKEN_PIPE);
      break;
    }
    if (!count) break;
    Require(output.size() + count <= limit);
    output.append(chunk, count);
    SecureZeroMemory(chunk, count);
  }
}

void WriteBytes(HANDLE stream, std::string_view data) {
  while (!data.empty()) {
    DWORD count = 0;
    Require(WriteFile(stream, data.data(), static_cast<DWORD>(data.size()), &count, nullptr) && count);
    data.remove_prefix(count);
  }
}

bool IsHex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

// The helper accepts the settings protocol: an action, a hex scope, and a flat
// object of strings. Keep the keys object in its original UTF-8 encoding.
class Request {
 public:
  explicit Request(std::string_view input) : input_(input) {
    Take('{');
    do {
      auto field = String();
      Take(':');
      if (field == "action" && action.empty()) action = String();
      else if (field == "scope" && scope.empty()) scope = String();
      else if (field == "keys" && keys.empty()) keys = Keys();
      else Require(false);
    } while (Consume(','));
    Take('}');
    SkipSpace();
    Require(input_.empty() && scope.size() == 64);
    for (char c : scope) Require(IsHex(c));
    Require((action == "read" && keys.empty()) || (action == "write" && !keys.empty()));
  }

  std::string_view action, scope, keys;

 private:
  void SkipSpace() {
    const auto first = input_.find_first_not_of(" \t\r\n");
    input_.remove_prefix(first == std::string_view::npos ? input_.size() : first);
  }

  bool Consume(char c) {
    SkipSpace();
    if (input_.empty() || input_.front() != c) return false;
    input_.remove_prefix(1);
    return true;
  }

  void Take(char c) { Require(Consume(c)); }

  std::string_view String() {
    Take('"');
    const auto start = input_.data();
    while (!input_.empty()) {
      const auto c = static_cast<unsigned char>(input_.front());
      input_.remove_prefix(1);
      if (c == '"') return {start, static_cast<size_t>(input_.data() - start - 1)};
      Require(c >= 0x20);
      if (c != '\\') continue;
      Require(!input_.empty());
      const char escape = input_.front();
      input_.remove_prefix(1);
      if (escape == 'u') {
        Require(input_.size() >= 4);
        for (char hex : input_.substr(0, 4)) Require(IsHex(hex) || (hex >= 'A' && hex <= 'F'));
        input_.remove_prefix(4);
      } else {
        Require(std::string_view("\"\\/bfnrt").find(escape) != std::string_view::npos);
      }
    }
    Require(false);
    return {};
  }

  std::string_view Keys() {
    Take('{');
    const auto start = input_.data() - 1;
    if (!Consume('}')) {
      do {
        String();
        Take(':');
        String();
      } while (Consume(','));
      Take('}');
    }
    return {start, static_cast<size_t>(input_.data() - start)};
  }

  std::string_view input_;
};

std::filesystem::path StorePath(std::string_view scope) {
  const DWORD size = GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
  Require(size > 1);
  std::wstring appData(size, L'\0');
  const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", appData.data(), size);
  Require(length > 0 && length < size);
  appData.resize(length);
  auto root = std::filesystem::path(appData);
  Require(root.is_absolute());
  return root / L"Jiangjie" / L"credentials" / (std::wstring(scope.begin(), scope.end()) + L".dpapi");
}

DATA_BLOB View(std::string_view bytes) {
  return {static_cast<DWORD>(bytes.size()), reinterpret_cast<BYTE*>(const_cast<char*>(bytes.data()))};
}

void ReadStore(const std::filesystem::path& file, DATA_BLOB& entropy) {
  const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  Handle handle(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (handle.get() == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    Require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND);
    WriteBytes(out, "{}");
    return;
  }
  std::string cipherText;
  ReadBytes(handle.get(), cipherText, kMaxRequest + 4096);
  auto cipher = View(cipherText);
  Blob plain;
  Require(CryptUnprotectData(&cipher, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &plain));
  WriteBytes(out, {reinterpret_cast<const char*>(plain.pbData), plain.cbData});
}

void WriteStore(const std::filesystem::path& file, DATA_BLOB& entropy, std::string_view keys) {
  if (keys == "{}") {
    if (!DeleteFileW(file.c_str())) {
      const DWORD error = GetLastError();
      Require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND);
    }
    return;
  }
  auto plain = View(keys);
  Blob cipher;
  Require(CryptProtectData(&plain, L"Jiangjie desktop credentials", &entropy, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &cipher));
  const auto directory = file.parent_path();
  std::filesystem::create_directories(directory);
  wchar_t temp[MAX_PATH];
  Require(GetTempFileNameW(directory.c_str(), L"jjc", 0, temp));
  try {
    {
      Handle handle(CreateFileW(temp, GENERIC_WRITE, 0, nullptr, TRUNCATE_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      Require(handle.get() != INVALID_HANDLE_VALUE);
      WriteBytes(handle.get(), {reinterpret_cast<const char*>(cipher.pbData), cipher.cbData});
      Require(FlushFileBuffers(handle.get()));
    }
    Require(MoveFileExW(temp, file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH));
  } catch (...) {
    DeleteFileW(temp);
    throw;
  }
}
}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc = 0;
  auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  const bool valid = argv && argc == 2 && std::wstring_view(argv[1]) == L"--desktop-settings-keychain";
  if (argv) LocalFree(argv);
  if (!valid) return 2;
  try {
    Secret input;
    ReadBytes(GetStdHandle(STD_INPUT_HANDLE), input.text, kMaxRequest);
    const Request request(input.text);
    const auto location = StorePath(request.scope);
    auto entropy = View(request.scope);
    if (request.action == "read") ReadStore(location, entropy);
    else WriteStore(location, entropy, request.keys);
    return 0;
  } catch (...) {
    return 1;
  }
}
