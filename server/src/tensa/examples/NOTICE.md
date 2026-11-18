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

IEEE RTS-24 reliability test system (`pglib_opf_case24_ieee_rts.m`), IEEE 30-bus test case
(`pglib_opf_case30_ieee.m`) and IEEE 57-bus test case (`pglib_opf_case57_ieee.m`).

These three files are part of the IEEE PES Power Grid Library for optimal power flow
(pglib-opf), release v23.07 (tag `v23.07`, commit `dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3`),
https://github.com/power-grid-lib/pglib-opf, and TENSA bundles them as they are there,
retrieved on 2026-11-18. TENSA changed nothing in them: each is the library's file byte for
byte, header comments included, and the catalog holds the SHA-256 of each, which TENSA checks
whenever one is added to a workspace.

Credit: the header of the 30-bus and 57-bus files reads
"Copyright (c) 1999 by Richard D. Christie, University of Washington Electrical Engineering
Licensed under the Creative Commons Attribution 4.0 International license,
http://creativecommons.org/licenses/by/4.0/". The data is that of the Power Systems Test Case
Archive of the University of Washington (https://labs.ece.uw.edu/pstca/), which R. D. Christie
entered in 1993 from data provided by I. Dabbagchi of AEP, and which the library has prepared
for optimal power flow. The header of the RTS-24 file reads
"Copyright (c) 1979 The Institute of Electrical and Electronics Engineers (IEEE) Licensed under
the Creative Commons Attribution 4.0 International license,
http://creativecommons.org/licenses/by/4.0/", and names M. E. Brennan of the IEEE as the
contact for questions about further reuse of the data. The system is the IEEE Reliability Test
System of the IEEE Reliability Test System Task Force of the Applications of Probability
Methods Subcommittee, "IEEE reliability test system," IEEE Transactions on Power Apparatus and
Systems, vol. PAS-98, no. 6, pp. 2047-2054, 1979, doi:10.1109/TPAS.1979.319398; the file's
header names Bruce Wollenberg as the provider of the MATPOWER case file data and the Power
Systems Control and Automation Laboratory of Georgia Tech as the source of its cost data. The
library asks that its version be named when it is cited, and describes itself in S.
Babaeinejadsarookolaee et al., "The Power Grid Library for Benchmarking AC Optimal Power Flow
Algorithms," arXiv:1908.02788, 2019.

Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),
https://creativecommons.org/licenses/by/4.0/. The library's LICENSE file says that its data
is under this licence ("See data files for specific copyright holders and attribution
details") and its software under the MIT licence, which does not cover the data.

Changes: TENSA made none. The library's version of the data is not the original operating
point: it sets every generator to 1.0 pu and starts every bus flat, gives the generators its
own dispatch (and, in the 30-bus and 57-bus files, its own limits), adds line ratings and angle
limits, and gives the 57-bus case a base voltage of 1.0 kV at every bus and three transformers
of the 30-bus case a ratio of 1. The catalog lists them for each case.

No warranty: the data is provided as is, as section 5 of the licence says.

## Case bundled from the RTS-GMLC repository

Reliability Test System of the Grid Modernization Lab Consortium, PSS/E version 33 file
(`RTS-GMLC.RAW`).

This file is part of the RTS-GMLC repository, https://github.com/GridMod/RTS-GMLC, release
v0.2.3 (commit `3ece0d3725c844056132393ee252b3083dd4eab4`), file
`RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW`, and TENSA bundles it as it is there, retrieved on
2026-11-18. TENSA changed nothing in it: it is the repository's file byte for byte, and the
catalog holds its SHA-256, which TENSA checks whenever it is added to a workspace. The data
was provided by the National Renewable Energy Laboratory (NREL), which is operated by Alliance
for Sustainable Energy, LLC for the U.S. Department of Energy (DOE), and the paper to cite for
it is C. Barrows et al., "The IEEE Reliability Test System: A Proposed 2019 Update," IEEE
Transactions on Power Systems, vol. 35, no. 1, pp. 119-127, 2020,
doi:10.1109/TPWRS.2019.2925557.

Licence: NREL Data Use Disclaimer Agreement, which the repository's README prints
(https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/README.md).
It lets anyone use, copy and distribute the data free of charge for any purpose, provided that
its entire notice appears in all copies of the data, and asks that DOE/NREL/ALLIANCE be
credited in any publication that results from its use. The names DOE/NREL/ALLIANCE may not be
used in advertising or publicity to endorse any product or commercial entity without their
written permission. The notice follows as the repository prints it, and it is also in
`RTS-GMLC-NOTICE.md` beside the file, in the catalog and in the `EXAMPLE-SOURCES.md` that TENSA
writes next to the case in a workspace. The repository's copy of the notice ends in the middle
of a sentence, after the words "ARISES OUT OF OR IN", and so does the copy in the repository's
PowerFactory folder; TENSA has not completed it.

> DATA USE DISCLAIMER AGREEMENT
> *(“Agreement”)*
>
> These data (“Data”) are provided by the National Renewable Energy Laboratory (“NREL”), which is operated by Alliance for Sustainable Energy, LLC (“ALLIANCE”) for the U.S. Department Of Energy (“DOE”).
>
> Access to and use of these Data shall impose the following obligations on the user, as set forth in this Agreement.  The user is granted the right, without any fee or cost, to use, copy, and distribute these Data for any purpose whatsoever, provided that this entire notice appears in all copies of the Data.  Further, the user agrees to credit DOE/NREL/ALLIANCE in any publication that results from the use of these Data.  The names DOE/NREL/ALLIANCE, however, may not be used in any advertising or publicity to endorse or promote any products or commercial entities unless specific written permission is obtained from DOE/NREL/ ALLIANCE.  The user also understands that DOE/NREL/Alliance is not obligated to provide the user with any support, consulting, training or assistance of any kind with regard to the use of these Data or to provide the user with any updates, revisions or new versions of these Data.
>
> **YOU AGREE TO INDEMNIFY DOE/NREL/ALLIANCE, AND ITS SUBSIDIARIES, AFFILIATES, OFFICERS, AGENTS, AND EMPLOYEES AGAINST ANY CLAIM OR DEMAND, INCLUDING REASONABLE ATTORNEYS' FEES, RELATED TO YOUR USE OF THESE DATA.  THESE DATA ARE PROVIDED BY DOE/NREL/Alliance "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL DOE/NREL/ALLIANCE BE LIABLE FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER, INCLUDING BUT NOT LIMITED TO CLAIMS ASSOCIATED WITH THE LOSS OF DATA OR PROFITS, WHICH MAY RESULT FROM AN ACTION IN CONTRACT, NEGLIGENCE OR OTHER TORTIOUS CLAIM THAT ARISES OUT OF OR IN**

Changes: TENSA made none.

## Case bundled from MATPOWER

ACTIVSg200 synthetic 200-bus test case (`case_ACTIVSg200.m`).

This file is part of MATPOWER, release 8.1 (commit `1a828c7af590714499284e36ee9c81273388c594`,
`data/case_ACTIVSg200.m`; the file of release 8.0 is the same), https://github.com/MATPOWER/matpower,
and TENSA bundles it as it is there, retrieved on 2026-11-18. TENSA changed nothing in it: it
is MATPOWER's file byte for byte, header comments included, and the catalog holds its SHA-256,
which TENSA checks whenever it is added to a workspace.

Credit: the header of the file reads "MATPOWER Copyright (c) 2017 by A.B. Birchfield, T. Xu,
K.M. Gegner, K.S. Shetye, and T.J. Overbye Licensed under the Creative Commons Attribution 4.0
International license, https://creativecommons.org/licenses/by/4.0/", and asks that
publications based on the data cite A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and
T. J. Overbye, "Grid Structural Characteristics as Validation Criteria for Synthetic Networks,"
IEEE Transactions on Power Systems, vol. 32, no. 4, pp. 3258-3265, 2017,
doi:10.1109/TPWRS.2016.2616385. The system is synthetic, from the ARPA-E GRID DATA project of
Texas A&M University (https://electricgrids.engr.tamu.edu/), whose page for the case names no
licence and says the data is free for commercial or non-commercial use; the licence stated is
the one in the header above.

Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),
https://creativecommons.org/licenses/by/4.0/. MATPOWER's own software is under the BSD
3-clause licence, which is not the licence of this data.

Changes: TENSA made none.

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
