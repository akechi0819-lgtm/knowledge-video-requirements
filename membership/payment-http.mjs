import { isIP } from 'node:net';
import { passStatus } from './monthly.mjs';
import { createEpayPayment, epayCashierUrl, queryEpayOrder, verifyEpaySign } from './epay.mjs';
import { claimOrderPoll, createPaymentOrder, fulfillPaymentOrder, getPaymentOrder, setPaymentDetails } from './payment-orders.mjs';

const notifyPath = '/api/payments/epay/notify';
const orderPath = /^\/api\/orders\/([0-9a-f-]{36})$/;
const validTradeNo = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function matchingAmount(money, cents) {
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(String(money));
  return Boolean(match && BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) === BigInt(cents));
}

function amountYuan(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function paymentDetails(order) {
  return { outTradeNo: order.id, name: '讲界 6 元周卡（7 天）', money: amountYuan(order.amount_cents) };
}

async function notificationParams(req, url) {
  let fields = url.searchParams;
  if (req.method === 'POST') {
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;
    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 16 * 1024) {
        req.resume();
        return null;
      }
      chunks.push(chunk);
    }
    fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }
  const params = Object.fromEntries(fields);
  return [...fields.keys()].length === Object.keys(params).length ? params : null;
}

function audit(event, reason) {
  console.warn(`[membership:epay] ${event}: ${reason}`);
}

function text(res, status, data, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {'content-type':contentType,'cache-control':'no-store','referrer-policy':'no-referrer'});
  res.end(data);
}

const returnPage = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>讲界支付</title><h1>支付结果处理中</h1><p>请切回讲界桌面端查看，支付结果将自动刷新。</p></html>';

export function createPaymentHandlers(db, config, { json, read }) {
  const opening = new Map();
  const passById = db.prepare('SELECT * FROM monthly_pass WHERE id=?');
  function orderView(order) {
    const status=order.status === 'pending' && Date.parse(order.expires_at) <= Date.now() ? 'expired' : order.status;
    const pending = status === 'pending';
    const cashier = config?.mode === 'submit';
    return {
      orderId:order.id, plan:order.plan_code, amountYuan:amountYuan(order.amount_cents), status,
      qrCode:pending && !cashier ? order.qr_code : null,
      payUrl:pending ? (cashier ? epayCashierUrl(config,paymentDetails(order)) : order.pay_url) : null,
      expiresAt:order.expires_at,
      passStatus:passStatus(order.pass_id ? passById.get(order.pass_id) : null),
    };
  }

  async function notify(req, res, url) {
    function reject(reason) {
      audit('notify rejected', reason);
      text(res,400,'fail');
    }
    if (!config) return text(res,503,'fail');
    const params=await notificationParams(req,url);
    if (!params || !verifyEpaySign(params,config.key)) return reject('invalid_signature');
    if (params.pid !== config.pid) return reject('merchant_mismatch');
    if (params.trade_status !== 'TRADE_SUCCESS' || params.type !== config.payType) return reject('invalid_trade_status');
    const order=getPaymentOrder(db,params.out_trade_no ?? '');
    if (!order || !matchingAmount(params.money,order.amount_cents)) return reject('invalid_order_or_amount');
    if (!validTradeNo(params.trade_no)) return reject('invalid_trade_no');
    try {
      fulfillPaymentOrder(db,order.id,params.trade_no);
    } catch {
      return reject('fulfillment_rejected');
    }
    return text(res,200,'success');
  }

  async function checkout(req,res,id) {
    if (!config) return json(res,503,{error:'payment_unconfigured',message:'收款渠道尚未开通，暂不能购买周卡。'});
    const body=await read(req);
    if (body?.plan !== 'weekly_6') return json(res,400,{error:'invalid_plan',message:'请选择 6 元周卡。'});
    let order=createPaymentOrder(db,id);
    if (!order) return json(res,409,{error:'pass_active',message:'当前周卡仍有效，暂不能重复购买。'});
    if (config.mode==='mapi' && order.status==='pending' && !order.pay_url && !order.qr_code) {
      if (!opening.has(order.id)) {
        const forwarded=req.headers['x-real-ip'];
        const peer=req.socket.remoteAddress;
        const ip=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) && typeof forwarded==='string' && isIP(forwarded) ? forwarded : peer;
        const payment=createEpayPayment(config,{
          ...paymentDetails(order), clientIp:ip,
        }).then(details => setPaymentDetails(db,order.id,details)).finally(() => opening.delete(order.id));
        opening.set(order.id,payment);
      }
      try { order=await opening.get(order.id); }
      catch {
        audit('checkout failed','provider_request_failed');
        return json(res,502,{error:'payment_unavailable',message:'支付渠道暂不可用，请稍后重试。'});
      }
    }
    return json(res,200,orderView(order));
  }

  async function checkOrder(res,id,orderId) {
    let order=getPaymentOrder(db,orderId);
    if (!order || order.user_id!==id) return json(res,404,{error:'order_not_found',message:'订单不存在。'});
    if (config && claimOrderPoll(db,orderId)) {
      try {
        const trade=await queryEpayOrder(config,orderId);
        if (trade.paid && trade.outTradeNo===orderId && trade.type===config.payType
            && validTradeNo(trade.tradeNo) && matchingAmount(trade.money,order.amount_cents)) {
          fulfillPaymentOrder(db,orderId,trade.tradeNo);
        } else if (trade.paid) audit('query rejected','trade_mismatch');
      } catch {
        audit('query failed','provider_or_fulfillment_error');
      }
      order=getPaymentOrder(db,orderId);
    }
    return json(res,200,orderView(order));
  }

  return {
    available:Boolean(config),
    publicRoute(req,res,url,path) {
      if (path===notifyPath && ['GET','POST'].includes(req.method)) return notify(req,res,url);
      if (path==='/payment/return' && req.method==='GET') {
        text(res,200,returnPage,'text/html; charset=utf-8');
        return true;
      }
      return false;
    },
    privateRoute(req,res,path,id) {
      const match=path.match(orderPath);
      if (path==='/api/orders' && req.method==='POST') {
        res.setHeader('cache-control','no-store');
        return checkout(req,res,id);
      }
      if (match && req.method==='GET') {
        res.setHeader('cache-control','no-store');
        return checkOrder(res,id,match[1]);
      }
      return false;
    },
  };
}
