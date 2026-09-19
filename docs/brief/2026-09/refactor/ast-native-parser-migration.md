# Brief: AST-Native Parser Migration (Eliminating Heuristic RegEx)

> **Kategori**: refactor  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement

- **Konteks & Alasan**:
  Saat ini beberapa fitur krusial pada deteksi relasi frontend di [`src/engine/tree.ts`](file:///home/shironim/Project/strata-mcp/src/engine/tree.ts) dan [`src/engine/contract.ts`](file:///home/shironim/Project/strata-mcp/src/engine/contract.ts) masih sangat bergantung pada Regular Expression (RegEx) manual:
  - `vueProvideRegex` & `vueInjectRegex`
  - `reactProviderRegex` & `reactUseContextRegex`
  - `staticPropRegex` & `boundPropRegex`
  - `dynamicJsxVarRegex` & `createElementPattern`
  RegEx memiliki kelemahan fundamental saat berhadapan dengan sintaks JavaScript/TypeScript modern: rentan gagal (*false negative* atau *false positive*) pada ekspresi multiline, destructuring assignment (`const { data, user: { id } } = props`), type cast (`as string`), comments di dalam arguments, atau token dinamis.
- **Tujuan Utama**:
  1. Mengganti seluruh parser regex pada deteksi boundary dan context dengan AST parser resmi: `@vue/compiler-dom` untuk Vue template dan AST-Grep / TypeScript compiler API untuk blok skrip JS/TS/JSX.
  2. Menjamin 100% akurasi ekstraksi provide/inject, React context, dan passed props tanpa terpengaruh gaya formatting kode sumber.

---

## Scope & Boundaries

### In-Scope
- [x] Refactoring fungsi `extractComponentContextNodes` di [`src/engine/tree.ts`](file:///home/shironim/Project/strata-mcp/src/engine/tree.ts) dari regex ke AST traversal (TypeScript AST untuk call expressions `provide(...)`, `inject(...)`, `useContext(...)`, dan JSX parser untuk `<Context.Provider>`).
- [x] Refactoring fungsi `extractRenderedPassedProps` di [`src/engine/tree.ts`](file:///home/shironim/Project/strata-mcp/src/engine/tree.ts) menggunakan `@vue/compiler-dom` AST node traversal alih-alih `staticPropRegex` / `boundPropRegex`.
- [x] Refactoring deteksi dynamic component `<component :is="...">` dan dictionary lookup di [`src/engine/tree.ts`](file:///home/shironim/Project/strata-mcp/src/engine/tree.ts) menggunakan AST matcher.

### Out-of-Scope
- [ ] Perubahan arsitektur penyimpanan database (telah ditangani di brief `sqlite-graph-closure-and-downward-tree.md`).
- [ ] Penambahan bahasa baru di luar framework yang didukung (Vue, Astro, React/JSX).

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Diubah & Target Line Range

1. **[`src/engine/tree.ts`](file:///home/shironim/Project/strata-mcp/src/engine/tree.ts)** (`L70-L225`, `L580-L656`):
   - **L70-L105** (`extractRenderedCustomTags`): Gunakan walker AST `@vue/compiler-dom` untuk menelusuri `NodeTypes.ELEMENT` daripada regex matching `<[A-Z]...`.
   - **L170-L225** (`extractRenderedPassedProps`): Gunakan `node.props` dari `@vue/compiler-dom` AST:
     - `NodeTypes.ATTRIBUTE`: menangani static attributes (prop biasa).
     - `NodeTypes.DIRECTIVE` (`v-bind` atau `:`): menangani ekspresi dinamis terikat.
   - **L580-L656** (`extractComponentContextNodes`):
     - Ganti regex dengan query AST-Grep untuk memindai pemanggilan fungsi `provide($KEY, $VAL)` dan `inject($KEY)`.
     - Gunakan parser JSX AST untuk memetakan `<$NAME.Provider value={$VAL}>`.

2. **[`src/engine/contract.ts`](file:///home/shironim/Project/strata-mcp/src/engine/contract.ts)** (`L250-L380`):
   - Standarisasi helper ekstraksi ekspresi agar seluruh pembacaan blok skrip mendelegasikan parsing ke `astgrep.ts` yang sudah ada, bukan membuat regex paralel.

### 2. Urutan Pengerjaan Logis
1. Buat unit test dengan edge-cases sintaks kompleks (multiline props, comment di dalam props, destructuring).
2. Refactor `extractRenderedPassedProps` menggunakan `@vue/compiler-dom`.
3. Refactor `extractComponentContextNodes` menggunakan `astgrep.ts`.
4. Jalankan pengujian perbandingan hasil (baseline vs AST-native) untuk memastikan zero regresi.

### 3. Dampak Terhadap Bagian Lain
- **Props Drilling Alert & Dangling Context Detection**: Menjadi jauh lebih tangguh dan akurat tanpa peringatan palsu (*false alerts*).

---

## Acceptance Criteria (Given-When-Then)

- [x] **Scenario 1: Ekstraksi Props Multiline & Dinamis**:
  - **Given**: Komponen Vue mem-passing props multiline dengan objek kompleks:
    ```vue
    <UserCard
      :profile="{
        id: user.id,
        role: 'admin'
      }"
      data-testid="user-card"
    />
    ```
  - **When**: `extractRenderedPassedProps` dijalankan pada file tersebut.
  - **Then**: Prop `profile` dan `data-testid` berhasil diekstrak dengan akurat tanpa terpotong oleh batas baris.

- [x] **Scenario 2: Ekstraksi Provide/Inject dengan Simbol TypeScript**:
  - **Given**: Komponen memanggil `provide(THEME_KEY, currentTheme)` di mana `THEME_KEY` adalah konstanta injection key.
  - **When**: `extractComponentContextNodes` dijalankan.
  - **Then**: AST matcher menangkap key `THEME_KEY` dan nilai `currentTheme` secara presisi.

---

## Definition of Done (DoD) Checklist

- [x] Seluruh regex kritis di `tree.ts` digantikan oleh AST parser resmi (@vue/compiler-dom dan TypeScript Compiler API).
- [x] Zero false-positives pada props multiline dan nested objects.
- [x] Seluruh suite unit test lulus (`tests/core/ast-native-parser.test.ts`).

---

## Provenance
- **Completion Commit**: Pending atomic commit
- **Anchors**:
  - `src/engine/tree.ts`
  - `tests/core/ast-native-parser.test.ts`
