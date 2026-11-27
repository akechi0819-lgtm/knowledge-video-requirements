# video-generation-kit：蓝图驱动的视频生成机制（可嵌入包）

## 正式选题的制作入口（本工作区新增）

本地接口由 A 导出确认的内容，B 按题准备逐段场景，再配音和渲染。下面的命令从 hackson 仓库根目录执行。安装视频依赖用 `node video-kit/setup.mjs`，另备可执行的 ffmpeg、ffprobe 和 Chrome / Edge，以及可显示中文的字体。

1. 在蓝图工作区逐段确认并定稿。导出器读取同一工作区的交付、状态及蓝图版本，保留原 B 段号（含 B03a 这样的插段）、讲解内容、事实、用户要求、画面意图和已有旁白。每段需要有可朗读的文本；遇到空旁白，回 A 补齐、确认并重新导出。此步骤可在独立工作区验证。

   ```sh
   node dsh-workbench-fix/dsh-base/packages/bohack-blueprint/scripts/export-production.js "$BLUEPRINT_WORKSPACE" > production.json
   ```

2. 为本次题目生成独立场景。使用已配好的 DSH 模型时，从仓库根目录执行 `sh video-kit/scripts/prepare-scenes-dsh.sh --input production.json --output scenes-v1`。要单独指定文本服务时，设置 `SCENE_API_KEY` 为视觉规划用的文本模型密钥，`SCENE_ENDPOINT` 为完整的兼容 chat/completions 地址，`SCENE_MODEL` 为模型名。脚本逐段提交已确认内容，校验返回的矩形、椭圆、线条、文字和出现时机，保存可复查的数据及渲染用 HTML。适合简单示意动画。人物插画、照片、复杂地图需要 B 另行提供相应场景。B 也可直接给制作单每段填写相对路径 `scene`，指向可信本地 HTML；其 `#stage` 采用本片尺寸，`window.seek(t)` 按秒更新画面，读取注入的 `window.STYLE` 和 `window.__PLAN__`。

   ```sh
   node video-kit/scripts/prepare-scenes.mjs --input production.json --output scenes-v1 --endpoint "$SCENE_ENDPOINT" --model "$SCENE_MODEL"
   ```

3. 选择旁白来源。使用自己的服务时设置 `VIDEO_TTS_ENDPOINT`（完整的 speech 地址）、`VIDEO_TTS_MODEL`、`VIDEO_TTS_KEY`（服务要求认证时）和 `VOICE_NAME`。本入口向服务发送 model、voice、input、response_format=mp3，接收二进制 MP3。按返回音频的实测时长编排整段，不需要词级时间戳。macOS 可用 `--voice say:Tingting` 调用已安装的系统音色，按段实测时长且无词级时间戳；此选项只支持 prepared 入口。省略 `--voice` 会用默认的联网 edge-tts。两种接口都按段读取已确认旁白。密钥通过环境传入。

   小米 MiMo 预置音色使用 `VIDEO_TTS_PROTOCOL=mimo`、`VIDEO_TTS_ENDPOINT=https://api.xiaomimimo.com/v1/chat/completions`、`VIDEO_TTS_MODEL=mimo-v2.5-tts`、`VIDEO_TTS_KEY`，并以 `--voice api:茉莉` 等指定音色。接口返回的 Base64 MP3 会解码后校验；仅支持默认语速。未设置协议时仍使用原有 speech 接口。参考 [MiMo TTS 指南](https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/speech-synthesis-v2.5)。

   ```sh
   node video-kit/WORK/modules/video/pipeline.mjs --prepared scenes-v1/production.json --out film-v1 --voice "api:$VOICE_NAME"
   node video-kit/WORK/modules/video/verify.mjs film-v1/mapping.json
   ```

4. 素材目录和成片目录分别使用新路径。宿主等待进程成功退出，再读取 `final.mp4` 与 `mapping.json`；逐段的 `blueprint_id` 对应 A 的原 B 号，`start_sec` 和 `end_sec` 给出片内位置。自动质检后仍需观看关键画面，核对知识、视觉与旁白的对应关系。

### 来源与验证记录

