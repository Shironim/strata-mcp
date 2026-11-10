# inspect_component — SSOT Component Contracts & AST Slicing

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Tool Call `inspect_component` (`src/tools/inspect-component.ts`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

Modern frontend components (Vue SFCs, React/Next.js, Svelte, Astro) intertwine visual HTML markup, CSS/Tailwind styling, reactivity primitives, and business logic across hundreds or thousands of lines:
* **Developer & AI Agent Problems:** Reading entire files via `read_file` (500–1,500+ lines) simply to inspect a prop name, emit payload, or single event handler wastes tens of thousands of context tokens and triggers *Lost in the Middle* attention dilution (resulting in hallucinated refactoring).
* **The `inspect_component` Solution:** Delivers **Goldilocks Context**—extracting public component contracts (props, emits, slots, models, composables, stores, and outbound API calls) instantly without ingesting presentational templates, while slicing targeted functions (*AST Slicing*) with verified caller boundaries and precise line coordinates.

---

## 2. Input Specifications (Parameters & Aliasing)

| Parameter | Type | Required? | Description & Aliasing |
|---|---|---|---|
| `path` | `string` | **Yes** | Target component or module file path (Aliases: `file_path`, `filePath`, `target_path`, `component`, `component_path`). |
| `view` | `'map' \| 'source'` | Optional | `'map'` to map source coordinates without code bodies; `'source'` to retrieve slices using a `source_ref`. |
| `symbol` | `string` | Optional | Name of the function/method to slice with verified callers and test references (Aliases: `symbol_name`, `name`). |
| `source_range` | `object` | Optional | Inclusive line range extraction `{ start_line: number, end_line: number }`. |
| `source_ref` | `object` | Optional | Hash-bound token `{ sha256, startOffset, endOffset }` obtained from `view: "map"`. |
| `outline` | `boolean` | Optional | When `true`, extracts a high-level outline of functions, methods, and computed properties with line bounds (Alias: `include_outline`). |
| `audit_events` | `boolean` | Optional | Vue-specific: verifies that template event bindings match implementation handlers in `<script>`. |
| `impact` | `'none' \| 'summary' \| 'full'` | Optional | Per-prop impact analysis: computes unique consumers, usage count, and omission renders (default: `'none'`). |
| `project_root` | `string` | Optional | Project root directory for path resolution and dependency tracking (Aliases: `root`, `workspace_root`). |
| `format` | `'text' \| 'json'` | Optional | Output format (default: `'text'` for token efficiency, alias: `output_format`). |
| `response_detail`| `'summary' \| 'full'` | Optional | Response detail level: `'summary'` (default) gives a compact summary; `'full'` includes the complete payload. |
| `max_bytes` | `integer` | Optional | Hard budget ceiling on UTF-8 JSON response payload bytes (default: 16384 bytes). |
| `continuation_token`| `string` | Optional | Deterministic pagination token to fetch next page when truncated. |

---

## 3. Technical Mechanics & Algorithm

### A. Public Contract & Interface Extraction
1. **Polymorphic Document Adapter:** Files are parsed via specialized adapters (`VueDocumentAdapter`, `JsxDocumentAdapter`, `SvelteDocumentAdapter`, `AstroDocumentAdapter`, `ScriptDocumentAdapter`).
2. **Multi-Block SFC Splitting:** In Vue and Astro files, script, template, and style blocks are isolated using official parsers (`@vue/compiler-dom`, `@vue/compiler-sfc`, and Astro SFC parser).
3. **Cross-File Type Chasing:** When props are typed via external interfaces (e.g., `defineProps<UserCardProps>()` where `UserCardProps` is imported from `./types`), Strata chases imports recursively up to 32 levels deep, extracting original property types, union variants, optionality, and `@deprecated` JSDoc comments.
4. **Outbound API Contract Resolution:**
   * Detects outgoing HTTP requests: Axios (`axios.get/post/put/delete`), Native `fetch()`, TanStack Query (`useQuery`, `useMutation`), Inertia Forms (`useForm`, `router.post`), Nuxt `$fetch` / `useFetch`, and Next.js Server Actions.
   * Performs 1-hop resolution into local composables (`useXxx`), marking `source: 'imported-composable'` and recording the hash dependency of the composable file.

### B. AST Symbol Slicing (`symbol: "<name>"`)
1. **AST-Level Call Extraction:** Uses TypeScript AST traversal (`ts.isCallExpression`) to inspect call invocations, rendering it immune to comments, string literals, or non-call property accesses.
2. **Caller Verification:** Distinguishes confirmed active callers (`confirmedCallers`) from passive importer candidates (`candidateImporters`).
3. **Cross-File Target Line Bounds:** Resolves callee declaration coordinates through barrel re-exports (`index.ts`) and `tsconfig.json` path aliases.
4. **Context Guard Notice:** If an extracted slice exceeds 50 lines, Strata includes a precision continuation hint directing the agent to a specific `source_range` to protect token context.

---

## 4. Language & Framework Support

* **Vue 3 & Nuxt (`.vue`):**
  * `<script setup lang="ts">`, `<script setup>`, and Options/Composition API.
  * Macros: `defineProps`, `withDefaults`, `defineEmits`, `defineSlots`, `defineModel` (Vue 3.4+), and `defineExpose`.
  * Nuxt Page Metadata: `definePageMeta({ layout: '...', middleware: '...' })`.
* **React & Next.js (`.tsx`, `.jsx`, `.ts`, `.js`):**
  * Function components, arrow functions, and `React.FC<Props>`.
  * Higher-Order Component (HOC) unwrapping: Unwraps `React.memo` and `React.forwardRef` down to underlying prop types.
  * Class Variance Authority (CVA) / Tailwind Variants extraction.
  * Directives & Boundaries: `'use client'`, `'use server'`, and segment configurations (`revalidate`, `dynamic`).
* **Svelte (`.svelte`):**
  * Svelte 4: `export let propName = default;`, `createEventDispatcher()`, slots.
  * Svelte 5 Runes: `$props()`, `$bindable(default)`, `$state()`, snippets `{#snippet ...}`.
* **Astro (`.astro`):**
  * Frontmatter TypeScript AST parsing (`---`).
  * Island Directives: `client:load`, `client:visible`, `client:idle`, `client:media`, `client:only`.
* **Composables & Custom Hooks (`.ts`, `.js`):**
  * Vue composables (`use*.ts`), React custom hooks, Pinia stores (`defineStore`), and Zustand stores.

---

## 5. Output Structure & Example Responses

### Default Text Format (`format: "text"`):
```markdown
Component: src/components/UserProfileCard.vue (Vue 3 SFC)
Boundary: client-hydrated

Props:
  - userId: string (required)
  - variant: "compact" | "detailed" (default: "compact")
  - isActive: boolean (optional)

Emits:
  - update:profile -> (payload: UserPayload)
  - deleteAccount -> ()

Slots:
  - avatar (scoped: { url, fallback })
  - default

State & Composable Dependencies:
  - Stores: useUserStore (Pinia)
  - Composables: useAuth, useNotification

Outbound API Contracts:
  - POST /api/v1/users/[id] (method: POST, client: axios)
    backendTargetHint: UserController@update
```

### Structured JSON Format (`structuredContent`):
```json
{
  "component": "UserProfileCard",
  "framework": "vue",
  "filePath": "src/components/UserProfileCard.vue",
  "props": [
    { "name": "userId", "type": "string", "required": true },
    { "name": "variant", "type": "\"compact\" | \"detailed\"", "default": "\"compact\"" }
  ],
  "emits": [
    { "name": "update:profile", "payloadType": "UserPayload" }
  ],
  "slots": ["default", "avatar"],
  "slotDetails": [
    { "name": "avatar", "isScoped": true, "bindings": ["url", "fallback"] }
  ],
  "stateDependencies": {
    "stores": ["useUserStore"],
    "composables": ["useAuth", "useNotification"]
  },
  "boundaryContracts": [
    {
      "type": "axios",
      "method": "POST",
      "endpoint": "/api/v1/users/[id]",
      "backendTargetHint": "UserController@update"
    }
  ]
}
```

---

## 6. Invariants & Safety Guardrails

1. **Cryptographic Coordinates (`sourceRef`):**
   Every text region is bound to a SHA-256 hash of the file content. If the file is modified on disk during an agent session, previous region references are rejected as stale (*stale rejection*) to prevent misaligned edits.
2. **Dynamic Spreads:** Prop spreads (`{...props}`, `v-bind="$attrs"`) cannot be verified with 100% certainty via static analysis. Strata notes these limitations explicitly in diagnostics without asserting false certainty.
3. **Pure Static Analysis:** Operates purely on source code without runtime execution, external network downloads, or active backend calls.

---

## 7. Code Implementation References

* **Tool Definition Catalog:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Primary Handler:** [`src/tools/inspect-component.ts`](../../src/tools/inspect-component.ts)
* **Contract Engine:** [`src/engine/contract.ts`](../../src/engine/contract.ts)
* **Per-Framework Parsers:**
  * Vue: [`src/engine/parsers/contract-vue.ts`](../../src/engine/parsers/contract-vue.ts)
  * React: [`src/engine/parsers/contract-react.ts`](../../src/engine/parsers/contract-react.ts)
  * Svelte: [`src/engine/parsers/contract-svelte.ts`](../../src/engine/parsers/contract-svelte.ts)
  * Astro: [`src/engine/parsers/contract-astro.ts`](../../src/engine/parsers/contract-astro.ts)
* **Slicer & AST Grep:** [`src/engine/slicer.ts`](../../src/engine/slicer.ts) & [`src/engine/astgrep.ts`](../../src/engine/astgrep.ts)
