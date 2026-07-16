import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Range, StateEffect } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { ICommandPalette } from '@jupyterlab/apputils';
import type { Cell } from '@jupyterlab/cells';
import { CodeEditor } from '@jupyterlab/codeeditor';
import {
  INotebookTracker,
  NotebookActions,
  NotebookPanel
} from '@jupyterlab/notebook';
import { KernelMessage } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';
import {
  hierarchy,
  tree as createTreeLayout,
  type HierarchyPointNode
} from 'd3-hierarchy';

import '../style/index.css';

const PLUGIN_ID = 'spacetimpepy-jupyterlab:plugin';
const OPEN_COMMAND = 'spacetimpepy-jupyterlab:open-panel';
const CAPTURE_COMMAND = 'spacetimpepy-jupyterlab:capture-selection';
const METADATA_KEY = 'spacetimpepy:variants';
const WORKFLOW_MARKER = 'SpaceTimeWorkflowBuilder';
const TRACE_JSON_PREFIX = 'SPACETIMEPY_TRACE_JSON:';
const REEXECUTE_JSON_PREFIX = 'SPACETIMEPY_REEXECUTE_JSON:';
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
const TRACE_QUERY_CODE = String.raw`
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
        value, type_name = manager.get(ref)
        return {"name": name, "value": _spx_value(value), "type": type_name}
    except Exception as exc:
        return {"name": name, "value": f"<error reading {ref}: {exc}>", "type": "error"}

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
                        "order": call.order_in_session,
                        "parentCallId": call.parent_call_id,
                        "branch": branch,
                        "stage": stage,
                        "arguments": args,
                    })
except Exception as exc:
    payload["error"] = f"{type(exc).__name__}: {exc}"

print("${TRACE_JSON_PREFIX}" + json.dumps(payload, default=str))
`;

