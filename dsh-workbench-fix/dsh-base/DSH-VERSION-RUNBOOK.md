# DSH 版本统一 · Agent 执行手册（RUNBOOK v2）

> **用法**：把本文件直接发给你的 agent，附一句「按这份 RUNBOOK 执行」。不需要补充上下文、不需要翻群消息、不需要问版本。
> **适用**：BoHack 2026 减论赛道知识视频工作台；成员含 **Windows 与 macOS**。
> **任意阶段重入都安全**：未开始 / 装了旧版 / 开发到一半 / 版本漂了，都从 §2 自检开始。
> **最后更新**：2026-11-14 01:15（实测依据见附录 A）

---

## 0. 给执行 agent 的契约（必读，先于一切）

1. **本文件自包含。** 不要向用户追问版本、路径、赛事规则；唯一允许提问的条件是命中 §3 的两个例外。
2. **按序执行**：§2 自检 → 判分支 → §4.0a Node 版本 → §4 建立或迁移 → §5 凭据 → §6 验收 → §7 交报告。每步都要**实际运行命令并核对输出**，不能凭描述跳过。
3. **幂等**：重复执行安全。已符合目标状态的步骤记录「已符合，跳过」，禁止重建或清空已有目录。
4. **平台**：Windows 用 PowerShell + `.cmd` 启动器；macOS / Linux 用 bash + `.sh` 启动器。agent 自行判断当前平台。**team 里有 mac 队友，两套启动器都已随本文档提供。**
5. **失败即停**：版本自检不通过就停下报告，**绝不「先跑起来再说」，绝不静默回退到别的版本**。
6. **红线**（违反即视为办砸）：
   - 不删除、不清空、不覆盖任何旧目录（旧 `~/.dsh`、桌面版、`D:\LMY\*`、`Desktop\*` 一律保留）；
   - 不修改系统/用户级 `PATH`、不修改注册表、不 `npm i -g`；
   - 不从旧 `DSH_HOME` 复制 `sessions/`、`cache/`、`.credentials.yaml`、`AGENTS.md`、`skills/`、`settings.yaml` 或任何 `*.jsonl.zstd`；
   - 不引用桌面版自带 CLI（`<desktop>/resources/runtime/cli/bin/dsh.cmd`），它随 nightly 漂移；
   - **不跨平台复制 `node_modules`**（Windows ↔ macOS）：原生模块按 OS / CPU / Node ABI 编译，跨平台必炸。跨平台只共享 `package.json` + `package-lock.json`。

---

## 1. 版本决定（背景事实，不要改）

**目标版本：`@deepseek-ai/dsh@0.2.2-rc.1`，精确锁定（等号，无 `^`）。**
**安装方式：项目内独立 `npm install` + 独立 `DSH_HOME`；不使用桌面版自带 CLI，不全局安装。**
**Node 硬要求：`>=24.9.0`**（`0.2.2-rc.1` 的 `engines.node`，实测 npm 会对 22.x 报 `EBADENGINE`）。这一条比平台差异更优先。

决定依据：

1. **插件集可复现性**。`0.2.2-rc.1` 把每个 `@deepseek-ai/*` 依赖精确锁死为同版本（`dsh-base`、`dsh-skill`、`dsh-mcp-client`、`dsh-session-projection` 等均为 `0.2.2-rc.1`）；`0.1.0-rc.6` 的依赖全是 `^0.1.0-rc.6`，三台机器在不同时间安装会分别解析到 `0.1.0-rc.8` / `0.1.5-rc.1` / `0.1.7-rc.2`——**「主版本一样」不等于 cordis 里实际运行的模块一样**，这才是「拼不到一起」的真正根源。
2. **会话格式**。`@deepseek-ai/dsh-session-persistence` 只有 `0.2.x` 版本线，0.1.x 与 0.2.x 不是同一套持久化实现；本机旧 home 里 `session.jsonl.zstd`、`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd` 三种并存。跨版本共享会话没有保障。
3. **桌面版不可 pin**。`app-update.yml` 为 `channel: nightly`，会自动升级；它自带的 CLI 注释明确「与 app 同版本」。

**版本无关的部分**（迁移时唯一要保住的东西）：模块之间只交换纯文本——Markdown 需求文档、分段蓝图、返工意见。

