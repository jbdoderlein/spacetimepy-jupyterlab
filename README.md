# spacetimepy-jupyterlab

This JupyterLab 4 extension displays live SpaceTimePy workflow branches and stage distributions.

Install the extension for local development:

```bash
npm install
npm run build
uv sync --no-editable
uv run jupyter labextension list
uv run jupyter lab
```

Import `SpaceTimeWorkflowBuilder` and define `loader` and `writer` in a setup cell.
Use a separate cell for this workflow:

```python
w = (
    SpaceTimeWorkflowBuilder()
    .input(loader)
    .filter_operator("commitNb > 2000 and commitNb < 7000")
    .filter_operator("language == 'Python'")
    .random_selection_operator(3, seed=0)
    .output(writer)
)
w.execute_live_workflow()
```

Execute the cell once. The SpaceTime side panel opens with the recorded execution.
Edit arguments in existing operator calls. Save the notebook to submit the saved source to the kernel.
Typing alone does not execute the workflow. Failed saves do not submit edits.
JupyterLab autosaves also trigger this check. Disable notebook autosave if you want only manual saves to trigger execution.
Invalid Python preserves the last successful branch. The panel reports unsupported edits and execution errors.

Each SpaceTime checkpoint stores the workflow state immediately before one operator executes.
This state includes the computed input set. The kernel restores the checkpoint before the first changed operator.
It executes the suffix as a child of the selected branch. It does not execute the unchanged prefix or reload the workflow input.
New branches write output through the original writer.
The JSON writer writes `[]` for an empty result. The panel retains that branch with zero output elements.

Select a branch endpoint to restore its cell source and display its results.
Selection does not execute Python, create a branch, or write output.
The panel displays stage sizes and numeric or categorical distributions. The feature selector changes the displayed distribution.

Use one linear workflow per live cell. Keep notebook variables and external inputs fixed during the session.
Keep the input call, output call, operator count, and operator order fixed.
Insertions, deletions, reordering, and nested workflows are unsupported.
Use an explicit sampling seed to compare resumed results with fresh execution.
Ordinary `execute_workflow()` does not activate live execution.

Kernel requests execute in sequence. A newer edit prevents an older response from replacing the display.
Cell disposal and kernel replacement remove the live listeners. A kernel restart ends the live session.

Run the checks:

```bash
python -m pytest tests
npm test
npm run build
```

The Python integration tests use real DSL operators and SpaceTime checkpoints through the kernel request templates.
Edit files in `src/kernel/`. Run `npm run generate:kernel-code` to regenerate the embedded Python code.
