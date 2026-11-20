import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const [database, rawCount = '1', ...extra] = process.argv.slice(2);
const count = Number(rawCount);
if (!database || extra.length || !Number.isSafeInteger(count) || count < 1 || count > 100) {
  throw new Error('用法：node invite.mjs DATABASE [数量，1 至 100]');
}
const db = new DatabaseSync(database, { readOnly: false });
try {
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const insert = db.prepare('INSERT INTO invite_code(hash) VALUES (?)');
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(24).toString('base64url');
    insert.run(createHash('sha256').update(code).digest('hex'));
    codes.push(code);
  }
  db.exec('COMMIT');
  console.log(codes.join('\n'));
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
