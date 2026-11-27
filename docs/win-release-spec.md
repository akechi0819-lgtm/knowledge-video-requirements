# 讲界视频工坊 Windows 发布规格书

Phase 1 只读审计于 2026-11-25（新加坡时间）完成。以下「决策」是 Phase 2–6 的实施规格。

## 1. 基线与范围

- **施工基线**为本工作区的 `repo2`，`main` 的 `c01c4cf33ce483f376ba782387dd43685b0b7f10`。下文路径默认相对该 Git 根目录。该工作树是稀疏检出，`desktop/`、`.agents/`、`.project-skills/`、`patches/`、`tests/` 和 `交付/` 等通过 Git 树和对象读取。后续会话应从此提交准备完整施工树，并保留现有工作树中的用户修改。
- **发布与验收基线**为 Git tag `v0.2.0-beta.2`（`d068c9a84c28e27b3809fe57a4f10acd4307f109`）及其同级解压目录 `../knowledge-video-requirements-0.2.0-beta.2/`。同级 `../Jiangjie-macOS-arm64.dmg` 为本地现存文件，本阶段未挂载或验证其构建出处与签名。同级 `../Windows部署与客户视角验收交接.md` 和快照内本地输出是此前验收证据。
- **代码地图**。原生桌面入口和启动页在 `desktop/`，构建、签名、网关和 Nginx 在 `scripts/`，工作台壳内 UI 与 API 在 `dsh-workbench-fix/dsh-base/packages/bohack-blueprint/`，会员服务器在 `membership/`，视频引擎与样例在 `video-kit/`，站点在 `frontend/public/site/`。旧需求入口见 `start-requirement-dialogue.sh`、`requirement_dialogue/chat.py`、`dsh/requirement-dialogue.patch.yml` 和 `scene_retrieval.py`。Web 预览镜像入口为 `preview.Dockerfile` 和 `preview-worker.Dockerfile`。

## 2. 仓库现状

### 2.1 macOS Apple Silicon

- `desktop/main.swift` 导入 AppKit、WebKit、Darwin、Security，以 Swift 构建原生窗口，内嵌 WKWebView。窗口先显示随包启动页，再启动 `scripts/desktop-dsh.sh`，从以 `dsh web: ` 开头的输出提取 loopback 端口并打开 `/bohack/`。数据目录用文件锁保证单实例，进程组和后代在退出时回收。文件选取、下载和 Keychain helper 也由壳实现。随包 Chromium 走 Playwright 截帧链，桌面 UI 走 WKWebView。底层是 Swift 原生壳，仓库树无 Electron/Tauri 构建入口。
- `scripts/build-desktop.sh` 强制 Darwin arm64，用 `xcrun swiftc -O -target arm64-apple-macos14.0` 编译，组装临时目录中的 `讲界.app`。脚本 SHA-256 校验锁定的 Node `24.22.1`、独立 CPython `3.12.14+20260901` 和 Chromium Mac_Arm `1749205` 下载，使用 `desktop/python-constraints.txt` 安装 wheel，用 npm pack 打包本地插件，并对 DSH 与 video-kit 各执行 `npm ci --omit=dev`。图标、启动页与媒体来自 `desktop/Jiangjie.icns`、`desktop/startup.html` 和 `frontend/public/site/media/`。 `desktop/Info.plist` 的 App 版本为 `0.2.1`、build 为 `2`。见 `README.md` 的构建与分发段。
- `scripts/build-desktop-codecs.sh` 锁定 FFmpeg、x264、LAME、pkgconf，构建 arm64 的 `ffmpeg` 与 `ffprobe`，检查 H.264/AAC、MP3、PNG、质检过滤器和动态链接。构建缓存分 `.runtime/desktop-downloads` 与 `.runtime/desktop-codec-cache`，App staging 使用 `TMPDIR` 或 `/tmp`。
- `scripts/sign-desktop.sh` 从内部 Mach-O、原生模块和嵌套 bundle 到外层签名，用 `desktop/runtime-entitlements.plist` 给所需运行时设置权限。构建后运行 `scripts/package-desktop.sh <app> <新.dmg>`，创建带 Applications 链接及编解码器对应源码的 UDZO DMG。正式流程为 Developer ID Application、DMG 时间戳、公证、staple、Gatekeeper 检查。相关输入为 `JIANGJIE_SIGN_IDENTITY`（默认 ad hoc）、`JIANGJIE_NOTARY_PROFILE`（正式包需要）、`JIANGJIE_MEMBER_URL` 和 `JIANGJIE_MEMBER_AGENT_API`（可写入 plist）。
- `scripts/desktop-runtime.sh` 给子进程设置包内绝对路径和受控 PATH。`scripts/desktop-dsh.sh` 在用户目录初始化 profile、指向已打包插件、保留用户内容，设 `WORKBENCH_PORT=0` 与 `JIANGJIE_DESKTOP_DSH_PATCH`，再由 `dsh-workbench.sh` 使用 `--profile workbench --patch … --port 0 --no-open --host 127.0.0.1` 启动。若用户已有 `dsh/workbench-model.env`，shell 启动脚本会读取。两个基线的 Git 树均未发现 `.github/workflows/`、GitLab CI、Azure Pipelines、Jenkinsfile 或 CircleCI 入口。仓库内的可核验流程为上述本地脚本，服务器 CI 配置与 DMG 出处待发布方提供证据。