function buildReexecutionCode(request: VariantReexecutionRequest): string {
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
    branch_call_ids = []
    replay_start_call_id = db_session.query(FunctionCall.id).order_by(FunctionCall.id.desc()).limit(1).scalar() or 0
    source_call_ids_by_method = {}
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
        source_call_occurrence = sum(
            1 for call in source_calls
            if _spx_method_name(call) == method_name
            and (call.end_lineno, call.end_col_offset) < (source_call.end_lineno, source_call.end_col_offset)
        )
        source_candidates = [call for call in base_calls if _spx_matches(call, method_name)]
        source_call_id = (
            source_candidates[source_call_occurrence].id
            if source_call_occurrence < len(source_candidates)
            else target_call.id
        )
        for new_call in new_calls:
            metadata = dict(new_call.call_metadata or {})
            metadata["spx_branch"] = {
                "id": branch_id,
                "label": branch_label,
                "fromCallId": branch_from_call_id,
                "sourceCallId": source_call_id,
                "combinationKey": request.get("combinationKey"),
                "combinationLabel": request.get("combinationLabel"),
                "parentCombinationKey": replay_parent_combination_key,
                "strategyVersion": 2,
            }
            new_call.call_metadata = metadata
            branch_call_ids.append(new_call.id)
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
        metadata["spx_branch"] = {
            "id": branch_id,
            "label": branch_label,
            "fromCallId": branch_from_call_id,
            "sourceCallId": source_call_id,
            "combinationKey": request.get("combinationKey"),
            "combinationLabel": request.get("combinationLabel"),
            "parentCombinationKey": replay_parent_combination_key,
            "strategyVersion": 2,
        }
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

interface Position extends CodeEditor.IPosition {
  line: number;
  column: number;
}

interface VariantRange {
  start: Position;
  end: Position;
}

interface CodeVariant {
  id: string;
  label: string;
  code: string;
}

interface VariantTarget {
  id: string;
  label: string;
  original: string;
  range: VariantRange;
  activeVariantId?: string;
  variants: CodeVariant[];
}

interface CaptureResult {
  ok: boolean;
  message: string;
  target?: VariantTarget;
}

interface SpaceTimeTraceArgument {
  name: string;
  value: unknown;
  type?: string;
}

interface WorkflowHistogramBin {
  label: string;
  count: number;
}

interface WorkflowHistogram {
  kind: 'numeric' | 'categorical' | 'empty';
  bins: WorkflowHistogramBin[];
}

interface WorkflowStageSummary {
  index: number;
  label: string;
  sampleSize: number;
  histograms: Record<string, WorkflowHistogram>;
}

interface SpaceTimeTraceNode {
  id: number | string;
  function: string;
  order: number | null;
  parentCallId?: number | string | null;
  branch?: {
    id: string;
    label: string;
    fromCallId: number | string | null;
    sourceCallId: number | string;
    combinationKey?: string;
    combinationLabel?: string;
    parentCombinationKey?: string;
  } | null;
  stage?: WorkflowStageSummary | null;
  arguments: SpaceTimeTraceArgument[];
}

interface VariantReexecutionRequest {
  source: string;
  targets: Array<{
    targetId: string;
    variantId: string;
    variantLabel: string;
    range: VariantRange;
  }>;
  combinationKey: string;
  combinationLabel: string;
  baselineCombinationKey: string;
  originalCombinationKey: string;
}

interface VariantReexecutionResult {
  ok: boolean;
  error?: string;
  reused?: boolean;
  branchId?: string;
  branchFromCallId?: number | string | null;
  callIds?: Array<number | string>;
}

interface SpaceTimeTracePayload {
  loaded: boolean;
  error?: string;
  session?: {
    id: number | string;
    name?: string | null;
  };
  baselineCombinationKey?: string | null;
  baselineCombinationLabel?: string | null;
  features: string[];
  inputStage?: WorkflowStageSummary | null;
  nodes: SpaceTimeTraceNode[];
}

interface VariantCombination {
  key: string;
  label: string;
  isOriginal: boolean;
}

interface WorkflowTreeDatum {
  node: SpaceTimeTraceNode;
  children: WorkflowTreeDatum[];
  combinationKey?: string;
  edgeLabel?: string;
}

interface WorkflowTreeSelection {
  activeCombinationKey: string;
  baselineCombinationKey: string;
  baselineCombinationLabel: string;
  variantLabelById: Map<string, string>;
}

interface ExplorerPanelOptions {
  onAddVariant: (targetId: string, label: string, code: string) => CaptureResult;
  onApplyVariant: (targetId: string, variantId: string) => CaptureResult;
  onCaptureSelection: () => CaptureResult;
  onDeleteVariant: (targetId: string, variantId: string) => CaptureResult;
  onGetTargets: () => VariantTarget[];
  onHighlightLine: () => void;
  onKernelProbe: () => Promise<string>;
}

function formatTraceValue(value: unknown): string {
  if (value === null) {
    return 'None';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class ExplorerPanel extends Widget {
  constructor(private readonly options: ExplorerPanelOptions) {
    super();
    this.id = 'spacetimpepy-explorer-panel';
    this.title.label = 'Explore';
    this.title.caption = 'Exploratory notebook controls';
    this.addClass('spx-panel');

    this.header = document.createElement('div');
    this.header.className = 'spx-panel-header';
    this.header.textContent = 'Exploratory Controls';

    const captureButton = document.createElement('button');
    captureButton.className = 'spx-button spx-button-primary';
    captureButton.type = 'button';
    captureButton.textContent = 'Capture Selected Code';
    captureButton.onclick = () => {
      const result = this.options.onCaptureSelection();
      if (result.target) {
        this.selectedTargetId = result.target.id;
      }
      this.setStatus(result.message);
      this.render();
    };

    this.targetSelect = document.createElement('select');
    this.targetSelect.className = 'spx-select';
    this.targetSelect.onchange = () => {
      this.selectedTargetId = this.targetSelect.value || null;
      this.render();
    };

    this.originalPreview = document.createElement('pre');
    this.originalPreview.className = 'spx-code-preview';

    this.variantLabel = document.createElement('input');
    this.variantLabel.className = 'spx-input';
    this.variantLabel.placeholder = 'Variant label';

    this.variantCode = document.createElement('textarea');
    this.variantCode.className = 'spx-textarea';
    this.variantCode.placeholder = 'Replacement code';
    this.variantCode.rows = 5;

    const addVariantButton = document.createElement('button');
    addVariantButton.className = 'spx-button';
    addVariantButton.type = 'button';
    addVariantButton.textContent = 'Add Variant';
    addVariantButton.onclick = () => {
      if (!this.selectedTargetId) {
        this.setStatus('Capture or choose a target first.');
        return;
      }
      const result = this.options.onAddVariant(
        this.selectedTargetId,
        this.variantLabel.value,
        this.variantCode.value
      );
      this.setStatus(result.message);
      if (result.ok) {
        this.variantLabel.value = '';
        this.variantCode.value = '';
      }
      this.render();
    };

    this.variantList = document.createElement('div');
    this.variantList.className = 'spx-variant-list';

    const highlightButton = document.createElement('button');
    highlightButton.className = 'spx-button';
    highlightButton.type = 'button';
    highlightButton.textContent = 'Highlight Active Line';
    highlightButton.onclick = () => {
      this.options.onHighlightLine();
      this.setStatus('Requested notebook highlight.');
    };

    const kernelButton = document.createElement('button');
    kernelButton.className = 'spx-button';
    kernelButton.type = 'button';
    kernelButton.textContent = 'Kernel Probe';
    kernelButton.onclick = async () => {
      this.setStatus('Waiting for kernel...');
      const result = await this.options.onKernelProbe();
      this.setStatus(result);
    };

    this.status = document.createElement('pre');
    this.status.className = 'spx-status';
    this.status.textContent = 'Select code in a notebook cell, then capture it.';

    this.node.append(
      this.header,
      captureButton,
      this.sectionTitle('Targets'),
      this.targetSelect,
      this.originalPreview,
      this.sectionTitle('New Variant'),
      this.variantLabel,
      this.variantCode,
      addVariantButton,
      this.sectionTitle('Saved Variants'),
      this.variantList,
      this.sectionTitle('Diagnostics'),
      highlightButton,
      kernelButton,
      this.status
    );

    this.render();
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const targets = this.options.onGetTargets();
    if (
      this.selectedTargetId &&
      !targets.some(target => target.id === this.selectedTargetId)
    ) {
      this.selectedTargetId = null;
    }
    if (!this.selectedTargetId && targets.length > 0) {
      this.selectedTargetId = targets[targets.length - 1].id;
    }

    this.targetSelect.replaceChildren();
    if (targets.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No captured code';
      this.targetSelect.append(option);
    } else {
      for (const target of targets) {
        const option = document.createElement('option');
        option.value = target.id;
        option.textContent = target.label;
        this.targetSelect.append(option);
      }
    }
    this.targetSelect.value = this.selectedTargetId ?? '';

    const selectedTarget = targets.find(
      target => target.id === this.selectedTargetId
    );
    this.originalPreview.textContent = selectedTarget
      ? selectedTarget.original
      : 'No target selected.';

    this.variantList.replaceChildren();
    if (!selectedTarget || selectedTarget.variants.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spx-empty';
      empty.textContent = 'No variants yet.';
      this.variantList.append(empty);
      return;
    }

    for (const variant of selectedTarget.variants) {
      const item = document.createElement('div');
      item.className = 'spx-variant-item';

      const label = document.createElement('div');
      label.className = 'spx-variant-label';
      label.textContent = variant.label;

      const preview = document.createElement('pre');
      preview.className = 'spx-variant-code';
      preview.textContent = variant.code;

      const applyButton = document.createElement('button');
      applyButton.className = 'spx-button spx-button-compact';
      applyButton.type = 'button';
      applyButton.textContent = 'Apply';
      applyButton.onclick = () => {
        const result = this.options.onApplyVariant(
          selectedTarget.id,
          variant.id
        );
        this.setStatus(result.message);
        this.render();
      };

      const actions = document.createElement('div');
      actions.className = 'spx-variant-actions';
      actions.append(applyButton);

      const isOriginal =
        variant === selectedTarget.variants[0] &&
        variant.code === selectedTarget.original;
      if (!isOriginal) {
        const deleteButton = document.createElement('button');
        deleteButton.className =
          'spx-button spx-button-compact spx-button-danger';
        deleteButton.type = 'button';
        deleteButton.textContent = 'Delete';
        deleteButton.title = `Delete ${variant.label}`;
        deleteButton.onclick = () => {
          const result = this.options.onDeleteVariant(
            selectedTarget.id,
            variant.id
          );
          this.setStatus(result.message);
          this.render();
        };
        actions.append(deleteButton);
      }

      item.append(label, preview, actions);
      this.variantList.append(item);
    }
  }

  private sectionTitle(text: string): HTMLElement {
    const title = document.createElement('div');
    title.className = 'spx-section-title';
    title.textContent = text;
    return title;
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private selectedTargetId: string | null = null;
  private readonly header: HTMLDivElement;
  private readonly originalPreview: HTMLPreElement;
  private readonly status: HTMLPreElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly variantCode: HTMLTextAreaElement;
  private readonly variantLabel: HTMLInputElement;
  private readonly variantList: HTMLDivElement;
}

class SpaceTimeWebView extends Widget {
  constructor(
    private readonly onActivateCombination: (
      combinationKey: string
    ) => CaptureResult
  ) {
    super();
    this.id = 'spacetimpepy-webview-panel';
    this.title.label = 'SpaceTime';
    this.title.caption = 'SpaceTime web view';
    this.addClass('spx-webview');

    this.content = document.createElement('div');
    this.content.className = 'spx-webview-content';
    this.content.textContent = 'hello';
    this.node.append(this.content);
  }

  renderTrace(
    trace: SpaceTimeTracePayload,
    selection: WorkflowTreeSelection
  ): void {
    this.content.replaceChildren();
    this.currentTrace = trace;
    this.currentSelection = selection;

    const features = trace.features ?? [];
    if (!this.selectedFeature || !features.includes(this.selectedFeature)) {
      this.selectedFeature = features[0] ?? null;
    }

    const title = document.createElement('div');
    title.className = 'spx-trace-title';
    title.textContent = trace.session?.name
      ? `Session ${trace.session.id}: ${trace.session.name}`
      : trace.session
        ? `Session ${trace.session.id}`
        : 'SpaceTime session trace';
    this.content.append(title);

    if (features.length > 0) {
      const controls = document.createElement('div');
      controls.className = 'spx-trace-controls';

      const featureLabel = document.createElement('label');
      featureLabel.className = 'spx-trace-feature-label';
      featureLabel.textContent = 'Feature';

      const featureSelect = document.createElement('select');
      featureSelect.className = 'spx-select spx-trace-feature-select';
      for (const feature of features) {
        const option = document.createElement('option');
        option.value = feature;
        option.textContent = feature;
        featureSelect.append(option);
      }
      featureSelect.value = this.selectedFeature ?? '';
      featureSelect.onchange = () => {
        this.selectedFeature = featureSelect.value;
        if (this.currentTrace && this.currentSelection) {
          this.renderTrace(this.currentTrace, this.currentSelection);
        }
      };
      featureLabel.append(featureSelect);
      controls.append(featureLabel);
      this.content.append(controls);
    }

    if (trace.error) {
      const error = document.createElement('div');
      error.className = 'spx-trace-empty';
      error.textContent = trace.error;
      this.content.append(error);
      return;
    }

    if (!trace.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'spx-trace-empty';
      empty.textContent = 'No function calls recorded for the latest session.';
      this.content.append(empty);
      return;
    }

    const graph = document.createElement('div');
    graph.className = 'spx-trace-graph';
    this.content.append(graph);
    this.renderTraceTree(
      graph,
      this.createTraceTree(
        trace,
        selection.baselineCombinationKey,
        selection.baselineCombinationLabel,
        selection.variantLabelById
      ),
      selection.activeCombinationKey
    );
  }

  renderStatus(message: string, isError = false): void {
    this.content.replaceChildren();
    const status = document.createElement('div');
    status.className = isError
      ? 'spx-trace-empty spx-trace-error'
      : 'spx-trace-empty';
    status.textContent = message;
    this.content.append(status);
  }

  private createTraceTree(
    trace: SpaceTimeTracePayload,
    baselineCombinationKey: string,
    baselineCombinationLabel: string,
    variantLabelById: Map<string, string>
  ): WorkflowTreeDatum {
    const inputNode: SpaceTimeTraceNode = {
      id: 'workflow-input',
      function: 'Workflow input',
      order: null,
      stage: trace.inputStage,
      arguments: []
    };
    const root: WorkflowTreeDatum = {
      node: inputNode,
      children: []
    };
    const treeNodeByCallId = new Map<string, WorkflowTreeDatum>([
      [String(inputNode.id), root]
    ]);
    const originalNodes = trace.nodes.filter(node => !node.branch);
    let originalParent = root;
    originalNodes.forEach((node, index) => {
      const datum: WorkflowTreeDatum = {
        node,
        children: [],
        edgeLabel: index === 0 ? baselineCombinationLabel : undefined
      };
      originalParent.children.push(datum);
      originalParent = datum;
      treeNodeByCallId.set(String(node.id), datum);
    });
    originalParent.combinationKey = baselineCombinationKey;

    const branchGroupsById = new Map<string, SpaceTimeTraceNode[]>();
    for (const node of trace.nodes.filter(candidate => candidate.branch)) {
      const branchId = node.branch!.id;
      const group = branchGroupsById.get(branchId) ?? [];
      group.push(node);
      branchGroupsById.set(branchId, group);
    }
    const branchGroups = new Map<string, SpaceTimeTraceNode[]>();
    for (const branchNodes of branchGroupsById.values()) {
      const branch = branchNodes[0].branch!;
      branchGroups.set(branch.combinationKey ?? branch.id, branchNodes);
    }

    const branchData = Array.from(branchGroups.values()).map(branchNodes => {
      const data = branchNodes.map(
        (node): WorkflowTreeDatum => ({
          node,
          children: []
        })
      );
      data.forEach(datum => {
        treeNodeByCallId.set(String(datum.node.id), datum);
      });
      return { branchNodes, data };
    });

    for (const { branchNodes, data } of branchData) {
      if (data.length === 0) {
        continue;
      }
      const branch = branchNodes[0].branch!;
      const sourceIndex = originalNodes.findIndex(
        node => String(node.id) === String(branch.sourceCallId)
      );
      const fallbackParent =
        sourceIndex > 0
          ? treeNodeByCallId.get(String(originalNodes[sourceIndex - 1].id))
          : root;
      const branchParent =
        branch.fromCallId !== null
          ? treeNodeByCallId.get(String(branch.fromCallId)) ?? fallbackParent
          : fallbackParent;
      const first = data[0];
      first.edgeLabel = branch.label ?? branch.combinationLabel ?? 'Variant';
      (branchParent ?? root).children.push(first);
      for (let index = 1; index < data.length; index++) {
        data[index - 1].children.push(data[index]);
      }
      data[data.length - 1].combinationKey = branch.combinationKey;
    }
    this.labelTreeForks(root, variantLabelById);
    return root;
  }

  private labelTreeForks(
    node: WorkflowTreeDatum,
    variantLabelById: Map<string, string>
  ): Array<[string, string]> | null {
    const childCombinations = node.children.map(child =>
      this.labelTreeForks(child, variantLabelById)
    );
    const available = childCombinations.filter(
      (combination): combination is Array<[string, string]> =>
        combination !== null
    );
    if (
      node.children.length > 1 &&
      available.length === node.children.length
    ) {
      const entryCount = Math.min(
        ...available.map(combination => combination.length)
      );
      for (let index = 0; index < entryCount; index++) {
        const variantIds = new Set(
          available.map(combination => combination[index][1])
        );
        if (variantIds.size <= 1) {
          continue;
        }
        node.children.forEach((child, childIndex) => {
          const variantId = childCombinations[childIndex]?.[index]?.[1];
          if (variantId) {
            child.edgeLabel =
              variantLabelById.get(variantId) ?? child.edgeLabel ?? 'Variant';
          }
        });
        break;
      }
    }
    if (node.combinationKey) {
      return parseCombinationEntries(node.combinationKey);
    }
    return childCombinations.find(combination => combination !== null) ?? null;
  }

  private renderTraceTree(
    graph: HTMLElement,
    treeData: WorkflowTreeDatum,
    activeCombinationKey: string
  ): void {
    const nodeWidth = 220;
    const horizontalStep = 276;
    const verticalGap = 64;
    const padding = 16;
    const root = createTreeLayout<WorkflowTreeDatum>()
      .nodeSize([horizontalStep, 1])(
      hierarchy(treeData, datum => datum.children)
    );
    const nodes = root.descendants();
    const activeLeaf = nodes.find(
      positionedNode =>
        positionedNode.data.combinationKey === activeCombinationKey
    );
    const activePath = new Set<WorkflowTreeDatum>(
      activeLeaf?.ancestors().map(positionedNode => positionedNode.data) ?? []
    );
    const canvas = document.createElement('div');
    canvas.className = 'spx-trace-tree-canvas';
    graph.append(canvas);

    const itemByDatum = new Map<WorkflowTreeDatum, HTMLDivElement>();
    for (const positionedNode of nodes) {
      const datum = positionedNode.data;
      const isActive =
        positionedNode.depth > 0 && activePath.has(positionedNode.data);
      const item = document.createElement('div');
      item.className = 'spx-trace-tree-item';
      if (datum.combinationKey && positionedNode.children === undefined) {
        const activate = (): void => {
          const result = this.onActivateCombination(datum.combinationKey!);
          if (!result.ok) {
            this.renderStatus(result.message, true);
          }
        };
        item.classList.add('spx-trace-tree-leaf');
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.title = 'Apply this variant configuration';
        item.onclick = activate;
        item.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        };
      }
      if (datum.combinationKey === activeCombinationKey) {
        item.classList.add('spx-trace-tree-leaf-active');
        item.setAttribute('aria-current', 'true');
      }
      if (positionedNode.depth > 0) {
        const label = document.createElement('div');
        label.className = datum.edgeLabel
          ? isActive
            ? 'spx-trace-tree-label spx-trace-tree-label-active'
            : 'spx-trace-tree-label'
          : 'spx-trace-tree-label spx-trace-tree-label-empty';
        label.textContent = datum.edgeLabel ?? '';
        item.append(label);
      }
      item.append(
        this.createNode(datum.node, isActive, positionedNode.depth > 0),
        this.createBinPlot(datum.node, isActive)
      );
      canvas.append(item);
      itemByDatum.set(datum, item);
    }

    const depthHeights: number[] = [];
    for (const positionedNode of nodes) {
      const item = itemByDatum.get(positionedNode.data)!;
      depthHeights[positionedNode.depth] = Math.max(
        depthHeights[positionedNode.depth] ?? 0,
        item.offsetHeight
      );
    }
    const depthTops = [padding];
    for (let depth = 1; depth < depthHeights.length; depth++) {
      depthTops[depth] =
        depthTops[depth - 1] + depthHeights[depth - 1] + verticalGap;
    }

    const minimumX = Math.min(...nodes.map(node => node.x));
    const positions = new Map<
      WorkflowTreeDatum,
      { left: number; top: number }
    >();
    let canvasWidth = nodeWidth + padding * 2;
    let canvasHeight = 0;
    for (const positionedNode of nodes) {
      const left = positionedNode.x - minimumX + padding;
      const top = depthTops[positionedNode.depth];
      const item = itemByDatum.get(positionedNode.data)!;
      item.style.left = `${left}px`;
      item.style.top = `${top}px`;
      item.style.visibility = 'visible';
      positions.set(positionedNode.data, { left, top });
      canvasWidth = Math.max(canvasWidth, left + nodeWidth + padding);
      canvasHeight = Math.max(canvasHeight, top + item.offsetHeight + padding);
    }
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    const svgNamespace = 'http://www.w3.org/2000/svg';
    const links = document.createElementNS(svgNamespace, 'svg');
    links.classList.add('spx-trace-tree-links');
    links.setAttribute('width', String(canvasWidth));
    links.setAttribute('height', String(canvasHeight));
    links.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);
    const definitions = document.createElementNS(svgNamespace, 'defs');
    const marker = document.createElementNS(svgNamespace, 'marker');
    marker.setAttribute('id', 'spx-trace-tree-arrow');
    marker.setAttribute('viewBox', '0 0 8 8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto');
    marker.classList.add('spx-trace-tree-marker');
    const arrow = document.createElementNS(svgNamespace, 'path');
    arrow.setAttribute('d', 'M 0 0 L 8 4 L 0 8 Z');
    marker.append(arrow);
    const activeMarker = marker.cloneNode(true) as SVGMarkerElement;
    activeMarker.id = 'spx-trace-tree-arrow-active';
    activeMarker.classList.add('spx-trace-tree-marker-active');
    definitions.append(marker, activeMarker);
    links.append(definitions);

    for (const link of root.links()) {
      this.appendTreeLink(
        links,
        link.source,
        link.target,
        positions,
        itemByDatum,
        activePath.has(link.target.data)
      );
    }
    canvas.prepend(links);
  }

  private appendTreeLink(
    svg: SVGSVGElement,
    source: HierarchyPointNode<WorkflowTreeDatum>,
    target: HierarchyPointNode<WorkflowTreeDatum>,
    positions: Map<WorkflowTreeDatum, { left: number; top: number }>,
    items: Map<WorkflowTreeDatum, HTMLDivElement>,
    isActive: boolean
  ): void {
    const sourcePosition = positions.get(source.data)!;
    const targetPosition = positions.get(target.data)!;
    const sourceItem = items.get(source.data)!;
    const targetItem = items.get(target.data)!;
    const targetCard = targetItem.querySelector<HTMLElement>('.spx-trace-node');
    const sourceX = sourcePosition.left + 110;
    const sourceY = sourcePosition.top + sourceItem.offsetHeight;
    const targetX = targetPosition.left + 110;
    const targetY = targetPosition.top + (targetCard?.offsetTop ?? 0);
    const middleY = sourceY + (targetY - sourceY) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('spx-trace-tree-link');
    if (isActive) {
      path.classList.add('spx-trace-tree-link-active');
    }
    path.setAttribute(
      'd',
      `M ${sourceX} ${sourceY} C ${sourceX} ${middleY}, ${targetX} ${middleY}, ${targetX} ${targetY}`
    );
    path.setAttribute(
      'marker-end',
      isActive
        ? 'url(#spx-trace-tree-arrow-active)'
        : 'url(#spx-trace-tree-arrow)'
    );
    svg.append(path);
  }

  private createNode(
    node: SpaceTimeTraceNode,
    isActive = false,
    showArguments = true
  ): HTMLElement {
    const nodeElement = document.createElement('div');
    nodeElement.className = isActive
      ? 'spx-trace-node spx-trace-node-active'
      : 'spx-trace-node';

    const functionName = document.createElement('div');
    functionName.className = 'spx-trace-function';
    functionName.textContent = node.function;

    const sampleSize = document.createElement('div');
    sampleSize.className = 'spx-trace-sample-size';
    sampleSize.textContent = node.stage
      ? `Sample size: ${node.stage.sampleSize.toLocaleString()}`
      : 'Sample size unavailable';

    nodeElement.append(functionName, sampleSize);
    if (showArguments) {
      const argumentList = document.createElement('div');
      argumentList.className = 'spx-trace-args';
      if (node.arguments.length === 0) {
        const noArgs = document.createElement('span');
        noArgs.className = 'spx-trace-no-args';
        noArgs.textContent = 'no recorded arguments';
        argumentList.append(noArgs);
      } else {
        for (const argument of node.arguments) {
          const argumentElement = document.createElement('div');
          argumentElement.className = 'spx-trace-arg';
          argumentElement.textContent = `${argument.name}: ${formatTraceValue(argument.value)}`;
          argumentList.append(argumentElement);
        }
      }
      nodeElement.append(argumentList);
    }
    return nodeElement;
  }

  private createBinPlot(
    node: SpaceTimeTraceNode,
    isActive = false
  ): HTMLElement {
    const plot = document.createElement('div');
    plot.className = isActive
      ? 'spx-bin-plot spx-bin-plot-active'
      : 'spx-bin-plot';

    const histogram = this.selectedFeature
      ? node.stage?.histograms[this.selectedFeature]
      : undefined;
    if (!histogram || histogram.bins.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spx-bin-plot-empty';
      empty.textContent = this.selectedFeature ? 'No data' : 'No feature selected';
      plot.append(empty);
      return plot;
    }

    const bars = document.createElement('div');
    bars.className = 'spx-bin-bars';
    const maximum = Math.max(...histogram.bins.map(bin => bin.count), 1);
    for (const bin of histogram.bins) {
      const bar = document.createElement('div');
      bar.className = 'spx-bin-bar';
      bar.style.height = `${Math.max(3, (bin.count / maximum) * 100)}%`;
      bar.title = `${bin.label}: ${bin.count}`;
      bars.append(bar);
    }

    const axis = document.createElement('div');
    axis.className = 'spx-bin-axis';
    const firstLabel = document.createElement('span');
    firstLabel.textContent = histogram.bins[0].label;
    const lastLabel = document.createElement('span');
    lastLabel.textContent = histogram.bins[histogram.bins.length - 1].label;
    axis.append(firstLabel, lastLabel);
    plot.append(bars, axis);
    return plot;
  }

  private currentTrace: SpaceTimeTracePayload | null = null;
  private currentSelection: WorkflowTreeSelection | null = null;
  private selectedFeature: string | null = null;
  private readonly content: HTMLDivElement;
}

class SelectionCaptureOverlay {
  constructor(
    private readonly notebooks: INotebookTracker,
    private readonly onCapture: () => CaptureResult,
    private readonly onOpenPanel: () => void,
    private readonly onRefreshPanel: () => void
  ) {
    this.button = document.createElement('button');
    this.button.className = 'spx-selection-button';
    this.button.type = 'button';
    this.button.textContent = 'Variants';
    this.button.onclick = () => {
      const result = this.onCapture();
      this.onOpenPanel();
      this.onRefreshPanel();
      this.hide();
      if (!result.ok) {
        console.warn(result.message);
      }
    };
    document.body.append(this.button);

    document.addEventListener('selectionchange', this.scheduleUpdate);
    document.addEventListener('keyup', this.scheduleUpdate, true);
    document.addEventListener('mouseup', this.scheduleUpdate, true);
    window.addEventListener('resize', this.scheduleUpdate);
  }

  private scheduleUpdate = (): void => {
    window.clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => this.update(), 40);
  };

  private update(): void {
    const context = getActiveEditorContext(this.notebooks);
    if (!context) {
      this.hide();
      return;
    }
    if (!cellContainsWorkflowBuilder(context.cell)) {
      this.hide();
      return;
    }

    const range = normalizeSelection(context.editor);
    if (!range) {
      this.hide();
      return;
    }

    const rect = context.editor.host.getBoundingClientRect();
    this.button.style.top = `${Math.max(8, rect.top + 8)}px`;
    this.button.style.left = `${Math.max(8, rect.right - 92)}px`;
    this.button.classList.add('spx-selection-button-visible');
  }

  private hide(): void {
    this.button.classList.remove('spx-selection-button-visible');
  }

  private updateTimer = 0;
  private readonly button: HTMLButtonElement;
}

const inlineWidgetRefresh = StateEffect.define<void>();

class VariantSelectorWidget extends WidgetType {
  constructor(
    private readonly target: VariantTarget,
    private readonly onApplyVariant: (
      targetId: string,
      variantId: string
    ) => CaptureResult,
    private readonly onOpenPanel: () => void,
    private readonly onRefreshPanel: () => void
  ) {
    super();
  }

  eq(other: VariantSelectorWidget): boolean {
    return (
      other.target.id === this.target.id &&
      other.target.activeVariantId === this.target.activeVariantId &&
      other.target.variants.length === this.target.variants.length
    );
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'spx-inline-widget';

    const activeVariant = this.target.variants.find(
      variant => variant.id === this.target.activeVariantId
    );
    const menuButton = document.createElement('button');
    menuButton.className = 'spx-inline-select';
    menuButton.type = 'button';
    menuButton.title = 'Apply code variant';
    menuButton.textContent = activeVariant?.label ?? 'Variant';
    menuButton.onpointerdown = event => {
      event.stopPropagation();
    };
    menuButton.onmousedown = event => {
      event.stopPropagation();
    };
    menuButton.onclick = event => {
      event.stopPropagation();
      toggleInlineVariantMenu(
        menuButton,
        this.target,
        this.onApplyVariant,
        this.onRefreshPanel
      );
    };

    const editButton = document.createElement('button');
    editButton.className = 'spx-inline-edit';
    editButton.type = 'button';
    editButton.title = 'Open variant panel';
    editButton.textContent = '+';
    editButton.onpointerdown = event => event.stopPropagation();
    editButton.onmousedown = event => event.stopPropagation();
    editButton.onclick = event => {
      event.stopPropagation();
      this.onOpenPanel();
      this.onRefreshPanel();
    };

    container.append(menuButton, editButton);
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function toggleInlineVariantMenu(
  anchor: HTMLElement,
  target: VariantTarget,
  onApplyVariant: (targetId: string, variantId: string) => CaptureResult,
  onRefreshPanel: () => void
): void {
  const existing = document.querySelector<HTMLElement>('.spx-inline-menu');
  if (existing?.dataset.targetId === target.id) {
    existing.remove();
    return;
  }
  existing?.remove();

  const menu = document.createElement('div');
  menu.className = 'spx-inline-menu';
  menu.dataset.targetId = target.id;
  menu.setAttribute('role', 'menu');

  for (const variant of target.variants) {
    const item = document.createElement('button');
    item.className = 'spx-inline-menu-item';
    item.type = 'button';
    item.textContent = variant.label;
    item.setAttribute('role', 'menuitem');
    if (variant.id === target.activeVariantId) {
      item.classList.add('spx-inline-menu-item-active');
    }
    item.onpointerdown = event => {
      event.stopPropagation();
    };
    item.onclick = event => {
      event.stopPropagation();
      onApplyVariant(target.id, variant.id);
      onRefreshPanel();
      menu.remove();
    };
    menu.append(item);
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  document.body.append(menu);

  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) {
      menu.remove();
    }
  };
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      menu.remove();
    }
  };

  window.setTimeout(() => {
    document.addEventListener('pointerdown', closeOnOutsidePointer, {
      capture: true,
      once: true
    });
    document.addEventListener('keydown', closeOnEscape, {
      capture: true,
      once: true
    });
  }, 0);
}

