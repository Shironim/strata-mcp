# Brief: Strata-MCP Observability & Analytics Telemetry Engine

> **Kategori**: feature  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement
- **Konteks & Alasan**: `@dimassetoid/strata-mcp` membutuhkan sistem observabilitas tingkat produksi (*Production-Grade Observability*) yang tidak hanya mencatat kegagalan teknis, melainkan juga berfungsi sebagai **pipa telemetri analitik data penggunaan tools (*Tool & Agent Analytics*)**. Selama ini, eksekusi tool MCP tidak menyimpan rekaman histori ke disk dan tidak mengukur metrik efisiensi token, latensi parsing AST, maupun pola komponen yang sering diperiksa oleh AI Agent.
- **Tujuan Utama**:
  1. Mengimplementasikan **Dual-Sink Structured Logging**:
     - **Sink 1 (`process.stderr`)**: Stream real-time untuk pemantauan live MCP client tanpa mencemari stream `stdout` JSON-RPC.
     - **Sink 2 (`.strata/strata.log`)**: Persistent flight recorder berbasis format **JSON Lines (`.jsonl`)** dengan *file size rotation guard* (maksimal 2MB).
  2. Mengumpulkan **Metrik Telemetri Analitik** per pemanggilan tool:
     - *Token Density & Compression*: Ukuran output (`bytes_out`, `lines_out`, `items_found`) vs file mentah.
     - *Latency & Profiling*: Waktu eksekusi parsing AST & query SQLite (`duration_ms`), serta alert `slow_tool_execution` (> 250ms).
     - *Agent Interaction Heatmap*: Target komponen/file yang paling sering diteliti oleh AI Agent.
     - *Cache Efficiency*: Pelacakan `cache_hit` (apakah query diambil dari SQLite atau parsing ulang disk).
     - *Error Diagnostics*: Pelacakan kegagalan input argumen atau parsing error terstruktur.

---

## Scope & Boundaries
### In-Scope
- [ ] Pembuatan modul logger terstruktur [`src/engine/telemetry.ts`](src/engine/telemetry.ts) dengan dukungan dual-sink (`stderr` + `.strata/strata.log`) dan rotasi file otomatis.
- [ ] Penambahan schema event telemetri analitik:
  ```json
  {
    "timestamp": "ISO8601",
    "event": "tool_call_completed" | "tool_call_failed",
    "tool": "inspect_component | get_component_tree | find_code | trace_state | audit_frontend | get_routes | get_api_contracts | patch_plan",
    "duration_ms": 18,
    "cache_hit": true,
    "input": { "targetPath": "src/Button.vue" },
    "metrics": { "bytes_out": 450, "lines_out": 22, "items_found": 5 },
    "status": "success" | "error",
    "error": { "code": "...", "message": "...", "stack": "..." }
  }
  ```
- [ ] Instrumentasi handler `CallToolRequestSchema` pada [`src/mcp.ts`](src/mcp.ts) untuk mengukur metrik dan mengalirkan event ke telemetry engine.
- [ ] Penambahan unit test untuk memvalidasi rotasi berkas dan keutuhan format JSONL.

### Out-of-Scope
- Menggunakan SDK pihak ketiga yang berat (OpenTelemetry/Jaeger/Datadog) yang meningkatkan ukuran paket npm.
- Mengubah arsitektur internal AST parsing atau skema tabel `.strata/cache.db`.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Terlibat
1. `src/engine/telemetry.ts` (File Baru): Modul `StrataTelemetry` yang mengelola append JSONL ke `.strata/strata.log`, rotasi file (2MB limit), dan streaming ke `stderr`.
2. `src/mcp.ts` (L40-L75): Pembungkusan eksekusi tool MCP dengan telemetri analitik (timer, metrik output, error tracking).
3. `tests/mcp/observability.test.ts` (File Baru): Verifikasi keutuhan log JSONL, pengukuran latensi, dan keamanan stream `stdout`.

### 2. Line Range Mapping (Presisi Target)
- `src/mcp.ts:L40-L75`: Instrumentasi pemanggilan `tool.handler(args)` dengan `StrataTelemetry.recordToolCall(...)`.

### 3. Dimensi Analisis Data yang Dihasilkan
1. **Analisis Efisiensi Token**: Membuktikan penghematan token konteks agent dari formula `1 - (bytes_out / raw_file_bytes)`.
2. **Pola Komponen Populer (Component Heatmap)**: Mengetahui file UI yang paling sering diperiksa oleh agent.
3. **P95 Latensi Eksekusi**: Mengidentifikasi titik lambat pada repositori besar.
4. **Cache Hit-Rate**: Menilai efektivitas invalidation delta-sync.
5. **Diagnostik Parameter Agent**: Mengetahui bila schema deskripsi tool perlu diperbaiki jika terjadi lonjakan error argumen.

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1 (Pencatatan Log Analitik Lengkap)**:
  - **Given**: Server MCP `strata-mcp` sedang berjalan.
  - **When**: Tool `inspect_component` selesai mengeksekusi inspeksi file.
  - **Then**: Satu baris JSONL baru tercatat di `.strata/strata.log` berisi atribut `duration_ms`, `metrics.bytes_out`, `metrics.lines_out`, `tool`, dan `status: "success"`.

- [ ] **Scenario 2 (Pencatatan Error Terstruktur)**:
  - **Given**: Sebuah tool mengalami exception saat dijalankan.
  - **When**: Error tertangkap oleh handler.
  - **Then**: Event `tool_call_failed` tercatat di `.strata/strata.log` dan `stderr` dengan menyertakan `error.message`, `error.stack`, dan parameter input yang bermasalah.

- [ ] **Scenario 3 (Proteksi Rotasi File Log)**:
  - **Given**: File log `.strata/strata.log` mencapai ukuran 2MB.
  - **When**: Event baru dicatat.
  - **Then**: File lama di-rotate menjadi `.strata/strata.log.1` dan file baru dimulai tanpa menyebabkan disk exhaustion.

---

## Definition of Done (DoD) Checklist
- [ ] Modul `StrataTelemetry` terimplementasi dan terintegrasi di `src/mcp.ts`.
- [ ] Berkas log `.strata/strata.log` terbentuk otomatis dan berformat JSONL murni.
- [ ] Unit test mencakup logging analitik dan rotasi log.