### 2.2 Windows 源码工作台与 DSH

- `dsh-workbench-fix/dsh-base/部署说明-队友机.md` 的源码流程为在 `dsh-base` 下执行 `npm.cmd ci`、`.\setup-profiles.cmd`、`node ..\..\video-kit\setup.mjs`。其中 `setup-profiles.cmd` 使用 `mklink /J`，分别把 `.dsh-home/profiles/bohack/node_modules/@bohack/blueprint` 和 `.dsh-home/profiles/workbench/node_modules/@bohack/blueprint` 指向 `packages/bohack-blueprint`。两个 profile 的 `package.json` 把同一插件列为本地文件依赖及 Cordis bundle，插件的 `package.json` 指定其 patch。链接用于按 profile 解析本地插件。现脚本跳过已经存在的路径，未验证目标是否正确，末尾也没有逐条汇总 junction 创建失败。
- `dsh-workbench.cmd` 以自身目录为 CWD，调用 `dsh.cmd workbench %*` 并传回退出码。它没有自带参数解析、默认端口或桌面环境变量。明确传 `--host 127.0.0.1 --port 3099` 是现有检验方法。部署文档还描述了默认 3099 和 `WORKBENCH_PORT`，但从 Windows 两个 CMD 文件看不到该变量转成 CLI 参数。可执行探测以 Phase 2 的锁定 CLI 为准。Bash 版 `dsh-workbench.sh` 显式读取 `WORKBENCH_PORT`（空值默认 3109）。
- `dsh.cmd` 把 `DSH_HOME` 无条件设为同级 `.dsh-home`，检查 Node 最低 `24.9.0`，若特定用户的本机 `NODE24` 目录存在则前置到 PATH，否则沿用当前 PATH。执行同级 `node_modules/.bin/dsh.cmd`，用固定 `%TEMP%\bohack-dsh-ver.txt` 检查 `0.2.2-rc.1`，参数原样透传。Windows 发布壳应直接执行打包的 Node 和 DSH JS bin。现锁的 `node_modules/@deepseek-ai/dsh` 条目声明 `bin.dsh=lib/bin.js`，staging 时用包清单核对并写入运行时布局。
- `dsh-workbench-fix/dsh-base/package.json` 精确锁定 `@deepseek-ai/dsh@0.2.2-rc.1`。两基线共享的 `package-lock.json` 为 lockfile v3，724 个 HTTPS `resolved` 全部指向 `registry.npmmirror.com`，含完整性摘要。仅设置 npm 默认 registry 无法当作绝对镜像 URL 已迁移的证据。当前 `video-kit/package-lock.json` 的 302 个、`membership/package-lock.json` 的 21 个 HTTPS `resolved` 均指向 `registry.npmjs.org`。须在原依赖版本和 integrity 可核验的前提下切换 DSH 构建源，首次安装不运行 npm。

### 2.3 视频运行时与火锅验收

- `video-kit/requirements.txt` 当前为 `edge-tts>=7.0`、`numpy>=1.24`、`Pillow>=10.0`、`playwright>=1.65.2`、`scipy>=1.18.1`。beta.2 只含前三项。当前 `video-kit/package.json` 含 `playwright-core`，另有固定的 Remotion、React 等依赖。beta.2 仅有 `playwright-core`。Windows 正式产物须以当前锁定实测为准。Node 与 Python Playwright 属于两个依赖入口，分别核对 driver 和浏览器兼容。
- `video-kit/setup.mjs` 是开发机安装入口。它在 kit 根执行 `npm install --no-audit --no-fund`，用 `VIDEO_SETUP_PYTHON` 或系统 Python 创建 `WORK/modules/video/.venv`，再用 venv 的 Python 执行 pip requirements。最后打印工具解析和 `ffmpeg -version`。它不会安装外部 FFmpeg、ffprobe 或浏览器，FFmpeg 探测失败仅输出提示。正式包由构建机预装所有运行依赖。
- `video-kit/WORK/modules/video/style.mjs` 优先读取 `VIDEO_FFMPEG`、`VIDEO_FFPROBE`、`VIDEO_BROWSER`、`VIDEO_PYTHON` 和 `VIDEO_PLAYWRIGHT`。源码默认从 PATH 找 FFmpeg，探测 Edge/Chrome/Chromium 的已知位置，从 venv 或 PATH 选择 Python。该目录的 `render.mjs` 用 Playwright Chromium driver 启动选中的可执行文件并截图，调用 FFmpeg 的 `libx264`、`aac` 编码。`ffmpeg.mjs` 执行 ffprobe、检查音视频流、生成 concat 目录清单并合片。`pipeline.mjs` 调用 Python 混音 `finish_bgm.py` 与 `qa_windows.py`，输出 `quality-notes.json`。`finish_bgm.py` 为上游 BGM 脚本显式把 FFmpeg 目录前置至子进程 PATH。
- `tts_driver.py` 分发到同目录 `tts.py`（联网 Edge TTS，和浏览器是否安装无关）、`tts_sapi.py`（`sapi` 或 `sapi:<音色>`）、`tts_api.py`（会员/自配 speech 或 MiMo）和 macOS `tts_say.py`。SAPI 当前以 `powershell.exe -NoProfile -Command` 调用 `System.Speech`，先找指定音色、再找中文音色，生成 WAV 和 SpeakProgress 词边界，再经 `libmp3lame` 编码、ffprobe 定时。仓库文档称 SAPI 无词级时间戳，当前源码实际以系统事件生成近似词级时间。是否出现有效边界由系统音色与实测确定。
- **四段冒烟**。依据 `video-kit/README.md` 与 `video-kit/examples/hotpot.v1.json`，在 kit 根执行以下命令。现有环境先设置所需的 `VIDEO_*` 绝对路径，输出使用新目录。待确认的 `examples/hotpot.v3.json` 可验证确认闸门和显式预览。发布 smoke 将同一脚本的 `node` 替换为包内绝对路径。

  ```powershell
  node WORK/modules/video/pipeline.mjs examples/hotpot.v1.json --out out/win-smoke --voice sapi
  node WORK/modules/video/verify.mjs out/win-smoke/mapping.json
  ```

