# IRG_FTR ↔ IRG Chain 888101 Integration (v2.7)

Companion document to `../IRG_GDP_Complete_System/CHAIN_INTEGRATION.md`.
Both apps share a single blockchain backend and stay parallel — no merging.

---

## What changed in this repo

```
irg-ftr-platform-v5/
├── middleware/                                    [NEW — mirrored from GDP]
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   ├── k8s-deployment.yaml
│   └── README.md
├── backend/
│   ├── .env.example                                [NEW]
│   ├── package.json                                [PATCHED — added ethers]
│   ├── prisma/
│   │   ├── schema.prisma                           [APPENDED ChainTxAudit model]
│   │   └── migrations/
│   │       └── 20260417000001_add_chain_tx_audit/
│   │           └── migration.sql                   [NEW]
│   └── src/
│       ├── services/
│       │   └── chain-submit.service.ts             [NEW — the gateway]
│       ├── routes/
│       │   ├── chain.routes.ts                     [NEW — audit sink]
│       │   └── index.ts                            [PATCHED — wired up]
│       └── modules/
│           ├── swap/services/
│           │   └── blockchain.service.ts           [PATCHED — default 888101,
│           │                                         gateway routing]
│           └── registration/services/
│               └── wallet.service.ts               [PATCHED —
│                                                     linkRegistrationToBlockchain
│                                                     now calls the gateway]
```

No other files were touched.

---

## Deployment

### 1. Point the FTR backend at the same middleware as the GDP backend

```bash
cd backend
cp .env.example .env
# edit:
#   IRG_CHAIN_MIDDLEWARE_URL    = same as Django's IRG_CHAIN_MIDDLEWARE_URL
#   IRG_CHAIN_MIDDLEWARE_SECRET = same HMAC secret
#   IRG_CHAIN_AUDIT_TOKEN       = same bearer token
#   ADDR_FTR_TOKEN, ADDR_IDENTITY_REGISTRY, ... = deployed contract addresses
```

### 2. Install dependencies and run the migration

```bash
cd backend
npm install        # pulls in ethers + @prisma/client + @types/node
npx prisma migrate deploy
npm run dev
```

### 3. Verify registration → wallet → chain

```bash
# Hit POST /api/v1/registration/... to create a test participant
# Then:
psql $DATABASE_URL -c "SELECT module, action, status, \"txHash\"
                       FROM \"ChainTxAudit\"
                       ORDER BY \"createdAt\" DESC LIMIT 5;"
# Expected: a row with module='registration', action='link_wallet',
# status='SUBMITTED' (or 'SIMULATED' in dev), and a real 0x... hash.
```

### 4. Verify swap → chain

```bash
# Hit POST /api/v1/swap/... to execute a swap
# Then the same query should show a new row with module='swap'.
```

---

## What each module now pushes on-chain

| Module | Action(s) audit-logged |
| --- | --- |
| `registration` | `link_wallet` — new participant's wallet recorded in IdentityRegistry |
| `swap` | `surrender`, `execute_swap`, `burn`, `batch_transfer` |
| Future: `redemption`, `roi`, `admin` | Add more call sites to `chain-submit.service.ts` as needed |

The gateway is deliberately a single module — any future FTR feature
that creates a transaction should import `systemSubmit` / `rawSubmit`
and never talk to the middleware directly.

---

## Behaviour when middleware is not configured

Set `IRG_CHAIN_ALLOW_SIMULATE=true` in `.env` (default in dev) and the
gateway returns a deterministic simulated hash, marks the audit row
`SIMULATED`, and logs the reason. Flip to `false` in production so a
misconfigured deploy fails loudly instead of silently producing fake
hashes.

---

**IPR Owner: Rohit Tidke | © 2026 Intech Research Group**
