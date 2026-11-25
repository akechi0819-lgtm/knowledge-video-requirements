# 会员服务

Node.js 24.15 或更新版本。`npm ci` 后设置以下环境变量并运行 `npm start`：

- `BETTER_AUTH_SECRET`：至少 32 字符的随机密钥；`BETTER_AUTH_URL`：服务的完整对外地址。
- `MEMBER_DATABASE`：持久 SQLite 文件路径；默认当前目录 `membership.sqlite`。`PORT` 默认 8787，`MEMBER_HOST` 默认绑定 `127.0.0.1`。
- `MEMBER_CHAT_BASE_URL`、`MEMBER_CHAT_API_KEY`、`MEMBER_CHAT_MODEL`：OpenAI 兼容文本供应商的 API 根地址（例如以 `/v1` 结尾）、密钥和固定模型。
- `MEMBER_TTS_BASE_URL`、`MEMBER_TTS_API_KEY`、`MEMBER_TTS_MODEL`、`MEMBER_TTS_VOICE`：标准 `/audio/speech` 供应商的 API 根地址、密钥、固定模型和音色。`MEMBER_TTS_PROTOCOL` 可选 `speech`（默认）或 `mimo`；后者由服务端转换为 MiMo 聊天配音并返回 MP3。

注册使用受邀入口 `/api/auth/sign-up/email`，请求头 `X-Invite-Code` 携带一次性邀请码。登录使用 Better Auth 的 `/api/auth/sign-in/email`；客户端 POST 应带服务地址对应的 `Origin`。从 `set-auth-token` 取得令牌并在后续请求带 `Authorization: Bearer ...`。公网服务使用 HTTPS、持久 SQLite 数据库和服务端私有凭据。

`GET /api/member` 返回赠片、`weekly_6` 周卡状态、剩余额度百分比、到期时间、复购资格及活动制作 ID。状态包括 `none`、`active`、`exhausted`、`expired`、`stopped`。底价、账本金额和内部无限制片开关只在本机运营侧可见。

`POST /api/productions/start`、`/finish` 和 `/abandon` 接受 `{ "productionId": "客户端持久化的唯一标识" }`。同一账号同时只有一条活动制作。普通开片先使用赠片，再检查当前周卡。活动制作绑定开片时的周卡，迟到的用量仍归原卡。迁移前开片且无法确认所属周期的制作只记录用量。复购后点击「继续制作」时，桌面端通过 `/api/productions/start` 提交新的 `productionId` 和 `replacesProductionId`，原子换发授权并复用原任务的断点。重复提交新 ID 可恢复丢失的回执。完成或放弃后，原 ID 保留终态。

代理路径为 `/api/proxy/<productionId>/chat/completions`、`/responses`、`/audio/speech`，也可以在路径省略制作 ID 并用 `X-Production-Id` 指定。服务端覆盖模型和音色。周卡代理在转发前检查绑定卡，已用尽、过期或停用时返回 `402 quota_circuit_broken`。同卡请求依次入账，本次请求跨过上限后，下一笔请求即被拦截。赠片和本地无限制片也记录文本成本。

文本代理识别 Chat Completions、Responses 和对应的 SSE 用量。上游接受请求后缺少完整用量，包括中途断流，按请求及已收到的响应字节估算并标记 `estimated`。标准及 MiMo 配音成功后仅记录输入字符数，成本字段为零，周卡余额不变。MiMo 音频校验失败返回 502，账本不新增记录。供应商明确返回失败状态的请求保留原响应。账本每笔按加权成本向上取整，10,000 微元等于 ¥1.00。

- `MEMBER_PRICE_INPUT_USD`、`MEMBER_PRICE_CACHE_READ_USD`、`MEMBER_PRICE_CACHE_WRITE_USD`、`MEMBER_PRICE_OUTPUT_USD` 为每百万 token 美元价，默认分别为 1.00、0.05、1.25、5.00。
- `MEMBER_RELAY_RATE`、`MEMBER_USD_CNY` 默认分别为 0.04、7.25。中转的输入总量不含缓存时，设置 `MEMBER_INPUT_INCLUDES_CACHED=false`。
- `MEMBER_LONG_CONTEXT_ENABLED` 默认开启，输入超过 `MEMBER_LONG_CONTEXT_THRESHOLD`（默认 272,000）时，输入与缓存按 2 倍、输出按 1.5 倍计价。
- 服务端从 `MEMBER_WEEKLY_PRICE_CENTS`（默认 600）和 `MEMBER_CIRCUIT_RATIO`（默认 0.85）计算签发时锁定的微元预算。