- **验证语义**。原入口读 `WORK/tools/blueprint.mjs` 的确认闸门，单段配音/渲染/编码抛错会在 concat 前停止。准备单入口 `--prepared` 要求状态「准备制作」、唯一合法段号、已确认旁白、真实场景文件与显式输出目录。`verify.mjs` 解码起/中/末帧，校验分段区间正值和连续性（0.05 秒容差）、clip 实测时长、总覆盖（0.25 秒）、旁白窗至少 −45 dB、段首纯人声轨至多 −50 dB，并合并质检 notes。发布门槛同时断言退出码 0、stdout 有 `VERIFY PASS`、`verify-report.json` 的 `pass: true`、预期段数和 MP4 H.264/AAC。当前 `VERIFY WARN` 通常仍退出 0。缺段文件与显式抽帧硬错误或未捕获异常才非零。
- **两种火锅样例**。本机快照的 `video-kit/out/windows-smoke-20261125-133613/{run-log.md,verify-report.json,mapping.json,final.mp4}` 记录四段，24.633 秒、1280×720、30 fps、H.264/AAC、Huihui SAPI，`pass: true`。这是预制场景独立冒烟。另有 `README.md` 指定的 90 秒定稿制作单，入口是 `video-kit/scripts/hotpot-scenes.mjs --input 交付/没有美洲火锅会少些什么_90秒/production.json --output <场景目录>`，再走 `pipeline.mjs --prepared <场景目录>/production.json --out <成片目录> --voice …` 和同一 verifier。套餐验收须另跑会员登录后的新项目出片。

### 2.4 Git 子模块实际用途

下表 pin 以 `.gitmodules` 和 Git 树的 `160000` 条目为准。前三项在 beta.2 与当前 HEAD 共用同一 pin。beta.2 的 ZIP 中三处目录为空，`repo2` 稀疏工作树也未填充这些路径。

| 子模块路径 | 锁定 commit | 实际用途 |
| --- | --- | --- |
| `.project-skills/andy-vibe-knowledge` | `c3a13a85f7cc560e5d396f063baecea4b2748e1e` | `.agents/skills/andy-vibe-knowledge` → `skills/vibe-knowledge`，`.agents/skills/ai-teardown` → `skills/ai-teardown`。worker COPY。Mac 构建显式复制 LICENSE。 |
| `.project-skills/deepseek-opus-motion-skill` | `dd0e05264a6cd7ad714c0899e17157584290bad4` | `.agents/skills/motion-design-prompt-generator` → 同名目录。worker COPY。Mac 构建显式复制 LICENSE。 |
| `.project-skills/vibe-knowledge-film` | `62d51508aad00003dc6209afa80c4b5dc540de59` | `.agents/skills/vibe-knowledge-film` 指向根目录。`preview-worker.Dockerfile` 分路径复制脚本、引擎、参考和示例。当前 `scripts/build-desktop.sh` 跳过该 Skill，`scripts/install-external-skills.sh` 按 pin 从原仓装到用户工作区。 |
| `.project-skills/huashu-art-motion` | `a97c45018d46e950d56d61981138e08f4e092909` | 当前 HEAD 新增，`.agents/skills/huashu-art-motion` 指向根目录，供 Skill 发现和 Mac staging。 |
| `.project-skills/vibe-know--skill` | `74cd27291a1e1c1725f5c58867313d69f044cd67` | 当前 HEAD 新增，`.agents/skills/vibe-know--skill` 指向根目录。当前 Mac staging 跳过，外部安装脚本按 pin 获取。 |