**「拼得到一起」的完整定义**：主版本 → 同插件集（`package-lock.json`）→ 同会话格式 → 同 `profile` + `cordis.patch.yml` → 各自独立但结构相同的 `DSH_HOME` → 同 Node 大版本。**只对齐第一个数字不够。**

---

## 2. 自检（先跑，输出决定走哪条分支）

Windows（PowerShell）：

```powershell
node -v; npm -v
"OS = " + $PSVersionTable.OS + " / " + [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Get-Command dsh -ErrorAction SilentlyContinue | Select-Object Source
& "$env:USERPROFILE\Bohack\dsh-base\dsh.cmd" --version 2>$null
"DSH_HOME(User)    = " + [Environment]::GetEnvironmentVariable('DSH_HOME','User')
"DSH_HOME(Machine) = " + [Environment]::GetEnvironmentVariable('DSH_HOME','Machine')
Test-Path "$env:USERPROFILE\Bohack\dsh-base\node_modules\@deepseek-ai\dsh\package.json"
Get-Content "$env:USERPROFILE\Bohack\dsh-base\node_modules\@deepseek-ai\dsh\package.json" -ErrorAction SilentlyContinue | Select-String '"version"'
```

macOS / Linux（bash）：

```bash
node -v; npm -v; uname -s; uname -m
command -v dsh || true
~/bohack-dsh-base/dsh.sh --version 2>/dev/null || true
echo "DSH_HOME=$DSH_HOME"
test -f ~/bohack-dsh-base/node_modules/@deepseek-ai/dsh/package.json && grep '"version"' ~/bohack-dsh-base/node_modules/@deepseek-ai/dsh/package.json | head -1
```

再记录四项：

- 工作文件在哪（旧 workspace / 仓库路径），以及 `git status --short`（**迁移必须保持它不变**）；
- 是否已有按 DSH 0.1.x API 写的插件，或只兼容 0.1.x 的社区 profile；
- 赛事方是否指定过 DSH 版本；
- 桌面版是否在运行、`3080` 是否被占用（不影响基座，仅记录）。

分支判定：

| 自检结果 | 走 |
| --- | --- |
| 命中 §3 例外 | §3 回退分支，之后仍走 §4 |
| `node -v` < 24.9.0 | **先 §4.0a 升 Node**，再继续（否则 `npm install` 报 `EBADENGINE`，运行时可能炸） |
| 无基座、无工作文件 | §4.1 → §4.2 → §4.3 → §4.4（全新） |
| 有工作文件、基座不存在或版本不符 | §4.5（**开发中途迁移**），再回到 §4.1–§4.4 |
| 基座已存在且版本正确 | 直接跳 §6 验收 |

---

## 3. 两个例外（命中才改目标版本）

- **赛事方指定了版本 V** → 把本文档中所有 `0.2.2-rc.1` 替换为 V，其余流程不变，报告注明「按赛事方指定」。不要争论。
- **已有按 0.1.x API 写的插件 / 只兼容 0.1.x 的社区 profile，且今晚来不及改** → 目标版本改为 `0.1.0-rc.6`，**并且必须**共享同一份 `package-lock.json`（因为 `^` 会漂）。会话依旧不迁移；Node 要求按该版本的 `engines` 重新核对。

若两条同时命中，以赛事方为准。除这两种情况外一律 `0.2.2-rc.1`。

---

## 4. 建立 / 迁入干净基座

### 4.0 路径约定（agent 按平台解析一次，后文统一用 `<BASE>`）

```
Windows : <BASE> = %USERPROFILE%\Bohack\dsh-base
mac/Linux: <BASE> = ~/bohack-dsh-base
<HOME>  = <BASE>/.dsh-home    独立 DSH_HOME，只由启动器进程级设置
<WORK>  = <BASE>/workspace    只放版本无关的工作文件
```

**`<BASE>` 已存在就复用，绝不删除重建。**

### 4.0a Node 版本统一（跨平台都要做，先于安装）

`0.2.2-rc.1` 要求 `node >=24.9.0`。各平台自行安装到同一大版本（推荐 24.21.x）：

- Windows：`nvm-windows` → `nvm install 24.21.0 && nvm use 24.21.0`，或官网 LTS 安装包；
- macOS：`nvm install 24.21.0 && nvm use 24.21.0`，或 `brew install node@24`；
- 核对：`node -v` 必须 `>=24.9.0`。

