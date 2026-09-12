# Tachiko model routing

Use this as the current default routing policy, not as a substitute for repository-specific constraints or a direct user choice.

## Roles

- **Luna** — default implementation sub-agent for scoped, well-specified coding work. Prefer Low for small/local changes and Medium for multi-file, validation-heavy, or moderately ambiguous implementation. Use High only when difficult debugging or semantics justify it.
- **Terra** — default long-lived serial captain when the job is to own a queue, choose the next ready Issue, coordinate phases, or keep a long implementation session converging. Medium is the normal starting point. Delegate well-scoped implementation lanes to Luna when that reduces cost without losing ownership.
- **Sol** — default independent reviewer and critical consultant. Medium is the normal review level; use High for difficult semantic, architectural, migration, or correctness review. Preserve independence from the implementing agent when possible.
- **Astra** — reserve for architecture-level decisions, unusually high ambiguity, or risk where stronger global reasoning materially changes the outcome. Do not choose Astra merely because a task is long.

## Effort heuristic

- **Low** — routine and local with a strong contract and cheap verification.
- **Medium** — default for multi-step implementation, serial stewardship, or review with meaningful interactions across files/components.
- **High** — hard debugging, migrations, deep semantic review, or ambiguity that cannot be cheaply reduced first.
- **Extra-high / xhigh** — exceptional; use only when the additional reasoning is clearly worth the cost and the selected surface supports it.

Prefer the smallest capable route. Reduce ambiguity in the Issue before upgrading the model. Keep implementation and independent review roles separate when the workflow benefits from an unbiased exact-HEAD review.
