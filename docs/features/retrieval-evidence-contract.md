# retrieval-evidence-contract — SSOT Cryptographic Evidence, Budgeting, & Token Pagination

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Context Budget & Evidence Engine (`src/engine/context-budget.ts`, `src/engine/retrieval-evidence.ts`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

Common failure modes of first-generation AI coding tools include:
* **Context Flooding:** Tools return hundreds of kilobytes of unconstrained payloads, flooding LLM context windows, exhausting token budgets, and causing attention dilution (*Lost in the Middle*).
* **Silent Truncation:** Payloads are chopped arbitrarily mid-line or mid-JSON without notifying the agent that results are incomplete.
* **Illusion of Completeness:** Tools report that a search completed cleanly even when directories were omitted or partial parse failures occurred.
* **The Retrieval Contract Solution:**
  Strata-MCP enforces strict byte budgets (`max_bytes`), deterministic pagination tokens (`continuation_token`), cryptographic provenance tracking (*provenance tracking*), and explicit omission reporting (*explicit omissions*).

---

## 2. Budget & Pagination Parameter Specifications

All Strata-MCP tools expose standardized parameters to regulate response volume:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `max_bytes` | `integer` | `16384` (16 KiB) | Hard budget ceiling on UTF-8 JSON response payload size (minimum 512 bytes). If output exceeds this threshold, Strata applies graceful pagination or returns an actionable budget error. |
| `continuation_token` | `string` | `undefined` | Deterministic cryptographic token returned when results are truncated, used to fetch the subsequent page. |
| `include_structured` | `boolean` | `false` | In `format: "text"` mode, set to `true` to include full JSON `structuredContent`. Defaults to `false` to preserve transport bandwidth. |

---

## 3. Retrieval Evidence Object Structure

Every Strata MCP response includes retrieval metadata within `structuredContent.retrieval`:

```json
{
  "retrieval": {
    "policy": "component-tree-v1",
    "workspace": "/path/to/project",
    "scope": "/path/to/project/src",
    "basis": "indexed",
    "status": "complete",
    "selectionReason": "Bounded component traversal selected by entrypoint, direction, depth and scope.",
    "snapshot": {
      "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "timestamp": 1700000000000
    },
    "budget": {
      "maxBytes": 16384,
      "bytesOut": 4096,
      "truncated": false
    },
    "omissions": []
  }
}
```

### Key Elements:
1. **`basis` (`'source' | 'derived' | 'indexed'`):**
   * `'source'`: Evidence read directly from raw source code lines.
   * `'derived'`: Inferred from framework conventions (e.g., guessing controller names from route patterns).
   * `'indexed'`: Retrieved from the indexed graph database (`graph.db`).
2. **`status` (`'complete' | 'partial' | 'stale'`):**
   * `'complete'`: The requested scope was completely analyzed without parser errors.
   * `'partial'`: Files encountered parser errors or were bounded by `limit`/`max_depth`.
   * `'stale'`: Disk contents changed since the last index; prompts re-synchronization.
3. **`omissions` (Explicit Omission List):**
   When files are skipped due to parse errors or dynamic constructs, they are transparently recorded with diagnostic codes and reasons (e.g., `DYNAMIC_PROP_SPREAD`, `VUE_PARSE_FAILED`).

---

## 4. Token Pagination Mechanics (`continuation_token`)

When collections (such as file lists in `find_code(action: "map")` or search matches) exceed `max_bytes`:
1. Strata truncates the collection at a clean item boundary (without corrupting JSON syntax).
2. Emits metadata indicating continuation availability:
   ```json
   {
     "budget": {
       "maxBytes": 16384,
       "truncated": true,
       "continuationToken": "eyJvZmZzZXQiOjUwLCJzZWVkIjoxMjM0NX0="
     }
   }
   ```
3. The AI agent repeats the tool call passing:
   `continuation_token: "eyJvZmZzZXQiOjUwLCJzZWVkIjoxMjM0NX0="`
   to receive the subsequent page deterministically without duplicate entries.

---

## 5. Code Implementation References

* **Context Budget Enforcer:** [`src/engine/context-budget.ts`](../../src/engine/context-budget.ts)
* **Retrieval Evidence Formatter:** [`src/engine/retrieval-evidence.ts`](../../src/engine/retrieval-evidence.ts)
* **Index Retrieval Tracker:** [`src/engine/index-retrieval-evidence.ts`](../../src/engine/index-retrieval-evidence.ts)
* **MCP Response Decorator:** [`src/tools/retrieval-response.ts`](../../src/tools/retrieval-response.ts)