链接对象在 Git 中为 `120000`。Windows 的 `core.symlinks=false` 会把链接检出成文本，Windows staging 应按批准的路径表展开到真实目录，并按文件裁定再分发范围。beta.2 的 `scripts/build-desktop.sh` 明确将 `vibe-knowledge-film` 列入 staging，当前 HEAD 才开始排除并提供外部安装流程。`patches/vibe-knowledge-sibling-skill.patch` 在树中存在，未发现当前桌面或预览构建入口调用它。视频基础档播放的是 `video-kit/vendor/vibe-knowledge/` 的 BGM 与工具，遵循同目录 `LICENSE`、`NOTICE.md` 和 `THIRD_PARTY.md`，可通过空子模块的四段冒烟。当前原版 Skill 入口另依赖 DSH 的 Bash 能力、类 Unix 目录、工具与包，详见 `lib/skill-runtime.js`、`lib/skill-process.js`、`lib/original-video-job.js`（均相对上述插件目录）。

### 2.5 会员、邀请码与模型凭据

- 源码入口默认调用 `dsh-workbench-fix/dsh-base/packages/bohack-blueprint/lib/web.js` 的 `GET /bohack/api/membership`，在未安装会员对象时返回 `{ enabled: false }`。同路由 POST 报不支持。插件 `index.js` 在 `JIANGJIE_DESKTOP_WORKSPACE` 存在时打开 desktop，或由插件配置启用 desktop，然后实例化 `lib/membership.js`。multiuser 分支会先返回。desktop 下即使未设置 URL，未登录 GET 也可返回 `enabled: true, account: null`，注册/登录才因缺地址失败。
- 真正可用的正式包需要在启动时配置 desktop workspace、`JIANGJIE_MEMBER_URL=https://jiangjie.gingers.cloud/desktop-membership` 及 `desktop/agent.patch.yml` 对应的 provider 路由和本地 marker。Mac 从环境或 plist 读取地址。`JIANGJIE_MEMBER_AGENT_API=openai-responses` 切换桌面 Agent 到 Responses，默认 Chat Completions。线上 Nginx/systemd 配置见 `scripts/jiangjie-preview.nginx.conf` 与 `scripts/jiangjie-membership-beta.service`。服务端需要 HTTPS origin 与前缀匹配、强会话密钥、持久化并备份 SQLite、有效 Chat/TTS 上游配置。桌面客户无需填写供应商密钥，平台密钥留在服务端。真实支付尚待接入，详见 `membership/README.md` 和 `membership/server.mjs`。
- 工作台的会员动作由插件 `web/index.html` 和 `lib/membership.js` 发起。注册 POST `/api/auth/sign-up/email` 带 `X-Invite-Code`，登录 POST `/api/auth/sign-in/email`。请求带正确 Origin，接收 `set-auth-token`，后续用 Bearer。 `membership/invite.mjs` 生成邀请码，`membership/server.mjs` 校验并以 SQLite reservation 防重复，注册成功消耗、失败释放。客户端现在把令牌、邮箱、来源和模式存于 `<workspace 同级>/membership/account.json`。会员初次平台 AI 调用开片，赠片优先，后续请求复用授权，同片完成后结算。自配 API（BYOK）与会员模式可切换，已有活动制作时保护原授权。
- `MISSING_CREDENTIAL` 是 DSH 供应商凭据解析错误。快照中已安装的 `dsh-workbench-fix/dsh-base/node_modules/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js` 显示默认 `DEEPSEEK_API_KEY` 凭据引用，先查 DSH credentials service，服务未注入时回看启动环境，无可用值则抛出该码。源码 `dsh-workbench-fix/dsh-base/DSH-VERSION-RUNBOOK.md` 说明 Settings → Models 存到当前 `DSH_HOME/.credentials.yaml`。插件 `lib/engine.js` 将需求会话的供应商失败码转为「需求模型请求失败（…）」。 `web/index.html` 再显示需求助手不可用。此前源码测试在首次需求消息遇到此错误。正式会员模式验证本地 marker、平台授权与 proxy 路由，不将它作为提示消费者自行配置 DeepSeek 的依据。

### 2.6 发布站点

- 官网静态首页源文件是 `frontend/public/site/index.html`，媒体在 `frontend/public/site/media/`。部署样例 `scripts/jiangjie-preview.nginx.conf` 从 `/opt/jiangjie-preview/site` 提供首页，`/bohack/` 交给预览网关，`/desktop-membership/` 指向会员服务。`frontend/app/page.tsx` 是占位页。两个基线的静态首页未发现下载区、`#downloads` 或 DMG 链接，仓库可追踪的 Mac 下载入口是 `README.md` 的 GitHub Release 链接。
- 同级验收交接记录线上 `/bohack/` 当时 302 到 `/#downloads`。本次公网浏览工具未能读取首页或 beta.2 Release 内容，线上下载区的实际部署源码仍需 Phase 6 对照。Phase 1 不把部署记录推断为当前线上事实。§4 的下载清单是拟建接口。

## 3. 架构决策记录

### ADR-01 原生壳与打包运行时

**决策**。Windows 用 C++ Win32 + WebView2 对齐 macOS 的「原生壳 + 内嵌 WebView + 本地 DSH + 独立截图浏览器」。首发目标为仍在服务期的 Windows 11 x64 桌面版本。Windows 10 22H2 x64（含 ESU 环境）作为额外兼容通道，只有通过全部安装、WebView2 ACL、截图、原生模块及升级回归后才发布对应支持声明。ARM64 独立发布通道须等 Node addon、Python wheel、Chromium 和编解码器全链验证。WebView2 采用包内 Fixed Version，预先固定 SDK 和 runtime，显式指定绝对目录和用户数据目录。Playwright 另用固定修订的可再分发 Chromium。固定版浏览器安全修订通过本产品更新。包体增加和 Win10 AppContainer 目录 ACL 是选择成本。

