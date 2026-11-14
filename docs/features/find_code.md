# find_code — inventory and static search

**Status:** Implementation contract. **Reviewed:** 2026-11-14, package `0.8.2`.

Search source with ast-grep patterns, relational YAML, literal lines or component
usage selectors. Inventory mode lists files without ingesting source bodies.
No initialized index is required. Traversal obeys collector ignore rules and
the selected scope; zero matches do not prove runtime absence.

## Parameters

| Parameter | Effective behavior |
|---|---|
| `path` | Directory or file; falls back to the resolved project root. Aliases include `file_path`, `filePath`, `target_path`. Prop supply search requires a directory. |
| `action` | Advertised values: `search` (default), `map`. |
| `pattern` | Structural pattern, or text in literal mode. Aliases: `query`, `search`. |
| `mode` | `ast` by default; `literal` performs exact case-sensitive substring matching per line; `auto` falls back only on an AST **pattern parse error**, not arbitrary execution/read failures. |
| `component` | Usage search; aliases `component_name`, `componentName`. Supports name variants and detected import aliases within static discovery limits. |
| `prop_name` | With `component`, selects prop supply/omission analysis. Aliases: `prop`, `propName`. |
| `prop_presence` | `present` by default, or `omitted`; alias `propPresence`. |
| `rule_yaml` | Complete ast-grep YAML rule; the rule specifies its language. |
| `code` | Inline snippet; alias `code_snippet`. Used for pattern/rule matching or a syntax-tree dump. |
| `language` | `auto`, `vue`, `astro`, `ts`, `js`, `tsx`, `jsx`, `html`, `css`. Snippets default to `ts`; explicit `auto` uses a tag heuristic. Disk searches infer languages from files/blocks. |
| `scope` | Component usage only: `template`, `script`, `both` (default). |
| `max_results` | Match cap, default 200; alias `maxResults`. Also accepted as an inventory limit alias. |
| `limit` | Inventory page size, default 100, clamped to 1–500. |
| `offset` | Inventory starting offset, default 0. Distinct from response-budget continuation. |
| `exclude_dirs` | Collector exclusions; alias `excludeDirs`. |

All modes also accept `format`, `include_structured`, `response_detail`,
`max_bytes` and `continuation_token` under the
[shared response contract](retrieval-evidence-contract.md).

## Mode selection and conflicts

- **Inventory:** `action: "map"` accepts path, limit, offset, exclusions and
  response controls. Pattern, YAML, code, component selectors and non-AST modes
  conflict with inventory. Explicit `mode: "ast"` is accepted.
- **Prop supply:** `component` + `prop_name` (+ `prop_presence`) accepts path and
  response controls. Pattern/code/YAML, mode, language, scope, limit, offset,
  max-results and exclusion selectors conflict with this operation.
- **Inline input:** code plus pattern/YAML matches a snippet. Code alone without
  a target path dumps its syntax tree. `action: "dump_ast"` remains an implemented
  compatibility path absent from the advertised action enum; clients enforcing
  that enum can reject it.
- **Other searches:** component usage takes precedence over YAML, then pattern
  search. Prefer one selector to make the operation unambiguous.

## Prop supply boundaries

The component must have one exact matching basename inside the selected directory.
Ambiguous names require a narrower scope. Supported targets are Vue and React/JSX;
Astro/Svelte targets are rejected for this selector, even though other search modes
can inspect their source. A result distinguishes resolved usages, resolved static
omissions, candidate usages and indeterminate supply such as forwarding/spreads.
An omitted render does not establish a missing required prop at runtime.

## Results and examples

Inventory returns `root`, `scope`, `status`, `coverage`, `domainRoots`,
`frameworkCandidates` and `files`. File role/domain labels and manifest-derived
framework candidates are heuristics. Pattern results include matches and can
include `modeRequested`, `modeUsed` and `fallbackReason`. JSON primary
representations differ between legacy match arrays and structured operations;
do not assume one universal result shape.

Prop supply returns `matches`, `matchCount`, `query`, `coverage`,
`impactIdentity` and `inputFreshness`. `coverage.completeness` is `partial`;
`coverage.propSupply` includes `omittedRenderCount`, `omittedConsumerCount`,
`indeterminateRenderCount`, `candidateUsageCount` and `boundary`.
The text formatter explicitly calls this a partial static search.

Example requests; replace paths and component names with the intended project:

```json
{"action":"map","path":"src","limit":100,"format":"json","response_detail":"full"}
```

```json
{"path":"src","component":"BaseButton","prop_name":"variant","prop_presence":"omitted","format":"json","response_detail":"full"}
```

```json
{"code":"const n = ref(0)","pattern":"ref($$$)","language":"ts","format":"json","response_detail":"full"}
```

Errors include invalid selector combinations, ambiguous/missing prop targets,
unsupported prop-search frameworks and ast-grep failures. Match caps, ignored
directories and response pagination restrict coverage. Narrow the scope or follow
continuation metadata before concluding there are no additional results.

## Owners and verification

- [Catalog](../../src/tools/catalog.ts), [handler](../../src/tools/find-code.ts).
- [Search](../../src/engine/search.ts), [prop selector](../../src/engine/search-intent.ts),
  [prop impact](../../src/engine/prop-impact.ts), [inventory](../../src/engine/frontend-map.ts).
- [Template tests](../../tests/core/template-expression.test.ts),
  [MCP regressions](../../tests/mcp/improvements-regression.test.ts),
  [response budgets](../../tests/mcp/serialized-budget.test.ts).
