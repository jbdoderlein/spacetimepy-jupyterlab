from __future__ import annotations

import builtins
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import IPython
import spacetimepy
from sampling_mining_workflows_dsl.element.loader.LoaderFactory import LoaderFactory
from sampling_mining_workflows_dsl.element.writer.WriterFactory import WriterFactory
from sampling_mining_workflows_dsl.metadata.Metadata import Metadata as DslMetadata
from sampling_mining_workflows_dsl.SpaceTimeWorkflowBuilder import (
    SpaceTimeWorkflowBuilder,
)


KERNEL_DIRECTORY = Path(__file__).parents[1] / "src" / "kernel"
REEXECUTE_PREFIX = "SPACETIMEPY_REEXECUTE_JSON:"
TRACE_PREFIX = "SPACETIMEPY_TRACE_JSON:"


class Metadata:
    def __init__(self, name: str) -> None:
        self.name = name


class MetadataValue:
    def __init__(self, value: Any) -> None:
        self._value = value

    def get_value(self) -> Any:
        return self._value


class Element:
    def __init__(self, value: int) -> None:
        self._metadata = {Metadata("score"): MetadataValue(value)}

    def get_all_metadata_values(self) -> dict[Metadata, MetadataValue]:
        return self._metadata


class ElementSet:
    def __init__(self, values: list[int]) -> None:
        self._elements = [Element(value) for value in values]

    def flatten_set(self) -> ElementSet:
        return self

    def get_elements(self) -> list[Element]:
        return self._elements


class FirstOperator:
    pass


class SecondOperator:
    pass


class WorkflowBuilder:
    def __init__(self) -> None:
        self._workflow = self
        self._stages: dict[int, tuple[ElementSet, object | None]] = {
            0: (ElementSet([0, 1]), None)
        }

    def first(self, value: int) -> WorkflowBuilder:
        self._stages[1] = (ElementSet([value, value + 1]), FirstOperator())
        return self

    def second(self, value: int) -> WorkflowBuilder:
        previous = [
            element.get_all_metadata_values()[next(iter(element.get_all_metadata_values()))].get_value()
            for element in self._stages[1][0].get_elements()
        ]
        self._stages[2] = (
            ElementSet([item + value for item in previous]),
            SecondOperator(),
        )
        return self

    def execute_workflow(self) -> WorkflowBuilder:
        return self

    def get_all_set_from_workflow(
        self,
    ) -> dict[int, tuple[ElementSet, object | None]]:
        return self._stages


def _template(name: str) -> str:
    return (KERNEL_DIRECTORY / name).read_text(encoding="utf-8")


def _with_summary(template: str) -> str:
    return template.replace(
        "# __SPX_WORKFLOW_SUMMARY__",
        _template("workflow-summary.py"),
    )


def _reexecute_code(request: dict[str, Any]) -> str:
    return (
        _with_summary(_template("reexecute-variant.py"))
        .replace("__SPX_REQUEST_JSON__", json.dumps(json.dumps(request)))
        .replace("__SPX_REEXECUTE_JSON_PREFIX__", REEXECUTE_PREFIX)
    )


def _trace_code() -> str:
    return (
        _with_summary(_template("trace-query.py"))
        .replace("__SPX_TRACE_JSON_PREFIX__", TRACE_PREFIX)
    )


def _execute(code: str, prefix: str) -> dict[str, Any]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(
            compile(code, "<spacetimepy-jupyterlab-test>", "exec"),
            {"__builtins__": builtins.__dict__},
        )
    line = next(
        line for line in output.getvalue().splitlines() if line.startswith(prefix)
    )
    return json.loads(line[len(prefix) :])


def _range(source: str, token: str) -> dict[str, dict[str, int]]:
    offset = source.index(token)
    before = source[:offset]
    line = before.count("\n")
    column = len(before.rsplit("\n", 1)[-1])
    return {
        "start": {"line": line, "column": column},
        "end": {"line": line, "column": column + len(token)},
    }