**启动契约**。稳定入口 `Jiangjie.exe` 定位已激活版本。原生壳以标准用户运行，按用户 SID 做单实例，启动受控的 Node/DSH 子进程，先放入可回收的 Windows Job Object，再继续运行。只绑定 `127.0.0.1` 临时端口，等待工作台健康与本次实例身份确认，限定 WebView 导航到本次工作台。将关闭窗口、退出、启动超时、异常退出与重启均纳入进程树回收。首发时增加随机进程内会话令牌、准确的 Host/Origin 检查与本地路由鉴别，限制浏览器、脚本和其他站点对工作台的访问。保留用户主动的文件选择和导出。WebView2、Node、Python、Chromium、FFmpeg、ffprobe、DSH、依赖 DLL 和工作台资源由构建打包。选定原版 Skill 可用的 Shell 和工具链也由构建提供。传递绝对 exe 路径、结构化参数和只对子进程生效的私有 PATH。每个工具入口按各自的 cwd 执行。

**数据契约**。路径用 Windows Known Folders 解析。应用和安装/更新进程只访问当前用户的三类位置。

| 位置 | 内容与生命周期 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\Jiangjie\` | 稳定 Launcher、更新助手、卸载器、`current.json` 和 `versions\<releaseSequence>\`。版本根放资源与运行时，运行时按只读对待。同卷落盘、验证完成后原子激活，保留上一版。 |
| `%APPDATA%\Jiangjie\` | `dsh\`、`workspace\threads\`、`membership\`、用户设置与项目。正式安装支持原位升级、保留项目和可恢复的迁移。已有源码/旧版数据提供明确导入，不隐式覆盖。 |
| `%LOCALAPPDATA%\Jiangjie\` | `logs\`、`cache\`、`webview2\`、`skill-runtime\`、下载缓存与安装/更新日志。工作进程的临时媒体留存按限额清理。项目已保存文件仍在用户数据或用户选定的位置。 |

Windows 用用户级 DPAPI 保护自配 API key 与会员 token，将密钥作用域绑定当前用户账户，兼容以前的明文记录时加密写成功后再移除明文。复用 `lib/settings.js` 的现有 stdin/stdout helper 协议并保持 Mac 的 Keychain 路径。会员 token 的迁移口位于 `lib/membership.js`。日志以轮转和脱敏为默认，不记录登录令牌、邀请码、用户 API key 或启动 URL 中的临时凭据。异机带来完整项目数据，但需要重新登录或配置配额来源。依据 `desktop/main.swift`、`scripts/desktop-dsh.sh` 和 `scripts/desktop-runtime.sh`。 [WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) · [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

桌面持久化复用工作台的用户目录与项目 API。 `web/desktop-projects.js` 已有导入入口，`web/local-projects.js` 的 IndexedDB 属于相应浏览器及 origin，随机端口变化后不承担桌面项目恢复职责。Phase 3 验证两次启动选择不同端口仍能打开旧项目。

### ADR-02 在线 Setup 与离线完整包

**决策**。发布原生小型 `Setup.exe`（启动器目标 ≤ 5 MiB）与完整 `Jiangjie-<version>-windows-x64-offline.exe`。在线引导器用 WinHTTP 获取签名清单，在当前用户缓存目录下载对应离线包，支持中断重试与经 ETag/长度确认的 Range 续传。校验最终长度、SHA-256、Authenticode 发布者和签名后，以等待式调用完整包的静默入口。离线包采用 Unicode NSIS，包含同一套签名清单、版本化应用和运行时，以内嵌清单离线验证，无需联网即可装好和打开应用。联网模型和会员功能依然需要网络。

引导器、安装器、卸载器、更新助手用用户级执行清单（Win32 `asInvoker`、NSIS `RequestExecutionLevel user`），只写 §3 的用户目录、HKCU 卸载项、当前用户桌面和开始菜单。双击默认安装后自动拉起一次，便于自动化的静默入口不自动拉起，由在线引导器或显式请求方在成功后拉起。使用进程退出码、阶段和日志位置传达错误。双击下载进度可取消，安装阶段静默。禁用系统写入和系统 PATH 持久化，企业策略导致不可装时明确报错。安装和更新持同一用户级锁。并发启动、断电、磁盘不足或文件占用时保留可恢复状态。卸载时默认保留用户项目和设置。依据 `scripts/package-desktop.sh`、`scripts/desktop-dsh.sh`、`dsh-workbench-fix/dsh-base/setup-profiles.cmd`。 [NSIS 用户级执行和静默选项](https://nsis.sourceforge.io/Docs/Chapter4.html)

### ADR-03 组件增量更新与回滚

**决策**。首版采用按 SHA-256 寻址的**组件增量**，以相同组件字节直接复用获得增量。组件固定为 `app`（壳、DSH、业务与静态包）、`node`、`python`、`webview2`、`chromium`、`codecs`、`skills`、`notices`。每个组件是可重现归档，含版本化逐文件清单。每次启动及运行中的定时器检查签名发布清单，跳过已验证缓存的同哈希组件，仅下载变化的组件到暂存。组件路径、文件数、体积、重解析点和重复/逃逸条目均需校验。完整包走同一落盘/激活逻辑，可在组件不可用时回退至完整下载，构建测量变更字节与全量字节。

更新准备可并行，项目渲染、导出或数据迁移执行期间不切版本。等壳退出、进程树清空后，助手验签、校验 staging 并原子切换 `current.json`，随后做新版本启动健康确认。未验证激活不写成功标记。确认失败恢复同机已验证的上一版，并记录失败序列，避免重启循环。迁移先备份，可逆或确认兼容旧版后才激活。失败时旧版本仍可启动，已下载的完整组件可重用。版本化 runtime 从正式 feed 获取。首次安装/升级均不依赖包管理器。组件验证失败最多进行一次清晰的完整包回退，然后报告可诊断错误。依据 `scripts/desktop-dsh.sh` 的 profile 分层、`scripts/desktop-runtime.sh` 的运行时分离及 `scripts/package-desktop.sh` 的完整包基线。

## 4. HTTPS 下载与更新接口（拟建）

首发域名沿用 `jiangjie.gingers.cloud`。`GET /downloads/windows/x64/stable/feed.json` 返回 `application/json`，允许 GET/HEAD，可协商 ETag，使用 `Cache-Control: no-cache`。未知平台、架构或通道返回 404。官网 `/#downloads` 显示版本、大小、系统要求、发布时间及在线/离线入口和校验值。对浏览器的在线下载名固定为 `Setup.exe`。实际产物 URL 按 releaseSequence 不可变，二进制支持 GET/HEAD、`Content-Length`、Range（206/416）、强 ETag 和 `immutable` 缓存。若并入 CDN，CDN 源与可跳转域名是发布配置中的 HTTPS allowlist，严格校验后再跟随。

