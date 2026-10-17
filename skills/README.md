# Tachiko stewardship Skills

This repository keeps two intentionally different Skill surfaces:

- `skills/` is the canonical portable source used for reusable/uploadable Tachiko stewardship Skills.
- `.agents/skills/` contains thin repository-local discovery entrypoints so Codex can find those canonical Skills from a normal checkout.

Do not maintain independent full copies in both locations. A discovery entrypoint should contain only enough metadata for selective activation plus a pointer to its canonical `skills/<name>/SKILL.md`.

Repository governance, Issues, PRs, and accepted specifications remain higher authority than any Skill.
