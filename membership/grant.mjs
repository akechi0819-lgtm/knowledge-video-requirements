import { DatabaseSync } from 'node:sqlite';
import { currentPass, passStatus, stopPass } from './monthly.mjs';

const [database, command, subject] = process.argv.slice(2);
const commands = ['inspect', 'unlimited', 'metered', 'stop'];
try {
  if (!database || !subject || !commands.includes(command) || process.argv.length !== 5) {
    throw new Error('用法：node grant.mjs DATABASE inspect EMAIL | unlimited EMAIL | metered EMAIL | stop EMAIL');
  }
  const db = new DatabaseSync(database, { readOnly: command === 'inspect' });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    let result;
    const user = db.prepare('SELECT id,email FROM user WHERE email=?').get(subject.toLowerCase());
    if (!user) throw new Error('未找到账号。');
    if (command === 'unlimited' || command === 'metered') {
      const enabled = command === 'unlimited';
      db.prepare(enabled ? 'INSERT OR IGNORE INTO unlimited_production(user_id) VALUES (?)' : 'DELETE FROM unlimited_production WHERE user_id=?').run(user.id);
      result = { email: user.email, unlimitedProduction: enabled };
    }
    if (command === 'stop') result = stopPass(db, user.id);
    if (command === 'inspect') {
      const passes = db.prepare('SELECT * FROM monthly_pass WHERE user_id=? ORDER BY rowid DESC').all(user.id);
      const totals = db.prepare(`SELECT COALESCE(SUM(usage.input_tokens),0) AS inputTokens,
        COALESCE(SUM(usage.cache_read_tokens),0) AS cacheReadTokens,
        COALESCE(SUM(usage.cache_write_tokens),0) AS cacheWriteTokens,
        COALESCE(SUM(usage.output_tokens),0) AS outputTokens
        FROM usage JOIN production ON production.user_id=usage.user_id AND production.id=usage.production_id
        WHERE production.pass_id=?`);
      result = {
        account: user,
        unlimitedProduction: Boolean(db.prepare('SELECT 1 FROM unlimited_production WHERE user_id=?').get(user.id)),
        giftRemaining: db.prepare('SELECT gifts FROM member WHERE user_id=?').get(user.id)?.gifts ?? 3,
        monthlyStatus: passStatus(currentPass(db, user.id)),
        passes: passes.map(pass => ({
          ...pass, status: passStatus(pass), usedYuan: pass.used_micro_cny / 10000,
          budgetYuan: pass.budget_micro_cny / 10000,
          usedPercent: pass.used_micro_cny / pass.budget_micro_cny * 100,
          circuitBroken: Boolean(pass.circuit_broken_at || pass.used_micro_cny >= pass.budget_micro_cny),
          tokenTotals: totals.get(pass.id),
        })),
        orders: db.prepare(`SELECT id,plan_code,amount_cents,status,pass_id,created_at,expires_at,paid_at
          FROM payment_order WHERE user_id=? ORDER BY rowid DESC`).all(user.id),
        usage: db.prepare(`SELECT usage.*,production.funding,production.pass_id FROM usage LEFT JOIN production
          ON production.user_id=usage.user_id AND production.id=usage.production_id
          WHERE usage.user_id=? ORDER BY usage.created_at DESC`).all(user.id),
      };
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
