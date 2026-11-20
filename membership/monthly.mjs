import { randomUUID } from 'node:crypto';

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function initializeMonthly(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS monthly_pass (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tokens INTEGER NOT NULL,
      starts_at TEXT, expires_at TEXT NOT NULL, stopped_at TEXT
    );
    CREATE INDEX IF NOT EXISTS monthly_pass_user ON monthly_pass(user_id);
    CREATE TABLE IF NOT EXISTS monthly_test_order (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL, pass_id TEXT UNIQUE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_test_order ON monthly_test_order(user_id) WHERE pass_id IS NULL;`);
    if (!db.prepare('PRAGMA table_info(production)').all().some(column => column.name === 'pass_id')) {
      db.exec('ALTER TABLE production ADD COLUMN pass_id TEXT');
    }
    if (db.prepare('PRAGMA table_info(member)').all().some(column => column.name === 'expires_at')) {
      db.exec(`INSERT INTO monthly_pass(id,user_id,tokens,expires_at)
        SELECT lower(hex(randomblob(16))),user_id,tokens,expires_at FROM member WHERE expires_at IS NOT NULL;
        ALTER TABLE member DROP COLUMN tokens;
        ALTER TABLE member DROP COLUMN expires_at;`);
    }
  });
}

export function currentPass(db, userId) {
  return db.prepare('SELECT * FROM monthly_pass WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(userId);
}

export function passStatus(pass, now = Date.now()) {
  if (!pass) return 'none';
  if (pass.stopped_at) return 'stopped';
  return Date.parse(pass.expires_at) > now ? 'active' : 'expired';
}

function issuePass(db, userId, tokens, now, expiresAt) {
  if (passStatus(currentPass(db, userId), now) === 'active') throw new Error('已有未到期月卡；暂不叠加或提前更换。');
  const id = randomUUID();
  db.prepare('INSERT INTO monthly_pass(id,user_id,tokens,starts_at,expires_at) VALUES (?,?,?,?,?)')
    .run(id, userId, tokens, new Date(now).toISOString(), new Date(expiresAt).toISOString());
  return db.prepare('SELECT * FROM monthly_pass WHERE id=?').get(id);
}

export function openPass(db, userId, tokens, expiresAt) {
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('到期时间必须是未来的有效日期。');
  return transaction(db, () => issuePass(db, userId, tokens, now, expiresAt));
}

export function stopPass(db, userId) {
  return transaction(db, () => {
    const pass = currentPass(db, userId);
    if (passStatus(pass) === 'stopped') return pass;
    if (passStatus(pass) !== 'active') throw new Error('没有可停用的月卡。');
    db.prepare('UPDATE monthly_pass SET stopped_at=? WHERE id=?').run(new Date().toISOString(), pass.id);
    return currentPass(db, userId);
  });
}

export function createTestOrder(db, userId, tokens) {
  return transaction(db, () => {
    const pending = db.prepare('SELECT * FROM monthly_test_order WHERE user_id=? AND pass_id IS NULL').get(userId);
    if (pending) {
      if (pending.tokens !== tokens) throw new Error('该账号已有待履约测试订单，不能变更订单额度。');
      return pending;
    }
    if (passStatus(currentPass(db, userId)) === 'active') throw new Error('已有未到期月卡；暂不接受提前下单。');
    const id = randomUUID();
    db.prepare('INSERT INTO monthly_test_order(id,user_id,tokens,created_at) VALUES (?,?,?,?)')
      .run(id, userId, tokens, new Date().toISOString());
    return db.prepare('SELECT * FROM monthly_test_order WHERE id=?').get(id);
  });
}

export function fulfillTestOrder(db, id) {
  return transaction(db, () => {
    const order = db.prepare('SELECT * FROM monthly_test_order WHERE id=?').get(id);
    if (!order) throw new Error('测试订单不存在。');
    if (order.pass_id) return order;
    const now = Date.now();
    const pass = issuePass(db, order.user_id, order.tokens, now, now + 30 * 86400000);
    db.prepare('UPDATE monthly_test_order SET pass_id=? WHERE id=?').run(pass.id, id);
    return db.prepare('SELECT * FROM monthly_test_order WHERE id=?').get(id);
  });
}