- 配乐来自随工具提供的 `vendor/vibe-knowledge/skills/vibe-knowledge/assets/music/vibe-bgm.m4a`，旁边的 JSON 记录节拍。每次制作按本片时长裁剪、循环及混音；曲目使用范围见 vendor 的 NOTICE。旧火锅入口使用 `scene.html` 中预写的 HTML/SVG 和 `plan.mjs` 中的动作；下文原包的第 1–9 节说明的是这条原始入口。
- 本地接口验收用了两段折纸测试输入、真实的 A 定稿函数、返回固定图形数据的测试服务，以及由 macOS 中文语音提供 MP3 的本地 speech 测试服务。实际生成约 19.8 秒 MP4，通过混音、静止检测、段落定位和边界帧检查。测试没有调用商业模型，没有验证正式选题的视觉质量或团队 DSH 联调。默认 Edge 配音端点在这台 Mac 的本次连接测试中超时。


把"蓝图 JSON → 成片 + 段落映射"的完整生成机制从原项目抽出，自包含、可冷启动安装。
队友把本目录整体拷进自己的项目即可用；**目录内相对路径（`WORK/…`、`vendor/…`）是机制的一部分，不要打散**。

## 1. 机制一览

```
blueprint.json ──闸门 parse──▶ TTS(edge-tts 词级时间戳 / Windows SAPI 离线)
        │                            │
        │                      plan.mjs（段落+词级时间戳 → 场景 cue）
        │                            │
        │                      render.mjs（scene.html 确定性 seek(t) 逐帧截帧，Edge headless）
        │                            │
        │                      ffmpeg 逐段 clip（旁白 adelay/apad 落窗）→ concat
        │                            │
        │                      mapping.json（段 id → 成片起止秒，ffprobe 实测累加）
        │                            │
        └──────────────▶ finish_bgm.py（强制 BGM 混音 + 响度/真峰值校准）
                                     │
                               qa_windows.py（接触表/响度/静止/BGM 相关性质检）
```

- **画面零生成式模型**：确定性 SVG/HTML 逐帧渲染，同输入同画面（本快照已含渲染抖动修复）。
- **时长不硬卡**：每段 = 段首留白 + 实测旁白音频 + 段尾留白；mapping 起止秒全部实测。
- **失败即停**：任一段 TTS/截帧/编码/校验失败即非零退出，不产出缺段成片。
- **段落可指认**：每帧左上烧录 `S<n>｜标题` 徽章；mapping.json 给出机器可定位区间。
- **费用 0**：edge-tts 走微软公开朗读端点（无 key 不计费）；渲染/混音全本地。

## 2. 目录结构

```
video-kit/
  setup.mjs                  一键安装（npm + venv + pip）
  package.json               playwright-core 依赖
  requirements.txt           edge-tts / numpy / Pillow
  README.md / MANIFEST.md    本文 / 快照来源与便携化改动清单
  examples/                  hotpot.v1.json（已确认示例）、hotpot.v3.json（待确认示例，演示 preview 闸门）
  WORK/
    tools/blueprint.mjs      蓝图 parse/view/diff + 交付闸门（V1–V12 校验）
    modules/video/           管线全部源码（见 §1 流程）+ scene.html 渲染器
  vendor/vibe-knowledge/       上游 MIT 许可与声明（LICENSE / NOTICE.md / THIRD_PARTY.md）
    skills/vibe-knowledge/
      tools/fit_bgm.py         按小节裁 BGM（vendor 原件）
      tools/bgm_force.py       说话时人声/BGM 差值统一校准（vendor 原件）
      assets/music/vibe-bgm.*  默认 BGM 资产（混音与质检相关性检查依赖，勿删）
```

## 3. 环境要求

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 18 | 管线与闸门脚本，ESM |
| Python | ≥ 3.9 | setup.mjs 建 kit 内 `.venv`，不污染系统 |
| ffmpeg / ffprobe | ≥ 4.4，建议 6/8 | 需 `ebur128=peak=true`、`freezedetect`、`acompressor`；**PATH 里若有古老 ffmpeg（如 anaconda 2013）请用环境变量指到新版** |
| 浏览器 | Edge / Chrome / Chromium 任一 | headless 截帧；自动探测常见安装位置，否则 `VIDEO_BROWSER` |
| 中文字体 | Win 自带雅黑；Linux 装 Noto Sans CJK SC；mac 自带 | 画面字幕/标签用系统字体栈 |
| 网络 | edge-tts 需联网 | 离线备选：Windows `--voice sapi`（系统 SAPI，无词级时间戳，同步降级） |

## 4. 快速开始

```bash
node setup.mjs                                            # 装 playwright-core + .venv + pip 依赖
node WORK/modules/video/pipeline.mjs examples/hotpot.v1.json --out out/demo
node WORK/modules/video/verify.mjs out/demo/mapping.json  # 可选：区间/旁白落窗/边界帧验收
```

