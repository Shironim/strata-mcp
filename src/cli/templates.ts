/**
 * Agent harness templates for Strata-MCP.
 * Generated into .agents/ during `strata init`.
 */
import { renderPlaybooksForSkill } from '../workflow-playbooks';

export const STRATA_FRONTEND_RULE = `# RULE: Strata-MCP Frontend Structural Intelligence Engine

## 1. Directive & Core Mission
Frontend templates interlace visual markup, design tokens, and domain logic. Use structural inspection to select interfaces, relationships or source regions relevant to the task. Prioritize using \`strata-mcp\` MCP tools over performing raw text searches (\`grep_search\`, \`find_by_name\`, or reading full files via \`view_file\`) when analyzing frontend architecture, UI components, and reactivity flows:
- **Vue Single File Components (\`.vue\`)**
- **React / Next.js (\`.tsx\`, \`.jsx\`, \`.ts\`, \`.js\`)**
- **Svelte 4 & Svelte 5 Runes (\`.svelte\`)**
- **Astro Islands (\`.astro\`)**

## 2. Tool Routing Matrix

| Frontend Scenario | Strata-MCP Tool | Advantage vs Raw File Reading |
|---|---|---|
| Investigating features, domains, or components | \`find_code(action: "map")\`, then \`inspect_component(view: "map")\` | Select files and regions from a bounded inventory without pulling full sources; fetch exact source slices only via hash-bound \`source_ref\`. |
| Inspecting props, emits, slots, exposed methods, and state | \`inspect_component\` | Returns a structural contract with evidence and limitations; request summary for an overview and full for primary details. |
| Mapping component tree hierarchy or parent-child relations | \`get_component_tree\` | Reports bounded component topology (\`downward\`/\`down\` or \`upward\`/\`up\`), props drilling, and import dependencies. |
| Searching template structures, variable bindings, or expressions | \`find_code\` | AST structural pattern matching that is resilient against whitespace differences, line formatting, and local naming. |
| Tracing global/local reactive state flow (Pinia, Context, Zustand) | \`trace_state\` | Finds static read/write candidates within the selected scope and capability (\`consumers\`, \`dependencies\`, \`both\`); review unresolved and excluded references. |
| Extracting URL routes, route parameters, and layout hierarchies | \`audit_frontend(target: "routes")\` | Maps page sitemaps across Next.js, Nuxt, Astro, SvelteKit, and Inertia without reading dozens of page files. |
| Extracting backend API calls (Inertia, TanStack, Axios, fetch) | \`audit_frontend(target: "api-contracts")\` | Discovers endpoint URLs, HTTP methods, form payload fields, and \`backendTargetHint\` to backend controllers. |
| Auditing unused components and state | \`audit_frontend\` | Reports static candidates (\`dead-components\`, \`dead-state\`); \`all\` also includes \`routes\` and \`api-contracts\`. Review scope and omissions before acting. |
| Refactoring props, events, models, or slots across discovered consumers | \`generate_patch_plan\` | Proposes supported static edits (\`rename_prop\`, \`remove_prop\`, \`rename_event\`, \`rename_model\`, \`rename_slot\`) with hashes; review coverage and preconditions, then verify the edited contract and run relevant application checks. |

## 3. Protocol & Execution Principles (Selective Context & Map First)
- **Map First, Read Selectively:** Inventory scope using \`find_code(action: "map")\`, map selected files with \`inspect_component(view: "map")\` or \`outline: true\` to inspect coordinates without source bodies, then copy the returned \`source_ref\` for \`view: "source"\`. Never construct line numbers or byte offsets manually.
- **Inspect Contracts Over Bodies:** When discovering component interfaces, prefer \`inspect_component(path)\` to examine public contracts (props, emits, slots, models, state dependencies, outbound APIs) rather than reading raw template files line-by-line.
- **Targeted Slicing:** When specific logic needs inspection or editing, extract only the targeted function slice via \`inspect_component(path, symbol: "...")\` or exact verified lines via \`inspect_component(path, source_range: { start_line, end_line })\`. Reserve full-file reading only for broad multi-region refactoring where the whole file text is indispensable.
- **Evidence Boundaries:** Maps and ranges indicate source locations, not quality or correctness. Treat framework and path hints as candidates/conventions; verify parser diagnostics, status, and coverage before concluding findings.
- **No Blind Probing:** Never read component files from line 1 when you only need to inspect props, emits, or slots. Use \`inspect_component\`.
- **Pre-Refactor Verification:** Always verify upstream consumers with \`get_component_tree(direction: "upward")\` or \`generate_patch_plan\` before modifying component props, emits, v-models, or slots. When \`generate_patch_plan\` flags \`DYNAMIC_PROP_SPREAD\`, verify the affected consumer manually.
- **Responsible Budget & Truncation:** When a symbol slice exceeds 50 lines or results hit \`max_results\`, respect the context guard notice and use the exact suggested continuation hint (e.g. \`source_range\`) rather than dumping unbounded text.
- **Layered Output:** Request \`response_detail: "summary"\` for counts and risk metadata, then repeat the request with \`response_detail: "full"\` for primary analysis. Exact source requires full; summary is not a continuation page.
- **Format Discipline (Text vs JSON):** Prefer default \`format: "text"\` for human-readable analysis; use JSON when the caller needs structured fields. Text MCP transport omits full structured content unless requested with \`include_structured: true\`. JSON requests retain structured content; review retrieval evidence and coverage separately.
- **Fullstack Handoff to Septum:** When \`inspect_component\` or \`audit_frontend(target: "api-contracts")\` reports an outbound HTTP API with \`backendTargetHint\` (e.g. \`POST /api/v1/cadets -> [Backend: CadetController@store]\`), hand off the hint directly to Septum (\`septum_slice\` or \`septum_symbol\`) rather than grep-searching backend controllers.
`;

