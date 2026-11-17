# Notices for the example cases

TENSA's example cases come from several sources, each under its own terms. This file says
what each source asks. The catalog (`catalog.json`) has the same information for every case,
with the citations, and `docs/examples.md` in the repository is written from it.

When a case is added to a workspace, TENSA writes `EXAMPLE-SOURCES.md` beside it with the
source, the citations and the licence of that case.

## ANDES example cases

IEEE 14-bus with machines and controls, Kundur two-area system and WSCC 9-bus.

These files are part of ANDES, not of TENSA. TENSA does not redistribute them: it copies
them from the ANDES installed on the user's machine when a case is added. ANDES is
distributed under the GNU General Public License, version 3 or later (GPL-3.0-or-later).
The licence text is at https://github.com/CURENT/andes/blob/v2.0.0/LICENSE and in the
ANDES distribution.

The ANDES README asks that research or consulting that uses ANDES cite:

H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling
and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021,
doi:10.1109/TPWRS.2020.3017019.

The systems themselves have their own sources, which the catalog names for each case: the
IEEE 14-bus test case of the Power Systems Test Case Archive of the University of
Washington, the two-area system of P. Kundur, "Power System Stability and Control"
(McGraw-Hill, 1994), and the WSCC 9-bus system of P. M. Anderson and A. A. Fouad, "Power
System Control and Stability" (IEEE Press).
