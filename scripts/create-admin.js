// Create (or update) an administrator account in the database configured in .env.
//   node scripts/create-admin.js --email admin@e1000signer.com --password "secret" [--name "Admin"]
// If the email exists, the account is promoted to admin, verified, activated and its password reset.
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const email = opt('--email')?.trim().toLowerCase();
const password = opt('--password');
const name = opt('--name') || 'Administrator';

if (!email || !password) {
  console.log('Usage: node scripts/create-admin.js --email <email> --password <password> [--name <name>]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
  `INSERT INTO users(email, password_hash, full_name, usertype_id, is_verified, is_active)
   SELECT $1, $2, $3, id, TRUE, TRUE FROM usertypes WHERE code = 'admin'
   ON CONFLICT (lower(email)) DO UPDATE SET
     password_hash = EXCLUDED.password_hash, usertype_id = EXCLUDED.usertype_id,
     is_verified = TRUE, is_active = TRUE, updated_at = now()
   RETURNING id, (xmax = 0) AS created`,
  [email, hash, name],
);
console.log(rows[0].created ? `✔ admin created: ${email}` : `✔ existing account promoted/updated: ${email}`);
await pool.end();
