"""Check live replay with real DSL operators and SpaceTime checkpoints."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

import IPython
import pytest
from spacetimepy import SpaceTime
from sampling_mining_workflows_dsl.SpaceTimeWorkflowBuilder import SpaceTimeWorkflowBuilder
from sampling_mining_workflows_dsl.element.loader.LoaderFactory import LoaderFactory
from sampling_mining_workflows_dsl.element.writer.WriterFactory import WriterFactory
from sampling_mining_workflows_dsl.metadata.Metadata import Metadata
from sampling_mining_workflows_dsl.operator.selection.filter.FilterOperator import FilterOperator
from sampling_mining_workflows_dsl.operator.selection.sampling.automatic.RandomSelectionOperator import RandomSelectionOperator

KERNEL = Path(__file__).parents[1] / 'src/kernel'


def kernel(name, request, namespace, monkeypatch):
    code = (KERNEL / name).read_text()
    code = code.replace('# __SPX_WORKFLOW_SUMMARY__', (KERNEL / 'workflow-summary.py').read_text())
    code = code.replace('# __SPX_LIVE_SOURCE__', (KERNEL / 'live-source.py').read_text())
    code = code.replace('__SPX_REQUEST_JSON__', repr(json.dumps(request)))
    code = code.replace('__SPX_REEXECUTE_JSON_PREFIX__', 'RESULT:').replace('__SPX_TRACE_JSON_PREFIX__', 'RESULT:')
    monkeypatch.setattr(IPython, 'get_ipython', lambda: SimpleNamespace(user_ns=namespace))
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(code, '<kernel-test>', 'exec'), {})
    return json.loads(next(line[7:] for line in output.getvalue().splitlines() if line.startswith('RESULT:')))


@pytest.fixture
def live(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.json'
    input_path.write_text(json.dumps([
        {'id': str(i), 'commitNb': i * 1000, 'language': 'Python' if i % 2 else 'Java'}
        for i in range(1, 10)
    ]))
    loader = LoaderFactory.json_loader(str(input_path), Metadata.of_string('id'), Metadata.of_integer('commitNb'), Metadata.of_string('language'))
    writer = WriterFactory.json_writer(str(tmp_path / 'out.json'))
    counts = dict(commit=0, language=0, sample=0, load=0, write=0)
    original_filter = FilterOperator.execute
    original_sample = RandomSelectionOperator.execute
    original_load = type(loader).load_set
    original_write = type(writer).write_set

    def filter_execute(self):
        counts['commit' if self._previous_operator is None else 'language'] += 1
        return original_filter(self)

    def sample_execute(self):
        counts['sample'] += 1
        return original_sample(self)

    def load(self):
        counts['load'] += 1
        return original_load(self)

    def write(self, value):
        counts['write'] += 1
        return original_write(self, value)

    monkeypatch.setattr(FilterOperator, 'execute', filter_execute)
    monkeypatch.setattr(RandomSelectionOperator, 'execute', sample_execute)
    monkeypatch.setattr(type(loader), 'load_set', load)
    monkeypatch.setattr(type(writer), 'write_set', write)
    source = '''w = (SpaceTimeWorkflowBuilder().input(loader)
        .filter_operator("commitNb > 2000 and commitNb < 7000")
        .filter_operator("language == 'Python'")
        .random_selection_operator(1, seed=0).output(writer))
w.execute_live_workflow()'''
    namespace = dict(SpaceTimeWorkflowBuilder=SpaceTimeWorkflowBuilder, loader=loader, writer=writer)
    with SpaceTime.open(tmp_path / 'trace.db') as space:
        exec(source, namespace)
        session = space.data.list_sessions()[-1]
        branch = str(session.branches[0].id)
        result = kernel('live-workflow.py', dict(action='attach', branchId=branch, source=source), namespace, monkeypatch)
        assert result['ok'], result
        yield space, namespace, source, branch, str(session.id), counts, monkeypatch


def test_execution_counts_checkpoint_results_and_history(live):
    space, ns, source, root, session, counts, monkeypatch = live
    assert counts == dict(commit=1, language=1, sample=1, load=1, write=1)
    parent_snapshot = space.data.get_branch(int(root)).attributes['spx_workflow_stages']
    checkpoint_id = space.data.get_branch(int(root)).steps[2].id

    def restored_input_ids():
        context = space.replay.prepare(parent_branch_id=int(root), forked_from_step_id=checkpoint_id)
        return [element.get_id() for element in context.locals['workflow']._last_operator._input.get_elements()]

    assert restored_input_ids() == ['3', '5']

    def edit(parent, text, expected):
        before = counts.copy()
        result = kernel('live-workflow.py', dict(action='edit', branchId=parent, source=text), ns, monkeypatch)
        assert result['ok'], result
        assert {key: counts[key] - before[key] for key in counts} == expected
        return result['branchId']

    sample_source = source.replace('operator(1, seed', 'operator(2, seed')
    sample = edit(root, sample_source, dict(commit=0, language=0, sample=1, load=0, write=1))
    language_source = sample_source.replace("== 'Python'", "== 'Java'")
    language = edit(sample, language_source, dict(commit=0, language=1, sample=1, load=0, write=1))
    commit_source = language_source.replace('> 2000', '> 1000')
    edit(language, commit_source, dict(commit=1, language=1, sample=1, load=0, write=1))
    # Selecting an older branch gives the next edit that branch as its parent.
    older = edit(root, language_source, dict(commit=0, language=1, sample=1, load=0, write=1))
    assert space.data.get_branch(int(older)).parent_branch_id == int(root)
    assert space.data.get_branch(int(root)).attributes['spx_workflow_stages'] == parent_snapshot
    assert ns['w']._output.size() == 1
    assert restored_input_ids() == ['3', '5']
    resumed_output = json.loads(ns['writer'].set_path.read_text())
    # Compare all recorded stage summaries with ordinary fresh execution.
    exec(language_source.replace('execute_live_workflow()', 'execute_workflow()'), ns)
    assert json.loads(ns['writer'].set_path.read_text()) == resumed_output
    summary_scope = {}
    exec((KERNEL / 'workflow-summary.py').read_text(), summary_scope)
    assert space.data.get_branch(int(older)).attributes['spx_workflow_stages'] == summary_scope['_spx_summarize_workflow'](ns['w'])
    before = counts.copy()
    history = kernel('trace-query.py', dict(sessionId=session), ns, monkeypatch)
    assert 'error' not in history, history
    assert next(b['source'] for b in history['branches'] if b['id'] == root) == source
    assert counts == before
    assert len(history['branches']) == 5
    edit(root, source, dict(commit=0, language=0, sample=0, load=0, write=0))


def test_invalid_unsupported_and_failed_edits_preserve_history(live):
    space, ns, source, root, session, counts, monkeypatch = live
    for text in [source[:-1], source.replace('.random_selection_operator(1, seed=0)', ''), source.replace('.input(loader)', '.input(other)'), source.replace('random_selection_operator', 'manual_sampling_operator')]:
        before = counts.copy()
        result = kernel('live-workflow.py', dict(action='edit', branchId=root, source=text), ns, monkeypatch)
        assert not result['ok']
        assert counts == before
    result = kernel('live-workflow.py', dict(action='edit', branchId=root, source=source.replace('operator(1, seed', 'operator(-1, seed')), ns, monkeypatch)
    assert not result['ok']
    history = kernel('trace-query.py', dict(sessionId=session), ns, monkeypatch)
    assert [b['id'] for b in history['branches']] == [root]
    result = kernel('live-workflow.py', dict(action='edit', branchId=root, source=source.replace('operator(1, seed', 'operator(2, seed')), ns, monkeypatch)
    assert result['ok'], result


def test_construction_and_ordinary_execution_do_not_record(tmp_path):
    loader_path = tmp_path / 'input.json'
    loader_path.write_text('[{"id": "one"}]')
    loader = LoaderFactory.json_loader(str(loader_path), Metadata.of_string('id'))
    writer = WriterFactory.json_writer(str(tmp_path / 'out.json'))
    with SpaceTime.open(tmp_path / 'trace.db') as space:
        workflow = SpaceTimeWorkflowBuilder().input(loader).random_selection_operator(1).output(writer)
        assert not space.data.list_sessions()
        workflow.execute_workflow()
        assert not space.data.list_sessions()


def test_live_signal_and_replay_in_ipykernel(tmp_path):
    from jupyter_client import KernelManager

    manager = KernelManager()
    manager.start_kernel(cwd=str(tmp_path))
    client = manager.client()
    client.start_channels()

    def execute(code):
        message_id = client.execute(code, store_history=False)
        messages = []
        while True:
            message = client.get_iopub_msg(timeout=30)
            if message['parent_header'].get('msg_id') != message_id:
                continue
            assert message['msg_type'] != 'error', message['content']
            messages.append(message)
            if message['msg_type'] == 'status' and message['content']['execution_state'] == 'idle':
                return messages

    def request(name, value):
        code = (KERNEL / name).read_text()
        code = code.replace('# __SPX_WORKFLOW_SUMMARY__', (KERNEL / 'workflow-summary.py').read_text())
        code = code.replace('# __SPX_LIVE_SOURCE__', (KERNEL / 'live-source.py').read_text())
        code = code.replace('__SPX_REQUEST_JSON__', repr(json.dumps(value)))
        code = code.replace('__SPX_REEXECUTE_JSON_PREFIX__', 'RESULT:').replace('__SPX_TRACE_JSON_PREFIX__', 'RESULT:')
        messages = execute(f'exec(compile({code!r}, "<live-kernel>", "exec"), {{}})')
        output = ''.join(m['content']['text'] for m in messages if m['msg_type'] == 'stream')
        return json.loads(next(line[7:] for line in output.splitlines() if line.startswith('RESULT:')))

    try:
        client.wait_for_ready(timeout=30)
        execute('''import json
from sampling_mining_workflows_dsl.SpaceTimeWorkflowBuilder import SpaceTimeWorkflowBuilder
from sampling_mining_workflows_dsl.element.loader.LoaderFactory import LoaderFactory
from sampling_mining_workflows_dsl.element.writer.WriterFactory import WriterFactory
from sampling_mining_workflows_dsl.metadata.Metadata import Metadata
with open('input.json', 'w') as stream:
    json.dump([{'id': str(i), 'score': i} for i in range(8)], stream)
loader = LoaderFactory.json_loader('input.json', Metadata.of_string('id'), Metadata.of_integer('score'))
writer = WriterFactory.json_writer('out.json')''')
        source = '''w = (SpaceTimeWorkflowBuilder().input(loader)
    .filter_operator("score > 2").random_selection_operator(1, seed=0).output(writer))
w.execute_live_workflow()'''
        messages = execute(source)
        signal = next(m['content']['data']['application/vnd.spacetimepy.live+json'] for m in messages if m['msg_type'] == 'display_data' and 'application/vnd.spacetimepy.live+json' in m['content']['data'])
        result = request('live-workflow.py', dict(action='attach', branchId=signal['branchId'], source=source))
        assert result['ok'], result
        edited = source.replace('operator(1, seed', 'operator(2, seed')
        result = request('live-workflow.py', dict(action='edit', branchId=signal['branchId'], source=edited))
        assert result['ok'], result
        trace = request('trace-query.py', dict(sessionId=signal['sessionId']))
        assert len(trace['branches']) == 2, trace
        assert trace['nodes'][-1]['stage']['sampleSize'] == 2
        assert trace['nodes'][-1]['branch']['fromStepId'] == trace['nodes'][0]['id']
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)
