#include "release_engine.h"
#include "build_config.h"

#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <string>

namespace {
namespace fs = std::filesystem;
using namespace jiangjie::release;

struct UpdaterOptions {
    bool check = false;
    bool stage = false;
    bool apply = false;
    bool quiet = false;
    bool relaunch = false;
    bool allowLocalHttp = false;
    DWORD waitPid = 0;
    std::string feedUrl;
    std::string channel;
    fs::path installRoot;
};

void ParseArgs(UpdaterOptions& opts) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return;
    for (int i = 1; i < argc; ++i) {
        const std::wstring arg = argv[i];
        auto next = [&]() -> std::wstring { return (i + 1 < argc) ? std::wstring(argv[++i]) : L""; };
        if (arg == L"--check") opts.check = true;
        else if (arg == L"--stage") opts.stage = true;
        else if (arg == L"--apply") opts.apply = true;
        else if (arg == L"--quiet") opts.quiet = true;
        else if (arg == L"--relaunch") opts.relaunch = true;
        else if (arg == L"--allow-local-http") opts.allowLocalHttp = true;
        else if (arg == L"--wait-pid") opts.waitPid = static_cast<DWORD>(std::wcstoul(next().c_str(), nullptr, 10));
        else if (arg == L"--feed-url") opts.feedUrl = WideToUtf8(next());
        else if (arg == L"--channel") opts.channel = WideToUtf8(next());
        else if (arg == L"--install-dir") opts.installRoot = fs::path(next());
    }
    LocalFree(argv);
}

std::string ResolveChannelFeedUrl(const UpdaterOptions& opts, const std::string& channel) {
    if (!opts.feedUrl.empty()) return opts.feedUrl;
    std::string url = JIANGJIE_UPDATE_FEED_URL;
    const std::string stableSeg = "/stable/";
    if (channel == "beta") {
        const auto pos = url.find(stableSeg);
        if (pos != std::string::npos) url.replace(pos, stableSeg.size(), "/beta/");
    }
    return url;
}

int RunApply(const UpdaterOptions& opts, const InstallLayout& layout, const fs::path& logFile) {
    if (opts.waitPid != 0) {
        HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, opts.waitPid);
        if (parent) {
            WaitForSingleObject(parent, 15000);
            CloseHandle(parent);
        }
    }

    UserUpdateLock lock;
    if (!lock.Acquire(15000)) {
        LogReleaseEvent(logFile, "updater", "apply_lock_timeout");
        return 2;
    }

    std::string err;
    if (!ActivatePendingUpdate(layout, &err)) {
        LogReleaseEvent(logFile, "updater", "apply_failed", err, 3);
        return 3;
    }

    LogReleaseEvent(logFile, "updater", "apply_succeeded");
    if (opts.relaunch) {
        const fs::path launcher = layout.installRoot / L"Jiangjie.exe";
        std::error_code ec;
        if (fs::is_regular_file(launcher, ec)) {
            ShellExecuteW(nullptr, L"open", launcher.c_str(), nullptr, layout.installRoot.c_str(), SW_SHOWNORMAL);
            LogReleaseEvent(logFile, "updater", "relaunched");
        }
    }
    return 0;
}

