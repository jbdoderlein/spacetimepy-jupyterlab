"""JupyterLab extension metadata for spacetimpepy-jupyterlab."""

from __future__ import annotations


def _jupyter_labextension_paths() -> list[dict[str, str]]:
    return [{"src": "labextension", "dest": "spacetimpepy-jupyterlab"}]
