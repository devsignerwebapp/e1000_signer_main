// Idempotent seed: RBAC catalog + initial admin account.
// Note: it only ADDS missing usertype→permission links; it never removes links
// that an admin added from the dashboard.
import bcrypt from 'bcryptjs';
import { pool, tx } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { USERTYPES, PERMISSIONS, USERTYPE_PERMISSIONS } from '../src/config/rbac.js';

async function main() {
  await tx(async (c) => {
    for (const t of USERTYPES) {
      await c.query(
        `INSERT INTO usertypes(code,name,description,is_paid,sort_order) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
           is_paid=EXCLUDED.is_paid, sort_order=EXCLUDED.sort_order`,
        [t.code, t.name, t.description, t.paid, t.sort],
      );
    }
    for (const p of PERMISSIONS) {
      await c.query(
        `INSERT INTO permissions(code,category,description) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET category=EXCLUDED.category, description=EXCLUDED.description`,
        [p.code, p.category, p.description],
      );
    }
    for (const [type, perms] of Object.entries(USERTYPE_PERMISSIONS)) {
      await c.query(
        `INSERT INTO usertype_permissions(usertype_id, permission_id)
         SELECT ut.id, p.id FROM usertypes ut, permissions p
         WHERE ut.code = $1 AND p.code = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [type, perms],
      );
    }
    console.log(`✔ RBAC: ${USERTYPES.length} usertypes, ${PERMISSIONS.length} permissions`);

    if (env.admin.email && env.admin.password) {
      const hash = await bcrypt.hash(env.admin.password, 12);
      const { rowCount } = await c.query(
        `INSERT INTO users(email,password_hash,full_name,usertype_id,is_verified)
         SELECT $1,$2,$3,id,TRUE FROM usertypes WHERE code='admin'
         ON CONFLICT (lower(email)) DO NOTHING`,
        [env.admin.email.toLowerCase(), hash, env.admin.name],
      );
      console.log(rowCount ? `✔ admin created: ${env.admin.email}` : `• admin already exists: ${env.admin.email}`);
    }
  });
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
