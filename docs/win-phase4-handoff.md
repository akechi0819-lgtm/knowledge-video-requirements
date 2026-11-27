# Windows Phase 4 剩余任务交接

**状态：代码与本机编译已完成主要改造，原生版完整冒烟仍有阻塞，尚未达到发布验收。** 工作树位于 `C:\Users\Terry\Desktop\genjiers\repo2`，基线为 `main@c01c4cf`。当前工作树包含多轮未提交修改和新增文件，请在当前工作树续做。先读 [发布规格](win-release-spec.md) 和 [发布进度](win-release-progress.md)。本轮 Phase 4 指桌面壳和首启，安装器、签名和更新属于后续阶段。

## 优先完成

### 1. 排查实际原生窗口首启并完成进程树冒烟

- 当前复现入口是 `.runtime/windows-desktop/native-smoke.ps1`。用旧的 staging EXE 启动后，65 秒内未观察到 `workbench_ready`，预期的 `%LOCALAPPDATA%\Jiangjie\logs\main.log` 也未出现。只读探针 `.runtime/windows-desktop/window-probe.ps1` 枚举到了讲界原生窗口及「一键导出诊断包」子控件，未观察到 Node/WebView2 子进程。控件在建窗时创建，仅凭枚举结果无法判断失败页是否已显示。
- 失败测试使用 `Start-Process -WindowStyle Hidden`。先在交互式 Windows x64 会话运行一遍最新 EXE，观察中文启动提示或错误代码，并核对实际 Known Folder 路径与落盘权限。若仍无主日志，在 `desktop/windows/main.cpp` 的 `Desktop::Run` 和 `StartBrowser` 逐步定位，区分消息循环、日志目录、外层 Job、Node 启动、WebView2 初始化和导航。真实 DSH + DPAPI + 本地模拟模型在浏览器里的链路已通过，优先排查原生桥接。
- **staging EXE 已落后于源码。** 最新编译产物在 `.runtime/windows-desktop/native-Ninja/Jiangjie.exe`，已经包含 COM 初始化顺序调整及更早期的错误代码提示。之前超时的 `build/win-desktop/Jiangjie.exe` 编译时间更早。先同步最新原生二进制和变动的应用文件，或通过 `-StageDirectory` 构建到新的目录，再判断最新源码能否启动。构建脚本会拒绝覆盖已有 staging。
- 实测门禁包括启动画面切到已鉴权的 WebView2、从可见和最小化窗口重复启动时恢复聚焦、只启动一个后端、正常关闭与只强杀主 EXE 后后代不残留。原生 CTest 已验证通用进程树，完整包还要真实观察 Node、WebView2 与媒体进程。启动故障时验证中文错误页仍可操作。
- 当前原生路径使用双层 Job、固定版 WebView2 实际进程路径校验、回环动态端口和同源请求头。保留这些边界。若外层 Job 确实与某种 WebView2 环境冲突，应定位并验证兼容办法，继续满足后代回收要求。

### 2. 验收诊断入口与故障场景

- 从原生帮助菜单、工作台设置和启动失败页分别导出，测试取消、不可写路径、成功提示及 ZIP 内容。诊断 CLI 和脱敏已有测试，原生保存对话框和三条入口尚需实测。
- ZIP 应包含可解析的系统信息、Edge 路径和版本、运行时 BOM 及限量日志，且无凭据。可用包内 Node 复核，入口是 `desktop/windows/diagnostics.mjs export <目标.zip>`。当前导出器依赖包内 Node。如果 Node **本身**被安全软件拦截或缺失，失败页按钮也会报无法启动导出。确认该场景是否需要独立的原生降级导出，并按原始需求完成验收。
- Sentry 兼容 DSN 通过本地替身验证过发送格式和无 DSN 分支。真实上报需要发布方允许的 DSN。用测试凭据和受控环境验证，避免把真实密钥或令牌写入交接材料。

### 3. 收尾媒体和商业化验收

