import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeMonthly } from './monthly.mjs';
import { initializePaymentOrders, createPaymentOrder, fulfillPaymentOrder, claimOrderPoll, getPaymentOrder } from './payment-orders.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE member(user_id TEXT,gifts INTEGER); CREATE TABLE production(user_id TEXT,id TEXT); CREATE TABLE usage(id TEXT);');
  initializeMonthly(db);
  initializePaymentOrders(db);
  return db;
}

test('paid order survives active pass and checkout never issues it', () => {
  const db = database(), now = Date.now();
  try {
    const order = createPaymentOrder(db, 'user', now);
    const older = createPaymentOrder(db, 'user', now + 15 * 60000);
    const original = fulfillPaymentOrder(db, older.id, 'trade-old', now + 15 * 60000);
    assert.equal(fulfillPaymentOrder(db, order.id, 'trade-1', now + 15 * 60000).status, 'paid');
    assert.equal(claimOrderPoll(db, order.id, now), false);
    db.prepare('UPDATE monthly_pass SET used_micro_cny=budget_micro_cny WHERE id=?').run(original.pass_id);
    assert.equal(createPaymentOrder(db, 'user', now).status, 'paid');
    assert.equal(db.prepare('SELECT count(*) AS n FROM monthly_pass').get().n, 1);
    assert.equal(claimOrderPoll(db, order.id, now), true);
    assert.equal(claimOrderPoll(db, order.id, now + 4999), false);
    assert.equal(fulfillPaymentOrder(db, order.id, 'trade-1', now + 5000).status, 'fulfilled');
    assert.equal(createPaymentOrder(db, 'user', now + 5000), null);
  } finally { db.close(); }
});

test('duplicate provider trade rolls back and expired orders can be paid late', () => {
  const db = database(), now = Date.now();
  try {
    const first = createPaymentOrder(db, 'first', now);
    const second = createPaymentOrder(db, 'second', now);
    const afterExpiry = now + 15 * 60000;
    assert.equal(claimOrderPoll(db, first.id, afterExpiry), false);
    const replacement = createPaymentOrder(db, 'first', afterExpiry);
    assert.notEqual(replacement.id, first.id);
    assert.equal(getPaymentOrder(db, first.id).status, 'expired');
    assert.equal(fulfillPaymentOrder(db, first.id, 'trade-1', afterExpiry).status, 'fulfilled');
    assert.throws(() => fulfillPaymentOrder(db, second.id, 'trade-1', afterExpiry));
    assert.equal(getPaymentOrder(db, second.id).status, 'pending');
    assert.equal(getPaymentOrder(db, second.id).provider_trade_no, null);
    assert.equal(db.prepare("SELECT count(*) AS n FROM monthly_pass WHERE user_id='second'").get().n, 0);
  } finally { db.close(); }
});
