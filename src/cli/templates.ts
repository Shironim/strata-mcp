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
| Memetakan hierarki pohon komponen atau relasi parent-child | \`get_component_tree\` | Menampilkan topologi komponen (\`downward\`/\`down\` atau \`upward\`/\`up\`), props drilling, dan import dependencies secara instan. |
| Mencari struktur template, binding variabel, atau ekspresi | \`find_code\` | AST structural pattern matching yang kebal terhadap perbedaan spasi, pemformatan baris, dan penamaan lokal. |
| Melacak alur perubahan state global/lokal (Pinia, Context, Zustand) | \`trace_state\` | Menemukan read/write blast radius (\`consumers\`, \`dependencies\`, \`both\`) state di seluruh aplikasi. |
| Menemukan seluruh URL routes, parameter rute, dan layout hierarchy | \`audit_frontend(target: "routes")\` | Memetakan sitemap halaman Next.js, Nuxt, Astro, dan Inertia tanpa membaca puluhan file pages. |
| Mengekstrak panggilan API backend (Inertia, TanStack, Axios, fetch) | \`audit_frontend(target: "api-contracts")\` | Mengetahui endpoint URL, HTTP method, field payload form, serta \`backendTargetHint\` ke controller backend. |
| Audit kode mati, dead state, archetype drift, design token, atau bundle | \`audit_frontend\` | Verifikasi kepatuhan dan kebersihan frontend (\`dead-components\`, \`dead-state\`, \`routes\`, \`similar-templates\`, \`design-tokens\`, \`bundle-health\`, \`api-contracts\`, \`archetype-drift\`, \`all\`). |
| Perencanaan refactoring prop/event/model/slot pada seluruh consumer | \`generate_patch_plan\` | Rekomendasi patch AST presisi (\`rename_prop\`, \`remove_prop\`, \`rename_event\`, \`rename_model\`, \`rename_slot\`) tanpa resiko regresi manual. |

## 3. Protocol & Execution Principles
- **No Blind Probing:** Jangan membaca komponen dari baris 1 jika hanya butuh mengetahui prop atau event emit. Gunakan \`inspect_component\`.
- **Pre-Refactor Verification:** Sebelum mengubah prop, emit, v-model, atau slot komponen, selalu periksa consumers menggunakan \`get_component_tree\` (\`direction: "upward"\`) atau \`generate_patch_plan\`.
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
     \`get_component_tree(path: "path/to/Page.tsx", direction: "downward")\`
   - Analisis blast radius (siapa saja parent/page yang mengimpor komponen ini):
     \`get_component_tree(path: "path/to/SharedButton.vue", direction: "upward")\`

3. **Pemetaan URL Routes & Layouts:**
   - Pindai topologi file-based routes (Next.js, Nuxt, Astro, Inertia):
     \`audit_frontend(path: ".", target: "routes", framework: "next-app", view: "summary")\`

4. **Ekstraksi Kontrak API Backend:**
   - Petakan seluruh panggilan network frontend (TanStack, Inertia, Axios, fetch):
     \`audit_frontend(path: ".", target: "api-contracts")\`

5. **Pelacakan Aliran State & Composables:**
   - Petakan consumer stores (Pinia, Zustand, Context):
     \`trace_state(identifier: "useCartStore", depth: 2, direction: "both")\`

6. **Audit Arsitektur Menyeluruh:**
   - Audit kesehatan frontend secara komprehensif atau terarah:
     \`audit_frontend(target: "all")\`
     Pilihan target: \`routes\`, \`dead-components\`, \`dead-state\`, \`similar-templates\`, \`design-tokens\`, \`bundle-health\`, \`api-contracts\`, \`archetype-drift\`.

7. **Perencanaan Refactoring Presisi (Patch Plan):**
   - Hasilkan rekomendasi patch AST deterministik di semua consumer (\`rename_prop\`, \`remove_prop\`, \`rename_event\`, \`rename_model\`, \`rename_slot\`):
     \`generate_patch_plan(path: "...", refactor_type: "rename_prop", old_name: "title", new_name: "headline")\`

8. **Pencarian AST Struktural:**
   - Temukan pola kode atau penggunaan komponen yang kebal terhadap variasi formatting:
     \`find_code(pattern: "<Button $PROPS>$$$CHILDREN</Button>")\`
`;

