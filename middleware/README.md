# IRG Chain 888101 — Submission Middleware (FTR copy)

Identical to the copy inside the IRG_GDP repo under `middleware/`. Both
copies are kept so each app is self-contained; in production you only
need **one** running middleware instance per environment — the Django
(GDP) backend and this Node (FTR) backend both point at the same URL.

## Quick start (local dev)

```bash
cd middleware
cp .env.example .env
# edit .env — set MIDDLEWARE_SHARED_SECRET and (optional) SYSTEM_SIGNER_KEY
npm install
npm start
```

## Env vars

See `.env.example`. The important ones:

- `MIDDLEWARE_SHARED_SECRET` — must match the Django setting
  `BLOCKCHAIN_CONFIG['MIDDLEWARE_SHARED_SECRET']` and the Node backend
  env `IRG_CHAIN_MIDDLEWARE_SECRET`.
- `SYSTEM_SIGNER_KEY` — signer for backend-originated system tx. Load
  from AWS Secrets Manager / KMS. Never commit.
- `AUDIT_SINK_URL` — one of:
    - `http://<django>:8000/api/v1/chain/audit/` (GDP sink) OR
    - `http://<node>:3001/api/v1/chain/audit` (FTR sink)

  Pick whichever backend should hold the durable audit log. Typically
  both are enabled and the middleware fans out to each — for now the
  simpler single-sink design writes to one (the GDP Django backend is
  recommended since it has the fuller audit schema).

## API and security notes

Identical to the GDP copy — see
`../../IRG_GDP_Complete_System/middleware/README.md`.