function createInlineVariantExtension(
  cell: Cell,
  editor: CodeEditor.IEditor,
  onApplyVariant: (targetId: string, variantId: string) => CaptureResult,
  onOpenPanel: () => void,
  onRefreshPanel: () => void
) {
  return ViewPlugin.fromClass(
    class InlineVariantPlugin {
      decorations: DecorationSet;

      constructor(private readonly view: EditorView) {
        this.decorations = this.buildDecorations();
        cell.model.metadataChanged.connect(this.onMetadataChanged);
      }

      update(update: ViewUpdate): void {
        const shouldRefresh =
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some(transaction =>
            transaction.effects.some(effect => effect.is(inlineWidgetRefresh))
          );
        if (shouldRefresh) {
          this.decorations = this.buildDecorations();
        }
      }

      destroy(): void {
        cell.model.metadataChanged.disconnect(this.onMetadataChanged);
      }

      private readonly onMetadataChanged = (): void => {
        this.view.dispatch({ effects: inlineWidgetRefresh.of(undefined) });
      };

      private buildDecorations(): DecorationSet {
        if (!cellContainsWorkflowBuilder(cell)) {
          return Decoration.none;
        }

        const ranges: Range<Decoration>[] = [];
        const targets = getTargetsFromCell(cell).sort((left, right) => {
          const leftOffset = editor.getOffsetAt(left.range.start);
          const rightOffset = editor.getOffsetAt(right.range.start);
          return leftOffset - rightOffset;
        });

        for (const target of targets) {
          const from = editor.getOffsetAt(target.range.start);
          const to = editor.getOffsetAt(target.range.end);
          if (from >= to) {
            continue;
          }

          ranges.push(
            Decoration.mark({ class: 'spx-inline-target' }).range(from, to)
          );
          ranges.push(
            Decoration.widget({
              widget: new VariantSelectorWidget(
                target,
                onApplyVariant,
                onOpenPanel,
                onRefreshPanel
              ),
              side: 1
            }).range(to)
          );
        }

        return Decoration.set(ranges, true);
      }
    },
    {
      decorations: plugin => plugin.decorations
    }
  );
}

