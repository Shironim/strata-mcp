# generate_patch_plan — SSOT Rencana Refactoring Deterministik

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Tool Call `generate_patch_plan` (`src/tools/patch-plan.ts`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Refactoring kontrak komponen (mengubah nama prop, menghapus event, merename v-model atau slot) pada codebase frontend yang besar sangat berisiko:
* **Masalah Pengembang & AI Agent:**
  * Edit manual berbasis pencarian teks sering melewatkan file konsumen, salah mengganti variabel yang kebetulan bernama sama, atau salah memperkirakan nomor baris (*offset drift*).
  * Agent sering berasumsi bahwa semua passing prop bersifat statis, padahal ada komponen yang menggunakan spread operator (`{...props}` atau `v-bind="$attrs"`).
* **Solusi `generate_patch_plan`:**
  Menghitung rencana perubahan kode (*patch plan*) yang deterministik, presisi secara AST, terikat hash kriptografis (`sourceRef`), serta secara otomatis mendeteksi dan memperingatkan keberadaan dynamic prop spread (`DYNAMIC_PROP_SPREAD`).

---

## 2. Spesifikasi Input (Parameter & Aliasing)

| Parameter | Tipe | Wajib? | Deskripsi & Aliasing |
|---|---|---|---|
| `path` | `string` | **Ya** | Path ke file komponen yang direfactor (misal: `"src/components/BaseButton.vue"`). Alias: `component_path`, `file_path`, `filePath`, `component`. |
| `refactor_type`| `'rename_prop' \| 'remove_prop' \| 'rename_event' \| 'remove_event' \| 'rename_model' \| 'remove_model' \| 'rename_slot' \| 'remove_slot'` | **Ya** | Jenis operasi refactoring yang dilakukan. Alias: `refactor`, `refactorType`. |
| `old_name` | `string` | **Ya** | Nama prop, event, model, atau slot saat ini (misal: `"is-active"`, `"on-submit"`). Alias: `old`, `oldName`. |
| `new_name` | `string` | Bersyarat* | Nama baru target (wajib diisi saat operasi rename). Alias: `new`, `newName`. |
| `operations` | `array` | Opsional | Daftar operasi atomik untuk dieksekusi secara batch dalam satu lintasan (Alias: `batch_operations`). |
| `target_path` | `string` | Opsional | Direktori root proyek (default: `"."`). |
| `format` | `'text' \| 'json'` | Opsional | Format keluaran (default: `'text'`, alias: `output_format`). |

*\*Wajib jika operasi berupa rename.*

---

## 3. Cara Kerja Teknis & Algoritma

```
[Target Component: BaseButton.vue]
  ├── 1. Validasi Prekondisi (Cek kontrak komponen & keberadaan old_name)
  ├── 2. Upward Traversal (Cari seluruh konsumen yang merender komponen ini)
  ├── 3. AST Diff Engine (Urai DOM template Vue / JSX TSX konsumen)
  │      - Hitung koordinat baris, kolom, startOffset, endOffset
  │      - Hasilkan oldSnippet & newSnippet
  │      - Ikat ke hash SHA-256 (sourceRef)
  └── 4. Safety Guard: Tandai DYNAMIC_PROP_SPREAD jika konsumen menggunakan spread
```

### A. Prekondisi & Validasi Kontrak
Sebelum menghitung patch, Strata menginspeksi target komponen:
* Memverifikasi apakah `old_name` benar-benar dideklarasikan di komponen tersebut. Jika tidak ada, proses ditolak lebih awal dengan pesan diagnostik yang jelas.

### B. Upward Consumer Traversal
Menggunakan algoritma upward component tree untuk menemukan semua file konsumen yang mengimpor dan merender komponen target.

### C. Pemotongan Offsets & Snippets Presisi
* **Props (`rename_prop` / `remove_prop`):** Menemukan atribut statis (`is-active="true"`), dinamis (`:is-active="val"`), maupun kebab/camel-case (`:isActive="val"`). Menghitung karakter pengganti dan merapikan whitespace jika dihapus.
* **Events (`rename_event` / `remove_event`):** Menemukan directive event `@click` atau `v-on:click` pada Vue, serta callback props `onClick={...}` pada React.
* **Models (`rename_model` / `remove_model`):** Menemukan `v-model:name="val"`.
* **Slots (`rename_slot` / `remove_slot`):** Menemukan named slot `#header` atau `v-slot:header`.

### D. Safety Guard: Deteksi `DYNAMIC_PROP_SPREAD`
Jika ada komponen konsumen yang meneruskan prop menggunakan spread operator:
* Vue: `<BaseButton v-bind="$attrs" />` atau `v-bind="props"`
* React: `<BaseButton {...props} />`

Strata otomatis memunculkan peringatan:
`[WARNING: DYNAMIC_PROP_SPREAD]` pada file tersebut. Ini memberi tahu AI agent bahwa static analysis tidak dapat menjamin 100% konsumsi prop di titik tersebut, sehingga agent wajib melakukan inspeksi manual.

---

## 4. Struktur Output & Contoh Respon

### Format JSON Terstruktur (`format: "json"`):
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
      "message": "Component uses v-bind=\"$attrs\". Verifikasi manual diperlukan."
    }
  ]
}
```

---

## 5. Rujukan Implementasi Kode

* **Katalog Definisi Tool:** [`src/tools/catalog.ts`](../../src/tools/catalog.ts)
* **Handler Utama:** [`src/tools/patch-plan.ts`](../../src/tools/patch-plan.ts)
* **Engine Patch Plan:** [`src/engine/patch-plan.ts`](../../src/engine/patch-plan.ts)
* **Preconditions Checker:** [`src/engine/patch-preconditions.ts`](../../src/engine/patch-preconditions.ts)
* **Coverage & Omission Collector:** [`src/engine/patch-coverage.ts`](../../src/engine/patch-coverage.ts)
