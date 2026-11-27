# 讲界视频工坊 Windows 正式发布人类运维与合规上线手册

更新于 2026-11-26。本手册列出所有**无法由代码仓库自动完成、必须由发布负责人/运维工程师人工执行**的外部基础设施、证书合规、安全软件白名单及灰度运维标准操作步骤（SOP）。

> 与工程自动化脚本的关系：
> - 自动化构建、纯净机门禁验收与产物发布由 [`.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml) 全自动执行。
> - 技术构建细节与本地命令参考见 [`docs/win-release-runbook.md`](win-release-runbook.md)。

---

## 一、官网全站强制 HTTPS（TLS 1.2/1.3）与 CDN 断点续传配置

客户端在线引导安装器（`Jiangjie-Setup-Online-x64.exe`）与后台更新助手（`JiangjieUpdater.exe`）在生产模式下**严格拒绝非 HTTPS 连接**，并强依赖强 `ETag`、`Content-Length` 与 HTTP `206 Partial Content` 实现断点续传。

### 1.1 源站 Nginx 强制 HTTPS 与 TLS 加固

在生产服务器部署 [`scripts/jiangjie-preview.nginx.conf`](../scripts/jiangjie-preview.nginx.conf) 时，必须确认并补充以下 TLS 安全配置：

1. **80 端口强制 301 跳转 HTTPS**（仅保留 ACME 证书续期路径 `/.well-known/acme-challenge/`）。
2. **仅启用 TLS 1.2 与 TLS 1.3**（禁用 TLS 1.0/1.1）：
   ```nginx
   ssl_protocols TLSv1.2 TLSv1.3;
   ssl_prefer_server_ciphers on;
   ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
   ssl_session_cache shared:SSL:10m;
   ssl_session_timeout 1d;
   add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
   ```
3. **自动续期守护**：确认 `jiangjie-cert-renew.timer` 已启用并运行，证书距到期少于 30 天时自动续期并重载 Nginx。

### 1.2 CDN 与对象存储（S3 / Cloudflare R2 / 阿里云 OSS）关键配置

若在源站或对象存储前接入 CDN（推荐 Cloudflare / 阿里云 CDN / 腾讯云 EdgeOne），必须逐项核对：

| 配置项 | 必须设置值 | 原因与故障后果 |
| --- | --- | --- |
| **强制 HTTPS 回源 & 跳转** | 开启（最低 TLS 1.2，支持 TLS 1.3） | 客户端校验 HTTPS Allowlist，降级 HTTP 会导致下载立即中止。 |
| **Range 回源（分片回源）** | **必须开启** | 否则 CDN 忽略客户端 `Range: bytes=...` 头返回 200 全量文件，导致弱网断点续传失效。 |
| **二进制禁开自动压缩** | 对 `.exe`、`.tar.gz`、`.blockmap`、`.dmg` **禁用** Gzip/Brotli | CDN 二次压缩会改写 `Content-Length` 并剥离强 `ETag`，直接触发 `206` 续传校验失败。 |
| **缓存规则（不可变目录）** | `/downloads/windows/x64/*/<seq>/*` → 遵循源站 `public, max-age=31536000, immutable` | 版本序列号不可变，最大化边缘命中率、降低源站带宽成本。 |
| **缓存规则（动态清单）** | `*.json`、`*.yml`、`*.yaml`、`SHA256SUMS.txt`、通道级 `Jiangjie-Setup-Online-x64.exe` → `no-cache`（或 TTL=0 回源验证 ETag） | 确保紧急回滚、灰度比例调整与新版本发布在分钟级生效。 |
| **跨站下载跳转域名** | 仅允许 `jiangjie.gingers.cloud` 或已在客户端 Allowlist 注册的 HTTPS 域名 | 防止开放重定向或域名不在客户端信任白名单导致下载被拒。 |

### 1.3 上线前 HTTPS 与断点续传自检命令

发布前在公网终端执行以下命令，所有断言必须通过：

```bash
# 1. 验证 HTTP 自动 301 跳转 HTTPS
curl -sI http://jiangjie.gingers.cloud/ | grep -iE "^HTTP/|^location:"

# 2. 验证 TLS 1.2 / 1.3 正常握手，且拒绝 TLS 1.1
curl -sI --tlsv1.2 --tls-max 1.3 https://jiangjie.gingers.cloud/downloads/release-manifest.json | head -n 10

# 3. 验证动态清单返回 Cache-Control: no-cache 与正确 Content-Type
curl -sI https://jiangjie.gingers.cloud/downloads/windows/x64/stable/feed.json | grep -iE "^HTTP/|cache-control|content-type|etag"

# 4. 验证不可变离线包支持强 ETag、Accept-Ranges 与 HTTP 206 Range 断点续传
OFFLINE_URL="https://jiangjie.gingers.cloud/downloads/windows/x64/stable/<SEQ>/Jiangjie-Setup-Offline-x64.exe"
curl -sI "$OFFLINE_URL" | grep -iE "^HTTP/|accept-ranges|content-length|etag|cache-control"
curl -sI -H "Range: bytes=0-1023" "$OFFLINE_URL" | grep -iE "^HTTP/2 206|^HTTP/1.1 206|content-range|content-length"
```

---

## 二、代码签名证书申请与 GitHub Secrets / Variables 配置清单

Windows 正式版必须完成**先内后外**全链路 Authenticode 签名（内层自有 PE → NSIS 卸载器 → 外层在线/离线安装包），并附加 RFC 3161 时间戳（SHA-256），且严格禁止 UPX 加壳。

### 2.1 方案 A：微软 Azure Trusted Signing（推荐，SmartScreen 声誉建立最快）

1. **前置资质**：中国或海外合法注册企业实体（需营业执照、邓白氏编码 D-U-N-S 或企业公户/域名验证材料，通常要求实体存续满 3 年，视微软最新审核政策为准）。
2. **Azure 控制台配置步骤**：
   - 在 Azure Portal 创建 **Trusted Signing Account**（推荐区域：`East US` / `West US 2` / `North Europe`）。
   - 提交 **Identity Validation（Public Trust）** 组织实名验证，等待微软审核通过（一般 3–7 个工作日）。
   - 在账户下创建 **Certificate Profile**，类型选择 `Public Trust`。
   - 创建 Microsoft Entra ID **App Registration（Service Principal）**（推荐配置 GitHub OIDC Federated Credential 或 Client Secret），并在 Trusted Signing Account 的 IAM 中授予角色：**`Trusted Signing Certificate Profile Signer`**。
3. CI 流水线会在 `sign_mode=azure-trusted-signing` 时自动从 NuGet 拉取 `Microsoft.Trusted.Signing.Client`（含 `Azure.CodeSigning.Dlib.dll`），调用 `scripts/windows/sign.ps1` 并使用 `http://timestamp.acs.microsoft.com` 打时间戳。

### 2.2 方案 B：企业 EV 代码签名证书 / 云 HSM（DigiCert / Sectigo / GlobalSign）

1. 向合规 CA（DigiCert KeyLocker、Sectigo Cloud HSM、GlobalSign Atlas 等）采购 **EV Code Signing Certificate**（自 2023 年 6 月起，CA/B Forum 要求私钥必须存放于 FIPS 140-2 Level 2+ 硬件令牌或云 HSM，优先选购支持 CI/CD API 的云 HSM 方案）。
2. `scripts/windows/sign.ps1` 的 `signtool-ev` 模式支持三种对接方式（三选一）：
   - **云 HSM CSP/KSP**：配置 `WIN_SIGN_CSP` + `WIN_SIGN_KEY_CONTAINER` + `WIN_SIGN_CERT_FILE`（需在自托管 Runner 安装对应 HSM 客户端驱动）。
   - **证书库指纹**：配置 `WIN_SIGN_CERT_SHA1`（40 位十六进制指纹，适用于已导入系统证书库的自托管 Runner）。
   - **Base64 PFX**：配置 `WIN_SIGN_PFX_BASE64` + `WIN_SIGN_PFX_PASSWORD`（仅适用于受控私有签名或过渡测试，CI 会在临时目录落盘并在 `always()` 步骤中强制销毁）。

### 2.3 生成 ECDSA P-256 更新清单签名密钥对（与代码签名证书分离）

在离线安全机器上执行一次：

```powershell
node scripts/windows/generate-release-manifest.mjs keygen `
  --private-out feed-signing-key.pem `
  --public-out feed-pubkey.b64url
```

- 将 `feed-signing-key.pem` 完整内容存入 GitHub Secret：`JIANGJIE_FEED_SIGNING_KEY_PEM`（切勿提交到 Git！）。
- 将 `feed-pubkey.b64url` 单行内容存入 GitHub Repository Variable：`JIANGJIE_RELEASE_PUBKEY_B64`，CI 构建 C++ 客户端时会自动编译进内置公钥用于验签 `feed.json`。

### 2.4 GitHub Repository Secrets 与 Variables 完整清单

路径：GitHub 仓库 → **Settings → Secrets and variables → Actions**（建议为 `stable` 正式发布配置受保护的 GitHub Environment 与人工审批）。

#### A. Actions Secrets（敏感凭据，永不打印到日志）

| Secret 变量名 | 适用场景 | 必填性 | 说明 |
| --- | --- | --- | --- |
| `JIANGJIE_FEED_SIGNING_KEY_PEM` | 更新清单验签 | **正式发布必填** | ECDSA P-256 PKCS#8 PEM 私钥，用于签名 `feed.json`。 |
| `AZURE_CLIENT_ID` | Azure Trusted Signing | 方案 A 必填 | Azure Entra ID 应用（Service Principal）Client ID。 |
| `AZURE_TENANT_ID` | Azure Trusted Signing | 方案 A 必填 | Azure 租户 Tenant ID。 |
| `AZURE_SUBSCRIPTION_ID` | Azure Trusted Signing | 方案 A 必填 | Azure 订阅 ID。 |
| `AZURE_SIGNING_ENDPOINT` | Azure Trusted Signing | 方案 A 必填 | 如 `https://eus.codesigning.azure.net/`。 |
| `AZURE_SIGNING_ACCOUNT` | Azure Trusted Signing | 方案 A 必填 | Trusted Signing Account 名称。 |
| `AZURE_SIGNING_CERT_PROFILE` | Azure Trusted Signing | 方案 A 必填 | Public Trust Certificate Profile 名称。 |
| `AZURE_SIGNING_DLIB_PATH` | Azure Trusted Signing | 可选 | 自托管 Runner 预装 `Azure.CodeSigning.Dlib.dll` 路径；留空时 CI 自动从 NuGet 下载。 |
| `WIN_SIGN_CERT_SHA1` | EV / HSM (`signtool-ev`) | 方案 B 三选一 | 40 位十六进制证书指纹（自托管签名机）。 |
| `WIN_SIGN_PFX_BASE64` | EV / 测试 PFX (`signtool-ev`) | 方案 B 三选一 | Base64 编码的 `.pfx` 证书文件（CI 临时解码并在结束后销毁）。 |
| `WIN_SIGN_PFX_PASSWORD` | EV / 测试 PFX (`signtool-ev`) | 配对 PFX 必填 | `.pfx` 文件解密口令。 |
| `WIN_SIGN_CSP` | 云 HSM (`signtool-ev`) | 方案 B 三选一 | 云 HSM 加密服务提供程序名称（配合下两项使用）。 |
| `WIN_SIGN_KEY_CONTAINER` | 云 HSM (`signtool-ev`) | 配合 CSP 必填 | HSM 密钥容器名称。 |
| `WIN_SIGN_CERT_FILE` | 云 HSM (`signtool-ev`) | 配合 CSP 必填 | 公钥证书 `.cer` 文件路径。 |
| `RELEASE_S3_BUCKET` | S3 / Cloudflare R2 分发 | 可选（配即启用） | 目标存储桶名称（配置后自动同步不可变版本目录与动态清单）。 |
| `RELEASE_S3_ACCESS_KEY_ID` | S3 / Cloudflare R2 分发 | 启用 S3 时必填 | 仅授予目标桶写权限的 Access Key ID。 |
| `RELEASE_S3_SECRET_ACCESS_KEY` | S3 / Cloudflare R2 分发 | 启用 S3 时必填 | 对应 Secret Access Key。 |
| `RELEASE_S3_ENDPOINT` | Cloudflare R2 / 兼容 S3 | R2 必填 / AWS 可留空 | 如 `https://<account-id>.r2.cloudflarestorage.com`。 |
| `RELEASE_S3_REGION` | S3 / Cloudflare R2 分发 | 可选 | 默认 `auto`（AWS S3 填实际区域如 `ap-southeast-1`）。 |
| `OSS_BUCKET` | 阿里云 OSS 分发 | 可选（配即启用） | 阿里云 OSS Bucket 名称。 |
| `OSS_ENDPOINT` | 阿里云 OSS 分发 | 启用 OSS 时必填 | 如 `oss-cn-shanghai.aliyuncs.com`。 |
| `OSS_ACCESS_KEY_ID` | 阿里云 OSS 分发 | 启用 OSS 时必填 | 仅授予目标 Bucket 写权限的 RAM 子账号 AccessKey ID。 |
| `OSS_ACCESS_KEY_SECRET` | 阿里云 OSS 分发 | 启用 OSS 时必填 | 对应 RAM AccessKey Secret。 |

#### B. Actions Variables（非敏感配置）

| Variable 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `JIANGJIE_RELEASE_PUBKEY_B64` | `""`（开发测试跳过验签） | ECDSA P-256 64 字节原始公钥（base64url），正式发布**必须配置**。 |
| `JIANGJIE_FEED_KEY_ID` | `jiangjie-release-2026` | 写入 `feed.json` 信封的公钥标识，用于后续密钥轮换追踪。 |
| `JIANGJIE_MEMBER_URL` | `https://jiangjie.gingers.cloud/desktop-membership` | 编译进客户端的正式会员服务 HTTPS 地址。 |
| `JIANGJIE_MEMBER_AGENT_API` | `""`（Chat Completions） | 可选 `openai-responses` 切换桌面 Agent 协议。 |
| `JIANGJIE_DOWNLOADS_BASE_URL` | `https://jiangjie.gingers.cloud/downloads` | 写入 `feed.json` / `release-manifest.json` 的公网下载根 URL。 |
| `WIN_SIGN_TIMESTAMP_URL` | 按模式自动选择 | RFC 3161 时间戳地址（Azure 默认 `http://timestamp.acs.microsoft.com`，EV 默认 `http://timestamp.digicert.com`）。 |

---

## 三、国内主流安全软件与微软白名单预提交流程

即使已完成 EV / Azure Trusted Signing 代码签名，首次发布的全新应用由于初始下载声誉较低，仍可能被 Windows SmartScreen 或国产杀毒软件拦截。**建议在正式推广前提前 3–5 个工作日，以首版已签名 `beta` 安装包完成全部四家预提交。**

### 3.1 提交前准备材料包（统一复用）
- 已签名且通过 `signtool verify /pa /v` 校验的双轨安装包：
  - `Jiangjie-Setup-Online-x64.exe`
  - `Jiangjie-Setup-Offline-x64.exe`
- 对应的 `SHA256SUMS.txt`、内层签名二进制清单（`Jiangjie.exe`、`JiangjieApp.exe`、`JiangjieUpdater.exe`、`BohackCredentialStore.exe`、`Uninstall.exe`）。
- 企业营业执照扫描件、软件著作权登记证书（如有）、官网域名备案信息（`jiangjie.gingers.cloud`）、产品功能简介（说明本软件为 Per-User 免 UAC 桌面视频创作工具、不注入系统进程、不修改系统 PATH、不使用 UPX 加壳）。

### 3.2 四大安全厂商提交流程

1. **Microsoft Security Intelligence（Windows Defender & SmartScreen）**
   - 入口：`https://www.microsoft.com/en-us/wdsi/filesubmission`
   - 步骤：使用 Microsoft 账号登录 → 选择 **Software developer** → 上传已签名的 `Jiangjie-Setup-Online-x64.exe`（若离线包超单文件上传上限，可先提交在线引导器与 `Jiangjie.exe`/`JiangjieApp.exe`，或通过企业提交通道）→ 产品选择 `Microsoft Defender SmartScreen` / `Microsoft Defender Antivirus` → 填写「Incorrectly detected as malware/PUA or SmartScreen warning on newly signed legitimate desktop installer」→ 提交并跟踪工单直至状态变为 `Not malware / Clean`。
   - 复测：使用 Edge / Chrome 从正式 HTTPS 网址下载安装包（确保文件带有 NTFS Zone.Identifier Mark-of-the-Web），在全新未登录过开发账号的 Windows 11 虚拟机双击运行，确认无红色/蓝色 SmartScreen 阻断。

2. **360 开放平台（360 安全卫士 / 360 杀毒）**
   - 入口：`https://open.soft.360.cn/`（软件安全认证中心）
   - 步骤：注册并完成企业开发者实名认证（提交营业执照与对公/法人核验）→ 进入「软件提交认证」→ 填写软件名称「讲界视频工坊」、官网地址与版本号 → 上传已签名的在线引导器与离线完整包 → 备注说明本安装包采用标准 Unicode NSIS 与原生 Win32 静态编译，仅安装至 `%LOCALAPPDATA%\Programs\Jiangjie` 且内含合法开源运行时（Node.js / Python / FFmpeg / Chromium / WebView2）→ 等待 1–3 个工作日审核通过进入白名单。

3. **腾讯电脑管家（腾讯安全开放平台）**
   - 入口：`https://open.guanjia.qq.com/`（及样本预检 `https://habo.qq.com/`）
   - 步骤：完成企业主体认证 → 在「软件白名单 / 误报申诉」提交 `Jiangjie-Setup-Online-x64.exe` 与 `Jiangjie-Setup-Offline-x64.exe` 的下载链接及 SHA-256 → 附上数字签名主体与企业资质 → 审核通过后在装有最新版腾讯电脑管家的 Windows 11 虚拟机中实测下载、安装、首次启动与成片导出全程无弹窗拦截。

4. **火绒安全（火绒误报申诉与开发者通道）**
   - 入口：`https://www.huorong.cn/`（火绒安全社区「误报反馈」板块或官方客服邮件通道）
   - 步骤：提交软件包正式 HTTPS 下载链接、SHA-256、签名信息以及（如有触发时）火绒拦截日志/截图 → 明确说明软件行为（本地回环 `127.0.0.1` 工作台、内置 Playwright/Chromium 离屏渲染与 FFmpeg 视频合成、关闭时通过 Windows Job Object 回收全部子进程）→ 通常 24 小时内响应并合入病毒库白名单。

---

## 四、首次发布灰度放量、监控巡检与紧急回滚标准操作步骤（SOP）

### 4.1 首次试跑与预发布验收（T-1）

1. **CI 无发布试跑（干跑验证流水线与纯净机门禁）**：
   - 在 GitHub Actions 手动触发 **`Windows Desktop Build, Verify & Release`**（`channel=beta`, `enable_signing=false`, `publish_release=false`）。
   - 确认 `build-windows` 与 `verify-clean-windows` 均 100% 通过，下载 `e2e-report-*` 核对 `e2e-verify-report.json` 中 5 项门禁均为 `passed: true`。
2. **真证书 Beta 发布与干净 VM 人工验收**：
   - 配齐第二章 GitHub Secrets 后，触发 `channel=beta`, `enable_signing=true`, `publish_release=true`（或推送 `v0.2.1-beta.1` 标签）。
   - 在一台全新无开发工具的 Windows 11 x64（及候选 Windows 10 22H2）标准用户虚拟机中，从 `https://jiangjie.gingers.cloud/#downloads` 走真实浏览器下载：
     - 验证 SmartScreen / Defender / 360 / 火绒无异常阻断；
     - 验证免 UAC 安装、快捷方式创建与自动拉起；
     - 使用真实测试邀请码完成会员注册、登录、首次平台模型推理、新建项目并成功导出成片；
     - 验证关闭重开后 DPAPI 凭据自动恢复，且项目历史完整保留；
     - 验证「帮助 → 导出诊断包」与设置页诊断包不包含任何明文密钥或 Token。

### 4.2 分阶段灰度放量（10% → 50% → 100%）

自动更新助手 `JiangjieUpdater.exe` 对每个用户 Windows SID 计算确定性哈希并取模 `[0, 99]`，只有桶号 `< rolloutPercentage` 的客户端才会拉取新版本，保证同一用户不会在升级与不升级之间反复抖动。

| 阶段 | 放量比例 | 观察窗口 | 放行条件（全部满足方可进入下一阶段） |
| --- | --- | --- | --- |
| **Stage 1：种子灰度** | `10%`（或先 `beta` 通道） | 24 小时 | 安装成功率 ≥ 98%；启动 `workbench_ready` 成功率 ≥ 99%；无 P0 崩溃/白屏/成片失败；杀软误报率为 0。 |
| **Stage 2：半量验证** | `50%` | 24–48 小时 | 组件增量复用正常（A→B 带宽节省符合预期）；无自动回滚激增；会员服务与 TTS 上游延迟/错误率平稳。 |
| **Stage 3：全量推送** | `100%` | 持续监控 | 更新 `release-manifest.json` 与 `stable` 通道 `feed.json` 为 `rolloutPercentage: 100`，归档本次发布记录与 `SHA256SUMS.txt`。 |

### 4.3 常态化监控与巡检清单

- **每日巡检**：
  - 官网与下载节点 HTTPS 拨测（200 / 206 Range / 证书剩余有效期 > 30 天）。
  - 会员服务（`jiangjie-membership-beta.service`）进程存活、SQLite 定时备份状态与上游模型/TTS 余额。
  - 若启用 `JIANGJIE_DESKTOP_CRASH_DSN`，检查 Sentry 崩溃趋势与 `desktop_failure` 错误码分布。
- **每周 / 周期维护**：
  - **`feed.json` 有效期刷新**：`feed.json` 默认有效期 `expiresDays = 14` 天。若超过 10 天未发新版本，需使用**相同的 `releaseSequence` 和文件哈希**延长 `expiresAt` 并重新签名上传 `feed.json`，防止客户端因清单过期拒绝检查更新。
  - **开源合规维护**：确保官网 `#downloads` 折叠区的 FFmpeg GPL 对应源码包下载链接持续可访问，并与当前发行的 FFmpeg 8.0 二进制版本严格一致。

### 4.4 紧急止血与回滚 SOP

发现严重缺陷（启动失败、大面积成片异常、崩溃率飙升或安全软件误报突发）时，按以下分级在 **15 分钟内**执行止血：

1. **Level 1：立即暂停放量（1 分钟内止血）**
   - 保持当前 `releaseSequence` 与产物哈希不变，将 `rolloutPercentage` 修改为 `0`，使用私钥重新签名 `feed.json` 并原子覆盖 `/downloads/windows/x64/stable/feed.json`（及 `latest.yml`）。
   - 若官网下载页也需回退，立即将 `/downloads/release-manifest.json` 与通道兜底文件 `/downloads/windows/x64/stable/Jiangjie-Setup-Online-x64.exe` 原子切回上一已验证稳定版本，并刷新 CDN 动态清单缓存。
   - **红线警告：绝不可直接调低 `feed.json` 中的 `releaseSequence`**（客户端内置防降级攻击校验，会直接拒绝低于本机已信任序列号的清单！）。

2. **Level 2：全网回滚到上一稳定版本（客户端平滑修复）**
   - 确认问题版本已对部分用户生效时，取出上一稳定版的已验证构建产物，分配一个**严格大于问题版本的全新 `releaseSequence`**（例如问题版为 `seq=105`，回滚版设为 `seq=106`），重新生成清单与签名并全量发布（`rolloutPercentage=100`）。
   - 对于已升级但无法启动到 `workbench_ready` 的客户端，`Jiangjie.exe` 会在连续 2 次启动失败后**自动本地回滚至 `previousSequence`** 并将故障序列号记入 `failed-sequences.json`，无需用户手动重装。

3. **Level 3：签名私钥/证书紧急轮换**
   - **Authenticode 证书泄露**：立即联系 CA / Azure 吊销受损证书；按 ADR-04 策略先以有效新证书签发紧急更新包，并在微软/国内安全厂商同步报备新发布者身份。
   - **Feed ECDSA 私钥轮换**：先发一版同时信任旧公钥与新公钥的客户端更新，待存量客户端覆盖率达标后，再切换 GitHub Secret `JIANGJIE_FEED_SIGNING_KEY_PEM` 与 `JIANGJIE_FEED_KEY_ID`。