function ensureInlineVariantWidgets(
  notebooks: INotebookTracker,
  configuredEditors: WeakSet<CodeEditor.IEditor>,
  onApplyVariantForCell: (
    cell: Cell,
    editor: CodeEditor.IEditor,
    targetId: string,
    variantId: string
  ) => CaptureResult,
  onOpenPanel: () => void,
  onRefreshPanel: () => void
): void {
  const cells = notebooks.currentWidget?.content.widgets ?? [];
  for (const cell of cells) {
    const editor = cell.editor;
    if (!editor || configuredEditors.has(editor)) {
      continue;
    }

    editor.injectExtension(
      createInlineVariantExtension(
        cell,
        editor,
        (targetId, variantId) =>
          onApplyVariantForCell(cell, editor, targetId, variantId),
        onOpenPanel,
        onRefreshPanel
      )
    );
    configuredEditors.add(editor);
  }
}

function getActiveEditorContext(notebooks: INotebookTracker):
  | {
      cell: Cell;
      editor: CodeEditor.IEditor;
    }
  | null {
  const cell = notebooks.currentWidget?.content.activeCell;
  const editor = cell?.editor;
  if (!cell || !editor) {
    return null;
  }
  return { cell: cell as Cell, editor };
}

function cellContainsWorkflowBuilder(cell: Cell): boolean {
  return cell.model.sharedModel.getSource().includes(WORKFLOW_MARKER);
}

