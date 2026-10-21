# Risk-based review policy

Risk is determined by *impact and blast radius of the actual change*, not number of lines or the author's reputation. The following is a conservative starting point; project owners must approve rules before enforcing them.

| Tier | Typical changes | Depth | Suggested human reviewers | Required evidence |
| --- | --- | --- | --- | --- |
| LOW | Docs/copy, isolated UI text, internal-only additive behavior behind a disabled feature flag | QUICK | Owner may allow zero *only for trusted authors with enforceable green automated gates* | Changed-file scan, smoke test, relevant CI, reversibility |
| MEDIUM | Normal product/business logic, UI workflows, external API integration, cache behavior | STANDARD | At least one accountable person | Targeted tests + type/build as relevant, error path, regression proof |
| HIGH | Authn/authz, MFA/OTP, sessions, payments, financial balances, migrations, data deletion, PII, secrets, production configs, CI/workflows, release automation, webhooks, permissions, security controls | DEEP | Two people or established CODEOWNERS policy | Independent security review, negative tests, full relevant CI, rollback drill/plan, monitored rollout |

Escalate to HIGH when a small change has irreversible consequences, affects many users/accounts, or monitoring/rollback is weak. Consider dependencies changed transitively, feature flags default state and who can turn them off.

Untrusted contributor: require an additional human review even for LOW; AI output never fills a human slot. For critical paths, require named code owners independently of classifier estimates.

## Verdict meanings

- **BLOCK:** confirmed critical/high regression, security flaw, dangerous data change; or an explicitly required check demonstrably failed. Do not approve or deploy.
- **REVIEW REQUIRED:** meaningful uncertainty, absent mandatory human sign-off, missing mandatory check or incomplete rollout/rollback coverage.
- **READY FOR HUMAN DECISION:** no confirmed blockers, relevant tests witnessed passing, approval/rollback requirements explicit. Not a guarantee of zero defects.

Human sign-off is tied to the inspected commit; if unreviewed code is added after sign-off, the platform should invalidate approval or the human should re-review.

## Suggested default protected paths

`**/auth/**`, `**/security/**`, `**/billing/**`, `**/payments/**`, `**/migrations/**`, `**/import/**`, `.github/workflows/**`, `Dockerfile*`, `docker-compose*`, `**/deploy/**`, `**/infra/**`, `**/secrets/**`, production environment configuration.

Path matching is advisory here. Configure actual CODEOWNERS and branch protection in GitHub/GitLab; a Markdown instruction does not secure a repository.
