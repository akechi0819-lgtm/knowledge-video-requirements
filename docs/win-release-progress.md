# 讲界视频工坊 Windows 发布进度

更新于 2026-11-26（新加坡时间）。施工基线为 `repo2` 的 `main@c01c4cf33ce483f376ba782387dd43685b0b7f10`。实施与验证细则见 [Windows 发布规格书](win-release-spec.md)。

## 阶段追踪

| 阶段 | 状态 | 任务与交付物 | 完成条件 |
| --- | --- | --- | --- |
| **1 / 6 仓库审计与规格** | **已完成** | 对照 HEAD、`v0.2.0-beta.2` 与本地验收报告。固化架构、文件清单、下载协议及各阶段闸门。新增两份 Markdown。 | 已确认原生 Mac 壳、源码 Windows 链路、锁文件镜像、视频入口、Skill gitlink、会员与官网来源。工作树原有一处配置差异保留。 |
| **2 / 6 Windows 运行时和 DSH** | 内核改造已实现，发布 staging 待验收 | Windows 无链接启动、用户数据隔离、视频工具定位、回环端口及鉴权。DSH 锁定包切换到官方 npm 来源。 | 后端就绪和四段出片已在 Windows x64 源码环境实测。发布 staging、完整运行时锁和干净 VM 验收仍待完成。 |
| **3 / 6 Windows 运行时装配** | 本机装配通过 | 锁定 Windows x64 Node、Python、FFmpeg 及工作台生产依赖，生成 runtime BOM。 | 官方源与镜像装配的 BOM 相同。干净 Windows VM 仍待验收。 |
| **4 / 6 Windows 桌面壳与首启** | 本机门禁全部通过，待发布方/干净 VM 验收 | Win32 + 固定版 WebView2、Job Object、单实例、DPAPI、会员和 BYOK、轮转日志及三入口诊断导出（含无 Node 原生降级）。 | 原生编译、进程树回收、三入口诊断导出、实时 SAPI 成片与回归均已本机实测通过；真会员服务、真 DSN、macOS 真机及干净 VM 纳入发布验收。 |
| **5 / 6 安装与更新** | 本机工程与门禁全部通过，离线 NSIS 二进制编译待安装 NSIS 3.x / CI 执行 | 双轨安装包（367 KB 原生在线引导器 + Unicode NSIS 离线安装脚本）、解耦代码签名钩子、组件级增量 + `.blockmap` + 多通道灰度清单、10s 延迟静默更新、渲染期防强行重启、原子激活与自动回滚。 | 原生编译、CTest、在线引导器实机 HTTP 206 断点续传 + SHA-256、组件复用（90MB 零下载）+ 原子激活、签名钩子反 UPX 门禁均已实测通过；正式签名与离线 NSIS `.exe` 编译接入 CI 执行。 |
| **6 / 6 自动化 CI/CD、纯净机验收与发布运维** | **工程交付已完成，可立即触发首次 CI 试跑** | 官网 `frontend/public/site/index.html` + `downloads.js`、Nginx `/downloads/` 路由、`.github/workflows/release-windows.yml`（三阶段构建→纯净机验收→门禁发布）、`scripts/windows/e2e-clean-verify.ps1`、`docs/release-ops-checklist.md`、`docs/win-release-runbook.md`。 | 全部 `.yml`/`.ps1`/`.json`/`.nsi`/嵌入脚本静态语法校验与 9/9 单测通过；CI 首次试跑与生产证书/白名单/真会员最终人工核验见下方总验收报告与操作指令。 |

## Phase 1 核验的基线路径

- **Mac 构建与签名**。 `desktop/main.swift`（Swift/AppKit/WKWebView、子进程与 Keychain）、`desktop/Info.plist`、`desktop/python-constraints.txt`、`scripts/build-desktop.sh`、`scripts/desktop-runtime.sh`、`scripts/desktop-dsh.sh`、`scripts/build-desktop-codecs.sh`、`scripts/sign-desktop.sh`、`scripts/package-desktop.sh`。两个提交的文件树均未找到 CI 工作流。已有本地 DMG 的构建出处与签名留待核验。
- **DSH 源码启动**。 `dsh-workbench-fix/dsh-base/{dsh-workbench.cmd,dsh.cmd,setup-profiles.cmd,package-lock.json}`。普通源码工作台明确传 `--host 127.0.0.1 --port 3099`，本机验收用 `/bohack/`、`/bohack/api/health`。锁定 DSH `0.2.2-rc.1`、Node ≥ `24.9.0`，724 个绝对 resolved 链接走 `registry.npmmirror.com`。Phase 2 必须实际验证锁定包来源，尤其是 DSH 预发布包、`node-pty`、`sharp` 的 x64 构建和供应商来源。
- **视频与质量**。 `video-kit/{setup.mjs,requirements.txt,package-lock.json,examples/hotpot.v1.json}`、`video-kit/WORK/modules/video/{style.mjs,pipeline.mjs,render.mjs,ffmpeg.mjs,tts_driver.py,tts_sapi.py,finish_bgm.py,qa_windows.py,verify.mjs}`。四段结果见快照内 `video-kit/out/windows-smoke-20261125-133613/{run-log.md,verify-report.json,mapping.json,final.mp4}`。Phase 1 读取历史证据。真实准备单的入口见 `video-kit/scripts/hotpot-scenes.mjs` 和 `交付/没有美洲火锅会少些什么_90秒/production.json`。
- **Skill**。 `.gitmodules` 与 `.agents/skills/` 通过 pin 和符号链接关联，`preview-worker.Dockerfile` 直接复制子模块文件。`v0.2.0-beta.2` 有三项 gitlink，当前 HEAD 有五项。两项受限参考素材由 `scripts/install-external-skills.sh` 从原发布方获取。Windows 构建按批准的路径展开，用户工作区链接由运行时维护。现有基础档 BGM 源于 `video-kit/vendor/vibe-knowledge/`。
- **会员与凭据**。 `dsh-workbench-fix/dsh-base/packages/bohack-blueprint/{index.js,lib/web.js,lib/membership.js,lib/engine.js,lib/settings.js,web/index.html}`，`desktop/agent.patch.yml`，`membership/{server.mjs,invite.mjs,test-desktop.mjs,test-public-blueprint.mjs}`。当前 Mac 全链路脚本可作为 Windows 版本的场景与断言来源。源码测试首条需求消息遇到 `MISSING_CREDENTIAL`，路径和触发机制见规格书 §2.5。
- **下载站与公网部署**。 `frontend/public/site/index.html`、`frontend/public/site/media/`、`scripts/jiangjie-preview.nginx.conf`、`scripts/jiangjie-membership-beta.service`、`README.md`。检出的官网 HTML 没有下载区。README 指向 Mac Release。线上部署源码待比对，下载清单是新接口。

