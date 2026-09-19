# Brief: Strata-MCP Lifecycle Management (CLI Init & In-Process Auto-Sync)

> **Kategori**: feature  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement
- **Konteks & Alasan**: `strata-mcp` adalah engine structural AST search & intelligence frontend (Vue SFC, React/Next, Astro) yang dirancang untuk membantu AI Agent memahami komponen UI tanpa membaca seluruh file mentah. Saat ini, `strata-mcp` belum memiliki workflow `init` untuk mem-provision agent harness (rules & skills di `.agents/`), dan mekanisme sinkronisasi database graph (`.strata/cache.db`) masih memerlukan pemanggilan manual (`strata sync`), sehingga berisiko *stale graph* saat agent mengedit file kode.
- **Tujuan Utama**:
  1. Menyediakan perintah manual `strata init` untuk mem-provision konfigurasi agent ke direktori `.agents/` (rules & skill) serta menginisialisasi SQLite cache.
  2. Mengaktifkan **In-Process Auto-Sync (Background Watcher)** saat MCP Server berjalan, sehingga setiap perubahan file komponen otomatis memperbarui cache AST secara inkremental tanpa intervensi manual.
  3. Menjamin status **Standalone**: Bebas dari dependensi langsung ke `septum` atau tool luar lainnya agar siap dipublikasikan secara independen ke npmjs.

---

## Scope & Boundaries
### In-Scope
- [ ] Implementasi CLI `strata init` pada `src/cli.ts` (men-generate `.agents/rules/strata-frontend.md`, `.agents/skills/strata-inspect/SKILL.md`, `.gitignore`, dan inisialisasi `.strata/cache.db`).
- [ ] Integrasi in-process file watcher di `src/mcp.ts` menggunakan modul `src/watcher.ts` dan `src/delta-sync.ts` dengan sistem debounce/non-blocking.
- [ ] Konfigurasi filter ekstensi watcher (`.vue`, `.astro`, `.tsx`, `.jsx`, `.ts`, `.js`) dengan pengabaian folder (`node_modules`, `.git`, `dist`, `.strata`).
- [ ] Penyediaan template generator untuk agent rules dan skill yang self-contained.

### Out-of-Scope
- Mengubah algoritma parsing AST internal (`src/engine/astgrep.ts`, `src/engine/contract.ts`).
- Menggabungkan atau memaksakan dependensi paket runtime terhadap `septum`.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Terlibat
1. `src/cli.ts` (L15-L60): Penambahan sub-command `init` pada parser CLI dan handler eksekusi.
2. `src/cli/init.ts` (File Baru): Implementasi modul `handleStrataInit` yang mem-provision `.agents/rules/strata-frontend.md` dan `.agents/skills/strata-inspect/SKILL.md`.
3. `src/cli/templates.ts` (File Baru): Definisi template string untuk rules dan skill.
4. `src/mcp.ts` (L30-L70): Bootstrapping in-process background watcher saat server MCP diinisialisasi melalui stdio transport.

### 2. Line Range Mapping (Presisi Target)
- `src/cli.ts:L25-L65`: Penambahan `case 'init'` dan teks bantuan `printHelp()`.
- `src/mcp.ts:L45-L95`: Integrasi watcher lifecycle (start saat MCP connect, cleanup saat process SIGINT/SIGTERM).

### 3. Urutan Pengerjaan
1. Buat template harness di `src/cli/templates.ts` untuk aturan agent (`strata-frontend.md`) dan skill (`SKILL.md`).
2. Implementasikan logic `handleStrataInit` di `src/cli/init.ts` (membuat `.strata`, `.agents/rules`, `.agents/skills/strata-inspect`, dan trigger initial sync).
3. Daftarkan perintah `strata init` di `src/cli.ts`.
4. Tambahkan background file watcher ke dalam lifecycle `src/mcp.ts` yang memanggil `deltaSync` secara otomatis saat event debounced terjadi.
5. Uji fungsionalitas CLI `strata init` dan verifikasi bahwa MCP server auto-sync berjalan tanpa memblokir I/O stdio.

### 4. Dampak & Risiko
- **Dampak:** File cache `.strata/cache.db` selalu up-to-date saat sesi coding berlangsung; AI Agent secara otomatis memiliki panduan routing tool di `.agents/`.
- **Risiko Resource Overhead:** File watcher di repo raksasa berpotensi mengonsumsi file descriptor berlebih jika tidak di-ignore dengan benar (`node_modules`, `.git`, `.strata` harus di-exclude secara ketat).
- **Standalone Guarantee:** Tidak ada import `septum` sama sekali.

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1 (CLI Init Manual)**:
  - **Given**: Sebuah workspace baru yang belum memiliki konfigurasi `.strata` maupun `.agents`.
  - **When**: Pengguna menjalankan `strata init` (atau `bun run ./src/cli.ts init`).
  - **Then**: Direktori `.agents/rules/strata-frontend.md` dan `.agents/skills/strata-inspect/SKILL.md` terbuat, file `.gitignore` memastikan `.strata/` diabaikan, dan initial cache SQLite terbentuk.

- [ ] **Scenario 2 (Automated In-Process Sync saat MCP Aktif)**:
  - **Given**: MCP Server `strata-mcp` sedang berjalan melayani agent.
  - **When**: Agent atau pengguna memodifikasi berkas komponen frontend (misal `App.vue` atau `Button.tsx`).
  - **Then**: File watcher mendeteksi perubahan, menjalankan `deltaSync` secara non-blocking di background, dan query berikutnya ke tool `inspect_component` mengembalikan metadata AST terbaru tanpa perlu menjalankan perintah CLI manual.

- [ ] **Scenario 3 (Standalone Independency)**:
  - **Given**: Proyek hanya menginstal `@dimassetoid/strata-mcp` tanpa `septum`.
  - **When**: Semua fungsionalitas `init`, `sync`, dan MCP tools dijalankan.
  - **Then**: Sistem berjalan 100% mulus tanpa error dependensi yang hilang.

---

## Definition of Done (DoD) Checklist
- [ ] Sub-command `strata init` berjalan idempotently (aman dijalankan berulang).
- [ ] Output konfigurasi agent secara konsisten ditulis ke `.agents/`.
- [ ] In-process watcher berjalan stabil dan tidak mengganggu performa respons tool MCP.
- [ ] Unit test ditambahkan untuk `src/cli/init.ts` dan watcher auto-sync.
