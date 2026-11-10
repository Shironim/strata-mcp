# storage-and-delta-sync — SSOT Database graph.db & Mesin Delta Sync

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Engine Penyimpanan & Sinkronisasi (`src/engine/storage/`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Aplikasi frontend berskala menengah hingga besar dapat memiliki ratusan hingga ribuan file komponen.
* **Tantangan Performa:**
  * Mem-parse AST seluruh file setiap kali ada panggilan tool membutuhkan waktu beberapa detik (menghambat respon interaktif LLM).
  * Menyimpan seluruh teks file ke memori memboroskan RAM.
  * Cache yang tidak cerdas akan menyajikan data usang (*stale*) jika sebuah file tipe (`types.ts`) atau barrel file (`index.ts`) berubah.
* **Solusi Storage & Delta Sync:**
  Menyediakan database relasional tertanam (*embedded*) **SQLite (`.strata/graph.db`)** dengan mode **WAL (*Write-Ahead Logging*)** berkecepatan tinggi, dipadukan dengan algoritma **Incremental Delta-Sync** dua lapis (mtime + streaming SHA-256) dan *transitive reverse invalidation*.

---

## 2. Arsitektur Database SQLite (`.strata/graph.db`)

Database diinisialisasi secara otomatis saat perintah `strata init` dijalankan:
* Lokasi file: `<workspace_root>/.strata/graph.db`
* Terisolasi dari Git: Folder `.strata` otomatis dilengkapi file `.gitignore` (`*`).
* **PRAGMA Performa Tinggi:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 15000;
  PRAGMA cache_size = -8192;
  PRAGMA temp_store = FILE;
  ```

---

## 3. Skema Tabel Relasional

```
           ┌──────────────┐
           │    files     │
           └──────┬───────┘
                  │ 1
       ┌──────────┼──────────────┬──────────────┬──────────────┐
       │ *        │ *            │ *            │ *            │ *
┌──────┴──────┐ ┌─┴────────────┐ ┌┴───────────┐ ┌┴───────────┐ ┌┴──────────────────┐
│ components  │ │    edges     │ │ state_deps │ │   routes   │ │ file_dependencies │
└─────────────┘ └──────────────┘ └────────────┘ └────────────┘ └───────────────────┘
```

| Tabel | Kolom Kunci | Peran & Isi Data |
|---|---|---|
| **`files`** | `id`, `path`, `framework`, `mtime`, `size`, `content_hash`, `is_page`, `is_layout`, `render_boundary` | Master katalog file, hash konten, dan status hidrasi rendering. |
| **`components`** | `id`, `file_id`, `name`, `contract_json` | Kontrak publik komponen (props, emits, slots, models) dalam JSON. |
| **`edges`** | `id`, `parent_file_id`, `child_file_id`, `import_type`, `is_rendered`, `payload_json` | Graf relasi pemanggilan: parent merender child, passed props, dan context. |
| **`state_deps`** | `id`, `file_id`, `kind`, `identifier`, `access_mode`, `line_number`, `usage_snippet`, `accessed_properties` | Pelacakan reaktivitas (Pinia/Zustand/Composable), mode read/write/watch. |
| **`routes`** | `id`, `url_path`, `file_id`, `type`, `params_json`, `layout_chain_json` | Pemetaan URL rute, parameter dinamis, dan rantai layout pembungkus. |
| **`file_dependencies`** | `file_id`, `dependency_path`, `content_hash`, `is_external` | Pemetaan dependensi tipe/barrel file untuk pelacakan perubahan lintas file. |
| **`meta`** | `key`, `value` | Metadata internal: `cache_version`, `config_fingerprint`, `sync_generation`. |

---

## 4. Algoritma Incremental Delta-Sync

Setiap kali tool Strata dipanggil, `syncWorkspace()` dijalankan secara otomatis (*Just-In-Time Preflight*):

```
[Agent Memanggil Tool Strata]
               │
               ▼
   [JIT Preflight Check] ──► syncWorkspace()
               │
               ├── 1. Fast Fingerprint (Cek mtime & size disk)
               │      └── Jika berubah: Hitung streaming SHA-256 hash
               │
               ├── 2. Klasifikasi Perubahan (Compare vs graph.db)
               │      ├── UNCHANGED  ──► Lewati (0 ms)
               │      ├── ADDED      ──► Parse AST file baru saja
               │      ├── MODIFIED   ──► Re-parse file & dependensi terdampak
               │      └── DELETED    ──► Hapus via ON DELETE CASCADE
               │
               └── 3. Transitive Invalidation (Cek file_dependencies)
                      └── Jika types.ts / index.ts berubah, re-parse konsumennya
               │
               ▼
[Eksekusi Query Tool dengan Data 100% Fresh (< 50ms)]
```

### A. Dua Lapis Pemeriksaan (*Stat + Streaming Hash*)
1. **Lapis 1 (In-Memory Fast Check):** Memeriksa `mtimeMs` dan `size` file. Jika sama persis dengan cache, file langsung dilewati (*zero overhead*).
2. **Lapis 2 (Kriptografis):** Jika `mtime` berubah, Strata membaca streaming buffer 64 KB untuk menghitung hash SHA-256. Jika hash ternyata identik (hanya save ulang tanpa ubah karakter), file tidak di-parse ulang.

### B. Penghapusan Bersih via `ON DELETE CASCADE`
Semua tabel anak (`components`, `edges`, `state_deps`, `routes`, `file_dependencies`) memiliki foreign key constraint:
```sql
REFERENCES files(id) ON DELETE CASCADE
```
Ketika sebuah file dihapus dari workspace, menghapus 1 baris di tabel `files` akan **otomatis membersihkan seluruh edge, state dependencies, dan hierarki pohon terkait** tanpa meninggalkan data sampah (*orphan records*).

### C. Transitive Invalidation (Tipe & Barrel Files)
Jika developer mengubah file `types.ts` (yang di-import oleh `UserProfile.vue`):
1. Hash `types.ts` dicatat di tabel `file_dependencies`.
2. Saat `types.ts` berubah, Strata mendeteksi mismatch hash pada dependensi `UserProfile.vue`.
3. `UserProfile.vue` otomatis ditandai sebagai **`stale`** dan ikut di-reparse ulang agar kontrak props-nya selalu mutakhir.

### D. Perubahan Konfigurasi Global (`config_fingerprint`)
Jika file `tsconfig.json`, `jsconfig.json`, atau alias path berubah:
* Strata mendeteksi perbedaan hash `config_fingerprint`.
* Memicu *full rebuild* secara otomatis dan aman untuk memastikan resolusi alias konsisten di seluruh graf.

---

## 5. Keamanan & Ketahanan Data (*Crash-Resilience*)

1. **Staged Sync via Temp Tables:**
   Proses sinkronisasi dilakukan di dalam `TEMP TABLE` SQLite (`temp.sync_files`, `temp.sync_verify`). Jika proses dihentikan mendadak di tengah jalan, database utama tidak akan rusak (*anti-corruption*).
2. **WAL Concurrency & Busy Timeout:**
   * Pembacaan (*read queries*) tidak memblokir penulisan (*write sync*).
   * Timeout 15 detik (`busy_timeout = 15000`) dengan mekanisme auto-retry untuk mencegah error kunci SQLite.

---

## 6. Rujukan Implementasi Kode

* **Skema Database & Registry:** [`src/engine/storage/schema.ts`](../../src/engine/storage/schema.ts)
* **Delta Sync Engine:** [`src/engine/storage/delta-sync.ts`](../../src/engine/storage/delta-sync.ts)
* **Staged Sync Algorithm:** [`src/engine/storage/staged-sync.ts`](../../src/engine/storage/staged-sync.ts)
* **State Storage Queries:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)
