import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { KernelMessage } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';

import '../style/index.css';

const PLUGIN_ID = 'spacetimpepy-jupyterlab:plugin';
const OPEN_COMMAND = 'spacetimpepy-jupyterlab:open-panel';

interface ExplorerPanelOptions {
  onHighlightLine: () => void;
  onKernelProbe: () => Promise<string>;
}

class ExplorerPanel extends Widget {
  constructor(options: ExplorerPanelOptions) {
    super();
    this.id = 'spacetimpepy-explorer-panel';
    this.title.label = 'Explore';
    this.title.caption = 'Exploratory notebook controls';
    this.addClass('spx-panel');

    const header = document.createElement('div');
    header.className = 'spx-panel-header';
    header.textContent = 'Exploratory Controls';

    const highlightButton = document.createElement('button');
    highlightButton.className = 'spx-button';
    highlightButton.type = 'button';
    highlightButton.textContent = 'Highlight Active Line';
    highlightButton.onclick = () => {
      options.onHighlightLine();
      this.setStatus('Requested notebook highlight.');
    };

    const kernelButton = document.createElement('button');
    kernelButton.className = 'spx-button';
    kernelButton.type = 'button';
    kernelButton.textContent = 'Kernel Probe';
    kernelButton.onclick = async () => {
      this.setStatus('Waiting for kernel...');
      const result = await options.onKernelProbe();
      this.setStatus(result);
    };

    this.status = document.createElement('pre');
    this.status.className = 'spx-status';
    this.status.textContent = 'Open a notebook and use the buttons above.';

    this.node.append(header, highlightButton, kernelButton, this.status);
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private readonly status: HTMLPreElement;
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
    const panel = new ExplorerPanel({
      onHighlightLine: () => highlightActiveEditorLine(notebooks),
      onKernelProbe: () => runKernelProbe(notebooks)
    });

    app.shell.add(panel, 'left', { rank: 650 });

    app.commands.addCommand(OPEN_COMMAND, {
      label: 'Open Exploratory Controls',
      execute: () => {
        if (!panel.isAttached) {
          app.shell.add(panel, 'left', { rank: 650 });
        }
        app.shell.activateById(panel.id);
      }
    });

    palette?.addItem({
      command: OPEN_COMMAND,
      category: 'Notebook Tools'
    });
  }
};

export default plugin;
