# Evals: improve the reviewer using actual incidents

The outcome metric is fewer **real bugs reaching production** at equal or lower human review cost, not the number of generated review comments.

## Build a gold-standard evaluation set

For every relevant incident, rollback or bug-fix PR, keep a read-only case with:
- unique case ID, before/after commit, expected bug class, owner-confirmed root cause and precise code location;
- whether the bug was present in the reviewed diff or pre-existing;
- expected reproduction / test and actual impact;
- failure mode a reviewer should catch and false-positive traps.

Include **clean PRs**, deliberately harmless refactors and near-miss examples. Scrub customer data and secrets before using outside trusted environments. Ask an engineer familiar with the code to validate the expected labels.

## Measures (track over time)

| Metric | Aim |
| --- | --- |
| Verified bug recall | Increase detection of historical high-impact regressions |
| Precision of posted findings | Minimize unsupported comments that cause harmful fixes |
| Review rounds to pass | Prefer 1-3, stop autonomous loop at 3 |
| Median / P95 human approvals and wait time | Lower without raising post-merge incidents |
| Revert / incident rate | Guardrails: do not degrade from baseline |
| False alarms on clean PRs | Approach zero for blocker-level comments |

Tag every finding after resolution: `fixed`, `false_positive`, `intentional`, `not_worth_fixing`, or `pre_existing`. Review recurring false positives and amend `REVIEW.md`, tests or lint checks. Do not blindly optimize by muting a bug category.

Whenever prompts/model/tools change, re-run the gold set and compare to baseline. Do not claim a measured improvement unless you have actual historical comparison data.

## Lightweight manual eval log

Store CSV columns:
`case_id,review_version,expected_issues,verified_found,verified_false_alarms,rounds_to_pass,human_minutes,incident_after_merge,notes`

Use this when measurement infrastructure is not available. It is not an automatic score without labeled cases.
