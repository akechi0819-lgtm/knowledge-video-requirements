#include "release_engine.h"

#include <bcrypt.h>

#include <array>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
namespace fs = std::filesystem;
using namespace jiangjie::release;

void Require(bool cond, const char* msg) {
    if (!cond) throw std::runtime_error(msg);
}

std::string Base64UrlEncode(const uint8_t* data, size_t len) {
    static constexpr char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) v |= static_cast<uint32_t>(data[i + 1]) << 8;
        if (i + 2 < len) v |= static_cast<uint32_t>(data[i + 2]);
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        if (i + 1 < len) out.push_back(tbl[(v >> 6) & 0x3F]);
        if (i + 2 < len) out.push_back(tbl[v & 0x3F]);
    }
    return out;
}

void TestEcdsaSignedFeed() {
    // Generate ephemeral P-256 keypair via CNG and verify signed feed envelope end-to-end
    BCRYPT_ALG_HANDLE ecAlg = nullptr;
    Require(BCryptOpenAlgorithmProvider(&ecAlg, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) == 0, "open ECDSA P-256");
    BCRYPT_KEY_HANDLE key = nullptr;
    Require(BCryptGenerateKeyPair(ecAlg, &key, 256, 0) == 0, "generate P-256 key");
    Require(BCryptFinalizeKeyPair(key, 0) == 0, "finalize P-256 key");

    ULONG pubSize = 0;
    Require(BCryptExportKey(key, nullptr, BCRYPT_ECCPUBLIC_BLOB, nullptr, 0, &pubSize, 0) == 0, "export pub size");
    std::vector<uint8_t> pubBlob(pubSize);
    Require(BCryptExportKey(key, nullptr, BCRYPT_ECCPUBLIC_BLOB, pubBlob.data(), pubSize, &pubSize, 0) == 0, "export pub");
    Require(pubSize == sizeof(BCRYPT_ECCKEY_BLOB) + 64, "P-256 public blob size");
    const std::string pubB64 = Base64UrlEncode(pubBlob.data() + sizeof(BCRYPT_ECCKEY_BLOB), 64);

    const std::string payload = R"({
        "schemaVersion": 1,
        "version": "0.3.0",
        "releaseSequence": 5,
        "channel": "stable",
        "platform": "windows",
        "arch": "x64",
        "minWindowsBuild": 19045,
        "rolloutPercentage": 50,
        "publishedAt": "2026-11-26T00:00:00Z",
        "expiresAt": "2099-12-31T23:59:59Z",
        "artifacts": {
            "offline": {
                "url": "https://jiangjie.gingers.cloud/downloads/windows/x64/stable/5/Jiangjie-Setup-Offline-x64.exe",
                "fileName": "Jiangjie-Setup-Offline-x64.exe",
                "sizeBytes": 1024,
                "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            }
        }
    })";

    BCRYPT_ALG_HANDLE hashAlg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    Require(BCryptOpenAlgorithmProvider(&hashAlg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0, "open sha256");
    Require(BCryptCreateHash(hashAlg, &hash, nullptr, 0, nullptr, 0, 0) == 0, "create sha256");
    Require(BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(payload.data())), static_cast<ULONG>(payload.size()), 0) == 0, "hash");
    uint8_t digest[32]{};
    Require(BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0, "finish hash");
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(hashAlg, 0);

    ULONG sigLen = 0;
    Require(BCryptSignHash(key, nullptr, digest, sizeof(digest), nullptr, 0, &sigLen, 0) == 0 && sigLen == 64, "sig size");
    std::vector<uint8_t> sig(sigLen);
    Require(BCryptSignHash(key, nullptr, digest, sizeof(digest), sig.data(), sigLen, &sigLen, 0) == 0, "sign");
    BCryptDestroyKey(key);
    BCryptCloseAlgorithmProvider(ecAlg, 0);

    const std::string envelope = "{\"schemaVersion\":1,\"keyId\":\"test-key\",\"payload\":\"" +
                                 Base64UrlEncode(reinterpret_cast<const uint8_t*>(payload.data()), payload.size()) +
                                 "\",\"signature\":\"" + Base64UrlEncode(sig.data(), sig.size()) + "\"}";

    FeedVerifyOptions opt;
    opt.pinnedPublicKeyBase64Url = pubB64;
    opt.requireSignature = true;
    opt.minSequence = 2;
    std::string err;
    auto parsed = ParseAndVerifyReleaseFeed(envelope, opt, &err);
    Require(parsed.has_value() && parsed->signatureVerified && parsed->version == "0.3.0" && parsed->releaseSequence == 5,
            "verify valid signed feed");

    // Tampered signature must fail
    sig[0] ^= 0xFF;
    const std::string badEnv = "{\"schemaVersion\":1,\"keyId\":\"test-key\",\"payload\":\"" +
                               Base64UrlEncode(reinterpret_cast<const uint8_t*>(payload.data()), payload.size()) +
                               "\",\"signature\":\"" + Base64UrlEncode(sig.data(), sig.size()) + "\"}";
    Require(!ParseAndVerifyReleaseFeed(badEnv, opt, &err).has_value(), "reject tampered ECDSA signature");

    // Sequence downgrade must fail
    opt.minSequence = 10;
    Require(!ParseAndVerifyReleaseFeed(envelope, opt, &err).has_value(), "reject sequence rollback");
}

