import type { VariantReexecutionRequest } from './types';

export const TRACE_JSON_PREFIX = 'SPACETIMEPY_TRACE_JSON:';
export const REEXECUTE_JSON_PREFIX = 'SPACETIMEPY_REEXECUTE_JSON:';
const WORKFLOW_SUMMARY_CODE = String.raw`
from collections import Counter
import math

def _spx_unwrap_workflow(value):
    if value is None:
        return None
    if hasattr(value, "get_all_set_from_workflow"):
        return value
    nested = getattr(value, "_workflow", None)
    if nested is not None and hasattr(nested, "get_all_set_from_workflow"):
        return nested
    nested = getattr(value, "workflow", None)
    if nested is not None and hasattr(nested, "get_all_set_from_workflow"):
        return nested
    return None

def _spx_histogram(values):
    values = [value for value in values if value is not None]
    if not values:
        return {"kind": "empty", "bins": []}

    numeric = all(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        for value in values
    )
    if numeric:
        numbers = [float(value) for value in values]
        minimum = min(numbers)
        maximum = max(numbers)
        if minimum == maximum:
            return {
                "kind": "numeric",
                "bins": [{"label": f"{minimum:g}", "count": len(numbers)}],
            }
        bin_count = min(10, max(1, math.ceil(math.sqrt(len(numbers)))))
        width = (maximum - minimum) / bin_count
        counts = [0] * bin_count
        for value in numbers:
            index = min(int((value - minimum) / width), bin_count - 1)
            counts[index] += 1
        return {
            "kind": "numeric",
            "bins": [
                {
                    "label": f"{minimum + index * width:g}-{minimum + (index + 1) * width:g}",
                    "count": count,
                }
                for index, count in enumerate(counts)
            ],
        }

    labels = []
    for value in values:
        if isinstance(value, (list, tuple, set)):
            labels.extend(str(item) for item in value)
        else:
            labels.append(str(value))
    counts = Counter(labels)
    most_common = counts.most_common(10)
    included = sum(count for _, count in most_common)
    bins = [{"label": label, "count": count} for label, count in most_common]
    if included < len(labels):
        bins.append({"label": "Other", "count": len(labels) - included})
    return {"kind": "categorical", "bins": bins}

def _spx_summarize_workflow(value):
    workflow = _spx_unwrap_workflow(value)
    if workflow is None:
        return []
    stages = []
    for index, stage_value in sorted(workflow.get_all_set_from_workflow().items()):
        set_object, operator = stage_value
        if set_object is None:
            continue
        flattened = set_object.flatten_set() if hasattr(set_object, "flatten_set") else set_object
        elements = flattened.get_elements() if hasattr(flattened, "get_elements") else []
        feature_values = {}
        for element in elements:
            if not hasattr(element, "get_all_metadata_values"):
                continue
            for metadata, metadata_value in element.get_all_metadata_values().items():
                name = str(getattr(metadata, "name", metadata))
                try:
                    value = metadata_value.get_value()
                except Exception:
                    value = getattr(metadata_value, "value", None)
                feature_values.setdefault(name, []).append(value)
        stages.append({
            "index": int(index),
            "label": "Input" if operator is None else type(operator).__name__,
            "sampleSize": len(elements),
            "histograms": {
                name: _spx_histogram(values)
                for name, values in feature_values.items()
            },
        })
    return stages

def _spx_find_notebook_workflow():
    try:
        from IPython import get_ipython
        namespace = get_ipython().user_ns
    except Exception:
        return None
    preferred = namespace.get("workflow")
    if _spx_unwrap_workflow(preferred) is not None:
        return preferred
    for value in reversed(list(namespace.values())):
        if _spx_unwrap_workflow(value) is not None:
            return value
    return None
`;
export const TRACE_QUERY_CODE = String.raw`
import json
import sys

${WORKFLOW_SUMMARY_CODE}

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

print("${TRACE_JSON_PREFIX}" + json.dumps(payload, default=str))
`;

