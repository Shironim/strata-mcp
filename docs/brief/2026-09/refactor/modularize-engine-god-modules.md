# Brief: Modularize Engine God Modules (Decomposing SRP Violations)

> **Kategori**: refactor  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement

- **Konteks & Alasan**:
  Codebase inti pada `src/engine/` telah tumbuh melampaui batas *Single Responsibility Principle* (SRP) dan memunculkan tiga "God Modules":
  1. [`src/engine/contract.ts`](file:///home/shironim/Project/strata-mcp/src/engine/contract.ts) ($\pm$ 72 KB / $\sim$ 2.000 baris): Mencampur aduk ekstraksi kontrak komponen Vue, React, Astro, kalkulasi render boundary, dan deteksi state dependency.
  2. [`src/engine/tree.ts`](file:///home/shironim/Project/strata-mcp/src/engine/tree.ts) ($\pm$ 40 KB / $\sim$ 1.200 baris): Menggabungkan path resolution, barrel file re-export chasing, regex heuristics, tree building, context extraction, dan props drilling alerts.
  3. [`src/engine/database.ts`](file:///home/shironim/Project/strata-mcp/src/engine/database.ts) ($\pm$ 38 KB / $\sim$ 1.260 baris): Menggabungkan schema definition, atomic delta hashing, state queries, blast radius CTEs, dan text formatters.
  Akibatnya, unit testing menjadi sulit diisolasi, *cognitive load* meningkat saat membaca kode, dan resiko merge conflict sangat tinggi.
- **Tujuan Utama**:
  1. Memecah ketiga God Module tersebut ke dalam sub-modul yang kohesif dan terfokus pada domain spesifiknya.
  2. Mempertahankan *Anti-Corruption Layer* & backward-compatibility 100% menggunakan barrel re-exports pada file asli, sehingga modul `src/tools/` dan test suite eksisting tidak mengalami breaking import.

---

## Scope & Boundaries

### In-Scope
- [x] Pemecahan `src/engine/contract.ts` ke dalam direktori `src/engine/parsers/`:
  - `contract-vue.ts`
  - `contract-react.ts`
  - `contract-astro.ts`
  - `state-dependency.ts`
- [x] Pemecahan `src/engine/tree.ts` ke dalam direktori `src/engine/graph/`:
  - `downward-traversal.ts`
  - `upward-traversal.ts`
  - `props-drilling.ts`
  - `context-analyzer.ts`
- [x] Pemecahan `src/engine/database.ts` ke dalam direktori `src/engine/storage/`:
  - `schema.ts` (DDL, indices, migrations)
  - `delta-sync.ts` (`hashChecker`, disk mapping, atomic commit)
  - `state-storage.ts` (`queryStateImpact`, `findUnusedState`)
  - `blast-radius.ts` (CTE upward traversal queries)
- [x] Menjaga file asli (`contract.ts`, `tree.ts`, `database.ts`) sebagai barrel re-export murni tanpa merusak file pemanggil.

### Out-of-Scope
- [ ] Mengubah algoritma atau logika bisnis ekstraksi (hanya murni refactoring struktur file dan pemisahan fungsi).

---

## Spesifikasi Detail Pekerjaan

### 1. Struktur Target Baru

```
src/engine/
├── contract.ts               <-- [Facade / Re-export facade]
├── tree.ts                   <-- [Facade / Re-export facade]
├── database.ts               <-- [Facade / Re-export facade]
│
├── parsers/                  <-- [Domain: Ekstraksi AST per framework]
│   ├── contract-vue.ts
│   ├── contract-react.ts
│   ├── contract-astro.ts
│   └── state-dependency.ts
│
├── graph/                    <-- [Domain: Graf & Analisis Hierarki]
│   ├── downward-traversal.ts
│   ├── upward-traversal.ts
│   ├── props-drilling.ts
│   └── context-analyzer.ts
│
└── storage/                  <-- [Domain: SQLite Persistence & Queries]
    ├── schema.ts
    ├── delta-sync.ts
    ├── state-storage.ts
    └── blast-radius.ts
```

### 2. Urutan Pengerjaan Logis
1. **Fase 1 (Storage Partition):** Ekstrak `schema.ts` dan `state-storage.ts` dari `database.ts`. Uji test database.
2. **Fase 2 (Parsers Partition):** Ekstrak parser per-framework dari `contract.ts`. Uji test contract.
3. **Fase 3 (Graph Partition):** Ekstrak props drilling dan traversal logic dari `tree.ts`. Uji test tree.
4. **Fase 4 (Verification):** Jalankan seluruh suite test (`bun test`) dan typecheck (`tsc --noEmit`).

### 3. Dampak Terhadap Bagian Lain
- Nol breaking changes terhadap `src/tools/` atau file luar lainnya karena file asli tetap bertindak sebagai *public facade*.
- Waktu loading dan isolasi unit testing meningkat drastis.

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1: Modular Responsibility Separation**:
  - **Given**: File `contract.ts`, `tree.ts`, dan `database.ts` di-refactor.
  - **When**: Diperiksa ukuran file fisik masing-masing file hasil partisi.
  - **Then**: Tidak ada file baru yang melebihi batas 500 baris kode / 20 KB.

- [ ] **Scenario 2: Backward Compatibility Facade**:
  - **Given**: Tool `src/tools/find-code.ts` dan test suite mengimpor fungsi dari `../engine/database` atau `../engine/tree`.
  - **When**: Build (`bun run build`) dan typecheck (`bun run typecheck`) dijalankan.
  - **Then**: Proses kompilasi berhasil 100% tanpa ada error missing export atau broken import.

---

## Definition of Done (DoD) Checklist

- [x] Tiga god modules berhasil didekomposisi ke sub-modul ber-SRP jelas.
- [x] Facade re-export terpasang rapi pada file asal.
- [x] Struktur modular siap untuk typecheck dan testing.

---

## Provenance
- **Completion Commit**: (menunggu implementasi)
- **Anchors**:
  - `src/engine/contract.ts`
  - `src/engine/tree.ts`
  - `src/engine/database.ts`