export const USE_STRATA_SKILL_TEMPLATE = `---
name: use-strata
description: >-
  Route frontend component discovery, contract inspection, component hierarchy analysis, reactive state tracing, route auditing, and refactoring patch generation using strata-mcp (find_code, inspect_component, get_component_tree, trace_state, audit_frontend, generate_patch_plan). Use when exploring frontend codebases, inspecting component interfaces (props, events/emits, slots, models), extracting AST slices without template bloat, tracing store and state reactivity, assessing component hierarchies, or planning deterministic refactors across Vue, React, Svelte, and Astro.
---

# use-strata — Frontend AST Static Analysis & Component Routing

Strata provides Abstract Syntax Tree (AST) inspection, reactive state tracking, and component dependency graph analysis for frontend architectures across Vue, React/Next.js, Svelte, and Astro.

---

## 1. Core Architectural Principles & Rationale

### Component Interface Isolation vs. Template Ingestion
Frontend Single File Components (SFCs) and JSX files combine presentational markup (HTML/JSX), styles (CSS), reactive state, and business logic into single files.
- **Source Selection:** Reading template markup via \`read_file\` to locate a single method or prop definition includes source beyond the selected interface or method.
- **Interface Separation:** AST extraction isolates public component interfaces (props, emits/events, slots, two-way bindings) and discrete method implementations without ingesting template bodies.

### Static AST Analysis Boundaries vs. Dynamic Execution
- **Static Contract Scope:** AST analysis extracts supported import, prop and component-reference syntax; dynamic or unsupported inputs can remain unresolved.
- **Dynamic Prop Spreading:** Dynamic prop spreads (\`{...props}\`, \`v-bind="$attrs"\`), dynamic component tags (\`<component :is="...">\`), and ambient event buses escape static dependency graphs. When flagged as \`DYNAMIC_PROP_SPREAD\`, verify the affected consumer manually rather than assuming exhaustive static coverage.
- **Coordinate Determinism:** Anchor all claims and code edits to verified AST line coordinates (\`file:line\`) or hash-verified \`source_ref\` tokens. Never estimate line numbers from raw text.

### Consumer Impact & State Mutation Flow
- **Interface Stability:** Modifying props, emits, or slots without evaluating upstream parent consumers risks runtime regressions across multiple views.
- **Reactivity Flow:** Modifying shared stores or context providers (Pinia, Zustand, Redux, React Context) requires tracing both readers (subscribers) and mutators (actions/reducers) across the entire component tree.

---

## 2. Intent-to-Tool Routing Table

| Engineering Intent | Strata Tool Call | Primary Arguments | Operational Output & Scope |
|---|---|---|---|
| **Survey feature directory or component inventory** | \`find_code\` | \`action: "map"\`, \`path?: "..."\` | Bounded file inventory and component catalog without template bodies. |
| **Search code structurally across components** | \`find_code\` | \`pattern: "..."\`, \`mode?: "ast" \| "literal" \| "auto"\`, \`component?: "..."\`, \`prop_name?: "..."\` | Matches component usages, prop bindings, and structural AST or literal patterns. |
| **Inspect component public interface** | \`inspect_component\` | \`path: "..."\`, \`impact?: "summary" \| "full"\`, \`response_detail?: "summary" \| "full"\` | Public contract summary: props, emits, slots, models, outbound APIs, and per-prop impact risk. |
| **Map source regions or structural outline** | \`inspect_component\` | \`path: "..."\`, \`view: "map"\` or \`outline: true\` (\`sfc_sections?: true\`) | Hash-bound region map (\`source_ref\`), SFC block bounds, and symbol/callee outline without bodies. |
| **Extract targeted method or source slice** | \`inspect_component\` | \`path: "..."\`, \`symbol: "..."\` or \`source_range\` or \`view: "source", source_ref\` (\`expected_hash?\`) | Exact hash-verified slice or function AST slice with caller references. |
| **Analyze parent consumer hierarchy (Blast Radius)** | \`get_component_tree\` | \`path: "..."\`, \`direction: "upward"\` | Maps all parent views, pages, and components consuming this component. |
| **Inspect child component tree & prop drilling** | \`get_component_tree\` | \`path: "..."\` or \`route: "/..."\`, \`direction: "downward"\`, \`max_depth?: 3\` | Hierarchical descendant tree showing component nesting and deeply passed props. |
| **Trace reactive state flow & store mutations** | \`trace_state\` | \`identifier: "<storeOrState>"\`, \`direction: "both"\`, \`depth?: 2\` | Multi-hop readers (subscribers) and mutators (writers) across store/context boundaries. |
| **Audit URL routes & nested layout hierarchy** | \`audit_frontend\` | \`target: "routes"\` | Next.js, Nuxt, SvelteKit, and Astro route parameters, nested layouts, and page entrypoints. |
| **Audit outbound API calls & backend hints** | \`audit_frontend\` | \`target: "api-contracts"\` | Client-side HTTP/API calls mapped to backend controller endpoint hints. |
| **Audit unused components and state** | \`audit_frontend\` | \`target: "dead-components"\` or \`"dead-state"\` | Static candidates with scope and limitations; no automatic deletion. |
| **Generate deterministic refactoring patch plan** | \`generate_patch_plan\` | \`path: "..."\`, \`refactor_type: "rename_*\|remove_*"\`, \`old_name: "..."\`, \`new_name?: "..."\`, \`operations?: [...]\` | Deterministic multi-file patch plan for renaming/removing props, events, models, or slots. |

---

## 3. Decision Workflow

Follow this sequence during frontend development tasks:

\`\`\`
[1. Discovery & Interface Inspection]
  Need to locate components or map a feature area?
  ├── YES ──► Execute find_code(action: "map") or find_code(pattern: "...")
  └── NO  ──► Proceed to target component

  Need to check component props, emits, or API calls?
  └── ALWAYS ──► Execute inspect_component(path: "...")
                 Do not read full template markup to inspect interface parameters.
                 (Note: For page/container files without props/emits, default contract output is minimal—use outline: true or view: "map" next.)

[2. State Flow & Method Slicing]
  Need to inspect a specific method, computed property, or event handler?
  └── Execute inspect_component(path: "...", symbol: "...") for a bounded AST slice.

  Is shared state (store, context, signal) involved?
  └── Execute trace_state(identifier: "...", direction: "both") to identify all readers and mutators.

[3. Impact Analysis & Refactoring]
  Renaming or removing a prop, event, slot, or v-model?
  ├── Step 1 ──► Execute get_component_tree(path: "...", direction: "upward")
  └── Step 2 ──► Execute generate_patch_plan(path: "...", refactor_type: "...", old_name: "...", new_name: "...")
                 Verify all dynamic spread sites flagged with DYNAMIC_PROP_SPREAD.

[4. Implementation & Post-Edit Audit]
  Apply targeted, minimal source edits.
  └── Execute inspect_component(path: "...", audit_events: true) to confirm template bindings and emits remain intact.
\`\`\`

### Canonical Workflow Playbooks
${renderPlaybooksForSkill()}

---

## 4. Operational Boundaries & Budget Discipline

1. **AST Slicing Limits:**
   - If an AST method slice exceeds 50 lines, Strata returns a continuation notice with a recommended \`source_range\` hint. Use the specified range rather than dumping unconstrained text.
2. **Dynamic Spread Verification:**
   - Props passed via object spread (\`{...props}\` or \`v-bind="$attrs"\`) cannot be fully verified via static AST. Manually inspect flagged consumers to ensure prop contract compliance.
3. **Template Event Verification:**
   - After modifying template event bindings, run \`inspect_component(path: "...", audit_events: true)\` to verify that handler references remain valid.
4. **Response Format (Text vs JSON):**
   - Use default \`format: "text"\` for human-readable queries (component contracts, outlines, trees, state tracing). Text responses present the selected analysis; JSON exposes structured fields.
   - Use \`format: "json"\` primarily for automated patch planning (\`generate_patch_plan\`). JSON responses include \`structuredContent\`.
5. **Fullstack Bridge (Strata &rarr; Septum):**
   - When outbound APIs disclose \`backendTargetHint\`, hand off the hint directly to Septum (\`septum_slice\` or \`septum_symbol\`) as candidate symbols for independent backend inspection; verify actual routes and declarations.
6. **E2E Selectors & Exact DOM Markup:**
   - Default \`inspect_component\` contract mode abstracts away raw HTML attributes (\`#id\`, exact validation strings, full DOM structure). For Playwright E2E selectors or exact template copy, use \`find_code(mode: "literal", ...)\` or targeted \`inspect_component(view: "source", source_ref: ...)\` / \`source_range\` slices.
`;

