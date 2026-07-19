# spacetimepy-jupyterlab

JupyterLab 4 exploratory controls for SpaceTimePy 2 workflow recordings.

The extension provides:

- a left sidebar panel named **Explore**
- a floating **Variants** button when code is selected in the active notebook cell
- an inline variant dropdown next to captured code
- cell-metadata-backed variant targets and replacement variants
- marker-gated activation for cells constructing `SpaceTimeWorkflowBuilder`
- automatic SpaceTime runtime and root-recording lifecycle through the opt-in workflow builder
- a SpaceTime web view that opens after a matching cell executes
- a function-step tree for the latest SpaceTime session, showing only recorded function arguments
- a workflow feature selector with sample sizes and compact per-stage bin plots
- checkpoint-based branch replay when an argument variant is applied
- combination caching and longest-prefix replay across existing branches
- aggregate numeric and categorical feature histograms for every workflow stage

The kernel integration uses only SpaceTimePy's public runtime, capture, DTO,
and replay interfaces. It does not import the core monitor or ORM models.

## Explicit opt-in, automatic recording

Import the specialized builder from the SpaceTime-enabled workflow DSL fork.
That import is the explicit opt-in; workflow construction and execution remain
the same as with the ordinary DSL:

```python
from sampling_mining_workflows_dsl.SpaceTimeWorkflowBuilder import (
    SpaceTimeWorkflowBuilder,
)

w = (
    SpaceTimeWorkflowBuilder()
    .input(...)
    .filter_operator(...)
    .output(...)
)
w.execute_workflow()
```

The builder reuses an active SpaceTime runtime or opens `spacetime.db`, begins a
root recording before the first operator, and finishes it after workflow execution.
It leaves the runtime open so the extension can create and reuse replay
branches. The extension also finalizes the recording after the cell, including
failed executions, so a construction error does not leave the kernel stuck.

The SpaceTime-specific operator methods are declared with
`@spacetimepy.function` in the DSL fork. Their decorators only declare capture;
they do not independently create runtimes or sessions.

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
5. record those steps as a named v2 execution branch

Captured targets are stored in the cell metadata under `spacetimepy:variants`.

Replay targets argument expressions on monitored builder methods. A selected
range outside a method argument, a non-expression replacement, or a step
without a rehydratable recorded `self` checkpoint is reported in the SpaceTime
panel.

## SpaceTime web view check

When a cell containing `SpaceTimeWorkflowBuilder` finishes executing, the
extension asks the active kernel for its open SpaceTime runtime.

If a runtime and execution session are available, the **SpaceTime** side panel
opens and queries the latest session through public DTOs.

The workflow input is shown as a shared root. Variant paths fork horizontally at the modified call and render only their replayed suffix, so shared checkpoints are not duplicated. Only the currently selected configuration path is green. Each leaf is clickable and applies its complete variant configuration to the notebook. Each node displays only the arguments recorded for that function call.

Variant combinations are stored as execution-branch configuration keys in the
current SpaceTime session. Selecting a combination that has already been
recorded reuses its existing branch without executing the workflow again. For
a new combination, replay starts from the recorded branch with the longest
matching workflow prefix.

The combination active when the workflow cell executes is stored as the session baseline. It can be any variant combination; the graph, cache, and checkpoint planner do not assume that a session starts with all targets set to `Original`.

The feature selector at the top of the SpaceTime panel displays the selected metadata distribution after each workflow step. Numeric metadata uses up to 10 equal-width bins. Categorical metadata uses the 10 most frequent values plus an `Other` bin. Only aggregate counts and sample sizes are sent to the browser.

## Development loop

Kernel programs are authored as Python templates in `src/kernel/`. The
`prebuild:lib` and `pretest` scripts generate the ignored TypeScript source
module automatically; do not edit `src/generated/kernel-sources.ts` directly.

```bash
npm run build
uv sync --no-editable --reinstall-package spacetimepy-jupyterlab
uv run jupyter lab
```

Variant replacement code is evaluated in the active IPython user namespace, with the same authority as code executed directly in a notebook cell.