- 本机当前自动化会话能枚举 SAPI 音色，但 `System.Speech.SelectVoice` 返回当前安全设置不可用。已将该失败改为可读的中文提示。下一步在交互式标准用户会话用可用的中文系统音色重跑四段样例。
- 已用 Phase 2 样例缓存的四段旁白启动另一次打包媒体冒烟，输出目录为 `../.phase4-tests/hotpot-cached-d9e43425-7b63-4a3b-bab2-6feb01d4ad9d/output`。交接时至少第一段已由包内 Chromium 渲染并经 FFmpeg 编码，仍需查看是否生成 `verify-report.json` 并检查 `pass: true`、四段及 H.264/AAC。使用缓存旁白的结果只验渲染和编码。
- 完整包实测会员邀请码注册、登录、首次推理、成片、退出重开及凭据恢复。当前通过的是本地会员服务器测试和真实 DSH + 模拟供应商的 BYOK 冒烟。正式或 staging 会员验收需要有效测试邀请码及服务权限。
- 完成后更新 `docs/win-release-progress.md`，区分本机已验证和仍待发布方验收。用干净 Windows 标准用户 VM 验收固定版 WebView2、权限、工作区和媒体依赖。macOS 构建脚本语法已验证，真机构建及签名包回归仍待执行。

## 已通过的验证

- MSVC x64 Release 编译通过。CTest 的 Win32 用例验证 Unicode 路径和动态端口参数、无控制台、正常退出以及强杀父进程后回收子孙进程。最新 CTest 结果在 `.runtime/windows-desktop/native-Ninja/Testing/Temporary/LastTest.log`。
- 诊断相关 5 项通过，覆盖脱敏、日期和大小轮转、实际解包 ZIP、崩溃事件白名单，以及阻止 DSH 另写含原始配置的启动日志。
- 工作台回归 201 项，196 通过、5 跳过，包含实际 DPAPI helper 的密钥保存、旧设置与会员令牌迁移。会员服务器 4 项、视频 Node 31 项、视频 Python 25 项均通过。视频 Python 25 项在中文 SAPI 故障提示的最后一处改动前通过，交付前可再补跑一次。
- 前端 `tsc --noEmit --incremental false` 通过。三份 macOS Bash 构建及启动脚本语法通过。本阶段原生壳使用 C++，没有 Rust 工程要编译。
- Windows 完整 staging 已生成并写入 BOM。浏览器归档由 `scripts/windows/browser-lock.json` 固定为 WebView2 158.0.4370.45 和独立 Chromium 160.0.8185.0。真实 DSH 的浏览器冒烟跑通了 BYOK 模式切换、实际连接测试、DPAPI 保存和刷新恢复。

## 复用入口

- 构建：`scripts/build-win-desktop.ps1`。默认读 `build/win-runtime`，用 `-CompileOnly` 运行原生编译、CTest 和诊断测试。完整构建可通过 `-StageDirectory <新目录>` 保留现有 staging。
- 主窗口与进程：`desktop/windows/main.cpp`、`desktop/windows/workbench_process.cpp`、`dsh-workbench-fix/dsh-base/start-dsh.mjs`、`desktop/windows/dsh-shutdown.mjs`。
- 凭据与账号：`desktop/windows/credential_store.cpp`，以及 workbench 插件的 `lib/windows-credentials.js`、`lib/settings.js`、`lib/membership.js`、`web/settings.js`。DSH 的底层连接服务依赖名为 `credentials` 的插件，Windows staging 已用 DPAPI provider 替换该接口，直接禁用会导致 DSH 启动失败。
- 本机复现辅助：`.runtime/windows-desktop/byok-smoke.mjs`、`native-smoke.ps1`、`window-probe.ps1` 和 `workbench-regression.log`。这些位于 Git 忽略目录，同一台机器可直接复用。
- 本机 Visual Studio 安装起初缺少完整 C++ 文件。可复用 `.runtime/windows-desktop` 内的 SDK、MSVC 补齐文件和 Ninja 构建目录，或使用已装完整组件的 MSVC x64 开发终端。默认沙箱曾阻断环回网络和部分原生测试，运行集成测试时使用允许本机环回的执行环境。把测试临时目录指向工作树旁的 `../.phase4-tests`，可避免对子进程写入系统临时目录的限制。
