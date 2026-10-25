/**
 * Agent harness templates for Strata-MCP.
 * Generated into .agents/ during `strata init`.
 */

export const STRATA_FRONTEND_RULE = `# RULE: Strata-MCP Frontend Structural Intelligence Engine

## 1. Directive & Core Mission
Prioritize using \`strata-mcp\` MCP tools over performing raw text searches (\`grep_search\`, \`find_by_name\`, or reading full files via \`view_file\`) when analyzing frontend architecture, UI components, and reactivity flows:
- **Vue Single File Components (\`.vue\`)**
- **React / Next.js (\`.tsx\`, \`.jsx\`, \`.ts\`, \`.js\`)**
- **Svelte 4 & Svelte 5 Runes (\`.svelte\`)**
- **Astro Islands (\`.astro\`)**

## 2. Tool Routing Matrix

| Frontend Scenario | Strata-MCP Tool | Advantage vs Raw File Reading |
|---|---|---|
| Investigating features, domains, or components | \`find_code(action: "map")\`, then \`inspect_component(view: "map")\` | Select files and regions from a bounded inventory without pulling full sources; fetch exact source slices only via hash-bound \`source_ref\`. |
| Inspecting props, emits, slots, exposed methods, and state | \`inspect_component\` | Delivers a concise public contract (10–30 lines) without flooding the context window with hundreds of template HTML lines. |
| Mapping component tree hierarchy or parent-child relations | \`get_component_tree\` | Instantly displays component topology (\`downward\`/\`down\` or \`upward\`/\`up\`), props drilling, and import dependencies. |
| Searching template structures, variable bindings, or expressions | \`find_code\` | AST structural pattern matching that is resilient against whitespace differences, line formatting, and local naming. |
| Tracing global/local reactive state flow (Pinia, Context, Zustand) | \`trace_state\` | Uncovers read/write blast radius (\`consumers\`, \`dependencies\`, \`both\`) across the entire application. |
| Extracting URL routes, route parameters, and layout hierarchies | \`audit_frontend(target: "routes")\` | Maps page sitemaps across Next.js, Nuxt, Astro, SvelteKit, and Inertia without reading dozens of page files. |
| Extracting backend API calls (Inertia, TanStack, Axios, fetch) | \`audit_frontend(target: "api-contracts")\` | Discovers endpoint URLs, HTTP methods, form payload fields, and \`backendTargetHint\` to backend controllers. |
| Auditing dead code, unused state, archetype drift, design tokens, or bundle | \`audit_frontend\` | Verifies architectural health and cleanliness (\`dead-components\`, \`dead-state\`, \`routes\`, \`similar-templates\`, \`design-tokens\`, \`bundle-health\`, \`api-contracts\`, \`archetype-drift\`, \`all\`). |
| Refactoring props, events, models, or slots across all consumers | \`generate_patch_plan\` | Produces prescriptive AST patch recommendations (\`rename_prop\`, \`remove_prop\`, \`rename_event\`, \`rename_model\`, \`rename_slot\`) without risks of manual regressions. |

## 3. Protocol & Execution Principles
- **Map First, Read Selectively:** Inventory scope using \`find_code(action: "map")\`, map selected files with \`inspect_component(view: "map")\`, then copy the returned \`source_ref\` for \`view: "source"\`. Never construct line numbers or byte offsets manually.
- **Evidence Boundaries:** Maps and ranges indicate source locations, not quality or correctness. Treat framework and path hints as candidates/conventions; verify parser diagnostics, status, and coverage before concluding findings.
- **No Blind Probing:** Never read component files from line 1 when you only need to inspect props, emits, or slots. Use \`inspect_component\`.
- **Pre-Refactor Verification:** Always verify upstream consumers with \`get_component_tree(direction: "upward")\` or \`generate_patch_plan\` before modifying component props, emits, v-models, or slots.
`;

