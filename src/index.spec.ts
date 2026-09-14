import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  class Signal {
    slots: Array<(...args: any[]) => void> = [];
    connect(fn: (...args: any[]) => void) { this.slots.push(fn); }
    disconnect(fn: (...args: any[]) => void) { this.slots = this.slots.filter(slot => slot !== fn); }
    emit(value?: any) { this.slots.forEach(slot => slot(this, value)); }
  }
  class Cell {
    isDisposed = false;
    disposed = new Signal();
    source = 'initial';
    model = {
      sharedModel: {
        changed: new Signal(),
        getSource: () => this.source,
        setSource: (value: string) => { this.source = value; this.model.sharedModel.changed.emit(); }
      },
      outputs: { toJSON: () => [{ output_type: 'display_data', data: { 'application/vnd.spacetimepy.live+json': { branchId: '1', sessionId: '1' } } }] }
    };
  }
  return { Signal, Cell, scheduled: new Signal(), executed: new Signal(), views: [] as any[] };
});
vi.mock('@jupyterlab/application', () => ({}));
vi.mock('@jupyterlab/cells', () => ({ CodeCell: state.Cell, Cell: state.Cell }));
vi.mock('@jupyterlab/notebook', () => ({ INotebookTracker: {}, NotebookActions: { executionScheduled: state.scheduled, executed: state.executed } }));
vi.mock('@jupyterlab/services', () => ({ KernelMessage: { isStreamMsg: (m: any) => m.header.msg_type === 'stream', isErrorMsg: () => false } }));
vi.mock('./trace-view', () => ({ SpaceTimeWebView: class {
  isAttached = true;
  id = 'view';
  renderTrace = vi.fn();
  renderStatus = vi.fn();
  constructor(public select: (id: string) => void) { state.views.push(this); }
} }));
vi.mock('./kernel-code', () => ({
  buildLiveCode: (r: any) => JSON.stringify(r),
  buildTraceCode: (sessionId: string) => JSON.stringify({ action: 'trace', sessionId }),
  isolateKernelCode: (code: string) => code,
  TRACE_JSON_PREFIX: 'RESULT:', REEXECUTE_JSON_PREFIX: 'RESULT:'
}));
import plugin from './index';

async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); } }

function setup() {
  const cell = new state.Cell();
  const pending: Array<{ request: any; finish: (result: any) => void }> = [];
  const kernel = { requestExecute: vi.fn(({ code }: { code: string }) => {
    let resolve!: (value: any) => void;
    const future = { done: new Promise(r => { resolve = r; }), onIOPub: (_m: any) => {}, dispose: vi.fn() };
    pending.push({ request: JSON.parse(code), finish: result => {
      future.onIOPub({ header: { msg_type: 'stream' }, content: { text: `RESULT:${JSON.stringify(result)}\n` } });
      resolve({});
    } });
    return future;
  }) };
  const panel = { content: {}, context: { saveState: new state.Signal() }, sessionContext: { session: { kernel }, kernelChanged: new state.Signal(), statusChanged: new state.Signal(), kernelDisplayStatus: 'idle' } };
  const app = { shell: { add: vi.fn(), activateById: vi.fn() } };
  plugin.activate(app as any, { forEach: (fn: any) => fn(panel) });
  state.scheduled.emit({ cell });
  state.executed.emit({ cell, notebook: panel.content, success: true });
  const history = { loaded: true, rootBranchId: '1', nodes: [], features: [], branches: [{ id: '1', source: 'initial' }, { id: '2', source: 'edited' }] };
  const save = async () => {
    panel.context.saveState.emit('started');
    panel.context.saveState.emit('completed');
    await flush();
  };
  return { cell, panel, pending, history, view: state.views[0], kernel, save };
}

beforeEach(() => {
  vi.useFakeTimers();
  state.scheduled.slots = []; state.executed.slots = []; state.views.length = 0;
});

describe('live cell requests', () => {
  it('restores a selected branch without a kernel request and uses it as the next parent', async () => {
    const { cell, pending, history, view, save } = setup();
    await flush(); pending[0].finish({ ok: true, branchId: '1' });
    await flush(); pending[1].finish(history); await flush();
    view.select('2');
    expect(cell.source).toBe('edited');
    await vi.advanceTimersByTimeAsync(600);
    expect(pending).toHaveLength(2);
    await save();
    expect(pending).toHaveLength(2);
    cell.model.sharedModel.setSource('new edit');
    await vi.advanceTimersByTimeAsync(600);
    expect(pending).toHaveLength(2);
    await save();
    expect(pending[2].request).toEqual({ action: 'edit', branchId: '2', source: 'new edit' });
  });

  it('serializes edits and prevents an older result from replacing the current display', async () => {
    const { cell, pending, history, view, save } = setup();
    await flush(); pending[0].finish({ ok: true, branchId: '1' });
    await flush(); pending[1].finish(history); await flush();
    cell.model.sharedModel.setSource('first'); await save();
    cell.model.sharedModel.setSource('second'); await save();
    expect(pending).toHaveLength(3);
    pending[2].finish({ ok: true, branchId: '2' }); await flush();
    pending[3].finish(history); await flush();
    expect(view.renderTrace).toHaveBeenCalledTimes(1);
    expect(pending[4].request.source).toBe('second');
    expect(pending[4].request.branchId).toBe('1');
  });

  it('preserves history on an invalid edit and removes listeners on kernel restart', async () => {
    const { cell, panel, pending, history, view, save } = setup();
    await flush(); pending[0].finish({ ok: true, branchId: '1' });
    await flush(); pending[1].finish(history); await flush();
    cell.model.sharedModel.setSource('invalid'); await save();
    pending[2].finish({ ok: false, invalid: true, error: 'Invalid source.' }); await flush();
    expect(view.renderTrace).toHaveBeenLastCalledWith(history, '1');
    expect(view.renderStatus).toHaveBeenLastCalledWith('Invalid source.', true);
    panel.sessionContext.kernelDisplayStatus = 'restarting'; panel.sessionContext.statusChanged.emit();
    expect(cell.model.sharedModel.changed.slots).toHaveLength(0);
    expect(panel.context.saveState.slots).toHaveLength(0);
    cell.model.sharedModel.setSource('later'); await vi.advanceTimersByTimeAsync(600);
    expect(pending).toHaveLength(3);
  });
});

it('ignores failed saves and text changed during a save', async () => {
  const { cell, panel, pending, history } = setup();
  await flush(); pending[0].finish({ ok: true, branchId: '1' });
  await flush(); pending[1].finish(history); await flush();
  cell.model.sharedModel.setSource('edited');
  panel.context.saveState.emit('started');
  panel.context.saveState.emit('failed');
  await flush();
  expect(pending).toHaveLength(2);
  panel.context.saveState.emit('started');
  cell.model.sharedModel.setSource('unsaved change');
  panel.context.saveState.emit('completed');
  await flush();
  expect(pending).toHaveLength(2);
});