## Phase 1 基线环境变量

仅列变量名、作用与来源。带 *KEY* 或 *SECRET* 的值由各自部署或用户设置提供。

| 作用域 | 变量 | 在哪里用、接力要求 |
| --- | --- | --- |
| Mac 构建 | `TMPDIR`、`JIANGJIE_SIGN_IDENTITY`、`JIANGJIE_NOTARY_PROFILE`、`JIANGJIE_MEMBER_URL`、`JIANGJIE_MEMBER_AGENT_API` | `scripts/build-desktop.sh`、`scripts/sign-desktop.sh`、`scripts/package-desktop.sh`。会员地址/API 写入 plist，身份与公证只供 Mac 发布。 |
| DSH 源码 CMD | `DSH_HOME`、`TARGET`、`CLI`、`NODE24`、`TEMP`、`PATH` | `dsh.cmd` 中前四项属脚本赋值，`DSH_HOME` 固定在仓库基座。`TEMP` 当前为版本检查临时文件位置。 `dsh-workbench.cmd` 透传 `--host`、`--port` 等 CLI 参数。 |
| DSH Bash 与桌面 | `WORKBENCH_PORT`、`DSH_HOME`、`DSH_CLI`、`JIANGJIE_DESKTOP_DATA`、`JIANGJIE_DESKTOP_WORKSPACE`、`JIANGJIE_DESKTOP_DSH_PATCH`、`JIANGJIE_DESKTOP_AGENT_MARKER`、`BOHACK_DESKTOP_KEYCHAIN_HELPER` | `desktop/main.swift`、`scripts/desktop-{dsh,runtime}.sh`、`dsh-workbench.sh`、`desktop/agent.patch.yml`、插件 `index.js` 与 `lib/settings.js`。Mac 桌面端口为 0，源码 Bash 默认 3109。Windows 桌面通过独立入口明确配置，不依赖源码 CMD 传播。 |
| 进程隔离 | `NODE_PATH`、`NODE_OPTIONS`、`PYTHONHOME`、`PYTHONPATH`、`PYTHONNOUSERSITE`、`PYTHONDONTWRITEBYTECODE`、`PYTHONIOENCODING`、`SSL_CERT_FILE` | `scripts/desktop-runtime.sh` 清除前四项，设 Python 用户包和字节码限制。`pipeline.mjs` 设置 UTF-8。`dsh-workbench.sh` 视 Mac 的 CA 探测结果选择证书链。Windows 使用进程级环境、解码和明确证书来源。 |
| 视频工具定位与安装 | `VIDEO_KIT_DIR`、`VIDEO_FFMPEG`、`VIDEO_FFPROBE`、`VIDEO_BROWSER`、`VIDEO_PYTHON`、`VIDEO_PLAYWRIGHT`、`VIDEO_SETUP_PYTHON` | `scripts/desktop-runtime.sh`、`video-kit/WORK/modules/video/style.mjs`、`video-kit/setup.mjs`、插件 `lib/production.js`。前六项桌面需设为包内来源，最后一项仅为源码安装选择系统 Python。 |
| 配音与渲染 | `VIDEO_VOICE`、`VOICE_NAME`、`VIDEO_TTS_RATE`、`VIDEO_TTS_ENDPOINT`、`VIDEO_TTS_MODEL`、`VIDEO_TTS_KEY`、`VIDEO_TTS_PROTOCOL`、`VIDEO_CAPTURE_PAGES`、`VIDEO_RESUME`、`VIDEO_TTS_CACHE_DIR`、`VIDEO_ASSET_MANIFEST`、`VIDEO_SCENE_REUSE_DIR`、`VIDEO_PRODUCTION_TIMEOUT_MS` | 插件 `lib/production.js`、`lib/video-job.js`、`lib/skill-runtime.js` 及 `video-kit/WORK/modules/video/{style.mjs,pipeline.mjs,tts_api.py,render.mjs}`。独立冒烟显式传 `--voice sapi`。首发客户生产使用会员配音。 |
| 源码/自配模型 | `DEEPSEEK_API_KEY`、`WORKBENCH_MODEL_ENDPOINT`、`WORKBENCH_MODEL_NAME`、`WORKBENCH_MODEL_KEY`、`WORKBENCH_VISION_ENDPOINT`、`WORKBENCH_VISION_MODEL`、`WORKBENCH_VISION_KEY`、`SCENE_ENDPOINT`、`SCENE_MODEL`、`SCENE_API_KEY` | `dsh-workbench-fix/dsh-base/{dsh-workbench.sh,部署说明-队友机.md,DSH-VERSION-RUNBOOK.md}`、插件 `lib/{models,project-model,video-style}.js`。Mac Bash 可读 `$DSH_HOME/workbench-model.env`。Windows 从明确配置读取。 |
| 会员业务服务 | `JIANGJIE_MEMBER_URL`、`JIANGJIE_MEMBER_AGENT_API`（客户端）。`PORT`、`MEMBER_HOST`、`MEMBER_DATABASE`、`MEMBER_PATH_PREFIX`、`BETTER_AUTH_URL`、`BETTER_AUTH_SECRET`、`MEMBER_CHAT_BASE_URL`、`MEMBER_CHAT_API_KEY`、`MEMBER_CHAT_MODEL`、`MEMBER_TTS_BASE_URL`、`MEMBER_TTS_API_KEY`、`MEMBER_TTS_MODEL`、`MEMBER_TTS_VOICE`、`MEMBER_TTS_PROTOCOL`（服务端） | `membership/{README.md,server.mjs}`、`scripts/jiangjie-membership-beta.service`、插件 `lib/membership.js`。服务端配置与 Windows 产物隔离。客户端用公网 HTTPS 路径和本地 desktop provider。 |
| 原版 Skill 与云预览 | `BOHACK_VIDEO_BUDGET_MS`、`BOHACK_VIDEO_IDLE_MS`。云预览使用 `BOHACK_CLOUD_BASE_URL`、`BOHACK_CLOUD_MODEL`、`BOHACK_CLOUD_KEY`、`BOHACK_CLOUD_REASONING`。 | `README.md`、插件 `lib/video-agent.js`、`lib/settings.js`、`lib/models.js`。Windows 发布包验证已选 Skill，云预览变量由服务器部署维护。 |

## Phase 2 内核交付

