import { DatabaseSync } from 'node:sqlite';
import { currentPass, passStatus, openPass, stopPass, createTestOrder, fulfillTestOrder } from './monthly.mjs';

const [database, command, subject, rawTokens, expiresAt, ...extra] = process.argv.slice(2);
const expected = { inspect: 3, open: 5, stop: 3, 'test-order': 4, 'test-fulfill': 3 };
const tokens = Number(rawTokens);
try {
  if (!database || !subject || process.argv.length !== 2 + expected[command] || extra.length) {
    throw new Error('用法：node grant.mjs DATABASE inspect EMAIL | open EMAIL TOKENS EXPIRY_ISO | stop EMAIL | test-order EMAIL TOKENS | test-fulfill ORDER_ID');
  }
  if (['open', 'test-order'].includes(command) && (!Number.isSafeInteger(tokens) || tokens <= 0)) throw new Error('额度必须是正整数。');
  const db = new DatabaseSync(database, { readOnly: command === 'inspect' });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    let result;
    if (command === 'test-fulfill') result = fulfillTestOrder(db, subject);
    else {
      const user = db.prepare('SELECT id,email FROM user WHERE email=?').get(subject.toLowerCase());
      if (!user) throw new Error('未找到账号。');
      if (command === 'open') result = openPass(db, user.id, tokens, Date.parse(expiresAt));
      if (command === 'stop') result = stopPass(db, user.id);
      if (command === 'test-order') result = createTestOrder(db, user.id, tokens);
      if (command === 'inspect') {
        result = {
          account: user,
          giftRemaining: db.prepare('SELECT gifts FROM member WHERE user_id=?').get(user.id)?.gifts ?? 3,
          monthlyStatus: passStatus(currentPass(db, user.id)),
          passes: db.prepare('SELECT * FROM monthly_pass WHERE user_id=? ORDER BY rowid DESC').all(user.id),
          testOrders: db.prepare('SELECT * FROM monthly_test_order WHERE user_id=? ORDER BY rowid DESC').all(user.id),
          usage: db.prepare(`SELECT usage.*,production.funding,production.pass_id FROM usage LEFT JOIN production
            ON production.user_id=usage.user_id AND production.id=usage.production_id
            WHERE usage.user_id=? ORDER BY usage.created_at DESC`).all(user.id),
        };
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
