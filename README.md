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
Edit operator arguments, insert operators, or delete operators.
Save the notebook to submit the saved source to the kernel.
Typing alone does not execute the workflow. Failed saves do not submit edits.
JupyterLab autosaves also trigger this check. Disable notebook autosave if you want only manual saves to trigger execution.
Invalid Python preserves the last successful branch. The panel reports unsupported edits and execution errors.

Each operator checkpoint stores the workflow state immediately before that operator executes.
This state includes the computed input set. The kernel restores the checkpoint before the first actual edit.
An additional finalization checkpoint stores the completed workflow before output writing.
Insertion after the final operator restores this terminal checkpoint.
It executes the suffix as a child of the selected branch. It does not execute the unchanged prefix or reload the workflow input.
Each successful branch writes output once through the original writer.
Deletion of the final operator retains the predecessor result and executes finalization without a new operator step.
The JSON writer writes `[]` for an empty result. The panel retains that branch with zero output elements.

Select an Output endpoint to restore its cell source and display its results.
Selection does not execute Python, create a branch, or write output.
The panel displays stage sizes and numeric or categorical distributions. The feature selector changes the displayed distribution.

Use one linear workflow per live cell. Keep notebook variables and external inputs fixed during the session.
Keep the workflow variable, builder call, input call, and output call fixed.
Keep at least one operator. Nested workflows remain unsupported.
The integration does not provide a separate move operation for reordering.
## Stage comparison

The graph places matched stages on the same row, including after operator insertion or deletion.
It preserves execution order and places all output endpoints on a final row.
The kernel aligns DSL operator names in execution order. Each occurrence can match at most once, and links cannot cross.
It first maximizes the number of matches. Among equal-length alignments, it maximizes pairs with equal argument expressions.
Python ASTs define expression equality without evaluation. Formatting changes do not affect this preference.
Identical expressions do not establish identical runtime values.
For residual ties, it selects the lexicographically smallest sequence of `(reference index, variant index)` pairs.
Thus, the earliest reference occurrence takes priority, followed by the earliest variant occurrence.
Indices start at zero in stored metadata.

These links describe correspondence for this DSL. They do not establish semantic equivalence.
The integration implements this strategy once in the kernel. It does not change the generic SpaceTimePy alignment contract.
Each branch stores its ordered operator-step references, terminal checkpoint, source, summaries, and parent comparison.
The panel uses these references instead of equal indices across branches.
A comparison link never permits reuse of a result. Every operator after the first edit executes again.
For example, `A → B → D` changed to `A → B → C → D` retains A/B and executes C/D.
D remains comparable with the original D, and C remains unmatched.

Use an explicit sampling seed to compare resumed results with fresh execution.
Ordinary `execute_workflow()` does not activate live execution.

Kernel requests execute in sequence. A newer edit prevents an older response from replacing the display.
Cell disposal and kernel replacement remove the live listeners. A kernel restart ends the live session.

Install the accompanying DSL capture changes before use. Start a new live recording after the update.

Run the checks:

```bash
python -m pytest tests
npm test
npm run build
```

The Python integration tests use real filter/random operators and SpaceTime checkpoints through the kernel request templates.
They check execution counts, fresh results, terminal state, and history after structural edits.
Name-alignment tests also cover systematic sampling. Its existing incomplete DSL implementation remains outside this change.
Edit files in `src/kernel/`. Run `npm run generate:kernel-code` to regenerate the embedded Python code.
