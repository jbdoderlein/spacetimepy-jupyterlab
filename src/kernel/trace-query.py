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
        stage_ids = attributes["spx_stage_step_ids"]
        payload["branches"].append({
            "id": str(branch.id), "source": attributes["spx_source"],
            "parentId": str(branch.parent_branch_id) if branch.parent_branch_id is not None else None,
            "operators": attributes["spx_operators"], "stages": stages[1:],
            "stageStepIds": stage_ids, "output": stages[-1],
            "alignment": attributes.get("spx_alignment"),
        })
        if branch.parent_branch_id is None:
            payload["rootBranchId"] = str(branch.id)
            payload["inputStage"] = stages[0]
        for stage in stages:
            features.update(stage["histograms"])
        start = attributes["spx_stage_start_index"]
        for index in range(start, len(stage_ids)):
            payload["nodes"].append({
                "id": stage_ids[index], "function": attributes["spx_operators"][index],
                "arguments": [], "stage": stages[index + 1],
                "branch": None if branch.parent_branch_id is None else {
                    "id": str(branch.id), "label": branch.name,
                    "fromStepId": stage_ids[start - 1] if start else None,
                    "sourceStepId": branch.forked_from_step_id,
                },
            })
    payload["features"] = sorted(features)
except Exception as error:
    payload["error"] = f"{type(error).__name__}: {error}"
print("__SPX_TRACE_JSON_PREFIX__" + json.dumps(payload))
