# Archon Internal Engineering Documentation

This directory holds internal engineering documents for the `shhaider/Archon`
fork: Architecture Decision Records (ADRs), audit packets, and roadmap-tier
analyses.

This is **not** the public end-user documentation site. The public Astro site
lives at `packages/docs-web/` and is published at `https://archon.diy`. Edits
in `docs/` do not change the public site, and edits in `packages/docs-web/`
should not be made for internal-only material.

## Layout

- `docs/adr/` — Architecture Decision Records, numbered sequentially.
  - `NNNN-<kebab-name>.md` is the ADR itself.
  - A matching `docs/adr/<topic>/` subdirectory may hold supporting evidence
    packets (capability matrices, code citations, side-by-side comparisons)
    when the decision needs more depth than fits in a single ADR.

## ADR Convention

ADRs use a MADR-lite header — `Status` / `Date` / `Roadmap` / `Audit packet` —
followed by `Context` → `Decision` → `Decision Matrix` → `Consequences` →
`Non-Goals` → `References`. The first ADR in this repo
(`docs/adr/0001-emdash-port-evaluation.md`) sets that template; future ADRs
may supersede it with an explicit `0002` decision rather than mutating the
convention silently.

New ADRs should:

- Cite primary code by relative path with line ranges (e.g.
  `packages/isolation/src/types.ts:168-187`).
- Name an owning Archon module (a real path inside `packages/`) for any
  PORT or EXTRACT-PATTERN verdict.
- Keep the ADR file itself short; place evidence in a sibling subdirectory
  when the comparison is large.