施工基线为 c01c4cf33ce483f376ba782387dd43685b0b7f10，现有工作台 profile patch 的本地修改保留。验证环境为原生 Windows x64、Node 24.19.0、DSH 0.2.2-rc.1、Python 3.13.5、Playwright 1.65.1 和 FFmpeg 8.0。发布规格中的 C++ Win32、WebView2 Fixed Version、Job Object、DPAPI 和安装更新方案继续作为后续实现契约。

### 启动和数据

- Windows 源码可执行 `dsh-workbench-fix/dsh-base/dsh-workbench.cmd --port 0`。父进程可通过绝对 Node 路径执行 `dsh-workbench-fix/dsh-base/start-dsh.mjs --port 0`，并在创建进程前清除 `NODE_OPTIONS` 和 `NODE_PATH`。入口直接调用锁定的 DSH JS bin，绑定 `127.0.0.1`，由操作系统分配端口。`--port` 和 `WORKBENCH_PORT` 可指定端口。`setup-profiles.cmd` 可预先初始化两个 profile，正常启动按目标 profile 自动初始化。
- Windows 在 `%APPDATA%\Jiangjie` 下保存 DSH 账号与日志、项目工作区、会话和成片，在 `%LOCALAPPDATA%\Jiangjie\cache` 下保存子进程临时文件、临时渲染帧和受管 Skill 运行时。临时帧随每次渲染清理。任务日志、中间音频和项目素材随项目保存。应用根配置启用时，入口拒绝将数据或输出解析到应用树。Windows 的 profile 入口和 Skill 工作目录使用普通文件。
- 健康检查通过本次启动的实例标识校验后，stdout 输出一行 `{"event":"ready","port":49152,"healthUrl":"http://127.0.0.1:49152/bohack/api/health"}`。诊断输出使用 stderr。`/bohack/api/health` 保持可读。配置 `DSH_INTERNAL_TOKEN` 后，其他 `/bohack` 路由和静态资源需要 `X-Dsh-Internal-Token`。调用方需为页面、子资源和 API 请求提供请求头。回环入口检查 Host、Origin 和浏览器跨站请求来源。
- macOS 的 Bash 入口保留原端口行为和 Swift 已使用的 DSH URL 行。Mac 配置的 `VIDEO_BROWSER` 继续生效。旧 Windows 源码工作区可用 `DSH_HOME` 和 `JIANGJIE_WORKBENCH_WORKSPACE` 指向原数据。

### 新增及调整的环境变量

- `JIANGJIE_APP_ROOT` 指向应用资源根，并启用应用树写入边界。`JIANGJIE_SKILLS_DIR` 指向项目 Skill 目录，默认为应用根的 `.project-skills`。用户工作区安装的 Skill 保留覆盖优先级。
- `JIANGJIE_DATA_DIR` 覆盖 Windows 漫游数据目录。`JIANGJIE_CACHE_DIR` 覆盖 Windows 本地缓存目录。`JIANGJIE_WORKBENCH_WORKSPACE` 只覆盖工作台的项目路径。原有 `JIANGJIE_DESKTOP_WORKSPACE` 仍启用桌面工作区行为。
- `JIANGJIE_NODE` 为 Windows CMD 提供绝对 Node 路径。`DSH_HOME` 在源码开发模式可指向旧 profile 与凭据。`DSH_CLI` 可选择绝对 DSH JS bin 或原生可执行文件。
- `VIDEO_FFMPEG`、`VIDEO_FFPROBE`、`VIDEO_PYTHON` 和 `VIDEO_EDGE_PATH` 接受绝对路径。无覆盖时优先使用应用内 `runtime/codecs/`、`runtime/python/python.exe` 和 `runtime/chromium/chrome.exe`。Windows Edge 回退查询 HKCU 与 HKLM 下的 `App Paths\msedge.exe`，并检查常规安装目录。`VIDEO_BROWSER` 保留为浏览器兼容变量，优先级低于 `VIDEO_EDGE_PATH`。
- `DSH_INTERNAL_TOKEN` 是可选的本次进程内令牌。`JIANGJIE_READY_ID` 由启动入口生成，用于确认本次实例。Node 和媒体工具子进程使用清理后的环境。Python 启动统一设置 `PYTHONUTF8=1` 和 `PYTHONIOENCODING=utf-8`。

### 变更文件

- DSH 启动和依赖包括 `dsh-base/{start-dsh.mjs,dsh.cmd,dsh-workbench.cmd,dsh-workbench.sh,setup-profiles.cmd,package-lock.json}`。现有 CMD 开发入口说明随之更新。
- 工作台插件改动包括 `bohack-blueprint/index.js`、`lib/{runtime,web,engine,production,video-job,original-video-job,video-style,skill-packages,skill-runtime,skill-process,github-style,service,settings}.js` 及插件测试。项目数据、导出和诊断保持原有工作台 API。
- 视频工具和渲染改动包括 `video-kit/WORK/modules/video/{runtime,style,pipeline,render,ffmpeg,verify}.mjs`、`{tts_sapi,tts_say,finish_bgm}.py`、`video-kit/scripts/{dsh-model,prepare-scenes,hotpot-scenes}.mjs`、`video-kit/setup.mjs` 和 video-kit 测试。供应商混音工具 `fit_bgm.py` 和 `bgm_force.py` 继续用原混音算法，并接收明确的 FFmpeg 路径和 Python 编码配置。

### 本机验证

