# trace_state — SSOT State Management & Composables Flow Tracer

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Tool Call `trace_state` (`src/tools/trace-state.ts`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

Reactive state (Pinia, Zustand, Redux, Context, and Composables) serves as the source of truth for frontend application data:
* **Developer & AI Agent Problems:**
  * When changing store data structures or renaming composable functions, agents cannot tell which components merely read data (*readers*) and which modify it (*mutators*).
  * Race conditions or infinite re-render loops emerge when state mutations happen outside anticipated pathways.
  * Nested composables (*multi-hop composables*) obscure original dependencies from leaf UI components.
* **The `trace_state` Solution:**
  Analyzes cross-file reactivity flow semantically: segregating consumers into `mutators` (action / setter callers) and `readers` (data displayers / watchers), recording accessed properties and invoked actions, and tracing multi-hop cascading chains (*multi-hop cascading*).

---

## 2. Input Specifications (Parameters & Aliasing)

| Parameter | Type | Required? | Description & Aliasing |
|---|---|---|---|
| `identifier` | `string` | **Yes** | Identifier name of the state, store, context, or composable (e.g., `"useCartStore"`, `"useAuth"`, `"CartContext"`). Aliases: `state`, `state_name`, `store`, `store_name`, `composable`, `name`, `symbol`. |
| `path` | `string` | Optional | Project root directory or target component file (default: `"."`, aliases: `target_path`, `file_path`, `filePath`). |
| `depth` | `number` | Optional | Traversal depth: `1` for direct consumers; `>1` for multi-hop call chains (default: `1`, alias: `max_depth`). |
| `role` | `'all' \| 'mutators' \| 'readers'` | Optional | Consumer role filter: `'all'` (default), `'mutators'` (state writers only), or `'readers'` (state readers only). |
| `direction` | `'consumers' \| 'dependencies' \| 'both'` | Optional | Traversal direction for multi-hop: `'consumers'` (upwards to users), `'dependencies'` (downwards to foundational stores), or `'both'` (default: `'both'`). |
| `format` | `'text' \| 'json'` | Optional | Output format (default: `'text'`, alias: `output_format`). |

---

## 3. Technical Mechanics & Algorithm

### A. Semantic Access Classification (Read vs Write vs Watch)
Strata avoids crude regex matching, decomposing TypeScript/JSX/Vue ASTs to classify `access_mode`:
1. **`write` (Mutator):**
   * Action / mutation method calls matching standard mutation verb prefixes: `set*`, `update*`, `delete*`, `add*`, `remove*`, `mutate*`, `trigger*`, `toggle*`, `reset*`, `dispatch*`, `$patch*`.
   * Destructured state setters: `const [count, setCount] = useState()` &rarr; invocations of `setCount` are recorded as `write`.
2. **`read` (Reader):**
   * Property accesses evaluated for rendering: `computed(() => store.totalPrice)` or `useSelector(s => s.items)`.
3. **`watch` (Subscriber):**
   * Reactive subscriptions such as `watch(() => store.user, ...)` or `useEffect` dependency array entries.

### B. Property & Action Tracking
* **`accessedProperties`:** Records specific fields accessed (e.g., `["items", "subtotal", "discountCode"]`), allowing agents to know if altering a specific property impacts that component.
* **`actionsCalled`:** Records mutation methods executed (e.g., `["addItem", "clearCart"]`).
* **`usageSnippet` & `lineNumber`:** Captures exact source code snippets and line numbers of call sites.

### C. Vue SFC Template Expression Scanning
Strata extracts bindings placed directly inside Vue SFC `<template>` blocks (e.g., `<button @click="cartStore.checkout()">{{ cartStore.totalPrice }}</button>`), correctly mapping `checkout()` to mutator and `totalPrice` to reader even when local variables are absent in `<script>`.

### D. Multi-Hop Chaining (`depth: 2+`)
Traces hierarchical dependency chains:
* `useCartStore` &rarr; imported by `useCheckoutSession` &rarr; imported by `CheckoutModal.vue`.
* With `direction: "both"`, agents see the entire lineage tree of state dependencies.

---

## 4. Language & Framework Support

* **Vue 3 & Nuxt (Pinia, Composables):**
  * Pinia stores (`defineStore`).
  * Nuxt auto-imported composables/stores.
  * Custom Vue composables (`use*.ts`).
* **React & Next.js (Zustand, Redux Toolkit, Context, Hooks):**
  * Zustand selector patterns: `useStore(state => state.items)`.
  * Redux Toolkit: `useSelector` (reader) and `useDispatch` / `dispatch()` (mutator).
  * React Context: `<Context.Provider>` and `useContext()`.
  * TanStack Query: `useQuery` (reader) vs `useMutation` (mutator).
* **Inertia.js:**
  * Router triggers: `router.post()`, `router.put()`, `router.delete()`.
* **Svelte:**
  * Svelte 5 Runes (`$state`), universal shared state modules, and Svelte Context.

---

## 5. Output Structure & Example Responses

### Default Text Format (`format: "text"`):
```text
State Impact Analysis for: useCartStore [Engine: sqlite-graph-cache | 12ms | cache hit]
Total Dependent Components/Pages: 3

[MUTATORS / WRITERS] (1 component)
- src/components/ProductCard.vue:42
  Actions Called: addItem
  Snippet: cartStore.addItem(product.id, quantity.value)

[READERS / SUBSCRIBERS] (2 components)
- src/components/NavbarBadge.vue:15
  Accessed Properties: totalItems
  Snippet: const badgeCount = computed(() => cartStore.totalItems)
- src/views/checkout/CheckoutPage.vue:30
  Accessed Properties: items, subtotal, discountCode
  Snippet: const summary = computed(() => cartStore.subtotal)

Summary: 1 mutator site, 2 reader sites. Multi-hop cascading available with depth: 2.
```

### Structured JSON Format (`structuredContent`):
```json
{
  "identifier": "useCartStore",
  "totalConsumers": 3,
  "roleFilter": "all",
  "mutatorsCount": 1,
  "readersCount": 2,
  "mutators": [
    {
      "path": "src/components/ProductCard.vue",
      "isPage": false,
      "kind": "store",
      "identifier": "useCartStore",
      "role": "mutator",
      "accessMode": "write",
      "lineNumber": 42,
      "actionsCalled": ["addItem"],
      "usageSnippet": "cartStore.addItem(product.id, quantity.value)"
    }
  ],
  "readers": [
    {
      "path": "src/components/NavbarBadge.vue",
      "isPage": false,
      "kind": "store",
      "identifier": "useCartStore",
      "role": "reader",
      "accessMode": "read",
      "lineNumber": 15,
      "accessedProperties": ["totalItems"],
      "usageSnippet": "const badgeCount = computed(() => cartStore.totalItems)"
    }
  ]
}
```

---

## 6. Code Implementation References

* **Tool Definition Catalog:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Primary Handler:** [`src/tools/trace-state.ts`](../../src/tools/trace-state.ts)
* **Storage & Multi-Hop Engine:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)
* **Vue State Dependency Parser:** [`src/engine/parsers/state-dependency.ts`](../../src/engine/parsers/state-dependency.ts)
* **React State Dependency Parser:** [`src/engine/parsers/react-state-dependency.ts`](../../src/engine/parsers/react-state-dependency.ts)
