# Review playbook: exact evidence over speculative comments

## Before generating findings

Write a private threat/failure map by subsystem. Read requirement/ticket or PR description, changed paths, entry points/call sites, recently changed APIs, tests and deployment topology. If the user supplies only a patch without surrounding repository, highlight incomplete context.

**Independent discovery passes when supported**
- Functional reviewer: root cause, API contracts, edge cases, data flow and state.
- Security/data reviewer: trust boundaries, access control, race conditions, migrations, secrets and financial integrity.
- Regression/deploy reviewer: affected consumers, tests, runtime config, logs, observability, rollback.
- Independent verification reviewer: adversarially try to refute each candidate, read surrounding source and tests, discard unverifiable conjecture.

Multiple passes by one agent are *not* statistically independent votes. Never claim that several agents agreed unless they genuinely ran separately. Run code/tests only where project instructions and available tools allow it.

## Evidence checklist per finding

1. File and line correspond to the **reviewed head**. Cite exact path, function and relevant lines.
2. Input/event sequence triggering the issue is possible under project assumptions.
3. Changed code is a causal contributor (or explicitly mark pre-existing).
4. There is no surrounding guard/caller invariant/test making the issue impossible.
5. Downstream consequence is concrete: exception, unauthorized data access, incorrect total, lost notification, false-success UI, unavailable rollback, etc.
6. Severity reflects realistic impact and likelihood; confidence reflects quality of evidence, not severity.
7. A safe, small regression test or remediation exists; if not, disclose investigation requirement.

Do not fabricate observed logs, screenshots, test output, timelines or precise line numbers. Prefer `file:line` to vague descriptions. Do not publish unconfirmed candidates as blockers.

## Boundary conditions to prioritize

- Missing/null/empty and malformed inputs; unexpected file columns or date formats.
- Duplicates and idempotency, retries and transaction boundaries.
- Concurrent requests, stale sessions, token reuse, race windows.
- Roles and tenant boundaries; account switching and elevated operations.
- Time zones, date cutoffs, DST, sort order and pagination.
- Precision/rounding, negative amounts, refunds, split or paired dates, sums across entities.
- Error rendering, partial failure, cache invalidation, silent exceptions.
- Config drift, environment variables, webhook callbacks, eventual consistency.
- Backwards compatibility, schema changes, deleted/renamed fields and deployed clients.
- UI states: loading, empty, error, permission denied, long tables, phone viewport.

## Severity rubric

- **critical:** immediately exploitable major compromise / irreversible extensive data loss / systemic outage.
- **high:** severe reachable bug, unauthorized action/data exposure, financial corruption, widespread service failure.
- **medium:** wrong user behavior affecting nontrivial cases; material operational issue with workaround.
- **low:** limited regression with demonstrable practical impact.

Style-only nits are dropped unless specifically requested. Confidence should be `high`, `medium` or `low`; only verified candidates with grounded evidence are suitable for publication. A failed test proves failure of a test, not automatically the proposed root cause.

## Clean review still explains limits

Examples: tests not run (no dependencies); only partial code provided; external auth provider inaccessible; production permissions not replicable; browser unavailable; no telemetry or rollbacks configured. 'No confirmed findings' means exactly that, not 'the code is perfect'.

## Convergence rules

- After a fix, compare the new diff to the previously reviewed commit; restrict scope to new changes and affected call sites.
- Suppress repeated issues using stable class + path + root cause, and document closure with evidence.
- Round 3 is the last autonomous fix/review attempt. Escalate if redesign is needed.
- Avoid creating changes merely to satisfy a stylistic suggestion.
