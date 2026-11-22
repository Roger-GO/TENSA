"""The bus admittance matrix of the loaded case."""

from __future__ import annotations

from tensa.core.errors import YbusTooLargeError
from tensa.core.wrapper.base import WrapperBase
from tensa.core.wrapper.results import YbusEntry, YbusResult
from tensa.core.wrapper.topology import _system_base_mva

# The most nonzero entries one answer carries. A network has a few nonzeros per
# bus (its diagonal and one pair per branch), so this is a case of over a hundred
# thousand buses; as JSON it is some tens of megabytes.
MAX_YBUS_ENTRIES = 500_000


class YbusMixin(WrapperBase):
    """The bus admittance matrix ANDES builds (``System.build_ybus()``)."""

    def bus_admittance_matrix(self) -> YbusResult:
        """The bus admittance matrix of the loaded case, as sparse triplets.

        ANDES sums the ``build_ybus()`` of every model it flagged ``ybus``
        (``Line``, transformers included, and ``Shunt``) into a complex sparse
        matrix, in per unit on the system base. The set of those models is
        taken at ``setup()``, and the parameters are converted to the system
        base there too: on a System that is not set up ANDES answers an empty
        matrix without a word. So the System is set up first when it is not
        (``_ensure_setup``, as the connectivity check does), which commits it:
        no disturbance can be added until the case is reloaded.

        Each model multiplies its admittances by its status ``u`` at the time
        of the call, so a device switched off adds zeros that the matrix still
        stores; those are left out, and only nonzeros are returned. Row and
        column ``i`` are the bus at position ``i`` of ``Bus.idx.v``:
        ``build_ybus`` places an entry at the bus's address in ``Bus.a``, which
        ANDES numbers 0 to n - 1 in that order.

        Raises ``YbusTooLargeError`` past ``MAX_YBUS_ENTRIES`` nonzeros.
        """
        ss = self._require_loaded()
        self._ensure_setup()
        ybus = ss.build_ybus()
        triplets = [
            (int(row), int(col), complex(value))
            for row, col, value in zip(list(ybus.I), list(ybus.J), list(ybus.V), strict=True)
            if value != 0
        ]
        if len(triplets) > MAX_YBUS_ENTRIES:
            raise YbusTooLargeError(len(triplets), MAX_YBUS_ENTRIES)
        book = self.keys()
        bus_idx = [str(idx) for idx in ss.Bus.idx.v]
        return YbusResult(
            n_bus=int(ss.Bus.n),
            base_mva=_system_base_mva(ss),
            bus_idx=bus_idx,
            bus_key=[book.key_of("Bus", idx) for idx in bus_idx],
            entries=[
                YbusEntry(row=row, col=col, re=value.real, im=value.imag)
                for row, col, value in triplets
            ],
        )
