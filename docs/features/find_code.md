# find_code — SSOT Pencarian Struktural Berbasis AST & Inventori Frontend

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Tool Call `find_code` (`src/tools/find-code.ts`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Pencarian kode teks biasa (`grep`, `ripgrep`, regex) sering kali gagal pada kode frontend modern:
* **Kelemahan Grep Biasa:**
  * Terkecoh oleh pemecahan baris (*multi-line formatting*), perbedaan spasi, atau jenis tanda kutip (`'` vs `"` vs `` ` ``).
  * Terkecoh oleh perbedaan penamaan komponen antara PascalCase (`<UserAvatar>`) dan kebab-case (`<user-avatar>`).
  * **Tidak mampu mencari "Absence of Code":** Grep tidak bisa mencari komponen yang *lupa mengisi prop tertentu*.
  * Menjelajahi folder baru dengan membaca seluruh file menghabiskan kuota token secara masif.
* **Solusi `find_code`:**
  Memanfaatkan mesin **`ast-grep` (Rust + Tree-sitter)** untuk pencarian pola sintaksis struktural yang kebal format baris, pencarian adopsi komponen beserta deteksi prop yang dihilangkan (*omission*), dan penyediaan peta inventori file terikat batas (*bounded inventory mapping*) tanpa membaca isi body file.

---

## 2. Spesifikasi Input (Parameter & Aliasing)

| Parameter | Tipe | Wajib? | Deskripsi & Aliasing |
|---|---|---|---|
| `path` | `string` | Opsional | Direktori atau file target pencarian (default: root, alias: `file_path`, `filePath`, `target_path`). |
| `pattern` | `string` | Bersyarat | Pola AST pattern (misal: `"ref($$$)"`, `"computed($$$)"`, `"console.log($$$)"`). Alias: `query`, `search`. |
| `action` | `'search' \| 'map'` | Opsional | Tindakan: `'search'` (default) atau `'map'` (memetakan inventori file tanpa membaca isi bodi). |
| `mode` | `'ast' \| 'auto' \| 'literal'` | Opsional | Mode pencarian pattern: `'ast'` (default struktural), `'literal'` (substring persis per baris), atau `'auto'` (AST dengan fallback literal jika syntax parse error). |
| `component` | `string` | Bersyarat | Nama komponen yang dicari adopsinya (misal: `"BaseButton"` atau `"base-button"`). Alias: `component_name`. |
| `prop_name` | `string` | Opsional | Nama prop untuk dianalisis bersama `component` (misal: `"variant"`). Alias: `prop`. |
| `prop_presence`| `'present' \| 'omitted'` | Opsional | Filter keberadaan prop: `'present'` (default, render yang mengisi prop) atau `'omitted'` (render yang **tidak** mengisi prop). |
| `rule_yaml` | `string` | Opsional | Definisi lengkap aturan relasional YAML ast-grep. |
| `code` | `string` | Opsional | Cuplikan kode untuk diuji polanya secara in-memory (tanpa menyentuh disk, alias: `code_snippet`). |
| `scope` | `'template' \| 'script' \| 'both'` | Opsional | Cakupan pencarian komponen: `'template'`, `'script'`, atau `'both'` (default). |
| `limit` | `integer` | Opsional | Batas maksimal path file yang dikembalikan untuk `action: "map"` (default: `100`, max: `500`). |
| `offset` | `integer` | Opsional | Offset awal untuk pagination stabil pada `action: "map"` (default: `0`). |
| `exclude_dirs` | `string[]` | Opsional | Daftar nama direktori untuk diabaikan (misal: `["storage", "legacy"]`). |
| `format` | `'text' \| 'json'` | Opsional | Format keluaran (default: `'text'`, alias: `output_format`). |

---

## 3. Tiga Mode Operasi Utama

### A. Pencarian Pola AST (`ast-grep`)
* Menggunakan metavariables:
  * `$$$` : Mencocokkan nol atau banyak argumen/statement.
  * `$NAME` : Menangkap identifier tertentu.
* **Kebal Whitespace & Multi-line:** Pola `ref($$$)` akan menemukan deklarasi `ref(0)` satu baris maupun `ref({\n  id: 1,\n  name: 'John'\n})` yang dipecah 10 baris.
* **Relational Rules (YAML):** Mendukung kondisi canggih seperti `inside`, `has`, `precedes`, atau `follows` (misal: mencari pemanggilan API yang hanya terjadi di dalam fungsi `onMounted`).

### B. Analisis Adopsi Komponen & Deteksi Prop Omission
* **Dual-Convention Matching:** Mencari `component: "Alert"` otomatis menemukan `<Alert>`, `<alert>`, dan `<CustomAlert>` jika di-import sebagai alias (`import { Alert as CustomAlert }`).
* **Prop Presence (`prop_presence: "present"`):** Menemukan semua render yang menyuplai prop, baik statis (`variant="danger"`) maupun dinamis (`:variant="type"`).
* **Prop Omission (`prop_presence: "omitted"`):** Menemukan seluruh titik render yang **LUPA / TIDAK MENGISI** prop tersebut. Sangat berguna untuk audit breaking change saat sebuah prop baru diwajibkan di komponen bersama.

### C. Bounded File Inventory (`action: "map"`)
* Mengembalikan daftar file frontend dalam scope tertentu tanpa menelan body file (menghemat hingga 95% token).
* Secara otomatis mengklasifikasikan domain, layer arsitektur (`page`, `component`, `layout`, `store`, `composable`), dan mendeteksi kandidat framework dari `package.json`.

---

## 4. Struktur Output & Contoh Respon

### Contoh A: Hasil Pencarian Prop Omission
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

### Contoh B: Hasil Bounded Inventory (`action: "map"`)
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

## 5. Rujukan Implementasi Kode

* **Katalog Definisi Tool:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Handler Utama:** [`src/tools/find-code.ts`](../../src/tools/find-code.ts)
* **Engine Search:** [`src/engine/search.ts`](../../src/engine/search.ts)
* **Engine AST Grep:** [`src/engine/astgrep.ts`](../../src/engine/astgrep.ts)
* **Prop Intent Search:** [`src/engine/search-intent.ts`](../../src/engine/search-intent.ts)
* **Frontend Map Engine:** [`src/engine/frontend-map.ts`](../../src/engine/frontend-map.ts)