export function buildReexecutionCode(request: VariantReexecutionRequest): string {
  const encodedRequest = JSON.stringify(JSON.stringify(request));
  return String.raw`
import ast
import json
import sys
import uuid

${WORKFLOW_SUMMARY_CODE}

request = json.loads(${encodedRequest})
result = {"ok": False}

class _SpxCombinationReuse(Exception):
    def __init__(self, branch_id=None, branch_from_call_id=None, call_ids=None):
        self.branch_id = branch_id
        self.branch_from_call_id = branch_from_call_id
        self.call_ids = call_ids or []

def _spx_contains(node, line, column):
    start_line = getattr(node, "lineno", None)
    end_line = getattr(node, "end_lineno", None)
    start_column = getattr(node, "col_offset", None)
    end_column = getattr(node, "end_col_offset", None)
    if None in (start_line, end_line, start_column, end_column):
        return False
    if line < start_line or line > end_line:
        return False
    if line == start_line and column < start_column:
        return False
    if line == end_line and column > end_column:
        return False
    return True

def _spx_method_name(call):
    return call.func.attr if isinstance(call.func, ast.Attribute) else None

def _spx_matches(call, method_name):
    return call.function == method_name or call.function.endswith("." + method_name)

def _spx_evaluate_arguments(call, namespace):
    args = []
    kwargs = {}
    for argument in call.args:
        if isinstance(argument, ast.Starred):
            args.extend(eval(compile(ast.Expression(argument.value), "<variant-replay>", "eval"), namespace, namespace))
        else:
            args.append(eval(compile(ast.Expression(argument), "<variant-replay>", "eval"), namespace, namespace))
    for keyword in call.keywords:
        value = eval(compile(ast.Expression(keyword.value), "<variant-replay>", "eval"), namespace, namespace)
        if keyword.arg is None:
            kwargs.update(value)
        else:
            kwargs[keyword.arg] = value
    return args, kwargs

try:
    if "spacetimepy" not in sys.modules:
        raise RuntimeError("SpaceTimePy is not loaded in this kernel.")

    from IPython import get_ipython
    from spacetimepy.core.models import FunctionCall
    from spacetimepy.core.monitoring import SpaceTimeMonitor

    monitor = SpaceTimeMonitor.get_instance()
    if monitor is None or getattr(monitor, "session", None) is None:
        raise RuntimeError("SpaceTimePy monitoring is not initialized.")
    if getattr(monitor, "current_session", None) is None:
        raise RuntimeError("There is no active SpaceTimePy monitoring session.")

    db_session = monitor.session
    session_id = monitor.current_session.id
    db_session.commit()
    session_calls = (
        db_session.query(FunctionCall)
        .filter(FunctionCall.session_id == session_id)
        .order_by(FunctionCall.order_in_session.asc(), FunctionCall.id.asc())
        .all()
    )
    baseline_combination_key = (
        request.get("baselineCombinationKey")
        or request.get("originalCombinationKey")
    )
    if request.get("combinationKey") == baseline_combination_key:
        raise _SpxCombinationReuse()

    cached_branch = next(
        (
            (call.call_metadata or {}).get("spx_branch")
            for call in session_calls
            if (
                ((call.call_metadata or {}).get("spx_branch") or {}).get("combinationKey")
                == request.get("combinationKey")
                and ((call.call_metadata or {}).get("spx_branch") or {}).get("strategyVersion")
                == 2
            )
        ),
        None,
    )
    if cached_branch:
        cached_branch_id = cached_branch.get("id")
        cached_call_ids = [
            call.id for call in session_calls
            if ((call.call_metadata or {}).get("spx_branch") or {}).get("id")
            == cached_branch_id
        ]
        raise _SpxCombinationReuse(
            cached_branch_id,
            cached_branch.get("fromCallId"),
            cached_call_ids,
        )

    def _spx_combination_entries(key):
        try:
            entries = json.loads(key)
            if not isinstance(entries, list):
                return []
            return [tuple(entry) for entry in entries]
        except Exception:
            return []

    desired_entries = _spx_combination_entries(request.get("combinationKey"))
    candidate_combination_keys = [baseline_combination_key]
    seen_combination_keys = {baseline_combination_key}
    for call in session_calls:
        branch = (call.call_metadata or {}).get("spx_branch") or {}
        combination_key = branch.get("combinationKey")
        if (
            combination_key
            and combination_key != request.get("combinationKey")
            and combination_key not in seen_combination_keys
        ):
            seen_combination_keys.add(combination_key)
            candidate_combination_keys.append(combination_key)

    replay_parent_combination_key = baseline_combination_key
    replay_target_index = 0
    for combination_key in candidate_combination_keys:
        candidate_entries = _spx_combination_entries(combination_key)
        prefix_length = 0
        for desired_entry, candidate_entry in zip(desired_entries, candidate_entries):
            if desired_entry != candidate_entry:
                break
            prefix_length += 1
        if prefix_length > replay_target_index:
            replay_parent_combination_key = combination_key
            replay_target_index = prefix_length

    replay_targets = request.get("targets") or []
    if replay_target_index >= len(replay_targets):
        raise RuntimeError("Could not identify the first variant location requiring replay.")
    replay_target = replay_targets[replay_target_index]
    branch_label = replay_target.get("variantLabel") or "Variant"

    source = request["source"]
    tree = ast.parse(source)
    point_line = int(replay_target["range"]["start"]["line"]) + 1
    point_column = int(replay_target["range"]["start"]["column"])
    source_calls = sorted(
        [node for node in ast.walk(tree) if isinstance(node, ast.Call) and _spx_method_name(node)],
        key=lambda node: (node.end_lineno, node.end_col_offset, node.lineno, node.col_offset),
    )
    enclosing_calls = [
        call for call in source_calls
        if any(
            _spx_contains(value, point_line, point_column)
            for value in [*call.args, *[keyword.value for keyword in call.keywords]]
        )
    ]
    if not enclosing_calls:
        raise ValueError("The variant must select code inside a method-call argument.")
    target_source_call = min(
        enclosing_calls,
        key=lambda call: (call.end_lineno - call.lineno, call.end_col_offset - call.col_offset),
    )
    target_method = _spx_method_name(target_source_call)

    selected_keyword = next(
        (
            keyword.arg for keyword in target_source_call.keywords
            if keyword.arg and _spx_contains(keyword.value, point_line, point_column)
        ),
        None,
    )
    selected_position = next(
        (
            index for index, value in enumerate(target_source_call.args)
            if _spx_contains(value, point_line, point_column)
        ),
        None,
    )
    if selected_keyword is None and selected_position is None:
        raise ValueError("Could not identify the changed function argument.")

    replay_call_ids = {
        call.id for call in session_calls
        if (call.call_metadata or {}).get("spx_branch")
    }
    changed = True
    while changed:
        changed = False
        for call in session_calls:
            if call.id not in replay_call_ids and call.parent_call_id in replay_call_ids:
                replay_call_ids.add(call.id)
                changed = True
    base_calls = [
        call for call in session_calls if call.id not in replay_call_ids
    ]

    source_occurrence = sum(
        1 for call in source_calls
        if _spx_method_name(call) == target_method
        and (call.end_lineno, call.end_col_offset) < (target_source_call.end_lineno, target_source_call.end_col_offset)
    )
    matching_calls = [call for call in base_calls if _spx_matches(call, target_method)]
    if source_occurrence >= len(matching_calls):
        raise LookupError(f"No recorded {target_method} call matches this cell expression.")
    target_call = matching_calls[source_occurrence]

    parent_target_call = None
    ancestor_combination_key = replay_parent_combination_key
    visited_combination_keys = set()
    while ancestor_combination_key and ancestor_combination_key not in visited_combination_keys:
        visited_combination_keys.add(ancestor_combination_key)
        ancestor_calls = [
            call for call in session_calls
            if ((call.call_metadata or {}).get("spx_branch") or {}).get("combinationKey")
            == ancestor_combination_key
        ]
        parent_target_call = next(
            (
                call for call in reversed(ancestor_calls)
                if ((call.call_metadata or {}).get("spx_branch") or {}).get("sourceCallId")
                == target_call.id
            ),
            None,
        )
        if parent_target_call is not None:
            break
        ancestor_branch = next(
            (
                (call.call_metadata or {}).get("spx_branch")
                for call in reversed(ancestor_calls)
                if (call.call_metadata or {}).get("spx_branch")
            ),
            None,
        )
        ancestor_combination_key = (
            ancestor_branch.get("parentCombinationKey")
            if ancestor_branch
            else None
        )
    checkpoint_call = parent_target_call or target_call

    parents = {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }
    replay_chain = [target_source_call]
    chain_call = target_source_call
    while True:
        attribute = parents.get(chain_call)
        outer_call = parents.get(attribute) if isinstance(attribute, ast.Attribute) else None
        if not (
            isinstance(attribute, ast.Attribute)
            and isinstance(outer_call, ast.Call)
            and outer_call.func is attribute
        ):
            break
        replay_chain.append(outer_call)
        chain_call = outer_call

    previous_calls = [
        call for call in base_calls
        if call.order_in_session is not None
        and target_call.order_in_session is not None
        and call.order_in_session < target_call.order_in_session
    ]
    branch_from_call_id = (
        checkpoint_call.parent_call_id
        if parent_target_call is not None
        else (previous_calls[-1].id if previous_calls else None)
    )
    branch_id = "variant-" + uuid.uuid4().hex[:10]
    user_namespace = get_ipython().user_ns
    target_values = monitor.object_manager.rehydrate_dict(checkpoint_call.locals_refs or {})
    live_receiver = target_values.get("self")
    if live_receiver is None:
        raise RuntimeError(f"The recorded {target_method} call has no rehydratable self checkpoint.")
    previous_branch_call_id = branch_from_call_id
    replay_start_call_id = db_session.query(FunctionCall.id).order_by(FunctionCall.id.desc()).limit(1).scalar() or 0
    source_call_ids_by_method = {}

    def _spx_branch_metadata(source_call_id):
        return {
            "id": branch_id,
            "label": branch_label,
            "fromCallId": branch_from_call_id,
            "sourceCallId": source_call_id,
            "combinationKey": request.get("combinationKey"),
            "combinationLabel": request.get("combinationLabel"),
            "parentCombinationKey": replay_parent_combination_key,
            "strategyVersion": 2,
        }

    for source_call in replay_chain:
        method_name = _spx_method_name(source_call)
        source_call_occurrence = sum(
            1 for call in source_calls
            if _spx_method_name(call) == method_name
            and (call.end_lineno, call.end_col_offset) < (source_call.end_lineno, source_call.end_col_offset)
        )
        source_candidates = [call for call in base_calls if _spx_matches(call, method_name)]
        if source_call_occurrence < len(source_candidates):
            source_call_ids_by_method.setdefault(method_name, []).append(
                source_candidates[source_call_occurrence].id
            )

    for source_call in replay_chain:
        method_name = _spx_method_name(source_call)
        function = getattr(live_receiver, method_name)
        args, kwargs = _spx_evaluate_arguments(source_call, user_namespace)
        before_id = db_session.query(FunctionCall.id).order_by(FunctionCall.id.desc()).limit(1).scalar() or 0
        monitor._parent_id_for_next_call = previous_branch_call_id
        call_result = function(*args, **kwargs)
        new_calls = (
            db_session.query(FunctionCall)
            .filter(FunctionCall.session_id == session_id, FunctionCall.id > before_id)
            .order_by(FunctionCall.id.asc())
            .all()
        )
        replayed_call = next((call for call in new_calls if _spx_matches(call, method_name)), None)
        if replayed_call is None and source_call is target_source_call:
            monitor._parent_id_for_next_call = None
            raise RuntimeError(f"Replayed {method_name} was not recorded by SpaceTimePy.")
        if replayed_call is None:
            monitor._parent_id_for_next_call = None
        if replayed_call is not None:
            previous_branch_call_id = replayed_call.id
        if call_result is not None:
            live_receiver = call_result

    recorded_branch_calls = (
        db_session.query(FunctionCall)
        .filter(
            FunctionCall.session_id == session_id,
            FunctionCall.id > replay_start_call_id,
        )
        .order_by(FunctionCall.id.asc())
        .all()
    )
    source_indexes = {}
    branch_call_ids = []
    for recorded_call in recorded_branch_calls:
        method_name = recorded_call.function.rsplit(".", 1)[-1]
        source_index = source_indexes.get(method_name, 0)
        source_ids = source_call_ids_by_method.get(method_name, [])
        source_call_id = (
            source_ids[source_index]
            if source_index < len(source_ids)
            else target_call.id
        )
        source_indexes[method_name] = source_index + 1
        metadata = dict(recorded_call.call_metadata or {})
        metadata["spx_branch"] = _spx_branch_metadata(source_call_id)
        recorded_call.call_metadata = metadata
        branch_call_ids.append(recorded_call.id)

    workflow_stages = _spx_summarize_workflow(live_receiver)
    if branch_call_ids and workflow_stages:
        first_branch_call = db_session.get(FunctionCall, branch_call_ids[0])
        first_metadata = dict(first_branch_call.call_metadata or {})
        first_metadata["spx_branch_stages"] = workflow_stages
        first_branch_call.call_metadata = first_metadata
    db_session.commit()
    result = {
        "ok": True,
        "branchId": branch_id,
        "branchFromCallId": branch_from_call_id,
        "callIds": branch_call_ids,
    }
except _SpxCombinationReuse as reused:
    result = {
        "ok": True,
        "reused": True,
        "branchId": reused.branch_id,
        "branchFromCallId": reused.branch_from_call_id,
        "callIds": reused.call_ids,
    }
except Exception as exc:
    try:
        if "monitor" in locals() and monitor is not None:
            monitor._parent_id_for_next_call = None
            monitor.session.rollback()
    except Exception:
        pass
    result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

print("${REEXECUTE_JSON_PREFIX}" + json.dumps(result, default=str))
`;
}