export const STRATA_INSPECT_SKILL = USE_STRATA_SKILL_TEMPLATE;

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
  *.vue|*.astro|*.svelte|*.tsx|*.jsx|*.ts|*.js)
    if command -v strata >/dev/null 2>&1; then
      strata sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    elif command -v bun >/dev/null 2>&1 && [ -f "$WORKSPACE_ROOT/node_modules/.bin/strata" ]; then
      "$WORKSPACE_ROOT/node_modules/.bin/strata" sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    elif command -v npx >/dev/null 2>&1; then
      npx --no-install strata sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    elif command -v bunx >/dev/null 2>&1; then
      bunx strata sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    fi
    ;;
  *)
    # Not a frontend file, skip
    ;;
esac

exit 0
`;

export const USE_STRATA_CLAUDE_COMMAND = `---
description: Deep frontend AST component inspection, component trees, reactivity tracking, routes, API contracts, architectural health audits, and deterministic patch planning using strata-mcp.
---

# /use-strata

Use \`strata-mcp\` tools for structural frontend intelligence rather than reading raw source files:
- **Map & Survey:** Begin with \`find_code(action: "map")\` to survey files, then use \`inspect_component(view: "map")\` or \`outline: true\` and \`view: "source"\` with the returned \`source_ref\`.
- **Component Contracts:** \`inspect_component\` extracts public contracts (props, emits, slots, models) & slices targeted functions without template bloat.
- **Hierarchy & Blast Radius:** \`get_component_tree\` maps component hierarchies, props drilling, and upstream page consumers (upward/downward).
- **Structural Code Search:** \`find_code\` matches code patterns and component usages structurally using AST matching.
- **Reactivity Flow:** \`trace_state\` traces reactive state readers and mutators across store/context boundaries (Pinia, Context, Zustand).
- **Architectural Health:** \`audit_frontend\` maps URL routes, api-contracts, and audits unused component/state candidates.
- **Prescriptive Patching:** \`generate_patch_plan\` dry-runs hash-bound patches for renaming/removing props, events, models, and slots; flags \`DYNAMIC_PROP_SPREAD\` for review.
`;

