# Reporting format

## Human-readable template

```
Confirmed: 2 (critical 0, high 1, medium 1, low 0); unverified: 1; pre-existing: 0.
Verdict: BLOCK
Scope: base 7a1b... -> head 8d2c... | 12 changed files
Risk: HIGH — changes token/session handling

1) [high] [Important] src/auth/session.ts:91
   Trigger: Existing session is refreshed after its revocation flag is set.
   Evidence: Handler writes a new session without checking revoked_at; ...
   Impact: Revoked user can continue using protected endpoints.
   Verify: Confirmed by tracing revoke() and refresh() plus targeted test ...
   Fix: Refuse refresh for revoked sessions; add regression test.

Checks:
- npm run typecheck — PASS (output inspected)
- npm test -- session — FAIL (test name, relevant failure)
- browser smoke test — NOT RUN (browser not available)

Human approvals: two suggested for HIGH; not yet verified.
Rollback: revert commit X, disable flag Y if already released.
Next action: fix finding #1; run session regression tests; obtain human approval.
```

Do not use this example as evidence for a real finding. A missing test command should be `NOT RUN` not `PASS`.

## JSON format

Use `examples/review.json` as a blank schema example. Top-level fields:
- `schema_version`: string `1.0`.
- `scope`: object with optional `base`, `head`, `repository`; use null for unknown.
- `risk_tier`: `low|medium|high`.
- `verdict`: `block|review_required|ready_for_human_decision`.
- `findings`: array, each item `id`, `severity`, `category`, `path`, `line`, `trigger`, `evidence`, `impact`, `recommendation`, `verification`, `confidence`; optional `related_paths` array.
- `checks`: array, each `command`, `status` (`pass|fail|not_run`), `details`.
- `limitations`, `human_approvals`, `rollback`: text/arrays as shown in example.

For `category=important` and `verification=confirmed`, display as a finding. `category=pre_existing` is separate. `verification=unconfirmed` must never be a blocking finding by itself. `category=nit` requires explicit user request for stylistic review.

Run `python scripts/validate_review.py examples/review.json` to verify JSON *structure only* before using it for machine processing.
