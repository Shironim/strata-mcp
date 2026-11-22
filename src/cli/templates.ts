/**
 * Agent harness templates for Strata-MCP.
 * Generated into .agents/ during `strata init`.
 */
import { renderPlaybooksForSkill } from '../workflow-playbooks';

export const STRATA_FRONTEND_RULE = `# RULE: Strata-MCP Frontend Structural Intelligence Engine

## 1. Directive & Core Mission
Frontend templates interlace visual markup, design tokens, and domain logic. Use structural inspection to select interfaces, relationships or source regions relevant to the task. Prioritize using \`strata-mcp\` MCP tools over performing raw text searches (\`grep_search\`, \`find_by_name\`, or reading full files via \`view_file\`) when analyzing frontend architecture, UI components, and reactivity flows:
- **Vue Single File Components (\`.vue\`) / Nuxt**
- **React / Next.js (\`.tsx\`, \`.jsx\`, \`.ts\`, \`.js\`)**
- **Svelte 4 & Svelte 5 Runes (\`.svelte\`)**
- **Astro Islands (\`.astro\`)**

## 2. Canonical Tool Routing Matrix (V2)

| Frontend Scenario | Strata-MCP Tool | Advantage vs Raw File Reading |
|---|---|---|
| Orienting in workspace, packages, files, or static health | \`map_workspace(view: "overview" \\| "packages" \\| "files" \\| "health")\` | Returns package topology, frameworks, file inventory, or unused component candidates without reading file bodies. |
| Extracting URL routes, route params, layouts, and API handlers | \`map_workspace(view: "routes")\` | Maps page sitemaps and server APIs across Nuxt (including layers), Next.js, Astro, SvelteKit, and Inertia. |
| Inspecting props, emits, models, slots, outline, and HTTP boundaries | \`inspect_file\` | Returns TypeChecker-resolved contracts (\`props\`, \`emits\`, \`models\`, \`slots\`, \`renderedComponents\`), \`outline\`, \`imports\`, and \`outboundHttp\` with \`backendTargetHint\`. |
| Go to definition, references, call hierarchy, component tree, state flow, or impact | \`query_graph\` | Traverses SQLite v3 graph + TypeScript Language Service (\`definition\`, \`references\`, \`callHierarchy\`, \`componentTree\`, \`stateFlow\`, \`impact\`). |
| Searching symbols, template component usages, prop usages, or text | \`search_code\` | Bounded FTS5 + graph search across \`symbol\`, \`componentUsage\`, \`propUsage\`, and \`text\` modes returning hash-bound \`sourceRef\` handles. |
| Reading targeted symbol body, SFC block, or line range | \`read_slice\` | Reads bounded, hash-verified source slices via \`source_ref\`, \`symbol_id\`, or \`path\` + (\`symbol\` / \`block\` / \`lines\`). |

## 3. Protocol & Execution Principles (Selective Context & Map First)
- **Map First, Read Selectively:** Orient with \`map_workspace(view: "overview" | "routes")\`, inspect target files with \`inspect_file\`, and fetch exact code only via \`read_slice\` using returned \`sourceRef\` or \`symbolId\`. Never construct line numbers or byte offsets manually.
- **Inspect Contracts Over Bodies:** Prefer \`inspect_file(path, sections: ["outline", "contract", "boundaries"])\` before reading implementation bodies.
- **Pre-Refactor Verification:** Before modifying component props, emits, or models, check consumers with \`query_graph(query: "impact")\` and \`search_code(kind: "componentUsage" | "propUsage")\`. Always inspect every \`DYNAMIC_SPREAD\` omission manually.
- **Evidence & Diagnostics:** Verify \`verification\` tier (\`graph\`, \`semantic\`, \`syntax-fallback\`), \`omissions\`, and \`diagnostics\` before concluding empty results mean absence.
- **Budget Control:** Responses default to \`16384\` UTF-8 bytes. When \`BUDGET_RESPONSE_TOO_LARGE\` occurs, either narrow \`sections\`/\`limit\` or retry with a larger \`max_bytes\` matching \`retryMaxBytes\`.
- **Format Discipline (Text vs JSON):** Prefer default \`format: "text"\` for human-readable analysis; use \`format: "json"\` when structured fields are needed.
- **Fullstack Handoff to Septum:** When \`inspect_file(sections: ["boundaries"])\` reports an outbound HTTP API with \`backendTargetHint\`, hand off the hint directly to Septum (\`septum_slice\` or \`septum_symbol\`) rather than grep-searching backend handlers.
`;