function normalizeSelection(
  editor: CodeEditor.IEditor
): { start: CodeEditor.IPosition; end: CodeEditor.IPosition } | null {
  const selection = editor.getSelection();
  const startOffset = editor.getOffsetAt(selection.start);
  const endOffset = editor.getOffsetAt(selection.end);
  if (startOffset === endOffset) {
    return null;
  }
  return startOffset < endOffset
    ? { start: selection.start, end: selection.end }
    : { start: selection.end, end: selection.start };
}

function getTargets(notebooks: INotebookTracker): VariantTarget[] {
  const cell = notebooks.currentWidget?.content.activeCell;
  if (!cell) {
    return [];
  }

  return getTargetsFromCell(cell);
}

function getTargetsFromCell(cell: Cell): VariantTarget[] {
  if (!cellContainsWorkflowBuilder(cell)) {
    return [];
  }

  const raw = cell.model.getMetadata(METADATA_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(isVariantTarget);
}

function getTargetsInWorkflowOrder(cell: Cell): VariantTarget[] {
  return getTargetsFromCell(cell).sort((left, right) => {
    const lineDifference = left.range.start.line - right.range.start.line;
    return lineDifference !== 0
      ? lineDifference
      : left.range.start.column - right.range.start.column;
  });
}

function parseCombinationEntries(
  combinationKey: string
): Array<[string, string]> | null {
  try {
    const entries: unknown = JSON.parse(combinationKey);
    if (
      !Array.isArray(entries) ||
      entries.some(
        entry =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          typeof entry[1] !== 'string'
      )
    ) {
      return null;
    }
    return entries as Array<[string, string]>;
  } catch {
    return null;
  }
}

function getVariantCombination(
  cell: Cell,
  useOriginalVariants = false
): VariantCombination {
  const entries = getTargetsInWorkflowOrder(cell).map(target => {
    const variant =
      (useOriginalVariants
        ? target.variants[0]
        : target.variants.find(
            candidate => candidate.id === target.activeVariantId
          )) ?? target.variants[0];
    return {
      targetId: target.id,
      variantId: variant?.id ?? '',
      label: variant?.label ?? 'Original',
      isOriginal: variant === target.variants[0]
    };
  });
  const changedLabels = entries
    .filter(entry => !entry.isOriginal)
    .map(entry => entry.label);
  return {
    key: JSON.stringify(
      entries.map(entry => [entry.targetId, entry.variantId] as const)
    ),
    label: changedLabels.join(' + ') || 'Original',
    isOriginal: changedLabels.length === 0
  };
}

function saveTargets(notebooks: INotebookTracker, targets: VariantTarget[]): boolean {
  const cell = notebooks.currentWidget?.content.activeCell;
  if (!cell) {
    return false;
  }
  return saveTargetsToCell(cell, targets);
}

function saveTargetsToCell(cell: Cell, targets: VariantTarget[]): boolean {
  cell.model.setMetadata(METADATA_KEY, targets);
  return true;
}

function captureSelection(notebooks: INotebookTracker): CaptureResult {
  const context = getActiveEditorContext(notebooks);
  if (!context) {
    return { ok: false, message: 'Open a notebook cell first.' };
  }
  if (!cellContainsWorkflowBuilder(context.cell)) {
    return {
      ok: false,
      message: `Variants are only active for cells containing ${WORKFLOW_MARKER}.`
    };
  }

  const range = normalizeSelection(context.editor);
  if (!range) {
    return { ok: false, message: 'Select some code in the active cell first.' };
  }

  const source = context.editor.model.sharedModel.getSource();
  const startOffset = context.editor.getOffsetAt(range.start);
  const endOffset = context.editor.getOffsetAt(range.end);
  const original = source.slice(startOffset, endOffset);
  const trimmed = original.trim();
  const target: VariantTarget = {
    id: `target-${Date.now()}`,
    label: trimmed.length > 32 ? `${trimmed.slice(0, 32)}...` : trimmed,
    original,
    range: {
      start: toPosition(range.start),
      end: toPosition(range.end)
    },
    variants: [
      {
        id: `variant-${Date.now()}`,
        label: 'Original',
        code: original
      }
    ]
  };

  const targets = getTargetsFromCell(context.cell);
  targets.push(target);
  saveTargetsToCell(context.cell, targets);

  return {
    ok: true,
    message: `Captured ${original.length} character selection.`,
    target
  };
}

function addVariant(
  notebooks: INotebookTracker,
  targetId: string,
  label: string,
  code: string
): CaptureResult {
  const context = getActiveEditorContext(notebooks);
  if (!context || !cellContainsWorkflowBuilder(context.cell)) {
    return {
      ok: false,
      message: `Variants are only active for cells containing ${WORKFLOW_MARKER}.`
    };
  }

  const normalizedCode = code;
  if (!normalizedCode) {
    return { ok: false, message: 'Variant code cannot be empty.' };
  }

  const targets = getTargets(notebooks);
  const target = targets.find(candidate => candidate.id === targetId);
  if (!target) {
    return { ok: false, message: 'Selected target no longer exists.' };
  }

  const variant: CodeVariant = {
    id: `variant-${Date.now()}`,
    label: label.trim() || `Variant ${target.variants.length + 1}`,
    code: normalizedCode
  };
  target.variants.push(variant);
  saveTargets(notebooks, targets);

  return { ok: true, message: `Added ${variant.label}.`, target };
}

function deleteVariant(
  notebooks: INotebookTracker,
  targetId: string,
  variantId: string
): CaptureResult {
  const context = getActiveEditorContext(notebooks);
  if (!context || !cellContainsWorkflowBuilder(context.cell)) {
    return {
      ok: false,
      message: `Variants are only active for cells containing ${WORKFLOW_MARKER}.`
    };
  }

  const targets = getTargetsFromCell(context.cell);
  const target = targets.find(candidate => candidate.id === targetId);
  const variantIndex = target?.variants.findIndex(
    candidate => candidate.id === variantId
  );
  if (!target || variantIndex === undefined || variantIndex < 0) {
    return { ok: false, message: 'Variant was not found.' };
  }

  const variant = target.variants[variantIndex];
  const original = target.variants[0];
  if (variantIndex === 0 && variant.code === target.original) {
    return { ok: false, message: 'The Original variant cannot be deleted.' };
  }

  if (target.activeVariantId === variant.id) {
    const restore = applyVariantToCell(
      context.cell,
      context.editor,
      target.id,
      original.id
    );
    if (!restore.ok) {
      return restore;
    }
    const restoredTargets = getTargetsFromCell(context.cell);
    const restoredTarget = restoredTargets.find(
      candidate => candidate.id === targetId
    );
    const restoredVariantIndex = restoredTarget?.variants.findIndex(
      candidate => candidate.id === variantId
    );
    if (
      !restoredTarget ||
      restoredVariantIndex === undefined ||
      restoredVariantIndex < 0
    ) {
      return { ok: false, message: 'Variant was not found after restoring.' };
    }
    restoredTarget.variants.splice(restoredVariantIndex, 1);
    saveTargetsToCell(context.cell, restoredTargets);
    return {
      ok: true,
      message: `Deleted ${variant.label} and restored Original.`,
      target: restoredTarget
    };
  }

  target.variants.splice(variantIndex, 1);
  saveTargetsToCell(context.cell, targets);
  return {
    ok: true,
    message: `Deleted ${variant.label}.`,
    target
  };
}

function applyVariant(
  notebooks: INotebookTracker,
  targetId: string,
  variantId: string
): CaptureResult {
  const context = getActiveEditorContext(notebooks);
  if (!context) {
    return { ok: false, message: 'Open a notebook cell first.' };
  }
  if (!cellContainsWorkflowBuilder(context.cell)) {
    return {
      ok: false,
      message: `Variants are only active for cells containing ${WORKFLOW_MARKER}.`
    };
  }
  return applyVariantToCell(context.cell, context.editor, targetId, variantId);
}

function applyVariantToCell(
  cell: Cell,
  editor: CodeEditor.IEditor,
  targetId: string,
  variantId: string
): CaptureResult {
  const targets = getTargetsInWorkflowOrder(cell);
  const target = targets.find(candidate => candidate.id === targetId);
  const variant = target?.variants.find(candidate => candidate.id === variantId);
  if (!target || !variant) {
    return { ok: false, message: 'Variant target was not found.' };
  }
  const combinationKey = JSON.stringify(
    targets.map(candidate => {
      const activeVariant =
        candidate.id === targetId
          ? variant
          : candidate.variants.find(
              option => option.id === candidate.activeVariantId
            ) ?? candidate.variants[0];
      return [candidate.id, activeVariant.id] as const;
    })
  );
  const result = applyVariantCombinationToCell(cell, editor, combinationKey);
  return result.ok
    ? { ...result, message: `Applied ${variant.label}.`, target }
    : result;
}

function applyVariantCombinationToCell(
  cell: Cell,
  editor: CodeEditor.IEditor,
  combinationKey: string
): CaptureResult {
  let entries: unknown;
  try {
    entries = JSON.parse(combinationKey);
  } catch {
    return { ok: false, message: 'The selected configuration is invalid.' };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, message: 'The selected configuration is invalid.' };
  }

  const variantIdByTargetId = new Map<string, string>();
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string'
    ) {
      return { ok: false, message: 'The selected configuration is invalid.' };
    }
    variantIdByTargetId.set(entry[0], entry[1]);
  }

  const targets = getTargetsInWorkflowOrder(cell);
  if (targets.length === 0 || variantIdByTargetId.size !== targets.length) {
    return {
      ok: false,
      message: 'This configuration no longer matches the notebook targets.'
    };
  }
  const replacements = targets.map(target => {
    const variantId = variantIdByTargetId.get(target.id);
    const variant = target.variants.find(candidate => candidate.id === variantId);
    return { target, variant };
  });
  if (replacements.some(replacement => !replacement.variant)) {
    return {
      ok: false,
      message: 'A variant from this configuration is no longer available.'
    };
  }

  const source = editor.model.sharedModel.getSource();
  const ranges = replacements.map(replacement => ({
    ...replacement,
    startOffset: editor.getOffsetAt(replacement.target.range.start),
    endOffset: editor.getOffsetAt(replacement.target.range.end)
  }));
  let cursor = 0;
  let updatedSource = '';
  const updatedOffsets: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    if (range.startOffset < cursor || range.endOffset < range.startOffset) {
      return { ok: false, message: 'Variant target ranges overlap or are stale.' };
    }
    updatedSource += source.slice(cursor, range.startOffset);
    const start = updatedSource.length;
    updatedSource += range.variant!.code;
    updatedOffsets.push({ start, end: updatedSource.length });
    cursor = range.endOffset;
  }
  updatedSource += source.slice(cursor);
  editor.model.sharedModel.setSource(updatedSource);

  replacements.forEach((replacement, index) => {
    replacement.target.activeVariantId = replacement.variant!.id;
    const start = editor.getPositionAt(updatedOffsets[index].start);
    const end = editor.getPositionAt(updatedOffsets[index].end);
    if (start && end) {
      replacement.target.range = {
        start: toPosition(start),
        end: toPosition(end)
      };
    }
  });
  saveTargetsToCell(cell, targets);
  editor.focus();
  return {
    ok: true,
    message: 'Applied workflow variant configuration.',
    target: targets[targets.length - 1]
  };
}

