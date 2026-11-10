# retrieval-evidence-contract — SSOT Bukti Kriptografis, Budgeting, & Paginasi Token

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Context Budget & Evidence Engine (`src/engine/context-budget.ts`, `src/engine/retrieval-evidence.ts`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Salah satu kegagalan terbesar tool AI coding generasi pertama adalah:
* **Context Flooding (Ledakan Token):** Tool mengembalikan payload ratusan kilobyte sekaligus yang membanjiri window context LLM, memicu error token limit atau membuat model lupa instruksi awal (*Lost in the Middle*).
* **Silent Truncation:** Teks dipotong secara sembarangan di tengah baris atau di tengah JSON tanpa memberi tahu agent bahwa data tersebut belum lengkap.
* **Halusinasi Kepastian:** Tool menyatakan bahwa pencarian selesai padahal sebagian direktori di-ignore atau terjadi error parsial.
* **Solusi Kontrak Retrieval:**
  Strata-MCP menegakkan batas hard budget byte (`max_bytes`), token paginasi deterministik (`continuation_token`), bukti kriptografis asal data (*provenance tracking*), dan pelaporan kelalaian eksplisit (*explicit omissions*).

---

## 2. Spesifikasi Parameter Budget & Paginasi

Semua tool di Strata-MCP memiliki parameter standar untuk mengendalikan ukuran respon:

| Parameter | Tipe | Default | Deskripsi |
|---|---|---|---|
| `max_bytes` | `integer` | `16384` (16 KiB) | Batas maksimal ukuran payload UTF-8 JSON hasil tool call (minimum 512 bytes). Jika data melebihi batas ini, Strata melakukan pemotongan teratur (*graceful pagination*) atau mengembalikan budget error eksplisit. |
| `continuation_token` | `string` | `undefined` | Token kriptografis deterministik yang dikembalikan saat respon terpotong untuk mengambil halaman berikutnya. |
| `include_structured` | `boolean` | `false` | Ketika `format: "text"`, atur ke `true` jika ingin menyertakan payload penuh `structuredContent` JSON. Default `false` untuk menghemat transport bandwidth. |

---

## 3. Struktur Objek Retrieval Evidence

Setiap respon dari tool Strata menyertakan metadata bukti retrieval pada `structuredContent.retrieval`:

```json
{
  "retrieval": {
    "policy": "component-tree-v1",
    "workspace": "/path/to/project",
    "scope": "/path/to/project/src",
    "basis": "indexed",
    "status": "complete",
    "selectionReason": "Bounded component traversal selected by entrypoint, direction, depth and scope.",
    "snapshot": {
      "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "timestamp": 1700000000000
    },
    "budget": {
      "maxBytes": 16384,
      "bytesOut": 4096,
      "truncated": false
    },
    "omissions": []
  }
}
```

### Elemen-Elemen Kunci:
1. **`basis` (`'source' | 'derived' | 'indexed'`):**
   * `'source'`: Fakta dibaca langsung dari baris kode sumber asli.
   * `'derived'`: Fakta disimpulkan dari pola konvensi (misal: menebak nama controller dari route).
   * `'indexed'`: Fakta diambil dari database graf terindeks (`graph.db`).
2. **`status` (`'complete' | 'partial' | 'stale'`):**
   * `'complete'`: Seluruh scope yang diminta berhasil dianalisis penuh tanpa ada kegagalan parse.
   * `'partial'`: Terdapat file yang gagal di-parse atau dipotong oleh batas `limit`/`max_depth`.
   * `'stale'`: File di disk telah berubah sejak pembacaan terakhir; meminta pengambilan ulang.
3. **`omissions` (Daftar Kelalaian Eksplisit):**
   Jika ada file yang dilewati karena parse error atau dynamic syntax, dicatat secara transparan dengan kode dan alasan (misal: `DYNAMIC_PROP_SPREAD`, `VUE_PARSE_FAILED`).

---

## 4. Mekanisme Paginasi Token (`continuation_token`)

Ketika koleksi data (misalnya daftar file pada `find_code(action: "map")` atau matches pencarian) melebihi batas `max_bytes`:
1. Strata memotong koleksi pada batas item yang aman (tanpa merusak struktur sintaksis JSON).
2. Menghasilkan respon berisi metadata:
   ```json
   {
     "budget": {
       "maxBytes": 16384,
       "truncated": true,
       "continuationToken": "eyJvZmZzZXQiOjUwLCJzZWVkIjoxMjM0NX0="
     }
   }
   ```
3. AI agent cukup mengulang pemanggilan tool dengan menyertakan:
   `continuation_token: "eyJvZmZzZXQiOjUwLCJzZWVkIjoxMjM0NX0="`
   untuk menerima halaman berikutnya secara deterministik tanpa duplikasi data.

---

## 5. Rujukan Implementasi Kode

* **Context Budget Enforcer:** [`src/engine/context-budget.ts`](../../src/engine/context-budget.ts)
* **Retrieval Evidence Formatter:** [`src/engine/retrieval-evidence.ts`](../../src/engine/retrieval-evidence.ts)
* **Index Retrieval Tracker:** [`src/engine/index-retrieval-evidence.ts`](../../src/engine/index-retrieval-evidence.ts)
* **Mcp Response Decorator:** [`src/tools/retrieval-response.ts`](../../src/tools/retrieval-response.ts)
