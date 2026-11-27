# 讲界视频工坊

## Mac 桌面工作台（邀请码内测）

[官网下载 macOS 内测 DMG](https://jiangjie.gingers.cloud/#downloads)。启动时会播放随包提供的介绍轮播。使用邮箱、密码和运营方私发的一次性邀请码注册。当前平台文本模型为 GPT-6.1 Terra，中文配音使用 MiMo「茉莉」。Agent 调度、素材保存、渲染和导出在用户 Mac 上完成；账号、赠片授权和模型转发由公网会员服务管理。新版桌面端已支持通过欧云收银台扫码购买 6 元周卡。[Windows x64 内测安装包](https://jiangjie.gingers.cloud/#downloads)也在官网下载。

在 macOS 14 或更高版本的 Apple Silicon Mac 上挂载 DMG，把「讲界」拖到「应用程序」后打开。App 内置 DSH、Node.js、Python、Chromium、FFmpeg 和 ffprobe，中文渲染沿用 macOS 自带字体。关闭窗口或退出时，本次启动的 DSH 会一并停止。本次内测包使用临时签名，正式分发需要 Developer ID 和 Apple 公证。

数据默认保存在 `~/Library/Application Support/讲界/`。项目位于 `workspace/threads/`，个人 DSH 配置位于 `dsh/`。App 读取该目录下的 `dsh/workbench-model.env`。主页的「导入项目包」支持旧版原始 JSON 快照（`version: 1`，包含 `files`）。从「最近创作」可以重新打开已导入的项目。

### 会员账号与自配 API

桌面版默认使用会员模式。新账号使用一次性邀请码注册后获赠 3 条。创建或打开项目时不扣额度，第一次调用平台 AI 时开片。同一条片的后续对话、素材、配音和制作共用授权，成片成功后结算。周卡有效期 7 天。会员服务按文本用量计费，配音单独记录。周卡额度用尽后会暂停平台制作，买新周卡后可继续原任务。普通用户无需供应商密钥。切到高级模式后，通用模型和配音请求直接发往自配地址，密钥保存在 macOS 钥匙串。

画面 Agent 等待模型 2 分钟没有新的工具进展时会提示仍在等待，5 分钟时暂停；正在执行的制作工具仍使用 10 分钟上限。明确的上游报错无需等到超时，成片工作台会用中文解释并提示下一步。会员模式可在成片页点「继续制作」，也可在创作对话中说「继续制作」，继续原任务并尽量复用已保存的画面和配音。

公网内测的会员地址为 `https://jiangjie.gingers.cloud/desktop-membership`，邮箱用于登录，内测暂不发送验证邮件。部署、发码和周卡支付见[会员服务说明](membership/README.md)。联调时可用 `JIANGJIE_MEMBER_URL` 指定测试地址，分发包在构建时内置公网地址。桌面 Agent 默认使用 Chat Completions，也可通过 `JIANGJIE_MEMBER_AGENT_API=openai-responses` 走 Responses。场景和视觉分析仍要求平台文本供应商支持 Chat Completions。

### 构建和分发

构建机需要 Apple Silicon、Xcode Command Line Tools、已检出的项目 Skill 子模块，以及下载依赖用的网络。依赖缓存写入 `.runtime/`。App 在系统临时目录组装和签名，避免桌面同步目录添加扩展属性。首次构建会编译 FFmpeg 和音视频编码依赖。DMG 内带对应源码、构建脚本和许可证。

```sh
app="$(JIANGJIE_MEMBER_URL=https://jiangjie.gingers.cloud/desktop-membership ./scripts/build-desktop.sh)"
./scripts/package-desktop.sh "$app" "$PWD/.runtime/讲界-arm64-本地验收.dmg"
```

正式包构建和打包时使用同一个 `JIANGJIE_SIGN_IDENTITY`，值为钥匙串内有效的 Developer ID Application 签名身份。打包时同时设置 `JIANGJIE_NOTARY_PROFILE`，对应 `notarytool store-credentials` 已保存的钥匙串配置。脚本等待 Apple 接受后为 DMG 附票，并执行附票和 Gatekeeper 检查。正式验收还需要在一台干净的 Apple Silicon Mac 上从 DMG 安装并导出已有项目。

### Windows x64 构建与发布

Windows 版采用原生 C++20 Win32 宿主与固定版 Microsoft Edge WebView2 运行时，内置完整 Node.js、Python、Chromium 与 FFmpeg 运行时，支持免管理员权限安装、Job Object 子进程回收、Windows DPAPI 全量加密凭据存储（含会员令牌与自配密钥）、三入口诊断包导出、以及组件级增量自动更新与启动失败自动回滚。用户数据与项目默认保存在 `%APPDATA%\Jiangjie`，程序版本树安装在 `%LOCALAPPDATA%\Programs\Jiangjie`。

本地在具备 MSVC（Visual Studio 2022/2026）、CMake、NSIS 与 PowerShell 7.2+ 的 Windows x64 构建机上执行：

```powershell
pwsh -File scripts/windows/bundle-runtime.ps1
pwsh -File scripts/build-win-desktop.ps1 -AppVersion 0.2.1 -ReleaseSequence 2
pwsh -File scripts/windows/build-release.ps1 -Version 0.2.1 -ReleaseSequence 2 -Channel beta
```

CI 发布门禁位于 `.github/workflows/release-windows.yml`，按「`build-windows`（运行时组装、C++ 编译与单测、双轨在线/离线安装包及组件差分包）→ `verify-clean-windows`（纯净机 PATH 清洗后安装、桌面启动、`/bohack/api/health` 与 `/bohack/api/desktop/busy` 验收、卸载回归）→ `publish-release`（上传 GitHub Release 与清单）」三阶段执行；官网 `#downloads` 由 `frontend/public/site/downloads.js` 动态读取 `/downloads/release-manifest.json`，服务器上线可使用 `scripts/deploy-win-release-server.sh`。

## 旧网页预览的自托管说明

[讲界官网](https://jiangjie.gingers.cloud/) 提供产品介绍、成片演示和桌面版下载。旧 `/bohack/` 链接跳转到下载区。下面是仓库保留的自托管预览实现说明。

在自行部署的预览中，体验者打开网页即可使用，无需安装依赖、注册或订阅。制作在服务器运行，每个浏览器分配独立容器。通用文本、代码和看图由服务器配置的多模态模型统一处理，优先适配 GPT 6.1 Terra；配音默认使用小米 MiMo，独立填写小米 Key，也可选择其他兼容 OpenAI Speech 的服务。个人 API Key 仅保存在该实例内存中。模型费用由各自的服务商账户结算。

设置页主要配置通用文本/代码、配音两类模型；同一服务商且权限通用时可共用一把 Key。音色属于配音服务：MiMo 预设使用“茉莉”，其他服务填写各自支持的音色 ID，切换服务不会沿用小米音色。独立工具路由折叠在高级设置中；生图接口暂未接入制作，无需配置。

项目通过浏览器 IndexedDB 保存在用户电脑上，页面空闲时自动保存，也可点击“保存到本机”。恢复时选择“本机项目”并点击“恢复”。清除浏览器站点数据会删除本机副本。制作所需资料会临时上传服务器，并传给所选模型或配音服务商。临时制作实例保留 24 小时；实例全部占满时，网关会优先回收空闲超过 10 分钟的实例（`GATEWAY_IDLE_EVICT_MS`），无法回收时等待页会显示排队原因并自动重试。预览服务器默认同时容纳四个实例（`GATEWAY_MAX_WORKERS`），并维护预热容器池（`GATEWAY_WARM_SIZE`）让新会话几乎立即进入工作台。容量按单机 CPU 与内存配置；更大并发时按机器数横向部署多组网关，负载均衡需按会话 Cookie 固定后端。下文安装步骤用于开发与自托管。

服务端入口为 `scripts/cloud-gateway.mjs`，每个实例运行 `scripts/cloud-worker.mjs`。运行镜像由 `preview.Dockerfile` 和 `preview-worker.Dockerfile` 构建。网关只暴露工作台路由，容器内 DSH 管理入口通过内部端口访问。

视频制作接收定稿蓝图与选定风格。内置风格、快捷预设及独立安装的 Skill 共用讲界宿主。制作 Agent 读取选中风格的正文与资料，按蓝图段落提交局部 HTML。宿主统一负责配音、真实时长、段落顺序、字幕、可选顶栏与片尾、逐帧渲染、BGM 混音和交片验收。模型画面裁切在独立主舞台，几何检查覆盖宿主槽位和登记的关键文本。配置的配音接口失败时，宿主尝试平台备用音色，并在任务进度和运行记录中标明。

任务目录的 `timings.json` 记录段落时间轴、旁白起止及配音后端提供的逐字边界。宿主在各段 25% 和 75% 的画面中读取可见镜头标识，生成 `film/mapping.json`，并写出 `film/verify-report.json` 与 `film/stills/index.html`。映射缺失、段落错位、视频解码失败或出现全黑帧时，成片停留在验收目录。运行用时和命令错误摘要分别见 `timings.jsonl` 和 `commands.jsonl`。

定稿后直接进入配音与局部 HTML 画面制作。资料库中已确认的成片图片随片放入 `现成素材/`，显式关联蓝图段落的图片同时绑定到相应段落。制作 Agent 默认总预算 60 分钟、空闲预算 12 分钟，可分别用 `BOHACK_VIDEO_BUDGET_MS` 和 `BOHACK_VIDEO_IDLE_MS` 调整。模型流瞬断时，原会话默认自动重试两次，次数可用 `BOHACK_VIDEO_TRANSIENT_RETRIES` 调整。自动重试和手动续跑均沿用当前任务已保存的局部场景与配音缓存。

首次安装风格 Skill 时，在仓库根目录运行 `git submodule update --init`。

桌面版的 `vibe-knowledge-film` 和 `vibe-know--skill` 含上游限制再发布的参考片材料，应用不直接携带。使用前可在终端运行 `bash /Applications/讲界.app/Contents/Resources/scripts/install-external-skills.sh`，从原作者仓库安装固定版本到 `~/Library/Application Support/讲界/workspace/.agents/skills/`；应用位于其他位置时请相应调整命令。已存在的目录不会覆盖。

## 三模块工作台与正式演示

[播放或下载 90 秒火锅成片](交付/没有美洲火锅会少些什么_90秒/没有美洲，火锅会少些什么？.mp4) · [定稿蓝图](交付/没有美洲火锅会少些什么_90秒/定稿蓝图.md) · [逐段核对](交付/没有美洲火锅会少些什么_90秒/逐段核对.md)

完整工作台使用 DSH 对话整理需求、上传资料、生成并确认蓝图。使用工作台内置风格时，独立视频 Agent 可按蓝图和已确认素材编写各段 HTML/CSS/JavaScript，调用配音、预览、渲染、质检与提交工具完成视频；成片页也可选择「原结构化模式」，由模型输出图层数据，再交给固定渲染器。安装和启动见[工作台部署说明](dsh-workbench-fix/dsh-base/部署说明-队友机.md)与[视频模块说明](video-kit/README.md)。原有 1 号模块仍可按下方说明独立运行。

蓝图用于确认内容梗概、事实、出处和用户要求。可执行 Skill 有自身分镜与节奏时按其规划编排，缺少规划时沿用蓝图顺序。选用无旁白 Skill 可直接提交整片，无段落映射时用完整播放器观看。首页可选择制作风格或 Skill；待编码的角色、道具等素材由独立 Agent 按选中 Skill 的视觉规范制作，逐变体查看并提交素材清单后自动交给成片 Agent。项目保留素材文件、预览和生成源码，成片后可以查看素材或按反馈重做单件。视频返工可以读取上一版段落源码并复用符合条件的旁白。可在设置中从公开 GitHub 整仓导入 Skill，先检查依赖提示并勾选要启用的 Skill。安装记录保留来源和 commit SHA。粘贴文字和参考视频提取均作为纯视觉参考使用。需求、蓝图、视频 Agent 与素材、预览、风格分析工具可分别设置模型，见[工作台部署说明](dsh-workbench-fix/dsh-base/部署说明-队友机.md#项目模型与风格库)。

本次演示使用普通话晓晓音色。完成视频依赖安装后，在仓库根目录运行以下命令，可从随附的定稿制作单重新渲染。输出目录需为新路径，神经配音需要网络。

```sh
demo='交付/没有美洲火锅会少些什么_90秒'
out=$(mktemp -d)
node video-kit/scripts/hotpot-scenes.mjs --input "$demo/production.json" --output "$out/scenes"
VIDEO_TTS_RATE=+7% node video-kit/WORK/modules/video/pipeline.mjs --prepared "$out/scenes/production.json" --out "$out/film" --voice zh-CN-XiaoxiaoNeural
node video-kit/WORK/modules/video/verify.mjs "$out/film/mapping.json"
```

如在工作台新创作中复演此片，先上传同目录的“火锅餐桌.png”，并把“hotpot-demo-scene.json”复制到该创作的 `workspace/threads/<会话 ID>/` 目录，以启用本题五段专用场景。启动工作台前设置 `VIDEO_VOICE=zh-CN-XiaoxiaoNeural`、`VIDEO_TTS_RATE=+7%`，并将 `VIDEO_PYTHON` 指向安装了 video-kit 依赖的 Python。


## 独立需求整理模块（源码运行）

仅使用需求整理模块的开发者可以从下列命令启动。该入口生成 Markdown 需求和可移动的资料交接包。桌面版用户从上方 DMG 安装即可。

独立入口使用 DSH `0.2.2-rc.1`、Node.js 24 和 Python 3。需要新安装 DSH 时可在有网络的环境执行：

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
node --version
dsh --version
```

解压后在本目录打开终端，运行：

```sh
./start-requirement-dialogue.sh --port 3080
```

根据启动提示在浏览器打开本机服务；按提示完成本人账户配置。不要转发包含登录令牌的启动地址。在 DSH 添加本目录为工作区并选择它，再新建对话。脚本以自身位置确定工作区，不需要沿用原机器目录。保持启动进程运行；端口占用时更换端口。

`AGENTS.md` 是 DSH 会话规则；`.dsh/skills/` 为补充技能，原生入口依赖前者。只在作者明确要求开始整理时输出任务文件。目标目录已存在时使用新目录；不得覆盖历史交付。

## 文件与使用

- `scene_retrieval.py`：本地原文定位、索引、按问题查询和单次任务打包，使用 Python 标准库。详细命令见 `场面引用检索使用说明.md`。
- `交接1_视频需求文档模板.md`：需求字段；`交接2`、`交接3` 和 PRD 说明后续团队职责。
- `dsh/requirement-dialogue.patch.yml`：标准模式工具配置；网页搜索开启，网页正文抓取关闭。搜索摘要是候选，不表示已核实正文。
- `需求对话模块_施工文档.md`：设计、历史实测和待联调事项，其中机器及样例状态均为原测试环境记录。
- `tests/`：检索和交接包回归测试；安装 pytest 后在本目录运行 `python3 -m pytest -q tests/test_task_package.py tests/test_scene_retrieval.py`。

本地长文默认以 GB18030 解码，其他编码使用 `--encoding` 指定。章内可以按自然段确定起止边界；跨多章选择时中间章节会整章收录，需先核对。查询的 `found` 是词面命中，`candidate` 是待核对候选，`not_found` 仅表示当前索引未找到依据。模型和检索结果均需人工审阅。

## 给蓝图模块的接入约定

需求侧在本地准备好一次任务的交接目录后，将该目录交由蓝图模块读取。最小输入是包内 `视频需求.md`；有本地原文索引时，同目录还包含 `资料索引.json` 和 `scene_retrieval.py`。未带索引的包不具备本地引用查询能力。蓝图模块需要核实具体场面时，可在交接包目录中按问题调用：

```sh
python3 ./scene_retrieval.py query --index ./资料索引.json --query '要核实的问题'
```

命令以 JSON 返回引用、位置和状态。查询是词面检索，不自动判断答案是否成立；请读取具体引文及上下文。桌面工作台在需求确认后调用蓝图模块，创作者可查看生成的分段和示意图，再确认制作。
