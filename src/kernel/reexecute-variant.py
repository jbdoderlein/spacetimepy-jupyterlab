import ast
import json
import sys

# __SPX_WORKFLOW_SUMMARY__

request = json.loads(__SPX_REQUEST_JSON__)
result = {"ok": False}


class _SpxCombinationReuse(Exception):
    def __init__(self, branch_id=None, branch_from_step_id=None, step_ids=None):
        self.branch_id = branch_id
        self.branch_from_step_id = branch_from_step_id
        self.step_ids = step_ids or []


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


def _spx_call_name(call):
    return call.qualified_name or call.function_name


def _spx_matches(call, method_name):
    name = _spx_call_name(call)
    return name == method_name or name.endswith("." + method_name)


def _spx_step_call(space, step):
    if step.function_call is not None:
        return step.function_call
    if step.stack_snapshot is not None:
        return space.data.get_function_call(step.stack_snapshot.function_call_id)
    return None


def _spx_evaluate_arguments(call, namespace):
    args = []
    kwargs = {}
    for argument in call.args:
        if isinstance(argument, ast.Starred):
            args.extend(
                eval(
                    compile(
                        ast.Expression(argument.value),
                        "<variant-replay>",
                        "eval",
                    ),
                    namespace,
                    namespace,
                )
            )
        else:
            args.append(
                eval(
                    compile(
                        ast.Expression(argument),
                        "<variant-replay>",
                        "eval",
                    ),
                    namespace,
                    namespace,
                )
            )
    for keyword in call.keywords:
        value = eval(
            compile(
                ast.Expression(keyword.value),
                "<variant-replay>",
                "eval",
            ),
            namespace,
            namespace,
        )
        if keyword.arg is None:
            kwargs.update(value)
        else:
            kwargs[keyword.arg] = value
    return args, kwargs


def _spx_combination_entries(key):
    try:
        entries = json.loads(key)
        if not isinstance(entries, list):
            return []
        return [tuple(entry) for entry in entries]
    except Exception:
        return []


