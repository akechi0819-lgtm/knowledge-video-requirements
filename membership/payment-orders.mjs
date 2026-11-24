import { randomUUID } from 'node:crypto';
import { weeklyConfig } from './billing.mjs';
import { transaction, currentPass, passStatus, issuePass } from './monthly.mjs';

export function initializePaymentOrders(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS payment_order (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_code TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, budget_micro_cny INTEGER NOT NULL, duration_days INTEGER NOT NULL,
    status TEXT NOT NULL, provider TEXT NOT NULL, provider_trade_no TEXT UNIQUE,
    pay_url TEXT, qr_code TEXT, pass_id TEXT UNIQUE, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, paid_at TEXT, last_polled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS payment_order_user ON payment_order(user_id);`);
}

export function getPaymentOrder(db, id) {
  return db.prepare('SELECT * FROM payment_order WHERE id=?').get(id);
}

function fulfillPaid(db, order, now) {
  if (order.status !== 'paid' || passStatus(currentPass(db, order.user_id), now) === 'active') return order;
  const pass = issuePass(db, order.user_id, now, order.id, {
    budgetMicroCny: order.budget_micro_cny, durationDays: order.duration_days,
  });
  db.prepare("UPDATE payment_order SET status='fulfilled', pass_id=? WHERE id=?").run(pass.id, order.id);
  return getPaymentOrder(db, order.id);
}

export function createPaymentOrder(db, userId, now = Date.now()) {
  return transaction(db, () => {
    const paid = db.prepare("SELECT * FROM payment_order WHERE user_id=? AND status='paid' ORDER BY rowid LIMIT 1").get(userId);
    if (paid) return paid;
    // Null means the account has an active pass and no paid order awaiting issuance.
    if (passStatus(currentPass(db, userId), now) === 'active') return null;
    db.prepare("UPDATE payment_order SET status='expired' WHERE user_id=? AND status='pending' AND expires_at<=?")
      .run(userId, new Date(now).toISOString());
    const pending = db.prepare("SELECT * FROM payment_order WHERE user_id=? AND status='pending' ORDER BY rowid LIMIT 1").get(userId);
    if (pending) return pending;
    const { priceCents, budgetMicroCny } = weeklyConfig();
    const id = randomUUID();
    db.prepare(`INSERT INTO payment_order(id,user_id,plan_code,amount_cents,budget_micro_cny,duration_days,status,provider,created_at,expires_at)
      VALUES (?,?,'weekly_6',?,?,7,'pending','epay',?,?)`)
      .run(id, userId, priceCents, budgetMicroCny, new Date(now).toISOString(), new Date(now + 15 * 60000).toISOString());
    return getPaymentOrder(db, id);
  });
}

export function setPaymentDetails(db, id, { payUrl, qrCode }) {
  db.prepare("UPDATE payment_order SET pay_url=?, qr_code=? WHERE id=? AND status='pending'").run(payUrl ?? null, qrCode ?? null, id);
  return getPaymentOrder(db, id);
}

export function claimOrderPoll(db, id, now = Date.now()) {
  return transaction(db, () => {
    const order = getPaymentOrder(db, id);
    if (!order || (order.status !== 'pending' && order.status !== 'paid')) return false;
    if (order.status === 'paid' && passStatus(currentPass(db, order.user_id), now) === 'active') return false;
    if (order.status === 'pending' && Date.parse(order.expires_at) <= now) return false;
    return db.prepare(`UPDATE payment_order SET last_polled_at=? WHERE id=?
      AND (last_polled_at IS NULL OR last_polled_at<=?)`)
      .run(new Date(now).toISOString(), id, new Date(now - 5000).toISOString()).changes === 1;
  });
}

export function fulfillPaymentOrder(db, id, providerTradeNo, now = Date.now()) {
  return transaction(db, () => {
    let order = getPaymentOrder(db, id);
    if (!order) throw new Error('订单不存在。');
    if (!providerTradeNo || (order.provider_trade_no && order.provider_trade_no !== providerTradeNo)) throw new Error('支付交易号不匹配。');
    if (order.status === 'fulfilled') return order;
    if (order.status !== 'paid') {
      db.prepare("UPDATE payment_order SET status='paid',provider_trade_no=?,paid_at=? WHERE id=?")
        .run(providerTradeNo, new Date(now).toISOString(), id);
      order = getPaymentOrder(db, id);
    }
    return fulfillPaid(db, order, now);
  });
}
