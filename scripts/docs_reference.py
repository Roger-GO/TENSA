"""The reference pages of the documentation site, written from the code they describe.

``mkdocs.yml`` lists this file under ``hooks``. MkDocs calls ``on_files`` below while it
builds, and the three pages it returns join the site without a file in ``docs/``:

- ``reference/api.md``, every route of the server, and ``reference/models.md``, every
  request and response model, both rendered from ``make_app().openapi()``;
- ``reference/cli.md``, every command and option of ``tensa``, rendered from the Typer app.

Because they are rendered on each build, they cannot drift from the server.

``render_pages`` and its parts need only a schema (or a click command), so the tests feed
them hand-written ones as well as the live ones. ``build_schema`` and ``build_cli_group`` are
the two functions that import the server.

Text from the code goes through ``_prose``: the descriptions are docstrings, so they carry
reStructuredText roles (``:class:`X```), a stray ``<case>`` or ``{id}`` that Markdown would
read as markup, and the long dash the documentation does not use.
"""

from __future__ import annotations

import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"

API_PAGE = "reference/api.md"
MODELS_PAGE = "reference/models.md"
CLI_PAGE = "reference/cli.md"

# How a route's tag reads as a heading. A tag that is not here is capitalised, so a new
# one still gets a section of its own.
TAG_TITLES = {
    "sessions": "Sessions",
    "cases": "Cases and topology",
    "pflow": "Power flow",
    "disturbances": "Disturbances",
    "elements": "Elements",
    "clone": "Parameter editing (clone)",
    "tds": "Time-domain simulation",
    "workspace": "Workspace",
    "version": "Version",
    "snapshot": "Snapshots",
    "bundle": "Bundles",
    "reports": "Reports",
    "eig": "Eigenvalue analysis",
    "cpf": "Continuation power flow",
    "se": "State estimation",
    "pmu": "PMU placement",
    "profiles": "Profiles",
    "sweep": "Sweeps",
    "jobs": "Jobs",
    "messages": "ANDES messages",
}

_METHODS = ("get", "put", "post", "delete", "patch", "options", "head")
_CODE_SPAN = re.compile(r"(``.+?``|`[^`\n]+`)", re.DOTALL)
_ROLE = re.compile(r":[a-z]+:`~?([^`]+)`")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s")


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------


def _escape(text: str) -> str:
    """Escape what Markdown or an attribute list would act on, outside code spans."""
    parts = _CODE_SPAN.split(text)
    for i in range(0, len(parts), 2):
        parts[i] = (
            parts[i]
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("{", "&#123;")
            .replace("}", "&#125;")
        )
    return "".join(parts)


def _plain(text: str) -> str:
    """The typography of the documentation: no long dash, no reStructuredText."""
    text = re.sub(r"\s*—\s*", " - ", text)
    text = re.sub(r"::$", ":", text, flags=re.MULTILINE)
    return _ROLE.sub(r"`\1`", text)


def _prose(text: str) -> str:
    """A description as Markdown paragraphs and lists."""
    lines: list[str] = []
    previous = ""
    in_fence = False
    for raw in _plain(text).strip().splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        elif not in_fence:
            if line.startswith("#"):
                line = "\\" + line
            # Python-Markdown starts a list only after a blank line.
            if _LIST_ITEM.match(line) and previous.strip() and not _LIST_ITEM.match(previous):
                lines.append("")
            # An indented line is a code block: leave it as it is.
            line = line if line.startswith("    ") else _escape(line)
        lines.append(line)
        previous = raw
    return "\n".join(lines)


def _cell(text: str) -> str:
    """A description for a table cell: one line, pipes escaped."""
    return _prose(" ".join(text.split())).replace("\n", " ").replace("|", "\\|")