export const STRATA_CLAUDE_COMMAND = USE_STRATA_CLAUDE_COMMAND;

export const STRATA_TS_RULE = `# RULE: Strata-MCP TypeScript / JavaScript Structural Intelligence Engine

## Directive & Tool Routing (Map First, Read Selectively)
Prioritize \`strata-mcp\` tools (\`find_code\`, \`inspect_component\`) over reading whole TypeScript/JavaScript files sequentially:
- **Survey Workspace Inventory:** Call \`find_code(action: "map", path: "...")\` to map files and review any excluded directories before broad scans.
- **Structural & Literal Search:** Call \`find_code(pattern: "...", mode: "ast" | "literal" | "auto", path: "...")\` for AST patterns or exact case-sensitive literal line search.
- **Module Outlines & 1-Hop Callees:** Call \`inspect_component(path, outline: true)\` to list functions, classes, methods, interfaces, types, enums, and exported constants with exact line ranges and cross-file callee coordinates.
- **Map & Hash-Verified Slicing:** Call \`inspect_component(path, view: "map")\` to get UTF-16 offsets and SHA-256, then pass \`source_ref\` to \`inspect_component(path, view: "source", source_ref: ...)\` — or request \`inspect_component(path, symbol: "...")\` / \`source_range: { start_line, end_line }\`.
- **Outbound HTTP Calls:** When auditing HTTP client calls, use \`audit_frontend(target: "api-contracts", path: "...")\`.
- **Response & Evidence Discipline:** Prefer default \`format: "text"\`. Never guess truncated slices or ignore \`Decision: partial\` / excluded-directory notes.
`;

