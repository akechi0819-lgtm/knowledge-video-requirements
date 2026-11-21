# 会员服务

Node.js 24.15 或更新版本。`npm ci` 后设置以下环境变量并运行 `npm start`：

- `BETTER_AUTH_SECRET`：至少 32 字符的随机密钥；`BETTER_AUTH_URL`：服务的完整对外地址。
- `MEMBER_DATABASE`：持久 SQLite 文件路径；默认当前目录 `membership.sqlite`。`PORT` 默认 8787，`MEMBER_HOST` 默认绑定 `127.0.0.1`。
- `MEMBER_CHAT_BASE_URL`、`MEMBER_CHAT_API_KEY`、`MEMBER_CHAT_MODEL`：OpenAI 兼容文本供应商的 API 根地址（例如以 `/v1` 结尾）、密钥和固定模型。
- `MEMBER_TTS_BASE_URL`、`MEMBER_TTS_API_KEY`、`MEMBER_TTS_MODEL`、`MEMBER_TTS_VOICE`：标准 `/audio/speech` 供应商的 API 根地址、密钥、固定模型和音色。`MEMBER_TTS_PROTOCOL` 可选 `speech`（默认）或 `mimo`；后者由服务端转换为 MiMo 聊天配音并返回 MP3。

注册使用受邀入口 `/api/auth/sign-up/email`，请求头 `X-Invite-Code` 携带一次性邀请码。登录使用 Better Auth 的 `/api/auth/sign-in/email`；客户端 POST 应带服务地址对应的 `Origin`。从 `set-auth-token` 取得令牌并在后续请求带 `Authorization: Bearer ...`。上线前须使用 HTTPS、持久备份数据库及妥善保存密钥；当前交付用于测试联调。

`GET /api/member` 返回赠片、有效月卡余额、到期时间、月卡状态和活动制作 ID。已过期或停用的月卡不计入可用余额。`POST /api/productions/start`、`/finish` 和 `/abandon` 接受 `{ "productionId": "客户端持久化的唯一标识" }`。重复开始相同活动制作会继续同一条片，即使此时月卡过期、停用或余额归零；停卡只影响新开片资格。完成和主动放弃都释放活动名额，重复请求返回原有终态。放弃后已用赠片和额度不退回，已结束的 ID 不能再开片。开片先消耗赠片，否则检查有效月卡和正余额，并将制作固定到该次月卡。旧制作迟到的用量仍记入旧卡，不扣新卡；迁移前已开片的制作无法确认原周期，后续用量只记账、不扣新月卡。余额最低为 0，赠片制作仍记录用量。配音单独记录输入字符数，不折算 token。上游不返回用量时账本记为未知，不应视为零成本。

代理路径为 `/api/proxy/<productionId>/chat/completions`、`/responses`、`/audio/speech`，也可以在路径省略制作 ID 并用 `X-Production-Id` 指定。客户端模型和音色会被服务端配置覆盖，不能传供应商地址或密钥。兼容文本流的 usage 事件；供应商必须提供实际 usage 才能计量。配音面向客户端使用标准二进制响应，MiMo 协议可由服务端转换。只允许已登录账号的活动制作调用。代理会把本次请求内容发送给配置的供应商。

## 月卡与本地运营

产品只保留单档、用户主动购买的月卡，不自动续费。收款渠道尚未开通：购买入口提示暂不可购买，`GET /api/member` 返回 `purchaseAvailable: false`，`POST /api/orders` 返回 `503 payment_unconfigured`，不创建订单。真实收款还需要确认渠道、商户凭据、正式价格和 Token 额度，并接入可信支付确认。提前购卡规则尚未定；本地流程暂不允许有效卡叠加或提前更换，即使余额已经用完。测试履约使用 30 天，仅用于验证周期归属，不承诺正式月卡的到期计算方式。

先启动会员服务初始化数据库，再在有数据库文件访问权的机器运行以下命令；没有面向登录用户的管理接口。`./membership.sqlite` 换为实际数据库文件，测试命令只用于隔离的联调数据库：

