# lifecycle-hooks — SSOT Agent Lifecycle Hooks & Closed-Loop Refactoring

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Lifecycle Hooks System (`.agents/hooks/`, `.agents/hooks.json`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

When AI agents modify code across large-scale repositories:
* **Stale Cache Dilemma:** Architectural index databases (such as `graph.db` in Strata or `septum.db` in Septum) fall out-of-sync immediately after an agent modifies a file. If the agent does not re-index, subsequent turns operate on stale data and hallucinate invalid references.
* **Architectural Boundary Violations:** Agents frequently introduce forbidden dependencies or circular import chains when adding new import statements.
* **The Lifecycle Hooks Solution:**
  Provides automated pre-tool validation (*pre-tool guard*) and post-tool synchronization (*post-tool sync*) triggered silently in the background whenever an agent invokes file-editing tools (`write_file`, `edit_file`, etc.), establishing a **Closed-Loop Self-Healing Workflow**.

---

## 2. Architecture & Hook Flow

Hooks are declared in `.agents/hooks.json` and mirrored into respective agent configuration directories:

```
[Agent Intends to Modify a File]
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. PRE-TOOL-USE HOOK (septum-pre-write.sh)                 │
│    - Intercepts payload before file is written to disk      │
│    - Validates module boundaries & circular import rules    │
│    - If violated: Aborts operation with clear feedback      │
└──────────────────────────┬──────────────────────────────────┘
                           │ (Validation Passes)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. FILE WRITTEN TO DISK (write_file / edit_file)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. POST-TOOL-USE HOOK (strata-post-write.sh)                │
│    - Intercepts path of modified file                       │
│    - Checks for frontend extensions (.vue, .tsx, .svelte)   │
│    - Runs background "strata sync <workspace>" (<20ms)      │
│    - graph.db is instantly FRESH for next agent turn        │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Hook Script Details

### A. `strata-post-write.sh` (Frontend Auto Delta-Sync)
* **Location:** `.agents/hooks/strata-post-write.sh` (mirrored to `.gemini/hooks/`, `.claude/hooks/`, `.codex/hooks/`).
* **Input Extraction Mechanism:**
  Extracts the modified file path from environment variables (`CLAUDE_FILE_PATH`), CLI argument `$1`, or JSON stdin stream from the agent harness using available runtimes (`node`, `bun`, `python3`, or fallback `sed`).
* **Execution:**
  If the file matches `.vue`, `.astro`, `.svelte`, `.tsx`, `.jsx`, `.ts`, or `.js`:
  ```bash
  strata sync "$WORKSPACE_ROOT" --json
  ```
  Runs an incremental delta sync in $<20$ milliseconds, keeping `graph.db` 100% current.

### B. `septum-pre-write.sh` & `septum-post-write.sh` (Backend Boundary Guards)
* **Pre-Write:** Validates proposed imports against architectural rules in `septum.db`. Prevents circular imports before changes hit disk.
* **Post-Write:** Updates backend symbol tables in `septum.db`.

---

## 4. AI Agent & Harness Support

Strata-MCP's hook integration is client-agnostic and supports major AI coding environments:

| AI Agent | Configuration Path | Hook Capabilities |
|---|---|---|
| **Google Antigravity** | `.gemini/` | Native MCP stdio transport + Pre/PostToolUse lifecycle hooks |
| **Claude Code & Desktop** | `.claude/` | Event-driven lifecycle hooks (`PostToolUse`) |
| **OpenAI Codex Agent** | `.codex/` | Hooks shell execution engine |
| **Roo Code / Cline / OpenCode** | `.agents/` / `opencode/` | Standard matcher config via `.agents/hooks.json` |
| **Cursor & Windsurf** | Workspace config | MCP stdio integration + prompt guidance rules |

---

## 5. Benefits for AI Agents

1. **Closed-Loop Self-Healing:**
   Agents can formulate a refactoring plan (`generate_patch_plan`), apply file edits (`edit_file`), and immediately inspect updated contracts (`inspect_component`) without ever operating on stale cache data.
2. **Zero Manual Overhead:** Human developers and AI agents never need to remember to run `strata sync` in the terminal manually.
3. **Automated Regression Prevention:** Pre-write hooks intercept violations before code that breaks architectural rules is written to disk.

---

## 6. Code Implementation References

* **Hook Manifest:** [`.agents/hooks.json`](../../.agents/hooks.json)
* **Strata Post-Write Script:** [`.agents/hooks/strata-post-write.sh`](../../.agents/hooks/strata-post-write.sh)
* **Sync Engine:** [`src/engine/storage/delta-sync.ts`](../../src/engine/storage/delta-sync.ts)
