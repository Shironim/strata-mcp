# inspect_component — SSOT Kontrak Komponen & AST Slicing

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Tool Call `inspect_component` (`src/tools/inspect-component.ts`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Komponen frontend modern (Vue SFC, React/Next.js, Svelte, Astro) mencampurkan markup visual HTML, styling CSS/Tailwind, reaktivitas, dan business logic dalam ratusan hingga ribuan baris kode.
* **Masalah Pengembang & AI Agent:** Membaca seluruh file via `read_file` (500–1.500+ baris) hanya untuk mencari tahu nama prop, emit, atau satu fungsi handler membuang puluhan ribu token konteks dan menyebabkan fenomena *Lost in the Middle* (halusinasi refactoring).
* **Solusi `inspect_component`:** Menyediakan **Konteks Emas (*Goldilocks Context*)**—mengekstrak kontrak publik komponen (props, emits, slots, models, composables, stores, dan outbound API calls) secara instan tanpa menelan template presentasi, serta memotong fungsi target (*AST Slicing*) dengan koordinat baris dan verifikasi caller yang presisi.

---

## 2. Spesifikasi Input (Parameter & Aliasing)

| Parameter | Tipe | Wajib? | Deskripsi & Aliasing |
|---|---|---|---|
| `path` | `string` | **Ya** | Path file komponen atau modul target (Alias: `file_path`, `filePath`, `target_path`, `component`, `component_path`). |
| `view` | `'map' \| 'source'` | Opsional | `'map'` untuk memetakan koordinat region source file tanpa body kode; `'source'` untuk mengambil potongan source berbasis `source_ref`. |
| `symbol` | `string` | Opsional | Nama fungsi/method untuk dipotong (*slice*) secara presisi beserta verifikasi caller dan pengujian (Alias: `symbol_name`, `name`). |
| `source_range` | `object` | Opsional | Mengambil baris kode inklusif `{ start_line: number, end_line: number }`. |
| `source_ref` | `object` | Opsional | Objek hash-bound `{ sha256, startOffset, endOffset }` yang diperoleh dari `view: "map"`. |
| `outline` | `boolean` | Opsional | Jika `true`, mengekstrak outline seluruh fungsi, method, dan computed property beserta jangkauan barisnya (Alias: `include_outline`). |
| `audit_events` | `boolean` | Opsional | Khusus komponen Vue: memverifikasi integritas event handler di `<template>` terhadap implementasi di `<script>`. |
| `impact` | `'none' \| 'summary' \| 'full'` | Opsional | Analisis dampak per-prop: menghitung consumer unik, usage count, dan deteksi omission render (default: `'none'`). |
| `project_root` | `string` | Opsional | Direktori root proyek untuk resolusi path dan dependensi (Alias: `root`, `workspace_root`). |
| `format` | `'text' \| 'json'` | Opsional | Format keluaran (default: `'text'` untuk efisiensi token, alias: `output_format`). |
| `response_detail`| `'summary' \| 'full'` | Opsional | Tingkat detail respon: `'summary'` (default) memberikan ringkasan padat; `'full'` menyertakan payload lengkap. |
| `max_bytes` | `integer` | Opsional | Batas hard budget byte payload UTF-8 JSON (default: 16384 bytes). |
| `continuation_token`| `string` | Opsional | Token deterministik untuk mengambil halaman berikutnya jika terpotong. |

---

## 3. Cara Kerja Teknis & Algoritma

### A. Ekstraksi Kontrak Publik (Interface Extraction)
1. **Polymorphic Document Adapter:** File diuraikan menggunakan adapter polimorfik (`VueDocumentAdapter`, `JsxDocumentAdapter`, `SvelteDocumentAdapter`, `AstroDocumentAdapter`, `ScriptDocumentAdapter`).
2. **Multi-Block SFC Splitting:** Pada file Vue dan Astro, blok script, template, dan style dipisahkan menggunakan parser resmi (`@vue/compiler-dom`, `@vue/compiler-sfc`, dan Astro SFC parser).
3. **Cross-File Type Chasing:** Jika props dideklarasikan menggunakan interface dari file eksternal (misal: `defineProps<UserCardProps>()` di mana `UserCardProps` di-import dari `./types`), Strata melacak import tersebut secara rekursif hingga kedalaman 32 tingkat, mengekstrak properti aslinya, tipe union, opsionalitas, dan komentar JSDoc `@deprecated`.
4. **Outbound API Contract Resolution:**
   * Mendeteksi pemanggilan API keluar: Axios (`axios.get/post/put/delete`), Native `fetch()`, TanStack Query (`useQuery`, `useMutation`), Inertia Form (`useForm`, `router.post`), Nuxt `$fetch` / `useFetch`, dan Next.js Server Actions.
   * Melakukan resolusi 1-hop ke composable lokal (`useXxx`), menandai `source: 'imported-composable'`, dan mencatat dependensi hash file composable tersebut.

### B. AST Symbol Slicing (`symbol: "<name>"`)
1. **Call Extraction AST-Level:** Menggunakan AST traversal (`ts.isCallExpression`) untuk membedah pemanggilan fungsi, sehingga kebal terhadap komentar, string literal, atau property access non-call.
2. **Caller Verification:** Membedakan pemanggil terkonfirmasi (`confirmedCallers`) dari sekadar file yang mengimpor pasif (`candidateImporters`).
3. **Cross-File Target Line Bounds:** Menyelesaikan lokasi deklarasi simbol callee lintas re-export barrel file (`index.ts`) dan alias `tsconfig.json`.
4. **Guard Potongan Panjang:** Jika hasil slice melebihi 50 baris, Strata menyertakan truncation hint presisi mengarahkan ke `source_range` spesifik untuk menjaga efisiensi token.

---

## 4. Dukungan Bahasa & Framework

* **Vue 3 & Nuxt (`.vue`):**
  * `<script setup lang="ts">`, `<script setup>`, dan Options/Composition API.
  * Macro: `defineProps`, `withDefaults`, `defineEmits`, `defineSlots`, `defineModel` (Vue 3.4+), dan `defineExpose`.
  * Nuxt Page Metadata: `definePageMeta({ layout: '...', middleware: '...' })`.
* **React & Next.js (`.tsx`, `.jsx`, `.ts`, `.js`):**
  * Function components, arrow functions, dan `React.FC<Props>`.
  * Higher-Order Component (HOC) unwrapping: Mengupas `React.memo` dan `React.forwardRef` hingga tipe props asli.
  * Ekstraksi varian CVA (*Class Variance Authority*) / Tailwind Variants.
  * Directives & Boundaries: `'use client'`, `'use server'`, serta segment config (`revalidate`, `dynamic`).
* **Svelte (`.svelte`):**
  * Svelte 4: `export let propName = default;`, `createEventDispatcher()`, slot.
  * Svelte 5 Runes: `$props()`, `$bindable(default)`, `$state()`, snippets `{#snippet ...}`.
* **Astro (`.astro`):**
  * Frontmatter TypeScript AST parsing (`---`).
  * Island Directives: `client:load`, `client:visible`, `client:idle`, `client:media`, `client:only`.
* **Composables & Custom Hooks (`.ts`, `.js`):**
  * Vue composables (`use*.ts`), React custom hooks, Pinia stores (`defineStore`), dan Zustand stores.

---

## 5. Struktur Output & Contoh Respon

### Format Teks Default (`format: "text"`):
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

### Format Terstruktur JSON (`structuredContent`):
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

## 6. Batasan & Guardrail (*Safety Invariants*)

1. **Koordinat Kriptografis (`sourceRef`):**
   Setiap region teks terikat hash SHA-256 dari konten file. Jika file diubah oleh developer di tengah jalan, referensi region lama otomatis ditolak (*stale rejection*) untuk mencegah salah edit.
2. **Dynamic Spreads:** Objek spread (`{...props}`, `v-bind="$attrs"`) tidak dapat dipastikan 100% secara statis. Strata mencatat status keterbatasan ini pada diagnostik tanpa memaksakan asumsi keliru.
3. **Analisis Statis Murni:** Tidak menjalankan kode runtime, tidak mengunduh paket eksternal, dan tidak memanggil backend secara aktif.

---

## 7. Rujukan Implementasi Kode

* **Katalog Definisi Tool:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Handler Utama:** [`src/tools/inspect-component.ts`](../../src/tools/inspect-component.ts)
* **Engine Kontrak:** [`src/engine/contract.ts`](../../src/engine/contract.ts)
* **Parser Per-Framework:**
  * Vue: [`src/engine/parsers/contract-vue.ts`](../../src/engine/parsers/contract-vue.ts)
  * React: [`src/engine/parsers/contract-react.ts`](../../src/engine/parsers/contract-react.ts)
  * Svelte: [`src/engine/parsers/contract-svelte.ts`](../../src/engine/parsers/contract-svelte.ts)
  * Astro: [`src/engine/parsers/contract-astro.ts`](../../src/engine/parsers/contract-astro.ts)
* **Slicer & AST Grep:** [`src/engine/slicer.ts`](../../src/engine/slicer.ts) & [`src/engine/astgrep.ts`](../../src/engine/astgrep.ts)