- `node grant.mjs ./membership.sqlite inspect test@example.com`：查账号、赠片、月卡历史、测试订单、用量及归属周期。
- `node grant.mjs ./membership.sqlite open test@example.com 10000 2026-12-20T00:00:00Z`：手动开卡，指定额度和未来的到期日，不记录收款。不会覆盖有效卡。
- `node grant.mjs ./membership.sqlite stop test@example.com`：停用当前月卡，不删除余额与用量历史，不撤销已经开片的授权。
- `node grant.mjs ./membership.sqlite test-order test@example.com 10000`：创建待履约测试订单；同账号同额度重复调用返回未履约的原单。
- `node grant.mjs ./membership.sqlite test-fulfill ORDER_ID`：本地模拟履约；重复调用同一订单返回原发放记录，不续期或补发。测试订单不是已支付凭证。

运行 `npm test` 验证本地 HTTP 注册登录、竞争开片、续用、用尽后的拦截、购买未开通、运营 CLI、测试订单幂等履约、旧制作跨月卡迟到用量、旧库迁移，以及模拟上游的文本、流式用量及标准与 MiMo 配音。测试供应商是本地模拟服务，不能证明真实供应商兼容性或实际成本；数据库账本目前是单机 SQLite，不代表多机部署已验证。真实支付与正式上线不在本地验收范围。

桌面成片页可继续原制作、补交完成回执或放弃本片授权。画面模型暂时不可用时，成片页显示中文原因和续作提示；可点击「继续制作」，也可在左侧对话说「继续制作」或「重试」。续作沿用原账号、授权、任务目录，复用完整场景和匹配的配音缓存。中途写出的片段会重新渲染。已质检成片在等待回执期间可播放和下载。回执确认后再要求 AI 返工会重新检查开片资格。

运行 `node --test dsh-workbench-fix/dsh-base/packages/bohack-blueprint/test/membership-resume.test.js` 验证本机工作台 API、状态落盘后重开、断线、生成失败、回执丢失、放弃重试和离线成片下载。测试使用模拟平台及合成产物。

安装的桌面 App 可用 `node membership/test-desktop.mjs "/path/to/讲界.app"` 运行全链路测试。它启动真正的桌面 App、DSH、会员服务和本地模拟供应商，通过工作台 API 测试需求、蓝图、素材、配音、制作 Agent、技术质检和成片下载。供应商返回的测试音频为合成音。

真实回归使用独立 QA 一次性邀请码的私有文件，并指定一个新的证据目录：

```sh
node membership/test-public-blueprint.mjs /path/to/讲界.app /path/to/private-invite /path/to/new-evidence-dir
```

该回归会消耗真实赠片额度，只验证到蓝图，不运行出片；临时资料会清理，证据目录中的 `result.json` 已脱敏。成功时附蓝图截图，实际文件名为 `blueprint.png`。

## 内测邀请码

新账号注册需要一次性邀请码。服务端使用 SQLite 原子预留，成功创建账号后核销；注册失败且账号未创建时释放。服务重启时会根据预留邮箱是否已创建账号恢复状态。一个码只能用于一次注册，重复登录不会增加赠片。码由 24 字节随机数生成，数据库只保存 SHA-256。内测时邮箱仅作登录名，正式邮箱验证可在 Better Auth 的 `emailVerification` 配置中接入。请在会员服务机器上执行以下命令，输出只会出现一次，请通过授权渠道交给体验者：

```sh
node invite.mjs /path/to/membership.sqlite 3
```

服务使用单个进程访问数据库，重启恢复时不可同时运行另一个服务实例。若服务部署在域名前缀下，`BETTER_AUTH_URL` 填写公网 HTTPS origin，`MEMBER_PATH_PREFIX` 填写路径前缀（例如 `/desktop-membership`），反向代理应保留完整请求路径。客户端地址则包含该前缀。

### 讲界公网内测

独立的 systemd 服务 `jiangjie-membership-beta` 监听服务器的 `127.0.0.1:18787`。讲界域名的 Nginx 把 `/desktop-membership/` 转给会员服务。程序位于 `/opt/jiangjie-membership-beta`，SQLite 位于 `/var/lib/jiangjie-membership-beta/membership.sqlite`。上游和会话签名配置由 systemd 从权限为 0600 的 `/etc/jiangjie-membership-beta/service.env` 读入。

在获授权的服务器终端生成一枚邀请码，并把标准输出保存在私有文件后单独发放。

```sh
umask 077
/opt/jiangjie-preview/node /opt/jiangjie-membership-beta/invite.mjs /var/lib/jiangjie-membership-beta/membership.sqlite 1 > 邀请码.txt
```
