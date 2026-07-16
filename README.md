# spacetimpepy-jupyterlab

Minimal JupyterLab 4 extension for exploratory notebook controls.

The current prototype adds:

- a left sidebar panel named **Explore**
- a floating **Variants** button when code is selected in the active notebook cell
- an inline variant dropdown next to captured code
- cell-metadata-backed variant targets and replacement variants
- marker-gated activation for cells containing `SpaceTimeWorkflowBuilder`
- a SpaceTime web view that opens after a matching cell executes if `spacetimepy` is already loaded in the kernel
- a function-call tree for the latest SpaceTime session, showing only recorded function arguments
- a workflow feature selector with sample sizes and compact per-stage bin plots
- checkpoint-based branch replay when an argument variant is applied

This is intentionally scoped to selected code replacement before adding richer Python argument-specific widgets.

## Install for local development with uv

```bash
npm install
npm run build
uv sync --no-editable
uv run jupyter labextension list
uv run jupyter lab
```

In JupyterLab, open the left sidebar tab named **Explore** or run **Open Exploratory Controls** from the command palette.

## Variant workflow

1. Open a notebook and select code inside a cell containing `SpaceTimeWorkflowBuilder`.
2. Click the floating **Variants** button, or use **Capture Selected Code** in the **Explore** panel.
3. Add one or more replacement variants in the panel.
4. Use the inline dropdown next to the captured code, or click **Apply** in the panel, to replace the captured range.

For a recorded `SpaceTimeWorkflowBuilder` method argument, applying a variant also asks the kernel to:

1. map the selected range to its enclosing Python method call
2. restore the recorded builder state at that method's entry (after the preceding call)
3. evaluate the replacement expression in the notebook namespace
4. invoke the changed method and the remaining outer call chain, including workflow execution
5. record those calls as a named branch in the SpaceTime trace

Captured targets are stored in the cell metadata under `spacetimpepy:variants`.

The replay prototype currently targets argument expressions on monitored builder methods. A selected range outside a method argument, a non-expression replacement, or a call without a rehydratable recorded `self` checkpoint is reported in the SpaceTime panel.

## SpaceTime web view check

When a cell containing `SpaceTimeWorkflowBuilder` finishes executing, the extension asks the active kernel whether `spacetimepy` is present in `sys.modules`.

If the kernel reports that it is loaded, the **SpaceTime** side panel opens and queries the latest SpaceTime monitoring session.

The workflow input is shown as a shared root. Variant paths fork horizontally at the modified call and render only their replayed suffix, so shared checkpoints are not duplicated. Only the currently selected configuration path is green. Each leaf is clickable and applies its complete variant configuration to the notebook. Each node displays only the arguments recorded for that function call.

Variant combinations are recorded in the current SpaceTime monitoring session. Selecting a combination that has already been recorded reuses its existing branch without executing the workflow again. For a new combination, replay starts from the recorded combination with the longest matching workflow prefix.

The combination active when the workflow cell executes is stored as the session baseline. It can be any variant combination; the graph, cache, and checkpoint planner do not assume that a session starts with all targets set to `Original`.

The feature selector at the top of the SpaceTime panel displays the selected metadata distribution after each workflow step. Numeric metadata uses up to 10 equal-width bins. Categorical metadata uses the 10 most frequent values plus an `Other` bin. Only aggregate counts and sample sizes are sent to the browser.

## Development loop

Kernel programs are authored as Python templates in `src/kernel/`. The
`prebuild:lib` and `pretest` scripts generate the ignored TypeScript source
module automatically; do not edit `src/generated/kernel-sources.ts` directly.

```bash
npm run build
uv sync --no-editable --reinstall-package spacetimpepy-jupyterlab
uv run jupyter lab
```

Variant replacement code is evaluated in the active IPython user namespace, with the same authority as code executed directly in a notebook cell.