- Feed 外层契约为 `schemaVersion: 1`、`keyId`、`payload`（原始 UTF-8 JSON 字节的 base64url）、`signature`（ECDSA P-256/SHA-256 的 64 字节 `r||s`，base64url）。客户端在解析业务字段前验证原始字节，公钥随 Setup 和 updater 内置。发布环境签名保管与 Authenticode 分离。轮换时先发布兼容新公钥的旧钥签名客户端，再启用新钥。全站及产物使用 HTTPS，在线校验拒绝过期、未来或低于本机已信任序列的元数据。离线包的内嵌签名使用不可变发布描述，在线 feed 的有效期只约束查询，已签离线包可长期离线安装。
- payload 字段为 `version`（SemVer）、`releaseSequence`（严格递增安全整数）、`channel`、`platform: "windows"`、`arch: "x64"`、`minWindowsBuild`（整数）、`publishedAt`、`expiresAt`（UTC ISO 8601）、`minBootstrapperVersion`、`minUpdaterVersion`、`releaseNotesUrl`、`artifacts` 和 `components`。 `artifacts` 含 `bootstrapper`、`offline` 和 `codecSource`，每项有 `url`、`fileName`、`sizeBytes`、`sha256`。PE 项附发布者提示，真正信任来自内置允许的 Authenticode 发布者及系统验证。组件条目至少含 `id`、`url`、`sizeBytes`、`unpackedSizeBytes`、`sha256`、`fileManifestSha256`。未知 schema 停止并提示升级客户端。公开清单包含公开工件与版本数据。
- 不可变的安装描述放入完整包，包含发布身份、运行时约束、组件和发布公钥对应的签名。排除全量 EXE 自身哈希，避免在嵌入后产生自引用。在线由外层 feed 绑定已签的完整 EXE。发布顺序为签组件/安装器 → 上传不可变文件、许可与源码 → 校验下载 → 原子切换 feed → 首页读取清单。移除有问题的版本用更高序列重新发布经验证的版本。本机健康失败的回滚仅使用本机已验证版本。
- 在线 feed 到期前须刷新签名。可以在同一序列延长 `expiresAt`，发布身份、文件哈希、组件和约束同时保持一致。客户端容许有限时钟偏差，对同序列内容变化或签名异常停止更新并记录诊断。
- 官网 HTML 从同源清单获得下载信息。为旧浏览器或清单异常提供同源固定入口 `/downloads/windows/x64/stable/Setup.exe`，全量离线链接经同源版本化路径提供。HTTP 错误显示可重试及离线替代入口。一次用户点击下载一次，官网不主动执行。拟接入已存在的 `frontend/public/site/index.html` 和 `scripts/jiangjie-preview.nginx.conf`。会员服务独立。

## 5. Phase 2–6 文件改造清单

下列「修改」均是基线已有路径，「新增」是拟建文件。为控制路径重复，表中 `<plugin>` 等于 `dsh-workbench-fix/dsh-base/packages/bohack-blueprint`，`<base>` 等于 `dsh-workbench-fix/dsh-base`，`<video>` 等于 `video-kit/WORK/modules/video`。

