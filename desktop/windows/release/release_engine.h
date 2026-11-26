#pragma once

#include <windows.h>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace jiangjie::release {
namespace fs = std::filesystem;

struct InstallLayout {
    fs::path installRoot;     // %LOCALAPPDATA%\Programs\Jiangjie
    fs::path versionsDir;     // %LOCALAPPDATA%\Programs\Jiangjie\versions
    fs::path currentJson;     // %LOCALAPPDATA%\Programs\Jiangjie\current.json
    fs::path pendingJson;     // %LOCALAPPDATA%\Programs\Jiangjie\pending-update.json
    fs::path failedJson;      // %LOCALAPPDATA%\Programs\Jiangjie\failed-sequences.json
    fs::path roamingData;     // %APPDATA%\Jiangjie
    fs::path localData;       // %LOCALAPPDATA%\Jiangjie
    fs::path cacheDir;        // %LOCALAPPDATA%\Jiangjie\cache
    fs::path downloadsDir;    // %LOCALAPPDATA%\Jiangjie\cache\downloads
    fs::path componentsCache; // %LOCALAPPDATA%\Jiangjie\cache\components
    fs::path logsDir;         // %LOCALAPPDATA%\Jiangjie\logs
};

struct ArtifactInfo {
    std::string url;
    std::string fileName;
    uint64_t sizeBytes = 0;
    std::string sha256;
    std::string publisherHint;
};

struct ComponentInfo {
    std::string id;
    std::string url;
    uint64_t sizeBytes = 0;
    uint64_t unpackedSizeBytes = 0;
    std::string sha256;
    std::string fileManifestSha256;
    std::string unpackDir; // relative directory inside version root ("" for root)
};

struct ReleaseFeed {
    int schemaVersion = 1;
    std::string version;
    uint64_t releaseSequence = 0;
    std::string channel = "stable";
    std::string platform = "windows";
    std::string arch = "x64";
    uint32_t minWindowsBuild = 19045;
    int rolloutPercentage = 100;
    std::string publishedAt;
    std::string expiresAt;
    std::string releaseNotesUrl;
    std::optional<ArtifactInfo> bootstrapper;
    std::optional<ArtifactInfo> offline;
    std::optional<ArtifactInfo> codecSource;
    std::vector<ComponentInfo> components;
    bool signatureVerified = false;
    std::string keyId;
};

struct CurrentInstallState {
    int schemaVersion = 1;
    std::string channel = "stable";
    std::string version;
    uint64_t releaseSequence = 0;
    uint64_t previousSequence = 0;
    std::string previousVersion;
    uint64_t healthySequence = 0;
    int unverifiedAttempts = 0;
    std::string installedAt;
};

struct PendingUpdateState {
    int schemaVersion = 1;
    std::string channel = "stable";
    std::string version;
    uint64_t releaseSequence = 0;
    std::string stagingDir;
    std::string notesUrl;
    std::string mode; // "incremental" or "offline-installer"
    std::string installerPath;
    std::string installerSha256;
    uint64_t downloadedBytes = 0;
    uint64_t reusedBytes = 0;
    std::string stagedAt;
};

struct DownloadProgress {
    uint64_t downloadedBytes = 0;
    uint64_t totalBytes = 0;
    double bytesPerSecond = 0.0;
    bool resumed = false;
};

struct DownloadOptions {
    std::vector<std::string> allowedHosts = {"jiangjie.gingers.cloud", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"};
    bool allowLocalHttp = false;
    uint64_t expectedSize = 0;
    std::string expectedSha256;
    int maxRetries = 3;
    std::function<void(const DownloadProgress&)> onProgress;
    const std::atomic<bool>* cancelFlag = nullptr;
};

struct FeedVerifyOptions {
    std::string pinnedPublicKeyBase64Url; // 64-byte raw X||Y P-256 public key in base64url; empty disables requirement
    bool requireSignature = false;
    bool checkExpiry = true;
    uint64_t minSequence = 0;
    uint32_t currentWindowsBuild = 0; // 0 = auto-detect
};

struct IncrementalStageResult {
    bool staged = false;
    uint64_t downloadedBytes = 0;
    uint64_t reusedBytes = 0;
    int downloadedComponents = 0;
    int reusedComponents = 0;
    PendingUpdateState pending;
};

// Minimal JSON DOM used internally for release manifests and state files.
struct JsonValue {
    enum class Type { Null, Bool, Int, Double, String, Array, Object };
    Type type = Type::Null;
    bool boolVal = false;
    int64_t intVal = 0;
    double doubleVal = 0.0;
    std::string strVal;
    std::vector<JsonValue> arrVal;
    std::map<std::string, JsonValue> objVal;