## 周卡支付与运营

商品为 6 元周卡，签发后有效 7 天，默认熔断预算 ¥5.10。金额与权益在服务端下单时写入订单。迁移旧库时保留已耗尽的卡状态。当前卡仍有效且额度未用尽时禁止叠加，额度用尽、到期或停用后可复购。

- `EPAY_API_URL`、`EPAY_PID`、`EPAY_KEY` 从服务端注入。缺任一项时 `purchaseAvailable` 为 `false`，创建订单返回 `503 payment_unconfigured`。生产凭据由运营配置到权限为 0600 的 `/etc/jiangjie-membership-beta/service.env`。
- `EPAY_PAY_TYPE` 默认 `alipay`。 `EPAY_MODE=mapi` 默认向 `mapi.php` POST 表单，使用返回的 `qrcode` 或 `payurl`。讲界公网使用 `EPAY_MODE=submit`，浏览器打开签名的 `submit.php` 欧云收银台，由欧云显示订单金额及支付宝扫码收款码。反向代理应覆盖 `X-Real-IP` 为连接方 IP，供 `mapi.php` 的 `clientip` 使用。
- `EPAY_NOTIFY_URL`、`EPAY_RETURN_URL` 默认分别为公网站点加服务前缀的 `/api/payments/epay/notify`、`/payment/return`。回跳页只显示静态提示。异步通知支持 GET 和 POST 表单，校验签名、商户、成功状态、订单应付金额及交易号唯一性后履约。
- `POST /api/orders` 接受 `{ "plan": "weekly_6" }`，复用同账号 15 分钟内的待付订单。 `GET /api/orders/:id` 只允许订单所属账号读取，每单主动查单间隔至少 5 秒。已验证的晚到付款若遇上有效周卡，先记为已付款待生效，现卡结束后由有效通知或可信主动查询发卡。
- 桌面端本地渲染支付二维码并轮询订单，每 2.5 秒刷新状态，付款后更新会员权益。Bearer 凭证和待处理订单 ID 保存于权限为 0600 的会员本地文件，退出登录清除。
- 文本计费支持 `prompt_cache_hit_tokens` 缓存命中字段。直连供应商时按其实际用量格式和单价配置。

先启动会员服务初始化数据库，再在服务本机用实际数据库路径运行运营命令：

- `node grant.mjs ./membership.sqlite inspect EMAIL` 查看赠片、订单、周卡历史、消耗、熔断状态和用量明细。
- `node grant.mjs ./membership.sqlite unlimited EMAIL` 开通内部无限制片，`metered EMAIL` 恢复计量。仅本地回环 HTTP、无公网路径前缀的测试服务可显式设置 `MEMBER_LOCAL_TEST_UNLIMITED=true` 使用该权益。
- `node grant.mjs ./membership.sqlite stop EMAIL` 停用当前有效周卡，保留账本。

运行 `npm test` 使用本地模拟网关验证下单、回调拒收、幂等、主动补单、迁移、熔断复购及续作。桌面相关验证从仓库根目录运行：

```sh
node --test dsh-workbench-fix/dsh-base/packages/bohack-blueprint/test/{membership-resume,membership-purchase,membership-purchase-browser,production-error,production}.test.js
```

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

旧网页工作台下线后，官网和会员服务仍分别使用 `/opt/jiangjie-preview` 下的站点、TLS 证书和 Node 运行时。

在获授权的服务器终端生成一枚邀请码，并把标准输出保存在私有文件后单独发放。

```sh
umask 077
/opt/jiangjie-preview/node /opt/jiangjie-membership-beta/invite.mjs /var/lib/jiangjie-membership-beta/membership.sqlite 1 > 邀请码.txt
```