产物（`out/demo/`）：`final.mp4`（含 BGM）、`final_voice_only.mp4`（混音前纯人声）、
`mapping.json`、`run-log.md`（耗时/调用次数/费用）、`plans.json`、`clips/S*.mp4`、
`audio/`（TTS 缓存）、`qa/`（接触表 sheet.jpg、响度、静止检测）、`bgm.json`。

常用参数：`--out <dir>` 输出目录；`--voice <name|sapi>` 音色；`--force-tts` 强制重合成；
`--allow-unconfirmed` 未确认蓝图跑**工程预览**（必须同时显式 `--out`）。

## 5. 交付闸门（嵌入方必读）

管线开工前强制跑 `WORK/tools/blueprint.mjs parse <blueprint> --json`：

- schema 校验 V1–V12 通过 **且** `confirmation.status=confirmed` 且 `blocking_gaps=[]` → 正式交付；
- 未确认 → 默认**拒绝**；加 `--allow-unconfirmed --out <dir>` 才跑，产物 `mapping.gate.preview=true`，
  run-log 首行标注"工程预览，非正式交付"。**不要把未确认蓝图的产物当正式交付。**
- 蓝图核心字段：`segments[]{id:S1..Sn, title, content, narration, visual_intent, requirement_refs}`、
  顶层 `user_narration`（**各段 narration 逐字拼接必须等于它**，V8）、`confirmation`、`boundaries`。
  完整 schema 与返工 diff 白名单见 `blueprint.mjs` 内校验实现；`view` 子命令渲染人读确认单，`diff` 子命令做改动隔离检查。
- **确认状态只能由真实创作者授予**，集成方代码不得自设 `confirmed`。

## 6. 嵌入你的项目

三种粒度，任选：

1. **整包 CLI（推荐）**：把 `video-kit/` 拷入项目（如 `tools/video-kit/`），宿主代码 spawn
   `node <kit>/WORK/modules/video/pipeline.mjs <blueprint.json> --out <dir>`，读 `<dir>/mapping.json`
   拿成片路径与每段起止秒。kit 自带依赖安装，不与宿主 node_modules/venv 冲突。
2. **段级 API**：`import { buildPlan } from '<kit>/WORK/modules/video/plan.mjs'`、
   `import { renderSegment } from '<kit>/WORK/modules/video/render.mjs'`，自行编排 TTS 与 concat
   （`ffmpeg.mjs` 导出 `concatClips/probeDuration/assertClipPlayable`）。
3. **只取渲染器**：`scene.html` + `render.mjs` + `style.mjs` 可单独复用为"确定性 HTML 时间线截帧"组件。

接口契约 = `mapping.json`（schema `video.mapping.v1`）：`segments[]{id,title,clip,start_sec,end_sec,
duration_sec,narration,narration_audio_seconds,scene_role,frames}` + `final_video` + `gate`。
宿主项目做播放器/字幕/返工定位都消费它。

**改风格/规格只改 `style.mjs`**（分辨率/帧率/调色板/字体/字幕/留白/编码参数唯一来源；
scene.html 通过注入的 `window.STYLE` 读同一份，渲染与编排不会漂移）。

## 7. 环境变量（便携路径层）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `VIDEO_FFMPEG` / `VIDEO_FFPROBE` | 指定 ffmpeg/ffprobe 绝对路径 | 优先使用应用内运行时，源码模式可从受控 PATH 解析 |
| `VIDEO_EDGE_PATH` / `VIDEO_BROWSER` | 指定截帧浏览器绝对路径，`VIDEO_EDGE_PATH` 优先 | Windows 先查 Edge 的 HKCU/HKLM App Paths，再查常规安装路径 |
| `VIDEO_PYTHON` | 指定 TTS、混音、质检用的 Python 绝对路径 | 优先使用应用内运行时，源码模式可使用 kit 内 `.venv` 或本机 Python |
| `VIDEO_PLAYWRIGHT` | 指定 playwright-core 包路径 | kit 根 `node_modules`（require.resolve） |
| `VIDEO_SETUP_PYTHON` | setup.mjs 建 venv 用的 Python 绝对路径 | 优先沿用 `VIDEO_PYTHON` 或解析本机 Python |

Windows 的默认成片目录在 `%APPDATA%\Jiangjie\videos`。使用 `JIANGJIE_DATA_DIR` 和 `JIANGJIE_CACHE_DIR` 可配置项目数据与临时缓存，`JIANGJIE_APP_ROOT` 指向只读应用树。源码模式可以用 `--out` 指定成片目录。

## 8. 已知边界（如实）

