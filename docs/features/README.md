# Strata-MCP Features — Single Source of Truth (SSOT)

Selamat datang di direktori dokumentasi resmi **Single Source of Truth (SSOT)** untuk **Strata-MCP (Frontend Structural Intelligence Engine)**.

Dokumentasi ini merangkum kebutuhan bisnis, cara kerja teknis tingkat mendalam (*deep AST traversal*), spesifikasi input/output, batasan arsitektur, dan integrasi lintas sistem (termasuk Septum-MCP dan Lifecycle Hooks).

---

## Peta Navigasi Fitur

### 1. Alat Analisis & Inspeksi Utama (Core MCP Tools)

* **[`inspect_component.md`](./inspect_component.md)** — **Inspeksi Kontrak Komponen & AST Slicing**  
  Mengekstrak kontrak publik komponen (props, emits, slots, models, state dependencies, dan outbound API calls) tanpa menelan template markup presentasi, serta memotong fungsi target (*symbol slicing*) dengan verifikasi caller presisi.

* **[`get_component_tree.md`](./get_component_tree.md)** — **Topologi Hirarki Komponen & Analisis Blast Radius**  
  Menelusuri hierarki komponen secara vertikal: ke bawah (*downward*) untuk memetakan anak & mendeteksi Props Drilling (>2 level), dan ke atas (*upward*) untuk mengukur blast radius dampak perubahan pada halaman/view sebelum refactoring.

* **[`trace_state.md`](./trace_state.md)** — **Pelacak Arus State Management & Composables**  
  Menganalisis arus reaktivitas (Pinia, Zustand, Redux, Context, dan Composables): memisahkan konsumen menjadi `mutators` (pemanggil action / setter) dan `readers` (penampil data), melacak properti yang disentuh, serta mendukung multi-hop cascading chains (`depth: 2+`).

* **[`find_code.md`](./find_code.md)** — **Pencarian Struktural Berbasis AST & Inventori Frontend**  
  Pencarian pola AST (`ast-grep`) yang kebal whitespace dan format baris, analisis adopsi komponen (PascalCase vs kebab-case), deteksi prop omission (`prop_presence: "omitted"`), serta bounded file inventory (`action: "map"`).

* **[`audit_frontend.md`](./audit_frontend.md)** — **Topologi URL Rute, API Contracts, & Fullstack Bridge**  
  Audit sitemap rute URL dan nested layouts, deteksi dead code (komponen & state mati), inventarisasi pemanggilan API outbound beserta **`backendTargetHint`** sebagai jembatan estafet ke **Septum-MCP** di backend.

* **[`generate_patch_plan.md`](./generate_patch_plan.md)** — **Rencana Refactoring Deterministik**  
  Menghitung perubahan kode lintas file konsumen secara presisi AST saat merename atau menghapus prop, event, model, atau slot, lengkap dengan deteksi guardrail `DYNAMIC_PROP_SPREAD`.

---

### 2. Arsitektur Pondasi & Sistem Pendukung

* **[`storage-and-delta-sync.md`](./storage-and-delta-sync.md)** — **Database `graph.db` & Mesin Incremental Delta Sync**  
  Arsitektur penyimpanan SQLite tertanam (WAL mode), skema relasional 6 tabel, algoritma deteksi perubahan dual-pass (mtime + streaming SHA-256), `ON DELETE CASCADE`, dan transitive reverse dependency invalidation.

* **[`lifecycle-hooks.md`](./lifecycle-hooks.md)** — **Agent Lifecycle Hooks & Closed-Loop Refactoring**  
  Sistem hook otomatis (`strata-post-write.sh` & `septum-pre-write.sh`) yang terpicu setiap kali agent mengedit kode, menjaga `graph.db` selalu mutakhir (<20ms) dan mendukung multi-agent (Google Antigravity, Claude Code, OpenAI Codex, OpenCode/Roo Code, Cursor, Windsurf).

* **[`retrieval-evidence-contract.md`](./retrieval-evidence-contract.md)** — **Bukti Kriptografis, Budgeting, & Paginasi Token**  
  Kontrak batas ukuran respon (`max_bytes`), token paginasi deterministik (`continuation_token`), dan pelaporan kelalaian eksplisit (*omissions*).

* **[`tool-call-logging.md`](./tool-call-logging.md)** — **Audit Logging & Telemetri Lokal**  
  Kontrak pencatatan pemanggilan tool ke `.strata/strata.log`, deteksi bloat respon (>16 KiB), metrik durasi, dan rotasi log otomatis.

---

## Matriks Panduan Pemilihan Alat bagi AI Agent

| Skenario Kebutuhan | Alat yang Direkomendasikan | Keunggulan vs `read_file` / `grep` |
|---|---|---|
| **Menjelajahi modul atau folder baru** | `find_code(action: "map")` | Mengambil katalog file dan domain arsitektur tanpa menelan isi file (hemat ~95% token). |
| **Memahami interface atau method komponen** | `inspect_component(path)` | Mengambil props, emits, slot, store, dan API tanpa membaca template 1.000 baris. |
| **Melihat layout memakai komponen apa saja** | `get_component_tree(path, direction: "downward")` | Memetakan anak, passing props, dan mendeteksi props drilling secara instan. |
| **Mengecek komponen dipakai di halaman mana saja** | `get_component_tree(path, direction: "upward")` | Mengukur blast radius ke seluruh halaman aplikasi dalam hitungan milidetik. |
| **Memodifikasi store / composable bersama** | `trace_state(identifier)` | Membedakan mutators (pengubah) dan readers (pembaca) secara presisi. |
| **Menelusuri API dari UI form ke Controller Backend** | `audit_frontend(target: "api-contracts")` &rarr; `septum_slice` | Pola Estafet Fullstack: langsung oper `backendTargetHint` ke Septum tanpa grep di backend. |
| **Merename / menghapus prop di banyak file** | `generate_patch_plan(...)` | Menghitung koordinat baris/kolom AST pasti dan menandai dynamic spread warning. |