export const USE_STRATA_TS_SKILL_TEMPLATE = `---
name: use-strata
description: >-
  Route TypeScript/JavaScript file inventory, symbol outlines, 1-hop callee tracing, AST/literal code search, and hash-verified slicing using strata-mcp (find_code, inspect_component, audit_frontend). Use when exploring TS/JS modules without dumping entire files into context.
---

# use-strata — TypeScript / JavaScript AST Navigation & Slicing

## Intent-to-Tool Routing Table

| Intent | Tool Call | Canonical Arguments | Output |
|---|---|---|---|
| **Map repository files** | \`find_code\` | \`action: "map"\`, \`path?: "..."\`, \`limit?\`, \`offset?\` | Bounded file inventory plus excluded directory report. |
| **AST pattern or literal search** | \`find_code\` | \`pattern: "..."\`, \`mode: "ast" \| "literal" \| "auto"\`, \`path?: "..."\` | Exact line/column matches without reading full files. |
| **Module symbol outline & 1-hop callees** | \`inspect_component\` | \`path: "..."\`, \`outline: true\` | Functions, classes, methods, interfaces, types, enums, exported constants, and callee line bounds. |
| **Map top-level spans & source_ref** | \`inspect_component\` | \`path: "..."\`, \`view: "map"\` | Top-level declaration coordinates with SHA-256 and UTF-16 byte offsets. |
| **Read targeted symbol or lines** | \`inspect_component\` | \`path: "..."\`, \`symbol: "..."\` or \`source_range: { start_line, end_line }\` or \`view: "source", source_ref\` | Bounded, hash-verified source slice in compact text mode. |
| **Discover outbound HTTP calls** | \`audit_frontend\` | \`target: "api-contracts"\`, \`path?: "..."\` | Static \`fetch\` / Axios / HTTP call inventory. |

## Discipline
- Always start with \`find_code(action: "map")\` or \`inspect_component(path, outline: true)\` / \`view: "map"\` before slicing.
- Keep default \`format: "text"\` for interactive analysis; escalate to \`source_range\` continuation hints if a slice hits budget limits.
`;

