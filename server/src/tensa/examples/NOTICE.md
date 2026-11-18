# Notices for the example cases

TENSA's example cases come from several sources, each under its own terms. This file says
what each source asks. The catalog (`catalog.json`) has the same information for every case,
with the citations, and `docs/examples.md` in the repository is written from it.

When a case is added to a workspace, TENSA writes `EXAMPLE-SOURCES.md` beside it with the
source, the citations and the licence of that case.

## ANDES example cases

IEEE 14-bus with machines and controls, Kundur two-area system, IEEE 39-bus New England
system, NPCC 140-bus system, WECC 179-bus system, and the smaller cases of the gallery:
the Kundur system with a stabiliser on one generator, the IEEE 14-bus system with a fault
built in, the PJM 5-bus system with classical machines and a line trip, the IEEE 14-bus
system with a solar plant, the IEEE 14-bus system with a type-3 wind turbine, and the IEEE
118-bus and IEEE 300-bus cases (networks for power flow, with no machine models).

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
fault files are the Kundur and IEEE 14-bus files with one device added each. The IEEE
14-bus solar and wind files are the IEEE 14-bus file with the machine at bus 8 replaced by
converter models of the second generation of the WECC generic renewable models (the
specifications of P. Pourbeik for the Type 3 and Type 4 wind turbines, written for the
National Renewable Energy Laboratory, and the WECC specification of a solar PV plant, both
described in the catalog); ANDES gives no source for their data. The IEEE 118-bus case is the
data of the University of Washington archive (typed in by R. Christie, 1993) as MATPOWER's
`case118` holds it, whose licence notice says that the MATPOWER case files are not covered by
its own BSD license and have in most cases been included with permission or converted from
data available from a public source; the archive's page states no licence. The IEEE 300-bus
case is the data of the same archive, developed by the IEEE Test Systems Task Force in 1993
according to the archive's page, as MATPOWER's `case300` holds it, under the same licence note;
the file lacks the phase shifter of the archive's data on branch 196-2040, which the catalog
says. The catalog says what was and was not compared with the publications.

## Cases bundled from the IEEE PES Power Grid Library

IEEE 30-bus test case (`pglib_opf_case30_ieee.m`) and IEEE 57-bus test case
(`pglib_opf_case57_ieee.m`).

These two files are part of the IEEE PES Power Grid Library for optimal power flow
(pglib-opf), release v23.07 (tag `v23.07`, commit `dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3`),
https://github.com/power-grid-lib/pglib-opf, and TENSA bundles them as they are there,
retrieved on 2026-11-18. TENSA changed nothing in them: each is the library's file byte for
byte, header comments included, and the catalog holds the SHA-256 of each, which TENSA checks
whenever one is added to a workspace.

Credit: the header of each file reads "Copyright (c) 1999 by Richard D. Christie, University
of Washington Electrical Engineering Licensed under the Creative Commons Attribution 4.0
International license, http://creativecommons.org/licenses/by/4.0/". The data is that of the
Power Systems Test Case Archive of the University of Washington
(https://labs.ece.uw.edu/pstca/), which R. D. Christie entered in 1993 from data provided by
I. Dabbagchi of AEP, and which the library has prepared for optimal power flow. The library
asks that its version be named when it is cited, and describes itself in S.
Babaeinejadsarookolaee et al., "The Power Grid Library for Benchmarking AC Optimal Power Flow
Algorithms," arXiv:1908.02788, 2019.

Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),
https://creativecommons.org/licenses/by/4.0/. The library's LICENSE file says that its data
is under this licence ("See data files for specific copyright holders and attribution
details") and its software under the MIT licence, which does not cover the data.

Changes: TENSA made none. The library's version of the archive's data is not the archive's
operating point: it sets every generator to 1.0 pu and starts every bus flat, gives the
generators its own dispatch and limits, adds line ratings and angle limits, and gives the
57-bus case a base voltage of 1.0 kV at every bus and three transformers of the 30-bus case a
ratio of 1. The catalog lists them for each case.

No warranty: the data is provided as is, as section 5 of the licence says.

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
