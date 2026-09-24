"""Neutralise non-Helm templating (helmfile / gomplate) in a values file.

Values files are often themselves templates: ``{{ exec "secret-tool" ... }}`` or
``{{ .Values.foo }}`` cannot be parsed as YAML, so we swap each expression for
a quoted placeholder string before handing the file to ``helm template``.
``${var}`` and ``${env:VAR}`` are left alone — they are valid YAML scalars and
the collector resolves ``${env:...}`` itself at runtime.
"""

import re
from dataclasses import dataclass, field
from typing import List

# Non-greedy so `{{ ... "${clusterName}" ... }}` (which contains `}`) is one match.
_GO_TEMPLATE = re.compile(r"\{\{-?(.*?)-?\}\}")
_SHELL_VAR = re.compile(r"\$\{(?!env:)([A-Za-z_][A-Za-z0-9_]*)\}")


@dataclass(frozen=True)
class Placeholder:
    line: int
    expression: str
    replacement: str


@dataclass(frozen=True)
class Neutralised:
    text: str
    placeholders: List[Placeholder] = field(default_factory=list)
    variables: List[str] = field(default_factory=list)


def _replacement(index: int) -> str:
    return f"TEMPLATED_{index}"


def _replace_line(line: str, line_no: int, start_index: int):
    found = []

    def sub(match: "re.Match[str]") -> str:
        replacement = _replacement(start_index + len(found))
        found.append(Placeholder(line_no, match.group(0).strip(), replacement))
        # A whole-value expression must become a quoted scalar; one embedded in
        # an existing string must not introduce stray quotes.
        before = line[: match.start()].rstrip()
        standalone = before.endswith(":") or before.endswith("-") or before == ""
        return f'"{replacement}"' if standalone else replacement

    return _GO_TEMPLATE.sub(sub, line), found


def neutralise(text: str) -> Neutralised:
    """Return YAML-parseable text plus a record of what was substituted."""
    out_lines = []
    placeholders: List[Placeholder] = []
    for line_no, line in enumerate(text.splitlines(keepends=True), start=1):
        new_line, found = _replace_line(line, line_no, len(placeholders))
        out_lines.append(new_line)
        placeholders.extend(found)

    variables = sorted(set(_SHELL_VAR.findall(text)))
    return Neutralised("".join(out_lines), placeholders, variables)
