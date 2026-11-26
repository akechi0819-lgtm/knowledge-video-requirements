# 讲界视频工坊 Windows 发布与运维手册（Runbook）

更新于 2026-11-26。本手册面向发布工程师与 CI 运维，涵盖双轨安装包构建、代码签名配置、组件增量发布、官网清单上线及异常回滚流程。外部基础设施、证书申请、安全软件白名单与首次灰度上线请配合 [`docs/release-ops-checklist.md`](release-ops-checklist.md) 与 [`.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml) 执行。

## 1. 产物架构总览

| 产物 | 路径 / 文件名 | 定位与约束 |
| --- | --- | --- |
| **在线引导安装器（主推）** | `Jiangjie-Setup-Online-x64.exe` | 原生 C++20 Win32 + WinHTTP，静态 CRT，实测约 **367 KB**（< 10 MiB 约束）。Per-User 免 UAC，支持 ETag + HTTP Range 断点续传、SHA-256 校验、失败一键重试、静默调用离线包并自动启动应用。 |
| **离线完整安装包（兜底）** | `Jiangjie-Setup-Offline-x64.exe` | Unicode NSIS 3.x（LZMA 固实压缩，严禁 UPX），`RequestExecutionLevel user`，安装至 `%LOCALAPPDATA%\Programs\Jiangjie` 版本化目录，写 `HKCU\...\Uninstall\Jiangjie`，卸载默认保留 `%APPDATA%\Jiangjie`。 |
| **稳定入口与更新助手** | `Jiangjie.exe` + `JiangjieUpdater.exe` | `Jiangjie.exe` 负责读取 `current.json`、原子激活待生效更新及连续启动失败自动回滚；`JiangjieUpdater.exe` 负责后台组件级增量下载与校验。 |
| **多通道更新清单** | `feed.json`、`releases.win.json`、`latest.yml` / `beta.yml`、`*.blockmap` | 支持 `stable` / `beta` 通道、ECDSA P-256/SHA-256 签名信封、`rolloutPercentage` 百分比灰度与组件/块级差分校验。 |
| **官网下载聚合清单** | `release-manifest.json` | 供 `https://jiangjie.gingers.cloud/#downloads`（`frontend/public/site/downloads.js`）动态读取，绝不在前端写死版本号。 |

## 2. 本地无证书构建与验证（`WIN_SIGN_MODE=none`）

```powershell
# 1. 装配 Windows x64 运行时（Node / Python / FFmpeg / 生产依赖）
pwsh -NoProfile -File scripts/windows/bundle-runtime.ps1

# 2. 编译 Win32 + WebView2 桌面壳、Launcher、Updater 与在线引导器
pwsh -NoProfile -File scripts/build-win-desktop.ps1 -Generator 'Visual Studio 17 2022'

# 3. 打包双轨安装包与增量清单（本地无证书模式）
$env:WIN_SIGN_MODE = 'none'
pwsh -NoProfile -File scripts/windows/package-installer.ps1 `
  -Version 0.2.1 `
  -ReleaseSequence 2 `
  -Channel stable `
  -RolloutPercentage 100
```

> 若需生成全新的 ECDSA P-256 更新清单签名密钥对：
> ```powershell
> node scripts/windows/generate-release-manifest.mjs keygen --private-out feed-signing-key.pem --public-out feed-pubkey.b64url
> ```
> 将 `feed-pubkey.b64url` 内容通过 `-DJIANGJIE_RELEASE_PUBKEY_B64=...` 注入客户端构建，私钥仅存于 CI Secret (`JIANGJIE_FEED_SIGNING_KEY_PEM`)。

## 3. 生产代码签名配置（`scripts/windows/sign.ps1`）

签名顺序严格遵守**先内后外**，且内置反加壳门禁（检测到 `UPX0`/`UPX1`/`UPX!` 立即中止）：
1. 内层自有 PE：`Jiangjie.exe`、`JiangjieApp.exe`、`JiangjieUpdater.exe`、`BohackCredentialStore.exe`
2. NSIS 双阶段生成的 `Uninstall.exe`
3. 外层安装包：`Jiangjie-Setup-Offline-x64.exe`、`Jiangjie-Setup-Online-x64.exe`
4. 全部签名并 `signtool verify /pa /v` 通过后，最后计算 SHA-256 与生成发布清单。

### 模式 A：微软 Azure Trusted Signing（推荐）
```powershell
$env:WIN_SIGN_MODE = 'azure-trusted-signing'
$env:AZURE_SIGNING_ENDPOINT = 'https://eus.codesigning.azure.net/'
$env:AZURE_SIGNING_ACCOUNT = '<your-account-name>'
$env:AZURE_SIGNING_CERT_PROFILE = '<your-cert-profile>'
$env:AZURE_SIGNING_DLIB_PATH = 'C:\tools\Azure.CodeSigning.Dlib.dll'
```

### 模式 B：传统 EV 证书 / 云 HSM（`signtool-ev`）
```powershell
$env:WIN_SIGN_MODE = 'signtool-ev'
$env:WIN_SIGN_TIMESTAMP_URL = 'http://timestamp.digicert.com'
# 三选一：
# 1) 本地证书库指纹：
$env:WIN_SIGN_CERT_SHA1 = '<40位十六进制指纹>'
# 2) 云 HSM CSP/KSP：
# $env:WIN_SIGN_CSP = '<Provider Name>'; $env:WIN_SIGN_KEY_CONTAINER = '<Container>'; $env:WIN_SIGN_CERT_FILE = '<cert.cer>'
# 3) PFX 文件：
# $env:WIN_SIGN_PFX_PATH = '<path.pfx>'; $env:WIN_SIGN_PFX_PASSWORD = '<secret>'
```

## 4. 服务器与 CDN 发布顺序（原子上线）

部署路径对齐 `scripts/jiangjie-preview.nginx.conf`（站点根目录 `/opt/jiangjie-preview/site`）：

1. **上传不可变版本目录**（`Cache-Control: immutable`，支持 HTTP Range）：
   - `/opt/jiangjie-preview/site/downloads/windows/x64/<channel>/<releaseSequence>/Jiangjie-Setup-Online-x64.exe`
   - `/opt/jiangjie-preview/site/downloads/windows/x64/<channel>/<releaseSequence>/Jiangjie-Setup-Offline-x64.exe`
   - `/opt/jiangjie-preview/site/downloads/windows/x64/<channel>/<releaseSequence>/Jiangjie-Setup-Offline-x64.exe.blockmap`
   - `/opt/jiangjie-preview/site/downloads/windows/x64/<channel>/<releaseSequence>/components/*.tar.gz`
2. **校验静态文件可访问性与 Range 响应**：
   - `curl -I https://jiangjie.gingers.cloud/downloads/windows/x64/stable/<seq>/Jiangjie-Setup-Offline-x64.exe`（应返回 `200` + `Accept-Ranges: bytes` + `ETag`）
   - `curl -I -H "Range: bytes=0-1023" ...`（应返回 `206 Partial Content`）
3. **原子切换动态清单**（`Cache-Control: no-cache`）：
   - 更新同源兜底链接 `/downloads/windows/x64/<channel>/Jiangjie-Setup-Online-x64.exe`
   - 原子替换 `/downloads/windows/x64/<channel>/feed.json`、`releases.win.json`、`latest.yml`（或 `beta.yml`）
   - 原子替换 `/downloads/release-manifest.json`（官网 `#downloads` 自动生效，无需改 HTML/JS）

## 5. 灰度发布与紧急回滚

- **分阶段灰度**：先将 `rolloutPercentage` 设为 `10`（基于用户 SID 的确定性哈希分桶），观察崩溃日志与诊断反馈无异常后逐步调至 `50` → `100`。
- **客户端自动回滚**：新版本若连续 2 次未能启动到 `workbench_ready`（未写入 `healthySequence`），`Jiangjie.exe` 自动回滚至 `previousSequence` 并将故障序列写入 `failed-sequences.json`，防止死循环。
- **服务端紧急止血**：不要直接降低 `releaseSequence`（客户端会拒绝防降级攻击）；应以更高 `releaseSequence` 重新发布经验证的稳定版本，或将问题版本的 `rolloutPercentage` 置为 `0` 后重新签名 `feed.json`。
