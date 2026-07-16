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
            return {str(key): _spx_value(val) for key, val in list(value.items())[:8]}
        text = repr(value)
        if len(text) > 160:
            text = text[:157] + "..."
        return {"type": type(value).__name__, "repr": text}
    except Exception as exc:
        return {"type": type(value).__name__, "repr": f"<unrepresentable: {exc}>"}

def _spx_argument(manager, name, ref):
    if name in ("self", "cls"):
        return None
    try:
        value, _ = manager.get(ref)
        return {"name": name, "value": _spx_value(value)}
    except Exception as exc:
        return {"name": name, "value": f"<error reading {ref}: {exc}>"}

payload = {
    "loaded": "spacetimepy" in sys.modules,
    "nodes": [],
    "features": [],
    "inputStage": None,
}
try:
    if payload["loaded"]:
        from spacetimepy.core.monitoring import SpaceTimeMonitor
        from spacetimepy.core.models import FunctionCall, MonitoringSession

        monitor = SpaceTimeMonitor.get_instance()
        if monitor is None or getattr(monitor, "session", None) is None:
            payload["error"] = "SpaceTimePy is loaded but monitoring is not initialized."
        else:
            db_session = monitor.session
            current_session = getattr(monitor, "current_session", None)
            if current_session is None:
                current_session = (
                    db_session.query(MonitoringSession)
                    .order_by(MonitoringSession.start_time.desc())
                    .first()
                )
            if current_session is None:
                payload["error"] = "No SpaceTime monitoring session was found."
            else:
                payload["session"] = {
                    "id": current_session.id,
                    "name": current_session.name,
                }
                baseline = (current_session.session_metadata or {}).get(
                    "spx_jupyter_baseline",
                    {},
                )
                payload["baselineCombinationKey"] = baseline.get("combinationKey")
                payload["baselineCombinationLabel"] = baseline.get("combinationLabel")
                calls = (
                    db_session.query(FunctionCall)
                    .filter(FunctionCall.session_id == current_session.id)
                    .all()
                )
                calls.sort(
                    key=lambda call: (
                        call.order_in_session is None,
                        call.order_in_session if call.order_in_session is not None else 0,
                        call.start_time.isoformat() if call.start_time else "",
                    )
                )
                manager = getattr(monitor, "object_manager", None)
                baseline_stages = _spx_summarize_workflow(_spx_find_notebook_workflow())
                if baseline_stages:
                    payload["inputStage"] = baseline_stages[0]
                effective_branch_by_call_id = {}
                for call in calls:
                    branch = (call.call_metadata or {}).get("spx_branch")
                    if branch:
                        effective_branch_by_call_id[call.id] = dict(branch)

                changed = True
                while changed:
                    changed = False
                    for call in calls:
                        if call.id in effective_branch_by_call_id:
                            continue
                        parent_branch = effective_branch_by_call_id.get(call.parent_call_id)
                        if parent_branch:
                            effective_branch_by_call_id[call.id] = dict(parent_branch)
                            changed = True

                base_calls = [
                    call for call in calls
                    if call.id not in effective_branch_by_call_id
                ]
                base_call_index_by_id = {
                    call.id: index for index, call in enumerate(base_calls)
                }
                for call in calls:
                    metadata_branch = (call.call_metadata or {}).get("spx_branch")
                    branch = effective_branch_by_call_id.get(call.id)
                    if metadata_branch or not branch:
                        continue
                    parent_branch = effective_branch_by_call_id.get(call.parent_call_id, branch)
                    parent_source_id = parent_branch.get("sourceCallId")
                    parent_source_index = base_call_index_by_id.get(parent_source_id, -1)
                    source_call = next(
                        (
                            candidate for candidate in base_calls[parent_source_index + 1:]
                            if candidate.function == call.function
                        ),
                        None,
                    )
                    if source_call is not None:
                        branch["sourceCallId"] = source_call.id
                base_stage_by_call_id = {
                    call.id: baseline_stages[index + 1]
                    for index, call in enumerate(base_calls)
                    if index + 1 < len(baseline_stages)
                }
                base_stage_index_by_call_id = {
                    call.id: index + 1 for index, call in enumerate(base_calls)
                }
                branch_stages = {}
                for call in calls:
                    metadata = call.call_metadata or {}
                    branch = effective_branch_by_call_id.get(call.id)
                    stages = metadata.get("spx_branch_stages")
                    if branch and stages:
                        branch_stages[branch["id"]] = stages

                feature_names = {
                    feature
                    for stages in [baseline_stages, *branch_stages.values()]
                    for stage in stages
                    for feature in stage.get("histograms", {})
                }
                payload["features"] = sorted(feature_names)
                for call in calls:
                    metadata = call.call_metadata or {}
                    branch = effective_branch_by_call_id.get(call.id)
                    stage = base_stage_by_call_id.get(call.id)
                    if branch:
                        source_stage_index = base_stage_index_by_call_id.get(branch.get("sourceCallId"))
                        stages = branch_stages.get(branch.get("id"), [])
                        if source_stage_index is not None and source_stage_index < len(stages):
                            stage = stages[source_stage_index]
                    args = []
                    if manager is not None:
                        for name, ref in (call.locals_refs or {}).items():
                            arg = _spx_argument(manager, name, ref)
                            if arg is not None:
                                args.append(arg)
                    payload["nodes"].append({
                        "id": call.id,
                        "function": call.function,
                        "branch": branch,
                        "stage": stage,
                        "arguments": args,
                    })
except Exception as exc:
    payload["error"] = f"{type(exc).__name__}: {exc}"

print("__SPX_TRACE_JSON_PREFIX__" + json.dumps(payload, default=str))