def _request(
    source: str,
    *,
    first_variant: str,
    second_variant: str,
    first_label: str,
    second_label: str,
) -> dict[str, Any]:
    baseline_key = json.dumps([["A", "A1"], ["B", "B1"]], separators=(",", ":"))
    combination_key = json.dumps(
        [["A", first_variant], ["B", second_variant]],
        separators=(",", ":"),
    )
    return {
        "source": source,
        "targets": [
            {
                "targetId": "A",
                "variantId": first_variant,
                "variantLabel": first_label,
                "range": _range(source, "10"),
            },
            {
                "targetId": "B",
                "variantId": second_variant,
                "variantLabel": second_label,
                "range": _range(source, "20" if second_variant == "B2" else "2"),
            },
        ],
        "combinationKey": combination_key,
        "combinationLabel": " + ".join(
            label
            for variant, original, label in (
                (first_variant, "A1", first_label),
                (second_variant, "B1", second_label),
            )
            if variant != original
        )
        or "Original",
        "baselineCombinationKey": baseline_key,
        "originalCombinationKey": baseline_key,
    }


def test_v2_kernel_workflow_replay_cache_tree_and_histograms(tmp_path):
    baseline_source = (
        "w = (WorkflowBuilder().first(1).second(2))\n"
        "w.execute_workflow()"
    )
    first_variant_source = (
        "w = (WorkflowBuilder().first(10).second(2))\n"
        "w.execute_workflow()"
    )
    second_variant_source = (
        "w = (WorkflowBuilder().first(10).second(20))\n"
        "w.execute_workflow()"
    )
    baseline_key = json.dumps([["A", "A1"], ["B", "B1"]], separators=(",", ":"))
    user_namespace = {"WorkflowBuilder": WorkflowBuilder}
    previous_get_ipython = IPython.get_ipython
    space = spacetimepy.SpaceTime.open(tmp_path / "workflow.db")
    try:
        IPython.get_ipython = lambda: SimpleNamespace(user_ns=user_namespace)
        space.capture.function(WorkflowBuilder.first)
        space.capture.function(WorkflowBuilder.second)
        space.capture.function(WorkflowBuilder.execute_workflow)
        with space.capture.recording(
            name="Notebook workflow",
            attributes={
                "spx_jupyter_baseline": {
                    "combinationKey": baseline_key,
                    "combinationLabel": "Original",
                }
            },
        ) as recording:
            exec(baseline_source, user_namespace, user_namespace)

        first_request = _request(
            first_variant_source,
            first_variant="A2",
            second_variant="B1",
            first_label="Larger",
            second_label="Original",
        )
        first_result = _execute(
            _reexecute_code(first_request),
            REEXECUTE_PREFIX,
        )
        assert first_result["ok"] is True
        assert first_result.get("reused") is not True

        first_branch = space.data.get_branch(int(first_result["branchId"]))
        assert first_branch.parent_branch_id == recording.branch_id
        assert first_branch.configuration_key == first_request["combinationKey"]
        assert [
            step.function_call.function_name for step in first_branch.steps
        ] == ["first", "second", "execute_workflow"]
        assert first_branch.attributes["spx_workflow_stages"]

        cached_result = _execute(
            _reexecute_code(first_request),
            REEXECUTE_PREFIX,
        )
        assert cached_result["ok"] is True
        assert cached_result["reused"] is True
        assert cached_result["branchId"] == first_result["branchId"]

        second_request = _request(
            second_variant_source,
            first_variant="A2",
            second_variant="B2",
            first_label="Larger",
            second_label="More",
        )
        second_result = _execute(
            _reexecute_code(second_request),
            REEXECUTE_PREFIX,
        )
        assert second_result["ok"] is True
        second_branch = space.data.get_branch(int(second_result["branchId"]))
        assert second_branch.parent_branch_id == first_branch.id
        assert [
            step.function_call.function_name for step in second_branch.steps
        ] == ["second", "execute_workflow"]

        trace = _execute(_trace_code(), TRACE_PREFIX)
        assert trace["loaded"] is True
        assert trace.get("error") is None
        assert trace["baselineCombinationKey"] == baseline_key
        assert trace["features"] == ["score"]
        assert trace["inputStage"]["sampleSize"] == 2
        assert len(trace["nodes"]) == 8
        branch_nodes = [node for node in trace["nodes"] if node["branch"]]
        assert {node["branch"]["id"] for node in branch_nodes} == {
            first_result["branchId"],
            second_result["branchId"],
        }
        assert all("sourceStepId" in node["branch"] for node in branch_nodes)
        assert any(
            argument["name"] == "value" and argument["value"] == 10
            for node in branch_nodes
            for argument in node["arguments"]
        )
    finally:
        IPython.get_ipython = previous_get_ipython
        space.close()


