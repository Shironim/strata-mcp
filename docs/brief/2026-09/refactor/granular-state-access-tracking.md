# Brief: Granular State Tracking & Mutator/Reader Ingestion

> **Kategori**: refactor  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement

- **Konteks & Alasan**:
  Saat ini tabel `state_deps` di SQLite SSOT (`.strata/graph.db`) hanya mencatat relasi biner flat: `(file_id, kind, identifier)`. Sistem sama sekali tidak menyimpan metadata apakah komponen tersebut adalah **Mutator** (menulis/mengubah state) atau **Reader** (hanya menampilkan/membaca state). Akibatnya, setiap kali tool `trace_state` atau fungsi `queryStateImpact` dan `findUnusedState` dipanggil, mesin harus membaca ulang file dari disk dan menjalankan regex heuristik on-the-fly untuk mengelompokkan consumer menjadi mutator atau reader.
- **Tujuan Utama**:
  1. Memperkaya skema tabel `state_deps` dengan kolom `access_mode` (`read` | `write` | `watch`), `line_number`, dan `usage_snippet`.
  2. Mengklasifikasikan access mode secara otomatis pada saat ingestion/indexing awal via AST parser (`extractStateDependencies`).
  3. Mengubah `queryStateImpact` dan `findUnusedState` menjadi 100% indexed SQL queries tanpa disk I/O maupun regex matching berulang saat query time.

---

## Scope & Boundaries

### In-Scope
- [x] Penambahan kolom `access_mode TEXT DEFAULT 'read' CHECK(access_mode IN ('read', 'write', 'watch'))`, `line_number INTEGER`, dan `usage_snippet TEXT` pada tabel `state_deps` di [`src/engine/database.ts`](file:///home/shironim/Project/strata-mcp/src/engine/database.ts).
- [x] Pembaruan fungsi `extractStateDependencies` di [`src/engine/contract.ts`](file:///home/shironim/Project/strata-mcp/src/engine/contract.ts) untuk mendeteksi write actions (misal: assignment, store actions, setter call `$patch`, `setState`) vs read usages.
- [x] Refactoring `queryStateImpact` dan `findUnusedState` di [`src/engine/database.ts`](file:///home/shironim/Project/strata-mcp/src/engine/database.ts) agar mengelompokkan mutators vs readers langsung via `WHERE access_mode = 'write'`.
- [x] Penambahan backward compatibility auto-migration di `initSchema()`.

### Out-of-Scope
- [ ] Perubahan format output JSON atau teks yang dihasilkan oleh MCP tool `trace_state` (kontrak publik MCP tetap identik).
- [ ] Refactor tree hierarchy (`get_component_tree`) — ditangani terpisah di brief `sqlite-graph-closure-and-downward-tree.md`.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Diubah & Target Line Range

1. **[`src/engine/database.ts`](file:///home/shironim/Project/strata-mcp/src/engine/database.ts)** (`L162-L185`, `L405-L510`, `L740-L950`):
   - **L162-L167**: Modifikasi skema `state_deps`:
     ```sql
     CREATE TABLE IF NOT EXISTS state_deps (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
       kind TEXT NOT NULL,
       identifier TEXT NOT NULL,
       access_mode TEXT DEFAULT 'read' CHECK(access_mode IN ('read', 'write', 'watch')),
       line_number INTEGER DEFAULT 0,
       usage_snippet TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_state_deps_ident_mode ON state_deps(identifier, access_mode);
     ```
   - **L405-L420 & L475-L510**: Bind `access_mode`, `line_number`, dan `usage_snippet` saat insert atomic batch.
   - **L740-L840** (`queryStateImpact`): Ganti pemindaian regex on-the-fly dengan query SQL:
     ```sql
     SELECT f.path, f.is_page, s.access_mode, s.line_number, s.usage_snippet
     FROM state_deps s
     JOIN files f ON s.file_id = f.id
     WHERE s.identifier = ?;
     ```
   - **L850-L950** (`findUnusedState`): Query langsung file yang memiliki 0 dependent record pada `state_deps`.

2. **[`src/engine/contract.ts`](file:///home/shironim/Project/strata-mcp/src/engine/contract.ts)** (`L70-L130`):
   - Perbarui parser `extractStateDependencies` untuk mengembalikan array objek:
     `Array<{ kind: string; identifier: string; accessMode: 'read' | 'write' | 'watch'; lineNumber: number; usageSnippet?: string }>`
   - Deteksi pola mutator:
     - Pinia/Vuex: `store.action()`, `store.$patch()`, `store.count++`
     - React: `setCount(...)`, `dispatch(...)`
     - Composable: fungsi yang diawali dengan `mutate`, `set`, `update`, `delete`, `add`

3. **[`src/types.ts`](file:///home/shironim/Project/strata-mcp/src/types.ts)**:
   - Perbarui interface dependency state:
     ```ts
     export type StateAccessMode = 'read' | 'write' | 'watch';
     export interface StateDependencyItem {
       kind: 'store' | 'context' | 'composable';
       identifier: string;
       accessMode: StateAccessMode;
       lineNumber?: number;
       usageSnippet?: string;
     }
     ```

### 2. Urutan Pengerjaan Logis
1. Definisikan type `StateAccessMode` & `StateDependencyItem` di `src/types.ts`.
2. Perbarui `initSchema` & migrasi database di `src/engine/database.ts`.
3. Tingkatkan `extractStateDependencies` di `src/engine/contract.ts` untuk melacak `accessMode`.
4. Perbarui ingestion loop di `src/engine/database.ts` dan `src/engine/watcher.ts`.
5. Refactor `queryStateImpact` dan `findUnusedState` menjadi native SQL filter.
6. Verifikasi via `bun test`.

### 3. Dampak Terhadap Bagian Lain
- **Tool `trace_state`**: Mendapatkan peningkatan kecepatan query hingga 10x pada proyek besar karena tidak ada pembacaan disk berulang saat menghitung mutators vs readers.
- **Deteksi Unused State**: Jauh lebih akurat dan bebas dari false-positive akibat regex name matching parsial.

---

## Acceptance Criteria (Given-When-Then)

- [x] **Scenario 1: Klasifikasi Mutator vs Reader Tersimpan di SQLite**:
  - **Given**: Komponen Vue mengimpor `useCartStore` dan memanggil `cart.checkout()`.
  - **When**: File diindeks ke database `.strata/graph.db`.
  - **Then**: Tabel `state_deps` mencatat baris dengan `access_mode = 'write'` dan cuplikan baris kode pada `usage_snippet`.

- [x] **Scenario 2: Query State Impact Murni via SQL**:
  - **Given**: State `useCartStore` digunakan di 10 komponen.
  - **When**: Pemanggilan `queryStateImpact("useCartStore")` dijalankan.
  - **Then**: Hasil mutator dan reader langsung dikelompokkan berdasarkan kolom `access_mode` dari SQL tanpa ada pembacaan disk (`fs.readFile`) tambahan.

---

## Definition of Done (DoD) Checklist

- [x] Skema `state_deps` diperbarui dengan `access_mode`.
- [x] `extractStateDependencies` mengklasifikasikan read vs write via AST.
- [x] `queryStateImpact` dan `findUnusedState` 100% menggunakan SQL indexing.
- [x] Unit tests untuk state tracking lulus (`tests/core/granular-state-tracking.test.ts`).

---

## Provenance
- **Completion Commit**: Completed
- **Anchors**:
  - `src/engine/database.ts`
  - `src/engine/contract.ts`
