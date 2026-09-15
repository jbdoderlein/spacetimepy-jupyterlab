import json
from IPython import get_ipython
from spacetimepy import get_active_spacetime
from sampling_mining_workflows_dsl.live import execute_suffix
from sampling_mining_workflows_dsl.operator.OperatorBuilder import OperatorBuilder

# __SPX_WORKFLOW_SUMMARY__
# __SPX_LIVE_SOURCE__

request = json.loads(__SPX_REQUEST_JSON__)
result = {"ok": False}
try:
    space = get_active_spacetime()
    if space is None:
        raise RuntimeError("There is no active SpaceTime runtime.")
    parent = space.data.get_branch(int(request["branchId"]))
    source = request["source"]
    name, calls, descriptions, skeleton = _spx_parse(source)
    namespace = get_ipython().user_ns
    if request["action"] == "attach":
        if not parent.attributes.get("spx_live") or parent.status != "completed":
            raise ValueError("The cell has no completed live recording.")
        workflow = namespace[name]
        stages = _spx_summarize_workflow(workflow)
        if len(parent.steps) != len(calls) + 1:
            raise ValueError("The source does not match the recorded operator count.")
        space.capture.annotate_branch(parent.id, {
            "spx_source": source, "spx_operators": descriptions,
            "spx_workflow_stages": stages, "spx_stage_start_index": 0,
            "spx_stage_step_ids": [step.id for step in parent.steps[:-1]],
            "spx_terminal_step_id": parent.steps[-1].id,
        })
        result = {"ok": True, "branchId": str(parent.id)}
    else:
        _, old_calls, old_descriptions, old_skeleton = _spx_parse(parent.attributes["spx_source"])
        if skeleton != old_skeleton:
            raise ValueError("Keep the workflow variable, builder, input, and output fixed.")
        start = 0
        while (start < min(len(old_descriptions), len(descriptions))
               and old_descriptions[start] == descriptions[start]):
            start += 1
        if start == len(old_calls) == len(calls):
            # Keep the saved formatting without creating an execution branch.
            space.capture.annotate_branch(parent.id, {"spx_source": source})
            result = {"ok": True, "branchId": str(parent.id), "reused": True}
        else:
            stage_ids = parent.attributes["spx_stage_step_ids"]
            checkpoint_id = (stage_ids[start] if start < len(old_calls)
                             else parent.attributes["spx_terminal_step_id"])

            def execute(context):
                workflow = context.locals["workflow"]
                previous = workflow.get_operator_by_position(start - 1)
                saved_output = previous._output if previous else None
                if previous is None:
                    workflow._root = None
                else:
                    previous._next_operator = None
                workflow._last_operator = previous
                builder = OperatorBuilder(workflow)
                for call in calls[start:]:
                    args, kwargs = _spx_arguments(call, namespace)
                    getattr(builder, call.func.attr)(*args, **kwargs)
                if previous is not None:
                    previous._output = saved_output
                workflow.output(workflow._output_writer)
                return execute_suffix(workflow, start)

            replay = space.replay.run(
                execute, parent_branch_id=parent.id,
                forked_from_step_id=checkpoint_id, name=f"Edit operator {start + 1}",
                attributes={"spx_source": source, "spx_operators": descriptions,
                            "spx_stage_start_index": start,
                            "spx_alignment": _spx_align(old_calls, calls)},
            )
            space.capture.annotate_branch(replay.branch.id, {
                "spx_workflow_stages": _spx_summarize_workflow(replay.value),
                "spx_stage_step_ids": stage_ids[:start] + [step.id for step in replay.branch.steps[:-1]],
                "spx_terminal_step_id": replay.branch.steps[-1].id,
            })
            result = {"ok": True, "branchId": str(replay.branch.id)}
    space.commit()
except SyntaxError:
    result = {"ok": False, "invalid": True, "error": "The source is incomplete or invalid. The recorded history is available."}
except Exception as error:
    result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
print("__SPX_REEXECUTE_JSON_PREFIX__" + json.dumps(result))
