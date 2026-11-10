# audit_frontend — SSOT Topologi URL, Layouts, API Contracts, & Fullstack Bridge

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Tool Call `audit_frontend` (`src/tools/audit-frontend.ts`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Memahami arsitektur makro aplikasi frontend sering kali membingungkan bagi AI agent:
* **Masalah Pengembang & AI Agent:**
  * Tidak mengetahui sitemap URL rute yang ada di aplikasi beserta parameter dinamisnya (`[id]`, `[...slug]`).
  * Tidak mengetahui hierarki layout yang membungkus setiap halaman.
  * **Jurang Frontend–Backend:** Agent melihat form atau pemanggilan API di UI, tetapi bingung mencari controller/service mana di backend yang menangani request tersebut, memicu *grep* membabi buta di backend yang memboroskan puluhan ribu token.
  * Komponen mati (*dead components*) atau store usang (*dead state*) menumpuk tanpa terdeteksi.
* **Solusi `audit_frontend`:**
  Menyajikan audit makro topologi URL rute dan rantai layout pembungkusnya, menginventarisasi seluruh kontrak pemanggilan API outbound beserta **`backendTargetHint`** (jembatan estafet ke **Septum-MCP** di backend), serta mendeteksi komponen dan state yang sudah tidak digunakan (*dead code*).

---

## 2. Spesifikasi Input (Parameter & Aliasing)

| Parameter | Tipe | Wajib? | Deskripsi & Aliasing |
|---|---|---|---|
| `path` | `string` | Opsional | Direktori root proyek (default: `"."`, alias: `target_path`, `targetPath`). |
| `target` | `'routes' \| 'api-contracts' \| 'dead-components' \| 'dead-state' \| 'all'` | Opsional | Target audit spesifik (default: `'all'`). |
| `view` | `'summary' \| 'full' \| 'tree'` | Opsional | Tampilan representasi rute untuk `target: "routes"` (default: `'summary'`). |
| `prefix` | `string` | Opsional | Filter awalan rute URL (misal: `"/dashboard"`, `"/api"`). |
| `framework` | `string` | Opsional | Petunjuk framework: `'next-app'`, `'next-pages'`, `'nuxt'`, `'astro'`, `'sveltekit'`, `'inertia'`, `'vue-router'`. |
| `scope_path` | `string` | Opsional | Sub-direktori atau workspace scope (misal: `"apps/web"`) untuk menghindari scan seluruh monorepo. |
| `include_pages`| `boolean` | Opsional | Mengikutsertakan file page/view dalam audit dead-components (default: `false`). |
| `exclude_dirs` | `string[]` | Opsional | Daftar nama direktori untuk diabaikan. |
| `format` | `'text' \| 'json'` | Opsional | Format keluaran (default: `'text'`, alias: `output_format`). |

---

## 3. Empat Target Audit Utama

### A. Topologi Rute & Layouts (`target: "routes"`)
* Memindai file-based routing:
  * Next.js App Router (`app/**/page.tsx`, `layout.tsx`)
  * Next.js Pages Router (`pages/**/*.tsx`, `_app.tsx`)
  * Nuxt 3 (`pages/**/*.vue`, `layouts/*.vue`)
  * SvelteKit (`src/routes/**/+page.svelte`, `+layout.svelte`)
  * Astro (`src/pages/**/*.astro`)
* Mengekstrak parameter dinamis (`:id`, `*slug`), middleware, dan rantai **Nested Layout** pembungkusnya.

### B. Outbound API Contracts & Fullstack Bridge (`target: "api-contracts"`)
* Menginventarisasi seluruh pemanggilan HTTP keluar:
  * Axios (`axios.get/post/put/delete`)
  * Native `fetch()`
  * TanStack Query / SWR
  * Inertia.js (`useForm`, `router.post`)
  * Nuxt `$fetch` / `useFetch`
* Mengekstrak method, URL endpoint, field payload form, serta file dan baris pemanggil.
* **Sintesis `backendTargetHint`:** Menerjemahkan endpoint REST atau named route Ziggy menjadi simbol controller backend (misal: `POST /api/v1/cadets` &rarr; `CadetController@store`).

### C. Komponen Mati (`target: "dead-components"`)
* Mendeteksi komponen UI yang tidak pernah di-import atau dirender di bagian mana pun dalam workspace.

### D. State Mati (`target: "dead-state"`)
* Mendeteksi store (Pinia/Zustand), Context, atau Composable yang tidak memiliki konsumen (*readers* maupun *mutators*).

---

## 4. Jembatan ke Backend: Pola "Fullstack Estafet" ke Septum-MCP

Fitur ini menjadi jembatan utama antara Strata-MCP (Frontend) dan Septum-MCP (Backend):

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. SISI FRONTEND (Strata-MCP)                                          │
│    audit_frontend(target: "api-contracts")                             │
│    Hasil:                                                              │
│    - Endpoint: POST /api/v1/cadets                                     │
│    - Payload Fields: [name, batch_id, status]                          │
│    - backendTargetHint: "CadetController@store"                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Estafetkan Hint ke Septum)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. SISI BACKEND (Septum-MCP)                                           │
│    septum_slice(query: "CadetController@store", max_depth: 5)          │
│    Hasil:                                                              │
│    - Ingress: routes/api.php                                           │
│    - Controller: CadetController.php@store                             │
│    - FormRequest: StoreCadetRequest.php (Rule validasi batch_id)       │
│    - Database: Eloquent Model Cadet::create()                          │
└────────────────────────────────────────────────────────────────────────┘
```

**Dampak Penghematan Token:**
Task fullstack end-to-end yang biasanya menghabiskan 40.000–50.000 token karena agent melakukan grep membabi buta di backend, dapat diselesaikan hanya dengan **~1.500–2.500 token**.

---

## 5. Struktur Output & Contoh Respon

### Contoh Output `target: "routes"`:
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

### Contoh Output `target: "api-contracts"`:
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

## 6. Rujukan Implementasi Kode

* **Katalog Definisi Tool:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Handler Utama:** [`src/tools/audit-frontend.ts`](../../src/tools/audit-frontend.ts)
* **API Contract Engine:** [`src/engine/api-contract.ts`](../../src/engine/api-contract.ts)
* **Routes Scanner:** [`src/engine/routes.ts`](../../src/engine/routes.ts)
* **Audit Dead Components:** [`src/engine/audit.ts`](../../src/engine/audit.ts)
* **Audit Dead State:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)
