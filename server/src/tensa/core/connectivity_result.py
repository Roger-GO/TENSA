"""Connectivity / island-detection result dataclass for Unit 17 of the v2.0 plan.

Wraps :meth:`andes.system.System.connectivity`'s side-effects. ANDES's
``connectivity()`` returns ``None``; the routine populates several
attributes on ``ss.Bus`` (``island_sets``, ``islands``, ``islanded_buses``,
``n_islanded_buses``). The substrate's :meth:`Wrapper.compute_connectivity`
unpacks those attributes into this dataclass before serialising over the
worker Pipe.

Per ``andes/core/connman.py`` (verified against ANDES 2.0.0):

- ``Bus.island_sets`` — list of connected components, *excluding* lone
  (degree-zero) buses. Each entry is a list of 0-based bus *addresses*
  (positions in ``Bus.idx.v``), not user-facing idx values.
- ``Bus.islanded_buses`` — list of degree-zero bus addresses.
- ``Bus.islands`` — unified list: ``[[addr], ...]`` singletons for each
  islanded bus appended to the connected components from
  ``island_sets``. Length == total island count (the value the route
  exposes as ``island_count``).

This dataclass converts those addresses to the case-file idx values via
``Bus.idx.v[address]`` so the wire payload is self-explanatory and the
SLD can index by the same idx it uses for bus nodes today.

Per the plan's locked scope: post-run only. There is no per-frame
recomputation; the streaming pipeline (``server/src/tensa/core/stream.py``'s
``VAR_GROUPS``) is not extended here.
"""

from __future__ import annotations

import dataclasses


@dataclasses.dataclass(frozen=True)
class ConnectivityResult:
    """Connectivity / island-detection result returned by
    ``Wrapper.compute_connectivity``.

    Field semantics:

    - ``island_count`` — total number of islands, including singleton
      "islands" of one degree-zero bus. Equals ``len(Bus.islands)``.
      A fully-interconnected case yields ``island_count == 1``;
      tripping a critical line yields ``island_count >= 2``.
    - ``islands`` — list of lists of bus *idx* values (case-file
      identifiers, stringified for stable JSON keying). Each inner
      list is one island's bus membership. Index-aligned with
      ``Bus.islands`` so the first entry matches the first island
      reported by ANDES (which is a singleton when degree-zero buses
      exist; the larger connected components follow).
    - ``islanded_bus_idxes`` — convenience: just the degree-zero buses
      (each appears as its own singleton in ``islands`` too). The SLD
      uses this for its primary "grey out" trigger when the user
      hasn't asked for full per-island colouring. Stringified.
    """

    island_count: int
    islands: list[list[str]]
    islanded_bus_idxes: list[str]


__all__ = ["ConnectivityResult"]
