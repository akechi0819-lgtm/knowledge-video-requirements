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
    CREATE INDEX IF NOT EXISTS monthly_pass_user ON monthly_pass(user_id);`);
    const columns = (table, additions) => {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
      for (const [name, definition] of additions) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    const legacyPasses = !db.prepare('PRAGMA table_info(monthly_pass)').all().some(column => column.name === 'used_micro_cny');
    columns('monthly_pass', [
      ['plan_code', "TEXT NOT NULL DEFAULT 'weekly_6'"],
      ['budget_micro_cny', 'INTEGER NOT NULL DEFAULT 51000'],
      ['used_micro_cny', 'INTEGER NOT NULL DEFAULT 0'],
      ['circuit_broken_at', 'TEXT'], ['order_id', 'TEXT'],
    ]);
    if (legacyPasses) {
      db.prepare('UPDATE monthly_pass SET used_micro_cny=budget_micro_cny, circuit_broken_at=COALESCE(circuit_broken_at,?) WHERE tokens<=0')
        .run(new Date().toISOString());
    }
    columns('usage', [
      ['input_tokens', 'INTEGER'], ['cache_read_tokens', 'INTEGER'],
      ['cache_write_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'],
      ['cost_micro_cny', 'INTEGER'], ['estimated', 'INTEGER NOT NULL DEFAULT 0'],
    ]);
    if (!db.prepare('PRAGMA table_info(production)').all().some(column => column.name === 'pass_id')) {
      db.exec('ALTER TABLE production ADD COLUMN pass_id TEXT');
    }
    if (db.prepare('PRAGMA table_info(member)').all().some(column => column.name === 'expires_at')) {
      db.prepare(`INSERT INTO monthly_pass(id,user_id,tokens,expires_at,used_micro_cny,circuit_broken_at)
        SELECT lower(hex(randomblob(16))),user_id,tokens,expires_at,
          CASE WHEN tokens<=0 THEN 51000 ELSE 0 END, CASE WHEN tokens<=0 THEN ? ELSE NULL END
        FROM member WHERE expires_at IS NOT NULL`).run(new Date().toISOString());
      db.exec(`ALTER TABLE member DROP COLUMN tokens;
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
  if (Date.parse(pass.expires_at) <= now) return 'expired';
  if (pass.used_micro_cny >= pass.budget_micro_cny || pass.circuit_broken_at) return 'exhausted';
  return 'active';
}

export function issuePass(db, userId, now, orderId, terms) {
  if (!orderId || !terms || !Number.isSafeInteger(terms.budgetMicroCny) || terms.budgetMicroCny <= 0 ||
      !Number.isSafeInteger(terms.durationDays) || terms.durationDays <= 0) throw new Error('发卡需要有效订单和订单权益。');
  if (passStatus(currentPass(db, userId), now) === 'active') throw new Error('已有生效中的周卡；暂不叠加或提前更换。');
  const id = randomUUID();
  const { budgetMicroCny, durationDays } = terms;
  db.prepare(`INSERT INTO monthly_pass(id,user_id,tokens,starts_at,expires_at,plan_code,budget_micro_cny,order_id)
    VALUES (?,?,?,?,?,'weekly_6',?,?)`)
    .run(id, userId, 0, new Date(now).toISOString(), new Date(now + durationDays * 86400000).toISOString(), budgetMicroCny, orderId);
  return db.prepare('SELECT * FROM monthly_pass WHERE id=?').get(id);
}

export function stopPass(db, userId) {
  return transaction(db, () => {
    const pass = currentPass(db, userId);
    if (passStatus(pass) === 'stopped') return pass;
    if (passStatus(pass) !== 'active') throw new Error('没有可停用的周卡。');
    db.prepare('UPDATE monthly_pass SET stopped_at=? WHERE id=?').run(new Date().toISOString(), pass.id);
    return currentPass(db, userId);
  });
}