void TestExpiryAndRolloutAndPaths() {
    const std::string expired = R"({
        "schemaVersion": 1, "version": "0.2.1", "releaseSequence": 3,
        "channel": "stable", "platform": "windows", "arch": "x64",
        "expiresAt": "2020-01-01T00:00:00Z"
    })";
    FeedVerifyOptions opt;
    opt.checkExpiry = true;
    std::string err;
    Require(!ParseAndVerifyReleaseFeed(expired, opt, &err).has_value(), "reject expired feed");

    // Rollout determinism
    Require(!IsEligibleForRollout(L"S-1-5-21-100", "0.3.0", 5, 0), "0% rollout ineligible");
    Require(IsEligibleForRollout(L"S-1-5-21-100", "0.3.0", 5, 100), "100% rollout eligible");
    int hits = 0;
    for (int i = 0; i < 200; ++i) {
        if (IsEligibleForRollout(L"S-1-5-21-" + std::to_wstring(i), "0.3.0", 5, 50)) ++hits;
    }
    Require(hits > 60 && hits < 140, "50% rollout roughly balanced");

    // Path safety
    Require(IsSafeRelativePath(L"runtime/node/node.exe"), "normal relative path");
    Require(!IsSafeRelativePath(L"../escape.exe"), "reject parent traversal");
    Require(!IsSafeRelativePath(L"C:\\Windows\\evil.dll"), "reject drive path");
    Require(!IsSafeRelativePath(L"/abs/path"), "reject leading slash");

    // URL allowlist
    const std::vector<std::string> hosts = {"jiangjie.gingers.cloud"};
    Require(IsAllowedDownloadUrl("https://jiangjie.gingers.cloud/downloads/feed.json", hosts, false, &err), "allowlisted https");
    Require(!IsAllowedDownloadUrl("http://jiangjie.gingers.cloud/downloads/feed.json", hosts, false, &err), "reject non-https");
    Require(!IsAllowedDownloadUrl("https://evil.example/feed.json", hosts, false, &err), "reject unknown host");
    Require(IsAllowedDownloadUrl("http://127.0.0.1:8080/feed.json", hosts, true, &err), "allow local http test mode");
}

void TestActivationAndRollback(const fs::path& root) {
    const InstallLayout layout = ResolveInstallLayout(root / L"install ' 中文", root / L"local");
    fs::create_directories(layout.versionsDir / L"1");
    { std::ofstream(layout.versionsDir / L"1" / L"marker.txt") << "v1"; }

    CurrentInstallState v1;
    v1.channel = "stable";
    v1.version = "0.2.1";
    v1.releaseSequence = 1;
    v1.healthySequence = 1;
    Require(WriteCurrentStateAtomic(layout, v1), "write initial current.json");

    // Stage v2
    const fs::path staging2 = layout.versionsDir / L"2.staging";
    fs::create_directories(staging2);
    { std::ofstream(staging2 / L"marker.txt") << "v2"; }

    PendingUpdateState p2;
    p2.channel = "stable";
    p2.version = "0.2.2";
    p2.releaseSequence = 2;
    p2.stagingDir = WideToUtf8(staging2.native());
    p2.mode = "incremental";
    Require(WritePendingUpdateAtomic(layout, p2), "write pending-update.json");

    std::string err;
    Require(ActivatePendingUpdate(layout, &err), "activate v2");
    Require(!ReadPendingUpdate(layout).has_value(), "pending cleared after activation");

    auto cur = ReadCurrentState(layout);
    Require(cur.has_value() && cur->releaseSequence == 2 && cur->previousSequence == 1 && cur->healthySequence == 1,
            "current switched to v2 with previousSequence=1");

    // Simulate 2 failed launches without reaching healthy state -> automatic rollback to v1
    cur->unverifiedAttempts = 2;
    Require(WriteCurrentStateAtomic(layout, *cur), "simulate 2 unverified attempts");
    std::string reason;
    Require(CheckAndRollbackIfUnhealthy(layout, 2, &reason), "rollback triggered");

    auto after = ReadCurrentState(layout);
    Require(after.has_value() && after->releaseSequence == 1 && after->healthySequence == 1, "rolled back to v1");
    Require(IsSequenceFailed(layout, 2), "bad sequence recorded in failed-sequences.json");

    // Healthy recording works
    Require(RecordVersionHealthy(layout, 1), "record v1 healthy");
}

} // namespace

int main() {
    try {
        Require(Sha256HexBytes("", 0) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty sha256");
        TestEcdsaSignedFeed();
        TestExpiryAndRolloutAndPaths();

        const fs::path root = fs::current_path() / (L"release-test-" + std::to_wstring(GetCurrentProcessId()));
        fs::remove_all(root);
        fs::create_directories(root);
        TestActivationAndRollback(root);
        fs::remove_all(root);

        std::cout << "release_engine_test PASSED\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "release_engine_test FAILED: " << ex.what() << "\n";
        return 1;
    }
}
