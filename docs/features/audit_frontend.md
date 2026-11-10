# audit_frontend — SSOT URL Topology, Layouts, API Contracts, & Fullstack Bridge

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Tool Call `audit_frontend` (`src/tools/audit-frontend.ts`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

Understanding the macro architecture of a frontend application is often challenging for AI agents:
* **Developer & AI Agent Problems:**
  * Unaware of the route URL sitemap in the application along with dynamic parameters (`[id]`, `[...slug]`).
  * Unaware of the layout hierarchy wrapping each page.
  * **Frontend–Backend Divide:** Agents identify a form or API call in the UI, but struggle to locate which controller or service handles that request on the backend, triggering blind grepping across backend files and wasting tens of thousands of tokens.
  * Dead components or obsolete stores accumulate undetected.
* **The `audit_frontend` Solution:**
  Provides a macro audit of route URL topology and nested layout chains, inventories all outbound API call contracts along with **`backendTargetHint`** (a direct handoff bridge to **Septum-MCP** on the backend), and detects unused components and state (*dead code*).

---

## 2. Input Specifications (Parameters & Aliasing)

| Parameter | Type | Required? | Description & Aliasing |
|---|---|---|---|
| `path` | `string` | Optional | Project root directory (default: `"."`, aliases: `target_path`, `targetPath`). |
| `target` | `'routes' \| 'api-contracts' \| 'dead-components' \| 'dead-state' \| 'all'` | Optional | Specific audit target (default: `'all'`). |
| `view` | `'summary' \| 'full' \| 'tree'` | Optional | Representation view for `target: "routes"` (default: `'summary'`). |
| `prefix` | `string` | Optional | Route URL prefix filter (e.g., `"/dashboard"`, `"/api"`). |
| `framework` | `string` | Optional | Framework hint: `'next-app'`, `'next-pages'`, `'nuxt'`, `'astro'`, `'sveltekit'`, `'inertia'`, `'vue-router'`. |
| `scope_path` | `string` | Optional | Sub-directory or workspace scope (e.g., `"apps/web"`) to avoid scanning an entire monorepo. |
| `include_pages`| `boolean` | Optional | Include page/view files in dead-components audit (default: `false`). |
| `exclude_dirs` | `string[]` | Optional | List of directory names to ignore. |
| `format` | `'text' \| 'json'` | Optional | Output format (default: `'text'`, alias: `output_format`). |

---

## 3. Four Core Audit Targets

### A. Route Topology & Layouts (`target: "routes"`)
* Scans file-based routing:
  * Next.js App Router (`app/**/page.tsx`, `layout.tsx`)
  * Next.js Pages Router (`pages/**/*.tsx`, `_app.tsx`)
  * Nuxt 3 (`pages/**/*.vue`, `layouts/*.vue`)
  * SvelteKit (`src/routes/**/+page.svelte`, `+layout.svelte`)
  * Astro (`src/pages/**/*.astro`)
* Extracts dynamic parameters (`:id`, `*slug`), middleware, and wrapping **Nested Layout** chains.

### B. Outbound API Contracts & Fullstack Bridge (`target: "api-contracts"`)
* Inventories all outbound HTTP calls:
  * Axios (`axios.get/post/put/delete`)
  * Native `fetch()`
  * TanStack Query / SWR
  * Inertia.js (`useForm`, `router.post`)
  * Nuxt `$fetch` / `useFetch`
* Extracts HTTP methods, URL endpoints, form payload fields, and caller file/line coordinates.
* **`backendTargetHint` Synthesis:** Translates REST endpoints or Ziggy named routes into backend controller symbols (e.g., `POST /api/v1/cadets` &rarr; `CadetController@store`).

### C. Dead Components (`target: "dead-components"`)
* Detects UI components that are never imported or rendered anywhere across the workspace.

### D. Dead State (`target: "dead-state"`)
* Detects stores (Pinia/Zustand), Contexts, or Composables that have no active consumers (*neither readers nor mutators*).

---

## 4. Backend Bridge: "Fullstack Handoff" Pattern to Septum-MCP

This feature serves as the primary bridge between Strata-MCP (Frontend) and Septum-MCP (Backend):

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. FRONTEND SIDE (Strata-MCP)                                          │
│    audit_frontend(target: "api-contracts")                             │
│    Result:                                                             │
│    - Endpoint: POST /api/v1/cadets                                     │
│    - Payload Fields: [name, batch_id, status]                          │
│    - backendTargetHint: "CadetController@store"                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Handoff Hint to Septum)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. BACKEND SIDE (Septum-MCP)                                           │
│    septum_slice(query: "CadetController@store", max_depth: 5)          │
│    Result:                                                             │
│    - Ingress: routes/api.php                                           │
│    - Controller: CadetController.php@store                             │
│    - FormRequest: StoreCadetRequest.php (batch_id validation rules)    │
│    - Database: Eloquent Model Cadet::create()                          │
└────────────────────────────────────────────────────────────────────────┘
```

**Token Savings Impact:**
An end-to-end fullstack task that typically consumes 40,000–50,000 tokens due to blind backend grepping can be resolved in just **~1,500–2,500 tokens**.

---

## 5. Output Structure & Example Responses

### Example Output for `target: "routes"`:
```text
Frontend Routes Topology:
Framework: Nuxt 3 / Vue Router

Route: /dashboard/settings
├── Page File: src/pages/dashboard/settings.vue
├── Layout Chain: RootLayout.vue -> DashboardLayout.vue
└── Dynamic Params: none

Route: /catalog/:id
├── Page File: src/pages/catalog/[id].vue
├── Layout Chain: RootLayout.vue -> StoreLayout.vue
└── Dynamic Params: ["id"]

Total Routes: 2
```

### Example Output for `target: "api-contracts"`:
```text
API Contracts Audit:
Total Endpoints: 2

- POST /api/v1/cadets (client: axios)
  Consumer: src/views/cadets/CadetCreateModal.vue:54
  Payload Fields: ["name", "email", "batch_id"]
  backendTargetHint: [Backend: CadetController@store]
  Suggested Symbols: CadetController, CadetController@store, CadetService

- GET /api/v1/cadets/:id (client: tanstack-query)
  Consumer: src/views/cadets/CadetDetailPage.vue:18
  backendTargetHint: [Backend: CadetController@show]
```

---

## 6. Code Implementation References

* **Tool Definition Catalog:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Primary Handler:** [`src/tools/audit-frontend.ts`](../../src/tools/audit-frontend.ts)
* **API Contract Engine:** [`src/engine/api-contract.ts`](../../src/engine/api-contract.ts)
* **Routes Scanner:** [`src/engine/routes.ts`](../../src/engine/routes.ts)
* **Dead Components Audit:** [`src/engine/audit.ts`](../../src/engine/audit.ts)
* **Dead State Audit:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)
