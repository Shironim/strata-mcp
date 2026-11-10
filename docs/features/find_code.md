# find_code — SSOT AST-Based Structural Search & Frontend Inventory

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Tool Call `find_code` (`src/tools/find-code.ts`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

Plain-text search tools (`grep`, `ripgrep`, regex) frequently fail on modern frontend codebases:
* **Limitations of Standard Grep:**
  * Thrown off by line wraps (*multi-line formatting*), whitespace variations, or quote types (`'` vs `"` vs `` ` ``).
  * Thrown off by casing conventions between PascalCase (`<UserAvatar>`) and kebab-case (`<user-avatar>`).
  * **Cannot search for "Absence of Code":** Grep cannot find components where developers *forgot to provide a specific prop*.
  * Exploring a new directory by reading entire files rapidly exhausts context token budgets.
* **The `find_code` Solution:**
  Leverages the **`ast-grep` engine (Rust + Tree-sitter)** for structural syntax pattern matching immune to line breaks, component adoption tracking with prop omission detection (`omission`), and bounded file inventory mapping (`action: "map"`) without reading file bodies.

---

## 2. Input Specifications (Parameters & Aliasing)

| Parameter | Type | Required? | Description & Aliasing |
|---|---|---|---|
| `path` | `string` | Optional | Search target directory or file (default: root, aliases: `file_path`, `filePath`, `target_path`). |
| `pattern` | `string` | Conditional | Structural AST pattern (e.g., `"ref($$$)"`, `"computed($$$)"`, `"console.log($$$)"`). Aliases: `query`, `search`. |
| `action` | `'search' \| 'map'` | Optional | Action: `'search'` (default) or `'map'` (maps file inventory without reading bodies). |
| `mode` | `'ast' \| 'auto' \| 'literal'` | Optional | Pattern search mode: `'ast'` (default structural), `'literal'` (exact substring per line), or `'auto'` (AST with literal fallback on syntax parse error). |
| `component` | `string` | Conditional | Component name for adoption search (e.g., `"BaseButton"` or `"base-button"`). Alias: `component_name`. |
| `prop_name` | `string` | Optional | Prop name to analyze alongside `component` (e.g., `"variant"`). Alias: `prop`. |
| `prop_presence`| `'present' \| 'omitted'` | Optional | Prop presence filter: `'present'` (default, renders supplying the prop) or `'omitted'` (renders **omitting** the prop). |
| `rule_yaml` | `string` | Optional | Complete relational YAML ast-grep rule definition. |
| `code` | `string` | Optional | Code snippet to test against patterns in-memory (without touching disk, alias: `code_snippet`). |
| `scope` | `'template' \| 'script' \| 'both'` | Optional | Component search scope: `'template'`, `'script'`, or `'both'` (default). |
| `limit` | `integer` | Optional | Maximum number of file paths returned for `action: "map"` (default: `100`, max: `500`). |
| `offset` | `integer` | Optional | Starting offset for stable pagination under `action: "map"` (default: `0`). |
| `exclude_dirs` | `string[]` | Optional | List of directory names to ignore (e.g., `["storage", "legacy"]`). |
| `format` | `'text' \| 'json'` | Optional | Output format (default: `'text'`, alias: `output_format`). |

---

## 3. Three Primary Operating Modes

### A. AST Pattern Search (`ast-grep`)
* Utilizes metavariables:
  * `$$$` : Matches zero or more arguments/statements.
  * `$NAME` : Captures specific identifiers.
* **Whitespace & Multi-line Immunity:** The pattern `ref($$$)` matches single-line declarations like `ref(0)` as well as multi-line declarations like `ref({\n  id: 1,\n  name: 'John'\n})` across 10 lines.
* **Relational Rules (YAML):** Supports advanced relational constraints such as `inside`, `has`, `precedes`, or `follows` (e.g., searching for API calls executed strictly inside `onMounted`).

### B. Component Adoption Analysis & Prop Omission Detection
* **Dual-Convention Matching:** Searching for `component: "Alert"` automatically matches `<Alert>`, `<alert>`, and `<CustomAlert>` when imported as an alias (`import { Alert as CustomAlert }`).
* **Prop Presence (`prop_presence: "present"`):** Finds all renders supplying the prop, whether static (`variant="danger"`) or dynamic (`:variant="type"`).
* **Prop Omission (`prop_presence: "omitted"`):** Finds all render locations that **OMIT / FORGOT** the prop. Essential for auditing breaking changes when making a prop required across shared components.

### C. Bounded File Inventory (`action: "map"`)
* Returns a scoped frontend file catalog without reading file bodies (saving up to 95% of tokens).
* Automatically classifies domains, architectural layers (`page`, `component`, `layout`, `store`, `composable`), and detects framework candidates from `package.json`.

---

## 4. Output Structure & Example Responses

### Example A: Prop Omission Search Result
```text
Prop query: {"component":"BaseButton","prop":"variant","presence":"omitted"}

Matches (2 omitted renders):
- src/views/WelcomeView.vue:35
  Snippet: <BaseButton label="Get Started" @click="start" />
- src/components/AlertBox.vue:50
  Snippet: <BaseButton label="Dismiss" />

Prop supply coverage: {"suppliedCount":8,"omittedCount":2,"dynamicForwarded":0}
[Static search complete: 2 components omit the "variant" prop]
```

### Example B: Bounded Inventory Result (`action: "map"`)
```text
Frontend Map: /src/modules/checkout
Framework Candidates: Vue 3, Nuxt

Coverage: 5 files discovered | Limit: 100
Extensions: .vue: 3, .ts: 2

Files Inventory:
- src/modules/checkout/pages/CheckoutPage.vue [domain: checkout | layer: page]
- src/modules/checkout/components/PaymentForm.vue [domain: checkout | layer: component]
- src/modules/checkout/components/OrderSummary.vue [domain: checkout | layer: component]
- src/modules/checkout/stores/useCheckoutStore.ts [domain: checkout | layer: store]
- src/modules/checkout/composables/usePayment.ts [domain: checkout | layer: composable]
```

---

## 5. Code Implementation References

* **Tool Definition Catalog:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Primary Handler:** [`src/tools/find-code.ts`](../../src/tools/find-code.ts)
* **Search Engine:** [`src/engine/search.ts`](../../src/engine/search.ts)
* **AST Grep Engine:** [`src/engine/astgrep.ts`](../../src/engine/astgrep.ts)
* **Prop Intent Search:** [`src/engine/search-intent.ts`](../../src/engine/search-intent.ts)
* **Frontend Map Engine:** [`src/engine/frontend-map.ts`](../../src/engine/frontend-map.ts)
