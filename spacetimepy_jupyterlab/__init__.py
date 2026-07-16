"""JupyterLab extension metadata for spacetimepy-jupyterlab."""

from __future__ import annotations


def _jupyter_labextension_paths() -> list[dict[str, str]]:
    return [{"src": "labextension", "dest": "spacetimepy-jupyterlab"}]
