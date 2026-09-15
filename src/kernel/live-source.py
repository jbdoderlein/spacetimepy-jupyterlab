import ast
import copy


def _spx_parse(source):
    tree = ast.parse(source)
    if len(tree.body) != 2 or not isinstance(tree.body[0], ast.Assign):
        raise ValueError("Use one workflow assignment followed by execute_live_workflow().")
    assignment, terminal = tree.body
    if len(assignment.targets) != 1 or not isinstance(assignment.targets[0], ast.Name):
        raise ValueError("Assign the workflow to one variable.")
    name = assignment.targets[0].id
    if not (isinstance(terminal, ast.Expr) and isinstance(terminal.value, ast.Call)
            and isinstance(terminal.value.func, ast.Attribute)
            and isinstance(terminal.value.func.value, ast.Name)
            and terminal.value.func.value.id == name
            and terminal.value.func.attr == "execute_live_workflow"
            and not terminal.value.args and not terminal.value.keywords):
        raise ValueError("End the cell with execute_live_workflow().")
    calls = []
    value = assignment.value
    while isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
        calls.append(value)
        value = value.func.value
    calls.reverse()
    if not (isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
            and value.func.id == "SpaceTimeWorkflowBuilder"):
        raise ValueError("Use SpaceTimeWorkflowBuilder in the live cell.")
    if len(calls) < 3 or calls[0].func.attr != "input" or calls[-1].func.attr != "output":
        raise ValueError("Use input, linear operators, and output in this order.")
    operators = calls[1:-1]
    unsupported = {"grouping_operator", "cluster_sampling_operator", "stratified_random_operator", "quota_operator"}
    for call in operators:
        if not call.func.attr.endswith("_operator") or call.func.attr in unsupported:
            raise ValueError("Live execution supports only linear operator calls.")
    descriptions = [ast.unparse(ast.Call(func=ast.Name(id=c.func.attr, ctx=ast.Load()), args=c.args, keywords=c.keywords)) for c in operators]
    skeleton = copy.deepcopy(tree)
    # Remove operator calls from the fixed input/output structure.
    output = skeleton.body[0].value
    input_call = output.func.value
    for _ in operators:
        input_call = input_call.func.value
    output.func.value = input_call
    return name, operators, descriptions, ast.dump(skeleton)


def _spx_align(old_calls, calls):
    """Match names in order, then prefer equal argument ASTs.

    Residual ties use the smallest sequence of (reference, variant) indices.
    The indices start at zero. Argument expressions are not evaluated.
    """
    def key(call):
        return ast.dump(ast.Call(func=ast.Name(id=call.func.attr, ctx=ast.Load()),
                                 args=call.args, keywords=call.keywords))

    old_keys, keys = list(map(key, old_calls)), list(map(key, calls))
    n, m = len(old_calls), len(calls)
    table = [[(0, 0, ()) for _ in range(m + 1)] for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            candidates = [table[i + 1][j], table[i][j + 1]]
            if old_calls[i].func.attr == calls[j].func.attr:
                count, unchanged, pairs = table[i + 1][j + 1]
                candidates.append((count + 1, unchanged + (old_keys[i] == keys[j]),
                                   ((i, j),) + pairs))
            table[i][j] = min(candidates, key=lambda item: (-item[0], -item[1], item[2]))
    pairs = table[0][0][2]
    return {
        "pairs": [list(pair) for pair in pairs],
        "deleted": [i for i in range(n) if i not in {a for a, _ in pairs}],
        "inserted": [j for j in range(m) if j not in {b for _, b in pairs}],
    }


def _spx_arguments(call, namespace):
    # Evaluate only operator arguments. Input and output calls remain fixed.
    expression = ast.Expression(ast.Call(
        func=ast.Name(id="__spx_arguments", ctx=ast.Load()),
        args=call.args, keywords=call.keywords,
    ))
    scope = dict(namespace, __spx_arguments=lambda *args, **kwargs: (args, kwargs))
    return eval(compile(ast.fix_missing_locations(expression), "<live-arguments>", "eval"), scope, scope)
