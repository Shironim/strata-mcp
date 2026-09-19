# Brief: Strata-MCP Codebase Hygiene & MCP Tool Parity

> **Kategori**: refactor  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement
- **Konteks & Alasan**: Berdasarkan hasil audit review-ai-code menjelang publikasi ke npmjs, ditemukan dua isu arsitektural pada `@dimassetoid/strata-mcp`:
  1. **Asimetri Fungsionalitas CLI vs MCP Server**: Engine memiliki dua kapabilitas ekstraksi tingkat tinggi yang sangat berharga—[`scanRoutes`](src/engine/routes.ts) dan [`extractWorkspaceApiContracts`](src/engine/api-contract.ts)—namun keduanya hanya dapat diakses melalui CLI (`strata routes` dan `strata apis`). AI Agent yang berkomunikasi via protokol MCP tidak dapat mengakses rute frontend maupun kontrak endpoint API komponen.
  2. **Internal Debugging Utility Leakage ("Magic / Out-of-Scope")**: Sub-command `strata dump <code>` di [`src/cli.ts`](src/cli.ts) mengekspos fungsi debugging mentah pohon AST-grep yang tidak memiliki nilai fungsional bagi end-user maupun AI Agent di lingkungan produksi.
- **Tujuan Utama**:
  1. Menghapus sub-command `dump` dari antarmuka CLI publik.
  2. Mengekspos tool MCP baru: `get_routes` (memetakan rute frontend Next.js, Nuxt, Astro, dan Inertia) dan `get_api_contracts` (mengekstrak endpoint API yang dipanggil komponen) pada [`src/tools/`](src/tools/).
  3. Memastikan seluruh surface fitur 100% konsisten, koheren, dan siap dipublikasikan ke npmjs tanpa kode coba-coba ("magic").

---

## Scope & Boundaries
### In-Scope
- [ ] Menghapus opsi command `dump` dan import `dumpSyntaxTree` dari [`src/cli.ts`](src/cli.ts).
- [ ] Membuat definisi tool MCP `get_routes` di `src/tools/get-routes.ts` yang membungkus `scanRoutes`.
- [ ] Membuat definisi tool MCP `get_api_contracts` di `src/tools/get-api-contracts.ts` yang membungkus `extractWorkspaceApiContracts`.
- [ ] Mendaftarkan kedua tool tersebut ke [`src/tools/index.ts`](src/tools/index.ts) dan memperbarui schema array `TOOLS`.
- [ ] Memperbarui dokumentasi rules di `.agents/rules/strata-frontend.md` agar AI Agent mengetahui keberadaan tool rute dan API kontrak.

### Out-of-Scope
- Mengubah skema database SQLite di `.strata/cache.db`.
- Mengubah algoritma internal AST remapping pada Vue, React, atau Astro.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Terlibat
1. `src/cli.ts` (L20-L50, L370-L382): Penghapusan dokumentasi dan handler `command === 'dump'`.
2. `src/tools/get-routes.ts` (File Baru): Tool MCP `get_routes` dengan schema `targetPath`, `framework`, `prefix`.
3. `src/tools/get-api-contracts.ts` (File Baru): Tool MCP `get_api_contracts` dengan schema `targetPath`, `framework`.
4. `src/tools/index.ts` (L1-L35): Ekspor dan registrasi `getRoutesTool` dan `getApiContractsTool`.
5. `.agents/rules/strata-frontend.md`: Penambahan tool baru ke tabel routing agent.

### 2. Line Range Mapping (Presisi Target)
- `src/cli.ts:L35-L40`: Hapus baris `strata dump <code> [options]`.
- `src/cli.ts:L370-L385`: Hapus blok `if (command === 'dump') { ... }`.
- `src/tools/index.ts:L1-L30`: Tambahkan impor dan masukkan ke array `TOOLS`.

### 3. Urutan Pengerjaan
1. Buat tool MCP `src/tools/get-routes.ts`.
2. Buat tool MCP `src/tools/get-api-contracts.ts`.
3. Daftarkan kedua tool ke `src/tools/index.ts`.
4. Bersihkan `dump` dari `src/cli.ts`.
5. Sinkronkan tabel panduan pada `src/cli/templates.ts` dan `.agents/rules/strata-frontend.md`.
6. Tambahkan unit test untuk tool MCP baru di `tests/mcp/routes-api-tools.test.ts`.

### 4. Dampak & Risiko
- **Dampak Positif:** AI Agent dapat langsung memetakan arsitektur rute dan ketergantungan API backend dari UI melalui protokol MCP tanpa perlu menjalankan bash shell CLI.
- **Risiko Breaking Change:** Sub-command `strata dump` dihapus (dapat diterima karena merupakan internal utility sesuai instruksi user).

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1 (Eksposur Tool MCP Rute)**:
  - **Given**: Server MCP `strata-mcp` sedang melayani client.
  - **When**: Client memanggil tool `get_routes` dengan opsi `targetPath`.
  - **Then**: Tool mengembalikan manifest rute halaman yang terdeteksi (Next/Nuxt/Astro/Inertia) dalam format JSON terstruktur.

- [ ] **Scenario 2 (Eksposur Tool MCP API Contracts)**:
  - **Given**: Server MCP `strata-mcp` sedang melayani client.
  - **When**: Client memanggil tool `get_api_contracts` dengan opsi `targetPath`.
  - **Then**: Tool mengembalikan daftar panggilan endpoint HTTP (URL, method, payload keys) yang dikonsumsi oleh komponen-komponen UI.

- [ ] **Scenario 3 (Pembersihan Command Dump)**:
  - **Given**: Pengguna menjalankan CLI `strata --help`.
  - **When**: Output bantuan ditampilkan.
  - **Then**: Perintah `dump` tidak lagi muncul di daftar panduan dan eksekusi `strata dump` menghasilkan pesan unknown command.

---

## Definition of Done (DoD) Checklist
- [ ] Command `dump` dihapus bersih dari CLI.
- [ ] Tool `get_routes` dan `get_api_contracts` terdaftar pada ListTools MCP.
- [ ] Unit test MCP mencakup eksekusi kedua tool baru.
- [ ] Seluruh test suite `bun test` tetap 100% lulus.