def _anchor(name: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")


def _code(text: object) -> str:
    """Inline code that survives a table cell."""
    return "`" + str(text).replace("`", "'").replace("|", "\\|") + "`"


def _tag_title(tag: str) -> str:
    return TAG_TITLES.get(tag, tag.replace("-", " ").capitalize())


# ---------------------------------------------------------------------------
# Schema types and tables
# ---------------------------------------------------------------------------


def _ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[-1]


def _link(name: str, *, from_models: bool) -> str:
    target = f"#{_anchor(name)}" if from_models else f"models.md#{_anchor(name)}"
    return f"[{_escape(name)}]({target})"


def _type(schema: dict[str, Any], *, from_models: bool) -> str:
    """A schema's type as one inline Markdown phrase (links to the models page)."""
    if "$ref" in schema:
        return _link(_ref_name(schema["$ref"]), from_models=from_models)
    for key in ("anyOf", "oneOf"):
        if key in schema:
            options = schema[key]
            named = [
                _type(option, from_models=from_models)
                for option in options
                if option.get("type") != "null"
            ]
            # A null among the options reads as "or null" at the end, not as a member.
            return " or ".join(named) + (" or null" if len(named) != len(options) else "")
    if "allOf" in schema:
        return " and ".join(_type(part, from_models=from_models) for part in schema["allOf"])
    if "const" in schema:
        const = schema["const"]
        return _code(f'"{const}"' if isinstance(const, str) else const)
    kind = schema.get("type")
    if kind == "array":
        item = schema.get("items")
        inner = _type(item, from_models=from_models) if isinstance(item, dict) else "any"
        return f"array of {inner}"
    if kind == "object":
        extra = schema.get("additionalProperties")
        if isinstance(extra, dict) and extra:
            return f"object (names to {_type(extra, from_models=from_models)})"
        return "object"
    if kind is None:
        return "any"
    fmt = schema.get("format")
    return f"{kind} ({fmt})" if fmt else str(kind)


_LIMITS = (
    ("minimum", "min {}"),
    ("exclusiveMinimum", "above {}"),
    ("maximum", "max {}"),
    ("exclusiveMaximum", "below {}"),
    ("minLength", "min length {}"),
    ("maxLength", "max length {}"),
    ("minItems", "min items {}"),
    ("maxItems", "max items {}"),
)


def _default(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, str):
        return f'"{value}"'
    return str(value)


def _facts(schema: dict[str, Any]) -> list[str]:
    """The choices, limits and default a schema states, as short sentences."""
    facts: list[str] = []
    for option in list(schema.get("anyOf", [])) or [schema]:
        if "enum" in option:
            facts.append("One of " + ", ".join(_code(v) for v in option["enum"]) + ".")
        limits = [label.format(f"{option[key]:g}") for key, label in _LIMITS if key in option]
        if limits:
            facts.append("Limits: " + ", ".join(limits) + ".")
        if "pattern" in option:
            facts.append(f"Pattern {_code(option['pattern'])}.")
    if "default" in schema:
        facts.append(f"Default {_code(_default(schema['default']))}.")
    return facts


def _describe(description: str, facts: list[str]) -> str:
    """A table cell: the description, then what the schema adds to it."""
    return " ".join(part for part in [_cell(description), *map(_cell, facts)] if part)


def _fields_table(model: dict[str, Any], *, from_models: bool) -> list[str]:
    """The properties of an object schema as a table."""
    properties = model.get("properties") or {}
    if not properties:
        return []
    required = set(model.get("required") or [])
    rows = ["| Field | Type | Required | Description |", "| --- | --- | --- | --- |"]
    for name, prop in properties.items():
        description = _describe(prop.get("description", ""), _facts(prop))
        rows.append(
            f"| {_code(name)} | {_type(prop, from_models=from_models)} "
            f"| {'yes' if name in required else 'no'} | {description} |"
        )
    return rows


def _parameters_table(parameters: list[dict[str, Any]]) -> list[str]:
    rows = ["| Name | In | Type | Required | Description |", "| --- | --- | --- | --- | --- |"]
    for parameter in parameters:
        schema = parameter.get("schema") or {}
        description = _describe(parameter.get("description", ""), _facts(schema))
        rows.append(
            f"| {_code(parameter['name'])} | {parameter['in']} "
            f"| {_type(schema, from_models=False)} "
            f"| {'yes' if parameter.get('required') else 'no'} | {description} |"
        )
    return rows


def _resolve(schema: dict[str, Any], components: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in schema:
        resolved: dict[str, Any] = components.get(_ref_name(schema["$ref"]), {})
        return resolved
    return schema


# ---------------------------------------------------------------------------
# The API pages
# ---------------------------------------------------------------------------


def _operations(schema: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    found = []
    for path, item in schema.get("paths", {}).items():
        for method in _METHODS:
            if method in item:
                found.append((method.upper(), path, item[method]))
    return found


def _operation_anchor(method: str, path: str, operation: dict[str, Any]) -> str:
    return _anchor(str(operation.get("operationId") or f"{method}-{path}"))


def _is_generic_validation_error(response: dict[str, Any]) -> bool:
    """FastAPI's own 422 on every route that takes input, which the page's intro covers."""
    schema = ((response.get("content") or {}).get("application/json") or {}).get("schema") or {}
    return response.get("description") == "Validation Error" and schema.get("$ref", "").endswith(
        "/HTTPValidationError"
    )


def _render_operation(
    method: str, path: str, operation: dict[str, Any], components: dict[str, Any]
) -> list[str]:
    anchor = _operation_anchor(method, path, operation)
    out = [f"### {_code(method + ' ' + path)} {{ #{anchor} }}", ""]
    if operation.get("deprecated"):
        out += ['!!! warning "Deprecated"', "    This route is deprecated.", ""]
    summary = operation.get("summary")
    if summary:
        out += [f"**{_escape(_plain(summary).strip())}**", ""]
    description = (operation.get("description") or "").strip()
    if description and description != (summary or "").strip():
        out += [_prose(description), ""]

    parameters = operation.get("parameters") or []
    if parameters:
        out += ["**Parameters**", "", *_parameters_table(parameters), ""]

    body = operation.get("requestBody")
    if body:
        needed = "required" if body.get("required") else "optional"
        out += [f"**Request body** ({needed})", ""]
        if body.get("description"):
            out += [_prose(body["description"]), ""]
        for media, content in (body.get("content") or {}).items():
            body_schema = content.get("schema") or {}
            out += [f"Media type {_code(media)}: {_type(body_schema, from_models=False)}", ""]
            fields = _fields_table(_resolve(body_schema, components), from_models=False)
            if fields:
                out += [*fields, ""]

    responses = {
        status: response
        for status, response in (operation.get("responses") or {}).items()
        if not _is_generic_validation_error(response)
    }
    if responses:
        out += ["**Responses**", "", "| Status | Meaning | Body |", "| --- | --- | --- |"]
        for status, response in responses.items():
            bodies = [
                f"{_code(media)} {_type(content['schema'], from_models=False)}"
                if content.get("schema")
                else _code(media)
                for media, content in (response.get("content") or {}).items()
            ]
            meaning = _cell(response.get("description", ""))
            out.append(f"| {status} | {meaning} | {'; '.join(bodies)} |")
        out.append("")
    return out


def render_api(schema: dict[str, Any]) -> str:
    """``reference/api.md``: every route, grouped by tag, in the order the app lists them."""
    info = schema.get("info", {})
    components = (schema.get("components") or {}).get("schemas") or {}
    groups: dict[str, list[tuple[str, str, dict[str, Any]]]] = {}
    for method, path, operation in _operations(schema):
        tag = (operation.get("tags") or ["other"])[0]
        groups.setdefault(tag, []).append((method, path, operation))

    out = [
        "# API routes",
        "",
        f"Every route of the TENSA server, rendered from its OpenAPI schema (TENSA "
        f"{info.get('version', '')}). A running server serves the same schema at "
        "`/openapi.json`, with interactive pages at `/docs` (Swagger UI) and `/redoc`. "
        "The [API guide](../api.md) says how the routes fit together, and the "
        "[models](models.md) page describes each request and response body.",
        "",
        "Routes sit under `/api`. A request with a JSON body needs a "
        "`Content-Type: application/json` header. Every error the server raises itself is an "
        "RFC 7807 [ProblemDetails](models.md#problemdetails) document. A route that takes "
        "input also answers 422 with FastAPI's "
        "[HTTPValidationError](models.md#httpvalidationerror) when the request does not "
        "match its schema; the tables below leave that row out unless a route gives its 422 "
        "a meaning of its own.",
        "",
        "The WebSocket routes (`/api/ws/...`) are not part of an OpenAPI schema. The "
        "[API guide](../api.md#websockets) describes them.",
        "",
        "## Contents",
        "",
    ]
    for tag, operations in groups.items():
        out.append(f"- **{_tag_title(tag)}**")
        for method, path, operation in operations:
            target = _operation_anchor(method, path, operation)
            summary = _cell(operation.get("summary", ""))
            out.append(
                f"    - [{_code(method + ' ' + path)}](#{target})"
                f"{': ' + summary if summary else ''}"
            )
    out.append("")
    for tag, operations in groups.items():
        out += [f"## {_tag_title(tag)}", ""]
        for method, path, operation in operations:
            out += _render_operation(method, path, operation, components)
    return "\n".join(out).rstrip() + "\n"


def render_models(schema: dict[str, Any]) -> str:
    """``reference/models.md``: every schema of the API, in alphabetical order."""
    components = (schema.get("components") or {}).get("schemas") or {}
    out = [
        "# API models",
        "",
        "The request and response bodies of the [API routes](api.md), one section per model. "
        "A field marked `yes` under Required must be sent (or is always present in a "
        "response); an optional field that is left out takes the default named in its "
        "description.",
        "",
    ]
    for name in sorted(components):
        model = components[name]
        out += [f"## {_escape(name)} {{ #{_anchor(name)} }}", ""]
        if model.get("description"):
            out += [_prose(model["description"]), ""]
        if model.get("properties"):
            out += [*_fields_table(model, from_models=True), ""]
        else:
            facts = " ".join(_facts(model))
            out += [f"Type: {_type(model, from_models=True)}.", *(["", facts] if facts else []), ""]
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# The command line page
# ---------------------------------------------------------------------------

# Options Typer adds to every program; `--help` on a command says so already.
_BUILT_IN_OPTIONS = {"--help", "--install-completion", "--show-completion"}


def _option_value(param: Any) -> str:
    """What an option takes, as the `--help` table writes it."""
    if getattr(param, "is_flag", False):
        return "flag"
    name = str(getattr(param.type, "name", "text")).lower().removesuffix(" range")
    low = getattr(param.type, "min", None)
    return f"{name} (min {low:g})" if low is not None else name


def _option_default(param: Any) -> str:
    default = param.default
    if getattr(param, "is_flag", False) or default in (None, "", [], ()):
        return ""
    text = str(default)
    home = str(Path.home())
    if text.startswith(home):
        text = "~" + text[len(home) :]
    return _code(text.replace("\\", "/"))


def _render_command(name: str, command: Any) -> list[str]:
    out = [f"## {_code(name)}", ""]
    if command.help:
        out += [_prose(command.help), ""]
    options = [
        param
        for param in command.params
        if getattr(param, "opts", None)
        and not set(param.opts) & _BUILT_IN_OPTIONS
        and not getattr(param, "hidden", False)
    ]
    usage = name + (" [OPTIONS]" if options else "")
    if getattr(command, "commands", None):
        usage += " COMMAND [ARGS]..."
    out += [f"Usage: {_code(usage)}", ""]
    if options:
        out += ["| Option | Value | Default | Description |", "| --- | --- | --- | --- |"]
        for param in options:
            flags = ", ".join(_code(opt) for opt in [*param.opts, *param.secondary_opts])
            repeat = " Repeat it to give several." if getattr(param, "multiple", False) else ""
            out.append(
                f"| {flags} | {_option_value(param)} | {_option_default(param)} "
                f"| {_cell((param.help or '') + repeat)} |"
            )
        out.append("")
    return out


def render_cli(group: Any, *, program: str = "tensa") -> str:
    """``reference/cli.md``: a click group, its own options, and each command's."""
    out = [
        "# Command line",
        "",
        f"Every command and option of `{program}`, written from the program's own "
        f"definitions. `{program} --help` and `{program} COMMAND --help` print the same "
        "text in a terminal.",
        "",
        *_render_command(program, group),
    ]
    for name, command in group.commands.items():
        out += _render_command(f"{program} {name}", command)
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# The pages, and the MkDocs hook
# ---------------------------------------------------------------------------


def render_pages(schema: dict[str, Any], cli_group: Any) -> dict[str, str]:
    """The generated pages of the site, by path under ``docs/``."""
    return {
        API_PAGE: render_api(schema),
        MODELS_PAGE: render_models(schema),
        CLI_PAGE: render_cli(cli_group),
    }


def _bootstrap() -> None:
    """Make ``tensa`` importable from a checkout that has not installed it."""
    if SERVER_SRC.is_dir() and str(SERVER_SRC) not in sys.path:
        sys.path.insert(0, str(SERVER_SRC))


def build_schema() -> dict[str, Any]:
    """The OpenAPI schema of the app, built against a throwaway workspace.

    Nothing is bound or spawned, and the built UI is not needed.
    """
    _bootstrap()
    from tensa.api.app import make_app

    root = Path(tempfile.mkdtemp(prefix="tensa-docs-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir(mode=0o700)
        schema: dict[str, Any] = make_app(workspace=workspace).openapi()
        return schema
    finally:
        shutil.rmtree(root, ignore_errors=True)


def build_cli_group() -> Any:
    """The click command behind ``tensa``."""
    _bootstrap()
    import typer.main

    from tensa import cli

    return typer.main.get_command(cli.app)


def on_files(files: Any, config: Any) -> Any:
    """MkDocs hook: add the generated pages to the site."""
    from mkdocs.structure.files import File

    for name, text in render_pages(build_schema(), build_cli_group()).items():
        files.append(File.generated(config, name, content=text))
    return files