| 阶段 | 修改现有文件 | 新增文件 | 出口 |
| --- | --- | --- | --- |
| **2 运行时和 DSH** | `<base>/package-lock.json`（可验证 registry 重锁），`<base>/dsh.cmd`、`<base>/dsh-workbench.cmd`、`<base>/setup-profiles.cmd`（清理机器路径、参数与源码入口，保留源代码使用方式）。 | `scripts/build-win-runtime.ps1`、`desktop/windows/runtime.lock.json`、`desktop/windows/python-requirements.lock.txt`、`desktop/windows/runtime-layout.mjs`、`desktop/windows/start-dsh.mjs`、`scripts/smoke-win-runtime.ps1`。 | 可复建 staging：包内 Node/Python/Chromium/WebView2、DSH 与工作台健康。无宿主 PATH、可写安装树或权限前提，确定 Node 原生 addon 与 Windows wheels。 |
| **3 原生壳、会员与成片** | `<plugin>/index.js`、`lib/web.js`、`lib/settings.js`、`lib/membership.js`、`lib/production.js`、`lib/video-job.js`、`lib/original-video-job.js`、`lib/skill-runtime.js`、`lib/skill-process.js`、`web/index.html`（路径相对 `<plugin>`）。`video-kit/scripts/dsh-model.mjs`、`<video>/style.mjs`、`ffmpeg.mjs`、`render.mjs`、`tts_sapi.py`、`finish_bgm.py`（路径相对 `<video>`）。 | `desktop/windows/CMakeLists.txt`、`desktop/windows/launcher.cpp`、`desktop/windows/main.cpp`、`desktop/windows/workbench_process.cpp`、`desktop/windows/credential_store.cpp`、`desktop/windows/windows.manifest`、`desktop/windows/Jiangjie.rc`、`desktop/windows/Jiangjie.ico`、`desktop/windows/skills-win.json`、`scripts/build-win-desktop.ps1`、`scripts/build-win-codecs.ps1`、`scripts/smoke-win-video.ps1`。`<plugin>/test/windows-desktop.test.js`、`membership/test-desktop-win.mjs`。 | 新用户能在包内壳完成邀请码注册、首次模型调用、定稿、视频导出、关闭重开及凭据恢复。四段 fixture 严格通过。逐项验收首发可执行 Skill。 |
| **4 完整包、引导与签名** | `desktop/windows/CMakeLists.txt`、`desktop/windows/launcher.cpp`（二者由 Phase 3 生成）。 | `desktop/windows/release/release_engine.cpp`、`desktop/windows/release/bootstrapper.cpp`、`desktop/windows/release/installer.nsi`、`desktop/windows/release/feed.schema.json`、`scripts/package-win-desktop.ps1`、`scripts/sign-win-desktop.ps1`、`scripts/publish-win-manifest.mjs`、`scripts/smoke-win-install.ps1`。 | 标准用户双击 Setup 走 HTTPS 校验、静默全量安装、桌面快捷方式和自动启动。断网离线包、损坏/掉线/重复安装和保留数据卸载通过。 |
| **5 组件更新与回滚** | `desktop/windows/CMakeLists.txt`、`desktop/windows/launcher.cpp`、`desktop/windows/main.cpp`、`desktop/windows/release/release_engine.cpp`、`desktop/windows/release/feed.schema.json`、`scripts/package-win-desktop.ps1`、`scripts/publish-win-manifest.mjs`。 | `desktop/windows/release/updater.cpp`、`scripts/build-win-components.ps1`、`scripts/smoke-win-update.ps1`。 | A→B 组件复用与节省下载可证明。篡改、断电、文件占用、迁移与失败回滚通过，项目可续做。 |
| **6 CI、官网与发布验收** | `frontend/public/site/index.html`、`scripts/jiangjie-preview.nginx.conf`、`README.md`（Windows 下载、支持和许可证入口）。两份 `docs/win-release-*.md` 更新最终记录。 | `.github/workflows/windows-release.yml`、`frontend/public/site/downloads.js`、`docs/win-release-runbook.md`。 | CI 固定版本、校验构建依赖、签名、产出清单和许可物。在干净标准用户 VM 从 HTTPS 官网开始走下载到首次导出，人工测试 SmartScreen/Defender 和真会员 staging。发布生产 feed 需有发布权限。 |

Phase 3 以 `<plugin>/lib/skill-packages.js` 的发现流程为基础，用 `skills-win.json` 记录本包经验证的技能及其依赖。首发使用受控 Bash 和工具的 Skill 必须走测试并随包发齐。受上游再分发限制或超出已验证平台的条目，明确显示来源、依赖和支持状态。内置标准生产与手动导入项目始终走相同的桌面工作台。依赖原版脚本的测试若失败，修正后再把对应 Skill 计入首发范围。

Phase 4 的签名脚本接收明确的待签文件清单和签名配置，产生逐文件验证结果。正式模式要求自有 PE、卸载器及安装器均有已验证的时间戳和受信任的签名。构建测试可使用专用测试身份，其产物仅用于隔离验证。换证书时先在受信任产品更新中发布新旧发布者允许项，再签下一批生产工件。

## 6. 兼容性与风险矩阵

