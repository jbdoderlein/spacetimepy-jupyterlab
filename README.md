# spacetimpepy-jupyterlab

Minimal JupyterLab 4 extension boilerplate for exploratory notebook controls.

The first version adds a left sidebar panel with two actions:

- highlight the first visible editor line of the active notebook cell
- send a small probe command to the active notebook kernel

This is intentionally small so installation and extension wiring can be tested before adding richer Python argument widgets.

## Install for local development with uv

```bash
npm install
npm run build
uv sync --no-editable
uv run jupyter labextension list
uv run jupyter lab
```

In JupyterLab, open the left sidebar tab named **Explore** or run **Open Exploratory Controls** from the command palette.

## Development loop

```bash
npm run build
uv sync --no-editable --reinstall-package spacetimpepy-jupyterlab
uv run jupyter lab
```

For the next implementation step, the extension should replace the temporary DOM line highlight with a CodeMirror 6 decoration and add a kernel-backed protocol for argument option discovery.