function toPosition(position: CodeEditor.IPosition): Position {
  return {
    line: position.line,
    column: position.column
  } as Position;
}

function isVariantTarget(value: unknown): value is VariantTarget {
  const candidate = value as VariantTarget;
  return (
    typeof candidate?.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.original === 'string' &&
    Array.isArray(candidate.variants) &&
    typeof candidate.range?.start?.line === 'number' &&
    typeof candidate.range?.start?.column === 'number' &&
    typeof candidate.range?.end?.line === 'number' &&
    typeof candidate.range?.end?.column === 'number'
  );
}

function highlightActiveEditorLine(notebooks: INotebookTracker): void {
  const activeCell = notebooks.currentWidget?.content.activeCell;
  if (!activeCell) {
    return;
  }

  const line =
    activeCell.node.querySelector<HTMLElement>('.cm-line') ??
    activeCell.node.querySelector<HTMLElement>('.jp-InputArea-editor');

  if (!line) {
    return;
  }

  line.classList.add('spx-line-highlight');
  window.setTimeout(() => {
    line.classList.remove('spx-line-highlight');
  }, 1600);
}

async function runKernelProbe(notebooks: INotebookTracker): Promise<string> {
  const kernel = notebooks.currentWidget?.sessionContext.session?.kernel;
  if (!kernel) {
    return 'No active notebook kernel.';
  }

  const future = kernel.requestExecute({
    code: "print('spacetimpepy kernel probe ok')",
    silent: false,
    stop_on_error: true,
    store_history: false
  });

  const chunks: string[] = [];
  future.onIOPub = msg => {
    if (KernelMessage.isStreamMsg(msg)) {
      chunks.push(msg.content.text);
    } else if (KernelMessage.isExecuteResultMsg(msg)) {
      const data = msg.content.data;
      const text = data['text/plain'];
      if (typeof text === 'string') {
        chunks.push(text);
      }
    } else if (KernelMessage.isErrorMsg(msg)) {
      chunks.push(msg.content.traceback.join('\n'));
    }
  };

  try {
    await future.done;
  } catch (reason) {
    return `Kernel probe failed: ${String(reason)}`;
  }

  return chunks.join('').trim() || 'Kernel probe completed.';
}

