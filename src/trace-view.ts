import { Widget } from '@lumino/widgets';
import {
  hierarchy,
  tree as createTreeLayout,
  type HierarchyPointNode
} from 'd3-hierarchy';

import { buildWorkflowTree } from './trace-tree';
import type {
  CaptureResult,
  SpaceTimeTraceNode,
  SpaceTimeTracePayload,
  WorkflowTreeDatum,
  WorkflowTreeSelection
} from './types';

function formatTraceValue(value: unknown): string {
  if (value === null) {
    return 'None';
  }
  if (
    typeof value === 'string' ||
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

export class SpaceTimeWebView extends Widget {
  constructor(
    private readonly onActivateCombination: (
      combinationKey: string
    ) => CaptureResult
  ) {
    super();
    this.id = 'spacetimepy-webview-panel';
    this.title.label = 'SpaceTime';
    this.title.caption = 'SpaceTime web view';
    this.addClass('spx-webview');

    this.content = document.createElement('div');
    this.content.className = 'spx-webview-content';
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
      this.renderMessage(trace.error);
      return;
    }
    if (!trace.nodes.length) {
      this.renderMessage('No function calls recorded for the latest session.');
      return;
    }

    const graph = document.createElement('div');
    graph.className = 'spx-trace-graph';
    this.content.append(graph);
    this.renderTraceTree(
      graph,
      buildWorkflowTree(
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
    this.renderMessage(message, isError);
  }

  private renderMessage(message: string, isError = false): void {
    const status = document.createElement('div');
    status.className = isError
      ? 'spx-trace-empty spx-trace-error'
      : 'spx-trace-empty';
    status.textContent = message;
    this.content.append(status);
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
