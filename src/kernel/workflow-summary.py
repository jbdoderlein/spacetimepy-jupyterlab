from collections import Counter
import math

def _spx_unwrap_workflow(value):
    if value is None:
        return None
    if hasattr(value, "get_all_set_from_workflow"):
        return value
    nested = getattr(value, "_workflow", None)
    if nested is not None and hasattr(nested, "get_all_set_from_workflow"):
        return nested
    nested = getattr(value, "workflow", None)
    if nested is not None and hasattr(nested, "get_all_set_from_workflow"):
        return nested
    return None
def _spx_histogram(values):
    values = [value for value in values if value is not None]
    if not values:
        return {"kind": "empty", "bins": []}

    numeric = all(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        for value in values
    )
    if numeric:
        numbers = [float(value) for value in values]
        minimum = min(numbers)
        maximum = max(numbers)
        if minimum == maximum:
            return {
                "kind": "numeric",
                "bins": [{"label": f"{minimum:g}", "count": len(numbers)}],
            }
        bin_count = min(10, max(1, math.ceil(math.sqrt(len(numbers)))))
        width = (maximum - minimum) / bin_count
        counts = [0] * bin_count
        for value in numbers:
            index = min(int((value - minimum) / width), bin_count - 1)
            counts[index] += 1
        return {
            "kind": "numeric",
            "bins": [
                {
                    "label": f"{minimum + index * width:g}-{minimum + (index + 1) * width:g}",
                    "count": count,
                }
                for index, count in enumerate(counts)
            ],
        }

    labels = []
    for value in values:
        if isinstance(value, (list, tuple, set)):
            labels.extend(str(item) for item in value)
        else:
            labels.append(str(value))
    counts = Counter(labels)
    most_common = counts.most_common(10)
    included = sum(count for _, count in most_common)
    bins = [{"label": label, "count": count} for label, count in most_common]
    if included < len(labels):
        bins.append({"label": "Other", "count": len(labels) - included})
    return {"kind": "categorical", "bins": bins}

def _spx_summarize_workflow(value):
    workflow = _spx_unwrap_workflow(value)
    if workflow is None:
        return []
    stages = []
    for index, stage_value in sorted(workflow.get_all_set_from_workflow().items()):
        set_object, operator = stage_value
        if set_object is None:
            continue
        flattened = set_object.flatten_set() if hasattr(set_object, "flatten_set") else set_object
        elements = flattened.get_elements() if hasattr(flattened, "get_elements") else []
        feature_values = {}
        for element in elements:
            if not hasattr(element, "get_all_metadata_values"):
                continue
            for metadata, metadata_value in element.get_all_metadata_values().items():
                name = str(getattr(metadata, "name", metadata))
                try:
                    value = metadata_value.get_value()
                except Exception:
                    value = getattr(metadata_value, "value", None)
                feature_values.setdefault(name, []).append(value)
        stages.append({
            "index": int(index),
            "label": "Input" if operator is None else type(operator).__name__,
            "sampleSize": len(elements),
            "histograms": {
                name: _spx_histogram(values)
                for name, values in feature_values.items()
            },
        })
    return stages

def _spx_find_notebook_workflow():
    try:
        from IPython import get_ipython
        namespace = get_ipython().user_ns
    except Exception:
        return None
    preferred = namespace.get("workflow")
    if _spx_unwrap_workflow(preferred) is not None:
        return preferred
    for value in reversed(list(namespace.values())):
        if _spx_unwrap_workflow(value) is not None:
            return value
    return None