export const STRATA_INSPECT_SKILL = `---
name: strata-inspect
description: Deep frontend AST component inspection, component trees, reactivity tracking, routes, API contracts, architectural health audits, and deterministic patch planning using strata-mcp.
---

# Skill: Strata Frontend Inspector (\`strata-inspect\`)

> Use this skill whenever you need to explore, analyze, debug, or refactor modern frontend architectures—including **Vue 3/SFC**, **React / Next.js (App & Pages Router, RSC)**, **Svelte 4 & Svelte 5 Runes**, and **Astro Islands**—without dumping raw UI templates into context.

---

## When to Use This Skill (Use-Case Scenarios)

1. **Exploring Unfamiliar Frontend Codebases & Feature Architectures:**
   - Instead of scanning directories blindly or reading full page files, use \`find_code(action: "map")\` to get a bounded inventory with domain classifications (Feature-Sliced Design layers, DDD bounded contexts, monorepo packages).
   - Inspect public component contracts (props, emits, slots, exposed methods) via \`inspect_component\` in 15–30 lines instead of 500 lines of template markup.

2. **Refactoring Component Interfaces (Props, Emits, Models, Slots):**
   - Before renaming or removing a prop or event, calculate the exact blast radius across all parent consumers using \`get_component_tree(direction: "upward")\`.
   - Generate deterministic, prescriptive AST refactoring instructions across all consumers with \`generate_patch_plan(refactor_type: "rename_prop" | "remove_prop" | "rename_event" | "rename_model" | "rename_slot")\`.

3. **Verifying Reactivity & State Blast Radius:**
   - Map dependencies and downstream consumers of global/modular stores (Pinia, Zustand, React Context) via \`trace_state\`.
   - Audit broken event handler bindings, missing methods, or reactivity anti-patterns after editing a component using \`inspect_component(audit_events: true)\`.

4. **Auditing Meta-Framework Route Hierarchies & Layout Topologies:**
   - Extract URL route trees, dynamic route parameters, route groups, and nested layouts across Next.js (App Router conventions), Nuxt 3, SvelteKit (\`+page\`, \`+layout\`), and Astro using \`audit_frontend(target: "routes")\`.
   - Identify Page Archetype Drift (deviations from standard canonical layouts) using \`audit_frontend(target: "archetype-drift")\`.

5. **Mapping Network Calls & Backend API Contracts:**
   - Discover all client-side API requests (Inertia, TanStack Query, Axios, native fetch, server actions) and identify backend controller hints via \`audit_frontend(target: "api-contracts")\`.

6. **Cleaning Dead Code, Duplicate Templates, & Bundle Health:**
   - Detect unused components, unreferenced stores, duplicate template AST fragments, and rogue CSS design tokens using \`audit_frontend(target: "all")\` or specific targets (\`dead-components\`, \`dead-state\`, \`similar-templates\`, \`design-tokens\`, \`bundle-health\`).

7. **Targeted Symbol Extraction (Precision Slicing):**
   - Retrieve only the targeted function or method slice with verified line numbers and source hashes without reading the whole file using \`inspect_component(symbol: "...")\` or \`source_ref\`.

---

## Core Tool Reference & Execution Workflows

### 1. Component Contract & Symbol Slicing (\`inspect_component\`)
* **Extract Public Contract:**
  \`inspect_component(path: "src/components/ProductCard.vue")\`
  *Returns props (with types & defaults), emits, slots, models, and external state dependencies.*
* **Extract Focused Symbol / Function:**
  \`inspect_component(path: "src/components/ProductCard.vue", symbol: "handleCheckout")\`
* **Post-Edit Event & Reactivity Quality Gate:**
  \`inspect_component(path: "src/components/ProductCard.vue", audit_events: true)\`
* **Hash-Bound Source Slicing:**
  \`inspect_component(path: "src/components/ProductCard.vue", view: "source", source_ref: { ... })\`

### 2. Component Hierarchy & Dependency Trees (\`get_component_tree\`)
* **Downward Hierarchy (Props Drilling & Context Dependencies):**
  \`get_component_tree(path: "src/pages/Dashboard.tsx", direction: "downward")\`
* **Upward Traversal (Consumer Blast Radius):**
  \`get_component_tree(path: "src/components/Button.tsx", direction: "upward")\`
* **Route-Anchored Tree:**
  \`get_component_tree(route: "/dashboard", direction: "downward")\`

### 3. Structural AST Search & Map (\`find_code\`)
* **Bounded Frontend Inventory Mapping (Zero Raw File Dumps):**
  \`find_code(action: "map")\`
* **AST Structural Pattern Matching (Whitespace & Formatting Immune):**
  \`find_code(pattern: "<Button $PROPS>$$$CHILDREN</Button>")\`
* **Component Usage Search:**
  \`find_code(component: "ModalCard")\`
* **ast-grep YAML Rule Execution:**
  \`find_code(rule_yaml: "id: no-direct-store\\nlanguage: ts\\nrule:\\n  pattern: useStore.getState()")\`

### 4. Reactive State Flow & Blast Radius (\`trace_state\`)
* **Trace Store Read/Write Consumers:**
  \`trace_state(identifier: "useCartStore", depth: 2, direction: "both")\`
* **Trace State Impact Across Application:**
  \`trace_state(identifier: "cartItems", direction: "consumers")\`

### 5. Architectural Health & Route Auditing (\`audit_frontend\`)
* **Comprehensive Health Audit:**
  \`audit_frontend(target: "all")\`
* **File-Based Route Mapping:**
  \`audit_frontend(target: "routes")\`
* **Backend API Contract Extraction:**
  \`audit_frontend(target: "api-contracts")\`
* **Page Archetype Consistency:**
  \`audit_frontend(target: "archetype-drift")\`
* **Template Duplication & Dead State:**
  \`audit_frontend(target: "similar-templates")\`
  \`audit_frontend(target: "dead-components")\`
  \`audit_frontend(target: "dead-state")\`

### 6. Prescriptive Refactoring Patch Plans (\`generate_patch_plan\`)
* **Rename Prop Across All Consumers:**
  \`generate_patch_plan(path: "src/components/Badge.vue", refactor_type: "rename_prop", old_name: "label", new_name: "text")\`
* **Remove Deprecated Prop:**
  \`generate_patch_plan(path: "src/components/Badge.vue", refactor_type: "remove_prop", old_name: "isOutlined")\`
* **Refactor Models, Events, and Slots:**
  \`generate_patch_plan(path: "...", refactor_type: "rename_model", old_name: "value", new_name: "modelValue")\`
  \`generate_patch_plan(path: "...", refactor_type: "rename_event", old_name: "select", new_name: "change")\`
  \`generate_patch_plan(path: "...", refactor_type: "rename_slot", old_name: "header", new_name: "title")\`

---

## Execution Principles (Map First, Read Selectively)

1. **Map First:** Always start broad inquiries with \`find_code(action: "map")\` or \`audit_frontend(target: "routes")\` to understand the architecture before inspecting individual files.
2. **Never Blind-Probe:** Do not read raw component files from line 1 just to see their props or events. Call \`inspect_component\` for a clean public contract.
3. **Verify Blast Radius Before Mutation:** Always run \`get_component_tree(direction: "upward")\` or \`generate_patch_plan\` before touching shared component contracts.
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

export const STRATA_CLAUDE_COMMAND = `---
description: Deep frontend AST component inspection, component trees, reactivity tracking, routes, API contracts, architectural health audits, and deterministic patch planning using strata-mcp.
---

# /strata-inspect

Use \`strata-mcp\` tools for structural frontend intelligence rather than reading raw source files:
- Begin with \`find_code(action: "map")\` to survey files, then use \`inspect_component(view: "map")\` and \`view: "source"\` with the returned \`source_ref\`.
- \`inspect_component\`: Extract public component contracts (props, emits, slots) & slice functions with precision.
- \`get_component_tree\`: Map component hierarchies and props drilling (upward/downward).
- \`find_code\`: Search code patterns structurally using AST matching.
- \`trace_state\`: Trace reactive state reads and mutations (Pinia, Context, Zustand).
- \`audit_frontend\`: Audit routes, api-contracts, dead-components, bundle-health, and archetype-drift.
- \`generate_patch_plan\`: Plan deterministic AST refactoring patches across all consumers.
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