**注意**：本机 Windows 系统 node 是 `v22.22.2`，但已存在 `v24.21.0` 的独立二进制（见附录 B）。参考启动器会**在存在时自动把它放到 PATH 最前**（只用二进制，不碰任何 DSH 配置/会话）；其他机器没有这个路径就走系统 node，不达标会明确报错。mac 队友请用 nvm，不要依赖这个 Windows 私有路径。

### 4.1 建目录（幂等）

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Bohack\dsh-base\.dsh-home", "$env:USERPROFILE\Bohack\dsh-base\workspace" | Out-Null
```
```bash
mkdir -p ~/bohack-dsh-base/.dsh-home ~/bohack-dsh-base/workspace
```

### 4.2 写 `package.json`（精确锁，等号）

```json
{
  "name": "bohack-dsh-base",
  "private": true,
  "version": "0.0.0",
  "description": "Isolated DSH base for BoHack 2026, pinned to the exact team version",
  "dependencies": {
    "@deepseek-ai/dsh": "0.2.2-rc.1"
  }
}
```

### 4.3 安装（三条路，按顺序试）

**主命令**（镜像源，先确认 §4.0a 已完成）：

```powershell
npm install --prefix "$env:USERPROFILE\Bohack\dsh-base" --registry=https://registry.npmmirror.com --no-audit --no-fund --fetch-retries=1 --fetch-timeout=60000 --loglevel=warn
```
```bash
npm install --prefix ~/bohack-dsh-base --registry=https://registry.npmmirror.com --no-audit --no-fund --fetch-retries=1 --fetch-timeout=60000 --loglevel=warn
```

**3 分钟无进展 / 404 / ETIMEDOUT** → 换官方源 `https://registry.npmjs.org` 重跑同一条命令。

**install scripts 被拦（npm 11 常见）**：日志出现 `allow-scripts ... packages have install scripts not yet covered` 时，说明 `koffi`、`node-pty`、`@deepseek-ai/dsh-subprocess-local` 等原生模块的构建脚本没跑。按提示执行 `npm approve-scripts --allow-scripts-pending`（或逐包 `npm approve-scripts <pkg>`）后重跑安装；否则这些模块可能在首次运行时才炸。**这一步在 macOS 上尤其不能跳**。

**仍失败 → 兜底复制 `node_modules`**：仅限**同 OS + 同 CPU 架构 + 同 Node 大版本**的队友之间（例如 Windows x64 → Windows x64）。把 `node_modules` + `package-lock.json` + `profiles/<name>` 一起打包。**Windows ↔ macOS 之间绝不复制**（见 §4.6），mac 队友一律自己 `npm install`。

**无论走哪条，都要把 `package-lock.json` 共享给全组**——这是「同插件集」的唯一凭证，也是**唯一能跨平台**的东西。本机已生成（约 437 KB），和本文档放在一起。

### 4.4 启动器（不回退 + 版本自检）

两套启动器都已随本文档提供，**按平台取用**：Windows 用 `dsh.cmd` / `dsh-web.cmd` / `dsh-headless.cmd`，macOS / Linux 用 `dsh.sh` / `dsh-web.sh` / `dsh-headless.sh`（`chmod +x`）。逻辑一致：

1. `set` / `export` 进程级 `DSH_HOME=<HOME>`，覆盖机器全局值；
2. 检查 Node `>=24.9.0`；
3. 检查本地 CLI 存在，**找不到就报错退出，绝不回退**到桌面版；
4. `dsh --version` 必须等于 `0.2.2-rc.1`，否则报错退出；
5. 再执行 `dsh` / `dsh web` / `dsh --profile headless`。

