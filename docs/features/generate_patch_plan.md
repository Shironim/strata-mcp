# generate_patch_plan — SSOT Deterministic Refactoring Patch Plan

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Tool Call `generate_patch_plan` (`src/tools/patch-plan.ts`)  
**Last Updated:** 2026-11-13

---

## 1. Purpose & Business Requirements

Refactoring component contracts (renaming props, removing events, renaming v-models or slots) across large frontend codebases carries substantial risk:
* **Developer & AI Agent Problems:**
  * Manual text-search-based edits frequently miss consumer files, accidentally alter similarly named variables, or miscalculate line offsets (*offset drift*).
  * Agents often assume all prop passes are static, overlooking components using the spread operator (`{...props}` or `v-bind="$attrs"`).
* **The `generate_patch_plan` Solution:**
  Calculates a deterministic, AST-precise patch plan bound to cryptographic hashes (`sourceRef`), and automatically detects and flags dynamic prop spreading (`DYNAMIC_PROP_SPREAD`).

---

## 2. Input Specifications (Parameters & Aliasing)

| Parameter | Type | Required? | Description & Aliasing |
|---|---|---|---|
| `path` | `string` | **Yes** | Path to the component file being refactored (e.g., `"src/components/BaseButton.vue"`). Aliases: `component_path`, `file_path`, `filePath`, `component`. |
| `refactor_type`| `'rename_prop' \| 'remove_prop' \| 'rename_event' \| 'remove_event' \| 'rename_model' \| 'remove_model' \| 'rename_slot' \| 'remove_slot'` | **Yes** | Refactoring operation to perform. Aliases: `refactor`, `refactorType`. |
| `old_name` | `string` | **Yes** | Current name of the prop, event, model, or slot (e.g., `"is-active"`, `"on-submit"`). Aliases: `old`, `oldName`. |
| `new_name` | `string` | Conditional* | New target name (required for rename operations). Aliases: `new`, `newName`. |
| `operations` | `array` | Optional | List of atomic operations to execute in a single batch pass (Alias: `batch_operations`). |
| `target_path` | `string` | Optional | Project root directory (default: `"."`). |
| `format` | `'text' \| 'json'` | Optional | Output format (default: `'text'`, alias: `output_format`). |

*\*Required when operation is a rename.*

---

## 3. Technical Mechanics & Algorithm

```
[Target Component: BaseButton.vue]
  ├── 1. Precondition Validation (Verify component contract & old_name existence)
  ├── 2. Upward Traversal (Find all consumers rendering this component)
  ├── 3. AST Diff Engine (Parse consumer Vue template DOM / TSX JSX)
  │      - Calculate line, column, startOffset, endOffset coordinates
  │      - Generate oldSnippet & newSnippet
  │      - Bind to SHA-256 hash (sourceRef)
  └── 4. Safety Guard: Flag DYNAMIC_PROP_SPREAD if consumer uses spread operators
```

### A. Preconditions & Contract Validation
Before generating patches, Strata inspects the target component:
* Verifies whether `old_name` is explicitly declared on the component. If missing, the operation is rejected early with clear diagnostic messaging.

### B. Upward Consumer Traversal
Utilizes the upward component tree algorithm (`maxDepth: 1`, `limit: 1000`) to discover all direct consumer files (`.vue`, `.tsx`, `.jsx`, `.astro`, `.svelte`) importing and rendering the target component, forwarding `UPWARD_RESULTS_TRUNCATED` into `coverage.diagnostics` if a component exceeds 1,000 direct consumers.

### C. Precise Offset & Snippet Slicing
* **Props (`rename_prop` / `remove_prop`):** Matches static attributes (`is-active="true"`), dynamic bindings (`:is-active="val"`), and kebab/camel-case (`:isActive="val"`). Computes replacement characters and cleans up whitespace when removing.
* **Events (`rename_event` / `remove_event`):** Matches event directives (`@click`, `v-on:click`) in Vue and callback props (`onClick={...}`) in React.
* **Models (`rename_model` / `remove_model`):** Matches `v-model:name="val"`.
* **Slots (`rename_slot` / `remove_slot`):** Matches named slots (`#header`, `v-slot:header`).

### D. Safety Guard: `DYNAMIC_PROP_SPREAD` Detection
If any consumer component forwards props via a spread operator:
* Vue: `<BaseButton v-bind="$attrs" />` or `v-bind="props"`
* React: `<BaseButton {...props} />`

Strata automatically raises a warning:
`[WARNING: DYNAMIC_PROP_SPREAD]` on that file. This informs the AI agent that static analysis cannot guarantee exhaustive coverage at that call site, requiring manual verification.

---

## 4. Output Structure & Example Responses

### Structured JSON Format (`format: "json"`):
```json
{
  "targetComponent": "src/components/BaseButton.vue",
  "operation": "rename_prop",
  "oldName": "is-active",
  "newName": "active",
  "totalPatches": 2,
  "patches": [
    {
      "file": "src/views/HomeView.vue",
      "line": 45,
      "column": 12,
      "oldSnippet": ":is-active=\"true\"",
      "newSnippet": ":active=\"true\"",
      "sourceRef": {
        "sha256": "a1b2c3d4...",
        "startOffset": 1024,
        "endOffset": 1041
      }
    }
  ],
  "warnings": [
    {
      "type": "DYNAMIC_PROP_SPREAD",
      "file": "src/components/CustomWrapper.vue",
      "line": 15,
      "message": "Component uses v-bind=\"$attrs\". Manual verification required."
    }
  ]
}
```

---

## 5. Code Implementation References

* **Tool Definition Catalog:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Primary Handler:** [`src/tools/patch-plan.ts`](../../src/tools/patch-plan.ts)
* **Patch Plan Engine:** [`src/engine/patch-plan.ts`](../../src/engine/patch-plan.ts)
* **Preconditions Checker:** [`src/engine/patch-preconditions.ts`](../../src/engine/patch-preconditions.ts)
* **Coverage & Omission Collector:** [`src/engine/patch-coverage.ts`](../../src/engine/patch-coverage.ts)