def test_real_dsl_builder_automatically_records_and_replays(tmp_path):
    input_path = tmp_path / "input.json"
    input_path.write_text(
        json.dumps(
            [
                {"id": "one", "score": 1},
                {"id": "two", "score": 2},
                {"id": "three", "score": 3},
            ]
        ),
        encoding="utf-8",
    )
    id_metadata = DslMetadata.of_string("id")
    score_metadata = DslMetadata.of_integer("score")
    loader = LoaderFactory.json_loader(
        str(input_path),
        id_metadata,
        score_metadata,
    )
    writer = WriterFactory.json_writer(str(tmp_path / "output.json"))
    database_path = tmp_path / "workflow.db"
    baseline_source = (
        "w = (SpaceTimeWorkflowBuilder(database_path)"
        ".input(loader)"
        ".random_selection_operator(2, seed=4)"
        ".output(writer))\n"
        "w.execute_workflow()"
    )
    variant_source = baseline_source.replace(
        "random_selection_operator(2,",
        "random_selection_operator(1,",
    )
    baseline_key = json.dumps([["A", "A1"]], separators=(",", ":"))
    variant_key = json.dumps([["A", "A2"]], separators=(",", ":"))
    user_namespace = {
        "SpaceTimeWorkflowBuilder": SpaceTimeWorkflowBuilder,
        "database_path": database_path,
        "loader": loader,
        "writer": writer,
    }
    previous_get_ipython = IPython.get_ipython
    try:
        IPython.get_ipython = lambda: SimpleNamespace(user_ns=user_namespace)
        exec(baseline_source, user_namespace, user_namespace)

        space = spacetimepy.get_active_spacetime()
        assert space is not None
        session = space.data.list_sessions()[-1]
        assert session.status == "completed"
        space.capture.annotate_session(
            session.id,
            {
                "spx_jupyter_baseline": {
                    "combinationKey": baseline_key,
                    "combinationLabel": "Original",
                }
            },
        )

        request = {
            "source": variant_source,
            "targets": [
                {
                    "targetId": "A",
                    "variantId": "A2",
                    "variantLabel": "One result",
                    "range": _range(variant_source, "1"),
                }
            ],
            "combinationKey": variant_key,
            "combinationLabel": "One result",
            "baselineCombinationKey": baseline_key,
            "originalCombinationKey": baseline_key,
        }
        replay = _execute(_reexecute_code(request), REEXECUTE_PREFIX)
        assert replay["ok"] is True
        branch = space.data.get_branch(int(replay["branchId"]))
        assert branch.parent_branch_id == session.branches[0].id
        assert branch.status == "completed"
        assert [
            step.function_call.function_name for step in branch.steps
        ] == ["random_selection_operator"]

        trace = _execute(_trace_code(), TRACE_PREFIX)
        assert trace.get("error") is None
        assert trace["features"] == ["id", "score"]
        assert trace["inputStage"]["sampleSize"] == 3
        assert len(trace["nodes"]) == 2
    finally:
        IPython.get_ipython = previous_get_ipython
        active_space = spacetimepy.get_active_spacetime()
        if active_space is not None:
            active_space.close()