async function fetchSpaceTimeTrace(
  panel: NotebookPanel
): Promise<SpaceTimeTracePayload> {
  const kernel = panel.sessionContext.session?.kernel;
  if (!kernel) {
    return {
      loaded: false,
      error: 'No active notebook kernel.',
      features: [],
      nodes: []
    };
  }

  const future = kernel.requestExecute({
    code: TRACE_QUERY_CODE,
    silent: false,
    stop_on_error: true,
    store_history: false
  });

  const chunks: string[] = [];
  future.onIOPub = msg => {
    if (KernelMessage.isStreamMsg(msg)) {
      chunks.push(msg.content.text);
    } else if (KernelMessage.isExecuteResultMsg(msg)) {
      const text = msg.content.data['text/plain'];
      if (typeof text === 'string') {
        chunks.push(text);
      }
    }
  };

  try {
    await future.done;
  } catch (reason) {
    return {
      loaded: false,
      error: `Trace query failed: ${String(reason)}`,
      features: [],
      nodes: []
    };
  }

  const output = chunks.join('').trim();
  const jsonLine = output
    .split(/\r?\n/)
    .find(line => line.startsWith(TRACE_JSON_PREFIX));
  if (!jsonLine) {
    return {
      loaded: false,
      error: 'Trace query did not return a SpaceTime JSON payload.',
      features: [],
      nodes: []
    };
  }

  try {
    return JSON.parse(
      jsonLine.slice(TRACE_JSON_PREFIX.length)
    ) as SpaceTimeTracePayload;
  } catch (reason) {
    return {
      loaded: false,
      error: `Could not parse SpaceTime trace payload: ${String(reason)}`,
      features: [],
      nodes: []
    };
  }
}

async function persistSpaceTimeBaseline(
  panel: NotebookPanel,
  combination: VariantCombination
): Promise<boolean> {
  const kernel = panel.sessionContext.session?.kernel;
  if (!kernel) {
    return false;
  }
  const payload = JSON.stringify(
    JSON.stringify({
      combinationKey: combination.key,
      combinationLabel: combination.label
    })
  );
  const future = kernel.requestExecute({
    code: String.raw`
import json
import sys

payload = json.loads(${payload})
if "spacetimepy" in sys.modules:
    from spacetimepy.core.models import MonitoringSession
    from spacetimepy.core.monitoring import SpaceTimeMonitor

    monitor = SpaceTimeMonitor.get_instance()
    if monitor is not None and getattr(monitor, "session", None) is not None:
        db_session = monitor.session
        monitoring_session = getattr(monitor, "current_session", None)
        if monitoring_session is None:
            monitoring_session = (
                db_session.query(MonitoringSession)
                .order_by(MonitoringSession.start_time.desc())
                .first()
            )
        if monitoring_session is not None:
            metadata = dict(monitoring_session.session_metadata or {})
            metadata["spx_jupyter_baseline"] = payload
            monitoring_session.session_metadata = metadata
            db_session.commit()
`,
    silent: true,
    stop_on_error: true,
    store_history: false
  });
  try {
    await future.done;
    return true;
  } catch {
    return false;
  }
}

function createVariantReexecutionRequest(
  cell: Cell,
  target: VariantTarget,
  baselineCombinationKey: string
): VariantReexecutionRequest | null {
  const targets = getTargetsInWorkflowOrder(cell);
  const activeTargets = targets.map(candidate => {
    const variant =
      candidate.variants.find(
        option => option.id === candidate.activeVariantId
      ) ?? candidate.variants[0];
    return { target: candidate, variant };
  });
  if (
    !activeTargets.some(candidate => candidate.target.id === target.id) ||
    activeTargets.some(candidate => !candidate.variant)
  ) {
    return null;
  }

  const combination = getVariantCombination(cell);
  return {
    source: cell.model.sharedModel.getSource(),
    targets: activeTargets.map(candidate => ({
      targetId: candidate.target.id,
      variantId: candidate.variant!.id,
      variantLabel: candidate.variant!.label,
      range: candidate.target.range
    })),
    combinationKey: combination.key,
    combinationLabel: combination.label,
    baselineCombinationKey,
    originalCombinationKey: getVariantCombination(cell, true).key
  };
}

async function reexecuteVariantFromCheckpoint(
  panel: NotebookPanel,
  request: VariantReexecutionRequest
): Promise<VariantReexecutionResult> {
  const kernel = panel.sessionContext.session?.kernel;
  if (!kernel) {
    return { ok: false, error: 'No active notebook kernel.' };
  }

  const future = kernel.requestExecute({
    code: buildReexecutionCode(request),
    silent: false,
    stop_on_error: true,
    store_history: false
  });
  const chunks: string[] = [];
  future.onIOPub = msg => {
    if (KernelMessage.isStreamMsg(msg)) {
      chunks.push(msg.content.text);
    } else if (KernelMessage.isExecuteResultMsg(msg)) {
      const text = msg.content.data['text/plain'];
      if (typeof text === 'string') {
        chunks.push(text);
      }
    } else if (KernelMessage.isErrorMsg(msg)) {
      chunks.push(msg.content.traceback.join('\n'));
    }
  };

  try {
    await future.done;
  } catch (reason) {
    return { ok: false, error: `Variant replay failed: ${String(reason)}` };
  }

  const jsonLine = chunks
    .join('')
    .split(/\r?\n/)
    .find(line => line.startsWith(REEXECUTE_JSON_PREFIX));
  if (!jsonLine) {
    return {
      ok: false,
      error: 'Variant replay did not return a SpaceTime JSON payload.'
    };
  }

  try {
    return JSON.parse(
      jsonLine.slice(REEXECUTE_JSON_PREFIX.length)
    ) as VariantReexecutionResult;
  } catch (reason) {
    return {
      ok: false,
      error: `Could not parse variant replay result: ${String(reason)}`
    };
  }
}