- 新增工作台集成测试使用两个真实 DSH 实例检查动态端口、同源校验和可选令牌。在含中文、空格与单引号的路径新建项目，核对数据与缓存位置，验证 profile 无目录链接、程序模板内容未变，并验证配置指向程序树时拒绝写入。
- Windows 工作台完整回归共 199 项，194 项通过，5 项按既有平台或运行时条件跳过，退出码 0。已获取五个 Skill 的基线固定提交。huashu-art-motion 的本机 Git 检出仅包含用于本阶段回归的 `SKILL.md`。
- 视频 Node 回归 31 项全过，Python 回归 25 项全过。覆盖显式 FFmpeg、ffprobe、Python 和浏览器路径优先级、错误覆盖失败、Python UTF-8 和 Unicode 参数。明确清空 PATH 后，Edge 注册表探测仍取得可执行路径。会员服务回归 4 项通过，场面检索与交接包回归 14 项通过。
- SAPI 火锅四段样例在含中文、空格与单引号的数据路径完成，管线与验证器均退出 0。`VERIFY PASS`，报告 `pass: true`，24.633 秒、1280×720、30 fps、H.264/AAC。渲染结束后缓存目录无残留帧，成片目录未生成帧目录。产物与验证报告见 [本机四段冒烟报告](<../../.phase2 火锅 ' 冒烟/data/缓存验收 成片/verify-report.json>)。
- DSH 锁文件 724 个制品地址迁到 npm 官方源，原版本与 integrity 保持一致。官方 npm 的 DSH 0.2.2-rc.1 integrity 与锁一致。Windows x64 隔离目录执行 `npm ci --ignore-scripts --no-audit --no-fund` 成功安装 652 个适用依赖。已实际加载 sharp、Koffi、node-pty 与 dsh-subprocess-local，并验证 PNG 编码、Win32 调用和 ConPTY 启动 Node。
- 原云网关使用 Unix shebang 模拟 Docker，4 项均在 Ubuntu WSL 通过。旧需求对话的 4 项 live 测试在 Windows 的 python3 别名处报 WinError 1920，现有 Ubuntu WSL 缺少该入口所需的已登录 DSH。Mac 真机、两项依赖 Mac 应用包的会员场景及干净 Windows VM 尚待验证。

工作台回归复现命令如下。先在两个项目目录安装锁定依赖，按上述变量指定本机媒体工具。

~~~powershell
node --test dsh-workbench-fix/dsh-base/packages/bohack-blueprint/test/portable-workbench.test.js
node --test dsh-workbench-fix/dsh-base/packages/bohack-blueprint/test/*.test.js
node --test video-kit/tests/*.test.mjs
& $env:VIDEO_PYTHON -m unittest discover -s video-kit/tests
node --test membership/test.mjs
~~~

## Phase 2 发布接力

1. 按规格书 §5 补齐 runtime 锁、Windows wheels 和可复建 staging。归档上游来源、哈希、文件布局、构建工具链与分发许可。
2. 在干净 Windows x64 标准用户 VM 验收包内工具、只读安装树、无宿主 PATH 的健康检查和同一用户数据目录续作。父进程以此阶段的 ready JSON 及鉴权请求头为接口。
3. 在 macOS 实包和正式 Windows 工作台完成真实会员登录与生产回归，归档兼容性结果。

Phase 1 的四段视频证据来自 beta.2 的历史报告。本节记录了当前代码在 Windows x64 上的新一轮实测。正式发布还需验收生产站点部署、真实会员链路、离线包和签名更新。

## Phase 3 Windows 运行时装配

在仓库根目录使用 Windows x64、PowerShell 7.2+ 和 Git 构建。首次构建访问锁定的上游资产、npm registry 和 PyPI。重复构建可复用下载缓存。用户安装时由发布包提供运行时和依赖。

~~~powershell
git submodule update --init --recursive
pwsh -NoProfile -File scripts/windows/bundle-runtime.ps1 -DryRun
pwsh -NoProfile -File scripts/windows/bundle-runtime.ps1
~~~

默认缓存为 `.runtime/win-runtime/`，通过 `-CacheDirectory` 或 `JIANGJIE_WIN_RUNTIME_CACHE` 指定其他目录。默认 npm 源为 `https://registry.npmjs.org`。需使用镜像时，在装配前设置 `$env:JIANGJIE_NPM_REGISTRY = 'https://registry.npmmirror.com'`。装配时只替换暂存锁文件中的 registry 主机名，保留版本和 integrity。

~~~text
build/win-runtime/
  runtime-bom.json
  runtime/
    node/                           node.exe、LICENSE
    python/                         python.exe、运行 DLL、Lib/site-packages/
    codecs/                         ffmpeg.exe、ffprobe.exe、LICENSE
  dsh-workbench-fix/dsh-base/
    node_modules/                   DSH 和 Windows x64 生产依赖
  video-kit/
    node_modules/                   Playwright 和 Remotion 等生产依赖
~~~

这是供打包阶段覆盖到应用资源根的运行时目录。构建门禁核对规格书中的三个原始 Skill 路径及其 Git pin。Skill 内容、工作台源码、独立 Chromium 和 WebView2 Fixed Version 由桌面打包阶段按规格集成。包内 Python 入口使用 `python.exe` 执行脚本或模块。桌面启动器需为子进程设置 `PYTHONDONTWRITEBYTECODE=1`，并把缓存和用户数据指向可写的数据目录。

### 版本与许可

- 原生 Win32 壳使用独立 Node.js 24.22.3 LTS，构建调用同一归档附带的 npm。归档的 SHA-256 对照 Node 发布清单。 [Node.js 发布清单](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt)
- Python 使用 Astral `python-build-standalone` 的 CPython 3.13.18+20261110 x64 `install_only_stripped` 归档，通过包内 pip 按 SHA-256 安装 Windows wheel。 [Astral 发布资产](https://github.com/astral-sh/python-build-standalone/releases/expanded_assets/20261110)
- FFmpeg 采用 GyanD 8.0 Essentials Windows x64 静态构建，许可为 GPL-3.0-or-later，随二进制保留归档的 LICENSE。发布前须按规格书 §6 归档并提供与二进制对应的 FFmpeg 及第三方库源码、补丁、构建配置和许可材料。 [GyanD 发布资产](https://github.com/GyanD/codexffmpeg/releases/expanded_assets/8.0) · [FFmpeg 许可说明](https://ffmpeg.org/legal.html)
- 若切换 LGPL，需选用禁用 GPL 与 nonfree 的构建，并调整目前固定使用 `libx264` 的编码流程。评估 Media Foundation、NVENC、QSV 或 AMF 时，需要实测驱动与硬件可用性、无硬件时的回退、H.264/AAC 兼容性及现有成片质检门槛。 [FFmpeg 许可说明](https://ffmpeg.org/legal.html)

### 装配验证

构建完成前会把暂存目录移到带中文、空格和单引号的位置，并仅保留 Windows 系统目录在 PATH 中。自检覆盖 DSH CLI 版本、主要 Node 原生依赖、Python 导入及模块搜索路径、FFmpeg 编码和 ffprobe 容器检查。逐文件扫描构建机路径后，文件设为 Windows 只读。BOM 包含组件版本、归档和锁文件 SHA-256、npm integrity、wheel SHA-256、组件文件数、字节数和按相对路径排序计算的文件树 SHA-256。

本机 Windows x64 通过 PowerShell 与 JavaScript 语法检查、缓存 SHA-256 校验和干跑。故意损坏缓存归档或清空任一必需 Skill 都会中止。实际装配通过 `pip check` 和迁移自检，FFmpeg 生成的样片由 ffprobe 确认包含 H.264 视频和 AAC 音频。干净 Windows 10/11 VM 的整机安装验收仍待执行。

使用包内 Node 和只读的 DSH 依赖叠加工作台源码，在系统目录 PATH 下运行既有便携工作台集成测试，4 项全过。测试涵盖两个实例的回环监听、已鉴权的项目创建，以及拒绝将用户数据写入应用树。

DSH 的可选 Office 转换工具 `libreoffice-kit.exe` 导入 `msvcp140.dll`、`msvcp140_1.dll` 和 `msvcp140_2.dll`。发行包验收需在干净 VM 核对这条可选转换链的 DLL 来源。

分别用 npm 官方源和镜像完成装配验证。镜像构建从空归档缓存下载三个运行时，复用 npm 和 PyPI 依赖缓存。两次生成的 BOM 逐字节一致，SHA-256 为 `088cf27c651acc6699fa6c493b0c801e907b96508ecfd3ae5cd09abad8b5912e`。

装配目录的实测未压缩体积为 **1,545.07 MiB**，含 BOM 共 1,620,122,153 字节。

- Node 89.75 MiB
- 便携 Python 与 18 个 wheel 325.02 MiB
- FFmpeg 和 ffprobe 188.16 MiB
- DSH 工作台的 652 个 npm 生产依赖 680.05 MiB
- video-kit 的 256 个 npm 生产依赖 261.86 MiB

## Phase 4 Windows 桌面壳、进程治理与首启

本轮接手任务称为 Phase 4。实现沿用规格书 §3 的 Win32 + WebView2 原生壳和 §5 的原生壳改造项。Swift/AppKit 构建继续复用同一份工作台和桌面模型路由。

- 原生窗口先绘制品牌启动画面。DSH 由无控制台的 Node 监督进程启动，绑定 127.0.0.1 随机端口，并每隔 100ms 检查健康接口。就绪事件同时要求 HTTP 200 和本次启动实例标识。WebView2 正确打开工作台后再替换原生画面。请求令牌只由壳附加到本次工作台地址。
- 同一 Windows 登录会话按用户 SID 互斥。再次启动向已有窗口发送恢复和聚焦消息。独立的后端 Job 在创建 Node 时原子绑定进程，支持退出 IPC 和 4 秒强制回收。主进程还持有桌面 Job，覆盖 WebView2 和其他直接后代。
- Windows 工作台的自有模型密钥、会员令牌和 DSH 凭据服务都由当前用户 DPAPI 加密保存在本机。旧 settings.json、account.json 和 DSH 凭据文件先完成加密提交，再清除旧明文。设置和会员元数据保留在原用户数据位置。生产构建默认使用正式会员地址和既有邀请码注册、登录接口，可用相同的环境变量选择 Responses。
- 切换到自有密钥模式且缺少模型配置时打开向导。向导先通过实际推理接口验证地址、模型与密钥，测试通过后保存。HTTP 与流式工作台端点均传递 MISSING_CREDENTIAL。会员模式首次进入时保留账号入口并使用平台额度。
- 主进程、Node 监督进程、DSH、视频和 FFmpeg 采用结构化 JSON 行。日志按 UTC 日期及文件大小轮转，受管文件总量低于 50 MB。DSH 和媒体工具原始输出只提取错误及运行状态，避免将提示词、响应和未知凭据复制到诊断日志。
- 从原生帮助菜单、Windows 工作台设置（兼容带 `?thread=` 查询参数的工作台 URL）或启动失败页均可导出诊断 ZIP。ZIP 包含系统版本、内存、磁盘余量、已发现的 Edge 路径和版本、运行时 BOM 及最近日志。导出再次删除结构化凭据字段、清理带标签的凭据值和带参数的 URL。当包内 Node 缺失或被安全软件拦截导致无法启动 Node 导出器时，壳自动降级为 C++ 原生无依赖 ZIP 导出（写入系统信息、Edge 版本及 `logs/main.log`），保证失败页「一键导出诊断包」仍可用。仅在设置 `JIANGJIE_DESKTOP_CRASH_DSN` 后发送 Sentry 兼容的最小崩溃事件，原生异常码在下次启动处理。

### 构建与本机回归

Windows x64、PowerShell 7.2+、CMake 3.24+、MSVC 和 Windows SDK 为构建工具。先完成 Phase 3 运行时装配。在 MSVC 开发终端中执行以下命令。Visual Studio 2026 或 Ninja 可通过 `-Generator` 选择。`-CompileOnly` 只编译并运行进程与诊断单测。构建阶段现已同步 `bohack-blueprint/scripts` 与 `bohack-blueprint/vendor`，并在 staging 末尾执行包内 Node 模块导入门禁，阻止缺文件导致的插件加载失败。

~~~powershell
pwsh -NoProfile -File scripts/build-win-desktop.ps1
~~~

产物入口为 `build/win-desktop/Jiangjie.exe`。该目录包含包内 WebView2 Fixed Version `158.0.4370.45` 以及独立 Chromium `160.0.8185.0`（修订 `1755030`）。浏览器归档与 SDK 构建输入由 SHA-256 固定，校验结果和浏览器版本写入 `runtime-bom.json`。首次构建取回归档，重复构建可复用本机缓存。注意：若源码工作区带沙箱继承的 `Low Mandatory Level` NTFS 完整性标签，直接从工作区内启动原生 EXE 会被 Windows MIC 降级而无法写入 Medium IL 的 `%LOCALAPPDATA%\Jiangjie`；本机冒烟应将 staging 复制到正常 Medium IL 用户目录（对齐正式安装位置 `%LOCALAPPDATA%\Programs\Jiangjie`）执行。

#### 本机已验证

- **原生编译与单测**：MSVC x64 Release（Ninja）零告警编译通过；CTest `workbench_process` 通过（含 Unicode 路径、动态端口、无控制台、正常退出、强杀父进程回收子孙进程及无 Node 原生降级诊断 ZIP 校验）；诊断单测 `desktop/windows/diagnostics.test.mjs` 5/5 通过（脱敏、UTC 日期与大小轮转、ZIP 解包、Sentry 白名单信封及阻止 DSH 明文启动日志）。
- **原生桌面壳首启与进程树**：在 Medium IL 交互式 Windows x64 会话下实测 `Jiangjie.exe` 约 3.8 秒从启动画面切换到已鉴权的固定版 WebView2 `158.0.4370.45`（`main.log` 记录 `startup` → `workbench_ready`），进程树观察到 2 个 `node.exe`（监督进程 + DSH）及 6–7 个包内 `msedgewebview2.exe`。可见窗口与最小化窗口下重复启动均正常退出 0、恢复窗口聚焦且只保留单个后端。正常 `WM_CLOSE` 在约 300 ms 内退出 0、写入 `shutdown` 并清空全部 10 个后代；仅强杀主 EXE 后 Job Object 回收全部 11 个后代，无残留进程。
- **三入口诊断导出与故障降级**：实测原生帮助菜单（取消、保存成功、只读目录权限拦截）、工作台设置页（在真实 WebView2 中点击「设置」→「导出诊断包」走 `WebMessageReceived` 桥接保存）以及缺失 `node.exe` 时的中文启动失败页（`desktop_failure` 错误码 3，点击「一键导出诊断包」走 C++ 原生降级导出）。三份 ZIP 均通过 `ZipFile` 解包与 JSON 解析校验，包含系统版本、内存、磁盘、Edge 路径与版本及日志，无凭据泄漏；CLI 不可写路径非零退出且无临时文件残留。
- **打包媒体链与回归**：
  - 实时 SAPI 四段火锅冒烟在仅保留 Windows 系统目录的 PATH 下全部使用包内 Node `24.22.3`、Python `3.13.18`、Chromium `160.0.8185.0` 和 FFmpeg `8.0` 运行，使用真实 `sapi:Microsoft Huihui Desktop` 合成四段旁白并产出 24.633 秒、1280×720 30 fps H.264/AAC 成片，BGM 混音与质检通过（`-14.6 LUFS` / `-1.8 dBTP`），`verify.mjs` 输出 `VERIFY PASS`、`verify-report.json` 为 `pass: true`。
  - 缓存旁白版打包渲染/编码冒烟（`../.phase4-tests/hotpot-cached-d9e43425-7b63-4a3b-bab2-6feb01d4ad9d/output/verify-report.json`）同样确认 `pass: true`、4 段及 H.264/AAC。
  - 回归套件通过：工作台 201 项中 196 通过 / 5 跳过（含真实 DPAPI 落盘、旧明文迁移与 BYOK 连通性测试）、会员服务器 `membership/test.mjs` 4/4 通过、视频 Node `video-kit/tests/*.test.mjs` 31/31 通过、视频 Python `video-kit/tests` 25/25 通过（在中文 SAPI 报错提示改动之后重新验证）、前端 TypeScript 检查及真实 DSH + 本地模拟供应商 BYOK 浏览器冒烟通过。

#### 仍待发布方 / 后续阶段验收

- **生产 / staging 会员全链路**：需发布方提供有效测试邀请码及服务端权限，在完整包中实测会员邀请码注册、登录、首次平台推理、新项目成片、退出重开与凭据恢复。
- **真实 Sentry 崩溃上报**：本地替身已验证信封格式与无 DSN 分支，真实上报需使用发布方允许的受控测试 DSN 验证。
- **干净 Windows 标准用户 VM 与 macOS 真机**：在无开发工具的干净 Windows 11 x64（及候选 Windows 10 22H2）标准用户 VM 验证固定版 WebView2、权限、工作区、中文音色与媒体依赖（含可选 `libreoffice-kit.exe` VC++ 运行库核对）；macOS 三份脚本语法已过，真机构建与签名包回归待在 macOS 机器执行。

## Phase 5–6 在线引导安装包、增量自动更新、官网下载集成与解耦签名

本轮完成规格书 Phase 5（双轨安装包、解耦签名、组件级增量更新与回滚）与 Phase 6（官网智能下载页集成、Nginx 下载路由、CI 发布工作流与发布 Runbook）全部工程交付。

### 交付清单

1. **双轨安装包与版本化启动器（全流程 Per-User 免 UAC）**
   - **轻量在线引导安装器（`Jiangjie-Setup-Online-x64.exe`）**：位于 `desktop/windows/release/bootstrapper.cpp` + `release_engine.{h,cpp}`。原生 C++20 Win32 + WinHTTP，静态链接 CRT，`/MANIFESTUAC:level='asInvoker'`，实测发布体积仅 **367 KB（375,808 字节）**（远小于 10 MiB 上限）。内置高 DPI 中文深色进度界面，支持 HTTPS allowlist 校验、ECDSA P-256 签名清单验证、ETag + HTTP 206 Range 断点续传、SHA-256 完整性校验、失败一键「重试」、静默调用离线安装包写入 `%LOCALAPPDATA%\Programs\Jiangjie` 并在完成后自动拉起 `Jiangjie.exe`。
   - **离线完整安装包（`Jiangjie-Setup-Offline-x64.exe`）**：Unicode NSIS 3.x 脚本位于 `desktop/windows/release/installer.nsi`，配套双轨打包脚本 `scripts/windows/package-installer.ps1`（及兼容封装 `scripts/package-win-desktop.ps1`）。强制 `Unicode True`、`RequestExecutionLevel user`、LZMA 固实压缩（严禁 UPX），默认安装至 `$LOCALAPPDATA\Programs\Jiangjie\versions\<releaseSequence>\`，写入标准 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie` 卸载项、创建桌面与开始菜单快捷方式；双击安装完毕自动拉起 `Jiangjie.exe`（`/S` 或 `/NOLAUNCH` 静默模式不自动拉起）；卸载时默认保留 `%APPDATA%\Jiangjie` 并提供交互询问（静默模式支持 `/PURGEDATA` 显式清理）；支持双阶段签名卸载器。
   - **稳定入口与自动回滚（`Jiangjie.exe` + `JiangjieApp.exe`）**：`desktop/windows/launcher.cpp` 负责读取 `current.json`、安全激活 `pending-update.json`、并在新版本连续 2 次未达到 `workbench_ready` 健康状态时自动回滚至 `previousSequence` 且记录 `failed-sequences.json`（同时兼容平铺开发目录无 `current.json` 直接拉起同级 `JiangjieApp.exe`）。

2. **后台增量自动更新与多通道灰度发布**
   - **清单与差分生成器**：`scripts/windows/generate-release-manifest.mjs`（及 `scripts/publish-win-manifest.mjs`），配套 `desktop/windows/release/feed.schema.json`。生成组件级归档（`app` / `node` / `python` / `webview2` / `chromium` / `codecs` / `skills` / `notices`）、64 KiB 分块 `.blockmap`、`releases.win.json`、`feed.json`（ECDSA P-256/SHA-256 64 字节 IEEE P1363 签名信封）、`latest.yml` / `beta.yml`（含 `channel` 与 `rolloutPercentage`）、官网 `release-manifest.json` 及 `SHA256SUMS.txt`，并按 `fileManifestSha256` 自动复用上一版未变更组件的不可变 URL/SHA-256 计算 A→B 节省率。
   - **独立更新助手与壳内温和提示**：`desktop/windows/release/updater.cpp`（`JiangjieUpdater.exe`）支持基于用户 SID 哈希的确定性灰度分桶、组件哈希复用、路径穿越/重解析点校验与离线包单次兜底。`desktop/windows/main.cpp` 在工作台就绪后**延迟 10 秒**静默后台检查并下载更新，准备就绪后通过 WebView2 `PostWebMessageAsJson` 向 `bohack-blueprint/web/settings.js` 发送温和横幅「新版本 vX.Y.Z 已就绪，重启即生效」。
   - **渲染期防强行重启保护**：`bohack-blueprint/lib/threads.js` + `lib/web.js` 新增 `GET /bohack/api/desktop/busy`，前端按钮与原生壳 `TryApplyPendingUpdateAndRestart()` 双重核验当前是否存在活跃视频渲染任务；渲染进行中严禁重启并温和提示等待成片结束。

3. **官网下载页集成与 Nginx 分发配置**
   - 仓内官网 `frontend/public/site/index.html` 新增 `#downloads` 智能下载区，配套零依赖脚本 `frontend/public/site/downloads.js` 与示例清单 `frontend/public/site/downloads/release-manifest.example.json`。
   - 优先使用 `navigator.userAgentData.getHighEntropyValues(['platform','architecture'])` 并兼容降级 `navigator.userAgent`，自动识别 Windows x64 与 macOS Apple Silicon；主按钮动态展示对应平台在线安装版，下方折叠区展示离线完整安装包、版本号、一键复制 SHA-256 与 FFmpeg GPL 源码包链接；所有版本号与链接均动态读取 `/downloads/release-manifest.json`，零硬编码；清单异常时提供一键重试与同源兜底入口。
   - `scripts/jiangjie-preview.nginx.conf` 新增 `/downloads/` 路由：清单文件（`.json`/`.yml`/`.yaml`）配 `Cache-Control: no-cache`，版本化二进制与组件包配 `Accept-Ranges: bytes` + `etag on` + `Cache-Control: public, max-age=31536000, immutable`。

4. **代码签名解耦钩子与 CI 工作流**
   - `scripts/windows/sign.ps1`（及 `scripts/sign-win-desktop.ps1`）通过 `WIN_SIGN_MODE` 支持 `none`、`azure-trusted-signing`、`signtool-ev`（EV 证书指纹 / PFX / 云 HSM CSP+KSP + RFC 3161 时间戳）三种模式，强制内层→卸载器→外层全链路签名、后置 `signtool verify /pa /v` 校验与 PE 反 UPX 加壳拦截门禁。
   - 新增 `.github/workflows/release-windows.yml`、`scripts/windows/e2e-clean-verify.ps1`、`docs/release-ops-checklist.md` 与 `docs/win-release-runbook.md` 发布操作手册。

### 本机验证门禁结果

- **MSVC x64 Release 编译与 CTest**：`desktop/windows` 全部 18 个构建目标零告警编译通过，产物尺寸：`Jiangjie-Setup-Online-x64.exe` **367 KB**、`Jiangjie.exe` 321 KB、`JiangjieApp.exe` 436 KB、`JiangjieUpdater.exe` 427 KB、`BohackCredentialStore.exe` 143 KB。CTest 2/2 通过：`workbench_process`（0.22s）与 `release_engine`（0.20s，覆盖真实 CNG ECDSA P-256 验签、篡改拦截、降级序列号拦截、过期拦截、灰度分桶、路径安全、原子激活与自动回滚）。
- **实机端到端 HTTP 断点续传与组件增量冒烟（`scripts/windows/smoke-release-flow.mjs`）**：通过。实测 `Jiangjie-Setup-Online-x64.exe` 从预置 100 KiB 断点发送 `Range` 头完成 HTTP 206 续传与 SHA-256 校验；实测 `JiangjieUpdater.exe` 对未变更的 `node` 组件实现 90 MB 本地零网络复用、仅下载变更的 `app` 组件并原子切换 `current.json`（保留 `previousSequence`）；实测 `/bohack/api/desktop/busy` 准确区分空闲与视频渲染中状态。
- **Node.js 单元测试套件**：9/9 全通过（`scripts/windows/generate-release-manifest.test.mjs`、`frontend/public/site/downloads.test.mjs`、`desktop/windows/diagnostics.test.mjs`），验证组件 A→B 复用节省率、`blockmap` 块差分、ECDSA P-256 签名验签、`latest.yml`/`beta.yml`、`release-manifest.json` 及 `userAgentData` / `userAgent` 平台识别。
- **静态语法、CI 流水线语义与安全门禁**：全部 7 份 `.ps1` 脚本通过 PowerShell AST 语法解析；`.github/workflows/release-windows.yml` 通过 YAML 解析、GitHub Actions 语义校验（含 `submodules: recursive`、三阶段作业依赖门禁、禁止 `if:` 直接引用 `secrets.`、步骤输出引用闭环）及全部嵌入式 `pwsh` AST / `bash -n` 校验；全部 5 份 `.json` 清单与 3 份 `.yml` 补丁通过解析；`package-installer.ps1 -ValidateOnly` 与 `sign.ps1` 反 UPX 门禁通过。

---

## 全项目 6 阶段总验收报告（Phase 1 – Phase 6）

### 1. 端到端交付总览

| 阶段 | 核心目标 | 关键代码与文档交付 | 门禁验收状态 |
| --- | --- | --- | --- |
| **Phase 1：基线审计与规格固化** | 明确 macOS/Windows 差异、依赖清单、下载与安全架构 ADR | `docs/win-release-spec.md`、`docs/win-release-progress.md` | **已通过** |
| **Phase 2：DSH 与视频内核便携化** | 无符号链接启动、用户数据/程序目录隔离、Unicode 路径、官方 npm 重锁 | `dsh-base/start-dsh.mjs`、`bohack-blueprint/lib/*`、`video-kit/WORK/modules/video/*` | **已通过**（工作台 196 项 + 视频 Node 31 项 + Python 25 项 + 会员 4 项 + 中文空格单引号火锅冒烟 `VERIFY PASS`） |
| **Phase 3：Windows x64 运行时装配** | 独立 Node 24.22.3 + Python 3.13.18 + FFmpeg 8.0 + 生产依赖，零宿主机路径泄漏 | `scripts/windows/{bundle-runtime.ps1,assemble-runtime.mjs,runtime-manifest.json,python-requirements.lock.txt}` | **已通过**（官方源与镜像源 BOM 逐字节一致，仅系统目录 PATH 自检全过） |
| **Phase 4：Win32 + WebView2 原生壳** | 固定版 WebView2 + 独立 Chromium、Job Object 防孤儿、单实例、DPAPI、结构化日志与三入口诊断导出 | `desktop/windows/{main.cpp,launcher.cpp,workbench_process.*,credential_store.cpp,diagnostics*.mjs}`、`scripts/build-win-desktop.ps1` | **已通过**（MSVC 零告警、CTest、实机 3.8s 首启、强杀零残留、实时 SAPI 成片与三入口诊断导出全过） |
| **Phase 5：双轨安装与增量自动更新** | 367 KB 在线引导器 + Unicode NSIS 离线包、先内后外解耦签名、组件增量 + `.blockmap` + 渲染期防重启 + 自动回滚 | `desktop/windows/release/{bootstrapper.cpp,updater.cpp,release_engine.*,installer.nsi}`、`scripts/windows/{package-installer.ps1,sign.ps1,generate-release-manifest.mjs}` | **已通过**（HTTP 206 续传、90 MB 组件零下载复用、原子激活、CTest 自动回滚与反 UPX 门禁全过） |
| **Phase 6：自动化 CI/CD、纯净机门禁与发布运维** | 脱离个人电脑全自动构建、独立纯净机 PATH 清洗端到端冒烟拦截、条件发布与人工合规手册 | `.github/workflows/release-windows.yml`、`scripts/windows/e2e-clean-verify.ps1`、`frontend/public/site/{index.html,downloads.js}`、`scripts/jiangjie-preview.nginx.conf`、`docs/release-ops-checklist.md` | **工程与静态门禁全部通过**（等待推送后在 GitHub Actions 执行首次端到端试跑） |

### 2. 纯净机 CI 门禁防线说明

`.github/workflows/release-windows.yml` 采用严格的**三段式串行门禁**：
1. **`build-windows`（`windows-latest`）**：`actions/checkout@v4` 显式启用 `submodules: recursive`，带 GitHub Actions Cache 执行 Phase 3 运行时装配、Phase 4 原生壳编译与 CTest、Phase 5 双轨打包与条件代码签名，产出 `Jiangjie-Setup-Online-x64.exe`、`Jiangjie-Setup-Offline-x64.exe`、`*.blockmap`、`SHA256SUMS.txt`、`release-manifest.json`、`feed.json` 及 `latest.yml`/`beta.yml`。
2. **`verify-clean-windows`（独立 `windows-latest` Runner）**：先核对 `SHA256SUMS.txt`，再执行 `scripts/windows/e2e-clean-verify.ps1 -ScrubMachinePath`：
   - **环境净化**：清洗进程与注册表 `PATH` 仅保留 Windows 系统目录，断言 `node`/`python`/`ffmpeg`/`ffprobe`/`conda` 均不可见；
   - **免 UAC 静默安装**：安装至 `%LOCALAPPDATA%\Programs\Jiangjie`，验证 HKCU 卸载项与只读隔离目录；
   - **首启健康门禁**：启动 `Jiangjie.exe`，等待内置 DSH `/bohack/api/health` 返回 **HTTP 200**，断言所有运行时进程均源自安装目录；
   - **中文空格路径火锅冒烟**：在 `%LOCALAPPDATA%\Jiangjie 验收测试\火锅 冒烟 ...` 调用内置 `video-kit\examples\hotpot.v1.json`，断言 `final.mp4` 存在且为 **1280×720、30 fps、H.264 + AAC**，`verify.mjs` 输出 **`VERIFY PASS`**（`pass: true`）；
   - **Job Object 回收门禁**：关闭 `JiangjieApp.exe`，断言 **5 秒内**全部关联子进程（Node / Python / FFmpeg / Chromium / WebView2）数量归零；
   - **静默卸载门禁**：执行 `Uninstall.exe /S /PURGEDATA`，断言安装目录、快捷方式与 HKCU 注册表彻底清除且无残留进程。
3. **`publish-release`（`ubuntu-latest`）**：仅在 `build-windows` 与 `verify-clean-windows` **100% 通过**时才允许运行，二次校验 `SHA256SUMS.txt` 后自动发布至 GitHub Releases，并在配置了对应 Secrets 时按「先不可变版本目录、后动态清单」顺序同步至 S3/Cloudflare R2 或阿里云 OSS。

### 3. 立即触发首次 CI 试跑的操作指令

#### 方式 A：首次无证书干跑试跑（强烈推荐第一步，不污染 GitHub Releases）
先将当前分支推送到 GitHub，再执行以下 `gh` 命令（或在 GitHub 网页 **Actions → Windows Desktop Build, Verify & Release → Run workflow** 中点击运行）：

~~~powershell
# 1. 推送代码到远端主分支（确保包含 .github/workflows/release-windows.yml 与全部子模块 pin）
git push origin main

# 2. 使用 GitHub CLI 触发首次 beta 干跑（自动跑完 build-windows + verify-clean-windows 纯净机门禁）
gh workflow run release-windows.yml `
  --ref main `
  -f channel=beta `
  -f enable_signing=false `
  -f sign_mode=azure-trusted-signing `
  -f rollout_percentage=100 `
  -f publish_release=false

# 3. 实时观察运行日志与结果
gh run list --workflow=release-windows.yml --limit 3
gh run watch
~~~

#### 方式 B：配置代码签名与 ECDSA 密钥后触发正式 Beta / Stable 发布
按 [`docs/release-ops-checklist.md`](release-ops-checklist.md) 第二章配齐 GitHub Secrets & Variables 后，任选其一：

~~~powershell
# 选项 1：推送正式版本标签自动构建、纯净机验收并发布（含 -beta 自动入 beta 通道，否则入 stable 通道）
git tag -a v0.2.1-beta.1 -m "Release v0.2.1-beta.1"
git push origin v0.2.1-beta.1

# 选项 2：手动触发带签名与 10% 灰度的正式发布
gh workflow run release-windows.yml `
  --ref main `
  -f channel=stable `
  -f enable_signing=true `
  -f sign_mode=azure-trusted-signing `
  -f version=0.2.1 `
  -f release_sequence=200 `
  -f rollout_percentage=10 `
  -f publish_release=true
~~~

#### 人工外部上线待办（见 `docs/release-ops-checklist.md`）
- [ ] 官网生产 Nginx 开启强制 TLS 1.2/1.3 与 CDN 分片 Range 回源（禁开二进制自动压缩）
- [ ] 完成微软 Azure Trusted Signing 或企业 EV 证书采购，并在 GitHub Secrets 配置完整变量
- [ ] 生成并注入 ECDSA P-256 更新清单密钥对（`JIANGJIE_FEED_SIGNING_KEY_PEM` + `JIANGJIE_RELEASE_PUBKEY_B64`）
- [ ] 向 Microsoft Security Intelligence、360 开放平台、腾讯电脑管家、火绒完成签名包白名单预提交
- [ ] 干净标准用户 Windows 11/10 VM 真机核验 HTTPS 官网下载、SmartScreen 提示、真会员邀请码登录出片与 10% → 50% → 100% 灰度放量
