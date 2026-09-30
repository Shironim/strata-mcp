# Brief: Bidirectional Data Transport Engine & Fullstack API Stitching Bridge

> **Kategori**: feature  
> **Status**: Completed  
> **Tanggal**: 2026-09-30  
> **Versi Target**: 0.7.7  

---

## 1. Overview & Problem Statement

### Masalah 1: Ketiadaan Jembatan Antara Frontend AST dan Backend DDD
Sebelumnya, strata-mcp mampu mengekstrak endpoint outbound melalui \`get_api_contracts\` (misal: \`POST /api/v1/checkout\`). Namun, output tersebut tidak memiliki konteks arsitektural backend. Akibatnya, AI Agent terpaksa melakukan pencarian coba-ulang (*trial-and-error search*) di backend untuk menemukan file Controller/Action terkait, merusak efisiensi konteks dan melanggar prinsip *Minimal Sufficient Evidence (MSE)*.

### Masalah 2: Kerentanan Silang Transportasi Data Frontend-Backend (Chasm Data)
Dalam pengembangan aplikasi modern (Vue SFC, React/Next, Nuxt, Astro, Inertia), kegagalan komunikasi client-server paling sering bersumber dari celah kontrak data:
1. **Egress Hazards**: Casing payload tidak konsisten (\`mixed\` camelCase dan snake_case), multipart \`FormData\` yang gagal memuat nested object (\`[object Object]\`), serta input angka yang mengirimkan empty string (\`""\`) alih-alih \`null\` memicu error validasi 422.
2. **Ingress Traps**: Crash runtime seperti *"props.users.map is not a function"* karena backend mengembalikan pagination envelope (\`users.data\`), serta akses bersarang tanpa *optional chaining* (\`?.\`).
3. **422 Silent Failures**: Field payload dikirimkan oleh komponen, tetapi jika validasi backend menolak, komponen UI tidak memiliki binding error (\`form.errors.x\`) sehingga user/agent mengalami kegagalan tak terlihat (*silent rejection*).
4. **Dangling Cache Mutations**: Mutasi POST/PUT/DELETE dieksekusi tanpa memicu invalidasi cache TanStack Query / SWR / Inertia reload, menghasilkan stale data visual.

### Masalah 3: Kebutuhan Observabilitas Telemetri
Eksekusi tool MCP membutuhkan alat inspeksi metrik bawaan untuk mengukur latensi (p50/p95), error rate, dan item data yang diekstrak.

---

## 2. Architectural Deliverables

### A. Fullstack API Stitching Bridge (\`src/engine/api-contract.ts\`)
- **\`synthesizeBackendTargetHint(endpoint, method)\`**:
  - Melakukan normalisasi parameter REST (\`/api/users/:id\`).
  - Resolusi rute Ziggy/Inertia (\`route('checkout.store')\`).
  - Menghasilkan kandidat `controllerHint` (misal: `CheckoutController`, `UserController`) dan `actionHint` (`store`, `index`, `show`, `destroy`).
  - Menyediakan `targetIntent` (dan alias kompatibilitas) yang siap dikonsumsi langsung oleh downstream AI Agent, language server, atau tracer vertical slice backend tanpa pencarian berulang.

### B. Conditional Layout & Dynamic Style Extractor (\`src/engine/layout-extractor.ts\`)
- Mengurai template AST Vue SFC (\`@vue/compiler-dom\`), JSX React, dan Astro.
- Mengekstrak token layout murni (Tailwind \`flex\`, \`grid\`, \`max-w-*\`, \`z-*\`, dsb.).
- Mengekstrak binding dinamis \`:class="{ active: isActive }"\` dan direktif kondisional visibilitas (\`v-if\`, \`v-show\`, \`ternary\`).
- Mengeliminasi 100% kebutuhan membuka file template mentah untuk diagnosa layout.

### C. Bidirectional Data Transport Contract Analyzer (\`src/engine/transport-analyzer.ts\`)
- **Egress Scanner**: Analisis casing (\`detectKeyCasing\`), serialization format (\`json\`, \`multipart/form-data\`, \`query-params\`), dan deteksi risiko serialisasi.
- **Ingress Scanner**: Inferensi bentuk prop (\`paginated-collection\`, \`array\`, \`entity-object\`), deteksi **CRITICAL Pagination Trap** (\`users.map\` vs \`users.data\`), dan pengecekan guarded nullability.
- **Validation Schema Extractor**: Parsing skema Zod (\`z.object\`) dan TypeScript interface (\`...Payload\`, \`...DTO\`) beserta batasan field-nya.
- **Error Handling Audit**: Memetakan \`boundErrorFields\` terhadap \`payloadKeys\` mutasi untuk mendeteksi field yang berisiko mengalami *unhandled 422 failure*.
- **Invalidation Graph Extractor**: Pelacakan lifecycle \`mutation\` ➔ \`invalidation\` ➔ \`query\` pada TanStack Query (\`invalidateQueries\`), SWR (\`mutate\`), dan Inertia (\`router.reload\`).

### D. Observability Tooling & CLI Flight Recorder (`src/engine/telemetry.ts` & `src/cli.ts`)
- Flight recorder \`.strata/strata.log\` mencatat metrik telemetri runtime secara transparan (p50/p95 duration, slow calls, total items found, error diagnostics).
- Menyediakan CLI command: \`strata stats [path]\` untuk developer tanpa membebani context window AI Agent dengan tool MCP redundan (menjaga MCP surface tetap ramping pada 8 Core Tools).

---

## 3. Verification & Test Evidence

Seluruh fungsionalitas diverifikasi dengan test suite mandiri:
1. \`tests/fullstack-bridge-and-layout.test.ts\` (7 passing tests)
2. \`tests/observability-stats.test.ts\` (4 passing tests)
3. \`tests/bidirectional-transport.test.ts\` (6 passing tests)
4. \`tests/mcp/server.test.ts\` (8 registered Core MCP tools verified)

Total regresi: **257 pass, 0 fail across 46 test files**.