try:
    if "spacetimepy" not in sys.modules:
        raise RuntimeError("SpaceTimePy is not loaded in this kernel.")

    from IPython import get_ipython
    from spacetimepy import get_active_spacetime

    space = get_active_spacetime()
    if space is None:
        raise RuntimeError("There is no active SpaceTime runtime.")
    space.commit()

    sessions = space.data.list_sessions()
    if not sessions:
        raise RuntimeError("There is no SpaceTime execution session.")
    session = sessions[-1]
    branches = [
        space.data.get_branch(summary.id)
        for summary in session.branches
    ]
    root = next(
        (branch for branch in branches if branch.parent_branch_id is None),
        None,
    )
    if root is None:
        raise RuntimeError("The latest SpaceTime session has no root branch.")

    baseline_combination_key = (
        request.get("baselineCombinationKey")
        or request.get("originalCombinationKey")
    )
    desired_combination_key = request.get("combinationKey")
    if desired_combination_key == baseline_combination_key:
        raise _SpxCombinationReuse(
            str(root.id),
            None,
            [step.id for step in root.steps],
        )

    cached_branch = next(
        (
            branch
            for branch in branches
            if branch.status == "completed"
            and branch.configuration_key == desired_combination_key
        ),
        None,
    )
    if cached_branch is not None:
        parent_path = space.data.get_branch(
            cached_branch.parent_branch_id,
            resolve=True,
        ).steps
        fork_index = next(
            (
                index
                for index, step in enumerate(parent_path)
                if step.id == cached_branch.forked_from_step_id
            ),
            None,
        )
        branch_from_step_id = (
            parent_path[fork_index - 1].id
            if fork_index is not None and fork_index > 0
            else None
        )
        raise _SpxCombinationReuse(
            str(cached_branch.id),
            branch_from_step_id,
            [step.id for step in cached_branch.steps],
        )

    desired_entries = _spx_combination_entries(desired_combination_key)
    candidates = [(baseline_combination_key, root)]
    candidates.extend(
        (branch.configuration_key, branch)
        for branch in branches
        if branch.status == "completed"
        and branch.configuration_key
        and branch.configuration_key != desired_combination_key
    )
    replay_parent_combination_key = baseline_combination_key
    replay_parent_branch = root
    replay_target_index = 0
    for combination_key, branch in candidates:
        candidate_entries = _spx_combination_entries(combination_key)
        prefix_length = 0
        for desired_entry, candidate_entry in zip(
            desired_entries,
            candidate_entries,
        ):
            if desired_entry != candidate_entry:
                break
            prefix_length += 1
        if prefix_length > replay_target_index:
            replay_parent_combination_key = combination_key
            replay_parent_branch = branch
            replay_target_index = prefix_length

    replay_targets = request.get("targets") or []
    if replay_target_index >= len(replay_targets):
        raise RuntimeError(
            "Could not identify the first variant location requiring replay."
        )
    replay_target = replay_targets[replay_target_index]
    branch_label = replay_target.get("variantLabel") or "Variant"

    source = request["source"]
    tree = ast.parse(source)
    point_line = int(replay_target["range"]["start"]["line"]) + 1
    point_column = int(replay_target["range"]["start"]["column"])
    source_calls = sorted(
        [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and _spx_method_name(node)
        ],
        key=lambda node: (
            node.end_lineno,
            node.end_col_offset,
            node.lineno,
            node.col_offset,
        ),
    )
    enclosing_calls = [
        call
        for call in source_calls
        if any(
            _spx_contains(value, point_line, point_column)
            for value in [
                *call.args,
                *[keyword.value for keyword in call.keywords],
            ]
        )
    ]
    if not enclosing_calls:
        raise ValueError(
            "The variant must select code inside a method-call argument."
        )
    target_source_call = min(
        enclosing_calls,
        key=lambda call: (
            call.end_lineno - call.lineno,
            call.end_col_offset - call.col_offset,
        ),
    )
    target_method = _spx_method_name(target_source_call)

    selected_keyword = next(
        (
            keyword.arg
            for keyword in target_source_call.keywords
            if keyword.arg
            and _spx_contains(keyword.value, point_line, point_column)
        ),
        None,
    )
    selected_position = next(
        (
            index
            for index, value in enumerate(target_source_call.args)
            if _spx_contains(value, point_line, point_column)
        ),
        None,
    )
    if selected_keyword is None and selected_position is None:
        raise ValueError("Could not identify the changed function argument.")

    source_occurrence = sum(
        1
        for call in source_calls
        if _spx_method_name(call) == target_method
        and (call.end_lineno, call.end_col_offset)
        < (target_source_call.end_lineno, target_source_call.end_col_offset)
    )
    parent_path = space.data.get_branch(
        replay_parent_branch.id,
        resolve=True,
    ).steps
    matching_steps = []
    for step in parent_path:
        call = _spx_step_call(space, step)
        if call is not None and _spx_matches(call, target_method):
            matching_steps.append(step)
    if source_occurrence >= len(matching_steps):
        raise LookupError(
            f"No recorded {target_method} step matches this cell expression."
        )
    fork_step = matching_steps[source_occurrence]
    fork_index = next(
        index for index, step in enumerate(parent_path) if step.id == fork_step.id
    )
    branch_from_step_id = (
        parent_path[fork_index - 1].id if fork_index > 0 else None
    )

    parents = {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }
    replay_chain = [target_source_call]
    chain_call = target_source_call
    while True:
        attribute = parents.get(chain_call)
        outer_call = (
            parents.get(attribute) if isinstance(attribute, ast.Attribute) else None
        )
        if not (
            isinstance(attribute, ast.Attribute)
            and isinstance(outer_call, ast.Call)
            and outer_call.func is attribute
        ):
            break
        replay_chain.append(outer_call)
        chain_call = outer_call

    assigned_names = set()
    assignment = parents.get(chain_call)
    if isinstance(assignment, ast.Assign) and assignment.value is chain_call:
        assignment_targets = assignment.targets
    elif isinstance(assignment, ast.AnnAssign) and assignment.value is chain_call:
        assignment_targets = [assignment.target]
    else:
        assignment_targets = []
    for assignment_target in assignment_targets:
        assigned_names.update(
            node.id
            for node in ast.walk(assignment_target)
            if isinstance(node, ast.Name)
        )
    terminal_execution_call = next(
        (
            call
            for call in ast.walk(tree)
            if (
                isinstance(call, ast.Call)
                and isinstance(call.func, ast.Attribute)
                and call.func.attr == "execute_workflow"
                and isinstance(call.func.value, ast.Name)
                and call.func.value.id in assigned_names
                and (call.lineno, call.col_offset)
                > (chain_call.lineno, chain_call.col_offset)
            )
        ),
        None,
    )

    user_namespace = get_ipython().user_ns

    def _spx_execute(context):
        live_receiver = context.locals.get("self")
        if live_receiver is None:
            raise RuntimeError(
                f"The recorded {target_method} step has no rehydratable self "
                "checkpoint."
            )
        for source_call in replay_chain:
            method_name = _spx_method_name(source_call)
            function = getattr(live_receiver, method_name)
            args, kwargs = _spx_evaluate_arguments(source_call, user_namespace)
            call_result = function(*args, **kwargs)
            if call_result is not None:
                live_receiver = call_result

        if terminal_execution_call is not None:
            execution_method_name = terminal_execution_call.func.attr
            execution_function = getattr(live_receiver, execution_method_name)
            execution_args, execution_kwargs = _spx_evaluate_arguments(
                terminal_execution_call,
                user_namespace,
            )
            execution_result = execution_function(
                *execution_args,
                **execution_kwargs,
            )
            if execution_result is not None:
                live_receiver = execution_result
        return live_receiver

    replay = space.replay.run(
        _spx_execute,
        parent_branch_id=replay_parent_branch.id,
        forked_from_step_id=fork_step.id,
        name=branch_label,
        configuration_key=desired_combination_key,
        recipe={
            "integration": "spacetimepy-jupyterlab",
            "targets": replay_targets,
        },
        attributes={
            "spx_combination_label": request.get("combinationLabel"),
            "spx_parent_combination_key": replay_parent_combination_key,
            "spx_stage_start_index": fork_index,
        },
    )
    workflow_stages = _spx_summarize_workflow(replay.value)
    if workflow_stages:
        space.capture.annotate_branch(
            replay.branch.id,
            {"spx_workflow_stages": workflow_stages},
        )
    result = {
        "ok": True,
        "branchId": str(replay.branch.id),
        "branchFromStepId": branch_from_step_id,
        "stepIds": [step.id for step in replay.branch.steps],
    }
except _SpxCombinationReuse as reused:
    result = {
        "ok": True,
        "reused": True,
        "branchId": reused.branch_id,
        "branchFromStepId": reused.branch_from_step_id,
        "stepIds": reused.step_ids,
    }
except Exception as exc:
    result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

print("__SPX_REEXECUTE_JSON_PREFIX__" + json.dumps(result, default=str))