    const JsonValue* Get(const std::string& key) const;
    std::optional<std::string> AsString() const;
    std::optional<int64_t> AsInt() const;
    std::optional<uint64_t> AsUInt() const;
    std::optional<bool> AsBool() const;
};

std::optional<JsonValue> ParseJson(std::string_view input, std::string* errorOut = nullptr);
std::string JsonEscape(std::string_view value);

std::string WideToUtf8(std::wstring_view value);
std::wstring Utf8ToWide(std::string_view value);
std::string IsoUtcNow();
std::optional<int64_t> ParseIso8601UtcEpochSeconds(std::string_view iso);

InstallLayout ResolveInstallLayout(const fs::path& overrideInstallRoot = {}, const fs::path& overrideLocalRoot = {});
std::wstring CurrentUserSidString();
uint32_t CurrentWindowsBuildNumber();

class UserUpdateLock {
public:
    UserUpdateLock() = default;
    ~UserUpdateLock();
    UserUpdateLock(const UserUpdateLock&) = delete;
    UserUpdateLock& operator=(const UserUpdateLock&) = delete;

    bool Acquire(DWORD timeoutMs = 15000);
    void Release();

private:
    HANDLE mutex_ = nullptr;
};

void LogReleaseEvent(const fs::path& logFile, const char* source, const char* event,
                     const std::string& detail = {}, unsigned long code = 0) noexcept;

std::string Sha256HexBytes(const void* data, size_t size);
std::string Sha256HexFile(const fs::path& file);
std::optional<std::vector<uint8_t>> Base64UrlDecode(std::string_view input);

// Verifies an ECDSA P-256 / SHA-256 raw 64-byte (r||s) signature against a 64-byte raw (X||Y) public key.
bool VerifyEcdsaP256Raw(const void* message, size_t messageLen,
                        const uint8_t* signature64, size_t sigLen,
                        const uint8_t* pubKeyXY64, size_t pubKeyLen);

// Validates Authenticode signature via WinVerifyTrust.
bool VerifyAuthenticode(const fs::path& file, std::string* errorOut = nullptr);

// Validates HTTPS URL + host allowlist (or localhost HTTP when explicitly permitted).
bool IsAllowedDownloadUrl(std::string_view url, const std::vector<std::string>& allowedHosts,
                          bool allowLocalHttp, std::string* errorOut = nullptr);

// Fetches UTF-8 text from URL via WinHTTP.
std::string HttpGetText(std::string_view url, const std::vector<std::string>& allowedHosts,
                        bool allowLocalHttp, std::string* errorOut = nullptr);

// Downloads file with ETag + Range resume, progress callback, cancellation, and SHA-256 verification.
bool DownloadFileWithResume(std::string_view url, const fs::path& destination,
                            const DownloadOptions& options, std::string* errorOut = nullptr);

// Parses signed feed envelope or plain releases JSON and validates schema, signature, expiry, and OS build.
std::optional<ReleaseFeed> ParseAndVerifyReleaseFeed(std::string_view jsonText,
                                                     const FeedVerifyOptions& options,
                                                     std::string* errorOut = nullptr);

// Deterministic rollout eligibility check (0..99 < rolloutPercentage).
bool IsEligibleForRollout(std::wstring_view userSid, std::string_view version,
                          uint64_t releaseSequence, int rolloutPercentage);

std::string ReadUpdateChannel(const InstallLayout& layout);
std::optional<CurrentInstallState> ReadCurrentState(const InstallLayout& layout);
bool WriteCurrentStateAtomic(const InstallLayout& layout, const CurrentInstallState& state);

std::optional<PendingUpdateState> ReadPendingUpdate(const InstallLayout& layout);
bool WritePendingUpdateAtomic(const InstallLayout& layout, const PendingUpdateState& pending);
void ClearPendingUpdate(const InstallLayout& layout);

std::vector<uint64_t> ReadFailedSequences(const InstallLayout& layout);
bool RecordFailedSequence(const InstallLayout& layout, uint64_t sequence);
bool IsSequenceFailed(const InstallLayout& layout, uint64_t sequence);

// Validates relative path safety (no traversal, no drive letters, no leading slashes).
bool IsSafeRelativePath(const fs::path& rel);
// Rejects symlinks / junctions / reparse points in a directory tree.
bool ContainsReparsePoint(const fs::path& root);

// Stages an incremental component update by reusing matching SHA-256 components and downloading only changed ones.
IncrementalStageResult StageIncrementalComponents(const InstallLayout& layout,
                                                  const ReleaseFeed& feed,
                                                  const DownloadOptions& downloadOptions,
                                                  std::string* errorOut = nullptr);

// Atomically activates pending update into versions/<seq> and updates current.json (preserving previousSequence).
bool ActivatePendingUpdate(const InstallLayout& layout, std::string* errorOut = nullptr);

// Records that the currently running sequence reached healthy workbench_ready state.
bool RecordVersionHealthy(const InstallLayout& layout, uint64_t sequence);

// Checks if current version failed repeatedly before healthy state and rolls back to previousSequence.
bool CheckAndRollbackIfUnhealthy(const InstallLayout& layout, int maxUnverifiedAttempts = 2,
                                 std::string* rollbackReasonOut = nullptr);

// Queries local workbench /bohack/api/desktop/busy over loopback WinHTTP to avoid restarting during active render.
bool QueryWorkbenchBusy(unsigned port, const std::wstring& internalToken, bool* busyOut, std::string* reasonOut = nullptr);

} // namespace jiangjie::release
