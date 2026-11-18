# Notices for the example cases

TENSA's example cases come from several sources, each under its own terms. This file says
what each source asks. The catalog (`catalog.json`) has the same information for every case,
with the citations, and `docs/examples.md` in the repository is written from it.

When a case is added to a workspace, TENSA writes `EXAMPLE-SOURCES.md` beside it with the
source, the citations and the licence of that case.

## ANDES example cases

IEEE 14-bus with machines and controls, Kundur two-area system, IEEE 39-bus New England
system, NPCC 140-bus system, WECC 179-bus system, and three smaller cases of the gallery:
the Kundur system with a stabiliser on one generator, the IEEE 14-bus system with a fault
built in, and the PJM 5-bus system with classical machines and a line trip.

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
Washington; the two-area system of P. Kundur, "Power System Stability and Control"
(McGraw-Hill, 1994); the 39-bus New England system, from T. Athay, R. Podmore and S. Virmani,
"A practical method for the direct analysis of transient stability" (IEEE Transactions on
Power Apparatus and Systems, 1979); the NPCC 48-machine, 140-bus system, a test bed of CURENT
that is described as converted from the Power System Toolbox (J. H. Chow and K. W. Cheung,
IEEE Transactions on Power Systems, 1992); the WECC 179-bus, 29-machine system, which the
test cases library of S. Maslennikov et al. (IEEE PES General Meeting, 2016) is built on;
and the PJM 5-bus system of F. Li and R. Bo, "Small test systems for power system economic
studies" (IEEE PES General Meeting, 2010), which MATPOWER distributes as its `case5` file,
whose header says it is distributed with permission. The library of Maslennikov et al. asks
on its page that a publication using its material cite that paper. The NPCC and WECC files are ANDES's own
versions of those systems. The PJM 5-bus file puts machines and governors on the network of
`case5`, and ANDES gives no source for their data. The Kundur stabiliser and IEEE 14-bus
fault files are the Kundur and IEEE 14-bus files with one device added each. The catalog
says what was and was not compared with the publications.

## Cases written by TENSA

WSCC 9-bus, with classical machines.

This file is part of TENSA. It is written by `scripts/build_wscc9.py` in the TENSA
repository and is distributed with TENSA under the GNU General Public License, version 3 or
later (GPL-3.0-or-later); the licence text is at
https://github.com/Roger-GO/TENSA/blob/main/LICENSE and in the TENSA distribution. It is not
a copy of any file of ANDES.

The numbers in it are those of the WSCC 3-machine, 9-bus system as P. M. Anderson and A. A.
Fouad give them in "Power System Control and Stability" (2nd ed., IEEE Press and
Wiley-Interscience, 2003), Chapter 2, Example 2.6, which is the work to cite for the system.
The catalog says how the numbers were checked against the book. ANDES is the program that
reads and runs the file; the paper to cite for it is the one named above.
