# e1000_signer_main

E1000Signer backend: Node.js (ESM) + Express 5 + PostgreSQL.

```bash
npm install
npm run db:setup   # db:migrate + db:seed (idempotent)
npm run dev        # http://localhost:4000 (nodemon)
npm start          # production
```

- Config: `.env` (copy from `.env.example`). Never commit `.env`.
- Schema: `db/migrations/*.sql`; RBAC catalog: `src/config/rbac.js`.
- Public API: `/api/v1` with `X-API-Key`; spec at `/api/v1/openapi.json`; widget at `/embed.js`.

Details: [../.ai-knowledge/](../.ai-knowledge/README.md).
