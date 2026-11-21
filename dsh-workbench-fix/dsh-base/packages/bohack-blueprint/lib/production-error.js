export const receiptMessage = '成片已保存，平台授权回执待处理，请稍后点「补交完成回执」。'

export function productionErrorMessage(error, phase) {
  if (!error) return '制作遇到未识别的问题，请稍后重试。若反复出现，请联系支持。'
  const raw = String(error.message || error)
  if (raw.startsWith('成片已保存，平台授权回执待处理')) return receiptMessage
  const step = ['正在制作视频', '编写画面', '生成画面'].includes(phase) ? '画面模型'
    : ({ 生成配音:'配音服务', 生成素材:'素材服务', 预览画面:'画面预览', 配音与渲染:'配音与渲染', 自动质检:'自动质检' })[phase] || '制作服务'
  const status = error.status || /^(?:HTTP\s+)?([45]\d\d)\s*[:：\s]/m.exec(raw)?.[1]
  if (/CERTIFICATE_VERIFY_FAILED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED/i.test(raw)) return `${step}的安全连接校验失败，请检查服务地址或联系支持。`
  if (/fetch failed|failed to fetch|networkerror|ECONN(?:RESET|REFUSED)|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(raw)) return `${step}连接失败，请检查网络，或稍后重试。`
  if (/\b(?:ETIMEDOUT|UND_ERR_\w+_TIMEOUT|TimeoutError)\b|(?:request|connection) timed?\s*out/i.test(raw) || [408, 504].includes(Number(status))) return `${step}响应超时，请稍后重试。`
  if (/\b(?:ENOSPC|EDQUOT)\b/.test(raw)) return '磁盘空间不足，请释放空间后再试。'
  if (/\b(?:EACCES|EPERM|EROFS)\b/.test(raw)) return '无法写入制作文件，请检查工作区的读写权限后再试。'
  if (/\bENOENT\b/.test(raw)) return '制作所需的文件或工具缺失，请检查项目素材；若问题反复出现，请联系支持。'
  if ([401, 403].includes(Number(status))) return `${step}未通过身份或权限校验，请检查登录状态或自配服务的密钥权限。`
  if (Number(status) === 429) return `${step}请求太频繁，请稍等一会儿再试。`
  if (Number(status) >= 500) return `${step}暂时不可用，请稍后重试。`
  if (Number(status) === 413 || /context_length_exceeded|maximum context length/i.test(raw)) return `${step}收到的内容太长，请减少参考资料后再试。`
  if (Number(status) === 400 || Number(status) === 422) return `${step}拒绝了这次请求。若重试仍失败，请检查服务设置或联系支持。`
  if (Number(status) === 404) return `${step}找不到指定的服务或模型，请检查设置或联系支持。`
  const reason = raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)[0].trim().replace(/^Error:\s*/, '')
  if (/^(?:画面模型(?:超过 \d+ 分钟[^。]+|请求受到限制（429）|服务暂时不可用（50[0234]）)|制作工具超过 \d+ 分钟[^。]+)，制作已暂停。$/.test(reason)) return reason
  if (/制作超时/.test(reason)) return `${step}制作超时，请稍后重试。`
  if (/会话没有新的工具进展|未成功调用 submit|视频 Agent 未完成成片|会话已中止/.test(reason)) return '画面制作没有提交新的结果，请继续制作或重试。'
  if (/^缺少旁白：[A-Za-z0-9、]+；请补充后重新确认并定稿。$/.test(reason)) return reason
  if (/^(?:请先(?:登录|继续或放弃|在原项目)|请登录开片时|这个账号已有一条片|制作额度已用完|平台服务地址尚未配置|请配置当前配音服务|未配置可用的画面模型|制作记录已变更|本创作已有制作任务|制作仍在运行|成片已保存，请先补交|该片的制作授权已完成|这条片的授权已结束|工作台已重启|请在高级设置中配置|尚无已完成的成片)[\p{Script=Han} A-Za-z0-9。，、；：…]*$/u.test(reason)) return reason
  if (phase === '预览画面' || phase === '配音与渲染' || phase === '自动质检') return `${step}未完成，请稍后重试。若反复出现，请联系支持。`
  return `${step}遇到未识别的问题，请稍后重试。若反复出现，请联系支持。`
}

