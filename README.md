# 知识视频需求整理模块：交接说明

## 三模块工作台与正式演示

[播放或下载 90 秒火锅成片](交付/没有美洲火锅会少些什么_90秒/没有美洲，火锅会少些什么？.mp4) · [定稿蓝图](交付/没有美洲火锅会少些什么_90秒/定稿蓝图.md) · [逐段核对](交付/没有美洲火锅会少些什么_90秒/逐段核对.md)

完整工作台使用 DSH 对话整理需求、上传资料、生成并确认蓝图，再调用 video-kit 制作成片。安装和启动见[工作台部署说明](dsh-workbench-fix/dsh-base/部署说明-队友机.md)与[视频模块说明](video-kit/README.md)。原有 1 号模块仍可按下方说明独立运行。

确认蓝图、完成定稿后，在「成片」页点选本版的参考风格，再开始制作。也可以导入外部 SKILL.md，或从一段参考视频提取个人风格。模型挂载与学习范围见[工作台部署说明](dsh-workbench-fix/dsh-base/部署说明-队友机.md#项目模型与风格库)。

本次演示使用普通话晓晓音色。完成视频依赖安装后，在仓库根目录运行以下命令，可从随附的定稿制作单重新渲染。输出目录需为新路径，神经配音需要网络。

```sh
demo='交付/没有美洲火锅会少些什么_90秒'
out=$(mktemp -d)
node video-kit/scripts/hotpot-scenes.mjs --input "$demo/production.json" --output "$out/scenes"
VIDEO_TTS_RATE=+7% node video-kit/WORK/modules/video/pipeline.mjs --prepared "$out/scenes/production.json" --out "$out/film" --voice zh-CN-XiaoxiaoNeural
node video-kit/WORK/modules/video/verify.mjs "$out/film/mapping.json"
```

如在工作台新创作中复演此片，先上传同目录的“火锅餐桌.png”，并把“hotpot-demo-scene.json”复制到该创作的 `workspace/threads/<会话 ID>/` 目录，以启用本题五段专用场景。启动工作台前设置 `VIDEO_VOICE=zh-CN-XiaoxiaoNeural`、`VIDEO_TTS_RATE=+7%`，并将 `VIDEO_PYTHON` 指向安装了 video-kit 依赖的 Python。


本包交付需求整理与资料交接模块。它与创作者对话，生成 Markdown 视频需求；有用户提供的本地长文时，可筛选相关原文并生成可查询索引。作者要求开始整理后，由程序生成可移动的单次任务交接包。

## 分工边界与状态

- 需求负责人：使用本模块整理创作者意图、明确要求、待确认创意及资料线索，准备本地交接包。
- 同学 A：接收需求、起草分段蓝图并请创作者确认；实际接收端和 DSH 跨模块调用尚未联调，本包不是已发送给 A 的证明。
- 同学 B：根据已确认蓝图负责视频制作；本包不包含蓝图生成或视频制作功能。

## 安装与启动

本包包含源码、规则、配置和测试，不含 Node.js、DSH 安装包、任何模型凭据或用户资料。上游实测 DSH `0.2.2-rc.1`、Node.js `24.22.1` 和 Python 3；接收者需要自行准备 Node.js 24（DSH 要求至少 24.9.0）、Python 3，以及可用的 DeepSeek 模型凭据。按团队环境配置账号或凭据，不要把凭据写进本包或发给他人。需要新安装 DSH 时可在有网络的环境执行：

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

本包未包含历史会话、作者原始资料、运行产物、账号配置或凭据。原环境中旧版 `@omdsh-dev/dsh-genui` 与本版本不兼容并被跳过；接收方若有此插件也应以自己的启动日志为准。

## 给蓝图模块的接入约定

需求侧在本地准备好一次任务的交接目录后，将该目录交由蓝图模块读取。最小输入是包内 `视频需求.md`；有本地原文索引时，同目录还包含 `资料索引.json` 和 `scene_retrieval.py`。未带索引的包不具备本地引用查询能力。蓝图模块需要核实具体场面时，可在交接包目录中按问题调用：

```sh
python3 ./scene_retrieval.py query --index ./资料索引.json --query '要核实的问题'
```

命令以 JSON 返回引用、位置和状态。查询是词面检索，不自动判断答案是否成立；请读取具体引文及上下文。真实蓝图接收端与 DSH 的联调尚未完成，调用方式和错误反馈需由双方实际验证。