export const STRATA_TS_SKILL = USE_STRATA_TS_SKILL_TEMPLATE;

export const STRATA_TS_CLAUDE_COMMAND = `---
description: TypeScript/JavaScript AST file inventory, symbol outlines, 1-hop callee tracing, AST/literal search, and hash-verified slicing via strata-mcp.
---

# /use-strata

Use \`strata-mcp\` tools (\`find_code\`, \`inspect_component\`, \`audit_frontend\`) instead of reading full TS/JS files:
- \`find_code(action: "map", path: "...")\` — file inventory with exclusion reporting.
- \`find_code(pattern: "...", mode: "ast" | "literal", path: "...")\` — AST or exact literal search.
- \`inspect_component(path, outline: true)\` / \`view: "map"\` — declarations, interfaces, constants, line bounds, and 1-hop callees.
- \`inspect_component(path, symbol: "..." | source_range | view: "source", source_ref)\` — bounded, hash-verified source slices.
`;

export const STRATA_GEMINI_MD_POINTER = `# strata-mcp Workspace Guidance

Strata-MCP workspace rules are configured in \`.gemini/rules/strata-frontend.md\`. Follow those rules before reading full source files.
`;

export const STRATA_RULE_REFERENCE_FROM_AGENTS = `# RULE: strata-mcp Workspace Reference

The canonical \`strata-mcp\` rules for this workspace are already defined in \`AGENTS.md\` (use \`find_code(action: "map")\`, \`inspect_component(view: "map" | outline: true | symbol | source_range)\`, and \`view: "source"\` with \`source_ref\` before reading whole files).
`;

export const STRATA_RULE_REFERENCE_FROM_GEMINI = `# RULE: strata-mcp Workspace Reference

The canonical \`strata-mcp\` rules for this workspace are already defined in \`GEMINI.md\` (use \`find_code(action: "map")\`, \`inspect_component(view: "map" | outline: true | symbol | source_range)\`, and \`view: "source"\` with \`source_ref\` before reading whole files).
`;

export const STRATA_GEMINI_HOOKS = JSON.stringify(
  {
    'strata-autosync': {
      PostToolUse: [
        {
          matcher: 'edit_file|write_file|replace_file_content|write_to_file',
          hooks: [
            {
              type: 'command',
              command:
                "sh -c 'ROOT=\".\"; if [ ! -f \"$ROOT/.gemini/hooks/strata-post-write.sh\" ] && [ ! -f \"$ROOT/.agents/hooks/strata-post-write.sh\" ]; then ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; fi; if [ -f \"$ROOT/.gemini/hooks/strata-post-write.sh\" ]; then exec \"$ROOT/.gemini/hooks/strata-post-write.sh\" \"$@\"; elif [ -f \"$ROOT/.agents/hooks/strata-post-write.sh\" ]; then exec \"$ROOT/.agents/hooks/strata-post-write.sh\" \"$@\"; else strata sync --json 2>/dev/null || true; fi'",
            },
          ],
        },
      ],
    },
  },
  null,
  2
) + '\n';
