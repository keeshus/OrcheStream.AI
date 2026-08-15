# Plan: Per-Run Environment Variable Overrides (Manual + Webhook, not Schedules)

## Summary

Allow a flow run to **override the flow's configured environment variables for that run only**
— either with plaintext values or with references to secrets (core secrets / CyberArk).
The overrides are available on:

- **Manual runs** — the editor's debug overlay and the quick-run dialog on the flow cards.
- **Webhook-triggered runs** — callers include the overrides in the webhook request body.

**Not** on schedules — scheduled runs always use the flow's configured environment.

The flow's saved configuration is never modified.

---

## Override value model

Each override value is one of:

| Form | Example | Resolution |
|---|---|---|
| Plaintext string | `"API_KEY": "sk-123"` | Used as-is for this run. Allowed for any flow-configured var, including secret-typed ones. |
| Core secret reference | `"API_KEY": { "type": "core_secret", "value": "my-secret-name" }` | Resolved server-side from the secret store (scoped, see below). |
| CyberArk reference | `"DB_PASS": { "type": "cyberark", "value": "prod/db/password" }` | Resolved live from the flow group's bound Conjur vault. |

Example request shape (manual and webhook):

```json
{
  "input": { "message": "hello" },
  "envOverrides": {
    "API_KEY": "sk-123",
    "DB_PASS": { "type": "core_secret", "value": "db-pass" },
    "VAULT_TOKEN": { "type": "cyberark", "value": "prod/token" }
  }
}
```

---

## Scoping & security rules

1. **Name allowlist** — only variables **configured on the flow** (`flows.env_vars`) may be
   overridden. Names not present on the flow are silently ignored. This is a hard boundary:
   code nodes execute user JS with `process.env`, so arbitrary environment injection must be
   impossible.
2. **Secret scope** — a `core_secret` reference resolves only within the flow's own scope,
   in order:
   1. flow-scoped secrets (`scope_id = flow.id`)
   2. group-scoped secrets (`scope_id = flow.group_id`)
   3. app-wide secrets
   - A flow in group G can never reference group H's secrets.
   - **Global (unassigned) flows**: flow-scoped + app-wide only.
   - The lookup filters by `scope_id`, never by name alone.
3. **CyberArk scope** — resolved via the flow group's bound vault (`groupVaultConfig`);
   falls back to a connected vault for global flows. Same posture as existing resolution.
4. **Validation** — `envOverrides` must be a flat map of `string` or `{ type, value }`
   objects (`type` ∈ `core_secret` | `cyberark`); anything else → `400`.
5. **Audit** — secret references resolved for an override are written to the secret access
   log, same as normal secret resolution.
6. **Persistence (decided: yes)** — overrides are **persisted to run history** on the
   execution record under `__envOverrides`, needed for auditing. What is stored is exactly
   what the caller supplied — plaintext values and `{ type, value }` secret references
   (names/paths, **never** the resolved secret plaintext). Resolved values exist only in the
   sandbox during execution. The run history therefore shows what was requested, not what
   was decrypted.

---

## Data layer

No schema changes. The allowlist lives in the existing `flows.env_vars` column
(`[{ name, type: 'static' | 'core_secret' | 'cyberark', value }]`).

---

## Implementation

### Worker

| File | Change |
|---|---|
| `worker/src/executor/context.ts` | Add `envOverrides?: Record<string, string \| { type: 'core_secret' \| 'cyberark'; value: string }>` to `ContextBuilderOptions`. After the flow's own env resolution loop, merge overrides: plaintext → set directly; `core_secret` → scoped lookup (flow → group → app, filtered by `scope_id`) → `logSecretAccess`; `cyberark` → `getCyberArkSecret`. Names not in `flow.envVars` are skipped. |
| `worker/src/queue.ts` | Job payload type gains `envOverrides?`. |
| `worker/src/run.ts` | Pass `job.envOverrides` into the runner. |
| `worker/src/executor/runner.ts` | Thread `envOverrides` into `buildExecutionContext`. |

### Backend

