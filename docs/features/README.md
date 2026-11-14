# Strata-MCP Features — Single Source of Truth (SSOT)

Welcome to the official **Single Source of Truth (SSOT)** documentation directory for **Strata-MCP (Frontend Structural Intelligence Engine)**.

This documentation details business requirements, deep technical mechanisms (*deep AST traversal*), input/output specifications, architectural boundaries, and cross-system integrations (including Septum-MCP and Lifecycle Hooks).

---

## Feature Navigation Map

### 1. Core MCP Analysis & Inspection Tools

* **[`inspect_component.md`](./inspect_component.md)** — **Component Contract Inspection & AST Slicing**  
  Extracts public component contracts (props, emits, slots, models, state dependencies, and outbound API calls) without ingesting presentational markup templates, and slices targeted functions (*symbol slicing*) with verified caller boundaries.

* **[`get_component_tree.md`](./get_component_tree.md)** — **Component Hierarchy Topology & Blast Radius Analysis**  
  Traverses component hierarchies vertically: downwards (*downward*) to map children and detect Props Drilling (>2 levels), and upwards (*upward*) to measure the blast radius of changes across pages/views before refactoring.

* **[`trace_state.md`](./trace_state.md)** — **State Management & Composables Flow Tracer**  
  Analyzes reactivity flow (Pinia, Zustand, Redux, Context, and Composables): separates consumers into `mutators` (action / setter callers) and `readers` (data displays / watchers), tracks touched properties, and supports multi-hop cascading chains (`depth: 2+`).

* **[`find_code.md`](./find_code.md)** — **AST-Based Structural Search & Frontend Inventory**  
  Whitespace- and line-format-resilient structural pattern search via `ast-grep`, component adoption analysis (PascalCase vs kebab-case), prop omission detection (`prop_presence: "omitted"`), and bounded file inventory mapping (`action: "map"`).

* **[`audit_frontend.md`](./audit_frontend.md)** — **URL Route Topology, API Contracts, & Fullstack Bridge**  
  Audits URL route sitemaps and nested layout hierarchies, detects dead code (unused components & state), inventories outbound API calls with **`backendTargetHint`** as a direct handoff bridge to **Septum-MCP** in the backend.

* **[`generate_patch_plan.md`](./generate_patch_plan.md)** — **Deterministic Refactoring Patch Plan**  
  Calculates multi-file consumer edits with AST precision when renaming or removing props, events, models, or slots, complete with `DYNAMIC_PROP_SPREAD` guardrail warnings.

---

### 2. Foundational Architecture & Supporting Systems

* **[`storage-and-delta-sync.md`](./storage-and-delta-sync.md)** — **`graph.db` Database & Incremental Delta Sync Engine**  
  Embedded SQLite with 7 core tables, staged hashing/parsing, effective-scope fallback, shared publication, stable snapshot generations and transitive reverse dependency invalidation.

* **[`lifecycle-hooks.md`](./lifecycle-hooks.md)** — **Agent Lifecycle Hooks & Closed-Loop Refactoring**  
  Generated post-write synchronization hooks, client-integration boundaries, and the in-process analysis queue/cancellation contract. Septum guards have a separate installation/policy owner.

* **[`retrieval-evidence-contract.md`](./retrieval-evidence-contract.md)** — **Cryptographic Evidence, Budgeting, & Token Pagination**  
  Strict payload budget contract (`max_bytes`), deterministic pagination tokens (`continuation_token`), and explicit omission reporting (*explicit omissions*).

* **[`tool-call-logging.md`](./tool-call-logging.md)** — **Audit Logging & Local Telemetry**  
  Local logging contract recording tool calls to `.strata/strata.log`, response bloat detection (>16 KiB), duration metrics, and automated log rotation.

---

## AI Agent Tool Selection Matrix

| Engineering Scenario | Recommended Tool | Advantage vs `read_file` / `grep` |
|---|---|---|
| **Exploring a new module or folder** | `find_code(action: "map")` | Retrieves a bounded file catalog without source bodies; savings depend on the selected workspace and output. |
| **Understanding component interfaces or methods** | `inspect_component(path)` | Extracts props, emits, slots, stores, and APIs without reading 1,000-line template files. |
| **Checking which child components a layout renders** | `get_component_tree(path, direction: "downward")` | Instantly maps child components, passed props, and detects props drilling. |
| **Checking where a component is used across pages** | `get_component_tree(path, direction: "upward")` | Measures blast radius across all application views in milliseconds. |
| **Modifying a shared store / composable** | `trace_state(identifier)` | Accurately distinguishes mutators (writers) from readers. |
| **Tracing an API from UI form to Backend Controller** | `audit_frontend(target: "api-contracts")` &rarr; `septum_slice` | Fullstack Handoff Pattern: passes `backendTargetHint` directly to Septum without backend grep searching. |
| **Renaming / removing a prop across multiple files** | `generate_patch_plan(...)` | Computes precise AST line/column coordinates and flags dynamic spread warnings. |