export const USE_STRATA_SKILL_TEMPLATE = `---
name: use-strata
description: >-
  Route frontend and fullstack JS/TS codebase mapping, symbol/contract inspection, graph navigation (definition, references, call hierarchy, component tree, state flow, refactor impact), selective source slicing, and code search using strata-mcp (map_workspace, inspect_file, query_graph, read_slice, search_code) across Vue, Nuxt, React, Next.js, Svelte, and Astro in single-repo, monolith, fullstack, or monorepo workspaces.
---

# use-strata — Static and Semantic Code Analysis for Frontend & Fullstack JS/TS

Strata combines a persistent SQLite symbol graph with a lazily loaded, per-project TypeScript Language Service (with Virtual TSX projection for \`.vue\`, \`.svelte\`, and \`.astro\` SFCs) so AI agents navigate unfamiliar repositories with IDE-level precision.

---

## 1. Core Architectural Principles & Rationale

### Component Interface Isolation vs. Template Ingestion
Frontend Single File Components (SFCs) and JSX files combine presentational markup (HTML/JSX), styles (CSS), reactive state, and business logic into single files.
- **Source Selection:** Reading full files via \`read_file\` to locate a single method or prop definition pulls unrelated template markup into context.
- **Interface Separation:** \`inspect_file\` isolates public component contracts (props, emits, slots, models), outlines, outbound HTTP boundaries, and imports without ingesting implementation bodies.

### Static AST Analysis Boundaries vs. Dynamic Execution
- **Verification Tiers:** Check \`VERIFICATION: tier=graph|semantic|syntax-fallback\` in every response before assuming completeness.
- **Dynamic Prop Spreading:** Dynamic prop spreads (\`{...props}\`, \`v-bind="$attrs"\`), dynamic component tags (\`<component :is="...">\`), and ambient event buses escape static dependency graphs. When flagged under \`OMISSIONS\` (\`DYNAMIC_SPREAD\`), verify the affected consumer manually.
- **Coordinate Determinism:** Anchor all claims and code edits to verified \`source_ref\` or \`symbol_id\` handles returned by Strata. Never invent line numbers.

---

## 2. Intent-to-Tool Routing Table

| Engineering Intent | Strata Tool | Primary Arguments | Operational Output & Scope |
|---|---|---|---|
| **Map workspace packages, routes, files, or unused candidates** | \`map_workspace\` | \`view: "overview" \| "packages" \| "routes" \| "files" \| "health"\`, \`package?\`, \`path_prefix?\` | Bounded package topology, routes, file inventory, or static unused component candidates. |
| **Inspect file outline, TypeChecker-resolved props/slots, & HTTP boundaries** | \`inspect_file\` | \`path: "..."\`, \`sections?: ["outline", "contract", "boundaries", "imports"]\`, \`resolve_types?: true\` | Public contract, symbol outlines with \`symbolId\`/\`sourceRef\`, outbound HTTP calls with \`backendTargetHint\`. |
| **Go to Definition / Find All References (cross-file, SFC, auto-imports)** | \`query_graph\` | \`query: "definition" \| "references"\`, \`target: { symbol_id \| file+symbol \| file+line }\` | Semantic + graph-supplemented definitions and references across packages. |
| **Trace callers/callees, component tree, or state flow** | \`query_graph\` | \`query: "call_hierarchy" \| "component_tree" \| "state_flow"\`, \`direction?: "up" \| "down" \| "both"\`, \`scope?: { packages }\` | Caller/callee chains, bidirectional component hierarchy, and Pinia/Nuxt \`useState\` readers & writers. |
| **Compute refactor impact sites & dynamic omissions** | \`query_graph\` | \`query: "impact"\`, \`target: { file: "...", member?: "<propOrEvent>" }\` | Verified consumer sites plus \`DYNAMIC_SPREAD\` omissions requiring manual check. |
| **Read targeted symbol body or hash-verified slice** | \`read_slice\` | \`source_ref: "ref:..."\` or \`symbol_id: "..."\` or \`path + (symbol \| block \| lines)\` | Exact hash-verified source slice with \`STALE_SOURCE\` protection. |
| **Search unknown symbols, component usages, prop usages, or text** | \`search_code\` | \`query: "..."\`, \`kind?: "symbol" \| "component_usage" \| "prop_usage" \| "text"\`, \`package?\` | Bounded FTS5 + graph matches returning \`symbol_id\` and \`source_ref\` handles. |

---

## 3. Canonical Workflow Playbooks

${renderPlaybooksForSkill()}

---

## 4. Operational Boundaries & Budget Discipline

1. **Budget Control (\`max_bytes\`):**
   - Responses default to \`16384\` UTF-8 bytes. When \`BUDGET_RESPONSE_TOO_LARGE\` occurs, either narrow \`sections\`/\`limit\` or retry with \`max_bytes\` matching \`retryMaxBytes\`.
2. **Dynamic Spread Verification:**
   - Always inspect every site listed under \`OMISSIONS\` (\`DYNAMIC_SPREAD\`) manually before modifying component props or events.
3. **Response Format (Text vs JSON):**
   - Prefer default \`format: "text"\` for compact human-readable analysis; use \`format: "json"\` when structured fields are required.
4. **Fullstack Bridge (Strata &rarr; Septum):**
   - When \`inspect_file(sections: ["boundaries"])\` discloses \`backendTargetHint\`, hand off the hint directly to Septum (\`septum_slice\` or \`septum_symbol\`) for backend inspection.
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
  Route TypeScript/JavaScript file inventory, symbol outlines, outbound HTTP boundary tracing, graph navigation, code search, and hash-verified slicing using strata-mcp (map_workspace, inspect_file, query_graph, read_slice, search_code). Use when exploring TS/JS modules without dumping entire files into context.
---

# use-strata — TypeScript / JavaScript AST Navigation & Slicing

## Intent-to-Tool Routing Table

| Intent | Tool Call | Canonical Arguments | Output |
|---|---|---|---|
| **Map repository files** | \`map_workspace\` | \`view: "files"\`, \`path_prefix?: "..."\`, \`limit?\` | Bounded file inventory across workspace packages. |
| **Search symbols or text** | \`search_code\` | \`query: "..."\`, \`kind: "symbol" \| "text"\`, \`path_prefix?: "..."\` | Exact line/column matches with \`symbol_id\` and \`source_ref\`. |
| **Module outline & HTTP boundaries** | \`inspect_file\` | \`path: "..."\`, \`sections: ["outline", "boundaries", "imports"]\` | Functions, classes, interfaces, outbound HTTP calls, and imports without bodies. |
| **Navigate definitions, references, or callers** | \`query_graph\` | \`query: "definition" \| "references" \| "call_hierarchy"\`, \`target: { symbol_id \| file+symbol }\` | Cross-file definitions, references, and caller/callee chains. |
| **Read targeted symbol or lines** | \`read_slice\` | \`source_ref: "ref:..."\` or \`symbol_id: "..."\` or \`path + (symbol \| lines)\` | Bounded, hash-verified source slice. |

## Discipline
- Always start with \`map_workspace(view: "overview" | "files")\` or \`inspect_file(path, sections: ["outline", "boundaries"])\` before slicing.
- Keep default \`format: "text"\` for interactive analysis; pass \`max_bytes\` if \`BUDGET_RESPONSE_TOO_LARGE\` occurs.
`;

export const STRATA_TS_SKILL = USE_STRATA_TS_SKILL_TEMPLATE;

export const STRATA_TS_CLAUDE_COMMAND = `---
description: TypeScript/JavaScript AST file inventory, symbol outlines, graph navigation, code search, and hash-verified slicing via strata-mcp.
---

# /use-strata

Use \`strata-mcp\` tools (\`map_workspace\`, \`inspect_file\`, \`query_graph\`, \`read_slice\`, \`search_code\`) instead of reading full TS/JS files:
- \`map_workspace(view: "files", path_prefix: "...")\` — bounded file inventory.
- \`search_code(query: "...", kind: "symbol" | "text")\` — symbol or text search returning \`symbol_id\` and \`source_ref\`.
- \`inspect_file(path, sections: ["outline", "boundaries", "imports"])\` — declarations, interfaces, outbound HTTP calls, and imports.
- \`read_slice(source_ref: "..." | symbol_id: "..." | path + lines)\` — bounded, hash-verified source slices.
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
