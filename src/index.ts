import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { CodeCell, Cell } from '@jupyterlab/cells';
import { INotebookTracker, NotebookActions, NotebookPanel } from '@jupyterlab/notebook';
import { KernelMessage } from '@jupyterlab/services';
import { buildLiveCode, buildTraceCode, isolateKernelCode, REEXECUTE_JSON_PREFIX, TRACE_JSON_PREFIX } from './kernel-code';
import { SpaceTimeWebView } from './trace-view';
import type { LiveResult, SpaceTimeTracePayload } from './types';

const MIME = 'application/vnd.spacetimepy.live+json';

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'spacetimepy-jupyterlab:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebooks: INotebookTracker) => {
    let detach = (): void => {};
    let generation = 0;
    let queue = Promise.resolve();
    let selectBranch = (_id: string): void => {};
    const view = new SpaceTimeWebView(id => selectBranch(id));
    const sources = new WeakMap<Cell, string>();

    function enqueue(task: () => Promise<void>, current: () => boolean): void {
      queue = queue.then(task).catch(error => {
        if (current()) { view.renderStatus(String(error), true); }
      });
    }

    async function request<T>(panel: NotebookPanel, code: string, prefix: string): Promise<T> {
      const kernel = panel.sessionContext.session?.kernel;
      if (!kernel) { throw new Error('The notebook kernel is unavailable.'); }
      const future = kernel.requestExecute({ code: isolateKernelCode(code), store_history: false, stop_on_error: true });
      let output = '';
      let error = '';
      future.onIOPub = message => {
        if (KernelMessage.isStreamMsg(message)) { output += message.content.text; }
        if (KernelMessage.isErrorMsg(message)) { error = message.content.evalue; }
      };
      try { await future.done; } finally { future.dispose(); }
      if (error) { throw new Error(error); }
      const line = output.split('\n').find(line => line.startsWith(prefix));
      if (!line) { throw new Error('The kernel did not return a live workflow result.'); }
      return JSON.parse(line.slice(prefix.length)) as T;
    }

    NotebookActions.executionScheduled.connect((_, args) => {
      sources.set(args.cell, args.cell.model.sharedModel.getSource());
    });

    NotebookActions.executed.connect((_, args) => {
      if (!args.success || !(args.cell instanceof CodeCell)) { return; }
      let signal: { branchId: string; sessionId: string } | undefined;
      for (const output of args.cell.model.outputs.toJSON()) {
        if (output.output_type === 'display_data') {
          signal = (output.data as Record<string, unknown>)[MIME] as typeof signal ?? signal;
        }
      }
      if (!signal) { return; }
      let panel: NotebookPanel | undefined;
      notebooks.forEach(candidate => { if (candidate.content === args.notebook) { panel = candidate; } });
      if (!panel) { return; }
      detach();
      const token = ++generation;
      const cell = args.cell;
      const notebookPanel = panel;
      const sessionId = signal.sessionId;
      let branchId = signal.branchId;
      let trace: SpaceTimeTracePayload | undefined;
      let revision = 0;
      let suppressed = false;
      let savingSource: string | undefined;
      const source = sources.get(cell) ?? cell.model.sharedModel.getSource();
      let branchSource = source;
      const current = (): boolean => generation === token && !cell.isDisposed;
      if (!view.isAttached) { app.shell.add(view, 'right'); }
      app.shell.activateById(view.id);
      view.renderStatus('Read the live recording.');

      const refresh = async (): Promise<SpaceTimeTracePayload> => {
        const result = await request<SpaceTimeTracePayload>(notebookPanel, buildTraceCode(sessionId), TRACE_JSON_PREFIX);
        if (result.error) { throw new Error(result.error); }
        return result;
      };
      const changed = (): void => {
        if (!suppressed && current()) { ++revision; }
      };
      const saved = (_sender: unknown, state: 'started' | 'completed' | 'failed'): void => {
        if (!current()) { return; }
        if (state === 'started') {
          savingSource = cell.model.sharedModel.getSource();
          return;
        }
        const editedSource = savingSource;
        savingSource = undefined;
        if (state !== 'completed' || editedSource === undefined ||
            editedSource !== cell.model.sharedModel.getSource() || editedSource === branchSource) { return; }
        const version = ++revision;
        enqueue(async () => {
          if (!current() || version !== revision) { return; }
          const result = await request<LiveResult>(notebookPanel, buildLiveCode({ action: 'edit', branchId, source: editedSource }), REEXECUTE_JSON_PREFIX);
          if (!current()) { return; }
          const updated = result.ok ? await refresh() : trace;
          if (!current()) { return; }
          trace = updated;
          if (version !== revision) { return; }
          if (result.ok) {
            branchId = result.branchId!;
            branchSource = editedSource;
            view.renderTrace(trace!, branchId);
          } else {
            if (trace) { view.renderTrace(trace, branchId); }
            view.renderStatus(result.error ?? 'Live execution failed.', true);
          }
        }, () => current() && version === revision);
      };
      const stop = (): void => {
        cell.model.sharedModel.changed.disconnect(changed);
        notebookPanel.context.saveState.disconnect(saved);
        cell.disposed.disconnect(stop);
        notebookPanel.sessionContext.kernelChanged.disconnect(stop);
        notebookPanel.sessionContext.statusChanged.disconnect(statusChanged);
        if (generation === token) { ++generation; }
        trace = undefined;
        selectBranch = () => {};
        detach = () => {};
      };
      const statusChanged = (): void => {
        const status = notebookPanel.sessionContext.kernelDisplayStatus;
        if (status === 'restarting' || status === 'dead' || status === 'terminating') { stop(); }
      };
      detach = stop;
      cell.disposed.connect(stop);
      notebookPanel.sessionContext.kernelChanged.connect(stop);
      notebookPanel.sessionContext.statusChanged.connect(statusChanged);
      selectBranch = id => {
        const branch = trace?.branches.find(branch => branch.id === id);
        if (!branch || !current()) { return; }
        ++revision;
        branchId = id;
        branchSource = branch.source;
        suppressed = true;
        try { cell.model.sharedModel.setSource(branch.source); } finally { suppressed = false; }
        view.renderTrace(trace!, branchId);
      };
      enqueue(async () => {
        if (!current()) { return; }
        const result = await request<LiveResult>(notebookPanel, buildLiveCode({ action: 'attach', branchId, source }), REEXECUTE_JSON_PREFIX);
        if (!current()) { return; }
        if (!result.ok) { view.renderStatus(result.error ?? 'Cannot attach the live cell.', true); return; }
        const updated = await refresh();
        if (!current()) { return; }
        trace = updated;
        view.renderTrace(trace, branchId);
        cell.model.sharedModel.changed.connect(changed);
        notebookPanel.context.saveState.connect(saved);
      }, current);
    });
  }
};

export default plugin;
