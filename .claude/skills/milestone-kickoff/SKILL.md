---
name: milestone-kickoff
description: Use when starting work on the next idempotix milestone, or when the user asks to begin/continue a specific milestone from CLAUDE.md's milestone list.
---

Before writing any implementation code for a milestone:

1. Read CLAUDE.md's milestone list and check the actual repo state (which packages/files already exist) to determine what's really done — do not trust a stale checklist over the real filesystem/git history.
2. For every external library, framework, or API the milestone touches (NestJS, Prisma, TypeORM, nestjs-cls, @opentelemetry/api, etc.), verify current behavior against the installed node_modules version or official docs — never rely on training memory, since these APIs are explicitly version-sensitive (e.g. Prisma 7 removed `$metrics`/`$use` in favor of `$extends`).
3. For anything beyond a trivial fix, use plan mode: present a short concrete plan (files to add/change, key design decisions, how it will be tested against the shared adapter contract suite where applicable) and wait for explicit approval before writing code.
4. If a design choice is genuinely a product/business call (not a technical default), ask rather than assume.
5. Hold the quality bar of a banking-grade library: strict typing, tests alongside code, no speculative abstractions or unused flexibility, and enforce the non-negotiable principles in CLAUDE.md (same-transaction guarantee, scoped keys, cardinality-safe metrics).
6. Once the milestone is verifiably working (build/lint/typecheck/test all green), update CLAUDE.md's milestone status.