参考实现（mac/Linux，`dsh.sh`；另两个把末行改成 `exec "$CLI" web "$@"` 与 `exec "$CLI" --profile headless "$@"`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME="$BASE/.dsh-home"
TARGET="0.2.2-rc.1"
CLI="$BASE/node_modules/.bin/dsh"
[ -x "$CLI" ] || { echo "ERROR: local CLI missing. Run npm install first." >&2; exit 1; }
NODE_MIN="24.9.0"
NODE_GOT="$(node -p 'process.versions.node')"
[ "$(printf '%s\n' "$NODE_MIN" "$NODE_GOT" | sort -V | head -1)" = "$NODE_MIN" ] || { echo "ERROR: node $NODE_GOT, need >= $NODE_MIN" >&2; exit 1; }
GOT="$("$CLI" --version | tr -d '\r' | head -1)"
[ "$GOT" = "$TARGET" ] || { echo "ERROR: got $GOT, expected $TARGET. Do not fall back." >&2; exit 1; }
exec "$CLI" "$@"
```

Windows 版见同目录 `.cmd` 文件（含可选的本地 Node 24 优先逻辑）。**不要改掉里面的版本自检**。

### 4.4a 三个名词别混：启动器 / profile / 外壳

- **启动器（launcher）= 本基座自写的壳脚本**（`dsh*.cmd` / `dsh*.sh`），**不是 DSH 的概念**。它只做环境准备：进程级 `DSH_HOME`、Node 版本、本地 CLI 存在性、版本自检，最后把参数原样转发给真正的 CLI。它不安装东西、不决定装哪些插件。
- **profile = DSH 的概念**：`$DSH_HOME/profiles/<name>/package.json` 里 `dsh.profile.bundles` 声明的一组**有序插件 patch 层**（CLI 原话：`an ordered stack of plugin-bundle patch layers under your own overrides`）。CLI 的第一个位置参数就是 profile 名：`dsh web` ≡ `dsh --profile web`，`dsh headless "任务"` 同理。用 `dsh --profile <name> --dump-config` 可打印组合后的插件树：实测 web = `dsh-base` + `dsh-web-app` patch，headless = `dsh-base` + `dsh-headless` patch。
- **桌面版 / Web UI / CLI 是同一份 CLI 的三种外壳**：PATH 里的 `dsh.cmd` 只是转发到桌面版自带 CLI 的 shim；`desktop` profile 比 `web` 只多一个 `@tencent-connect/dsh-qqbot`。桌面版额外有 Electron 外壳和 nightly updater，所以不进开发链。

三个启动器的差别**只在最后一行**：`dsh` 透传（profile 由调用方给）、`dsh-web` 固定 `web`、`dsh-headless` 固定 `--profile headless`。**版本锁在 CLI 与 lockfile，profile 锁在 `$DSH_HOME/profiles`，启动器只是把两件事固定住。**

**首次启动的自动行为（迁移必读）**：`<HOME>` 初始为空；第一次真正 boot 某个 profile 时，DSH 会按内置 shipped 模板**自动物化** `$DSH_HOME/profiles/<name>/`（`package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml`），并生成 `.anonymous-user-id`、`storages/`。这是正常初始化，不算污染；§6 验收只禁止 `sessions/` / `cache/` / 旧 home 内容。本机实测：`--dump-config` 后 home 内出现 8 个条目，无会话、无凭据。

**因此自定义 profile 要在首次 boot 前放好**：若队友有自定义 `profiles/<name>` 或 `cordis.patch.yml`（§4.6 允许跨平台共享），先复制到 `<HOME>/profiles/<name>/` 再启动；不要等自动物化后再覆盖（容易半新半旧），更不要用 `--from-default-profile <name>`——它会**用内置模板覆盖自定义 profile**。三台机器必须共享同一份 profile 目录内容，否则「同版本、不同行为」。

### 4.5 开发到一半怎么迁（本节是重点）

**原则：只搬工作文件，不搬任何运行时状态。** 会话历史会丢，这是刻意的——跨版本会话格式不保证可读，强行复用才是「拼不到一起」的原因。

**要搬**：`<WORK>` 里的代码、Markdown 需求文档、分段蓝图、返工意见、测试素材、`package-lock.json`、git 仓库（连 `.git` 一起）、prompt / 配置文本。
**不要搬**：`sessions/`、`cache/`、`.credentials.yaml`、`AGENTS.md`、`skills/`、`profiles/*/node_modules`、`settings.yaml`、任何 `*.jsonl.zstd`、**以及 `node_modules`**（跨平台必须重装）。

步骤：

1. **先备份，只复制不删除**：把旧工作区整体复制到 `<BASE>/_backup/<YYYYMMDD-HHMM>/`。原目录保持原样。
2. 把「要搬」的文件复制到 `<BASE>/workspace/`。若是 git 仓库，保留 `.git`；完成后 `git status --short` 必须与迁移前**完全一致**。
3. `<HOME>` 保持为空。旧 `DSH_HOME`、旧 CLI、桌面版**全部保留不动**，只是从此不再使用。
4. 按 §4.0a–§4.4 建好基座（已有则复用），按 §5 重新配置凭据。
5. 在 `<WORK>` 里跑一次完整链路验证：Markdown 需求 → 分段蓝图 → 能按段落编号定位。跑通才算迁移完成。
6. 若需留档旧会话：只读导出为文本放 `<WORK>/_archive/`，**不要**放进 `<HOME>`，也不要让新版本去读它。

**任意时点重入**：中途断掉、换人接手、换了 agent，都从 §2 自检重新开始；已完成的步骤显示「已符合」，不会重复破坏现场。

### 4.6 跨平台分界（mac 队友必读）

Node.js 是跨平台的，但「JS 层跨平台」不等于「整个环境能整包复制」：

| | 跨平台吗 | 处理 |
| --- | --- | --- |
| `package.json` / `package-lock.json` | ✅ | **直接共享**，lockfile 里已包含 `darwin-arm64` / `darwin-x64` / `win32-x64` / `linux-*` 等所有平台的 optional 依赖，npm 会按 `os` + `cpu` 自动挑 |
| Markdown 需求 / 分段蓝图 / 返工意见 | ✅ | 正式交接契约，纯文本，随便传 |
| `profiles/<name>`、`cordis.patch.yml` | ✅（但别写绝对路径） | 里面若出现 `C:\...` 之类硬编码，mac 上会炸；用相对路径 |
| `node_modules` | ❌ | 含 `koffi`、`node-pty`、`node-addon-*-win32-x64-msvc`、`libreoffice-kit-darwin-*`、`sharp-*` 等按 OS / CPU / Node ABI 编译的原生模块，**各平台各自 `npm install`** |
| 启动器 `.cmd` / `.sh` | ❌ | 各用各的，已各提供一套；`.sh` 必须 LF 行尾 |
| `sessions/` / `.credentials.yaml` | ❌（且不该搬） | 会话格式与机器绑定；凭据各人重填 |
| Node 版本 | 数值要一致 | 全组 `>=24.9.0`，推荐同为 24.21.x；跨 Node 大版本要重新 `npm rebuild` |

**结论**：mac 队友的存在恰好说明应该走「共享 lockfile + 各自安装」，而不是「复制 node_modules」。lockfile 是跨平台契约，`node_modules` 只是本地产物。Apple Silicon（`arm64`）与 Intel mac（`x64`）之间同样不要互拷。

---

## 5. 凭据与模型

全新 `<HOME>` 没有 API key。**不要从旧 home 复制 `.credentials.yaml`**（可能绑定旧模型配置与权限预设）。首次启动后：

- Web UI：`Settings → Models` 填入 DeepSeek API key（凭据以 write-only 存于 `<HOME>/.credentials.yaml`）；
- 或 TUI 里 `/model add`；
- 模型与权限预设按各人习惯重设，**不要求全组一致**（不影响插件集与会话格式）。

---

## 6. 验收清单（必须全绿，agent 逐条实际核对）

- [ ] `node -v` ≥ `24.9.0`，且全组同一大版本
- [ ] 记录了本机 OS / CPU 架构（Windows x64 / macOS arm64 / macOS x64）
- [ ] `<BASE>/dsh.cmd --version`（或 `dsh.sh --version`）输出 `0.2.2-rc.1`
- [ ] `node_modules/@deepseek-ai/dsh/package.json` 的 `version` 为 `0.2.2-rc.1`
- [ ] `npm ls @deepseek-ai/dsh --prefix <BASE>` 无 `invalid` / `extraneous`
- [ ] `package-lock.json` 存在，且**已共享给全组**（mac 队友用同一份）
- [ ] install scripts 已确认执行（无 `allow-scripts pending` 遗留）；原生模块在该平台可用
- [ ] 启动器设置了进程级 `DSH_HOME=<HOME>`，无桌面版路径、无回退分支
- [ ] `<HOME>` 内没有 `sessions/`、`cache/` 或旧 home 的任何内容
- [ ] 用户级 / 机器级 `DSH_HOME`、`PATH`、注册表、旧 `~/.dsh` 的 mtime **均未变化**
- [ ] 工作文件齐全，`git status --short` 与迁移前一致（全新分支则为空）
- [ ] 一次真实调用可跑通（`dsh-headless` 跑一句话任务，或至少 `dsh --dump-config` 无报错）
- [ ] 完整链路验证：Markdown 需求 → 可确认、段落可识别的分段蓝图 → 能指出某段对应的蓝图位置

---

## 7. 交付报告模板（agent 必须输出，可直接转发群里）

```
DSH 基座对齐完成
- 目标版本：0.2.2-rc.1（精确锁）｜例外：无 / 按§3改为 ___
- 平台 / 架构：Windows x64 / macOS arm64 / macOS x64
- Node：<版本>｜npm：<版本>
- BASE：<路径>｜分支：全新 A / 中途迁移 B / 已符合直接验收
- 安装方式：npm 镜像源 / 官方源 / 同平台复制 node_modules
- install scripts：已执行 / 待处理（pending 包：___）
- lockfile：<路径>  已共享：是/否
- 旧目录：未改动（旧 DSH_HOME、桌面版、PATH、注册表）
- 验收：___/___ 通过；未通过项与处理：___
- 待补：API key / 队友已装插件时的兼容确认
```

---

## 8. 故障处理表

| 现象 | 处理 |
| --- | --- |
| `npm warn EBADENGINE ... required node >=24.9.0` | 按 §4.0a 升 Node 后**重新安装**，不要忽略警告继续 |
| `npm install` 卡住 > 3 分钟、无 `node_modules` | 终止，换官方源重跑；再失败走 §4.3 同平台兜底 |
| 镜像源 404 / ETIMEDOUT | `--registry=https://registry.npmjs.org` |
| `allow-scripts ... install scripts not yet covered` | `npm approve-scripts --allow-scripts-pending` 后重装；mac 上尤其不能跳 |
| 原生模块报 ABI / `NODE_MODULE_VERSION` / `koffi` / `node-pty` 加载失败 | 确认 Node 大版本一致 → `npm rebuild`；**不要从 Windows 拷 mac 的 `node_modules`** |
| `ERR_PNPM_ADDING_TO_ROOT`（装插件时） | 加 `--ignore-workspace-root-check`，或 `npm_config_ignore_workspace_root_check=true` |
| 启动器报 `got X, expected Y` | **停止**，核对 `package.json` 与 `node_modules`；不要改成「允许别的版本」 |
| 启动器报 `Node 24.9.0 or newer required` | 按 §4.0a 装 Node 24；Windows 可参考附录 B 的本地二进制 |
| 报缺 API key / 模型未配置 | 按 §5 重新填，不要拷旧凭据 |
| 旧会话读不出来 | 不要修，新开会话；旧会话只读导出为文本留档 |
| `3080` 被占用 | 旧 `dsh web` 或桌面版在跑；基座不受影响，换端口或关掉旧进程（**不要删它的文件**） |
| `git status` 与迁移前不一致 | 停止，从 §4.5 第 1 步的备份恢复，不要继续 |
| mac 上 `.sh` 报 `bad interpreter` / `\r` | 行尾转成 LF：`sed -i 's/\r$//' *.sh && chmod +x *.sh` |

---

## 9. 红线复述（给赶时间的 agent）

**不要删旧目录，不要改全局 PATH / 注册表，不要 `npm i -g`，不要用桌面版自带 CLI，不要复制旧会话 / 凭据 / AGENTS.md / skills，不要跨平台复制 `node_modules`，版本或 Node 不达标就报错退出而不是回退。** 版本不一致会让 cordis 里的模块集和会话格式全都不同；跨平台复制 `node_modules` 会让原生模块直接加载失败。

---

## 10. 群里对齐话术（可直接复制）

> 版本统一结论：**`@deepseek-ai/dsh@0.2.2-rc.1`，精确锁，项目内独立安装 + 独立 DSH_HOME，不用桌面版自带 CLI**；另外**全组 Node 要 >=24.9.0**（这个版本的硬性要求，22.x 会报 EBADENGINE）。
> 原因：0.2.2-rc.1 把所有 `@deepseek-ai/*` 依赖精确锁成同版本，0.1.0-rc.6 是 `^0.1.0-rc.6`，三个人装出来 cordis 跑的模块会不一样；会话持久化 0.1.x / 0.2.x 也不是一套实现。桌面版是 nightly，会自动升，不能拿来对齐。
> 随附 `DSH-VERSION-RUNBOOK.md`：**把这份文件甩给你的 agent 说「按 RUNBOOK 执行」即可**，不管你现在是没开始还是已经写了一半，它都会先自检再决定全新装还是迁移，不会删你现有文件。
> **mac 队友注意**：用目录里的 `.sh` 启动器（`chmod +x`），自己 `npm install`，**别拷 Windows 的 `node_modules`**（原生模块不跨平台）；`package.json` 和 `package-lock.json` 是全组共用的，装完请把 lockfile 发群里。
> 模块之间仍然只交换纯文本（Markdown 需求 / 分段蓝图 / 返工意见），这一层与版本、平台都无关。
> 两个例外请回一声：① 赛事方有没有指定版本；② 你有没有写过 0.1.x 的插件或装了只兼容 0.1.x 的 profile。

---

## 附录 A：本机实测事实（2026-11-14，决定依据）

| 事实 | 来源 |
| --- | --- |
| `D:\LMY\dsh-control\bin\dsh.cmd --version` → `0.2.2-rc.1` | 本机实测输出 |
| 注册表 `DeepSeek Harness` → `0.2.2-rc.1`，安装于 `D:\LMY\dsh-desktop` | 注册表 Uninstall 项 |
| CLI shim 转发到桌面版自带 CLI，注释「always same version as the app」 | `dsh-control/bin/dsh.cmd` 原文 |
| 桌面版 `app-update.yml`：`channel: nightly` | 文件原文 |
| `DSH_HOME` 为 User + Machine 两级全局变量 `C:\Users\24178\.dsh` | 环境变量实测 |
| 旧 home：4 个 profile、9 个自定义技能、`AGENTS.md`、23 个会话目录、`danger-full-access`、`session.jsonl.zstd` / v3 / v4 混杂 | 目录清点 |
| `@deepseek-ai/dsh@0.1.0-rc.6` 依赖 `^0.1.0-rc.6`；`@0.2.2-rc.1` 依赖精确锁 `0.2.2-rc.1` | `npm view ... dependencies --json` |
| `@deepseek-ai/dsh-session-persistence` 仅 `0.2.x` 版本线 | `npm view ... versions` |
| `0.2.2-rc.1` 的 `engines.node` = `>=24.9.0`；本机系统 node `v22.22.2` 触发 `EBADENGINE` | `package.json` + 安装日志 |
| 本机另有独立 Node `v24.21.0`（`.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`） | 实测 `node -v` |
| `package-lock.json` 含 `darwin-arm64` / `darwin-x64` / `win32-x64` / `linux-*` 等 optional 平台包 | lockfile 扫描 |
| 安装日志：`allow-scripts` 拦了 5 个 install scripts（含 `koffi`、`node-pty`、`dsh-subprocess-local`） | npm 输出 |
| npm `latest` = `0.2.2-rc.1`；`0.1.0-rc.6` 在镜像源装 7 分钟无产出（已终止）；`0.2.2-rc.1` 实测 **2m34s / 652 包** 装成 | 实测 |

## 附录 B：参考基座现状（本机 Windows，可连同本文档打包给队友）

```
<BASE> = C:\Users\24178\Bohack\dsh-base
├── DSH-VERSION-RUNBOOK.md   ← 本文件
├── package.json             ← 精确锁 0.2.2-rc.1
├── package-lock.json        ← 已生成（437 KB），需共享给全组
├── dsh.cmd / dsh-web.cmd / dsh-headless.cmd   ← Windows
├── dsh.sh  / dsh-web.sh  / dsh-headless.sh    ← macOS / Linux（LF 行尾，需 chmod +x）
├── node_modules/            ← 本机产物，Windows x64 + Node 24，禁止发给 mac 队友
├── .dsh-home/               ← 独立 DSH_HOME，保持为空直到首次启动
└── workspace/               ← 只放版本无关的工作文件
```

本机启动器自检实测：`dsh.cmd --version` → `0.2.2-rc.1`，`.dsh-home` 仍为空，旧 `~/.dsh` 未改动。启动器里的 `NODE24` 只是**可选的本机 Node 24 二进制**（不涉及 DSH 配置与会话）；其他机器没有该路径会自动跳过，走系统 node，不达标就报错。
