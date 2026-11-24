import { createHash, timingSafeEqual } from 'node:crypto';

function endpoint(base, path) {
  let url;
  try { url = new URL(base); } catch { throw new Error('Invalid EPay API configuration'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid EPay API configuration');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Invalid EPay API configuration');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  return url;
}

function safePayUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function readEpayConfig(env = process.env, { baseUrl, pathPrefix = '' } = {}) {
  const apiUrl = env.EPAY_API_URL, pid = env.EPAY_PID, key = env.EPAY_KEY;
  if (!apiUrl || !pid || !key) return null;
  endpoint(apiUrl, 'mapi.php');
  const mode = env.EPAY_MODE ?? 'mapi';
  if (!['mapi', 'submit'].includes(mode)) throw new Error('Invalid EPay mode');
  const publicBase = baseUrl?.replace(/\/$/, '');
  const prefix = pathPrefix ? `/${pathPrefix.replace(/^\/+|\/+$/g, '')}` : '';
  const notifyUrl = env.EPAY_NOTIFY_URL ?? (publicBase && `${publicBase}${prefix}/api/payments/epay/notify`);
  const returnUrl = env.EPAY_RETURN_URL ?? (publicBase && `${publicBase}${prefix}/payment/return`);
  if (!notifyUrl) throw new Error('Missing EPay notify URL');
  return { apiUrl, pid, key, mode, payType: env.EPAY_PAY_TYPE ?? 'alipay', notifyUrl, returnUrl };
}

export function signEpay(params, key) {
  const data = Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort().map(k => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(data + key, 'utf8').digest('hex');
}

export function verifyEpaySign(params, key) {
  const signature = params.sign;
  if (typeof signature !== 'string' || !/^[a-fA-F0-9]{32}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature.toLowerCase(), 'hex'), Buffer.from(signEpay(params, key), 'hex'));
}

async function fetchJson(url, options) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!result || typeof result !== 'object' || Number(result.code) !== 1) throw new Error();
    return result;
  } catch {
    // URLs and fetch errors can contain merchant credentials.
    throw new Error('EPay request failed');
  }
}

export async function createEpayPayment(config, { outTradeNo, name, money, clientIp }) {
  const params = { pid: config.pid, type: config.payType, out_trade_no: outTradeNo, notify_url: config.notifyUrl,
    return_url: config.returnUrl, name, money };
  if (config.mode === 'mapi') params.clientip = clientIp;
  params.sign = signEpay(params, config.key);
  params.sign_type = 'MD5';
  const body = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== ''));
  if (config.mode === 'submit') {
    const url = endpoint(config.apiUrl, 'submit.php');
    url.search = body.toString();
    return { payUrl: url.href, qrCode: null, tradeNo: null };
  }
  const result = await fetchJson(endpoint(config.apiUrl, 'mapi.php'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  const payUrl = safePayUrl(result.payurl);
  const qrCode = typeof result.qrcode === 'string' && result.qrcode ? result.qrcode : null;
  if (!payUrl && !qrCode) throw new Error('EPay response has no payment destination');
  return { payUrl, qrCode, tradeNo: result.trade_no == null ? null : String(result.trade_no) };
}

export async function queryEpayOrder(config, outTradeNo) {
  const url = endpoint(config.apiUrl, 'api.php');
  url.search = new URLSearchParams({ act: 'order', pid: config.pid, key: config.key, out_trade_no: outTradeNo }).toString();
  const result = await fetchJson(url, { method: 'GET' });
  return { tradeNo: result.trade_no == null ? null : String(result.trade_no),
    outTradeNo: result.out_trade_no == null ? null : String(result.out_trade_no),
    type: result.type == null ? null : String(result.type),
    money: result.money == null ? null : String(result.money), paid: String(result.status) === '1' };
}