- **无段级增量重生成**：返工=整条重跑；复用只在 TTS 缓存层（旁白/音色/语速三者一致才命中，改旁白绝不复用旧音频）。
- **BGM 强制**：finish_bgm/qa 依赖 vendor 子集；qa 检测不到 BGM 相关性会退出 2（规定不能交付）。不要绕过。
- **平台差异**：`--voice sapi` 仅 Windows；qa 接触表字体已做跨平台回退；Linux 需自装 CJK 字体。
- **TTS 缓存按输出目录隔离**：换 `--out` 目录=冷缓存，会重新网络合成（计费 0 但耗时增加）。
- 快照来源、逐文件哈希与便携化改动见 `MANIFEST.md`。
- **vendor 子集上游**：https://github.com/andyhuo520/vibe-knowledge 。代码/文档 MIT（随包附 LICENSE/NOTICE/THIRD_PARTY）；
  **BGM 资产非 MIT**：上游作者授权随工具提供、可用于本工具出的视频，**禁止单独提取分发或出售**（见 vendor/vibe-knowledge/NOTICE.md）。

## 9. 故障速查

| 症状 | 处置 |
| --- | --- |
| `ffmpeg` 报未知 filter / 行为古怪 | PATH 里是古老 ffmpeg；设 `VIDEO_FFMPEG`/`VIDEO_FFPROBE` 或调整 PATH |
| `playwright-core not installed` | kit 根跑 `npm install`（或 `node setup.mjs`） |
| `no Edge/Chrome/Chromium executable found` | 设 `VIDEO_BROWSER` |
| `CONTRACT §7 gate refused` | 蓝图未确认：走创作者确认，或显式 `--allow-unconfirmed --out` 跑预览 |
| edge-tts 网络失败 | 重试；Windows 可 `--voice sapi` 离线降级 |
| 字幕/标签豆腐块 | 装 CJK 字体（Linux：Noto Sans CJK SC） |
# 使用 DSH 生成场景

在工作区运行 `sh video-kit/scripts/prepare-scenes-dsh.sh --input /绝对路径/production.json --output /绝对路径/新场景目录`。脚本使用工作台的 DSH_HOME 与 DSH headless 当前默认模型；需要时沿用工作台的凭据文件向子进程传递密钥，不输出或另存密钥。输出目录必须不存在。可通过 DSH_HOME 环境变量指定其他 DSH 配置。


### 多素材画面

制作 JSON 的每段可通过 `assets` 传入本段需要的已确认素材，格式为 `{ "id": "traveler", "name": "旅行者", "type": "character", "image": "assets/traveler.svg" }`；类型为 `character`、`prop` 或 `background`。路径相对制作 JSON，素材应为已清理、可信的生成 SVG。同一 ID 可在不同段复用。画面模型必须安排该段列出的全部素材，并可逐段设置位置、大小、出现时间与移动目标；无法满足时会报错。原有 `image` 图片入口仍可使用。


讲界通过 `skill-packages/<包>/讲界.manifest.json` 将风格入口对应到已安装的 Skill 和所选模式。内置、预设和独立安装的 Skill 使用同一套逐段制作协议。Agent 读取风格正文及相关文本资料，用 `write_scene` 为每个蓝图段落提交局部 HTML。每个页面包含 `#stage` 和 `window.seek(t)`，`t` 为段内秒数。实际可见的镜头容器通过 `data-shot-id` 标记对应蓝图 B 段号。

宿主以实测配音时长生成 `timings.json`，据此编译和合成时间轴。在每段 25% 和 75% 对应的视频帧，渲染器读取页面内唯一可见的镜头标识，并保留截帧。技术验收可用 `node WORK/modules/video/verify.mjs <mapping.json> <timings.json>` 复查。字幕文本与两张截帧见同一次成片的 `stills/index.html`。

宿主将局部 HTML 放进与宿主页面隔离的主舞台，画面尺寸由 `window.__PLAN__.stage` 提供。任何超出主舞台的像素（包括固定定位元素）都被裁切。Agent 给必须可读的文本节点标记 `data-protected-text`；预览与逐帧渲染检查登记文字的边界和重叠，以及宿主槽位边界。字幕优先使用配音后端的词边界；没有可用边界时，分页时间按实测旁白区间估算。

Skill 可在自身目录的 `jiangjie.stage.json` 声明 `{ "topBar": true, "tailCard": true }`，预设可在 `讲界.manifest.json` 的 `stage` 字段覆盖。默认关闭顶栏，有明确出处时在旁白结束后静默呈现出处；配置 `tailCard: false` 可以关闭片尾，出处仍留在蓝图对应的关键事实。
