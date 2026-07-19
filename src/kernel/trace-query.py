import json
import sys

# __SPX_WORKFLOW_SUMMARY__


def _spx_value(value):
    try:
        if value is None or isinstance(value, (bool, int, float, str)):
            return value
        if isinstance(value, (list, tuple)):
            return [_spx_value(item) for item in list(value)[:8]]
        if isinstance(value, dict):
            return {
                str(key): _spx_value(val)
                for key, val in list(value.items())[:8]
            }
        text = repr(value)
        if len(text) > 160:
            text = text[:157] + "..."
        return {"type": type(value).__name__, "repr": text}
    except Exception as exc:
        return {
            "type": type(value).__name__,
            "repr": f"<unrepresentable: {exc}>",
        }


def _spx_call_for_step(space, step):
    if step.function_call is not None:
        return step.function_call, step.function_call.entry_local_references
    if step.stack_snapshot is not None:
        snapshot = step.stack_snapshot
        return (
            space.data.get_function_call(snapshot.function_call_id),
            snapshot.local_references,
        )
    return None, {}


def _spx_arguments(references, loaded_values):
    arguments = []
    for name, reference in references.items():
        if name in ("self", "cls"):
            continue
        try:
            arguments.append(
                {"name": name, "value": _spx_value(loaded_values[reference])}
            )
        except Exception as exc:
            arguments.append(
                {
                    "name": name,
                    "value": f"<error reading {reference}: {exc}>",
                }
            )
    return arguments


payload = {
    "loaded": "spacetimepy" in sys.modules,
    "nodes": [],
    "features": [],
    "inputStage": None,
}
try:
    if payload["loaded"]:
        from spacetimepy import get_active_spacetime

        space = get_active_spacetime()
        if space is None:
            payload["error"] = (
                "SpaceTimePy is loaded but there is no active SpaceTime runtime."
            )
        else:
            space.commit()
            sessions = space.data.list_sessions()
            if not sessions:
                payload["error"] = "No SpaceTime execution session was found."
            else:
                current_session = sessions[-1]
                payload["session"] = {
                    "id": current_session.id,
                    "name": current_session.name,
                }
                baseline = current_session.attributes.get(
                    "spx_jupyter_baseline",
                    {},
                )
                payload["baselineCombinationKey"] = baseline.get(
                    "combinationKey"
                )
                payload["baselineCombinationLabel"] = baseline.get(
                    "combinationLabel"
                )

                branches = [
                    space.data.get_branch(summary.id)
                    for summary in current_session.branches
                ]
                root = next(
                    (
                        branch
                        for branch in branches
                        if branch.parent_branch_id is None
                    ),
                    None,
                )
                if root is None:
                    raise RuntimeError("The latest session has no root branch.")
                branches = [
                    branch
                    for branch in branches
                    if branch.parent_branch_id is None
                    or branch.status == "completed"
                ]

                baseline_stages = _spx_summarize_workflow(
                    _spx_find_notebook_workflow()
                )
                if baseline_stages:
                    payload["inputStage"] = baseline_stages[0]

                all_steps = [
                    step
                    for branch in branches
                    for step in branch.steps
                ]
                step_calls = {}
                step_local_references = {}
                all_references = []
                for step in all_steps:
                    call, references = _spx_call_for_step(space, step)
                    if call is None:
                        continue
                    step_calls[step.id] = call
                    step_local_references[step.id] = references
                    all_references.extend(references.values())
                loaded_values = space.data.load_values(all_references)

                branch_stages = {
                    branch.id: branch.attributes.get(
                        "spx_workflow_stages",
                        [],
                    )
                    for branch in branches
                }
                feature_names = {
                    feature
                    for stages in [baseline_stages, *branch_stages.values()]
                    for stage in stages
                    for feature in stage.get("histograms", {})
                }
                payload["features"] = sorted(feature_names)

                baseline_stage_by_step_id = {
                    step.id: baseline_stages[index + 1]
                    for index, step in enumerate(root.steps)
                    if index + 1 < len(baseline_stages)
                }

                for branch in branches:
                    branch_data = None
                    stage_start = int(
                        branch.attributes.get("spx_stage_start_index", 0)
                    )
                    if branch.parent_branch_id is not None:
                        parent_path = space.data.get_branch(
                            branch.parent_branch_id,
                            resolve=True,
                        ).steps
                        fork_index = next(
                            (
                                index
                                for index, step in enumerate(parent_path)
                                if step.id == branch.forked_from_step_id
                            ),
                            None,
                        )
                        from_step_id = (
                            parent_path[fork_index - 1].id
                            if fork_index is not None and fork_index > 0
                            else None
                        )
                        branch_data = {
                            "id": str(branch.id),
                            "label": branch.name or "Variant",
                            "fromStepId": from_step_id,
                            "sourceStepId": branch.forked_from_step_id,
                            "combinationKey": branch.configuration_key,
                            "combinationLabel": branch.attributes.get(
                                "spx_combination_label"
                            ),
                            "parentCombinationKey": branch.attributes.get(
                                "spx_parent_combination_key"
                            ),
                        }

                    stages = branch_stages.get(branch.id, [])
                    for index, step in enumerate(branch.steps):
                        call = step_calls.get(step.id)
                        if call is None:
                            continue
                        stage = (
                            baseline_stage_by_step_id.get(step.id)
                            if branch.parent_branch_id is None
                            else (
                                stages[stage_start + index + 1]
                                if stage_start + index + 1 < len(stages)
                                else None
                            )
                        )
                        payload["nodes"].append(
                            {
                                "id": step.id,
                                "function": call.function_name,
                                "branch": branch_data,
                                "stage": stage,
                                "arguments": _spx_arguments(
                                    step_local_references.get(step.id, {}),
                                    loaded_values,
                                ),
                            }
                        )
except Exception as exc:
    payload["error"] = f"{type(exc).__name__}: {exc}"

print("__SPX_TRACE_JSON_PREFIX__" + json.dumps(payload, default=str))
