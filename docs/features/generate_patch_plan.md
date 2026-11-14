# generate_patch_plan — static consumer edit proposals

**Status:** Implementation contract

**Last updated:** 2026-11-14

## Input and operation boundaries

The tool accepts a component `path` (aliases include `component_path`, `file_path`
and `component`), an operation, `old_name`, and `new_name` for renames. Operations
are `rename_prop`, `remove_prop`, `rename_event`, `remove_event`, `rename_model`,
`remove_model`, `rename_slot` and `remove_slot`. `operations` supplies a batch.
`target_path` selects the workspace; otherwise the component's project root is used.

Operation names and required nonempty normalized identifiers are validated before
indexing or consumer discovery. The generator does not establish that `old_name`
is declared on the target component. Target declarations are outside the proposed
consumer edits and must be reviewed separately.

## Execution

1. Refresh an initialized workspace through `prepareIndexedAnalysis`. A failed
   refresh fails the analysis. Library/MCP calls on an uninitialized workspace
   retain source discovery without creating an index.
2. Discover direct consumer candidates through upward traversal with depth 1 and
   a 1000-consumer limit. Preserve truncation/scope/source diagnostics.
3. Read each consumer snapshot and resolve supported static usage sites. Generate
   replacement snippets with SHA-256-bound, end-exclusive UTF-16 source spans.
4. Record forwarding, dynamic selectors, unsupported syntax and colliding proposals
   as omissions/diagnostics rather than assuming coverage.
5. The tool checks the produced batch with `checkPatchPreconditions`: file hash,
   coordinates, snippet equality, valid source span and overlapping spans.

Supported syntax varies by operation. Prop edits cover supported Vue, Astro,
JSX/TSX and Svelte consumer sites. Event/model/slot edits have syntax-specific
limits; consult capability metadata and coverage for the actual request.
The operation does not apply edits.

## Output contract

The result uses `component`, `refactorType`, `oldName`, `newName`, optional
`operations`, `totalConsumersAudited`, `totalPatches`, `patches` and `coverage`.
Each patch contains `file`, `line`, `column`, `targetTag`, `oldSnippet`,
`newSnippet`, `description` and `sourceRef`.

`coverage` reports candidate/analyzed/failed/unsupported consumer counts,
diagnostics and omissions. Its operation scope explicitly excludes target
rewriting, forwarding and dynamic-component rewriting. Graph-bounded discovery
is not a complete runtime consumer inventory.

The tool adds `patchValidation` with `valid`, `validatedPatchCount` and `errors`.
`preconditionsValidated` remains as a compatibility field. Both describe only the
produced proposals. A valid batch, including an empty one, does not prove discovery
coverage or that the whole refactor is safe to apply. Revalidate the entire batch
against current disk source immediately before applying edits.

Retrieval evidence and response budgeting follow
[the retrieval contract](retrieval-evidence-contract.md).

## Implementation and verification

- `src/engine/patch-plan.ts`: operation validation, discovery and proposal generation.
- `src/engine/patch-preconditions.ts`: independent batch preconditions.
- `src/tools/patch-plan.ts`: preflight, validation and public response.
- `tests/core/analysis-consistency.test.ts`: consumers added after indexing.
- `tests/mcp/patch-validation.test.ts`: validation at library, CLI and MCP boundaries.
- `tests/core/golden-mutation-matrix.test.ts`: supported syntax and omission cases.
