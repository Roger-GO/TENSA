"""Cache policy and file detection of the SPA mount (``_SpaStaticFiles``).

``StaticFiles`` hands ``get_response`` a path run through ``os.path.normpath``,
so on Windows it has backslashes (``assets\\index-3f9a.js``). The mount's rules
(``assets/`` is immutable, a missing path that names a file is a 404) are written
against URL paths, so they first turn backslashes into slashes. Linux cannot
produce such a path through the mount, so these tests hand the helpers one
directly. The behaviour through the real mount is in
``tests/integration/test_static_serving.py``.
"""

from __future__ import annotations

import pytest
from starlette.responses import Response

from tensa.api.app import _names_a_file, _SpaStaticFiles, _url_path

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