function findNotebookPanel(
  notebooks: INotebookTracker,
  notebook: unknown
): NotebookPanel | null {
  let match: NotebookPanel | null = null;
  notebooks.forEach(panel => {
    if (panel.content === notebook) {
      match = panel;
    }
  });
  return match;
}

function findNotebookPanelForCell(
  notebooks: INotebookTracker,
  cell: Cell
): NotebookPanel | null {
  let match: NotebookPanel | null = null;
  notebooks.forEach(panel => {
    if (panel.content.widgets.includes(cell)) {
      match = panel;
    }
  });
  return match;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    notebooks: INotebookTracker,
    palette: ICommandPalette | null
  ) => {
    let panel: ExplorerPanel;
    let webView: SpaceTimeWebView | null = null;
    let webViewCell: Cell | null = null;
    let activateGraphCombination = (_combinationKey: string): CaptureResult => ({
      ok: false,
      message: 'No workflow notebook is associated with this graph.'
    });
    const configuredEditors = new WeakSet<CodeEditor.IEditor>();
    const replayQueues = new WeakMap<NotebookPanel, Promise<void>>();
    const baselineCombinations = new WeakMap<
      NotebookPanel,
      VariantCombination
    >();

    const openPanel = (): void => {
      if (!panel.isAttached) {
        app.shell.add(panel, 'left', { rank: 650 });
      }
      app.shell.activateById(panel.id);
    };

    const refreshPanel = (): void => {
      panel.refresh();
    };

    const openWebView = (
      trace?: SpaceTimeTracePayload,
      cell?: Cell
    ): void => {
      if (cell) {
        webViewCell = cell;
      }
      if (!webView || webView.isDisposed) {
        webView = new SpaceTimeWebView(combinationKey =>
          activateGraphCombination(combinationKey)
        );
      }
      if (!webView.isAttached) {
        app.shell.add(webView, 'right', { rank: 650 });
      }
      app.shell.activateById(webView.id);
      if (trace) {
        const contextCell = cell ?? webViewCell;
        if (!contextCell) {
          webView.renderStatus(
            'No workflow notebook is associated with this trace.',
            true
          );
          return;
        }
        const activeCombination = getVariantCombination(contextCell);
        const originalCombination = getVariantCombination(contextCell, true);
        const notebookPanel = findNotebookPanelForCell(notebooks, contextCell);
        const rememberedBaseline = notebookPanel
          ? baselineCombinations.get(notebookPanel)
          : undefined;
        const baselineCombinationKey =
          trace.baselineCombinationKey ??
          rememberedBaseline?.key ??
          originalCombination.key;
        const baselineCombinationLabel =
          trace.baselineCombinationLabel ??
          rememberedBaseline?.label ??
          (baselineCombinationKey === originalCombination.key
            ? 'Original'
            : 'Baseline');
        if (notebookPanel) {
          baselineCombinations.set(notebookPanel, {
            key: baselineCombinationKey,
            label: baselineCombinationLabel,
            isOriginal: baselineCombinationKey === originalCombination.key
          });
        }
        const variantLabelById = new Map<string, string>();
        for (const target of getTargetsInWorkflowOrder(contextCell)) {
          for (const variant of target.variants) {
            variantLabelById.set(variant.id, variant.label);
          }
        }
        webView.renderTrace(trace, {
          activeCombinationKey: activeCombination.key,
          baselineCombinationKey,
          baselineCombinationLabel,
          variantLabelById
        });
      }
    };

    const scheduleVariantReplay = (
      cell: Cell,
      result: CaptureResult
    ): void => {
      if (!result.ok || !result.target) {
        return;
      }
      const notebookPanel = findNotebookPanelForCell(notebooks, cell);
      if (!notebookPanel) {
        return;
      }
      const request = createVariantReexecutionRequest(
        cell,
        result.target,
        baselineCombinations.get(notebookPanel)?.key ??
          getVariantCombination(cell, true).key
      );
      if (!request) {
        return;
      }

      openWebView(undefined, cell);
      webView?.renderStatus('Resolving workflow variant combination...');
      const previous = replayQueues.get(notebookPanel) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const replay = await reexecuteVariantFromCheckpoint(
            notebookPanel,
            request
          );
          if (!replay.ok) {
            openWebView();
            webView?.renderStatus(
              replay.error ?? 'Variant replay failed.',
              true
            );
            return;
          }

          const trace = await fetchSpaceTimeTrace(notebookPanel);
          openWebView(trace, cell);
        });
      replayQueues.set(notebookPanel, next);
    };

    activateGraphCombination = (combinationKey: string): CaptureResult => {
      const cell = webViewCell;
      const editor = cell?.editor;
      if (!cell || !editor) {
        return {
          ok: false,
          message: 'The workflow notebook is no longer available.'
        };
      }
      const result = applyVariantCombinationToCell(
        cell,
        editor,
        combinationKey
      );
      refreshPanel();
      if (result.ok) {
        scheduleVariantReplay(cell, result);
      }
      return result;
    };

    const ensureInline = (): void => {
      ensureInlineVariantWidgets(
        notebooks,
        configuredEditors,
        (cell, editor, targetId, variantId) => {
          const result = applyVariantToCell(cell, editor, targetId, variantId);
          refreshPanel();
          scheduleVariantReplay(cell, result);
          return result;
        },
        openPanel,
        refreshPanel
      );
    };

    panel = new ExplorerPanel({
      onAddVariant: (targetId, label, code) => {
        const result = addVariant(notebooks, targetId, label, code);
        ensureInline();
        return result;
      },
      onApplyVariant: (targetId, variantId) => {
        const context = getActiveEditorContext(notebooks);
        const result = applyVariant(notebooks, targetId, variantId);
        refreshPanel();
        if (context) {
          scheduleVariantReplay(context.cell, result);
        }
        return result;
      },
      onCaptureSelection: () => {
        const result = captureSelection(notebooks);
        ensureInline();
        return result;
      },
      onDeleteVariant: (targetId, variantId) => {
        const result = deleteVariant(notebooks, targetId, variantId);
        refreshPanel();
        return result;
      },
      onGetTargets: () => getTargets(notebooks),
      onHighlightLine: () => highlightActiveEditorLine(notebooks),
      onKernelProbe: () => runKernelProbe(notebooks)
    });

    app.shell.add(panel, 'left', { rank: 650 });
    ensureInline();

    new SelectionCaptureOverlay(
      notebooks,
      () => {
        const result = captureSelection(notebooks);
        ensureInline();
        return result;
      },
      openPanel,
      refreshPanel
    );

    notebooks.currentChanged.connect(() => {
      refreshPanel();
      ensureInline();
    });
    notebooks.activeCellChanged.connect(() => {
      refreshPanel();
      ensureInline();
    });

    NotebookActions.executed.connect(async (_, args) => {
      if (!args.success || !cellContainsWorkflowBuilder(args.cell)) {
        return;
      }

      const notebookPanel = findNotebookPanel(notebooks, args.notebook);
      if (!notebookPanel) {
        return;
      }

      const baselineCombination = getVariantCombination(args.cell);
      baselineCombinations.set(notebookPanel, baselineCombination);
      await persistSpaceTimeBaseline(notebookPanel, baselineCombination);
      const trace = await fetchSpaceTimeTrace(notebookPanel);
      if (trace.loaded) {
        openWebView(trace, args.cell);
      }
    });

    app.commands.addCommand(OPEN_COMMAND, {
      label: 'Open Exploratory Controls',
      execute: openPanel
    });

    app.commands.addCommand(CAPTURE_COMMAND, {
      label: 'Capture Selected Code as Variant Target',
      execute: () => {
        const result = captureSelection(notebooks);
        ensureInline();
        refreshPanel();
        openPanel();
        return result.message;
      }
    });

    palette?.addItem({
      command: OPEN_COMMAND,
      category: 'Notebook Tools'
    });
    palette?.addItem({
      command: CAPTURE_COMMAND,
      category: 'Notebook Tools'
    });
  }
};

export default plugin;
