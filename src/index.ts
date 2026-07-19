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

import { combinationForTargets, parseCombinationKey } from './combinations';
import {
  buildFinishWorkflowRecordingCode,
  buildReexecutionCode,
  isolateKernelCode,
  REEXECUTE_JSON_PREFIX,
  TRACE_JSON_PREFIX,
  TRACE_QUERY_CODE
} from './kernel-code';
import { SpaceTimeWebView } from './trace-view';
import type {
  CaptureResult,
  CodeVariant,
  Position,
  SpaceTimeTracePayload,
  VariantCombination,
  VariantReexecutionRequest,
  VariantReexecutionResult,
  VariantTarget
} from './types';

import '../style/index.css';

const PLUGIN_ID = 'spacetimepy-jupyterlab:plugin';
const OPEN_COMMAND = 'spacetimepy-jupyterlab:open-panel';
const CAPTURE_COMMAND = 'spacetimepy-jupyterlab:capture-selection';
const METADATA_KEY = 'spacetimepy:variants';
const WORKFLOW_MARKER = 'SpaceTimeWorkflowBuilder';

interface ExplorerPanelOptions {
  onAddVariant: (targetId: string, label: string, code: string) => CaptureResult;
  onApplyVariant: (targetId: string, variantId: string) => CaptureResult;
  onCaptureSelection: () => CaptureResult;
  onDeleteVariant: (targetId: string, variantId: string) => CaptureResult;
  onGetTargets: () => VariantTarget[];
}

class ExplorerPanel extends Widget {
  constructor(private readonly options: ExplorerPanelOptions) {
    super();
    this.id = 'spacetimepy-explorer-panel';
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
  return new RegExp(`\\b${WORKFLOW_MARKER}\\s*\\(`).test(
    cell.model.sharedModel.getSource()
  );
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

function getVariantCombination(
  cell: Cell,
  useOriginalVariants = false
): VariantCombination {
  return combinationForTargets(
    getTargetsInWorkflowOrder(cell),
    useOriginalVariants
  );
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
  const entries = parseCombinationKey(combinationKey);
  if (!entries) {
    return { ok: false, message: 'The selected configuration is invalid.' };
  }

  const variantIdByTargetId = new Map<string, string>();
  for (const entry of entries) {
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

async function fetchSpaceTimeTrace(
  panel: NotebookPanel
): Promise<SpaceTimeTracePayload> {
  const execution = await executeKernel(panel, TRACE_QUERY_CODE);
  if (!execution.ok) {
    return {
      loaded: false,
      error:
        execution.error === 'No active notebook kernel.'
          ? execution.error
          : `Trace query failed: ${execution.error}`,
      features: [],
      nodes: []
    };
  }
  const jsonLine = execution.output
    .trim()
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
  const payload = JSON.stringify(
    JSON.stringify({
      combinationKey: combination.key,
      combinationLabel: combination.label
    })
  );
  const execution = await executeKernel(
    panel,
    String.raw`
import json
import sys

payload = json.loads(${payload})
if "spacetimepy" in sys.modules:
    from spacetimepy import get_active_spacetime

    space = get_active_spacetime()
    if space is not None:
        sessions = space.data.list_sessions()
        if sessions:
            space.capture.annotate_session(
                sessions[-1].id,
                {"spx_jupyter_baseline": payload},
            )
`,
    true
  );
  return execution.ok;
}

async function finishWorkflowRecording(
  panel: NotebookPanel,
  status: 'completed' | 'failed'
): Promise<KernelExecutionResult> {
  return executeKernel(
    panel,
    buildFinishWorkflowRecordingCode(status),
    true
  );
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
  const execution = await executeKernel(panel, buildReexecutionCode(request));
  if (!execution.ok) {
    return {
      ok: false,
      error:
        execution.error === 'No active notebook kernel.'
          ? execution.error
          : `Variant replay failed: ${execution.error}`
    };
  }

  const jsonLine = execution.output
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

type KernelExecutionResult =
  | { ok: true; output: string }
  | { ok: false; output: string; error: string };

async function executeKernel(
  panel: NotebookPanel,
  code: string,
  silent = false
): Promise<KernelExecutionResult> {
  const kernel = panel.sessionContext.session?.kernel;
  if (!kernel) {
    return { ok: false, output: '', error: 'No active notebook kernel.' };
  }

  const future = kernel.requestExecute({
    code: isolateKernelCode(code),
    silent,
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
    return { ok: false, output: chunks.join(''), error: String(reason) };
  }
  return { ok: true, output: chunks.join('') };
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
            label: baselineCombinationLabel
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
      onGetTargets: () => getTargets(notebooks)
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
      if (!cellContainsWorkflowBuilder(args.cell)) {
        return;
      }

      const notebookPanel = findNotebookPanel(notebooks, args.notebook);
      if (!notebookPanel) {
        return;
      }

      const finalization = await finishWorkflowRecording(
        notebookPanel,
        args.success ? 'completed' : 'failed'
      );
      if (!finalization.ok) {
        console.warn(
          `Could not finish the SpaceTime workflow recording: ${finalization.error}`
        );
      }
      if (!args.success) {
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
