# Task Briefs Manifest Index

> **Single Source of Truth (SSOT) Manifest** untuk seluruh dokumen Task Brief aktif pada proyek `@dimassetoid/strata-mcp`.

---

## Active Briefs Matrix

| No | Kategori | Judul Brief | Status | Dokumen Link | Tanggal |
| :---: | :--- | :--- | :---: | :--- | :---: |
| 1 | `refactor` | SQLite Graph Closure & Zero-Disk Downward Tree Traversal | `Completed` | [sqlite-graph-closure-and-downward-tree.md](./2026-09/refactor/sqlite-graph-closure-and-downward-tree.md) | 2026-09-19 |
| 2 | `refactor` | Granular State Tracking & Mutator/Reader Ingestion | `Completed` | [granular-state-access-tracking.md](./2026-09/refactor/granular-state-access-tracking.md) | 2026-09-19 |
| 3 | `refactor` | AST-Native Parser Migration (Eliminating Heuristic RegEx) | `Completed` | [ast-native-parser-migration.md](./2026-09/refactor/ast-native-parser-migration.md) | 2026-09-19 |
| 4 | `refactor` | Modularize Engine God Modules (Decomposing SRP Violations) | `Draft` | [modularize-engine-god-modules.md](./2026-09/refactor/modularize-engine-god-modules.md) | 2026-09-19 |
| 5 | `feature` | Strata-MCP Observability & Analytics Telemetry Engine | `Completed` | [observability-and-telemetry-readiness.md](./2026-09/feature/observability-and-telemetry-readiness.md) | 2026-09-30 |
| 6 | `feature` | Bidirectional Data Transport Engine & Fullstack API Stitching Bridge | `Completed` | [bidirectional-transport-and-fullstack-bridge.md](./2026-09/feature/bidirectional-transport-and-fullstack-bridge.md) | 2026-09-30 |

---

## Roadmap Rekomendasi Urutan Pengerjaan

```mermaid
flowchart TD
    B1["Brief 1: SQLite Graph Closure & Downward Tree<br/>(Enrich edges schema & zero-disk downward tree)"]
    B2["Brief 2: Granular State Tracking<br/>(Enrich state_deps access_mode & native SQL queries)"]
    B3["Brief 3: AST-Native Parser Migration<br/>(Eliminate regex heuristics in context/props)"]
    B4["Brief 4: Modularize God Modules<br/>(Decompose contract.ts, tree.ts, database.ts)"]

    B1 --> B2
    B1 --> B3
    B2 --> B4
    B3 --> B4
```
