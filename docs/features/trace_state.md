# trace_state — SSOT Pelacak Arus State Management & Composables

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Tool Call `trace_state` (`src/tools/trace-state.ts`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

State reaktif (Pinia, Zustand, Redux, Context, dan Composables) adalah sumber kebenaran data aplikasi frontend.
* **Masalah Pengembang & AI Agent:**
  * Saat mengubah struktur data store atau me-rename fungsi pada composable, agent tidak tahu siapa yang sekadar membaca data (*readers*) dan siapa yang memodifikasinya (*mutators*).
  * Terjadi *race condition* atau re-render loop ketika mutasi state terjadi di luar jalur yang diharapkan.
  * Composables bersarang (*multi-hop composables*) menyembunyikan ketergantungan asli dari komponen akhir.
* **Solusi `trace_state`:**
  Menganalisis arus reaktivitas secara semantis lintas file: membedakan peran konsumen menjadi `mutators` (pemanggil action / setter) dan `readers` (penampil data / watcher), mencatat properti yang dibaca dan action yang dipanggil, serta melacak rantai pemanggilan bersarang (*multi-hop cascading*).

---

## 2. Spesifikasi Input (Parameter & Aliasing)

| Parameter | Tipe | Wajib? | Deskripsi & Aliasing |
|---|---|---|---|
| `identifier` | `string` | **Ya** | Nama identifier state, store, context, atau composable (misal: `"useCartStore"`, `"useAuth"`, `"CartContext"`). Alias: `state`, `state_name`, `store`, `store_name`, `composable`, `name`, `symbol`. |
| `path` | `string` | Opsional | Direktori root proyek atau file komponen spesifik (default: `"."`, alias: `target_path`, `file_path`, `filePath`). |
| `depth` | `number` | Opsional | Kedalaman penelusuran: `1` untuk direct consumers; `>1` untuk multi-hop call chain (default: `1`, alias: `max_depth`). |
| `role` | `'all' \| 'mutators' \| 'readers'` | Opsional | Filter peran konsumen: `'all'` (default), `'mutators'` (hanya pengubah state), atau `'readers'` (hanya pembaca state). |
| `direction` | `'consumers' \| 'dependencies' \| 'both'` | Opsional | Arah pelacakan untuk multi-hop: `'consumers'` (ke atas/pemakai), `'dependencies'` (ke bawah/pondasi store ini), atau `'both'` (default: `'both'`). |
| `format` | `'text' \| 'json'` | Opsional | Format keluaran (default: `'text'`, alias: `output_format`). |

---

## 3. Cara Kerja Teknis & Algoritma

### A. Klasifikasi Akses Semantis (Read vs Write vs Watch)
Strata tidak melakukan text grep sederhana, melainkan membedah AST TypeScript/JSX/Vue untuk menentukan `access_mode`:
1. **`write` (Mutator):**
   * Pemanggilan action / method mutasi yang cocok dengan pola kata kerja: `set*`, `update*`, `delete*`, `add*`, `remove*`, `mutate*`, `trigger*`, `toggle*`, `reset*`, `dispatch*`, `$patch*`.
   * Setter hasil destructuring: `const [count, setCount] = useState()` &rarr; pemanggilan `setCount` dicatat sebagai `write`.
2. **`read` (Reader):**
   * Pengambilan property untuk dirender: `computed(() => store.totalPrice)` atau `useSelector(s => s.items)`.
3. **`watch` (Subscriber):**
   * Pemanggilan `watch(() => store.user, ...)` atau dependency array pada `useEffect`.

### B. Pelacakan Properti & Action Spesifik
* **`accessedProperties`:** Menyimpan daftar field spesifik yang disentuh (misal: `["items", "subtotal", "discountCode"]`). Ini memungkinkan agent mengetahui apakah perubahan field tertentu akan mempengaruhi komponen tersebut.
* **`actionsCalled`:** Menyimpan daftar method mutasi yang dieksekusi (misal: `["addItem", "clearCart"]`).
* **`usageSnippet` & `lineNumber`:** Menyimpan cuplikan kode dan nomor baris persis dari lokasi pemanggilan.

### C. Pemindaian Ekspresi Template Vue SFC
Strata mengekstrak binding yang berada langsung di dalam `<template>` Vue SFC (misal: `<button @click="cartStore.checkout()">{{ cartStore.totalPrice }}</button>`), memetakan `checkout()` ke mutator dan `totalPrice` ke reader meskipun tidak ada variabel lokal di `<script>`.

### D. Multi-Hop Chaining (`depth: 2+`)
Melacak rantai ketergantungan bertingkat:
* `useCartStore` &rarr; di-import oleh `useCheckoutSession` &rarr; di-import oleh `CheckoutModal.vue`.
* Dengan `direction: "both"`, agent dapat melihat seluruh pohon silsilah dependensi state.

---

## 4. Dukungan Bahasa & Framework

* **Vue 3 & Nuxt (Pinia, Composables):**
  * Pinia stores (`defineStore`).
  * Nuxt auto-imported composables/stores.
  * Vue composables kustom (`use*.ts`).
* **React & Next.js (Zustand, Redux Toolkit, Context, Hooks):**
  * Zustand selector patterns: `useStore(state => state.items)`.
  * Redux Toolkit: `useSelector` (reader) dan `useDispatch` / `dispatch()` (mutator).
  * React Context: `<Context.Provider>` dan `useContext()`.
  * TanStack Query: `useQuery` (reader) vs `useMutation` (mutator).
* **Inertia.js:**
  * Router triggers: `router.post()`, `router.put()`, `router.delete()`.
* **Svelte:**
  * Svelte 5 Runes (`$state`), universal shared state modules, dan Svelte Context.

---

## 5. Struktur Output & Contoh Respon

### Format Teks Default (`format: "text"`):
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

### Format Terstruktur JSON (`structuredContent`):
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

## 6. Rujukan Implementasi Kode

* **Katalog Definisi Tool:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Handler Utama:** [`src/tools/trace-state.ts`](../../src/tools/trace-state.ts)
* **Storage & Multi-Hop Engine:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)
* **Vue State Dependency Parser:** [`src/engine/parsers/state-dependency.ts`](../../src/engine/parsers/state-dependency.ts)
* **React State Dependency Parser:** [`src/engine/parsers/react-state-dependency.ts`](../../src/engine/parsers/react-state-dependency.ts)