int RunCheckAndStage(const UpdaterOptions& opts, const InstallLayout& layout, const fs::path& logFile) {
    UserUpdateLock lock;
    if (!lock.Acquire(5000)) {
        LogReleaseEvent(logFile, "updater", "check_lock_busy");
        return 11;
    }

    const std::string channel = opts.channel.empty() ? ReadUpdateChannel(layout) : opts.channel;
    const std::string feedUrl = ResolveChannelFeedUrl(opts, channel);
    const auto current = ReadCurrentState(layout);
    const uint64_t currentSeq = current ? current->releaseSequence : static_cast<uint64_t>(JIANGJIE_RELEASE_SEQUENCE);

    DownloadOptions dlOpts;
    dlOpts.allowLocalHttp = opts.allowLocalHttp;
    std::string err;
    const std::string rawFeed = HttpGetText(feedUrl, dlOpts.allowedHosts, opts.allowLocalHttp, &err);
    if (rawFeed.empty()) {
        LogReleaseEvent(logFile, "updater", "feed_fetch_failed", err, 12);
        return 12;
    }

    FeedVerifyOptions verifyOpts;
    verifyOpts.pinnedPublicKeyBase64Url = JIANGJIE_RELEASE_PUBKEY_B64;
    verifyOpts.requireSignature = !verifyOpts.pinnedPublicKeyBase64Url.empty();
    verifyOpts.checkExpiry = true;
    verifyOpts.minSequence = currentSeq;

    const auto feed = ParseAndVerifyReleaseFeed(rawFeed, verifyOpts, &err);
    if (!feed) {
        LogReleaseEvent(logFile, "updater", "feed_verify_failed", err, 13);
        return 13;
    }

    if (feed->releaseSequence <= currentSeq) {
        LogReleaseEvent(logFile, "updater", "up_to_date", feed->version);
        return 10;
    }

    if (IsSequenceFailed(layout, feed->releaseSequence)) {
        LogReleaseEvent(logFile, "updater", "skip_failed_sequence", std::to_string(feed->releaseSequence));
        return 10;
    }

    if (!IsEligibleForRollout(CurrentUserSidString(), feed->version, feed->releaseSequence, feed->rolloutPercentage)) {
        LogReleaseEvent(logFile, "updater", "outside_rollout_bucket",
                        feed->version + " (" + std::to_string(feed->rolloutPercentage) + "%)");
        return 10;
    }

    if (const auto existingPending = ReadPendingUpdate(layout)) {
        if (existingPending->releaseSequence == feed->releaseSequence) {
            LogReleaseEvent(logFile, "updater", "already_staged", feed->version);
            return 0;
        }
    }

    if (!opts.stage) {
        LogReleaseEvent(logFile, "updater", "update_available", feed->version);
        return 0;
    }

    // Prefer component-level incremental download + reuse
    if (!feed->components.empty()) {
        auto res = StageIncrementalComponents(layout, *feed, dlOpts, &err);
        if (res.staged) {
            LogReleaseEvent(logFile, "updater", "incremental_staged",
                            "v=" + feed->version + " downloaded=" + std::to_string(res.downloadedBytes) +
                                " reused=" + std::to_string(res.reusedBytes));
            return 0;
        }
        LogReleaseEvent(logFile, "updater", "incremental_fallback_offline", err, 14);
    }

    // One-time clean fallback to full offline installer if components unavailable or failed
    if (feed->offline) {
        const auto& offline = *feed->offline;
        const fs::path dst = layout.downloadsDir /
                             (offline.fileName.empty() ? (L"Jiangjie-" + Utf8ToWide(feed->version) + L"-Offline.exe")
                                                       : Utf8ToWide(offline.fileName));
        dlOpts.expectedSize = offline.sizeBytes;
        dlOpts.expectedSha256 = offline.sha256;
        if (!DownloadFileWithResume(offline.url, dst, dlOpts, &err)) {
            LogReleaseEvent(logFile, "updater", "offline_fallback_failed", err, 15);
            return 15;
        }
        PendingUpdateState pending;
        pending.channel = feed->channel;
        pending.version = feed->version;
        pending.releaseSequence = feed->releaseSequence;
        pending.notesUrl = feed->releaseNotesUrl;
        pending.mode = "offline-installer";
        pending.installerPath = WideToUtf8(dst.native());
        pending.installerSha256 = offline.sha256;
        pending.downloadedBytes = offline.sizeBytes;
        pending.stagedAt = IsoUtcNow();
        if (!WritePendingUpdateAtomic(layout, pending)) {
            LogReleaseEvent(logFile, "updater", "pending_write_failed", {}, 16);
            return 16;
        }
        LogReleaseEvent(logFile, "updater", "offline_staged", feed->version);
        return 0;
    }

    LogReleaseEvent(logFile, "updater", "no_downloadable_payload", err, 17);
    return 17;
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    UpdaterOptions opts;
    ParseArgs(opts);
    const InstallLayout layout = ResolveInstallLayout(opts.installRoot);
    const fs::path logFile = layout.logsDir / L"updater.log";

    if (opts.apply) return RunApply(opts, layout, logFile);
    if (opts.check || opts.stage) return RunCheckAndStage(opts, layout, logFile);
    return 1;
}