| File | Change |
|---|---|
| `backend/src/routes/execution.ts` | Read + validate `envOverrides` from the request body; pass to the in-process debug path and into the enqueued job. Keep the existing `__env` strip. |
| `backend/src/routes/webhook-openapi.ts` | **POST /webhook/:slug**: extract `envOverrides` from the body **before** schema validation (so `additionalProperties: false` schemas don't reject it); validate shape; strip from the flow `input`; enqueue with `envOverrides`. **Bugfix**: include `envVars: flow.env_vars` in the `flowDef` — webhook runs currently resolve no flow env vars at all, and the override allowlist depends on this. |
| `backend/src/routes/webhook-openapi.ts` (openapi.json) | Document the field in the generated request schema: `envOverrides: { type: 'object', additionalProperties: { anyOf: [string, { type, value }] } }` with a description. Never enumerate secret names. |
| `backend/src/routes/webhook.ts` | Mirror the extraction in the shadowed duplicate POST handler (consistency; mounted after webhook-openapi). |

### Frontend

| File | Change |
|---|---|
| `frontend/src/components/ui/RunModal.tsx` + `frontend/pages/index.tsx` | Collapsible **Environment overrides** section: one row per flow-configured var with a type toggle (**Plaintext / Core Secret / CyberArk**); the secret dropdown lists only secrets in the flow's scope (app + flow group + flow-scoped; app + flow-scoped for global flows); CyberArk option only when the flow's group has a bound vault; rows prefilled with the configured values; reset button. Sends `envOverrides` with the run. |
| `frontend/src/components/flow/DebugOverlay.tsx` | Same section in the editor's run panel. |
| `frontend/src/lib/api-client.ts` | `flows.execute` accepts `envOverrides`. |

---

## UI sketch

```
┌ Run Walk Manual Flow ─────────────────────────────┐
│ Trigger input for this run                        │
│ { "message": "Hello!" }                           │
│                                                   │
│ ▸ Environment overrides                           │
│   API_KEY      [Plaintext ▾] [sk-123          ]   │
│   DB_PASS      [Core Secret ▾] [db-pass      ▾]   │
│   VAULT_TOKEN  [CyberArk ▾]    [prod/token     ]  │
│                                   [Reset]         │
│                      [Cancel]  [Run]              │
└───────────────────────────────────────────────────┘
```

---

## Tests

1. **Unit (`context.ts`)** — override merge:
   - plaintext / core_secret / cyberark forms;
   - allowlist (unknown names ignored);
   - scope filtering (group H's secret unresolvable from group G's flow);
   - secret-typed flow vars overridable with plaintext;
   - unresolved secret references silently skipped.
2. **E2E manual (debug overlay)** — override with plaintext and with a core_secret reference;
   a code node returns `process.env.X`; assert the override wins; empty field keeps the
   configured value.
3. **E2E quick run (RunModal)** — same via the flow-card Run dialog.
4. **E2E webhook** — POST with a plaintext override → code node sees it; POST with a
   core_secret reference (app-scoped and group-scoped variants) → resolved; reference to a
   secret outside the flow's group → ignored; invalid override shape → `400`; without
   overrides → configured values (regression for the `flowDef.envVars` fix).
5. **E2E OpenAPI** — the generated spec documents the override shapes.
6. **E2E run history** — after a manual quick-run with overrides, the persisted execution
   record contains `__envOverrides` with exactly what was supplied (plaintext values and
   secret references — never resolved secret values), visible for auditing.
7. **Schedules** — untouched; existing schedule spec stays green.
8. Full parallel E2E suite.

---

## Hardening follow-up (recommended, separate change)

The **template** resolution path (`resolveTemplate` → `getSecret`) currently resolves
secrets by name + scope **without filtering `scope_id`** — a group-scoped secret whose name
matches could resolve for a flow in another group (e.g. `{{secrets.core.group:db-pass}}` in
group G1 returning group G2's `db-pass`). The override feature ships a correct
`scope_id`-filtered resolver; extending it to the template path closes the same gap there.

### What it means concretely

- `getSecret(name, { scope })` becomes flow-aware: `scope: 'group'` filters
  `scope_id = flow.group_id`, `scope: 'flow'` filters `scope_id = flow.id`, `'app'` stays
  as-is. `resolveTemplate` needs no signature change — the scoping happens inside
  `getSecret` using the execution context's flow.
- Same behavior for debug runs and worker runs (both build the context from the same
  builder).
- Covered by a unit test (flow in G1 with a same-named secret in G2 → not resolved) and a
  regression E2E (two groups, same secret name, template resolves only the own group's).