| 风险 | 代码证据 | 发布闸门 |
| --- | --- | --- |
| 中文、空格、单引号、深路径与 junction | `<base>/setup-profiles.cmd`、`video-kit/scripts/dsh-model.mjs`、`<video>/ffmpeg.mjs` 的 concat 清单、`<video>/tts_sapi.py` 的 PowerShell 参数。 | 原生 Wide API、Node/Python 参数数组、统一 UTF-8，启动/安装/卸载/更新走 Unicode 测试。覆盖含中文、空格和单引号的用户目录、工作区与素材文件，验证长路径、临时路径、路径规范化和 junction 错目标。尽量直接加载自带 DSH JS bin。确需 profile junction 时使用可重建、指向可验证的 junction。 |
| Node 24 原生模块、浏览器与 Python 混合依赖 | `<base>/package-lock.json` 中 `node-pty@1.2.0-beta.15`、`koffi@3.1.1` 和 `@deepseek-ai/dsh-subprocess-local` 有 install script。 `sharp@0.35.5`、Koffi、LibreOffice kit、ripgrep 等有 Windows x64 条目。 `video-kit/package-lock.json` 另有 esbuild 平台包。 | 原生 Windows x64 runner 构建并检查 addon ABI、ConPTY、sharp/libvips、Koffi、esbuild 和所需 DLL，强制平台可选依赖，禁止沿用 Linux/macOS 的 node_modules。Windows wheels 全量 hash 锁定，验证 NumPy、Pillow、SciPy、Python Playwright driver，逐一核验运行时 DLL 的来源与许可证。 |
| 无宿主依赖与无中文音色 | `<video>/style.mjs`、`<video>/tts_sapi.py`、`<plugin>/lib/skill-runtime.js` 的 PATH/类 Unix 前提。 | 干净 VM 移除宿主开发工具并用冲突 PATH 确认包内解析。SAPI 验收使用安装了中文系统音色的 VM，缺音色的 VM 需验证可解释提示和可用的服务端配音，客户首发默认走会员配音。中文字体须测缺字与授权。需要回退字体时随包发可再分发字体并留许可证。 |
| 固定 WebView2 与 Chromium | `desktop/main.swift`、`scripts/desktop-runtime.sh`、`<video>/render.mjs`。 | 固定版壳和独立渲染器分别验证稳定修订，Windows 10 候选环境加测 Microsoft 指定 AppContainer ACL、离线启动和受管策略。持续跟踪两种浏览器的安全更新。 [Fixed Version 部署要求](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) |
| FFmpeg GPL/LGPL 与 H.264 | `scripts/build-desktop-codecs.sh` 明确 `--enable-gpl --enable-libx264`，`<video>/style.mjs` 选 `libx264`，`scripts/package-desktop.sh` 提供源码包。 | 首发基线用独立 GPL FFmpeg/ffprobe 进程，存档确切源码、所有分发的依赖、补丁、配置、构建说明、许可和二进制 SHA-256。离线包内与官网同时提供相应材料，发布前评审分发边界和 H.264 专利许可。LGPL 路线需另行选编码器并在无 `--enable-gpl`、无 `--enable-nonfree` 的构建中重验编码、画质和版权条件。 [FFmpeg 官方许可说明](https://ffmpeg.org/legal.html) |
| Windows 杀软、SmartScreen 与证书轮换 | `scripts/sign-desktop.sh` 的先内后外签名、`scripts/package-desktop.sh` 的外层校验。 | `sign-win-desktop.ps1` 作为可替换签名钩子接 HSM/受管签名。先签自有 PE 和 NSIS 卸载器，再签外层 Setup/完整包。保留并核验供应商原签名。SHA-256、RFC 3161 时间戳，按系统 Authenticode 策略核验签名及发布者，完成签名后才生成清单哈希。证书私钥不进仓库/产物。用带 Mark-of-the-Web 的真实浏览器下载跑 Defender、SmartScreen、Smart App Control。免 UAC 是权限设计，声誉提示与企业策略单独验收。 [SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool) · [SmartScreen 声誉](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) |
| Skill 分发授权与任意第三方依赖 | `.gitmodules`、`scripts/build-desktop.sh`、`scripts/install-external-skills.sh`、`<plugin>/lib/skill-process.js`。 | 固定提交、构建期生成许可与来源清单，仅随包交付授权文件。受限参考资料走原作者渠道。内置 Skill 测实际脚本、辅助工具和干净机运行，外部可执行 Skill 的授权/兼容状态由工作台提示。 |
| 账号启用、回滚与数据 | `<plugin>/index.js`、`<plugin>/lib/web.js`、`<plugin>/lib/membership.js`、`membership/server.mjs`。 | 区分 `enabled: true`、未登录、邀请码失效、上游失败、余额耗尽与 BYOK。验证首跑、重启、续作、失败回滚及卸载保留。安装 staging 包中扫描敏感测试数据，验证回滚仍可读取已写入的用户数据。 |

Windows 10 与 ARM64 支持声明由以后实际验证结果确定。 [Windows 10 生命周期与版本](https://learn.microsoft.com/windows/release-health/release-information) · [Windows on Arm 仿真](https://learn.microsoft.com/windows/arm/apps-on-arm-x86-emulation)
