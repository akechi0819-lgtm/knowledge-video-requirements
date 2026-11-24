import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productionErrorMessage } from '../lib/production-error.js'

test('制作报错给出中文原因和下一步，不回显服务响应和本地路径', () => {
  const cases = [
    ['402: {\"error\":\"quota_circuit_broken\"}', '编写画面', /本周卡额度已用尽.*继续制作/],
    ['400: {"message":"fetch failed"}', '编写画面', /画面模型连接失败.*检查网络/],
    ['HTTP 401: secret', '生成配音', /配音服务.*身份或权限.*检查/],
    ['429: secret', '编写画面', /请求太频繁.*再试/],
    ['503: secret', '编写画面', /暂时不可用.*重试/],
    ['504: secret', '编写画面', /响应超时.*重试/],
    ['400: secret', '编写画面', /拒绝.*检查服务设置/],
    ['Error: CERTIFICATE_VERIFY_FAILED', '生成配音', /配音服务.*安全连接校验失败/],
    ['Error: ENOSPC: /Users/example/secret', '配音与渲染', /磁盘空间不足.*释放空间/],
    ['Error: ENOENT: /Users/example/secret', '预览画面', /文件或工具缺失.*检查项目素材/],
    ['ffmpeg: /Users/example/secret', '配音与渲染', /配音与渲染未完成.*联系支持/],
    ['unrecognized upstream payload: secret', '编写画面', /遇到未识别的问题.*联系支持/],
  ]
  for (const [error, phase, expected] of cases) {
    const message = productionErrorMessage(error, phase)
    assert.match(message, expected)
    assert.doesNotMatch(message, /fetch failed|secret|Users\//)
  }
})
