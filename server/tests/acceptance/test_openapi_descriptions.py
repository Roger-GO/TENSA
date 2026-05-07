"""R25 acceptance: every Pydantic field on every request/response model in
the OpenAPI spec has a non-empty ``description``; every route has a
non-empty ``summary``; every route has explicit ``responses`` declarations
referencing the ``ProblemDetails`` schema for at least one 4xx code.

Failing this test is the canonical R25 regression signal — the OpenAPI
contract is the substrate's user-facing API surface, and undocumented
fields make agent / SDK use materially worse.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager

VALID_TOKEN = "d" * 64


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(
        expected_token=VALID_TOKEN,
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.expected_token = VALID_TOKEN
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


@pytest.mark.acceptance
async def test_every_route_has_operation_id_and_summary(
    client: httpx.AsyncClient,
) -> None:
    """Every defined operation has a stable ``operationId`` and a non-empty
    ``summary``. These flow into the OpenAPI-to-MCP generator's tool name
    + description; without them, agent integrations get useless tool
    listings."""
    spec = (await client.get("/openapi.json")).json()
    failures: list[str] = []
    for path, methods in spec["paths"].items():
        for method, op in methods.items():
            if method.startswith("x-") or method == "parameters":
                continue
            if not op.get("operationId"):
                failures.append(f"{method.upper()} {path}: missing operationId")
            if not op.get("summary"):
                failures.append(f"{method.upper()} {path}: missing summary")
    assert not failures, "operations missing metadata:\n" + "\n".join(failures)


@pytest.mark.acceptance
async def test_every_pydantic_field_has_description(
    client: httpx.AsyncClient,
) -> None:
    """Walk every schema in the OpenAPI components and assert every
    property has a non-empty description."""
    spec = (await client.get("/openapi.json")).json()
    schemas = spec.get("components", {}).get("schemas", {})

    failures: list[str] = []

    def _walk_schema(name: str, schema: dict[str, Any], path: str = "") -> None:
        # Heuristic: only enforce on object schemas with declared properties.
        # ``allOf`` / ``oneOf`` / ``anyOf`` composites pull from the referenced
        # schemas which are walked separately.
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return
        for field_name, field_schema in properties.items():
            full_path = f"{name}.{path}{field_name}" if path else f"{name}.{field_name}"
            description = field_schema.get("description") if isinstance(field_schema, dict) else None
            if not description or not str(description).strip():
                failures.append(f"{full_path}: missing or empty description")

    # Skip FastAPI's own validation-error schemas — they're framework-provided
    # and the substrate cannot add descriptions to them. Our own schemas
    # MUST have descriptions.
    framework_schemas = {"HTTPValidationError", "ValidationError"}
    for name, schema in schemas.items():
        if name in framework_schemas:
            continue
        if isinstance(schema, dict):
            _walk_schema(name, schema)

    assert not failures, (
        "Pydantic fields missing description:\n  " + "\n  ".join(failures)
    )


@pytest.mark.acceptance
async def test_every_route_declares_problem_details_for_4xx(
    client: httpx.AsyncClient,
) -> None:
    """Every route should explicitly declare at least one 4xx response
    referencing ProblemDetails (so MCP / agent clients get typed errors)."""
    spec = (await client.get("/openapi.json")).json()
    schemas = spec.get("components", {}).get("schemas", {})
    assert "ProblemDetails" in schemas, "ProblemDetails component missing"
    failures: list[str] = []
    for path, methods in spec["paths"].items():
        for method, op in methods.items():
            if method.startswith("x-") or method == "parameters":
                continue
            responses = op.get("responses", {})
            has_4xx_problem = False
            for code, resp in responses.items():
                # FastAPI may surface 422 with its own HTTPValidationError schema
                # for query/body validation; we want at least ONE 4xx that
                # routes to ProblemDetails.
                if not str(code).startswith("4"):
                    continue
                content = resp.get("content", {})
                schema_ref = (
                    content.get("application/json", {})
                    .get("schema", {})
                    .get("$ref", "")
                )
                if "ProblemDetails" in schema_ref:
                    has_4xx_problem = True
                    break
            if not has_4xx_problem:
                failures.append(
                    f"{method.upper()} {path}: no 4xx response references ProblemDetails"
                )
    assert not failures, "routes missing ProblemDetails 4xx:\n  " + "\n  ".join(failures)
