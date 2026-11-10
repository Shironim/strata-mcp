# Logging pemanggilan tool Strata

Kontrak logging lokal untuk enam tool MCP. Owner implementasi: `src/engine/telemetry.ts`;
integrasi: `src/mcp.ts`; regresi: `tests/telemetry.test.ts`.

## Penilaian data yang masuk log

| Data | Keputusan dan kegunaan |
| --- | --- |
| Timestamp UTC, tool, status, durasi | Catat setiap pemanggilan yang mencapai dispatcher, termasuk handler error, worker exception, dan unknown tool. Durasi mengukur eksekusi internal sebelum logging, bukan latensi jaringan/client. |
| Action/view/target/direction/refactor_type | Normalisasi ke `action`, hanya jika nilainya terdaftar dalam enum schema tool. Mode yang tidak diberikan dan tidak punya default schema dapat absen. |
| Trace/session ID | Pertahankan ID yang diberikan caller, maksimal 64 karakter. Tidak membuat session ID atau menebak identitas pengguna. |
| Input | Maksimal 16 nama parameter; string menjadi `{bytes: N}`, nilai lain `{type: ...}`. Source, pola pencarian, path, dan nilai input tidak disalin mentah. |
| `metrics.bytes_out` | Jumlah byte UTF-8 semua blok teks hasil akhir. Tidak termasuk envelope dan structured content. |
| `metrics.lines_out` | Jumlah baris tiap blok teks, dijumlahkan. Teks kosong menyumbang nol; newline terakhir menghasilkan baris kosong. |
| `metrics.estimated_tokens` | `Math.round(bytes_out / 4)`. Perkiraan teks saja, bukan tokenizer/model usage atau total token structured content. |
| `metrics.response_bytes` | Byte UTF-8 serialisasi JSON objek hasil MCP, termasuk structured content; tidak termasuk framing JSON-RPC. Menggunakan hasil setelah `enforceResponseLimit`. |
| `bloat_alert` | `true` mulai 16 KiB `response_bytes`; dapat aktif walaupun teks pendek jika structured content besar. |
| `metrics.items_found` | Pertahankan ekstraksi yang sudah tersedia per tool. Dapat absen; tidak menganggap jumlah item sebagai jumlah seluruh node, coverage, atau relevansi. |
| Output digest | Default `preview_disabled`, atau `empty_output` jika tidak ada teks non-whitespace. `STRATA_LOG_PREVIEW=1` mengaktifkan cuplikan head/omission/tail maksimal 300 karakter setelah whitespace dirapikan. |
| Error | Code maksimal 64 karakter dan message maksimal 384 karakter (128 saat fallback budget log). Stack tidak disimpan. Pesan error tetap dapat memuat path atau potongan input dari upstream. |
| Full source/AST/output, stack, environment, credential | Tidak ditambahkan ke log. Preview opt-in dan error message perlu diperlakukan sebagai data proyek yang dapat sensitif. |

## Sink dan lifecycle

- Satu event JSON Lines per tool call pada `<workspace>/.strata/strata.log`; hanya jika `.strata/` sudah ada. Root mengikuti hasil worker, explicit root, session root hint, lalu cwd sebagai fallback.
- Tanpa metadata logging tambahan di respons MCP atau stdout. Stderr mengeluarkan satu warning dengan prioritas error, bloat, kemudian slow (`duration_ms >= 250`). Semua metrik tetap tersedia dalam event.
- File baru dibuat dengan mode `0600` (tetap mengikuti dukungan OS). File lama tidak diubah permission-nya.
- Rotasi dilakukan sebelum append akan melampaui 2 MiB; satu backup `.strata/strata.log.1` menggantikan backup sebelumnya. Jika rotasi gagal, append dilewati agar kegagalan rotasi tidak menyebabkan pertumbuhan tanpa batas.
- Logger mempertahankan I/O sinkron existing; tidak memerlukan flush saat shutdown. Kontrak ini tidak menjanjikan zero-latency, fsync durability, atau koordinasi rotasi beberapa proses pada root yang sama.
- Error serialisasi, stderr sinkron, dan filesystem tidak boleh menggagalkan respons tool. Jika stderr gagal secara sinkron, file sink tetap dicoba. Logging best-effort: event dapat hilang saat I/O gagal atau proses dihentikan.
- Scaffold `strata init` sudah menulis `.strata/` ke `.gitignore` dan `*` ke `.strata/.gitignore`; tidak diperlukan perubahan scaffold.
- Pemanggilan fungsi library/CLI langsung serta request yang ditolak SDK sebelum dispatcher tidak tercakup. Ringkasan `strata stats` membaca log aktif, tanpa menggabungkan `.1`.

## Pemantauan

```sh
tail -f .strata/strata.log
jq 'select(.bloat_alert == true) | {tool, action, metrics}' .strata/strata.log
jq 'select(.duration_ms >= 250) | {tool, action, duration_ms}' .strata/strata.log
jq 'select(.status == "error") | {tool, error}' .strata/strata.log
strata stats . --json
```

Atur `STRATA_LOG_PREVIEW=1` pada environment proses MCP server dan restart proses itu untuk mengaktifkan preview.
Build baru juga memerlukan restart client/server yang masih menjalankan artefak lama.

## Verifikasi

Regresi meliputi JSONL/UTF-8, metrik respons lengkap, ambang bloat tepat 16 KiB,
digest dan opt-in, rotasi dengan backup lama, isolasi kegagalan sink, serta pemanggilan
keenam tool lewat dispatcher berikut handler error, unknown tool, dan worker rejection.
Tes kompatibilitas mempertahankan masking input dan aturan tidak membuat `.strata/` otomatis.
Hasil tes, build, dan stdio lokal tidak membuktikan client MCP aktif telah memuat versi ini.

Hasil lokal 2026-11-04:

- **59 pass, 0 fail** pada `tests/telemetry.test.ts`, `tests/memory/telemetry.test.ts`,
  `tests/observability-stats.test.ts`, `tests/integration/mcp-server-protocol.test.ts`,
  `tests/mcp/root-boundaries.test.ts`, `tests/cli/init.test.ts`, dan `tests/cli/init-audit-fixes.test.ts`.
- `bun run typecheck` dan `bun run build` lulus.
- Smoke MCP stdio memakai SDK client dan `dist/mcp.js` pada workspace sementara:
  satu `find_code(action: map)` sukses dan satu unknown tool menghasilkan dua event;
  `response_bytes` cocok dengan hasil yang diterima client. Workspace sementara dihapus sesudah pemeriksaan.
- `git diff --check` lulus. Full suite, benchmark overhead, dan rotasi serentak lintas proses belum diuji.