export const STRATA_POST_WRITE_HOOK = `#!/usr/bin/env bash
# Strata-MCP Post-Write Delta Sync Hook
# Automatically updates SQLite graph cache when frontend files are modified.

set -e

FILE_PATH="$1"
if [ -z "$FILE_PATH" ] && [ -n "$CLAUDE_FILE_PATH" ]; then
  FILE_PATH="$CLAUDE_FILE_PATH"
fi

if [ -z "$FILE_PATH" ]; then
  if [ ! -t 0 ]; then
    STDIN_DATA="$(cat)"
    if [ -n "$STDIN_DATA" ]; then
      if command -v node >/dev/null 2>&1; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | node -e '
let raw = "";
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    const p = data?.tool_input?.file_path || data?.tool_input?.path || data?.file_path || data?.path || "";
    if (p) process.stdout.write(String(p));
  } catch {}
});
' 2>/dev/null || true)"
      elif command -v bun >/dev/null 2>&1; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | bun -e '
const raw = await Bun.stdin.text();
try {
  const data = JSON.parse(raw);
  const p = data?.tool_input?.file_path || data?.tool_input?.path || data?.file_path || data?.path || "";
  if (p) process.stdout.write(String(p));
} catch {}
' 2>/dev/null || true)"
      elif command -v python3 >/dev/null 2>&1; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get("tool_input", {}) if isinstance(d, dict) else {}
    p = ti.get("file_path") or ti.get("path") or d.get("file_path") or d.get("path") or ""
    if p: sys.stdout.write(str(p))
except Exception: pass
' 2>/dev/null || true)"
      fi

      if [ -z "$FILE_PATH" ]; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | sed -n 's/.*"\(file_path\|path\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\\2/p' | head -n 1)"
      fi
    fi
  fi
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Determine workspace root from the hook script location (.agents/hooks/..)
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="\${STRATA_WORKSPACE_ROOT:-$(cd "$HOOK_DIR/../.." && pwd)}"

# Check if file has frontend extension
case "$FILE_PATH" in
  *.vue|*.astro|*.tsx|*.jsx|*.ts|*.js)
    if command -v strata >/dev/null 2>&1; then
      strata sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    elif command -v bun >/dev/null 2>&1 && [ -f "$WORKSPACE_ROOT/node_modules/.bin/strata" ]; then
      "$WORKSPACE_ROOT/node_modules/.bin/strata" sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    fi
    ;;
  *)
    # Not a frontend file, skip
    ;;
esac

exit 0
`;

export const STRATA_CURSOR_RULE = `---
description: Strata-MCP Frontend Structural Intelligence Engine
globs: **/*.{vue,tsx,jsx,astro,ts,js}
alwaysApply: false
---

` + STRATA_FRONTEND_RULE;

export const STRATA_CLAUDE_COMMAND = `---
description: Deep frontend AST component inspection, component trees, reactivity tracking, routes, API contracts, architectural health audits, and deterministic patch planning using strata-mcp.
---

# /strata-inspect

Gunakan tool \`strata-mcp\` untuk inspeksi struktural frontend daripada membaca file utuh:
- \`inspect_component\`: Kontrak publik komponen (props, emits, slots) & precision slicing fungsi.
- \`get_component_tree\`: Hierarki pohon komponen dan props drilling (upward/downward).
- \`find_code\`: Pencarian pola kode berbasis AST struktural.
- \`trace_state\`: Pelacakan mutasi dan pembacaan state (Pinia, Context, Zustand).
- \`audit_frontend\`: Audit routes, api-contracts, dead-components, bundle-health.
- \`generate_patch_plan\`: Perencanaan refactoring AST deterministik.
`;

export const STRATA_GOOSEHINTS = `# Strata-MCP Frontend Guidelines
Prioritaskan penggunaan tool MCP strata-mcp (inspect_component, get_component_tree, find_code, audit_frontend) daripada pembacaan file mentah saat menganalisis komponen UI (Vue, React/Next, Astro).
`;

export const STRATA_GEMINI_HOOKS = JSON.stringify(
  {
    'strata-autosync': {
      PostToolUse: [
        {
          matcher: 'replace_file_content|write_to_file',
          hooks: [
            {
              type: 'command',
              command: 'strata sync --json',
            },
          ],
        },
      ],
    },
  },
  null,
  2
) + '\n';
