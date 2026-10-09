"""Cache policy and file detection of the SPA mount (``_SpaStaticFiles``).

``StaticFiles`` hands ``get_response`` a path run through ``os.path.normpath``,
so on Windows it has backslashes (``assets\\index-3f9a.js``). The mount's rules
(``assets/`` is immutable, a missing path that names a file is a 404, and so is
one under ``api/``) are written against URL paths, so they first turn backslashes
into slashes. Linux cannot produce such a path through the mount, so these tests
hand the helpers, and the mount's ``get_response``, one directly. The behaviour
through the real mount is in ``tests/integration/test_static_serving.py``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.exceptions import HTTPException
from starlette.responses import Response

from tensa.api.app import _is_api_path, _names_a_file, _SpaStaticFiles, _url_path

pytestmark = pytest.mark.unit

IMMUTABLE = "public, max-age=31536000, immutable"


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("assets/index-3f9a.js", "assets/index-3f9a.js"),
        ("assets\\index-3f9a.js", "assets/index-3f9a.js"),
        ("assets\\sub\\a.css", "assets/sub/a.css"),
        ("", ""),
    ],
)
def test_url_path_uses_forward_slashes(path: str, expected: str) -> None:
    assert _url_path(path) == expected


@pytest.mark.parametrize(
    "path",
    [
        "assets/index-3f9a.js",
        "assets\\index-3f9a.js",
        "assets/index-3f9a.js.map",
        "favicon.ico",
        "robots.txt",
        "a.b/c.css",
    ],
)
def test_a_path_with_an_extension_names_a_file(path: str) -> None:
    assert _names_a_file(path)


@pytest.mark.parametrize(
    "path",
    ["", "case", "case/foo", "case\\foo", "a.b/case", "a.b\\case", "assets/"],
)
def test_a_path_without_an_extension_is_a_client_side_route(path: str) -> None:
    assert not _names_a_file(path)


@pytest.mark.parametrize("path", ["assets/index-3f9a.js", "assets\\index-3f9a.js"])
@pytest.mark.parametrize("status", [200, 206, 304])
def test_hashed_asset_is_immutable_whatever_the_separator(path: str, status: int) -> None:
    response = _SpaStaticFiles._with_cache_control(path, Response(status_code=status))
    assert response.headers["cache-control"] == IMMUTABLE


@pytest.mark.parametrize("path", ["index.html", "", "favicon.svg", "case/foo", "case\\foo"])
def test_everything_else_is_revalidated(path: str) -> None:
    response = _SpaStaticFiles._with_cache_control(path, Response(status_code=200))
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("status", [301, 403, 404, 500])
def test_an_error_is_never_marked_immutable(status: int) -> None:
    """A cache must not keep a failed lookup under an asset's URL for a year."""
    response = _SpaStaticFiles._with_cache_control(
        "assets/index-3f9a.js", Response(status_code=status)
    )
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("path", ["api", "api/version", "api\\version", "api\\sessions\\1"])
def test_a_path_under_api_is_the_routers(path: str) -> None:
    assert _is_api_path(path)


@pytest.mark.parametrize("path", ["", "apiary", "case/api", "case\\api", "API/version"])
def test_any_other_path_is_the_pages(path: str) -> None:
    assert not _is_api_path(path)


@pytest.fixture
def mount(tmp_path: Path) -> _SpaStaticFiles:
    (tmp_path / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    return _SpaStaticFiles(directory=str(tmp_path), html=True)


_GET = {"type": "http", "method": "GET", "headers": []}


@pytest.mark.parametrize(
    "path",
    ["api", "api/nothing-here", "api\\nothing-here", "assets/gone-3f9a.js", "assets\\gone-3f9a.js"],
)
async def test_a_missing_api_path_or_file_is_a_404_whatever_the_separator(
    mount: _SpaStaticFiles, path: str
) -> None:
    """With backslashes an unknown ``/api`` path used to be answered with the page
    and a 200, so a client on Windows read HTML where it asked for JSON."""
    with pytest.raises(HTTPException) as refused:
        await mount.get_response(path, _GET)
    assert refused.value.status_code == 404


@pytest.mark.parametrize("path", ["case/foo", "case\\foo", "apiary"])
async def test_a_missing_client_side_route_gets_the_page(mount: _SpaStaticFiles, path: str) -> None:
    response = await mount.get_response(path, _GET)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("path", ["api\\nothing-here", "assets\\gone-3f9a.js"])
async def test_a_bundle_that_went_away_is_a_404_there_too(
    mount: _SpaStaticFiles, path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second way a miss shows up: the lookup itself raises, here for every
    file but the page."""
    found = _SpaStaticFiles.lookup_path

    def _gone(self: _SpaStaticFiles, path: str) -> object:
        if path != "index.html":
            raise FileNotFoundError(path)
        return found(self, path)

    monkeypatch.setattr(_SpaStaticFiles, "lookup_path", _gone)
    with pytest.raises(HTTPException) as refused:
        await mount.get_response(path, _GET)
    assert refused.value.status_code == 404
