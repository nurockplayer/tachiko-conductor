# Issue #16 bounded acceptance evidence

Authority: [campaign #14](https://github.com/nurockplayer/tachiko-conductor/issues/14),
[#16 canonical handoff](https://github.com/nurockplayer/tachiko-conductor/issues/16#issuecomment-5501293224),
[Accepted #26](https://github.com/nurockplayer/tachiko-conductor/issues/26#issuecomment-5537799440),
[accepted coverage matrix](https://github.com/nurockplayer/tachiko-conductor/pull/27#issuecomment-5547896007),
[bounded E1–E7 authorization](https://github.com/nurockplayer/tachiko-conductor/pull/27#issuecomment-5547943178),
[campaign takeover](https://github.com/nurockplayer/tachiko-conductor/pull/27#issuecomment-5548714601).

Baseline is `6a4328bc64fc731d6005c9b670cae1c6deadecbf`. This document belongs to the
implementation commit; the [unique live handoff](https://github.com/nurockplayer/tachiko-conductor/pull/27#issuecomment-5548757894)
binds its exact final SHA, commands/results, returned independent review, and live
GitHub state. A later commit requires renewed final verification and review.

**DEFERRED TO #20 — NOT IMPLEMENTED / NOT PROVEN:** real validation-command execution,
exact-HEAD provenance, and validation pending-state engine. VALIDATING in these
fixtures proves identity/routing and review invalidation. MERGE_READY with controlled
GitHub/reviewer responses is not unattended permission or a real validation run by
Conductor. Steward acceptance remains required; no merge or #25 authorization.

## Evidence method and limits

- `bootstrap-fixture.ts` uses actual Git, local bare remotes, linked worktrees,
  ancestry/ref/cleanliness checks and test-owned temporary directories. Only remote
  URL identity reads are substituted for the local transport. Race tests name the
  injected observation and assert the surviving real refs/workspace.
- `bootstrap-workflow.test.ts` uses real JsonFileStore and real bootstrap for the
  lifecycle scenarios. GitHub/provider/reviewer responses are controlled doubles;
  publication counts count fixture calls, not hosted GitHub transactions. Call-site
  rejection tables intentionally use sentinels to assert zero side effects.
- `bootstrap-provider.test.ts` runs both actual adapters/guards, but every provider
  command is a deterministic stub; only Git may reach the real process runner.
- Early provider fixture delegation accidentally spawned real providers in temporary
  test workspaces. That run was interrupted and its identified process trees stopped;
  it is excluded from passing evidence. The corrected fixture and subsequent complete
  suite are the evidence. This was not an authorized/claimed real-provider smoke test.
- `R→G` below means a behavioral baseline RED was observed before the corresponding
  production repair, followed by GREEN. `C` means coverage added or strengthened after
  the repair, or already-green coverage; it is not claimed to have preceded the repair.
  The ordinary-failure NEW-head test was strengthened after repair: an in-memory
  transpilation of the exact baseline state machine reproduced fresh-store corruption
  afterward (`BASELINE_REPLAY_CONFIRMED`), so this is explicitly a retrospective RED
  replay, not a test-first claim. Harness/protocol failures are not behavioral RED.

## Contract → implementation → assertion matrix

Test names below are searchable exact names or unique prefixes. W =
`src/workspace/git-worktree-bootstrap.ts`, F = `src/workflow/run.ts`, R =
`src/reviewers/loop.ts`, P = `src/workflow/pull-request-identity.ts`, S =
`src/domain/state-machine.ts`, C = `src/cli.ts`, G = `src/github/live-state.ts`.
Symbols I/B/H/G/R/L/W retain Accepted #26 meanings; the file shorthand W is used
only in the implementation column.

| Obligation | Implementation | Test / concrete assertion | Evidence class |
| --- | --- | --- | --- |
| A1 equal L=R=H=G, existing clean W | W.prepare exact refs and post-proof | recovery `does not add or move refs…`: no merge/update-ref/add; lifecycle fresh stores retain I/H/PR | C |
| A2 clean L behind accepted R | W ancestry then only `merge --ff-only` | workflow `carries an accepted sync…`: actual offered sync, fresh JSON, exactly one FF to new H, review sees new H then fix H | C integration; sync R→G |
| A3 local ahead, existing/missing W | W rejects non-ancestor before repair | recovery `preserves an ahead local commit…` both cases: local SHA/blob/remote retained; zero repair commands | C |
| A4 divergent graph | W same ancestry gate | recovery `accepts a real descendant commit and rejects a divergent recovery head`: positive durable descendant, divergence rejected | C |
| A5 same tuple, stale accepted H | P separates ownership from head advancement; F/R offer sync | workflow `offers exact live-head…`, `admission/re-read head…`: exact choice, old H/PR, no prepare/spawn; repeating without acceptance preserves old ledger | R→G at review boundary; C for additional call sites |
| A6 explicit accepted sync | C fresh tuple + S atomic H/PR; F VALIDATING and new review | workflow `persists an offered…` and `carries an accepted sync…`: new store read/list/resume, same I/PR/executor, human_resolved→VALIDATING, no reuse of old approval | R→G; full validation deferred #20 |
| A7 missing W: equal, absent L, behind L | W registration proof → expected-old CAS → explicit branch add | existing git-worktree test exact stale registration; recovery `rebuilds a missing workspace…`, `missing workspace behind recovery: none/cas`: exact remote tip without tracking fallback, CAS expected-old, concurrent commit preserved/no W on failed CAS | C; locked pre-CAS preservation R→G |
| A7 invalid registration | W.assertRegistration before ref mutation/add | recovery locked, foreign registration, wrong-registration, duplicate-registration: rejection, original L, no repair; only exact unlocked record allows narrow force add | locked R→G; others C |
| A8 foreign common Git dir | W.assertWorkspace | recovery `rejects a standalone checkout…`: same path/branch/SHA still rejected, original checkout retained; both provider common-dir cases zero spawn | C |
| A9 tracked/untracked dirty | W clean prepare/pre/post guard | recovery `preserves dirty…` retains bytes/L, no repair; provider dirty pre-spawn; workflow guard pre/post parks and fresh JSON resumes | pre-spawn dirty R→G; additional routes C |
| A10 unproved remote/endpoints/fetch/ancestry | W remote/fetch/base proof before mutation | recovery missing-remote/fetch-head/endpoints/stale live B/orphan cases: no local repair; wrong push URL list existing regression retained | orphan R→G; controls C |
| A10 mutation followed by drift | W post remote re-read; F/R post-prepare tuple read | recovery `post-remote`: allowed CAS/add remain at accepted tip, remote drift rejects without reset/push; workflow `post-tuple` permits prepare only, no spawn/H change | C |
| B pre-PR only L/only R/equal LR | W candidate from surviving replica, immutable B proof, no ledger write | three `reconstructs a pre-PR workspace…` positives; JSON checkpoint cases subsequently invoke normal implementation/acceptance once | R→G |
| B initial live base and slash ref | W literal Git branch validation; F persists I before prepare | recovery `accepts a literal slash…` plan→prepare; workflow initial no-PR uses `feature/stable`, live B newer than source checkout and asserts starting HEAD/I.baseSha equals live B | slash plan R→G; integrated path C |
| B malformed literal refs / filesystem domain | W Git `check-ref-format --branch`, reject contextual `@{` syntax, no normalize | recovery malformed table includes slash/space/reflog/HEAD/lock/trailing slash failures before fetch; existing containment/CLI tests retained | C |
| B initial crash exception | F preflight tuple, ephemeral candidate, W durable proof before S acceptance | workflow adoption existing/missing W: no implementation, coherent fresh JSON; no-delta/orphan/wrong tuple: no H/PR adoption or spawn | missing-W integrated C; shared ancestry/progress R→G |
| B durable B ancestry and reviewed-H progress | W unconditional B ancestry, separate H ancestry/tree delta | recovery direct clean published orphan; no-progress H=B; workflow direct/resumed H=B same-head/same-tree/orphan reject, valid delta succeeds and JSON H=PR | direct durable R→G; all route combinations C |
| B ownership at recovery/direct/resumed/validation/review | P reused in F/R before action and after prepare | workflow recovery IMPLEMENTING, stage table, direct/resumed admission/re-read: wrong tuple/disappeared PR cannot prepare/spawn/review; legitimate drift offers sync | R→G at original observed cases; strengthened tables C |
| B final fresh tuple | F final P before readiness | workflow final-gate number/head owner/repo/ref/base/missing ref cases all NEEDS_HUMAN, never MERGE_READY | R→G |
| B snapshot coherence | G compares number/state/SHA and raw ownership tuple across reads | github-live-state `refuses same-HEAD ownership drift…` table changes head/base refs and head repository during read, expects GH_SNAPSHOT_CHANGED | R→G |
| C success HEAD writers | S requires same-transition verified PR payload and retained PR number; F/R durable before write | workflow initial/direct/resumed successes fresh JSON; `rejects unproved HEAD-writing…` rejects omitted/replaced PR and unrelated transition payloads | C plus E1 repair |
| C sync admission | C P check before write; S sync requires PR payload | workflow `sync admission rejects…`: changed PR number leaves NEEDS_HUMAN/old H/PR; offered sync positive resumes from fresh store | C plus sync R→G |
| C ordinary failed observation | S preserves accepted bootstrap H/PR, new failed observation in agentResult | workflow ordinary bootstrap failure: actual transition→update→fresh read/list yields FAILED, old H/PR and agentResult NEW; existing non-bootstrap failure suite unchanged | retrospective baseline replay RED → current GREEN |
| D empty reservation / checkpoint restart | W creates parent only, never reserves/auto-adopts leaf | recovery `resumes after parent mkdir…`: interrupted add leaves no leaf, original branch, restart same I; lifecycle identity/branch/published checkpoint and PR crash fixtures avoid duplicate successful implementation/PR | C |
| D execution-boundary/provider-neutral recovery | W prepared starting H + clean identity; provider pre/post phases | both providers reject head/branch/push/common-dir before spawn and dirty/branch after successful result; clean new HEAD allowed; actual adapter + Git + JSON initial/direct/resumed pre/post guard scenarios park and resume | dirty pre-guard R→G; parity/resume C |
| D retained historical assertions | Existing CLI, path, workflow, review-loop/store suites | payload-free bootstrap transition rejected; nested `..workspaces` vs sibling containment; manual non-bootstrap PR path and ordinary provider failure unchanged | Existing coverage retained |

Historical #23 findings map respectively: 3912248220 / 3931476331 → A10 endpoints;
3912248232 → A7; 3916364479 → D checkpoint; 3931612779 → B durable progress;
3931612782 → D CLI; 3931746523 → A8; 3931746526 → D provider recovery;
3931946876 → A2/A5/A6; 3932551303 → D containment; 3938220874 → D execution boundary.
No #23 code or branch is revived.

## Verification and bounded review

Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check` on the exact
committed candidate. Tests before the final commit are provisional working-tree
checks only. The live handoff records final counts and any failure, real returned
independent review and model evidence limits, and the consolidation budget (at most
one repair batch after the first fresh review). CI absence is not CI success.
A green local suite and returned review do not substitute for Steward acceptance.


## First independent review and the single consolidation batch

The first completed read-only review covered
`a463d145403ad48b95cb52a3a15f3894107e9cf2` and returned one P2, with no other P0–P2.
The reviewer independently ran 112 relevant tests successfully and used two actual
Git/JSON temporary probes: H/PR absent, first live PR #11/G1, then either #11/G2
(clean descendant, published) or #12/G1 after preparation. Both were wrongly adopted.
This maps to A10 and B initial-persistence candidate stability, not a new policy.
The configured reviewer role first failed to launch (unsupported model); that failed
attempt is not review evidence. The successful fresh read-only task did not expose
an independently verifiable runtime model ID.

The only consolidation batch adds `E2 initial crash candidate head/number drift…`.
Both tests were run before the fix on the reviewed commit and produced behavioral
RED: actual `merge_ready`, expected `needs_human` (0/2 pass). F now retains the already
selected initial PR number/HEAD ephemerally and compares the post-prepare snapshot
before adoption. Drift parks without writing H/PR, spawning implementation/reviewer,
or resetting refs/workspace. The no-PR initial route remains a distinct case; no
persisted field, state, or recovery policy was added. Final exact-SHA GREEN and the
subsequent independent review are recorded in the live handoff. Consolidation: **1/1**;
any remaining substantive P0–P2 requires stopping for Steward, not another repair loop.
