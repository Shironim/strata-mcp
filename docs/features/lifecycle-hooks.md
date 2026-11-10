# lifecycle-hooks — SSOT Agent Lifecycle Hooks & Closed-Loop Refactoring

**Status:** Single Source of Truth (SSOT)  
**Pemilik Fitur:** Lifecycle Hooks System (`.agents/hooks/`, `.agents/hooks.json`)  
**Terakhir Diperbarui:** 2026-11-11  

---

## 1. Tujuan & Kebutuhan Bisnis

Ketika AI agent melakukan perubahan kode pada proyek berskala besar:
* **Masalah Cache Stale:** Database indeks arsitektur (seperti `graph.db` di Strata atau `septum.db` di Septum) menjadi usang (*out-of-sync*) seketika setelah agent mengedit sebuah file. Jika agent tidak menjalankan re-index, giliran (*turn*) berikutnya akan membaca data kadaluarsa dan memicu halusinasi.
* **Pelanggaran Batas Arsitektur:** Agent sering kali secara tidak sengaja membuat impor terlarang (*forbidden dependency*) atau dependensi melingkar (*circular dependency*) saat menambahkan baris impor baru.
* **Solusi Lifecycle Hooks:**
  Menyediakan mekanisme pencegahan (*pre-tool guard*) dan sinkronisasi otomatis (*post-tool sync*) yang terpicu secara instan di latar belakang setiap kali agent memanggil tool edit file (`write_file`, `edit_file`, dsb.), menciptakan **Siklus Refactoring Tertutup (*Closed-Loop Self-Healing Workflow*)**.

---

## 2. Arsitektur & Cara Kerja Hooks

Konfigurasi hooks didefinisikan secara deklaratif di `.agents/hooks.json` dan didistribusikan ke direktori masing-masing agent:

```
[Agent Ingin Mengubah File]
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. PRE-TOOL-USE HOOK (septum-pre-write.sh)                 │
│    - Mencegat payload sebelum file ditulis                 │
│    - Validasi batas modul & larangan circular import        │
│    - Jika melanggar: Tolak operasi dengan feedback jelas    │
└──────────────────────────┬──────────────────────────────────┘
                           │ (Lolos Validasi)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. FILE TERTULIS KE DISK (write_file / edit_file)           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. POST-TOOL-USE HOOK (strata-post-write.sh)                │
│    - Mencegat path file yang baru diubah                   │
│    - Jika berekstensi frontend (.vue, .tsx, .svelte, dll)   │
│    - Eksekusi "strata sync <workspace>" background (<20ms) │
│    - graph.db langsung FRESH untuk turn agent berikutnya   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Detail Skrip Hook

### A. `strata-post-write.sh` (Auto Delta-Sync Frontend)
* **Lokasi:** `.agents/hooks/strata-post-write.sh` (didistribusikan ke `.gemini/hooks/`, `.claude/hooks/`, `.codex/hooks/`).
* **Mekanisme Ekstraksi Input:**
  Mampu membaca path file yang diubah dari environment variable (`CLAUDE_FILE_PATH`), argument `$1`, atau parsing stream stdin JSON dari harness agent menggunakan runtime `node`, `bun`, `python3`, atau fallback `sed`.
* **Eksekusi:**
  Jika file berekstensi `.vue`, `.astro`, `.svelte`, `.tsx`, `.jsx`, `.ts`, atau `.js`:
  ```bash
  strata sync "$WORKSPACE_ROOT" --json
  ```
  Menjalankan incremental delta-sync secara instan ($<20$ milidetik) sehingga `graph.db` selalu 100% mutakhir.

### B. `septum-pre-write.sh` & `septum-post-write.sh` (Backend Boundary Guard)
* **Pre-Write:** Menguji *proposed imports* terhadap aturan arsitektur di `septum.db`. Mencegah dependensi melingkar sebelum file ditulis.
* **Post-Write:** Memperbarui tabel simbol backend di `septum.db`.

---

## 4. Dukungan AI Agent & Harness

Sistem hook Strata-MCP dirancang agnostik dan mendukung berbagai ekosistem AI coding agent:

| AI Agent | Folder Konfigurasi | Dukungan Hook |
|---|---|---|
| **Google Antigravity** | `.gemini/` | Native MCP stdio transport + Pre/PostToolUse hooks |
| **Claude Code & Desktop** | `.claude/` | Event-driven lifecycle hooks (`PostToolUse`) |
| **OpenAI Codex Agent** | `.codex/` | Hooks shell execution engine |
| **Roo Code / Cline / OpenCode** | `.agents/` / `opencode/` | Standard matcher config via `.agents/hooks.json` |
| **Cursor & Windsurf** | Workspace config | MCP stdio integration + prompt guidance rules |

---

## 5. Manfaat bagi AI Agent

1. **Closed-Loop Self-Healing:**
   Agent dapat merencanakan perubahan (`generate_patch_plan`), mengeksekusi edit (`edit_file`), dan secara otomatis memverifikasi hasil kontrak (`inspect_component`) tanpa pernah membaca data cache usang.
2. **Zero Manual Overhead:** Developer manusia dan AI agent tidak perlu mengingat untuk mengetik perintah `strata sync` secara manual di terminal.
3. **Pencegahan Regresi Otomatis:** Hook pre-write mencegah kode yang merusak aturan modularitas masuk ke dalam sistem.

---

## 6. Rujukan Implementasi Kode

* **Manifest Hook:** [`.agents/hooks.json`](../../.agents/hooks.json)
* **Skrip Strata Post-Write:** [`.agents/hooks/strata-post-write.sh`](../../.agents/hooks/strata-post-write.sh)
* **Engine Sinkronisasi:** [`src/engine/storage/delta-sync.ts`](../../src/engine/storage/delta-sync.ts)
