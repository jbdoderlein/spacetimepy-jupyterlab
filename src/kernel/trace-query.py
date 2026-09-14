import json
from spacetimepy import get_active_spacetime

request = json.loads(__SPX_REQUEST_JSON__)
payload = {"loaded": False, "nodes": [], "features": [], "branches": []}
try:
    space = get_active_spacetime()
    if space is None:
        raise RuntimeError("There is no active SpaceTime runtime.")
    space.commit()
    session = space.data.get_session(int(request["sessionId"]))
    payload.update(loaded=True, session={"id": session.id, "name": session.name})
    features = set()
    for summary in session.branches:
        branch = space.data.get_branch(summary.id)
        attributes = branch.attributes
        if branch.status != "completed" or "spx_source" not in attributes:
            continue
        stages = attributes["spx_workflow_stages"]
        payload["branches"].append({"id": str(branch.id), "source": attributes["spx_source"]})
        if branch.parent_branch_id is None:
            payload["rootBranchId"] = str(branch.id)
            payload["inputStage"] = stages[0]
        path = space.data.get_branch(branch.id, resolve=True).steps
        start = attributes["spx_stage_start_index"]
        for offset, step in enumerate(branch.steps):
            index = start + offset
            stage = stages[index + 1]
            features.update(stage["histograms"])
            payload["nodes"].append({
                "id": step.id, "function": attributes["spx_operators"][index],
                "arguments": [], "stage": stage,
                "branch": None if branch.parent_branch_id is None else {
                    "id": str(branch.id), "label": branch.name,
                    "fromStepId": path[start - 1].id if start else None,
                    "sourceStepId": branch.forked_from_step_id,
                },
            })
    payload["features"] = sorted(features)
except Exception as error:
    payload["error"] = f"{type(error).__name__}: {error}"
print("__SPX_TRACE_JSON_PREFIX__" + json.dumps(payload))
