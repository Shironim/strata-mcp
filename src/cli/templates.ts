/**
 * Agent harness templates for Strata-MCP.
 * Generated into .agents/ during `strata init`.
 */

export const STRATA_FRONTEND_RULE = `# RULE: Strata-MCP Frontend Structural Intelligence Engine

## 1. Directive & Core Mission
Prioritaskan penggunaan tool MCP \`strata-mcp\` daripada melakukan pencarian teks mentah (\`grep_search\`, \`find_by_name\`, atau membaca file utuh \`view_file\`) saat menganalisis arsitektur frontend, komponen antarmuka, dan aliran reaktivitas:
- **Vue Single File Components (\`.vue\`)**
- **React / Next.js (\`.tsx\`, \`.jsx\`, \`.ts\`, \`.js\`)**
- **Astro Islands (\`.astro\`)**

## 2. Tool Routing Matrix

| Skenario Frontend | Tool Strata-MCP | Keuntungan vs Pembacaan File Mentah |
|---|---|---|
| Memahami props, emits, slots, exposed methods, dan state komponen | \`inspect_component\` | Menghasilkan kontrak publik ringkas (10-30 baris) tanpa membanjiri konteks dengan ratusan baris template HTML. |
| Memetakan hierarki pohon komponen atau relasi parent-child | \`get_component_tree\` | Menampilkan topologi komponen, props drilling, dan import dependencies secara instan. |
| Mencari struktur template, binding variabel, atau ekspresi | \`find_code\` | AST structural pattern matching yang kebal terhadap perbedaan spasi, pemformatan baris, dan penamaan lokal. |
| Melacak alur perubahan state global/lokal (Pinia, Context, Zustand) | \`trace_state\` | Menemukan read/write blast radius state di seluruh aplikasi. |
| Menemukan seluruh URL routes, parameter rute, dan layout hierarchy | \`get_routes\` | Memetakan sitemap halaman Next.js, Nuxt, Astro, dan Inertia tanpa membaca puluhan file pages. |
| Mengekstrak panggilan API backend (Inertia, TanStack, Axios, fetch) | \`get_api_contracts\` | Mengetahui endpoint URL, HTTP method, dan field payload form yang dikirim ke backend. |
| Audit kode mati, dead state, atau komponen tak terpakai | \`audit_frontend\` | Verifikasi kepatuhan dan kebersihan frontend secara deterministik. |
| Perencanaan refactoring prop/komponen pada seluruh consumer | \`generate_patch_plan\` | Rekomendasi patch AST presisi (file, baris, kolom, replacement) tanpa resiko regresi manual. |

## 3. Protocol & Execution Principles
- **No Blind Probing:** Jangan membaca komponen dari baris 1 jika hanya butuh mengetahui prop atau event emit. Gunakan \`inspect_component\`.
- **Pre-Refactor Verification:** Sebelum mengubah prop atau emit komponen, selalu periksa consumers menggunakan \`get_component_tree\` atau perintah \`strata patch-plan\`.
`;

export const STRATA_INSPECT_SKILL = `---
name: strata-inspect
description: Deep frontend AST component inspection, component trees, reactivity tracking, routes, API contracts, architectural health audits, and deterministic patch planning using strata-mcp.
---

# Skill: Strata Frontend Inspector (\`strata-inspect\`)

> Gunakan skill ini saat perlu menganalisis arsitektur frontend (Vue, React/Next.js, Astro), memvalidasi prop/emit contracts, memetakan rute & API backend, melacak reaktivitas state, atau mengaudit kesehatan kode tanpa membaca seluruh file UI secara mentah.

## Core Capabilities & Workflows

1. **Pemeriksaan Kontrak Komponen & Precision Slicing:**
   - Ambil props, emits, slots, dan models publik:
     \`inspect_component(path: "path/to/Component.vue")\`
   - Iris fungsi/simbol spesifik dengan nomor baris presisi tanpa membaca seluruh file:
     \`inspect_component(path: "...", symbol: "handleAction")\`
   - Quality gate pasca-edit (broken template handlers & reactivity smells):
     \`inspect_component(path: "...", audit_events: true)\`

2. **Hierarki Pohon UI & Blast Radius:**
   - Petakan hierarki child components & props drilling:
     \`get_component_tree(entry_path: "path/to/Page.tsx", direction: "downward")\`
   - Analisis blast radius (siapa saja parent/page yang mengimpor komponen ini):
     \`get_component_tree(entry_path: "path/to/SharedButton.vue", direction: "upward")\`

3. **Pemetaan URL Routes & Layouts:**
   - Pindai topologi file-based routes (Next.js, Nuxt, Astro, Inertia):
     \`get_routes(targetPath: ".", framework: "next-app")\`

4. **Ekstraksi Kontrak API Backend:**
   - Petakan seluruh panggilan network frontend (TanStack, Inertia, Axios, fetch):
     \`get_api_contracts(targetPath: ".")\`

5. **Pelacakan Aliran State & Composables:**
   - Petakan consumer stores (Pinia, Zustand, Context):
     \`trace_state(identifier: "useCartStore", depth: 2)\`

6. **Audit Arsitektur Menyeluruh:**
   - Audit kesehatan frontend secara komprehensif atau terarah:
     \`audit_frontend(target: "all")\`
     Pilihan target: \`routes\`, \`dead-components\`, \`dead-state\`, \`similar-templates\`, \`design-tokens\`, \`bundle-health\`, \`api-contracts\`.

7. **Perencanaan Refactoring Presisi (Patch Plan):**
   - Hasilkan rekomendasi patch AST deterministik di semua consumer:
     \`generate_patch_plan(component_path: "...", refactor_type: "rename_prop", old_name: "title", new_name: "headline")\`

8. **Pencarian AST Struktural:**
   - Temukan pola kode atau penggunaan komponen yang kebal terhadap variasi formatting:
     \`find_code(pattern: "<Button $PROPS>$$$CHILDREN</Button>")\`
`;

export const STRATA_POST_WRITE_HOOK = `#!/usr/bin/env bash
# Strata-MCP Post-Write Delta Sync Hook
# Automatically updates SQLite graph cache when frontend files are modified.

set -e

FILE_PATH="$1"

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Check if file has frontend extension
case "$FILE_PATH" in
  *.vue|*.astro|*.tsx|*.jsx|*.ts|*.js)
    if command -v strata >/dev/null 2>&1; then
      strata sync "$(dirname "$FILE_PATH")" --json >/dev/null 2>&1 || true
    elif command -v bun >/dev/null 2>&1 && [ -f "./node_modules/.bin/strata" ]; then
      ./node_modules/.bin/strata sync "$(dirname "$FILE_PATH")" --json >/dev/null 2>&1 || true
    fi
    ;;
  *)
    # Not a frontend file, skip
    ;;
esac

exit 0
`;
