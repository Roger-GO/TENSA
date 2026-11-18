# Example cases

TENSA has a catalog of example cases: power systems you can add to your workspace and open
at once. Each entry says what the case is for, how large it is, what you can run on it, where
its data comes from, how to cite it, which licence it is under, what was changed in the
data, what to be careful about and how its results were checked.

This page is written from the catalog (`server/src/tensa/examples/catalog.json`) by
`scripts/gen_examples_page.py`, so it says what the program says. Do not edit it by hand.
Every check behind the "Verification" of a case, with what it was compared with and how close
it had to be, is in the [verification report](examples-verification.md).

## Adding a case

The cases marked as first run are copied into an empty workspace the first time the server
starts. Any case can be added later. In the app, **Example cases** lists them: it is the button
in the Workspace part of the Project tab, an item of the Workspace menu and a command in the
command palette. The cases are grouped by what they support. **Add to workspace** copies a
case's file in and **Open** loads it. **Cite** shows its references, each marked as the publication of
the system, the source of the data, the software or a dynamic model, and copies them as text or
as BibTeX with those marks, and the links to its source and licence open in a new tab. A case that is only links
to data TENSA does not hold has an **Open source page** link instead. From the command line:

```bash
tensa examples list --workspace ~/tensa-cases
tensa examples add ieee14 --workspace ~/tensa-cases
tensa examples cite ieee14
```

`list` and `add` work on a workspace: name the folder your server was started with, as
`--workspace` does for `tensa serve`. Left out, it is `~/.tensa/cases`, which is where
`tensa serve` looks too when it is not told another folder, so a server started with a
different one does not see the file. `tensa examples add` leaves a file that is already in the
workspace alone, and `--force` replaces it. `tensa examples cite` prints the plain-text
citations of a case and `--bibtex` prints them as BibTeX. The same is available from the API (`GET /api/examples` and
`POST /api/examples/{id}/add`) and to an assistant as the MCP tools `list_examples` and
`add_example`.

Whenever a case is added, TENSA writes `EXAMPLE-SOURCES.md` in the workspace root. It records
the source, the citations and the licence of everything that was added, next to the files
themselves. It is not a case file and the file list does not show it.

A case that comes from ANDES is copied from the ANDES installed on your machine, not from
TENSA. If the file there is not the one the catalog was written against, TENSA adds it anyway
and warns you, because the results may then differ from the ones documented here.

A workspace can hold another file under the name of a case that TENSA bundles: an earlier
release put a different file there (the WSCC 9-bus case was ANDES's network with no machines
until this one), or the file was edited. Adding the case does not replace it. The card then
says **Different file** and not **Added**, and **Replace with this version** puts the shipped
file in its place once you have confirmed it, since that overwrites your copy.
`tensa examples list` says `added, differs` for such a case, `GET /api/examples` sets its
`differs` field, and `tensa examples add --force` or `overwrite=true` replaces the file.

## The cases

| Case | Size | Analyses | First run | Source |
| --- | --- | --- | --- | --- |
| [IEEE 14-bus, with machines and controls](#ieee14) | 14 buses, 5 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [Kundur two-area system, modified by ANDES](#kundur) | 10 buses, 4 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [WSCC 9-bus, with classical machines](#wscc9) | 9 buses, 3 generators | Power flow, Time domain, Eigenvalues | yes | Bundled with TENSA |
| [IEEE 39-bus New England system, with machines, controls and stabilisers](#ieee39) | 39 buses, 10 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [NPCC 140-bus, 48-machine system](#npcc) | 140 buses, 48 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [WECC 179-bus, 29-machine system](#wecc) | 179 buses, 29 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |
| [Kundur two-area system with a stabiliser on one generator](#kundur_pss) | 10 buses, 4 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |
| [IEEE 14-bus with a fault built in](#ieee14_fault) | 14 buses, 5 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |
| [PJM 5-bus system with classical machines and a line trip](#pjm5bus) | 5 buses, 4 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |
| [IEEE 14-bus with a solar plant](#ieee14_solar) | 14 buses, 5 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |
| [IEEE 14-bus with a type-3 wind turbine](#ieee14_wt3) | 14 buses, 5 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |
| [IEEE RTS-24 reliability test system, as PGLib-OPF holds it](#rts24) | 24 buses, 33 generators | Power flow | no | Bundled with TENSA |
| [IEEE 30-bus test case, as PGLib-OPF holds it](#ieee30) | 30 buses, 6 generators | Power flow | no | Bundled with TENSA |
| [IEEE 57-bus test case, as PGLib-OPF holds it](#ieee57) | 57 buses, 7 generators | Power flow | no | Bundled with TENSA |
| [RTS-GMLC reliability test system, 73 buses](#rts_gmlc) | 73 buses, 160 generators | Power flow | no | Bundled with TENSA |
| [PEGASE 89-bus test case (part of the European transmission system)](#pegase89) | 89 buses, 12 generators | Power flow | no | Bundled with TENSA |
| [IEEE 118-bus test case](#ieee118) | 118 buses, 54 generators | Power flow | no | Your ANDES install |
| [ACTIVSg200 synthetic 200-bus test case (Illinois)](#activsg200) | 200 buses, 49 generators | Power flow | no | Bundled with TENSA |
| [IEEE 300-bus test case](#ieee300) | 300 buses, 69 generators | Power flow | no | Your ANDES install |
| [PEGASE 1354-bus test case (part of the European transmission system)](#pegase1354) | 1354 buses, 260 generators | Power flow | no | Bundled with TENSA |
| [ACTIVSg2000 synthetic 2000-bus test case (Texas)](#activsg2000) | 2000 buses, 544 generators | Power flow | no | Bundled with TENSA |
| [ACTIVSg200 with dynamic data (Texas A&M), 200 buses](#activsg200_dyn) | 200 buses, 49 generators | - | no | Link |
| [ACTIVSg2000 with dynamic data (Texas A&M), 2000 buses](#activsg2000_dyn) | 2000 buses, 544 generators | Power flow | no | Link |
| [Reduced 240-bus WECC with renewables (NLR), 243 buses](#wecc240) | 243 buses, 146 generators | Power flow | no | Link |
| [IEEE PES small-signal stability benchmark systems](#pes_benchmarks) | - | - | no | Link |
| [Nordic test system for voltage stability (IEEE PES), 74 buses](#nordic) | 74 buses, 20 generators | - | no | Link |
| [IEEE 145-bus 50-generator and 162-bus 17-generator dynamic cases (University of Washington)](#uw_dynamic) | - | - | no | Link |
| [MATPOWER case library](#matpower_library) | - | - | no | Link |
| [PGLib-OPF benchmark library](#pglib_opf_library) | - | - | no | Link |
| [University of Washington Power Systems Test Case Archive](#uw_archive) | - | - | no | Link |
| [Texas A&M Electric Grid Test Case Repository](#tamu_repository) | - | - | no | Link |
| [Edinburgh GB network and test case archive](#edinburgh_gb) | - | - | no | Link |

### IEEE 14-bus, with machines and controls { #ieee14 }

The IEEE 14-bus system with a round-rotor machine, an exciter and a governor on each generator: the usual first case for a power flow, a fault study and the eigenvalue analysis.

- **Id:** `ieee14`
- **Kind:** Dynamic
- **Size:** 14 buses, 5 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** yes
- **File:** `ieee14_full.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/ieee14/ieee14_full.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `ed5a7551ca9258fba9988fc8bdf9d66842f786141d607b99f389a1b6c52bc137`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/ieee14_full.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **Data source:** IEEE 14 Bus Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm (accessed 2026-11-17). [Link](https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm)
- **Data source:** ANDES, andes/cases/ieee14/README.md, release 2.0.0: the power flow data of ieee14.raw is by J. Conto and the dynamic data by H. Cui, both written for ANDES (https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee14,
  title        = {{IEEE} 14 Bus Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm},
  urldate      = {2026-11-17}
}
```

```bibtex
% Data source
@misc{andes_ieee14_readme,
  title        = {{ANDES} cases: {IEEE} 14-bus systems (README)},
  howpublished = {ANDES release 2.0.0, andes/cases/ieee14/README.md},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The dynamic data (round-rotor machines, a TGOV1 governor on each, an EXST1 exciter on one machine and an ESST3A on each of the other four) was written for ANDES by H. Cui, according to the ANDES cases README, and is not published by the IEEE.
- This is not the IEEE 14-bus case as the University of Washington archive distributes it. The line and transformer reactances, the line charging and the shunt at bus 9 are the archive's. The rest was changed in the PSS/E version prepared by J. Conto: the loads at buses 3, 4, 6 and 14 (bus 3 takes 50 MW and 25 MVAr where the archive has 94.2 MW and 19.0 MVAr), a 15 MVAr shunt at bus 14, the dispatch (generators at buses 2, 3, 6 and 8 deliver 40, 40, 30 and 35 MW, where the archive has power at buses 1 and 2 only), the voltage set-points (1.03 pu at buses 1, 2, 6 and 8 and 1.01 at bus 3, where the archive has 1.060, 1.045, 1.010, 1.070 and 1.090), the reactive limits, and the ratio of the four transformers (0.99677 on each, where the archive has 0.978, 0.969, 0.932 and none).
- The power flow solution therefore differs from the one the archive stores, by up to 0.06 pu in voltage and 11.8 degrees in angle (bus 8). Do not compare results of this file with published IEEE 14-bus results.
- No event is built in. The fault used for the verification is added through the API: a three-phase fault at bus 9 from 1.0 s to 1.1 s.

**Verification.** Compared with independent references: the power flow (bus voltages, angles, losses and the slack's power) agrees with pandapower's solution of the same network to 6e-9 pu and 8.5e-7 degrees. TENSA's power flow was also run on the archive's own data (MATPOWER's case14, which ANDES ships) and reproduces the solution the archive stores to 1.3e-3 pu and 0.017 degrees, which is the precision the archive stores it in (server/tests/integration/test_example_archive_solution.py). That checks the solver, not this file, whose data differ from the archive's. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution, and the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.025 Hz and 0.027. Not verified: the fault run and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. No published result exists for this data.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_2, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 1.012 Hz, damping 0.248 is eigenvalue 1.019 Hz, 0.275 (0.006 Hz and 0.027 apart); 0.952 Hz, damping 0.229 is eigenvalue 0.949 Hz, 0.245 (0.004 Hz and 0.015 apart); 1.078 Hz, damping 0.270 is eigenvalue 1.053 Hz, 0.261 (0.025 Hz and 0.009 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_full.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 5.51e-09 pu (bus 9) over 14 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 8.46e-07 deg (bus 14) over 14 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 2.72721, expected 2.72721, difference 1.24e-06 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 81.4272, expected 81.4272, difference 1.24e-06 MW | yes |
| Largest rotor angle spread in the disturbance run (fault at bus 9) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 60.2428, expected 60.2428, difference 2.19e-07 deg | yes |
| Lowest bus voltage in the disturbance run (fault at bus 9) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.000444015, expected 0.000444015, difference 1.63e-13 pu | yes |
| Lowest machine frequency in the disturbance run (fault at bus 9) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9556, expected 59.9556, difference 1.85e-07 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.948748, expected 0.948748, difference 3.92e-09 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.244586, expected 0.244586, difference 5.43e-10 | yes |

### Kundur two-area system, modified by ANDES { #kundur }

Four generators in two areas joined by a weak tie, the standard case for inter-area oscillations, with a round-rotor machine, an exciter and a governor on each generator.

- **Id:** `kundur`
- **Kind:** Dynamic
- **Size:** 10 buses, 4 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** yes
- **File:** `kundur_full.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/kundur/kundur_full.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `f725e03ba12d8207616f68acdd606bbd35e7c4a68f13e66d7db43925adac2ed8`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/kundur/kundur_full.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **System:** P. Kundur, Power System Stability and Control. New York: McGraw-Hill, 1994, ISBN 0-07-035958-X.
- **System:** M. Klein, G. J. Rogers and P. Kundur, "A fundamental study of inter-area oscillations in power systems," IEEE Transactions on Power Systems, vol. 6, no. 3, pp. 914-921, 1991, doi:10.1109/59.119229. [DOI](https://doi.org/10.1109/59.119229)
- **Data source:** CRESYM Colib, Kundur two-area system (test case page: the data of the book's system, with a load flow and the small-signal examples), https://colib.net/testCases/kundur_two_area_system/index.html (accessed 2026-11-17). Used here only to compare the file with the book's data. [Link](https://colib.net/testCases/kundur_two_area_system/index.html)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@book{kundur1994,
  author    = {Kundur, Prabha},
  title     = {Power System Stability and Control},
  publisher = {McGraw-Hill},
  address   = {New York},
  year      = {1994},
  isbn      = {007035958X}
}
```

```bibtex
% System
@article{klein1991fundamental,
  author  = {Klein, M. and Rogers, G. J. and Kundur, P.},
  title   = {A fundamental study of inter-area oscillations in power systems},
  journal = {IEEE Transactions on Power Systems},
  volume  = {6},
  number  = {3},
  pages   = {914--921},
  year    = {1991},
  doi     = {10.1109/59.119229}
}
```

```bibtex
% Data source
@misc{colib_kundur_two_area,
  title        = {Kundur two-area system},
  howpublished = {CRESYM Colib, test cases},
  url          = {https://colib.net/testCases/kundur_two_area_system/index.html},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- This is not the system of the book as printed, and its results must not be compared with the book's. The file's own title is "Modified Kundur's two-area test system, distributed with ANDES". It has 10 buses where the book's system has 11, the tie is three parallel lines of 0.22 per unit reactance on 100 MVA, the loads are 1159 MW at bus 7 and 1575 MW at bus 8 with a small net reactive power (-73.5 and -89.9 MVAr), where the book has 967 MW with 100 MVAr and a 200 MVAr capacitor and 1767 MW with 100 MVAr and a 350 MVAr capacitor, and the step-up transformers are 0.012 per unit on 100 MVA where the book's are 0.15 on 900 MVA.
- The dispatch and the voltages differ from the book's operating point as well: three generators deliver 700 MW with a set-point of 1.00 pu and the fourth is the slack (about 727 MW in the power flow solution), where the book has 700, 700, 719 and 700 MW and terminal voltages of 1.03, 1.01, 1.03 and 1.01 pu.
- The machines match the book's table in their inertia (6.5 s and 6.175 s), reactances (Xd 1.8, Xq 1.7, X'd 0.3, X'q 0.55, X''d and X''q 0.25 per unit) and open-circuit time constants (8, 0.03, 0.4 and 0.05 s), and differ in the leakage reactance (0.06 where the book has 0.2), the armature resistance (0 where the book has 0.0025) and the saturation (none where the book has A = 0.015 and B = 9.6). Each machine has a DC type 2 exciter and a TGOV1 governor, which the book's examples do not.
- One event is built into the file: Line_8 is switched out at 2 s.
- The eigenvalues the book gives for its system could not be read from any source opened for this entry, and they belong to another network and other exciters in any case, so no published mode is compared.

**Verification.** Compared with an independent reference: the power flow agrees with pandapower's solution of the same network to 2.3e-7 pu and 4.4e-5 degrees. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (largest change 3.5e-6), and the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.007 Hz and 0.005: the inter-area mode at 0.647 Hz with a damping ratio of 0.034 and a local mode at 1.141 Hz. Not verified: the Line_8 trip and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. No published value is compared, because the file is not the system of the book (see the caveats).

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_1, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 0.649 Hz, damping 0.034 is eigenvalue 0.647 Hz, 0.034 (0.002 Hz and 0.000 apart); 1.134 Hz, damping 0.093 is eigenvalue 1.141 Hz, 0.089 (0.007 Hz and 0.005 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_full.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 2.33e-07 pu (bus 7) over 10 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 4.41e-05 deg (bus 8) over 10 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 92.8029, expected 92.8024, difference 0.000533 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 726.803, expected 726.802, difference 0.000526 MW | yes |
| Largest rotor angle spread in the disturbance run (Line_8 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 30.7114, expected 30.7114, difference 3.63e-07 deg | yes |
| Lowest bus voltage in the disturbance run (Line_8 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.871601, expected 0.871601, difference 3.13e-09 pu | yes |
| Lowest machine frequency in the disturbance run (Line_8 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9992, expected 59.9992, difference 5.04e-08 Hz | yes |
| Inter-area mode between 0.3 and 0.9 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.646897, expected 0.646897, difference 2.36e-09 Hz | yes |
| Inter-area mode between 0.3 and 0.9 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.0343092, expected 0.0343092, difference 2.78e-10 | yes |
| Least damped local mode between 0.9 and 1.5 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 1.10779, expected 1.10779, difference 6.38e-09 Hz | yes |
| Least damped local mode between 0.9 and 1.5 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.086553, expected 0.086553, difference 2.5e-10 | yes |

### WSCC 9-bus, with classical machines { #wscc9 }

The 3-machine, 9-bus system of Anderson and Fouad with its three machines on the classical model, as in Example 2.6 of the book: the smallest case for a fault, a swing curve and the electromechanical modes of three machines. It has no exciter and no governor.

- **Id:** `wscc9`
- **Kind:** Dynamic
- **Size:** 9 buses, 3 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** yes
- **File:** `wscc9.xlsx`

**Source.** Bundled with TENSA as `wscc9.xlsx`. TENSA builds this file itself with the script at <https://github.com/Roger-GO/TENSA/blob/main/scripts/build_wscc9.py>, written 2026-11-17; it is not retrieved from anywhere. SHA-256 `ce980cc07d6dfc133fe66473610fa6e3a3962c4ccd09734d2d6d951df525c758`.

**Licence.** [GPL-3.0-or-later](https://github.com/Roger-GO/TENSA/blob/main/LICENSE). The file is written by TENSA's scripts/build_wscc9.py and is distributed with TENSA under its licence. The numbers in it are those of the book in the first citation, which is the work to cite for the system.

**Citations**

- **System:** P. M. Anderson and A. A. Fouad, Power System Control and Stability, 2nd ed. Piscataway, NJ: IEEE Press; Hoboken, NJ: Wiley-Interscience, 2003, ISBN 0-471-23862-7, doi:10.1109/9780470545577. The system is the one of Chapter 2 and its Example 2.6. [DOI](https://doi.org/10.1109/9780470545577)
- **Data source:** B. Wang, Y. Liu and K. Sun, "Power System Differential-Algebraic Equations," arXiv:1512.05185, 2015. It prints the classical-model data of this system (H, x'd, the mechanical powers, the internal voltages and the reduced admittance matrix of Example 2.6) that the build of this case is checked against. [Link](https://arxiv.org/abs/1512.05185)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@book{anderson2003power,
  author    = {Anderson, Paul M. and Fouad, A. A.},
  title     = {Power System Control and Stability},
  edition   = {2nd},
  publisher = {IEEE Press and Wiley-Interscience},
  address   = {Piscataway, NJ},
  year      = {2003},
  isbn      = {0471238627},
  doi       = {10.1109/9780470545577}
}
```

```bibtex
% Data source
@misc{wang2015dae,
  author        = {Wang, Bin and Liu, Yang and Sun, Kai},
  title         = {Power System Differential-Algebraic Equations},
  year          = {2015},
  eprint        = {1512.05185},
  archivePrefix = {arXiv},
  url           = {https://arxiv.org/abs/1512.05185}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** The file is written by scripts/build_wscc9.py from the data of the book, not copied from ANDES: the network and the loads are the book's, and the three machines are added as classical models (GENCLS) with the book's inertia constants and transient reactances on the 100 MVA base, no damping and no armature resistance; The power flow solution is stored in the file as the initial state, rounded to six places, as the ANDES example cases do; The transformers are lines with a reactance and the nominal ratio (the book gives a reactance only), flagged as transformers; No fault or other event is built in

**Caveats**

- ANDES ships a file of the same network, wscc9/wscc9.xlsx, with no machines. It is not this system: its reactances of lines 4-5, 6-9 and 7-8 (0.068, 0.1738 and 0.0576 per unit) are not the book's (0.085, 0.170 and 0.072), and its power flow differs (the angle of bus 3 is 5.14 degrees against the book's 4.66). Results from the two files must not be compared.
- Classical model: constant voltage behind the transient reactance, constant mechanical power, loads as constant impedances and no damping. Its modes lie on the imaginary axis (a damping ratio of 0) and a swing after a fault does not die out.
- To run the book's fault, add it in the app: a three-phase fault at bus 7 from 1.0 s to 1.0833 s (5 cycles at 60 Hz) and a trip of line 5-7 (Line_2) at 1.0833 s. With the default step the faster mode swings 1.6 percent slow (the trapezoidal rule's lag, 0.034 Hz at 2.1 Hz); a step of 1/120 s reproduces a continuous solution to a fraction of a degree.
- The inertia constants and reactances are per unit on 100 MVA, as the book tabulates them, so each machine is rated at 100 MVA here; the book's machine ratings (247.5, 192 and 128 MVA) are not in the file.
- A workspace made by an earlier TENSA holds ANDES's steady-state wscc9.xlsx under this name. Adding this case does not replace that file unless you ask. In the Example cases dialog the card says Different file and offers Replace with this version; on the command line tensa examples list says added, differs and tensa examples add wscc9 --force replaces it.

**Verification.** The data was checked against the book: the power flow solution (bus voltages, the generator angles and the slack's power) agrees with the one the book prints, to its printed precision, and the reduced admittance matrix and the initial state of the machines computed from the file agree with those of Example 2.6 as printed by Wang, Liu and Sun, to four decimals (server/tests/unit/test_wscc9_build.py). The power flow agrees with pandapower's solution of the same network to 2e-8 pu. The modes and the book's fault (a three-phase fault at bus 7, cleared after 5 cycles by opening line 5-7) were also computed independently of TENSA and ANDES (Kron reduction, the linearised swing equations, scipy's DOP853 integration), and TENSA agrees: the modes (1.383 and 2.126 Hz, undamped) to 5e-7 Hz, the largest rotor angle spread (85.8 degrees) to 0.004 degrees, the lowest bus voltage to 4e-6 pu and the lowest machine frequency to 1.1e-4 Hz. The undisturbed 10 s run does not move, and the ring-down of a load step has the frequencies of the eigenvalues within 0.034 Hz, which is what the trapezoidal rule's error at TENSA's default step comes to. Not compared: the swing curves of the book's figures, which no source opened gives as numbers, and no published value of the two modes was found. The run is stable and its swings do not die out, as those of an undamped model do not.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_0, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 1.374 Hz, damping 0.000 is eigenvalue 1.383 Hz, 0.000 (0.009 Hz and 0.000 apart); 2.093 Hz, damping 0.000 is eigenvalue 2.126 Hz, 0.000 (0.034 Hz and 0.000 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wscc9.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 2.19e-08 pu (bus 5) over 9 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wscc9.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 7.88e-07 deg (bus 2) over 9 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wscc9.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 4.64103, expected 4.64102, difference 6.07e-06 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wscc9.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 71.641, expected 71.641, difference 6.07e-06 MW | yes |
| Frequency of mode 1 of 2, 1.383 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.001 Hz | measured 1.38302, expected 1.38302, difference 4.54e-07 Hz | yes |
| Damping ratio of mode 1 of 2, 1.383 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.0001 | measured 0, expected 0, difference 0 | yes |
| Frequency of mode 2 of 2, 2.126 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.001 Hz | measured 2.12634, expected 2.12634, difference 4.31e-07 Hz | yes |
| Damping ratio of mode 2 of 2, 2.126 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.0001 | measured 0, expected 0, difference 0 | yes |
| Largest rotor angle spread in the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.00833333 s | 0.05 deg | measured 85.7914, expected 85.7874, difference 0.00399 deg | yes |
| Rotor angle spread at the end of the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.00833333 s | 0.5 deg | measured 74.3698, expected 74.6171, difference 0.247 deg | yes |
| Lowest bus voltage in the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.00833333 s | 5e-05 pu | measured 0.00108951, expected 0.001093, difference 3.49e-06 pu | yes |
| Lowest machine frequency in the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for wscc9.xlsx: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.00833333 s | 0.002 Hz | measured 59.9624, expected 59.9623, difference 0.000111 Hz | yes |
| Bus voltage magnitudes against the solution printed in the book | a published result | P. M. Anderson and A. A. Fouad, Power System Control and Stability, 2nd ed. (2003), Chapter 2, the nine-bus power flow solution (page 38), as quoted in Table 1 of ETAP's validation case TCS-LF-008, Load Flow Comparison Case 2 (https://etap.com/docs/default-source/validation-case-documents/etap_comparisonresults_lf2.pdf, retrieved 2026-11-17). The book prints the magnitudes to three decimals, so the tolerance is the rounding (0.0005) and a little over. | 0.0006 pu | largest difference 0.000369 pu (bus 5) over 9 buses | yes |
| Angles of the generator buses against the solution printed in the book | a published result | P. M. Anderson and A. A. Fouad, Power System Control and Stability, 2nd ed. (2003), Chapter 2, the nine-bus power flow solution (page 38), as quoted in Table 1 of ETAP's validation case TCS-LF-008, Load Flow Comparison Case 2 (https://etap.com/docs/default-source/validation-case-documents/etap_comparisonresults_lf2.pdf, retrieved 2026-11-17). The book prints the angles to 0.1 degree, so the tolerance is the rounding (0.05) and a little over. The quoted table gives no usable angle for the other buses. | 0.06 deg | largest difference 0.0352 deg (bus 3) over 2 buses | yes |
| Slack active power against the solution printed in the book | a published result | P. M. Anderson and A. A. Fouad, Power System Control and Stability, 2nd ed. (2003), Chapter 2, the nine-bus power flow solution (page 38), as quoted in Table 1 of ETAP's validation case TCS-LF-008, Load Flow Comparison Case 2 (https://etap.com/docs/default-source/validation-case-documents/etap_comparisonresults_lf2.pdf, retrieved 2026-11-17). The book prints 71.6 MW for the generator at bus 1. | 0.1 MW | measured 71.641, expected 71.6, difference 0.041 MW | yes |

### IEEE 39-bus New England system, with machines, controls and stabilisers { #ieee39 }

The 39-bus, 10-machine New England system with a round-rotor machine, an exciter, a governor and a power system stabiliser on every machine: a mid-size case for a fault study, inter-area oscillations and the eigenvalue analysis.

- **Id:** `ieee39`
- **Kind:** Dynamic
- **Size:** 39 buses, 10 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** yes
- **File:** `ieee39_full.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/ieee39/ieee39_full.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `9c2048dc94201ee48ffe816de65d53831fa1f4b0e7fdf32f24c50f1017edcfe5`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee39/ieee39_full.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **System:** T. Athay, R. Podmore and S. Virmani, "A practical method for the direct analysis of transient stability," IEEE Transactions on Power Apparatus and Systems, vol. PAS-98, no. 2, pp. 573-584, March 1979, doi:10.1109/TPAS.1979.319407. The system's data are traced to this paper, and from it to G. W. Bills et al., On-Line Stability Analysis Study, EEI RP 90-1, 1970, by the header of MATPOWER's case39.m and by pandapower's documentation (neither work was opened for this entry). [DOI](https://doi.org/10.1109/TPAS.1979.319407)
- **System:** M. A. Pai, Energy Function Analysis for Power System Stability. Boston, MA: Kluwer Academic Publishers, 1989, doi:10.1007/978-1-4613-1635-0. The book MATPOWER's case39.m names as the source of its 39-bus data (the book itself was not opened). [DOI](https://doi.org/10.1007/978-1-4613-1635-0)
- **Data source:** MATPOWER, data/case39.m, release 8.0, https://github.com/MATPOWER/matpower/blob/8.0/data/case39.m (accessed 2026-11-17). Its header describes the 39-bus New England system as generally representative of the New England 345 kV system and gives the sources above. Used here only to compare the file with the system as MATPOWER holds it. [Link](https://github.com/MATPOWER/matpower/blob/8.0/data/case39.m)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@article{athay1979practical,
  author  = {Athay, T. and Podmore, R. and Virmani, S.},
  title   = {A practical method for the direct analysis of transient stability},
  journal = {IEEE Transactions on Power Apparatus and Systems},
  volume  = {PAS-98},
  number  = {2},
  pages   = {573--584},
  year    = {1979},
  month   = mar,
  doi     = {10.1109/TPAS.1979.319407}
}
```

```bibtex
% System
@book{pai1989energy,
  author    = {Pai, M. A.},
  title     = {Energy Function Analysis for Power System Stability},
  publisher = {Kluwer Academic Publishers},
  address   = {Boston, MA},
  year      = {1989},
  doi       = {10.1007/978-1-4613-1635-0}
}
```

```bibtex
% Data source
@misc{matpower_case39,
  title        = {{MATPOWER} case39: the 39-bus {New England} system},
  howpublished = {MATPOWER release 8.0, data/case39.m},
  url          = {https://github.com/MATPOWER/matpower/blob/8.0/data/case39.m},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- This is not the 39-bus system as MATPOWER's case39 (and the sources above) give it, and its results must not be compared with published ones. The network is the same (46 branches between the same buses, and the same line and transformer data except two entries), but the loads, the dispatch, the voltage set-points and two branches were changed in the PSS/E version prepared by J. Conto, whose name the file's title carries. The total load is 5856 MW where MATPOWER's has 6254 MW, with different loads at buses 1, 3, 4, 9, 12, 29, 31 and 39 (bus 39 takes 400 MW where MATPOWER's takes 1104 MW), a capacitor of 100 MVAr at bus 4 and one of 200 MVAr at bus 5 that MATPOWER's does not have, the generators deliver other powers and hold other voltages (the slack is the generator at bus 39, where MATPOWER's slack is at bus 31), the tap of the transformer between buses 6 and 31 is 0.9 on the side of bus 31 where MATPOWER's is 1.07 on the side of bus 6, and the charging of line 25-26 is 0.513 per unit where MATPOWER's is 0.531. The comparison was made with the case39 data that pandapower 3.5.6 ships, which its documentation says come from PYPOWER.
- The machine, exciter, governor and stabiliser data come with ANDES, which gives no source for them in its cases, so this entry cannot say where their parameters come from. They are not those of any publication it cites. Every machine has an IEEEX1 exciter, a TGOV1N governor and an IEEEST stabiliser, so its modes are well damped (the least damped oscillatory mode has a damping ratio of 0.15) and are not those of the plain New England system.
- The file holds one event that is switched off: Toggler_1 would trip the generator at bus 30 (GENROU_1) at 12 s, after the default end time. The disturbance used for the verification is added through the API: a three-phase fault at bus 16 from 1.0 s to 1.1 s.
- The bus voltages and angles stored in the file are not a power flow solution (the voltage at bus 7 is stored as 0.863 pu, the solution has 1.060), so no stored solution is compared; the power flow starts from them and converges in 4 iterations.
- ANDES 2.0.0's eigenvalue analysis returns six real eigenvalues between +1.004 and +1.033 per second for this case, which the Eigenvalues panel shows as unstable modes. They are most likely not modes of the model: the ring-down run of the verification, which starts from the same state, does not grow (its last swing is smaller than its first), where a mode of +1 per second excited by the load step would grow it by a factor of hundreds of millions over its 20 s. They appear with the states that have no time constant (50 of the 220 here), which ANDES folds into the algebraic equations before it forms the state matrix. The electromechanical modes are not affected: the ring-down has the frequencies and damping ratios of the eigenvalues.

**Verification.** Compared with independent references: the power flow (bus voltages, angles, losses and the slack's power) agrees with pandapower's solution of the same network to 1.7e-7 pu and 1.4e-5 degrees. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (largest change 1.5e-9), the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.005 Hz and 0.007 (modes at 0.639, 0.962 and 1.114 Hz, damping ratios 0.188, 0.183 and 0.206), and the run does not grow. The fault at bus 16 is stable: the rotor angles swing out to 101 degrees apart and come back to within 0.6 degrees of where they began. Not verified: the fault run and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. No published result exists for this data (it is not the system of the publications, see the caveats), and the file's stored state is not a power flow solution, so there is no stored solution to compare with.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_9, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 0.641 Hz, damping 0.185 is eigenvalue 0.639 Hz, 0.188 (0.002 Hz and 0.004 apart); 0.962 Hz, damping 0.177 is eigenvalue 0.962 Hz, 0.183 (0.000 Hz and 0.006 apart); 1.109 Hz, damping 0.199 is eigenvalue 1.114 Hz, 0.206 (0.005 Hz and 0.007 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee39_full.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.73e-07 pu (bus 4) over 39 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee39_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 1.4e-05 deg (bus 18) over 39 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee39_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 37.1015, expected 37.1009, difference 0.000568 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee39_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 573.11, expected 573.11, difference 0.000568 MW | yes |
| Largest rotor angle spread in the disturbance run (fault at bus 16) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 100.907, expected 100.907, difference 3.4e-06 deg | yes |
| Lowest bus voltage in the disturbance run (fault at bus 16) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.00777993, expected 0.00777993, difference 1.47e-11 pu | yes |
| Lowest machine frequency in the disturbance run (fault at bus 16) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.8481, expected 59.8481, difference 1.24e-07 Hz | yes |
| Least damped mode between 0.4 and 0.8 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.638821, expected 0.638821, difference 2.54e-09 Hz | yes |
| Least damped mode between 0.4 and 0.8 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.188313, expected 0.188313, difference 3.42e-09 | yes |
| Least damped mode between 0.8 and 1.2 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.962418, expected 0.962418, difference 4.45e-09 Hz | yes |
| Least damped mode between 0.8 and 1.2 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.182904, expected 0.182904, difference 2.02e-09 | yes |

### NPCC 140-bus, 48-machine system { #npcc }

A 140-bus, 48-machine model of the northeast of the Eastern Interconnection, with 27 round-rotor and 21 classical machines, 29 governors and 24 exciters, and a line trip with a reclose built in: a large case for a time-domain run and for a system with many modes.

- **Id:** `npcc`
- **Kind:** Dynamic
- **Size:** 140 buses, 48 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** yes
- **File:** `npcc.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/npcc/npcc.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `f85a46d5f4b4910b09c7b141b85504fc060b812f5f940f266db8c9784f755b21`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/npcc/npcc.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **System:** J. H. Chow and K. W. Cheung, "A toolbox for power system dynamics and control engineering education and research," IEEE Transactions on Power Systems, vol. 7, no. 4, pp. 1559-1564, 1992, doi:10.1109/59.207380. The paper on the Power System Toolbox, which distributes the 48-machine, 140-bus NPCC system: it is the work Qi, Sun and Kang cite for it (the next entry). The paper itself was not opened, so which of its pages describes the system is not stated here. [DOI](https://doi.org/10.1109/59.207380)
- **System:** J. Qi, K. Sun and W. Kang, "Adaptive optimal PMU placement based on empirical observability Gramian," arXiv:1411.7016 (section 5, case study). It tests on the NPCC 48-machine, 140-bus system, cites Chow and Cheung (1992) for it, calls it a model of the northeast region of the Eastern Interconnection and says that 27 of its 48 generators have a fourth-order transient model and the others the classical second-order one, which is what this file holds. [Link](https://arxiv.org/abs/1411.7016)
- **Software:** H. Cui, ANDES documentation, Verification: CURENT NPCC verification notebook, ANDES release 2.0.0 (docs/source/verification/andes-npcc-verification.ipynb), https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-npcc-verification.ipynb (accessed 2026-11-17). It describes the system, its models and the line trip that ANDES was compared with DSATools TSAT on. [Link](https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-npcc-verification.ipynb)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@article{chow1992toolbox,
  author  = {Chow, J. H. and Cheung, K. W.},
  title   = {A toolbox for power system dynamics and control engineering education and research},
  journal = {IEEE Transactions on Power Systems},
  volume  = {7},
  number  = {4},
  pages   = {1559--1564},
  year    = {1992},
  doi     = {10.1109/59.207380}
}
```

```bibtex
% System
@misc{qi2014adaptive,
  author        = {Qi, Junjian and Sun, Kai and Kang, Wei},
  title         = {Adaptive Optimal {PMU} Placement Based on Empirical Observability {Gramian}},
  year          = {2014},
  eprint        = {1411.7016},
  archivePrefix = {arXiv},
  url           = {https://arxiv.org/abs/1411.7016}
}
```

```bibtex
% Software
@misc{andes_npcc_verification,
  author       = {Cui, Hantao},
  title        = {{ANDES} documentation, Verification: NPCC verification notebook},
  howpublished = {ANDES release 2.0.0, docs/source/verification/andes-npcc-verification.ipynb},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-npcc-verification.ipynb},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The file is the CURENT NPCC 48-machine test bed. Its RAW source gives the title "CURENT NPCC 48-machine testbed, converted from PST by Bin Wang", revised by Yin Lei on 18 November 2013. Whether its data are identical to those of the Power System Toolbox was not checked, because the toolbox data were not opened, so the references above describe the system and do not guarantee that this file matches them.
- Of the 48 machines, 27 are round-rotor (GENROU, all with a TGOV1 governor and 24 of them with an IEEEX1 exciter) and 21 classical (GENCLS, none with an exciter and 2 with a TGOV1 governor). The least damped modes lie between 2 and 5 Hz (damping ratios 0.017 at 2.47 Hz and 0.009 at 4.48 Hz).
- Two events are built into the file: Line_2 (bus 1 to bus 4) trips at 1.0 s and reconnects at 1.1 s. The disturbance of the verification is these two events.
- In the time domain loads are constant impedances, as ANDES has them by default.
- ANDES 2.0.0's eigenvalue analysis returns one real eigenvalue with a positive real part for this case (+0.011 per second), which the Eigenvalues panel shows as an unstable mode. The checks here can neither confirm it nor exclude it: a growth of 0.011 per second would be a factor of 1.25 over the 20 s ring-down. The states that take part in it are governor and exciter states, and they do not move in a run of 600 s that was made by hand (not part of the verification), so it is most likely a numerical effect of how ANDES folds the states that have no time constant (48 here) into the algebraic equations. The electromechanical modes are not affected: the ring-down has the frequencies and damping ratios of the eigenvalues.
- ANDES's own documentation compares this case with DSATools TSAT and finds identical results for a line trip, but the comparison is a set of plots whose data are not published, so it could not be used as a reference here.

**Verification.** Compared with independent references: the power flow agrees with pandapower's solution of the same network to 1.7e-7 pu and 2.5e-5 degrees, and with the solved state stored in the case file (taken from the PSS/E RAW file it was converted from, which TENSA did not compute) to 7.3e-6 pu, 0.0008 degrees and 0.019 MW at the slack, which is the precision of the stored state. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (largest change 3.4e-8), the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.012 Hz and 0.040 (the strongest oscillations are at 1.28 and 0.34 Hz; two of the three poles compared lie near one eigenvalue at 1.295 Hz, and a pole damped over 0.2 is left out because a run of 20 s cannot tell it from its neighbours), and the run does not grow. The line trip and reclose are stable and the rotor angles end where they began (a spread of 84.15 degrees before and after). Not verified: the trip run and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. No published numbers exist to compare with: ANDES's own comparison with TSAT is a set of plots.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_40, run to 20 s; poles damped over 0.2 are not compared | 0.05 Hz and 0.05 in damping ratio | 1.284 Hz, damping 0.057 is eigenvalue 1.295 Hz, 0.050 (0.011 Hz and 0.007 apart); 1.283 Hz, damping 0.090 is eigenvalue 1.295 Hz, 0.050 (0.012 Hz and 0.040 apart); 0.335 Hz, damping 0.156 is eigenvalue 0.328 Hz, 0.144 (0.007 Hz and 0.012 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for npcc.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.71e-07 pu (bus 31) over 140 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for npcc.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 2.54e-05 deg (bus 97) over 140 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for npcc.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 358.038, expected 358.035, difference 0.00225 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for npcc.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 466.038, expected 466.035, difference 0.00225 MW | yes |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in npcc.xlsx (taken from the RAW file it was converted from, to the digits the file keeps; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 5e-05 pu | largest difference 7.29e-06 pu (bus 32) over 140 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in npcc.xlsx (taken from the RAW file it was converted from, to the digits the file keeps; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.005 deg | largest difference 0.000806 deg (bus 21) over 140 buses | yes |
| Slack active power against the solution stored in the case file | a solution stored with the source | the solved state stored in npcc.xlsx (taken from the RAW file it was converted from, to the digits the file keeps; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.1 MW | measured 466.038, expected 466.019, difference 0.0186 MW | yes |
| Largest rotor angle spread in the disturbance run (Line_2 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 84.224, expected 84.224, difference 3.23e-07 deg | yes |
| Lowest bus voltage in the disturbance run (Line_2 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.952275, expected 0.952275, difference 1.88e-09 pu | yes |
| Lowest machine frequency in the disturbance run (Line_2 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9673, expected 59.9673, difference 3.4e-07 Hz | yes |
| Least damped mode between 0.4 and 0.8 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.657503, expected 0.657503, difference 2.31e-09 Hz | yes |
| Least damped mode between 0.4 and 0.8 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.0438331, expected 0.0438331, difference 2.94e-10 | yes |
| Least damped mode between 0.8 and 1.2 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 1.06874, expected 1.06874, difference 8.29e-09 Hz | yes |
| Least damped mode between 0.8 and 1.2 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.0405405, expected 0.0405405, difference 5.13e-11 | yes |

### WECC 179-bus, 29-machine system { #wecc }

A 179-bus, 29-machine model of the Western Interconnection with a governor, an exciter and a stabiliser on every machine: a large case with many lightly damped modes, for a time-domain run, a line trip and the eigenvalue analysis.

- **Id:** `wecc`
- **Kind:** Dynamic
- **Size:** 179 buses, 29 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** no
- **File:** `wecc_full.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/wecc/wecc_full.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `038cf6732389f7d691232b7548cfa3dea2dc6a01304cc5918ad63ad55fdf23ec`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/wecc/wecc_full.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **System:** S. Maslennikov, B. Wang, Q. Zhang, F. Ma, X. Luo, K. Sun and E. Litvinov, "A test cases library for methods locating the sources of sustained oscillations," 2016 IEEE Power and Energy Society General Meeting (PESGM), Boston, MA, July 2016, doi:10.1109/PESGM.2016.7741772. The library is built on a modified WECC 179-bus, 29-machine system, and asks that publications that use its material cite this paper. This file is ANDES's, not the library's: it is cited because it describes the system, and whether the two files hold the same data was not checked. [DOI](https://doi.org/10.1109/PESGM.2016.7741772)
- **Data source:** Test Cases Library of Power System Sustained Oscillations, Department of Electrical Engineering and Computer Science, University of Tennessee, Knoxville, https://web.eecs.utk.edu/~kaisun/Oscillation/ (accessed 2026-11-17), and its model page, https://web.eecs.utk.edu/~kaisun/Oscillation/model.html, which says the system was first reported in an EPRI report (TR-104586, Projects 2675-04-05, Final Report, 1994; not opened) and that its inertia and damping data were created with reference to the WECC system and may not match the real one. [Link](https://web.eecs.utk.edu/~kaisun/Oscillation/)
- **Software:** H. Cui, ANDES documentation, Verification: CURENT WECC verification notebook, ANDES release 2.0.0 (docs/source/verification/andes-wecc-verification.ipynb), https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-wecc-verification.ipynb (accessed 2026-11-17). It describes the system, its models and the line trip that ANDES was compared with DSATools TSAT on. [Link](https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-wecc-verification.ipynb)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@inproceedings{maslennikov2016library,
  author    = {Maslennikov, S. and Wang, B. and Zhang, Q. and Ma, F. and Luo, X. and Sun, K. and Litvinov, E.},
  title     = {A test cases library for methods locating the sources of sustained oscillations},
  booktitle = {2016 IEEE Power and Energy Society General Meeting (PESGM)},
  address   = {Boston, MA},
  year      = {2016},
  month     = jul,
  doi       = {10.1109/PESGM.2016.7741772}
}
```

```bibtex
% Data source
@misc{utk_oscillation_library,
  title        = {Test Cases Library of Power System Sustained Oscillations},
  howpublished = {University of Tennessee, Knoxville, Department of Electrical Engineering and Computer Science},
  url          = {https://web.eecs.utk.edu/~kaisun/Oscillation/},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@misc{andes_wecc_verification,
  author       = {Cui, Hantao},
  title        = {{ANDES} documentation, Verification: WECC verification notebook},
  howpublished = {ANDES release 2.0.0, docs/source/verification/andes-wecc-verification.ipynb},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-wecc-verification.ipynb},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The file is ANDES's modified CURENT WECC 179-bus, 263-branch system (the title of its RAW source). The library cited above is built on a modified WECC 179-bus, 29-machine system maintained by the same group, with classical machines of artificial inertia and damping; this file has GENROU machines with governors, exciters and stabilisers instead. The library's page says its data may not match the real Western Interconnection, and the same holds for this file.
- Every one of the 29 machines is a round-rotor machine (GENROU) with an IEEEG1 governor, an exciter (17 EXST1, 8 ESDC2A and 4 ESST3A) and a stabiliser (25 ST2CUT and 4 IEEEST). The system has 40 shunts and 263 branches. Its generator angles start 128 degrees apart, which is the loaded system's state and not a loss of synchronism: after the line trip they come back to the same spread.
- No event is built in. The disturbance of the verification is added through the API: Line_2 (bus 4 to bus 16, between two generator buses) trips at 1.0 s and reconnects at 1.1 s, the second of the two scenarios of ANDES's own comparison with TSAT and PSS/E.
- The undisturbed run records the first 1000 states and bus values of the case only, which is all the API records in a run (the case has 708 states, so every state is among them, and 292 of the 358 bus values).
- ANDES 2.0.0's eigenvalue analysis returns one real eigenvalue of +1.005 per second for this case, which the Eigenvalues panel shows as an unstable mode. It is most likely not a mode of the model: the ring-down run, which starts from the same state, does not grow, where a mode of +1 per second excited by the load step would grow it by a factor of hundreds of millions over its 20 s. It appears with the states that have no time constant (135 here), which ANDES folds into the algebraic equations before it forms the state matrix, and its largest participation is in a stabiliser state. The electromechanical modes are not affected: the ring-down has the frequencies and damping ratios of the eigenvalues.
- ANDES's own documentation compares this case with DSATools TSAT and PSS/E and says the three differ slightly for a line trip, but the comparison is a set of plots whose data are not published, so it could not be used as a reference here.

**Verification.** Compared with independent references: the power flow agrees with pandapower's solution of the same network to 1.8e-6 pu and 5e-4 degrees, and with the solved state stored in the case file (taken from the PSS/E RAW file it was converted from, which TENSA did not compute) to 5.7e-6 pu, 0.001 degrees and 0.004 MW at the slack, which is the precision of the stored state. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (largest change 2.7e-8), the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.008 Hz and 0.008 (0.967, 0.798 and 0.684 Hz, damping ratios 0.024, 0.021 and 0.040; a pole damped over 0.2 is left out because a run of 20 s cannot tell it from its neighbours), and the run does not grow. The line trip and reclose are stable and the rotor angles end where they began (a spread of 127.6 degrees before and after). Not verified: the trip run and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. No published numbers exist to compare with: ANDES's own comparison with TSAT and PSS/E is a set of plots.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_76, run to 20 s; poles damped over 0.2 are not compared | 0.05 Hz and 0.05 in damping ratio | 0.967 Hz, damping 0.024 is eigenvalue 0.961 Hz, 0.025 (0.006 Hz and 0.001 apart); 0.684 Hz, damping 0.040 is eigenvalue 0.684 Hz, 0.047 (0.000 Hz and 0.008 apart); 0.798 Hz, damping 0.021 is eigenvalue 0.790 Hz, 0.021 (0.008 Hz and 0.000 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wecc_full.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.78e-06 pu (bus 74) over 179 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wecc_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 0.000507 deg (bus 140) over 179 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wecc_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 626.051, expected 626.015, difference 0.0357 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for wecc_full.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 5174.76, expected 5174.73, difference 0.0357 MW | yes |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in wecc_full.xlsx (taken from the RAW file it was converted from, to the digits the file keeps; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 5e-05 pu | largest difference 5.74e-06 pu (bus 75) over 179 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in wecc_full.xlsx (taken from the RAW file it was converted from, to the digits the file keeps; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.005 deg | largest difference 0.00107 deg (bus 34) over 179 buses | yes |
| Slack active power against the solution stored in the case file | a solution stored with the source | the solved state stored in wecc_full.xlsx (taken from the RAW file it was converted from, to the digits the file keeps; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.1 MW | measured 5174.76, expected 5174.77, difference 0.00379 MW | yes |
| Largest rotor angle spread in the disturbance run (Line_2 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 128.86, expected 128.86, difference 2.68e-06 deg | yes |
| Lowest bus voltage in the disturbance run (Line_2 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.946224, expected 0.946224, difference 4.25e-10 pu | yes |
| Lowest machine frequency in the disturbance run (Line_2 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.942, expected 59.942, difference 1.85e-07 Hz | yes |
| Least damped mode between 0.4 and 0.8 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.789756, expected 0.789756, difference 3.41e-09 Hz | yes |
| Least damped mode between 0.4 and 0.8 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.0212344, expected 0.0212344, difference 4.6e-11 | yes |
| Least damped mode between 0.8 and 1.2 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.960922, expected 0.960922, difference 3e-09 Hz | yes |
| Least damped mode between 0.8 and 1.2 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.0249476, expected 0.0249476, difference 3.53e-10 | yes |

### Kundur two-area system with a stabiliser on one generator { #kundur_pss }

The modified Kundur two-area system of the Kundur case with a power system stabiliser model (IEEEST) on the exciter of generator 1: a case for putting a stabiliser on the diagram and seeing what it does to the modes. As the file sets it, the stabiliser leaves the damping of the inter-area mode where it was.

- **Id:** `kundur_pss`
- **Kind:** Dynamic
- **Size:** 10 buses, 4 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** no
- **File:** `kundur_ieeest.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/kundur/kundur_ieeest.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `d5c144218747e37b80b957d00e5320ca0c07b7520e36e30194ef0381faedab2e`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/kundur/kundur_ieeest.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **System:** P. Kundur, Power System Stability and Control. New York: McGraw-Hill, 1994, ISBN 0-07-035958-X.
- **System:** M. Klein, G. J. Rogers and P. Kundur, "A fundamental study of inter-area oscillations in power systems," IEEE Transactions on Power Systems, vol. 6, no. 3, pp. 914-921, 1991, doi:10.1109/59.119229. [DOI](https://doi.org/10.1109/59.119229)
- **Data source:** CRESYM Colib, Kundur two-area system (test case page: the data of the book's system, with a load flow and the small-signal examples), https://colib.net/testCases/kundur_two_area_system/index.html (accessed 2026-11-17). Used here only to compare the file with the book's data. [Link](https://colib.net/testCases/kundur_two_area_system/index.html)
- **Dynamic model:** ANDES, andes/models/pss/ieeest.py, release 2.0.0: the IEEEST power system stabiliser model that the case's IEEEST_1 is an instance of, with its input signal selection, two second-order filters, two lead-lag blocks, gain, washout and output limiter (https://github.com/CURENT/andes/blob/v2.0.0/andes/models/pss/ieeest.py, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/models/pss/ieeest.py)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@book{kundur1994,
  author    = {Kundur, Prabha},
  title     = {Power System Stability and Control},
  publisher = {McGraw-Hill},
  address   = {New York},
  year      = {1994},
  isbn      = {007035958X}
}
```

```bibtex
% System
@article{klein1991fundamental,
  author  = {Klein, M. and Rogers, G. J. and Kundur, P.},
  title   = {A fundamental study of inter-area oscillations in power systems},
  journal = {IEEE Transactions on Power Systems},
  volume  = {6},
  number  = {3},
  pages   = {914--921},
  year    = {1991},
  doi     = {10.1109/59.119229}
}
```

```bibtex
% Data source
@misc{colib_kundur_two_area,
  title        = {Kundur two-area system},
  howpublished = {CRESYM Colib, test cases},
  url          = {https://colib.net/testCases/kundur_two_area_system/index.html},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@misc{andes_ieeest,
  title        = {{ANDES} model {IEEEST}: power system stabiliser},
  howpublished = {ANDES release 2.0.0, andes/models/pss/ieeest.py},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/models/pss/ieeest.py},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- This is the Kundur case of this catalog with one model added, so what that entry says the file is and is not holds here too: it is ANDES's modified version of the book's system (10 buses where the book has 11), and its results must not be compared with the book's. The model added is an IEEEST stabiliser, IEEEST_1, on the exciter of generator 1 (EXDC2_1), with the rotor speed as its input. Every other sheet holds the data of the Kundur case's file, apart from the sixteenth significant digit of some bus angles.
- The stabiliser does not add damping. Every parameter of IEEEST_1 that sets its dynamics is 1 (the filter constants A1 to A6, the lead-lag and washout constants T1 to T6 and the gain KS), which makes it a second-order low-pass filter with its corner at 1 rad/s followed by a washout. At the frequency of the inter-area mode (0.647 Hz) its gain is 0.06 and it lags the speed by about 150 degrees, where a stabiliser leads it. The inter-area mode has a damping ratio of 0.03432 in the eigenvalue analysis with it and 0.03431 without it (the Kundur case), and the ring-down of a 2% load step gives the damping of that oscillation as 0.0339 in both. The case shows the model and its place on the diagram; it is not a tuned stabiliser, and it is no example of a stabiliser improving a case.
- The stabiliser adds two oscillatory modes to the eigenvalue analysis: a pair at -0.5 +- j0.866 per second (0.138 Hz, damping ratio 0.5), the roots of the denominator of its second filter, which the rest of the system does not move, and one at 0.145 Hz (damping ratio 0.42). It also moves the two slow modes the Kundur case has at 0.116 and 0.181 Hz to 0.110 and 0.187 Hz.
- One event is built into the file: Line_8 is switched out at 2 s.
- The file gives the generators at buses 2, 12 and 11 one value for both of their reactive limits (300, 550 and -100 MVAr), so a power flow, which does not enforce reactive limits unless asked to (and pandapower's reference does not either), leaves all three outside them and the Violations count reads 3 once it has run. The solution is that of the Kundur case, whose file holds the same limits.
- The eigenvalues the book gives for its system could not be read from any source opened for this entry, and they belong to another network and other exciters in any case, so no published mode is compared.

**Verification.** Compared with independent references: the power flow agrees with pandapower's solution of the same network (the Kundur case's) to 2.3e-7 pu and 4.4e-5 degrees, and the eigenvalue analysis has the pole pair of the stabiliser's second filter where the roots of its denominator put it, computed from the file's parameters with numpy (0.13783 Hz, damping ratio 0.5, to 3e-7 Hz). Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (largest change 3.5e-6), and the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.016 Hz and 0.009. The effect of the stabiliser was measured in the time domain, against the case without it: the damping ratio of the inter-area oscillation in the same ring-down is 0.03389 with the stabiliser and 0.03389 without it (the Kundur case), a change under 1e-4 where the check allows 0.005. There is no improvement to verify, and the entry does not claim one. Not verified: the Line_8 trip run and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. No published result exists for this file.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_1, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 0.649 Hz, damping 0.034 is eigenvalue 0.647 Hz, 0.034 (0.002 Hz and 0.000 apart); 1.132 Hz, damping 0.098 is eigenvalue 1.141 Hz, 0.089 (0.010 Hz and 0.009 apart); 1.124 Hz, damping 0.082 is eigenvalue 1.108 Hz, 0.087 (0.016 Hz and 0.005 apart) | yes |
| Damping of the mode between 0.3 and 0.9 Hz against kundur | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in the time-domain run of kundur after the same small disturbance, read the same way | between -0.005 and +0.005 in damping ratio | 0.649 Hz with damping 0.03389 here, 0.649 Hz with 0.03389 in kundur: a change of +0.00000 | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_ieeest.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 2.33e-07 pu (bus 7) over 10 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_ieeest.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 4.41e-05 deg (bus 8) over 10 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_ieeest.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 92.8029, expected 92.8024, difference 0.000533 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for kundur_ieeest.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 726.803, expected 726.802, difference 0.000526 MW | yes |
| Largest rotor angle spread in the disturbance run (Line_8 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 30.7113, expected 30.7113, difference 4.37e-07 deg | yes |
| Lowest bus voltage in the disturbance run (Line_8 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.871602, expected 0.871602, difference 3.73e-09 pu | yes |
| Lowest machine frequency in the disturbance run (Line_8 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9992, expected 59.9992, difference 5.04e-08 Hz | yes |
| Inter-area mode between 0.3 and 0.9 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.646885, expected 0.646885, difference 1.65e-10 Hz | yes |
| Inter-area mode between 0.3 and 0.9 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.0343232, expected 0.0343232, difference 9.3e-11 | yes |
| Least damped local mode between 0.9 and 1.5 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 1.10779, expected 1.10779, difference 1.91e-08 Hz | yes |
| Least damped local mode between 0.9 and 1.5 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.086558, expected 0.086558, difference 3.15e-10 | yes |
| Pole of the stabiliser's second filter: frequency | an independent solver | the roots of 1 + A3 s + A4 s^2, the denominator of the stabiliser's second input filter, with A3 = A4 = 1 from the case file: s = -1/2 +- j sqrt(3)/2 per second (numpy.roots, nothing of TENSA or ANDES); the filter's numerator is the same polynomial (A5 = A3, A6 = A4), so no signal passes through these states and the loop does not move them | 0.0001 Hz | measured 0.137832, expected 0.137832, difference 2.24e-07 Hz | yes |
| Pole of the stabiliser's second filter: damping ratio | an independent solver | the roots of 1 + A3 s + A4 s^2, the denominator of the stabiliser's second input filter, with A3 = A4 = 1 from the case file: s = -1/2 +- j sqrt(3)/2 per second (numpy.roots, nothing of TENSA or ANDES); the filter's numerator is the same polynomial (A5 = A3, A6 = A4), so no signal passes through these states and the loop does not move them | 0.0001 | measured 0.5, expected 0.5, difference 5.55e-16 | yes |

### IEEE 14-bus with a fault built in { #ieee14_fault }

The IEEE 14-bus case with machines and controls (the data of the IEEE 14-bus entry) with a three-phase fault at bus 9 from 1.0 s to 1.1 s already in the file, so that a time-domain run shows a disturbance as soon as the case is open.

- **Id:** `ieee14_fault`
- **Kind:** Dynamic
- **Size:** 14 buses, 5 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** no
- **File:** `ieee14_fault.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/ieee14/ieee14_fault.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `1a23244877af3b22ac9852ebb94dc6a40253d32b852413b0b9d986f40bf8d8b6`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/ieee14_fault.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **Data source:** IEEE 14 Bus Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm (accessed 2026-11-17). [Link](https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm)
- **Data source:** ANDES, andes/cases/ieee14/README.md, release 2.0.0: the power flow data of ieee14.raw is by J. Conto and the dynamic data by H. Cui, both written for ANDES (https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md)
- **Dynamic model:** ANDES, andes/models/timer.py, release 2.0.0: the Fault model, a three-phase-to-ground fault applied at a bus at one time and cleared at another through a small reactance and resistance to ground, which the case's Fault_1 is an instance of (https://github.com/CURENT/andes/blob/v2.0.0/andes/models/timer.py, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/models/timer.py)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee14,
  title        = {{IEEE} 14 Bus Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm},
  urldate      = {2026-11-17}
}
```

```bibtex
% Data source
@misc{andes_ieee14_readme,
  title        = {{ANDES} cases: {IEEE} 14-bus systems (README)},
  howpublished = {ANDES release 2.0.0, andes/cases/ieee14/README.md},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@misc{andes_fault,
  title        = {{ANDES} model {Fault}: three-phase-to-ground fault},
  howpublished = {ANDES release 2.0.0, andes/models/timer.py},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/models/timer.py},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The dynamic data (round-rotor machines, a TGOV1 governor on each, an EXST1 exciter on one machine and an ESST3A on each of the other four) was written for ANDES by H. Cui, according to the ANDES cases README, and is not published by the IEEE.
- This is not the IEEE 14-bus case as the University of Washington archive distributes it. The line and transformer reactances, the line charging and the shunt at bus 9 are the archive's. The rest was changed in the PSS/E version prepared by J. Conto: the loads at buses 3, 4, 6 and 14 (bus 3 takes 50 MW and 25 MVAr where the archive has 94.2 MW and 19.0 MVAr), a 15 MVAr shunt at bus 14, the dispatch (generators at buses 2, 3, 6 and 8 deliver 40, 40, 30 and 35 MW, where the archive has power at buses 1 and 2 only), the voltage set-points (1.03 pu at buses 1, 2, 6 and 8 and 1.01 at bus 3, where the archive has 1.060, 1.045, 1.010, 1.070 and 1.090), the reactive limits, and the ratio of the four transformers (0.99677 on each, where the archive has 0.978, 0.969, 0.932 and none).
- The power flow solution therefore differs from the one the archive stores, by up to 0.06 pu in voltage and 11.8 degrees in angle (bus 8). Do not compare results of this file with published IEEE 14-bus results.
- This is the IEEE 14-bus case of this catalog with one device added, Fault_1: a three-phase fault at bus 9 from 1.0 s to 1.1 s, through ANDES's default fault reactance of 1e-4 per unit and no resistance. Every other sheet of the file is the same as in that case's file, so the power flow, the eigenvalues and the notes above hold for both. The fault is cleared at 1.1 s with no line tripped, so the network after it is the network before it.
- A power flow, which does not enforce reactive limits unless asked to (and pandapower's reference does not either), leaves the generators at buses BUS2 and BUS6 above their reactive limits (30.4 against 15 MVAr and 21.0 against 10 MVAr), so the Violations count reads 2 once it has run. The IEEE 14-bus case of this catalog has the same two.
- The fault changes nothing in a power flow or an eigenvalue analysis. In a time-domain run it takes the lowest bus voltage to 0.0004 pu and the rotor angle spread from its initial 50.2 degrees to 60.2 degrees at most; the spread is back at 50.6 degrees at 10 s, and no machine loses synchronism.

**Verification.** Compared with an independent reference: the power flow (bus voltages, angles, losses and the slack's power) agrees with pandapower's solution of the same network to 5.5e-9 pu and 8.5e-7 degrees. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution, and the ring-down of a 2% load step has the frequencies and damping ratios of the eigenvalues, within 0.025 Hz and 0.027. Not verified: the fault run and the mode values are TENSA's own earlier output, kept as regression baselines to catch a change. They are equal, to the eight digits kept, to the baselines of the IEEE 14-bus case, whose run adds the same fault through the API, so the fault in the file is the fault the entry says. No published result exists for this data.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_2, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 1.012 Hz, damping 0.248 is eigenvalue 1.019 Hz, 0.275 (0.006 Hz and 0.027 apart); 0.952 Hz, damping 0.229 is eigenvalue 0.949 Hz, 0.245 (0.004 Hz and 0.015 apart); 1.078 Hz, damping 0.270 is eigenvalue 1.053 Hz, 0.261 (0.025 Hz and 0.009 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_fault.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 5.51e-09 pu (bus 9) over 14 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_fault.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 8.46e-07 deg (bus 14) over 14 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_fault.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 2.72721, expected 2.72721, difference 1.24e-06 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_fault.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 81.4272, expected 81.4272, difference 1.24e-06 MW | yes |
| Largest rotor angle spread in the disturbance run (fault at bus 9) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 60.2428, expected 60.2428, difference 2.19e-07 deg | yes |
| Lowest bus voltage in the disturbance run (fault at bus 9) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.000444015, expected 0.000444015, difference 1.63e-13 pu | yes |
| Lowest machine frequency in the disturbance run (fault at bus 9) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9556, expected 59.9556, difference 1.85e-07 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.948748, expected 0.948748, difference 3.92e-09 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.244586, expected 0.244586, difference 5.43e-10 | yes |

### PJM 5-bus system with classical machines and a line trip { #pjm5bus }

The PJM 5-bus test system of Li and Bo with four classical-model machines, a governor on each and a trip of one of two parallel lines at 2 s built in: the smallest case of the gallery, for a first time-domain run, a line outage and the swing between machines. The governors do nothing in ANDES 2.0.0 as it is configured (see the caveats).

- **Id:** `pjm5bus`
- **Kind:** Dynamic
- **Size:** 5 buses, 4 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** no
- **File:** `pjm5bus.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/5bus/pjm5bus.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `aa4f0e4ee6754221f3245b2e72cc44d23e5ddbcd39d2e5f9a70e0dabc82d8e83`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/5bus/pjm5bus.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **System:** F. Li and R. Bo, "Small test systems for power system economic studies," Proceedings of the 2010 IEEE Power & Energy Society General Meeting, July 2010, pp. 1-4, doi:10.1109/PES.2010.5589973. The paper MATPOWER's case5 file names as the source of the network. Its title, authors, venue and pages were read from Crossref; the paper itself is behind the publisher's access and was not opened. [DOI](https://doi.org/10.1109/PES.2010.5589973)
- **Data source:** MATPOWER, data/case5.m, release 8.0, https://github.com/MATPOWER/matpower/blob/8.0/data/case5.m (accessed 2026-11-17). Its header describes the data as a modified 5-bus, 5-generator case based on the PJM 5-bus system, created by Rui Bo in 2006 and modified in 2010 and 2014, and distributed with permission. ANDES's copy of the file (andes/cases/matpower/case5.m) is byte for byte this one. Used here to compare the network of the case with the system as MATPOWER holds it. [Link](https://github.com/MATPOWER/matpower/blob/8.0/data/case5.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for the library that distributes the case5 file the network is taken from. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Dynamic model:** F. Milano, Power System Modelling and Scripting. Berlin, Heidelberg: Springer, 2010, doi:10.1007/978-3-642-13669-6. The book that ANDES's source names for its TG2 governor model, the one this case's governors are (the book was not opened). [DOI](https://doi.org/10.1007/978-3-642-13669-6)
- **Dynamic model:** ANDES, andes/models/governor/tg2.py and andes/core/discrete.py, release 2.0.0: the TG2 governor, whose speed input goes through a dead band block (https://github.com/CURENT/andes/blob/v2.0.0/andes/models/governor/tg2.py), and the DeadBandRT block, whose flags stand at "inside the band" while the block is not enabled (https://github.com/CURENT/andes/blob/v2.0.0/andes/core/discrete.py), accessed 2026-11-17. Together they are why the governors of this case do not act (see the caveats). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/models/governor/tg2.py)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@inproceedings{li2010small,
  author    = {Li, Fangxing and Bo, Rui},
  title     = {Small test systems for power system economic studies},
  booktitle = {Proceedings of the 2010 IEEE Power \& Energy Society General Meeting},
  year      = {2010},
  month     = jul,
  pages     = {1--4},
  doi       = {10.1109/PES.2010.5589973}
}
```

```bibtex
% Data source
@misc{matpower_case5,
  title        = {{MATPOWER} case5: a modified 5-bus system based on the {PJM} 5-bus system},
  howpublished = {MATPOWER release 8.0, data/case5.m},
  url          = {https://github.com/MATPOWER/matpower/blob/8.0/data/case5.m},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray Daniel and Murillo-S{\'a}nchez, Carlos Edmundo and Thomas, Robert John},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Dynamic model
@book{milano2010power,
  author    = {Milano, Federico},
  title     = {Power System Modelling and Scripting},
  publisher = {Springer},
  address   = {Berlin, Heidelberg},
  year      = {2010},
  doi       = {10.1007/978-3-642-13669-6}
}
```

```bibtex
% Dynamic model
@misc{andes_tg2,
  title        = {{ANDES} model {TG2}: turbine governor type 2, and the {DeadBandRT} block},
  howpublished = {ANDES release 2.0.0, andes/models/governor/tg2.py and andes/core/discrete.py},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/models/governor/tg2.py},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The network is MATPOWER's case5 (Li and Bo's PJM 5-bus system), checked against ANDES's copy of that file: the five buses at 230 kV, the loads of 300, 300 and 400 MW, the six lines, the slack at bus 4 with no output of its own (it takes the losses, 3.9 MW) and the dispatch of the generators at buses 3 and 5 (323.49 and 466.51 MW) are the same. What differs: the two generators at bus 1 (40 and 170 MW) are one of 210 MW, the generators carry no limits on their active or reactive power (999 per unit), the line ratings and the cost data are not carried, and a second line between buses 1 and 2 (Line 1-2 (2), the same r, x and b as Line 1-2) has been added, which the event of the file trips at 2 s so that the trip islands nothing.
- The machines are four classical models (GENCLS) at buses 1, 3, 4 and 5, rated 200, 300, 200 and 300 MVA, each with an inertia constant of 2 s, no damping and a transient reactance of 1.7 per unit on its own base. ANDES gives no source for these dynamic data (there is no README for this folder, and the file's history there shows only H. Cui's edits since February 2020), so do not read them as Li and Bo's. With that reactance and 1000 MW of load the machines' internal voltages come out at 2.3 to 2.8 per unit and their rotor angles start about 77 degrees apart.
- The governors do nothing. Each machine has a TG2 governor (droop 0.05, time constants 0.2 s and 10 s, on the machine's base), and ANDES 2.0.0 does not move the machine's mechanical power with the default configuration: the dead band block in front of its input is disabled (TG2.config.deadband = 0), and a block that is disabled stands at "inside the band", which makes the governor's input zero. A 50% increase of the 400 MW load at bus 4 at 1 s takes the slowest machine to 0.840 per unit of speed with the governors as the file has them and with them taken out alike, and to 0.973 with the dead band enabled in ANDES (which TENSA does not expose). The case therefore behaves as four classical machines with constant mechanical power, and its checks hold it to exactly that; should ANDES change this, the checks that compare it with the classical model will fail.
- One event is built into the file: Line 1-2 (2) is switched out at 2 s. The run stays stable and the machines' angles hardly change (the largest rotor angle spread is 77.1 degrees against 76.6 at the start).
- The power flow has no published solution to compare with: MATPOWER's case5 stores every bus at 1 per unit and 0 degrees, which is a start and not a solution.

**Verification.** Compared with independent references: the power flow agrees with pandapower's solution of the same network to 1.2e-8 pu and 2.2e-6 degrees. Because every machine is classical, the dynamics have an independent reference too: the swing equations Kron-reduced and linearised in numpy (the three oscillatory modes, 1.079, 1.458 and 1.725 Hz, undamped as the machines have no damping, which TENSA's eigenvalue analysis reproduces to 2e-6 Hz and 1e-4 in damping ratio), and integrated with scipy for the line trip, which TENSA's run matches to 0.017 degrees in the largest rotor angle spread, 3.5e-5 pu in the lowest voltage and 5e-5 Hz in the lowest frequency (the angle spread at 10 s, which sits on an oscillation, to 0.3 degrees). These references hold the machines' mechanical power constant, which is what ANDES 2.0.0 runs with these governors (see the caveats), so they verify the network and the machines, not the governors. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution, and the ring-down of a 2% load step has the frequencies of the eigenvalues, within 0.017 Hz. No published result exists for this data; every check above is against a reference that does not come from TENSA, and none is a regression baseline.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load 2, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 1.096 Hz, damping 0.000 is eigenvalue 1.079 Hz, 0.000 (0.017 Hz and 0.000 apart); 1.714 Hz, damping 0.000 is eigenvalue 1.725 Hz, 0.000 (0.011 Hz and 0.000 apart); 1.454 Hz, damping 0.000 is eigenvalue 1.458 Hz, 0.000 (0.004 Hz and 0.000 apart) | yes |
| Frequency of mode 1 of 3, 1.079 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.001 Hz | measured 1.07906, expected 1.07906, difference 1.5e-06 Hz | yes |
| Damping ratio of mode 1 of 3, 1.079 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.0001 | measured 0, expected 0, difference 0 | yes |
| Frequency of mode 2 of 3, 1.458 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.001 Hz | measured 1.45832, expected 1.45832, difference 5.39e-07 Hz | yes |
| Damping ratio of mode 2 of 3, 1.458 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.0001 | measured 0, expected 0, difference 0 | yes |
| Frequency of mode 3 of 3, 1.725 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.001 Hz | measured 1.72514, expected 1.72514, difference 5.94e-07 Hz | yes |
| Damping ratio of mode 3 of 3, 1.725 Hz, against the linearised swing equations | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py | 0.0001 | measured 0, expected 0, difference 0 | yes |
| Largest rotor angle spread in the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.0333333 s | 0.05 deg | measured 77.0658, expected 77.0492, difference 0.0166 deg | yes |
| Rotor angle spread at the end of the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.0333333 s | 0.5 deg | measured 76.3566, expected 76.6593, difference 0.303 deg | yes |
| Lowest bus voltage in the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.0333333 s | 5e-05 pu | measured 0.984015, expected 0.98405, difference 3.53e-05 pu | yes |
| Lowest machine frequency in the disturbance run | an independent solver | the swing equations of the classical model solved independently of TENSA and ANDES (the network and machines ANDES holds for pjm5bus.xlsx, its TG2 governors held at their initial output because ANDES 2.0.0 does not move them with the dead band off: Kron reduction, linearisation, scipy DOP853), numpy 2.4.6, scipy 1.18.1; written by scripts/crosscheck_classical.py; integrated with a step of 0.0333333 s | 0.002 Hz | measured 59.9991, expected 59.9991, difference 5.05e-05 Hz | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for pjm5bus.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.17e-08 pu (bus 1) over 5 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for pjm5bus.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 2.18e-06 deg (bus 4) over 5 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for pjm5bus.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 3.93872, expected 3.9387, difference 1.84e-05 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for pjm5bus.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 3.93872, expected 3.9387, difference 1.84e-05 MW | yes |

### IEEE 14-bus with a solar plant { #ieee14_solar }

The IEEE 14-bus case with the machine at bus 8 replaced by a converter-interfaced solar plant (the WECC converter, electrical control and plant control models) and a trip and reclose of a line built in: a small case for inverter-based generation, for a disturbance with a converter in the network and for the eigenvalues of one.

- **Id:** `ieee14_solar`
- **Kind:** Dynamic
- **Size:** 14 buses, 5 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** no
- **File:** `ieee14_solar.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/ieee14/ieee14_solar.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `d6da1df345902bf05b06d07a5715f2bd9f677f6c64422a4bb33fc011282b2dc6`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/ieee14_solar.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **Data source:** IEEE 14 Bus Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm (accessed 2026-11-17). [Link](https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm)
- **Data source:** ANDES, andes/cases/ieee14/README.md, release 2.0.0: the power flow data of ieee14.raw is by J. Conto and the dynamic data by H. Cui, both written for ANDES, and almost all the other files of the folder are made by adding models to it; it describes ieee14_solar.xlsx as a generic solar PV device that can also model a Type-4 wind turbine, and ieee14_wt3.xlsx as one generic Type-3 wind turbine (https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md)
- **Dynamic model:** ANDES documentation, model reference, release 2.0.0: the groups RenGen (REGCA1, which 'implements REGCA1 in PSS/E, or REGC_A in PSLF and Powerworld'), RenExciter (REECA1) and RenPlant (REPCA1) (https://docs.andes.app/en/v2.0.0/reference/models/RenGen.html, https://docs.andes.app/en/v2.0.0/reference/models/RenExciter.html and https://docs.andes.app/en/v2.0.0/reference/models/RenPlant.html, accessed 2026-11-17). [Link](https://docs.andes.app/en/v2.0.0/reference/models/RenGen.html)
- **Dynamic model:** WECC Renewable Energy Modeling Task Force, Generic Solar Photovoltaic System Dynamic Simulation Model Specification, Western Electricity Coordinating Council Modeling and Validation Work Group, September 2012 (also Sandia National Laboratories report SAND2013-8876 by A. Ellis, M. Behnke and R. Elliott, October 2013), https://www.wecc.org/sites/default/files/documents/meeting/2024/WECC-Solar-PV-Dynamic-Model-Specification-September-2012.pdf (accessed 2026-11-17). It specifies the converter (REGC_A), the electrical control (REEC_B) and the plant controller (REPC_A) of a central-station PV plant, and says that the available solar power is taken as constant through a run. [Link](https://www.wecc.org/sites/default/files/documents/meeting/2024/WECC-Solar-PV-Dynamic-Model-Specification-September-2012.pdf)
- **Dynamic model:** P. Pourbeik, Proposed Changes to the WECC WT4 Generic Model for Type 4 Wind Turbine Generators, EPRI report prepared under NREL subcontract NFT-1-11342-01, issued 16 December 2011 and revised through 23 January 2013, https://www.wecc.org/sites/default/files/documents/program/2024/Report_on_WT4_Model_Description_PP012313.pdf (accessed 2026-11-17). It describes the converter (regc_a), electrical control (reec_a) and plant controller (repc_a) models that ANDES's REGCA1, REECA1 and REPCA1 implement. [Link](https://www.wecc.org/sites/default/files/documents/program/2024/Report_on_WT4_Model_Description_PP012313.pdf)
- **Dynamic model:** P. Pourbeik, J. J. Sanchez-Gasca, J. Senthil, J. D. Weber, P. Zadkhast, Y. Kazachkov, S. Tacke, J. Wen and A. Ellis, "Generic Dynamic Models for Modeling Wind Power Plants and Other Renewable Technologies in Large-Scale Power System Studies," IEEE Transactions on Energy Conversion, vol. 32, no. 3, pp. 1108-1116, September 2017, doi:10.1109/TEC.2016.2639050. The paper on the WECC second-generation generic models that these cases' converter, electrical control and plant control models are. Its title, authors, volume, pages and date were read from Crossref and its abstract from OpenAlex, which says it presents the latest developments of the WECC Renewable Energy Modeling Task Force's generic models; the paper itself is behind the publisher's access and was not opened. [DOI](https://doi.org/10.1109/TEC.2016.2639050)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee14,
  title        = {{IEEE} 14 Bus Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm},
  urldate      = {2026-11-17}
}
```

```bibtex
% Data source
@misc{andes_ieee14_readme,
  title        = {{ANDES} cases: {IEEE} 14-bus systems (README)},
  howpublished = {ANDES release 2.0.0, andes/cases/ieee14/README.md},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@misc{andes_renewable_models,
  title        = {{ANDES} model reference: renewable generator, electrical control and plant control groups},
  howpublished = {ANDES release 2.0.0, docs.andes.app},
  url          = {https://docs.andes.app/en/v2.0.0/reference/models/RenGen.html},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@techreport{wecc2012solarpv,
  author      = {{WECC Renewable Energy Modeling Task Force}},
  title       = {Generic Solar Photovoltaic System Dynamic Simulation Model Specification},
  institution = {Western Electricity Coordinating Council, Modeling and Validation Work Group},
  year        = {2012},
  month       = sep,
  url         = {https://www.wecc.org/sites/default/files/documents/meeting/2024/WECC-Solar-PV-Dynamic-Model-Specification-September-2012.pdf},
  urldate     = {2026-11-17}
}
```

```bibtex
% Dynamic model
@techreport{pourbeik2013wt4,
  author      = {Pourbeik, Pouyan},
  title       = {Proposed Changes to the {WECC} {WT4} Generic Model for Type 4 Wind Turbine Generators},
  institution = {Electric Power Research Institute, for the National Renewable Energy Laboratory (subcontract NFT-1-11342-01)},
  year        = {2013},
  note        = {Issued 16 December 2011, revised through 23 January 2013},
  url         = {https://www.wecc.org/sites/default/files/documents/program/2024/Report_on_WT4_Model_Description_PP012313.pdf},
  urldate     = {2026-11-17}
}
```

```bibtex
% Dynamic model
@article{pourbeik2017generic,
  author  = {Pourbeik, Pouyan and Sanchez-Gasca, Juan J. and Senthil, Jayapalan and Weber, James D. and Zadkhast, Pouya and Kazachkov, Yuriy and Tacke, Spencer and Wen, Jun and Ellis, Abraham},
  title   = {Generic Dynamic Models for Modeling Wind Power Plants and Other Renewable Technologies in Large-Scale Power System Studies},
  journal = {IEEE Transactions on Energy Conversion},
  volume  = {32},
  number  = {3},
  pages   = {1108--1116},
  year    = {2017},
  month   = sep,
  doi     = {10.1109/TEC.2016.2639050}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The network, loads, dispatch and shunts are those of the IEEE 14-bus case of this catalog (the sheets for buses, loads, generators, lines, shunts and areas are the same as in ieee14_full.xlsx, compared sheet by sheet), which is not the IEEE 14-bus case as the University of Washington archive distributes it: the loads at buses 3, 4, 6 and 14, the dispatch, the voltage set-points and the transformer ratios are not the archive's, so the power flow solution differs from the one the archive stores by up to 0.06 pu in voltage and 11.8 degrees in angle (bus 8). Do not compare results of this file with published IEEE 14-bus results.
- What differs from the IEEE 14-bus case of this catalog: the machine at bus 8 (its GENROU, TGOV1 and ESST3A) is gone, and the static generator of that bus, 35 MW and 7.4 MVAr at 1.03 per unit after the power flow, is taken over in a time-domain run by a converter model (REGCA1, rated 100 MVA), its electrical control (REECA1) and a plant controller (REPCA1, which monitors Line_20). The other four machines, with their governors and exciters, are the same, and the file adds the two line events below.
- The converter's data is generic. ANDES gives no source for it (the README of the folder describes the file as a generic solar PV device that can also be used to model a Type-4 wind turbine), and many of its limits are 999 per unit so that they never act: the converter's ramp rate and current-rate limits, and the power, voltage and ramp limits of its electrical control and plant control. Do not read the numbers as a plant's.
- The electrical control is REECA1, ANDES's implementation of the REEC_A model that the WECC reports on type 3 and type 4 wind turbines describe. The WECC specification of a solar PV plant pairs the same converter (REGC_A) and plant controller (REPC_A) with REEC_B instead, which this file does not use. As that specification says of its models, the available power is taken as constant for the whole run: there is no irradiance, and the plant delivers the 35 MW of the power flow.
- Two events are built into the file: Line_1 (from bus 1 to bus 2) is switched out at 1.0 s and switched in at 1.1 s. The disturbance hardly reaches the converter: its active power stays between 34.8 and 35.1 MW and the voltage of its bus dips from 1.030 to 1.018 per unit. The run stays stable: the rotor angle spread, 50.2 degrees at the start, reaches 54.0 degrees and is back at 50.1 at 10 s, the lowest bus voltage is 0.999 per unit and the lowest machine frequency 59.95 Hz.
- A power flow, which does not enforce reactive limits unless asked to (and pandapower's reference does not either), leaves the generators at buses BUS2 and BUS6 above their reactive limits (30.4 against 15 MVAr and 21.0 against 10 MVAr), so the Violations count reads 2 once it has run. The IEEE 14-bus case of this catalog has the same two.
- The ring-down of a 2% load step in the time domain has its three strongest oscillations at 1.048, 0.993 and 1.215 Hz. The first and the third are within 0.006 Hz and 0.013, and 0.004 Hz and 0.005 in damping ratio, of eigenvalues. The second is 0.016 Hz and 0.058 from the nearest one (1.009 Hz, damping 0.264), which is outside the 0.05 the other cases allow, so the check of this case allows 0.06. The same pole comes out of load steps of 2, 5 and 10 percent, of fits that start from 0.1 s to 1.5 s after the step, and of integration steps of 33, 20 and 10 ms, so it is not noise, the step or the size of the disturbance: it is a difference between the simulation and ANDES's eigenvalue analysis of this case, whose cause was not found. The IEEE 14-bus case of this catalog, with a synchronous machine at bus 8 where this one has a converter, matches to 0.027.

**Verification.** Compared with an independent reference: the power flow (bus voltages, angles, losses and the slack's power) agrees with pandapower's solution of the same network to 5.5e-9 pu and 8.5e-7 degrees. The converter models do not enter the power flow, so this checks the network and the dispatch the converter starts from, and the numbers are those of the IEEE 14-bus case. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (no state moves), and the ring-down of a 2% load step has the frequency and damping of eigenvalues for two of its three strongest oscillations, and for the third within 0.016 Hz and 0.058, outside the 0.05 allowed elsewhere (see the caveats): this case allows 0.06. After the line is switched out and in again the rotor angles end within 0.06 degrees of where they began, as they must when the network is the same again (an expectation, not a second computation). Not verified: the values of the disturbance run and of the modes are TENSA's own earlier output, kept as regression baselines to catch a change. No published or independent result exists for these converter models in this network.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_2, run to 20 s | 0.05 Hz and 0.06 in damping ratio | 1.048 Hz, damping 0.249 is eigenvalue 1.054 Hz, 0.262 (0.006 Hz and 0.013 apart); 0.993 Hz, damping 0.206 is eigenvalue 1.009 Hz, 0.264 (0.016 Hz and 0.058 apart); 1.215 Hz, damping 0.281 is eigenvalue 1.218 Hz, 0.285 (0.004 Hz and 0.005 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_solar.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 5.51e-09 pu (bus 9) over 14 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_solar.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 8.46e-07 deg (bus 14) over 14 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_solar.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 2.72721, expected 2.72721, difference 1.24e-06 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_solar.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 81.4272, expected 81.4272, difference 1.24e-06 MW | yes |
| Largest rotor angle spread in the disturbance run (Line_1 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 53.9794, expected 53.9794, difference 4.32e-07 deg | yes |
| Lowest bus voltage in the disturbance run (Line_1 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.998684, expected 0.998684, difference 3.98e-09 pu | yes |
| Lowest machine frequency in the disturbance run (Line_1 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9512, expected 59.9512, difference 4.86e-07 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 1.05398, expected 1.05398, difference 4.55e-08 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.261869, expected 0.261869, difference 1.66e-10 | yes |

### IEEE 14-bus with a type-3 wind turbine { #ieee14_wt3 }

The IEEE 14-bus case with the machine at bus 8 replaced by a type-3 wind turbine (the WECC converter, electrical control, plant control, drive train, aerodynamics, pitch and torque control models) and a trip and reclose of a line built in: a small case for a wind turbine in a network, with the slowly growing mode its linearisation has (see the caveats).

- **Id:** `ieee14_wt3`
- **Kind:** Dynamic
- **Size:** 14 buses, 5 generators
- **Analyses:** Power flow, Time domain, Eigenvalues
- **First run:** no
- **File:** `ieee14_wt3.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/ieee14/ieee14_wt3.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `bf2d9eeddfe909e9f3cc1e50e95bf2e8a8b893b063c44d19b683e9c30ccde606`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/ieee14_wt3.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- **Data source:** IEEE 14 Bus Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm (accessed 2026-11-17). [Link](https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm)
- **Data source:** ANDES, andes/cases/ieee14/README.md, release 2.0.0: the power flow data of ieee14.raw is by J. Conto and the dynamic data by H. Cui, both written for ANDES, and almost all the other files of the folder are made by adding models to it; it describes ieee14_solar.xlsx as a generic solar PV device that can also model a Type-4 wind turbine, and ieee14_wt3.xlsx as one generic Type-3 wind turbine (https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md)
- **Dynamic model:** ANDES documentation, model reference, release 2.0.0: the groups RenGen (REGCA1, which 'implements REGCA1 in PSS/E, or REGC_A in PSLF and Powerworld'), RenExciter (REECA1) and RenPlant (REPCA1) (https://docs.andes.app/en/v2.0.0/reference/models/RenGen.html, https://docs.andes.app/en/v2.0.0/reference/models/RenExciter.html and https://docs.andes.app/en/v2.0.0/reference/models/RenPlant.html, accessed 2026-11-17). [Link](https://docs.andes.app/en/v2.0.0/reference/models/RenGen.html)
- **Dynamic model:** ANDES documentation, model reference, release 2.0.0: the groups RenGovernor (WTDTA1, the wind turbine drive train, a two-mass model when Htfrac is not 0), RenAerodynamics (WTARA1), RenPitch (WTPTA1) and RenTorque (WTTQA1) (https://docs.andes.app/en/v2.0.0/reference/models/RenGovernor.html, https://docs.andes.app/en/v2.0.0/reference/models/RenAerodynamics.html, https://docs.andes.app/en/v2.0.0/reference/models/RenPitch.html and https://docs.andes.app/en/v2.0.0/reference/models/RenTorque.html, accessed 2026-11-17). [Link](https://docs.andes.app/en/v2.0.0/reference/models/RenGovernor.html)
- **Dynamic model:** P. Pourbeik, Proposed Changes to the WECC WT3 Generic Model for Type 3 Wind Turbine Generators, EPRI report prepared under NREL subcontract NFT-1-11342-01, issued 26 March 2012 and revised through 23 January 2013, https://www.wecc.org/sites/default/files/documents/meeting/2024/Report_on_WT3_Model_Description_PP012313.pdf (accessed 2026-11-17). It describes the seven models of the second-generation type 3 wind turbine: converter (regc_a), electrical control (reec_a), drive train (wtgt_a), aerodynamics (wtgar_a), pitch control (wtgpt_a), torque control (wtgtrq_a) and plant controller (repc_a), which are the seven models of this case. [Link](https://www.wecc.org/sites/default/files/documents/meeting/2024/Report_on_WT3_Model_Description_PP012313.pdf)
- **Dynamic model:** P. Pourbeik, J. J. Sanchez-Gasca, J. Senthil, J. D. Weber, P. Zadkhast, Y. Kazachkov, S. Tacke, J. Wen and A. Ellis, "Generic Dynamic Models for Modeling Wind Power Plants and Other Renewable Technologies in Large-Scale Power System Studies," IEEE Transactions on Energy Conversion, vol. 32, no. 3, pp. 1108-1116, September 2017, doi:10.1109/TEC.2016.2639050. The paper on the WECC second-generation generic models that these cases' converter, electrical control and plant control models are. Its title, authors, volume, pages and date were read from Crossref and its abstract from OpenAlex, which says it presents the latest developments of the WECC Renewable Energy Modeling Task Force's generic models; the paper itself is behind the publisher's access and was not opened. [DOI](https://doi.org/10.1109/TEC.2016.2639050)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee14,
  title        = {{IEEE} 14 Bus Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm},
  urldate      = {2026-11-17}
}
```

```bibtex
% Data source
@misc{andes_ieee14_readme,
  title        = {{ANDES} cases: {IEEE} 14-bus systems (README)},
  howpublished = {ANDES release 2.0.0, andes/cases/ieee14/README.md},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@misc{andes_renewable_models,
  title        = {{ANDES} model reference: renewable generator, electrical control and plant control groups},
  howpublished = {ANDES release 2.0.0, docs.andes.app},
  url          = {https://docs.andes.app/en/v2.0.0/reference/models/RenGen.html},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@misc{andes_wind_turbine_models,
  title        = {{ANDES} model reference: wind turbine drive train, aerodynamics, pitch and torque control},
  howpublished = {ANDES release 2.0.0, docs.andes.app},
  url          = {https://docs.andes.app/en/v2.0.0/reference/models/RenGovernor.html},
  urldate      = {2026-11-17}
}
```

```bibtex
% Dynamic model
@techreport{pourbeik2013wt3,
  author      = {Pourbeik, Pouyan},
  title       = {Proposed Changes to the {WECC} {WT3} Generic Model for Type 3 Wind Turbine Generators},
  institution = {Electric Power Research Institute, for the National Renewable Energy Laboratory (subcontract NFT-1-11342-01)},
  year        = {2013},
  note        = {Issued 26 March 2012, revised through 23 January 2013},
  url         = {https://www.wecc.org/sites/default/files/documents/meeting/2024/Report_on_WT3_Model_Description_PP012313.pdf},
  urldate     = {2026-11-17}
}
```

```bibtex
% Dynamic model
@article{pourbeik2017generic,
  author  = {Pourbeik, Pouyan and Sanchez-Gasca, Juan J. and Senthil, Jayapalan and Weber, James D. and Zadkhast, Pouya and Kazachkov, Yuriy and Tacke, Spencer and Wen, Jun and Ellis, Abraham},
  title   = {Generic Dynamic Models for Modeling Wind Power Plants and Other Renewable Technologies in Large-Scale Power System Studies},
  journal = {IEEE Transactions on Energy Conversion},
  volume  = {32},
  number  = {3},
  pages   = {1108--1116},
  year    = {2017},
  month   = sep,
  doi     = {10.1109/TEC.2016.2639050}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The network, loads, dispatch and shunts are those of the IEEE 14-bus case of this catalog (the sheets for buses, loads, generators, lines, shunts and areas are the same as in ieee14_full.xlsx, compared sheet by sheet), which is not the IEEE 14-bus case as the University of Washington archive distributes it: the loads at buses 3, 4, 6 and 14, the dispatch, the voltage set-points and the transformer ratios are not the archive's, so the power flow solution differs from the one the archive stores by up to 0.06 pu in voltage and 11.8 degrees in angle (bus 8). Do not compare results of this file with published IEEE 14-bus results.
- What differs from the IEEE 14-bus case of this catalog: the machine at bus 8 (its GENROU, TGOV1 and ESST3A) is gone, and the static generator of that bus, 35 MW and 7.4 MVAr at 1.03 per unit after the power flow, is taken over in a time-domain run by the seven models of a second-generation type-3 wind turbine: the converter (REGCA1, rated 100 MVA), its electrical control (REECA1), a plant controller (REPCA1, which monitors Line_20 and has a fourth BusFreq, BusFreq_4, for its frequency control, which is switched off), a two-mass drive train (WTDTA1, total inertia 6 MWs/MVA, half of it on the turbine side), the aerodynamics (WTARA1), the pitch control (WTPTA1) and the torque control (WTTQA1). The other four machines, with their governors and exciters, are the same, and the file adds the two line events below.
- The data is generic. ANDES gives no source for it (the README of the folder describes the file as one generic Type-3 wind turbine), and the aerodynamic model has no wind speed: the turbine's mechanical power is the power flow's 35 MW for the whole run, so a run shows the turbine's controls answer to the network and not to the wind. Many limits of the converter and its controls are 999 per unit so that they never act. Do not read the numbers as a turbine's.
- The case has a growing mode. ANDES's eigenvalue analysis returns one real eigenvalue with a positive real part, 0.0713 per second (an e-folding time of 14 s), so the Eigenvalues panel and the HTML report show an unstable mode. It is in the simulation too and not a leftover of the linearisation: in a run of 80 s after a 2% load step the generator-side speed of the drive train (state s2_y of WTDTA1 1) moves away from its equilibrium by 2.6e-7 per unit at 10 s and 4.9e-5 at 80 s, an exponential whose rate from 50 s on is 0.0713 per second, the eigenvalue's (test_ieee14_wt3_growth.py holds this against ANDES). It is far too slow to show in a run of the default 10 s, and the checks of this entry, which stop at 20 s, do not see it. Whether a turbine with this data would behave so no source says: the case with the same network and converter stack and no turbine has no such mode. ANDES's participation factors put the mode mostly on the integrator of the pitch control, a state that stays at zero in the run, so which state carries it is not stated here.
- Two events are built into the file: Line_1 (from bus 1 to bus 2) is switched out at 1.0 s and switched in at 1.1 s. The disturbance hardly reaches the turbine: its active power stays between 34.8 and 35.1 MW and the voltage of its bus dips from 1.030 to 1.018 per unit, as in the solar case, whose disturbance run it matches to 6 digits in the angle spread, the lowest voltage and the lowest frequency. The run stays stable: the rotor angle spread, 50.2 degrees at the start, reaches 54.0 degrees and is back at 50.1 at 10 s, the lowest bus voltage is 0.999 per unit and the lowest machine frequency 59.95 Hz.
- A power flow, which does not enforce reactive limits unless asked to (and pandapower's reference does not either), leaves the generators at buses BUS2 and BUS6 above their reactive limits (30.4 against 15 MVAr and 21.0 against 10 MVAr), so the Violations count reads 2 once it has run. The IEEE 14-bus case of this catalog has the same two.
- The ring-down of a 2% load step in the time domain has its three strongest oscillations at 1.048, 0.993 and 1.215 Hz. The first and the third are within 0.006 Hz and 0.013, and 0.004 Hz and 0.005 in damping ratio, of eigenvalues. The second is 0.016 Hz and 0.058 from the nearest one (1.009 Hz, damping 0.264), which is outside the 0.05 the other cases allow, so the check of this case allows 0.06. The same pole comes out of load steps of 2, 5 and 10 percent, of fits that start from 0.1 s to 1.5 s after the step, and of integration steps of 33, 20 and 10 ms, so it is not noise, the step or the size of the disturbance: it is a difference between the simulation and ANDES's eigenvalue analysis of this case, whose cause was not found. The IEEE 14-bus case of this catalog, with a synchronous machine at bus 8 where this one has a converter, matches to 0.027. The turbine's own oscillation, at 0.156 Hz with damping 0.200, is not in the machines' speeds, so no ring-down check covers it and it is held as a regression baseline only.

**Verification.** Compared with an independent reference: the power flow agrees with pandapower's solution of the same network to 5.5e-9 pu and 8.5e-7 degrees; none of the turbine's models enters the power flow, so this checks the network and the dispatch. Checks of TENSA against its own linearisation: the undisturbed 10 s run stays at its solution (no state moves), and the ring-down of a 2% load step has the frequency and damping of eigenvalues for two of its three strongest oscillations, and for the third within 0.016 Hz and 0.058, outside the 0.05 allowed elsewhere (see the caveats): this case allows 0.06. The case's growing mode is checked against ANDES by a test, not by the checks below, which stop at 20 s: the eigenvalue, 0.0713 per second, is the rate at which the turbine's speed moves away from its equilibrium in an 80 s run, to 1%. After the line is switched out and in again the rotor angles end within 0.07 degrees of where they began. Not verified: the values of the disturbance run and of the modes are TENSA's own earlier output, kept as regression baselines to catch a change. No published or independent result exists for these wind turbine models in this network, and the case is not stable in the sense of its eigenvalues.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_2, run to 20 s | 0.05 Hz and 0.06 in damping ratio | 1.048 Hz, damping 0.249 is eigenvalue 1.054 Hz, 0.262 (0.006 Hz and 0.013 apart); 0.993 Hz, damping 0.206 is eigenvalue 1.009 Hz, 0.264 (0.016 Hz and 0.058 apart); 1.215 Hz, damping 0.281 is eigenvalue 1.218 Hz, 0.285 (0.004 Hz and 0.005 apart) | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_wt3.xlsx; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 5.51e-09 pu (bus 9) over 14 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_wt3.xlsx; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 8.46e-07 deg (bus 14) over 14 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_wt3.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 2.72721, expected 2.72721, difference 1.24e-06 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for ieee14_wt3.xlsx; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 81.4272, expected 81.4272, difference 1.24e-06 MW | yes |
| Largest rotor angle spread in the disturbance run (Line_1 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.05 deg | measured 53.9794, expected 53.9794, difference 8.33e-09 deg | yes |
| Lowest bus voltage in the disturbance run (Line_1 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.0001 pu | measured 0.998685, expected 0.998684, difference 3.73e-09 pu | yes |
| Lowest machine frequency in the disturbance run (Line_1 trip) | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 59.9512, expected 59.9512, difference 4.56e-07 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 1.05398, expected 1.05398, difference 4.88e-08 Hz | yes |
| Least damped mode between 0.8 and 1.4 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.26187, expected 0.26187, difference 4.67e-10 | yes |
| Wind turbine mode between 0.13 and 0.2 Hz: frequency | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 Hz | measured 0.155728, expected 0.155728, difference 4.6e-09 Hz | yes |
| Wind turbine mode between 0.13 and 0.2 Hz: damping ratio | TENSA's own earlier output (a baseline, not a verification) | TENSA 0.5.0 with ANDES 2.0.0, 2026-11-17: its own earlier output (a regression baseline: TENSA's own earlier output, not a verification) | 0.002 | measured 0.199734, expected 0.199734, difference 4.33e-09 | yes |

### IEEE RTS-24 reliability test system, as PGLib-OPF holds it { #rts24 }

The 24-bus IEEE Reliability Test System of 1979 as the PGLib-OPF library (v23.07) holds it: 24 buses at 138 and 230 kV, 33 generators and 38 branches, with a peak load of 2,850 MW. A small case for the power flow, and for working with the diagram and the tables. The library prepares the case for optimal power flow, so a power flow on it is not an operating point of the system (see the caveats). It has no machine models, so there is no time-domain run.

- **Id:** `rts24`
- **Kind:** Steady state
- **Size:** 24 buses, 33 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `pglib_opf_case24_ieee_rts.m`

**Source.** Bundled with TENSA as `pglib_opf_case24_ieee_rts.m` from <https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case24_ieee_rts.m>, retrieved 2026-11-18. SHA-256 `5d4fc2d4a1a282f700c51747e592f5a5ac15fa6d5eadb7df7ae937bbe3063374`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: The Institute of Electrical and Electronics Engineers (IEEE), whose copyright the file's header states ("Copyright (c) 1979 The Institute of Electrical and Electronics Engineers (IEEE) Licensed under the Creative Commons Attribution 4.0 International license"), the IEEE Reliability Test System Task Force, whose system it is, and the IEEE PES Power Grid Library, which curated the file (pglib-opf v23.07, https://github.com/power-grid-lib/pglib-opf, pglib_opf_case24_ieee_rts.m). The header names M. E. Brennan of the IEEE as the contact for questions about further reuse of the data. The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header, and what the library changed is in the caveats. Anyone who passes the file on gives this credit, the licence link and the same statement. The library's code is under the MIT licence, which is not the licence of its data.

**Citations**

- **System:** IEEE Reliability Test System Task Force of the Applications of Probability Methods Subcommittee, "IEEE reliability test system," IEEE Transactions on Power Apparatus and Systems, vol. PAS-98, no. 6, pp. 2047-2054, Nov./Dec. 1979, doi:10.1109/TPAS.1979.319398. The system the file describes, which its header names as the source of its power flow data. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; the paper's text is behind a paywall and was not read. [DOI](https://doi.org/10.1109/TPAS.1979.319398)
- **Data source:** IEEE PES Power Grid Library, pglib-opf v23.07 (tag v23.07, commit dc6be4b2f85c), pglib_opf_case24_ieee_rts.m, https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case24_ieee_rts.m (accessed 2026-11-18). Its header names the RTS of 1979 as the source of the power flow data, Georgia Tech's Power Systems Control and Automation Laboratory as the source of the cost data and Bruce Wollenberg as the provider of the MATPOWER case file data, and states The Institute of Electrical and Electronics Engineers' copyright of 1979 under the Creative Commons Attribution 4.0 International licence. The git blob of the file at the tag is 00b024c2e583b82452392514d2c22881c708ba7c, the one of the file TENSA bundles. [Link](https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case24_ieee_rts.m)
- **Data source:** S. Babaeinejadsarookolaee, A. Birchfield, R. D. Christie, C. Coffrin, C. DeMarco, R. Diao, M. Ferris, S. Fliscounakis, S. Greene, R. Huang, C. Josz, R. Korab, B. Lesieutre, J. Maeght, T. W. K. Mak, D. K. Molzahn, T. J. Overbye, P. Panciatici, B. Park, J. Snodgrass, A. Tbaileh, P. Van Hentenryck and R. Zimmerman, "The Power Grid Library for Benchmarking AC Optimal Power Flow Algorithms," arXiv:1908.02788, August 2019. The report of the library the file comes from (IEEE PES Power Grid Library, pglib-opf), which its README names as its detailed report and which asks that the version be given when it is cited: this is v23.07. [Link](https://arxiv.org/abs/1908.02788)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@article{ieee1979rts,
  author  = {{IEEE Reliability Test System Task Force of the Applications of Probability Methods Subcommittee}},
  title   = {{IEEE} Reliability Test System},
  journal = {IEEE Transactions on Power Apparatus and Systems},
  volume  = {PAS-98},
  number  = {6},
  pages   = {2047--2054},
  year    = {1979},
  month   = nov,
  doi     = {10.1109/TPAS.1979.319398}
}
```

```bibtex
% Data source
@misc{pglib_opf_case24_ieee_rts,
  title        = {{PGLib-OPF} v23.07, pglib\_opf\_case24\_ieee\_rts.m},
  howpublished = {IEEE PES Power Grid Library},
  url          = {https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case24_ieee_rts.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{babaeinejadsarookolaee2019pglib,
  author        = {Babaeinejadsarookolaee, Sogol and Birchfield, Adam and Christie, Richard D. and Coffrin, Carleton and DeMarco, Christopher and Diao, Ruisheng and Ferris, Michael and Fliscounakis, Stephane and Greene, Scott and Huang, Renke and Josz, Cedric and Korab, Roman and Lesieutre, Bernard and Maeght, Jean and Mak, Terrence W. K. and Molzahn, Daniel K. and Overbye, Thomas J. and Panciatici, Patrick and Park, Byungkwon and Snodgrass, Jonathan and Tbaileh, Ahmad and Van Hentenryck, Pascal and Zimmerman, Ray},
  title         = {The Power Grid Library for Benchmarking {AC} Optimal Power Flow Algorithms},
  year          = {2019},
  eprint        = {1908.02788},
  archivePrefix = {arXiv},
  note          = {library version v23.07}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of PGLib-OPF v23.07, byte for byte and with its header comments (what the library changed in the system's data is in the caveats)

**Caveats**

- This is PGLib-OPF's version of the system, set up for optimal power flow, and not an operating point of the RTS. The network is the RTS's as MATPOWER 8.1's case24_ieee_rts holds it: compared with that file, all 24 buses (the loads of 2850 MW and 580 MVAr, the shunt of -100 MVAr at bus 6, the base voltages of 138 and 230 kV and the voltage limits) and the impedance, charging, tap, shift and ratings A and C of all 38 branches (five of them transformers) are equal, as are the active power limits and the reactive limits of the 33 generators.
- The library changed the dispatch and the set-points. MATPOWER's file gives the generators set-points from 0.98 to 1.05 pu and its own dispatch of 2999.3 MW; the library's file sets every generator to 1.0 pu, starts every bus flat (1.0 pu, 0 degrees), gives the generators another dispatch (32 of the 33 differ), a rating B on six branches that differs and angle limits of 30 degrees where MATPOWER's are 360. The file stores no solved state to compare with.
- What a power flow on the file means: the library's dispatch is 2220.5 MW for a load of 2850 MW, so the slack takes up the rest. The slack bus 13 has three units of 197 MW (591 MW of limit, 399 MW scheduled), and a power flow makes it deliver 1073.0 MW, 482 MW over that limit, with 44.5 MW of losses. TENSA does not enforce active power limits and the Violations table does not check them. It is a solution of the network's equations (checked against pandapower), not an optimum and not a published operating point.
- After a power flow the Violations table reads 5: the five 12 MW units at bus 15 each deliver 21.7 MVAr against a maximum of 6, since a power flow does not enforce reactive limits unless asked to and shares the reactive power the bus needs among its six units without regard to them. It also warns of five buses within 0.02 pu of the 0.95 pu minimum (buses 3, 4, 8, 12 and 24, at 0.964 to 0.969 pu) and two lines at 83% and 94% of their rating.
- The generator at bus 14 has no active power to give (its limit is 0) and a reactive range of -50 to 200 MVAr, so it supports the voltage only.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis. The file also holds the cost data of the optimal power flow, which TENSA does not use.

**Verification.** The power flow agrees with the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved (Newton-Raphson to 1e-8 MVA): bus voltages to 3.8e-8 pu, angles to 6.7e-6 degrees, and the losses (44.527 MW) and the slack's power (1073.03 MW) to 9e-5 MW. That is the independent reference there is: the file starts from a flat state, so it stores no solution, and no published solution of the library's dispatch was found. The network data was compared with MATPOWER 8.1's case24_ieee_rts outside the harness, with the result the caveats give. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case24_ieee_rts.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 3.77e-08 pu (bus 6) over 24 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case24_ieee_rts.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 6.69e-06 deg (bus 2) over 24 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case24_ieee_rts.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 44.5272, expected 44.5271, difference 8.5e-05 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case24_ieee_rts.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 1073.03, expected 1073.03, difference 8.5e-05 MW | yes |

### IEEE 30-bus test case, as PGLib-OPF holds it { #ieee30 }

The IEEE 30-bus test case of the University of Washington archive as the PGLib-OPF library (v23.07) holds it: 30 buses, 6 generators and 41 branches, a network and its loading only. A small case for the power flow, and for working with the diagram and the tables. The library prepares the case for optimal power flow, so a power flow on it is not the archive's operating point (see the caveats). It has no machine models, so there is no time-domain run.

- **Id:** `ieee30`
- **Kind:** Steady state
- **Size:** 30 buses, 6 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `pglib_opf_case30_ieee.m`

**Source.** Bundled with TENSA as `pglib_opf_case30_ieee.m` from <https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case30_ieee.m>, retrieved 2026-11-18. SHA-256 `cae3290639d989731d32428aacf30c0b918bc91db73bc54791f3aa62d3f76c70`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: Richard D. Christie, University of Washington Electrical Engineering, whose copyright the file's header states ("Copyright (c) 1999 by Richard D. Christie, University of Washington Electrical Engineering Licensed under the Creative Commons Attribution 4.0 International license"), and the IEEE PES Power Grid Library, which curated the file (pglib-opf v23.07, https://github.com/power-grid-lib/pglib-opf, pglib_opf_case30_ieee.m). The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header, and what the library and the archive's conversion changed is in the caveats. Anyone who passes the file on gives this credit, the licence link and the same statement. The library's code is under the MIT licence, which is not the licence of its data.

**Citations**

- **Data source:** 30 Bus Power Flow Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf30/pg_tca30bus.htm (accessed 2026-11-18). The page says the case represents a portion of the American Electric Power System (in the Midwestern US) as of December 1961, that the data was provided by Iraj Dabbagchi of AEP and entered in IEEE Common Data Format by Rich Christie at the University of Washington in August 1993, that the line impedances were hard to read on the printed data and may be incorrect, that the data has not been run through a power flow to check the answers, that the 11 kV and 1.0 kV base voltages are Christie's guess (the model has these buses at 132 or 33 kV), and that the case has no line limits. [Link](https://labs.ece.uw.edu/pstca/pf30/pg_tca30bus.htm)
- **Data source:** IEEE PES Power Grid Library, pglib-opf v23.07 (tag v23.07, commit dc6be4b2f85c), pglib_opf_case30_ieee.m, https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case30_ieee.m (accessed 2026-11-18). Its header names the archive's ieee30cdf.txt as its source, converted by cdf2matp rev. 1.11 on 20 September 2004, and states Richard D. Christie's copyright of 1999 under the Creative Commons Attribution 4.0 International licence. The git blob of the file at the tag is d429394621c797fa3893d4e4b6d8efa220a4015a, the one of the file TENSA bundles. [Link](https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case30_ieee.m)
- **Data source:** S. Babaeinejadsarookolaee, A. Birchfield, R. D. Christie, C. Coffrin, C. DeMarco, R. Diao, M. Ferris, S. Fliscounakis, S. Greene, R. Huang, C. Josz, R. Korab, B. Lesieutre, J. Maeght, T. W. K. Mak, D. K. Molzahn, T. J. Overbye, P. Panciatici, B. Park, J. Snodgrass, A. Tbaileh, P. Van Hentenryck and R. Zimmerman, "The Power Grid Library for Benchmarking AC Optimal Power Flow Algorithms," arXiv:1908.02788, August 2019. The report of the library the file comes from (IEEE PES Power Grid Library, pglib-opf), which its README names as its detailed report and which asks that the version be given when it is cited: this is v23.07. [Link](https://arxiv.org/abs/1908.02788)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee30,
  title        = {30 Bus Power Flow Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf30/pg_tca30bus.htm},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{pglib_opf_case30_ieee,
  title        = {{PGLib-OPF} v23.07, pglib\_opf\_case30\_ieee.m},
  howpublished = {IEEE PES Power Grid Library},
  url          = {https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case30_ieee.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{babaeinejadsarookolaee2019pglib,
  author        = {Babaeinejadsarookolaee, Sogol and Birchfield, Adam and Christie, Richard D. and Coffrin, Carleton and DeMarco, Christopher and Diao, Ruisheng and Ferris, Michael and Fliscounakis, Stephane and Greene, Scott and Huang, Renke and Josz, Cedric and Korab, Roman and Lesieutre, Bernard and Maeght, Jean and Mak, Terrence W. K. and Molzahn, Daniel K. and Overbye, Thomas J. and Panciatici, Patrick and Park, Byungkwon and Snodgrass, Jonathan and Tbaileh, Ahmad and Van Hentenryck, Pascal and Zimmerman, Ray},
  title         = {The Power Grid Library for Benchmarking {AC} Optimal Power Flow Algorithms},
  year          = {2019},
  eprint        = {1908.02788},
  archivePrefix = {arXiv},
  note          = {library version v23.07}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of PGLib-OPF v23.07, byte for byte and with its header comments (what the library changed in the archive's data is in the caveats)

**Caveats**

- This is PGLib-OPF's version of the archive's data, and not the archive's solved case. The network is the archive's: compared with the archive's ieee30cdf.txt, the loads and shunts of all 30 buses, the base voltages, and the resistance, reactance, charging and phase shift of all 41 branches are equal, and three transformers (9-11, 9-10 and 12-13) have a ratio of 1 where the archive's is 0, which also means 1. It is also the network of MATPOWER 8.0's case_ieee30 (the same loads, shunts and branch data). MATPOWER's case30 is another case, a hybrid with other generator data, whose branch impedances differ (the reactance of 36 of the 41 branches) and one of whose loads does; it is not this one.
- The library changed the generators and the limits, so a power flow on the file is not the archive's operating point. Every generator is set to 1.0 pu and every bus starts flat, so the file stores no solved state to compare with; the archive's set-points are 1.06, 1.045, 1.01, 1.01, 1.082 and 1.071 pu at buses 1, 2, 5, 8, 11 and 13. The dispatch is the library's, 135.5 MW at bus 1 and 46.0 MW at bus 2 where the archive has 260.2 and 40.0 MW: 181.5 MW for a load of 283.4 MW. A power flow therefore has the slack at bus 1 deliver 257.8 MW, not 135.5 (its limit in the file is 271 MW), and the losses are 20.4 MW. The generators at buses 5, 8, 11 and 13 have no active power (the library classes them as synchronous condensers).
- What a power flow on the file means: its dispatch, generator limits and line ratings are the library's, set for the optimal power flow it benchmarks, which TENSA does not solve. A power flow holds the active power the file gives each generator (the slack takes up the difference) and the voltage at 1.0 pu. It is a solution of the network's equations (checked against pandapower), not an optimum and not a published operating point.
- The archive's page says the case has no line limits. The ratings in the file (from 20 to 267 MVA, on all 41 branches) and its angle limits of 30 degrees are the library's, from its own model. After a power flow the Violations table reads 5, which is what the data gives and not an error: Line 1-2 loaded to 128.7% of its 138 MVA rating, the slack at bus 1 below its minimum reactive power of 0 (-55.8 MVAr), and the generators at buses 2, 5 and 8 above their maximum reactive power (52.1, 63.9 and 86.0 MVAr against 46, 40 and 40), since a power flow does not enforce reactive limits unless asked to. Buses 26 and 30 (0.956 and 0.954 pu) are within 0.02 pu of the 0.94 pu minimum.
- The archive's page says the line impedances were hard to read on its source and may be wrong, and that the data was never run through a power flow to check the answers. It also says the 11 kV and 1.0 kV base voltages are its author's guess, and the file keeps them: 9 buses at 132 kV, 18 at 33 kV, 2 at 11 kV and bus 9 at 1 kV.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis.

**Verification.** The power flow agrees with the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved (Newton-Raphson to 1e-8 MVA): bus voltages to 1.7e-8 pu, angles to 1.8e-6 degrees, and the losses (20.359 MW) and the slack's power (257.759 MW) to 6e-6 MW. That is the independent reference there is. No published or stored solution exists to compare with: the file starts from a flat state, and the archive's own stored solution belongs to its dispatch and its voltage set-points, which the library changed. The network data was compared with the archive's ieee30cdf.txt and with MATPOWER's case_ieee30 outside the harness, with the result the caveats give. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case30_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.68e-08 pu (bus 30) over 30 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case30_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 1.81e-06 deg (bus 5) over 30 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case30_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 20.3588, expected 20.3588, difference 6.16e-06 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case30_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 257.759, expected 257.759, difference 5.78e-06 MW | yes |

### IEEE 57-bus test case, as PGLib-OPF holds it { #ieee57 }

The IEEE 57-bus test case of the University of Washington archive as the PGLib-OPF library (v23.07) holds it: 57 buses, 7 generators and 80 branches, a network and its loading only. A small case for the power flow, with a heavier load than the 30-bus case. The library prepares the case for optimal power flow, so a power flow on it is not the archive's operating point (see the caveats). It has no machine models, so there is no time-domain run.

- **Id:** `ieee57`
- **Kind:** Steady state
- **Size:** 57 buses, 7 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `pglib_opf_case57_ieee.m`

**Source.** Bundled with TENSA as `pglib_opf_case57_ieee.m` from <https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case57_ieee.m>, retrieved 2026-11-18. SHA-256 `aa3b48f7cbaade2afd69cb3790ef72be981db8494dcef9277bee460f754bdb22`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: Richard D. Christie, University of Washington Electrical Engineering, whose copyright the file's header states ("Copyright (c) 1999 by Richard D. Christie, University of Washington Electrical Engineering Licensed under the Creative Commons Attribution 4.0 International license"), and the IEEE PES Power Grid Library, which curated the file (pglib-opf v23.07, https://github.com/power-grid-lib/pglib-opf, pglib_opf_case57_ieee.m). The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header, and what the library and the archive's conversion changed is in the caveats. Anyone who passes the file on gives this credit, the licence link and the same statement. The library's code is under the MIT licence, which is not the licence of its data.

**Citations**

- **Data source:** 57 Bus Power Flow Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf57/pg_tca57bus.htm (accessed 2026-11-18). The page says the case represents a portion of the American Electric Power System (in the Midwestern US) as it was in the early 1960s, that the data was provided by Iraj Dabbagchi of AEP and entered in IEEE Common Data Format by Rich Christie at the University of Washington in August 1993, that the line impedances were hard to read on the printed data and may be incorrect, that the data has not been run through a power flow to check the answers, and that the case has no line limits. [Link](https://labs.ece.uw.edu/pstca/pf57/pg_tca57bus.htm)
- **Data source:** IEEE PES Power Grid Library, pglib-opf v23.07 (tag v23.07, commit dc6be4b2f85c), pglib_opf_case57_ieee.m, https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case57_ieee.m (accessed 2026-11-18). Its header names the archive's ieee57cdf.txt as its source, converted by cdf2matp rev. 1.11 on 20 September 2004, and states Richard D. Christie's copyright of 1999 under the Creative Commons Attribution 4.0 International licence. The git blob of the file at the tag is d8b0c9e8b45265e57f52b7ab96880ad3a874cde5, the one of the file TENSA bundles. [Link](https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case57_ieee.m)
- **Data source:** S. Babaeinejadsarookolaee, A. Birchfield, R. D. Christie, C. Coffrin, C. DeMarco, R. Diao, M. Ferris, S. Fliscounakis, S. Greene, R. Huang, C. Josz, R. Korab, B. Lesieutre, J. Maeght, T. W. K. Mak, D. K. Molzahn, T. J. Overbye, P. Panciatici, B. Park, J. Snodgrass, A. Tbaileh, P. Van Hentenryck and R. Zimmerman, "The Power Grid Library for Benchmarking AC Optimal Power Flow Algorithms," arXiv:1908.02788, August 2019. The report of the library the file comes from (IEEE PES Power Grid Library, pglib-opf), which its README names as its detailed report and which asks that the version be given when it is cited: this is v23.07. [Link](https://arxiv.org/abs/1908.02788)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee57,
  title        = {57 Bus Power Flow Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf57/pg_tca57bus.htm},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{pglib_opf_case57_ieee,
  title        = {{PGLib-OPF} v23.07, pglib\_opf\_case57\_ieee.m},
  howpublished = {IEEE PES Power Grid Library},
  url          = {https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/pglib_opf_case57_ieee.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{babaeinejadsarookolaee2019pglib,
  author        = {Babaeinejadsarookolaee, Sogol and Birchfield, Adam and Christie, Richard D. and Coffrin, Carleton and DeMarco, Christopher and Diao, Ruisheng and Ferris, Michael and Fliscounakis, Stephane and Greene, Scott and Huang, Renke and Josz, Cedric and Korab, Roman and Lesieutre, Bernard and Maeght, Jean and Mak, Terrence W. K. and Molzahn, Daniel K. and Overbye, Thomas J. and Panciatici, Patrick and Park, Byungkwon and Snodgrass, Jonathan and Tbaileh, Ahmad and Van Hentenryck, Pascal and Zimmerman, Ray},
  title         = {The Power Grid Library for Benchmarking {AC} Optimal Power Flow Algorithms},
  year          = {2019},
  eprint        = {1908.02788},
  archivePrefix = {arXiv},
  note          = {library version v23.07}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of PGLib-OPF v23.07, byte for byte and with its header comments (what the library changed in the archive's data is in the caveats)

**Caveats**

- This is PGLib-OPF's version of the archive's data, and not the archive's solved case. The network is the archive's: compared with the archive's ieee57cdf.txt, the loads (1250.8 MW in all) and shunts of all 57 buses and the resistance, reactance, charging, ratio and phase shift of all 80 branches are equal. It is also the network of MATPOWER 8.0's case57. The archive gives no base voltage, and the file gives every bus 1.0 kV, so a voltage in kV on the diagram or in a table is the per unit value again.
- The library changed the generators and the limits, so a power flow on the file is not the archive's operating point. Every generator is set to 1.0 pu and every bus starts flat, so the file stores no solved state to compare with; the archive's set-points are 1.04, 1.01, 0.985, 0.98, 1.005, 0.98 and 1.015 pu at buses 1, 2, 3, 6, 8, 9 and 12. The dispatch is the library's, 122.5, 30.0, 579.5 and 259.5 MW at buses 1, 3, 8 and 12 where the archive has 128.9, 40, 450 and 310 MW: 991.5 MW for a load of 1250.8 MW. A power flow therefore has the slack at bus 1 deliver 411.7 MW against the 245 MW the file allows it, 167 MW over, and the losses are 29.9 MW. TENSA's power flow does not enforce active power limits, and the Violations table does not check them. The file's header says that the reactive limits of generator 1 were set by hand to 200 and -140 MVAr; that note is the archive conversion's, and the file's own limits for it are 123 and -123 MVAr, from the library's reactive capacity model.
- What a power flow on the file means: its dispatch, generator limits and line ratings are the library's, set for the optimal power flow it benchmarks, which TENSA does not solve. A power flow holds the active power the file gives each generator (the slack takes up the difference) and the voltage at 1.0 pu. It is a solution of the network's equations (checked against pandapower), not an optimum and not a published operating point.
- The archive's page says the case has no line limits. The ratings in the file (from 22 to 1617 MVA, on all 80 branches) and its angle limits of 30 degrees are the library's, from its own model; no line comes near its rating in a power flow. After a power flow the Violations table reads 5, which is what the data gives and not an error: bus 31 below its minimum (0.937 against 0.94 pu), and the generators at buses 2, 3, 6 and 9 above their maximum reactive power (78.2, 59.6, 30.2 and 111.2 MVAr against 50, 30, 25 and 9), since a power flow does not enforce reactive limits unless asked to. Six more buses are within 0.02 pu of a voltage limit.
- The archive's page says the line impedances were hard to read on its source and may be wrong, and that the data was never run through a power flow to check the answers.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis.

**Verification.** The power flow agrees with the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved (Newton-Raphson to 1e-8 MVA): bus voltages to 3.2e-8 pu, angles to 2.3e-6 degrees, and the losses (29.916 MW) and the slack's power (411.716 MW) to 2e-5 MW. That is the independent reference there is. No published or stored solution exists to compare with: the file starts from a flat state, and the archive's own stored solution belongs to its dispatch and its voltage set-points, which the library changed. The network data was compared with the archive's ieee57cdf.txt and with MATPOWER's case57 outside the harness, with the result the caveats give. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case57_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 3.2e-08 pu (bus 33) over 57 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case57_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 2.31e-06 deg (bus 33) over 57 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case57_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 29.9158, expected 29.9158, difference 1.88e-05 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on pglib_opf_case57_ieee.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 411.716, expected 411.716, difference 1.88e-05 MW | yes |

### RTS-GMLC reliability test system, 73 buses { #rts_gmlc }

The Reliability Test System of the Grid Modernization Lab Consortium (RTS-GMLC), the IEEE RTS-96 updated by the National Renewable Energy Laboratory and its partners, as the PSS/E version 33 file of its repository holds it: three areas, 73 buses at 138 and 230 kV, 160 generator records and 120 branches, loaded to a peak of 8,550 MW. A medium-size case for the power flow, with many generators and several at one bus, which is a test for the diagram. It is a PSS/E file, and its power flow is checked against a solution PSS/E printed. It has no machine models, so there is no time-domain run.

- **Id:** `rts_gmlc`
- **Kind:** Steady state
- **Size:** 73 buses, 160 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `RTS-GMLC.RAW`

**Source.** Bundled with TENSA as `RTS-GMLC.RAW` from <https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW>, retrieved 2026-11-18. SHA-256 `5db2a04865528419ce6e992e2b96bb9a2897b36c38f295ce8777e3a79591b783`.

**Licence.** [NREL Data Use Disclaimer Agreement](https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/README.md). Credit DOE/NREL/ALLIANCE (the U.S. Department of Energy, the National Renewable Energy Laboratory and Alliance for Sustainable Energy, LLC) in any publication that results from the use of this data, as the agreement asks, and cite the paper of Barrows et al. (2020) above. The names DOE/NREL/ALLIANCE may not be used in advertising or publicity to endorse any product or commercial entity without their written permission. The agreement lets anyone use, copy and distribute the data free of charge for any purpose provided that its entire notice appears in all copies of the data, and TENSA puts it in NOTICE.md, in RTS-GMLC-NOTICE.md beside the file, in the documentation page of the example cases and in EXAMPLE-SOURCES.md next to the case in a workspace. TENSA made no change to the data.

The licence asks that this notice appear, in full, in every copy of the data:

> DATA USE DISCLAIMER AGREEMENT
> *(“Agreement”)*
>
> These data (“Data”) are provided by the National Renewable Energy Laboratory (“NREL”), which is operated by Alliance for Sustainable Energy, LLC (“ALLIANCE”) for the U.S. Department Of Energy (“DOE”).
>
> Access to and use of these Data shall impose the following obligations on the user, as set forth in this Agreement.  The user is granted the right, without any fee or cost, to use, copy, and distribute these Data for any purpose whatsoever, provided that this entire notice appears in all copies of the Data.  Further, the user agrees to credit DOE/NREL/ALLIANCE in any publication that results from the use of these Data.  The names DOE/NREL/ALLIANCE, however, may not be used in any advertising or publicity to endorse or promote any products or commercial entities unless specific written permission is obtained from DOE/NREL/ ALLIANCE.  The user also understands that DOE/NREL/Alliance is not obligated to provide the user with any support, consulting, training or assistance of any kind with regard to the use of these Data or to provide the user with any updates, revisions or new versions of these Data.
>
> **YOU AGREE TO INDEMNIFY DOE/NREL/ALLIANCE, AND ITS SUBSIDIARIES, AFFILIATES, OFFICERS, AGENTS, AND EMPLOYEES AGAINST ANY CLAIM OR DEMAND, INCLUDING REASONABLE ATTORNEYS' FEES, RELATED TO YOUR USE OF THESE DATA.  THESE DATA ARE PROVIDED BY DOE/NREL/Alliance "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL DOE/NREL/ALLIANCE BE LIABLE FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER, INCLUDING BUT NOT LIMITED TO CLAIMS ASSOCIATED WITH THE LOSS OF DATA OR PROFITS, WHICH MAY RESULT FROM AN ACTION IN CONTRACT, NEGLIGENCE OR OTHER TORTIOUS CLAIM THAT ARISES OUT OF OR IN**

**Citations**

- **System:** C. Barrows, A. Bloom, A. Ehlen, J. Ikaheimo, J. Jorgenson, D. Krishnamurthy, J. Lau, B. McBennett, M. O'Connell, E. Preston, A. Staid, G. Stephen and J. P. Watson, "The IEEE Reliability Test System: A Proposed 2019 Update," IEEE Transactions on Power Systems, vol. 35, no. 1, pp. 119-127, January 2020, doi:10.1109/TPWRS.2019.2925557. The paper that describes the RTS-GMLC; its accepted manuscript (https://www.osti.gov/biblio/1545004) was read. [DOI](https://doi.org/10.1109/TPWRS.2019.2925557)
- **Data source:** RTS-GMLC, Reliability Test System - Grid Modernization Lab Consortium, GridMod/RTS-GMLC v0.2.3 (commit 3ece0d3725c8), RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW, https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW (accessed 2026-11-18). The repository's PSSE folder says the file was made from the repository's source data through its MATPOWER case and a PowerWorld Simulator 19 case, and was saved from PowerWorld; the file's first line is dated 7 November 2017. The repository's README states the data use agreement that is the licence, and describes the system as an updated version of the RTS-96. The git blob of the file at the tag is 41372a04c008b48027fbec4c239014bf3791b776, the one of the file TENSA bundles. [Link](https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW)
- **System:** C. Grigg, P. Wong, P. Albrecht, R. Allan, M. Bhavaraju, R. Billinton, Q. Chen, C. Fong, S. Haddad, S. Kuruganty, W. Li, R. Mukerji, D. Patton, N. Rau, D. Reppen, A. Schneider, M. Shahidehpour and C. Singh, "The IEEE Reliability Test System-1996. A report prepared by the Reliability Test System Task Force of the Application of Probability Methods Subcommittee," IEEE Transactions on Power Systems, vol. 14, no. 3, pp. 1010-1020, August 1999, doi:10.1109/59.780914. The system the RTS-GMLC updates (three joined copies of the RTS of 1979, which the RTS-GMLC paper describes). The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; its text was not read. [DOI](https://doi.org/10.1109/59.780914)
- **Data source:** PSS/E load flow report RTSOP_PSSE_Hooman.txt, RTS-GMLC repository (commit 3ece0d3725c8), https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt (accessed 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017. The solution PSS/E 33 printed for a copy of the RAW file, which the case's checks compare a power flow with (see the verification). [Link](https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@article{barrows2020rts,
  author  = {Barrows, Clayton and Bloom, Aaron and Ehlen, Ali and Ikaheimo, Jussi and Jorgenson, Jennie and Krishnamurthy, Dheepak and Lau, Jessica and McBennett, Brendan and O'Connell, Matthew and Preston, Eugene and Staid, Andrea and Stephen, Gord and Watson, Jean-Paul},
  title   = {The {IEEE} Reliability Test System: A Proposed 2019 Update},
  journal = {IEEE Transactions on Power Systems},
  volume  = {35},
  number  = {1},
  pages   = {119--127},
  year    = {2020},
  month   = jan,
  doi     = {10.1109/TPWRS.2019.2925557}
}
```

```bibtex
% Data source
@misc{rts_gmlc_raw,
  title        = {{RTS-GMLC} v0.2.3, RTS-GMLC.RAW (PSS/E version 33)},
  author       = {{National Renewable Energy Laboratory and partners}},
  howpublished = {GridMod/RTS-GMLC repository},
  url          = {https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW},
  urldate      = {2026-11-18}
}
```

```bibtex
% System
@article{grigg1999rts96,
  author  = {Grigg, C. and Wong, P. and Albrecht, P. and Allan, R. and Bhavaraju, M. and Billinton, R. and Chen, Q. and Fong, C. and Haddad, S. and Kuruganty, S. and Li, W. and Mukerji, R. and Patton, D. and Rau, N. and Reppen, D. and Schneider, A. and Shahidehpour, M. and Singh, C.},
  title   = {The {IEEE} Reliability Test System-1996. A report prepared by the Reliability Test System Task Force of the Application of Probability Methods Subcommittee},
  journal = {IEEE Transactions on Power Systems},
  volume  = {14},
  number  = {3},
  pages   = {1010--1020},
  year    = {1999},
  month   = aug,
  doi     = {10.1109/59.780914}
}
```

```bibtex
% Data source
@misc{rts_gmlc_psse_report,
  title        = {{PSS/E} load flow report {RTSOP\_PSSE\_Hooman.txt} of the {RTS-GMLC} case},
  author       = {Ghaffarzadeh, Hooman},
  year         = {2017},
  howpublished = {GridMod/RTS-GMLC repository},
  url          = {https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of the RTS-GMLC repository at v0.2.3, byte for byte and with its header line

**Caveats**

- The file is the PSS/E version 33 file of the RTS-GMLC repository, a peak-load case of the RTS-96 (three joined copies of the 24-bus RTS of 1979) as NREL and its partners updated it. The repository's PSSE page says it was made from the source data through the repository's MATPOWER case and a PowerWorld Simulator 19 case, and saved from PowerWorld, and its MATPOWER page says that case is a peak load flow case with all renewable generation disabled. 98 of the 160 generator records are in service (9076 MW of limit) and 62 are not (5473.8 MW), and the load is 8550 MW and 1740 MVAr; the data has 3 areas, 51 loads, 105 lines and 15 transformers.
- The 160 generator records are the 158 generators of the repository's gen.csv and two records named DC, one at bus 113 and one at bus 316. Several records share a bus (bus 113 has six).
- The system has a DC line, DC1 from bus 113 to bus 316, scheduled at 100 MW in the repository's dc_branch.csv and listed in its MATPOWER case as mpc.dcline (no flow set, limits of plus and minus 100 MW), and this file has none: its two-terminal DC section is empty, and the line is left as the two generator records named DC, each with 0 MW and the voltage set-point of its bus. The 100 MW transfer is not in the case. ANDES's reader takes buses, loads, fixed shunts, generators, branches, transformers, switched shunts and areas from a RAW file and skips every other section, two-terminal DC data included, with no message (a test adds a DC line to this file and shows it), as its MATPOWER reader does not read mpc.dcline; it would have dropped a DC line, and here it had none to drop. It reads the record at bus 113, the swing bus, as one of six slack generators (five in service), and the one at bus 316 as a generator that holds the voltage which another unit of that bus holds, so neither changes a solution. The RTS-96 also has a phase shifter (Barrows et al.); this file has no transformer with a phase angle.
- The file stores a voltage and an angle for every bus, and that state is not a solution of the file's data: a power flow differs from it by up to 0.081 pu and 18.1 degrees (both at bus 307), although the active power it stores for the slack, 220 MW, is what the solution needs. The cause was not found: putting the 100 MW of the DC line on its two buses takes the angle gap down to 12.6 degrees and leaves the voltage gap as it is, so the line is not the whole of it. No check rests on the stored state.
- The published solution is the report that PSS/E 33 printed for another copy of the file, RTS-GMLC_Hooman.raw (the repository's PSSE page says the copy corrects an issue where offline generators received a 1.000 pu voltage), and not for this file itself. PSS/E marks five of its generators as held at their maximum reactive power, and every transformer tap as locked. A check made for the purpose (scripts/crosscheck_pf.py report) found the two files hold the same network and dispatch: every bus, every generator in service and every branch and transformer are equal, and what differs is the voltage set-point of 40 generators that are out of service, the digits of the stored state, the header, and the end that two lines are listed from.
- The three switched shunts (buses 106, 206 and 306, -100 MVAr each) are marked as not adjustable in the file and are read as fixed shunts. The 15 transformers join 138 and 230 kV buses with fixed taps of 1.015 or 1.03 on the 138 kV side (the report marks every one as locked). The tap ratio is WINDV1 divided by WINDV2, as PSS/E has it; WINDV2 is 1.0 in every record, so ANDES's reading of the ratio as WINDV1 is the same.
- After a power flow the Violations table reads 22 and warns of 6: 22 generators are outside their reactive limits (21 above the maximum and one, 138, below the minimum), by 0.44 MVAr at most, since a power flow does not enforce reactive limits unless asked to, and the warnings are four lines at 92 to 98% of their rating and two generators at their maximum. With the limits enforced the solution is the one PSS/E printed.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis.

**Verification.** The power flow agrees with two independent references. The first is the solution PSS/E 33 printed, which the RTS-GMLC repository publishes for a copy of this file: the voltages of all 73 buses to 1.0e-4 pu and the angles to 0.0054 degrees at TENSA's defaults, to 5.8e-5 pu and 0.0053 degrees with the reactive limits enforced, which is the way that solution was made (the report marks five generators as held at their reactive maximum, and prints a voltage to four decimals and an angle to two, so that is its rounding), and the slack's power to 0.005 MW. The second is the solution pandapower 3.5.6 finds for the same file, which a PSS/E reader written for the check reads with no ANDES involved: bus voltages to 2.8e-8 pu, angles to 9.3e-6 degrees, and the losses (153.97 MW) and the slack's power (219.995 MW) to 2.2e-4 MW. The reader's network was checked against MATPOWER's definition of the admittance matrix to 3e-14 pu. The state the file stores is not a solution of its data (see the caveats), so it is no reference. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on RTS-GMLC.RAW, read by the PSS/E reader of scripts/crosscheck_pf.py; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 2.78e-08 pu (bus 103) over 73 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on RTS-GMLC.RAW, read by the PSS/E reader of scripts/crosscheck_pf.py; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 9.32e-06 deg (bus 306) over 73 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on RTS-GMLC.RAW, read by the PSS/E reader of scripts/crosscheck_pf.py; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 153.966, expected 153.965, difference 0.000217 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on RTS-GMLC.RAW, read by the PSS/E reader of scripts/crosscheck_pf.py; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 219.995, expected 219.995, difference 0.000182 MW | yes |
| Bus voltage magnitudes against the PSS/E solution | a published result | PSS/E 33 load flow report RTSOP_PSSE_Hooman.txt of the RTS-GMLC repository (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt, sha256 75080c127202662df85166ed66b995a0f68f40062092a7bf539d24b5d083b106, retrieved 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017, made from RTS-GMLC_Hooman.raw of the same folder (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC_Hooman.raw, sha256 a7cdbef898d5c76c9ee05ba70e43a6266d49308eadcad56ae55acc0263c55da7). PSS/E printed it after solving RTS-GMLC_Hooman.raw, which holds the same network and dispatch as RTS-GMLC.RAW (compared by scripts/crosscheck_pf.py report: every bus, every generator in service, every branch and transformer, apart from what a power flow does not use: the stored state, the settings of generators out of service and the end a branch with no tap is listed from); TENSA did not compute it. It prints a voltage to four decimals, an angle to two and the power of a generator to 0.1 MW | 0.0002 pu | largest difference 0.0001 pu (bus 315) over 73 buses | yes |
| Bus voltage angles against the PSS/E solution | a published result | PSS/E 33 load flow report RTSOP_PSSE_Hooman.txt of the RTS-GMLC repository (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt, sha256 75080c127202662df85166ed66b995a0f68f40062092a7bf539d24b5d083b106, retrieved 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017, made from RTS-GMLC_Hooman.raw of the same folder (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC_Hooman.raw, sha256 a7cdbef898d5c76c9ee05ba70e43a6266d49308eadcad56ae55acc0263c55da7). PSS/E printed it after solving RTS-GMLC_Hooman.raw, which holds the same network and dispatch as RTS-GMLC.RAW (compared by scripts/crosscheck_pf.py report: every bus, every generator in service, every branch and transformer, apart from what a power flow does not use: the stored state, the settings of generators out of service and the end a branch with no tap is listed from); TENSA did not compute it. It prints a voltage to four decimals, an angle to two and the power of a generator to 0.1 MW | 0.02 deg | largest difference 0.00539 deg (bus 312) over 73 buses | yes |
| Slack active power against the PSS/E solution | a published result | PSS/E 33 load flow report RTSOP_PSSE_Hooman.txt of the RTS-GMLC repository (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt, sha256 75080c127202662df85166ed66b995a0f68f40062092a7bf539d24b5d083b106, retrieved 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017, made from RTS-GMLC_Hooman.raw of the same folder (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC_Hooman.raw, sha256 a7cdbef898d5c76c9ee05ba70e43a6266d49308eadcad56ae55acc0263c55da7). PSS/E printed it after solving RTS-GMLC_Hooman.raw, which holds the same network and dispatch as RTS-GMLC.RAW (compared by scripts/crosscheck_pf.py report: every bus, every generator in service, every branch and transformer, apart from what a power flow does not use: the stored state, the settings of generators out of service and the end a branch with no tap is listed from); TENSA did not compute it. It prints a voltage to four decimals, an angle to two and the power of a generator to 0.1 MW | 0.1 MW | measured 219.995, expected 220, difference 0.00451 MW | yes |
| Bus voltage magnitudes against the PSS/E solution, reactive limits enforced | a published result | PSS/E 33 load flow report RTSOP_PSSE_Hooman.txt of the RTS-GMLC repository (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt, sha256 75080c127202662df85166ed66b995a0f68f40062092a7bf539d24b5d083b106, retrieved 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017, made from RTS-GMLC_Hooman.raw of the same folder (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC_Hooman.raw, sha256 a7cdbef898d5c76c9ee05ba70e43a6266d49308eadcad56ae55acc0263c55da7). PSS/E printed it after solving RTS-GMLC_Hooman.raw, which holds the same network and dispatch as RTS-GMLC.RAW (compared by scripts/crosscheck_pf.py report: every bus, every generator in service, every branch and transformer, apart from what a power flow does not use: the stored state, the settings of generators out of service and the end a branch with no tap is listed from); TENSA did not compute it. It prints a voltage to four decimals, an angle to two and the power of a generator to 0.1 MW; the report was solved with the generators held to their reactive limits, and the power flow compared with it is run that way | 0.0001 pu | largest difference 5.77e-05 pu (bus 112) over 73 buses | yes |
| Bus voltage angles against the PSS/E solution, reactive limits enforced | a published result | PSS/E 33 load flow report RTSOP_PSSE_Hooman.txt of the RTS-GMLC repository (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt, sha256 75080c127202662df85166ed66b995a0f68f40062092a7bf539d24b5d083b106, retrieved 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017, made from RTS-GMLC_Hooman.raw of the same folder (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC_Hooman.raw, sha256 a7cdbef898d5c76c9ee05ba70e43a6266d49308eadcad56ae55acc0263c55da7). PSS/E printed it after solving RTS-GMLC_Hooman.raw, which holds the same network and dispatch as RTS-GMLC.RAW (compared by scripts/crosscheck_pf.py report: every bus, every generator in service, every branch and transformer, apart from what a power flow does not use: the stored state, the settings of generators out of service and the end a branch with no tap is listed from); TENSA did not compute it. It prints a voltage to four decimals, an angle to two and the power of a generator to 0.1 MW; the report was solved with the generators held to their reactive limits, and the power flow compared with it is run that way | 0.01 deg | largest difference 0.00529 deg (bus 104) over 73 buses | yes |
| Slack active power against the PSS/E solution, reactive limits enforced | a published result | PSS/E 33 load flow report RTSOP_PSSE_Hooman.txt of the RTS-GMLC repository (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTSOP_PSSE_Hooman.txt, sha256 75080c127202662df85166ed66b995a0f68f40062092a7bf539d24b5d083b106, retrieved 2026-11-18), provided by Hooman Ghaffarzadeh on 8 November 2017, made from RTS-GMLC_Hooman.raw of the same folder (https://github.com/GridMod/RTS-GMLC/blob/3ece0d3725c844056132393ee252b3083dd4eab4/RTS_Data/FormattedData/PSSE/RTS-GMLC_Hooman.raw, sha256 a7cdbef898d5c76c9ee05ba70e43a6266d49308eadcad56ae55acc0263c55da7). PSS/E printed it after solving RTS-GMLC_Hooman.raw, which holds the same network and dispatch as RTS-GMLC.RAW (compared by scripts/crosscheck_pf.py report: every bus, every generator in service, every branch and transformer, apart from what a power flow does not use: the stored state, the settings of generators out of service and the end a branch with no tap is listed from); TENSA did not compute it. It prints a voltage to four decimals, an angle to two and the power of a generator to 0.1 MW; the report was solved with the generators held to their reactive limits, and the power flow compared with it is run that way | 0.1 MW | measured 219.998, expected 220, difference 0.00158 MW | yes |

### PEGASE 89-bus test case (part of the European transmission system) { #pegase89 }

A part of the European high-voltage transmission system as the PEGASE project of the French operator RTE made it, in MATPOWER 8.1's case89pegase: 89 buses at 380, 220 and 150 kV, 12 generators and 210 branches (47 of them transformers), with a load of 5,728 MW. The data is fictitious: it is made to look like part of the European system and does not describe it. A small case for the power flow, for the diagram and the tables of a network with transformers and aggregated generation, and for what a power flow makes of a state that a snapshot stored. It has no machine models, so there is no time-domain run.

- **Id:** `pegase89`
- **Kind:** Steady state
- **Size:** 89 buses, 12 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `case89pegase.m`

**Source.** Bundled with TENSA as `case89pegase.m` from <https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case89pegase.m>, retrieved 2026-11-18. SHA-256 `7eb25c591f04a08dcd99ab433451054eaafd8bb3d7999d9279a8ddb23d8ffe58`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: Cédric Josz, Stéphane Fliscounakis, Jean Maeght and Patrick Panciatici of Réseau de Transport d'Electricité (RTE), whose copyright the file's header states ("MATPOWER Copyright (c) 2015, 2016 by Cédric Josz, Stéphane Fliscounakis, Jean Maeght, and Patrick Panciatici Licensed under the Creative Commons Attribution 4.0 International license"), whose two papers (above) publications that use the data are asked to cite, and MATPOWER, which distributes the file (release 8.1, case89pegase.m). The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header. Anyone who passes the file on gives this credit, the licence link and the same statement.

**Citations**

- **Data source:** C. Josz, S. Fliscounakis, J. Maeght and P. Panciatici, "AC Power Flow Data in MATPOWER and QCQP Format: iTesla, RTE Snapshots, and PEGASE," arXiv:1603.01533, March 2016. The paper the file's header asks that publications based on the data cite. Its abstract page was opened and gives the title, the authors and the dates; the abstract says the paper publishes nine MATPOWER test cases, the largest a pan-European fictitious data set from the PEGASE project, which complements the four PEGASE cases published in MATPOWER 5.1 in March 2015 (the cases of this entry). The text of the paper was not read. [Link](https://arxiv.org/abs/1603.01533)
- **System:** S. Fliscounakis, P. Panciatici, F. Capitanescu and L. Wehenkel, "Contingency ranking with respect to overloads in very large power systems taking into account uncertainty, preventive and corrective actions," IEEE Transactions on Power Systems, vol. 28, no. 4, pp. 4909-4917, November 2013, doi:10.1109/TPWRS.2013.2251015. The second paper the file's header asks that publications based on the data cite. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title, authors, volume and pages; its text is behind a paywall and was not read. [DOI](https://doi.org/10.1109/TPWRS.2013.2251015)
- **Data source:** MATPOWER, data/case89pegase.m, release 8.1 (commit 1a828c7af590), https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case89pegase.m (accessed 2026-11-18). Its header describes the data as a part of the European high voltage transmission network of 89 buses, 12 generators and 210 branches at 380, 220 and 150 kV, says that the data are fictitious and do not correspond to real world data, that they stem from the PEGASE project (Pan European Grid Advanced Simulation and State Estimation) of the 7th Framework Program of the European Union, and states the copyright of 2015 and 2016 of its four authors under the Creative Commons Attribution 4.0 International licence. The address it gives for the project (www.fp7-pegase.com) did not resolve when checked. The git blob of the file at the commit is 71f1cf78dc523e4a3ffe532261d0525297cbab8b, the one of the file TENSA bundles. [Link](https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case89pegase.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{josz2016acpf,
  author        = {Josz, C{\'e}dric and Fliscounakis, St{\'e}phane and Maeght, Jean and Panciatici, Patrick},
  title         = {{AC} Power Flow Data in {MATPOWER} and {QCQP} Format: i{T}esla, {RTE} Snapshots, and {PEGASE}},
  year          = {2016},
  eprint        = {1603.01533},
  archivePrefix = {arXiv}
}
```

```bibtex
% System
@article{fliscounakis2013contingency,
  author  = {Fliscounakis, St{\'e}phane and Panciatici, Patrick and Capitanescu, Florin and Wehenkel, Louis},
  title   = {Contingency ranking with respect to overloads in very large power systems taking into account uncertainty, preventive and corrective actions},
  journal = {IEEE Transactions on Power Systems},
  volume  = {28},
  number  = {4},
  pages   = {4909--4917},
  year    = {2013},
  month   = nov,
  doi     = {10.1109/TPWRS.2013.2251015}
}
```

```bibtex
% Data source
@misc{matpower_case89pegase,
  title        = {{MATPOWER} data/case89pegase.m},
  howpublished = {MATPOWER release 8.1},
  url          = {https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case89pegase.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of MATPOWER 8.1, byte for byte and with its header comments

**Caveats**

- The data is fictitious. The header says it does not correspond to real world data and may be used to validate methods and tools, not for the operation and planning of the European grid. The network has 89 buses (50 at 380 kV, 5 at 220 kV and 34 at 150 kV), 12 generators in service (5,866 MW of output, the slack at bus 913 holding 1,249.4 MW against its limit of 1,700 MW), 210 branches (47 between buses of different base voltages, which TENSA draws as transformers; 32 of them have a tap ratio), a load of 5,727.9 MW and 1,374.9 MVAr, and shunts at 44 buses.
- Parts of the network are aggregated, which the header says (its remark 4): six buses carry a negative load, 2,430.8 MW in all, and two generators a negative minimum output, where the data stands for loads and generators together. The header's remark 2 says the line charging of every branch is set to 0 and the shunts of PEGASE's lines are put on the buses, which leaves the power flow equations as the original's: all 210 branches have a charging of 0 in the file.
- Three branches (7637-8581, 5848-7526 and 2154-5996) have a phase shift (-0.428, 0.179 and -0.153 degrees) and a tap ratio of 0, which MATPOWER reads as 1 and applies the shift for (its lib/makeYbus.m of the same release does both). ANDES 2.0.0's reader takes a branch with a ratio of 0 for a plain line and drops the shift (andes/io/matpower.py), so TENSA solves the network without those three shifts: the voltages are the same, since each shifter ends at a bus with one branch, and the angle of each of those three buses is 0.428, 0.179 and 0.153 degrees off the solution with the shifts (the angles of the others are not). The reference solution is pandapower's for the network as ANDES reads it, and says so in each check; a test shows that ANDES drops the three, and repeats it for the file of the 1354-bus case.
- 133 of the 210 branches have a rating of 0, which means no limit, and the Violations table does not check them; the 77 that have one (306 to 1,863 MVA) are 20 MVA above the current limits of the PEGASE data (the header's remark 1). After a power flow the Violations table reads 1 violation, line 5416-7637 at 100.1% of its rating, and 6 warnings (bus 2449 at 1.087 pu against the 1.1 pu maximum, and five lines at 80 to 93% of their rating). No generator is outside its reactive limits. On the diagram (180 symbols, 301 lines, none drawn over another), the values of a power flow have no clear place for 19 of the devices and are left off, which the diagram says over its corner; the tables have every value.
- The file stores a state, RTE's snapshot, and it is a solution of the file's equations at 86 of the 89 buses: against pandapower's solution its voltages differ by up to 1.6e-6 pu and its angles by up to 0.002 degrees, and its slack power by 0.3 MW. At the three buses that carry a negative load behind a branch of their own (8581, 7526 and 2154, the same three that have a phase shifter) the stored angle is 24.5, 10.2 and 8.8 degrees from the solution TENSA finds (24.96, 10.41 and 8.93 from the one with the phase shifts applied), and the power left over at the buses beside them is up to 3,000 MW; the voltages there agree. The cause was not found, so the check of the angles leaves those three buses out and every other check includes them.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis. The file also holds the cost data of the optimal power flow, which TENSA does not use.

**Verification.** The power flow agrees with two independent references. The first is the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved, for the network as ANDES reads it (three phase shifts left out, see the caveats): bus voltages to 2.6e-7 pu, angles to 1.2e-5 degrees, and the losses (132.43 MW) and the slack's power (1249.10 MW) to 0.002 MW. The second is the state RTE's snapshot stored in the file, which is a solution of the file's equations except at the angles of three buses: TENSA's voltages are within 1.7e-6 pu of it at all 89 buses, its angles within 0.0017 degrees at the other 86, and its slack power 0.3 MW off. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in case89pegase.m (the voltages and angles of RTE's snapshot that the PEGASE 89-bus data was made from, as this file carries them to six decimals; a solution of the file's equations except at the three buses 8581, 7526 and 2154, where the stored angle is 8.8 to 24.5 degrees from it (cause not found), so the angles of those three are left out; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 1e-05 pu | largest difference 1.71e-06 pu (bus 5210) over 89 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in case89pegase.m (the voltages and angles of RTE's snapshot that the PEGASE 89-bus data was made from, as this file carries them to six decimals; a solution of the file's equations except at the three buses 8581, 7526 and 2154, where the stored angle is 8.8 to 24.5 degrees from it (cause not found), so the angles of those three are left out; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.01 deg | largest difference 0.00166 deg (bus 2267) over 86 buses | yes |
| Slack active power against the solution stored in the case file | a solution stored with the source | the solved state stored in case89pegase.m (the voltages and angles of RTE's snapshot that the PEGASE 89-bus data was made from, as this file carries them to six decimals; a solution of the file's equations except at the three buses 8581, 7526 and 2154, where the stored angle is 8.8 to 24.5 degrees from it (cause not found), so the angles of those three are left out; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.5 MW | measured 1249.1, expected 1249.4, difference 0.296 MW | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case89pegase.m, read by matpowercaseframes, with the phase shift of 3 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 0 pu in a bus voltage and 0.43 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 2.61e-07 pu (bus 8964) over 89 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case89pegase.m, read by matpowercaseframes, with the phase shift of 3 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 0 pu in a bus voltage and 0.43 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 1.24e-05 deg (bus 8581) over 89 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case89pegase.m, read by matpowercaseframes, with the phase shift of 3 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 0 pu in a bus voltage and 0.43 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 132.428, expected 132.427, difference 0.00185 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case89pegase.m, read by matpowercaseframes, with the phase shift of 3 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 0 pu in a bus voltage and 0.43 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 1249.1, expected 1249.1, difference 0.00185 MW | yes |

### IEEE 118-bus test case { #ieee118 }

The IEEE 118-bus test case of the University of Washington archive as MATPOWER holds it (case118): 118 buses, 54 generators and 186 branches, a network and its loading only. A medium-size case for the power flow, and for how the diagram and the tables handle a hundred buses; it has no machine models, so there is no time-domain run.

- **Id:** `ieee118`
- **Kind:** Steady state
- **Size:** 118 buses, 54 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `case118.m`

**Source.** Copied from your own ANDES installation (`andes/cases/matpower/case118.m`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `bc2e6f22b4b9e776572885ee4b50e4f4ab2ee0c5577e9126e86d906f14c4b5f7`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/matpower/case118.m>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES). The data is the archive's, which states no licence, and MATPOWER's licence notice says that its case files are not covered by its BSD license and have in most cases been included with permission or converted from data available from a public source. TENSA does not redistribute the file: it copies it from the user's own ANDES.

**Citations**

- **Data source:** 118 Bus Power Flow Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf118/pg_tca118bus.htm (accessed 2026-11-17). The page says the case represents a portion of the American Electric Power System (in the Midwestern US) as of December 1962, typed in from a copy of the AEP document by Rich Christie at the University of Washington in 1993 (in PECO PSAP format, then in IEEE Common Data Format, ieee118cdf.txt). [Link](https://labs.ece.uw.edu/pstca/pf118/pg_tca118bus.htm)
- **Data source:** MATPOWER, data/case118.m, release 8.0, https://github.com/MATPOWER/matpower/blob/8.0/data/case118.m (accessed 2026-11-17). Its header says it was converted from the archive's IEEE CDF file (ieee118cdf.txt) on 15 October 2014 by cdf2matp, that the base kV data come from the archive's PSAP file and were added by hand on 10 March 2006, and that branches 86-87 and 68-116 were changed from transmission lines to transformers with a tap ratio of 1 on 15 February 2019. ANDES's copy of the file (andes/cases/matpower/case118.m) is byte for byte this one. [Link](https://github.com/MATPOWER/matpower/blob/8.0/data/case118.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for the library that distributes the case118 file. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee118,
  title        = {118 Bus Power Flow Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf118/pg_tca118bus.htm},
  urldate      = {2026-11-17}
}
```

```bibtex
% Data source
@misc{matpower_case118,
  title        = {{MATPOWER} data/case118.m},
  howpublished = {MATPOWER release 8.0},
  url          = {https://github.com/MATPOWER/matpower/blob/8.0/data/case118.m},
  urldate      = {2026-11-17}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The system is a portion of the American Electric Power System as of December 1962, typed in from a copy of the AEP document by Rich Christie at the University of Washington in 1993 (the archive's page says so). The same page warns that the base kV levels in the bus names appear to be a bad guess and that the line MVA limits were not part of the original data. Take the file's 138, 345 and 161 kV (106, 11 and 1 buses) as the file's data and not as the real system's. The file carries no line ratings (all 186 are 0), so TENSA reports no loading for a line and its Violations table has no line limits to check.
- The file is MATPOWER's case118 (ANDES's copy is byte for byte the one in MATPOWER 8.0), which is the archive's IEEE CDF data with two differences, found by comparing the loads, generator outputs, shunts, branch impedances, charging and ratios and the stored voltages and angles of the two files. First, the 15 buses where the archive lists a generator with a negative output (-9 MW at bus 4 to -184 MW at bus 116: buses 4, 8, 24, 27, 40, 42, 72, 73, 90, 91, 99, 107, 112, 113 and 116) have that output as extra load here and the generator kept at 0 MW to hold the voltage (bus 4 has 39 MW of load here against 30 MW and a generator of -9 MW in the archive), so the net injection at each bus is the archive's. Second, branches 86-87 and 68-116, lines in the archive, are transformers with a ratio of 1 here: MATPOWER's header records the change, of 15 February 2019, as made for consistency with the bus base voltages. 35 of the 54 generators are scheduled at 0 MW: the case has many voltage-control devices.
- ANDES's MATPOWER reader gives a bus whose base voltage is 0 a base of 110 kV. This file has no such bus (every bus has the 138, 345 or 161 kV the PSAP file gave it), so the rule does not apply to it.
- The voltages and angles the file carries are the archive's stored final state, to the archive's three decimals of a voltage and two of an angle (the same digits as ieee118cdf.txt, which was compared), and that state is not a solution of the data. TENSA's and pandapower's solutions agree to 1.4e-8 pu and 9.5e-6 degrees, and differ from the stored state by up to 0.0173 pu (bus 30, 0.968 stored and 0.985 solved) and 0.303 degrees (bus 1), with 114 of the 118 voltages within 2e-3 pu; the stored slack power is 516.4 MW against 513.9 MW solved. The check against the stored state therefore has the tolerance that state allows, 0.02 pu, 0.35 degrees and 3 MW, and the reference to hold TENSA to is pandapower's solution, to 1e-4 pu.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis.
- A power flow, which does not enforce reactive limits unless asked to (and pandapower's reference does not either), leaves six generators outside their reactive limits, so the Violations count reads 6 once it has run: the generator at bus 103 above its maximum (75.4 against 40 MVAr) and those at buses 19, 32, 34, 92 and 105 below their minimum. The table also warns of buses near their voltage limits (0.943 pu at bus 76, against a minimum of 0.94).

**Verification.** Compared with independent references: the power flow agrees with pandapower's solution of the same network, bus voltages to 1.4e-8 pu, angles to 9.5e-6 degrees, and the losses (132.863 MW) and the slack's power (513.863 MW) to 1.4e-4 MW. It also agrees with the state the University of Washington archive stores with the data, within what that state allows: it is not a solution (see the caveats), and the largest differences are 0.0173 pu, 0.303 degrees and 2.5 MW. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in case118.m (the final voltages and angles of the University of Washington archive's ieee118cdf.txt, which this file was converted from and carries to the archive's three decimals of a voltage and two of an angle; a state saved with the data and not a solution of it, since it differs from the solution of the same data by up to 0.017 pu and 0.30 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.02 pu | largest difference 0.0173 pu (bus 30) over 118 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in case118.m (the final voltages and angles of the University of Washington archive's ieee118cdf.txt, which this file was converted from and carries to the archive's three decimals of a voltage and two of an angle; a state saved with the data and not a solution of it, since it differs from the solution of the same data by up to 0.017 pu and 0.30 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.35 deg | largest difference 0.303 deg (bus 1) over 118 buses | yes |
| Slack active power against the solution stored in the case file | a solution stored with the source | the solved state stored in case118.m (the final voltages and angles of the University of Washington archive's ieee118cdf.txt, which this file was converted from and carries to the archive's three decimals of a voltage and two of an angle; a state saved with the data and not a solution of it, since it differs from the solution of the same data by up to 0.017 pu and 0.30 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 3 MW | measured 513.863, expected 516.4, difference 2.54 MW | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for case118.m; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.38e-08 pu (bus 38) over 118 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for case118.m; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 9.48e-06 deg (bus 1) over 118 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for case118.m; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 132.863, expected 132.863, difference 0.00014 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES holds for case118.m; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 513.863, expected 513.863, difference 0.00014 MW | yes |

### ACTIVSg200 synthetic 200-bus test case (Illinois) { #activsg200 }

A synthetic 200-bus power system built to look like a transmission system of central Illinois, from the ARPA-E GRID DATA project of Texas A&M University, as MATPOWER 8.1 holds it (case_ACTIVSg200): 200 buses (134 at 115 kV, 17 at 230 kV and 49 generator terminals at 13.8 kV), 49 generators and 245 branches, with a load of 1,476 MW. A medium-size case for the power flow, and for how the diagram and the tables handle two hundred buses. It has no machine models, so there is no time-domain run; a version with dynamic models is Texas A&M's, and is not bundled.

- **Id:** `activsg200`
- **Kind:** Steady state
- **Size:** 200 buses, 49 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `case_ACTIVSg200.m`

**Source.** Bundled with TENSA as `case_ACTIVSg200.m` from <https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg200.m>, retrieved 2026-11-18. SHA-256 `579a07884b01e71a90a6ebf4cb28ef7c4a4f3f93032a9910de0f74903a54dd38`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, whose copyright the file's header states ("MATPOWER Copyright (c) 2017 by A.B. Birchfield, T. Xu, K.M. Gegner, K.S. Shetye, and T.J. Overbye Licensed under the Creative Commons Attribution 4.0 International license"), whose paper publications that use the data are asked to cite (above), and MATPOWER, which distributes the file (release 8.1, case_ACTIVSg200.m). The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header. Anyone who passes the file on gives this credit, the licence link and the same statement. The page of Texas A&M University for this case names no licence; the licence is the one the file's header states.

**Citations**

- **System:** A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, "Grid Structural Characteristics as Validation Criteria for Synthetic Networks," IEEE Transactions on Power Systems, vol. 32, no. 4, pp. 3258-3265, July 2017, doi:10.1109/TPWRS.2016.2616385. The paper the file's header asks that publications based on the data cite, which describes how the synthetic networks are made. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; its text was not read. [DOI](https://doi.org/10.1109/TPWRS.2016.2616385)
- **Data source:** ACTIVSg200: 200-bus synthetic grid, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/ (accessed 2026-11-18). The page says the case is entirely synthetic, built from public information and a statistical analysis of real power systems, that it bears no relation to the actual grid in its location, and that it is free for commercial or non-commercial use (it names no licence); it offers the case in the PowerWorld, MATPOWER, PSS/E RAW and PSLF formats with the files for its transient stability models, and asks users to cite the appropriate papers. [Link](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/)
- **Data source:** MATPOWER, data/case_ACTIVSg200.m, release 8.1 (commit 1a828c7af590), https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg200.m (accessed 2026-11-18). Its header says it was created from ACTIV_SG_200.pwb, saved by PowerWorld Simulator version 20 Beta, and then by MATPOWER 6, dated 16 May 2017, and states the authors' copyright of 2017 under the Creative Commons Attribution 4.0 International licence. The file of release 8.0 is the same. The git blob of the file at the tag is 7f707e91b414de417f25492f47ed81cee8e6c981, the one of the file TENSA bundles. [Link](https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg200.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@article{birchfield2017grid,
  author  = {Birchfield, Adam B. and Xu, Ti and Gegner, Kathleen M. and Shetye, Komal S. and Overbye, Thomas J.},
  title   = {Grid Structural Characteristics as Validation Criteria for Synthetic Networks},
  journal = {IEEE Transactions on Power Systems},
  volume  = {32},
  number  = {4},
  pages   = {3258--3265},
  year    = {2017},
  month   = jul,
  doi     = {10.1109/TPWRS.2016.2616385}
}
```

```bibtex
% Data source
@misc{tamu_activsg200,
  title        = {{ACTIVSg200}: 200-bus synthetic grid},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{matpower_case_activsg200,
  title        = {{MATPOWER} data/case\_ACTIVSg200.m},
  howpublished = {MATPOWER release 8.1},
  url          = {https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg200.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of MATPOWER 8.1 (and of 8.0), byte for byte and with its header comments

**Caveats**

- The system is synthetic. The header calls it an entirely synthetic 200-bus case, situated in the central part of Illinois, designed by algorithms to be statistically similar to actual transmission systems without modelling any actual line, and says it contains no critical energy infrastructure information; the Texas A&M page says it bears no relation to the actual grid in this location. It has 200 buses (115 and 230 kV, and 13.8 kV at the 49 generator buses), 49 generators (38 in service, all with a set-point of 1.04 pu), 245 branches rated from 7.4 to 740 MVA, four shunts of 30 to 80 MVAr, and a load of 1475.7 MW and 420.6 MVAr.
- The file stores a solved state, and it is a solution with the generators' reactive limits enforced (PowerWorld's): four generators (buses 67, 94, 114 and 167) are outside their limits in a power flow that does not enforce them, which is TENSA's default. The default power flow differs from the stored state by up to 0.0038 pu (bus 114, stored 1.0362 against the 1.04 set-point) and 0.031 degrees, and by 0.027 MW in the slack's power; with the limits enforced TENSA's power flow, and pandapower's, land on it to 1.4e-5 pu and 0.0009 degrees. The check of the default power flow against the stored state is therefore held to what that difference needs, 0.005 pu, 0.05 degrees and 0.05 MW, and the check with the limits enforced to 1e-4 pu, 0.005 degrees and 0.05 MW.
- After a power flow at the defaults the Violations table reads 4, the four generators outside their reactive limits (bus 114 above its maximum of 0.36 MVAr at 1.25, and buses 67, 94 and 167 below their minimum, by 0.33 to 0.61 MVAr), and warns of nothing else.
- The file is MATPOWER's, made from a PowerWorld case: it also holds the generators' cost data, the output of an optimal power flow (the lam and mu columns), bus names, and the fuel and type of each generator, none of which TENSA uses. It has no DC line. The case has no dynamic data, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis; Texas A&M offers the case with dynamic models, which TENSA does not bundle.
- The Texas A&M page for the case names no licence: it says the data is free for commercial or non-commercial use and asks users to cite the appropriate papers. The licence stated is the one in the header of the file as MATPOWER distributes it, CC BY 4.0.

**Verification.** The power flow agrees with two independent references. The first is the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved: bus voltages to 4.5e-8 pu, angles to 6.9e-6 degrees, and the losses (12.607 MW) and the slack's power (384.397 MW) to 6e-5 MW. The second is the solution PowerWorld stored in the file, which PowerWorld solved with the generators held to their reactive limits: TENSA's power flow at its defaults, which does not hold them, differs from it by up to 0.0038 pu, 0.031 degrees and 0.027 MW at the slack, at the buses of the four generators that are outside their limits without it, and with the limits enforced it lands on it to 1.4e-5 pu, 0.0009 degrees and 0.029 MW. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg200.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 4.49e-08 pu (bus 30) over 200 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg200.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 6.87e-06 deg (bus 182) over 200 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg200.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 12.607, expected 12.6069, difference 5.72e-05 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg200.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 384.397, expected 384.397, difference 5.72e-05 MW | yes |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in case_ACTIVSg200.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIV_SG_200 case, which this file was created from; a state solved with the generators held to their reactive limits, so it differs from a power flow without them by up to 0.0038 pu and 0.031 degrees, at the buses of the four generators that are outside their limits without it; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.005 pu | largest difference 0.0038 pu (bus 114) over 200 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in case_ACTIVSg200.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIV_SG_200 case, which this file was created from; a state solved with the generators held to their reactive limits, so it differs from a power flow without them by up to 0.0038 pu and 0.031 degrees, at the buses of the four generators that are outside their limits without it; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.05 deg | largest difference 0.031 deg (bus 114) over 200 buses | yes |
| Slack active power against the solution stored in the case file | a solution stored with the source | the solved state stored in case_ACTIVSg200.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIV_SG_200 case, which this file was created from; a state solved with the generators held to their reactive limits, so it differs from a power flow without them by up to 0.0038 pu and 0.031 degrees, at the buses of the four generators that are outside their limits without it; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.05 MW | measured 384.397, expected 384.37, difference 0.027 MW | yes |
| Bus voltage magnitudes against the solution stored in the case file, reactive limits enforced | a solution stored with the source | the solved state stored in case_ACTIVSg200.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIV_SG_200 case, which this file was created from; a state solved with the generators held to their reactive limits, which is how the power flow compared with it is run; TENSA did not compute it); written by scripts/crosscheck_pf.py stored --enforce-q-limits; the power flow compared with it is run with the reactive limits enforced | 0.0001 pu | largest difference 1.39e-05 pu (bus 114) over 200 buses | yes |
| Bus voltage angles against the solution stored in the case file, reactive limits enforced | a solution stored with the source | the solved state stored in case_ACTIVSg200.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIV_SG_200 case, which this file was created from; a state solved with the generators held to their reactive limits, which is how the power flow compared with it is run; TENSA did not compute it); written by scripts/crosscheck_pf.py stored --enforce-q-limits; the power flow compared with it is run with the reactive limits enforced | 0.005 deg | largest difference 0.000933 deg (bus 76) over 200 buses | yes |
| Slack active power against the solution stored in the case file, reactive limits enforced | a solution stored with the source | the solved state stored in case_ACTIVSg200.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIV_SG_200 case, which this file was created from; a state solved with the generators held to their reactive limits, which is how the power flow compared with it is run; TENSA did not compute it); written by scripts/crosscheck_pf.py stored --enforce-q-limits; the power flow compared with it is run with the reactive limits enforced | 0.05 MW | measured 384.399, expected 384.37, difference 0.0288 MW | yes |

### IEEE 300-bus test case { #ieee300 }

The IEEE 300-bus test case of the University of Washington archive as MATPOWER holds it (case300): 300 buses, 69 generators and 411 branches at thirteen voltage levels, a network and its loading only. The largest case of the gallery that is not synthetic, for the power flow and for how the diagram and the tables handle three hundred buses; it has no machine models, so there is no time-domain run.

- **Id:** `ieee300`
- **Kind:** Steady state
- **Size:** 300 buses, 69 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `case300.m`

**Source.** Copied from your own ANDES installation (`andes/cases/matpower/case300.m`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `2f79960409dccb9a47cb9de7c9c1173e6991875465f99b65b042d7c10197e12f`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/matpower/case300.m>, retrieved 2026-11-18.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES). The data is the archive's, which states no licence, and MATPOWER's licence notice says that its case files are not covered by its BSD license and have in most cases been included with permission or converted from data available from a public source. TENSA does not redistribute the file: it copies it from the user's own ANDES.

**Citations**

- **Data source:** 300 Bus Power Flow Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf300/pg_tca300bus.htm (accessed 2026-11-18). The page says the case was developed by the IEEE Test Systems Task Force under the direction of Mike Adibi in 1993, that the IEEE Common Data Format version was obtained from Fernando Alvarado at the University of Wisconsin, and that the PTI format version was provided by Joan Staron of PTI. The title line of the data file reads "13/05/91 CYME INTERNATIONAL 100.0 1991 S IEEE 300-BUS TEST SYSTEM". No publication that describes the data was found. [Link](https://labs.ece.uw.edu/pstca/pf300/pg_tca300bus.htm)
- **Data source:** MATPOWER, data/case300.m, release 8.0, https://github.com/MATPOWER/matpower/blob/8.0/data/case300.m (accessed 2026-11-18). Its header says it was converted from the archive's IEEE CDF file (ieee300cdf.txt) on 18 November 2014 by cdf2matp, and the warnings at its end list what the conversion did (the negative generator outputs treated as load, the limit it gave the slack generator). ANDES's copy of the file (andes/cases/matpower/case300.m) is byte for byte this one. [Link](https://github.com/MATPOWER/matpower/blob/8.0/data/case300.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for the library that distributes the case300 file. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_ieee300,
  title        = {300 Bus Power Flow Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf300/pg_tca300bus.htm},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{matpower_case300,
  title        = {{MATPOWER} data/case300.m},
  howpublished = {MATPOWER release 8.0},
  url          = {https://github.com/MATPOWER/matpower/blob/8.0/data/case300.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** None.

**Caveats**

- The system was developed by the IEEE Test Systems Task Force in 1993, the archive's page says, and no publication that describes its data was found, so there is no paper to cite for the system. The file carries no line ratings (all 411 are 0), so TENSA reports no loading for a line and the Violations table has no line limits to check.
- The file is not the archive's data in three respects, found by comparing it with the archive's ieee300cdf.txt (the loads at the other buses, the shunts, the base voltages and the resistance, reactance, charging and ratio of all 411 branches are equal). First, the seven buses where the archive lists a generator with a negative output (buses 8, 10, 20, 138, 9002, 9051 and 9053: -5, -5, -10, -192.5, -4.2, -35.81 and -26.48 MW) have that output as extra load here, 279 MW in all, and the generator kept at 0 MW, so the net injection of each bus is the archive's; the warnings at the end of the file say so. Second, the phase shifter between buses 196 and 2040, a branch of the archive's type 4 with a shift of -11.4 degrees, has no shift in the file. Third, the slack generator at bus 7049 has a reactive range of 0 to 10 MVAr, which the converter made because the archive's limits were equal, and a limit of 2399.01 MW.
- The voltages and angles the file carries are the archive's stored final state, and they are not a solution of the file's data, because of the lost phase shifter. TENSA's solution and pandapower's agree with each other to 1.6e-7 pu and 1.3e-4 degrees, and differ from the stored state by up to 0.0085 pu (bus 193) and 9.76 degrees (bus 2040), with 18 of the 300 voltages more than 1e-3 pu off and the median angle gap 0.026 degrees. A power flow of the data with the shifter put back (-11.4 degrees on 196-2040, solved by pandapower outside TENSA) lands on the stored state to 3.2e-4 pu and 0.042 degrees, which finds the cause, and a test repeats it. The file stores no output for the slack (0 MW), so there is no check of it. The check against the stored state has the tolerance that allows these gaps, 0.01 pu and 10 degrees, so it says only that TENSA is at the archive's operating point; the reference to hold TENSA to is pandapower's solution, to 1e-4 pu.
- ANDES's MATPOWER reader gives a bus whose base voltage is 0 a base of 110 kV. This file has no such bus (its 300 buses are at thirteen levels from 0.6 to 345 kV), so the rule does not apply to it.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis.
- A power flow, which does not enforce reactive limits unless asked to, leaves the Violations table at 21: 13 bus voltages (8 below the 0.94 pu minimum, the lowest 0.929 pu at buses 170 and 9033, and 5 above the 1.06 pu maximum, the highest 1.073 pu at bus 149) and 8 generators above their maximum reactive power (the slack at bus 7049 by 28.8 MVAr, which its converter-made limit explains, and seven others by 0.014 to 0.30 MVAr). Its diagram has 599 nodes and 710 connectors, and drawing it when the case first opens takes several seconds.

**Verification.** The power flow agrees with the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved (Newton-Raphson to 1e-8 MVA): bus voltages to 1.6e-7 pu, angles to 1.3e-4 degrees, and the losses (408.316 MW) and the slack's power (455.946 MW) to 2.5e-3 MW. It also agrees with the state the University of Washington archive stores with the data, within what that state allows: the state is not a solution of the file's data (see the caveats, which give the cause), and the largest differences are 0.0085 pu and 9.76 degrees. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in case300.m (the final voltages and angles of the University of Washington archive's ieee300cdf.txt, which this file was converted from; a state saved with the archive's data and not a solution of the file's, which lacks the archive's -11.4 degree phase shifter on branch 196-2040, so it differs from the solution of the file by up to 0.0085 pu and 9.76 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.01 pu | largest difference 0.00854 pu (bus 193) over 300 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in case300.m (the final voltages and angles of the University of Washington archive's ieee300cdf.txt, which this file was converted from; a state saved with the archive's data and not a solution of the file's, which lacks the archive's -11.4 degree phase shifter on branch 196-2040, so it differs from the solution of the file by up to 0.0085 pu and 9.76 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 10 deg | largest difference 9.76 deg (bus 2040) over 300 buses | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case300.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 1.61e-07 pu (bus 9033) over 300 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case300.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 0.00013 deg (bus 1201) over 300 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case300.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 408.318, expected 408.316, difference 0.00244 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case300.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 455.949, expected 455.946, difference 0.00244 MW | yes |

### PEGASE 1354-bus test case (part of the European transmission system) { #pegase1354 }

A medium part of the European high-voltage transmission system as the PEGASE project of the French operator RTE made it, in MATPOWER 8.1's case1354pegase: 1,354 buses at 380 and 220 kV, 260 generators and 1,991 branches (234 of them transformers), with a load of 73,060 MW. The data is fictitious: it is made to look like part of the European system and does not describe it. A large case for the power flow and for how the tables and exports work at over a thousand buses; its diagram is not drawn, which the caveats say why. It has no machine models, so there is no time-domain run.

- **Id:** `pegase1354`
- **Kind:** Steady state
- **Size:** 1354 buses, 260 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `case1354pegase.m`

**Source.** Bundled with TENSA as `case1354pegase.m` from <https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case1354pegase.m>, retrieved 2026-11-18. SHA-256 `1b08b25a2f6c1d540d090009dfaff41ff2b05784a2d8d302a7ad695821557b89`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: Cédric Josz, Stéphane Fliscounakis, Jean Maeght and Patrick Panciatici of Réseau de Transport d'Electricité (RTE), whose copyright the file's header states ("MATPOWER Copyright (c) 2015, 2016 by Cédric Josz, Stéphane Fliscounakis, Jean Maeght, and Patrick Panciatici Licensed under the Creative Commons Attribution 4.0 International license"), whose two papers (above) publications that use the data are asked to cite, and MATPOWER, which distributes the file (release 8.1, case1354pegase.m). The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header. Anyone who passes the file on gives this credit, the licence link and the same statement.

**Citations**

- **Data source:** C. Josz, S. Fliscounakis, J. Maeght and P. Panciatici, "AC Power Flow Data in MATPOWER and QCQP Format: iTesla, RTE Snapshots, and PEGASE," arXiv:1603.01533, March 2016. The paper the file's header asks that publications based on the data cite. Its abstract page was opened and gives the title, the authors and the dates; the abstract says the paper publishes nine MATPOWER test cases, the largest a pan-European fictitious data set from the PEGASE project, which complements the four PEGASE cases published in MATPOWER 5.1 in March 2015 (the cases of this entry). The text of the paper was not read. [Link](https://arxiv.org/abs/1603.01533)
- **System:** S. Fliscounakis, P. Panciatici, F. Capitanescu and L. Wehenkel, "Contingency ranking with respect to overloads in very large power systems taking into account uncertainty, preventive and corrective actions," IEEE Transactions on Power Systems, vol. 28, no. 4, pp. 4909-4917, November 2013, doi:10.1109/TPWRS.2013.2251015. The second paper the file's header asks that publications based on the data cite. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title, authors, volume and pages; its text is behind a paywall and was not read. [DOI](https://doi.org/10.1109/TPWRS.2013.2251015)
- **Data source:** MATPOWER, data/case1354pegase.m, release 8.1 (commit 1a828c7af590), https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case1354pegase.m (accessed 2026-11-18). Its header describes the data as a medium part of the European high voltage transmission network of 1,354 buses, 260 generators and 1,991 branches at 380 and 220 kV, says that the data are fictitious and do not correspond to real world data, that they stem from the PEGASE project (Pan European Grid Advanced Simulation and State Estimation) of the 7th Framework Program of the European Union, and states the copyright of 2015 and 2016 of its four authors under the Creative Commons Attribution 4.0 International licence. The address it gives for the project (www.fp7-pegase.com) did not resolve when checked. The git blob of the file at the commit is d6ede376f35af472b45b93ae771209c483427c26, the one of the file TENSA bundles. [Link](https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case1354pegase.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% Data source
@misc{josz2016acpf,
  author        = {Josz, C{\'e}dric and Fliscounakis, St{\'e}phane and Maeght, Jean and Panciatici, Patrick},
  title         = {{AC} Power Flow Data in {MATPOWER} and {QCQP} Format: i{T}esla, {RTE} Snapshots, and {PEGASE}},
  year          = {2016},
  eprint        = {1603.01533},
  archivePrefix = {arXiv}
}
```

```bibtex
% System
@article{fliscounakis2013contingency,
  author  = {Fliscounakis, St{\'e}phane and Panciatici, Patrick and Capitanescu, Florin and Wehenkel, Louis},
  title   = {Contingency ranking with respect to overloads in very large power systems taking into account uncertainty, preventive and corrective actions},
  journal = {IEEE Transactions on Power Systems},
  volume  = {28},
  number  = {4},
  pages   = {4909--4917},
  year    = {2013},
  month   = nov,
  doi     = {10.1109/TPWRS.2013.2251015}
}
```

```bibtex
% Data source
@misc{matpower_case1354pegase,
  title        = {{MATPOWER} data/case1354pegase.m},
  howpublished = {MATPOWER release 8.1},
  url          = {https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case1354pegase.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of MATPOWER 8.1, byte for byte and with its header comments

**Caveats**

- The data is fictitious. The header says it does not correspond to real world data and may be used to validate methods and tools, not for the operation and planning of the European grid. The network has 1,354 buses (1,113 at 220 kV and 241 at 380 kV), 260 generators in service (74,753 MW of output, the slack at bus 4231 holding 2,641.2 MW in the file and 2,611.6 MW after a power flow), 1,991 branches (234 of them transformers, all with a tap ratio), a load of 73,059.7 MW and 13,401.4 MVAr, and shunts at 1,082 buses.
- Parts of the network are aggregated, which the header says (its remark 4): 52 buses carry a negative load, 1,086.3 MW in all, and 67 generators a negative minimum output, where the data stands for loads and generators together. The header's remark 2 says the line charging of every branch is set to 0 and the shunts of PEGASE's lines are put on the buses, which leaves the power flow equations as the original's: all 1,991 branches have a charging of 0 in the file. Two generators (the slack at bus 4231 and the one at bus 8109) have reactive limits of plus and minus infinity, and seven buses a voltage range of 0.7 to 1.3 pu where the others have 0.9 to 1.1.
- Six branches (549-5002, 3069-6115, 7256-4491, 6153-58, 749-4324 and 7466-3649) have a phase shift (up to 0.087 degrees) and a tap ratio of 0, which MATPOWER reads as 1 and applies the shift for (its lib/makeYbus.m of the same release does both). ANDES 2.0.0's reader takes a branch with a ratio of 0 for a plain line and drops the shift (andes/io/matpower.py), so TENSA solves the network without them: the solution with them is up to 6.0e-5 pu and 0.087 degrees from TENSA's. The reference solution is pandapower's for the network as ANDES reads it, and says so in each check; a test shows that ANDES drops the six.
- 559 of the 1,991 branches have a rating of 0, which means no limit, and the Violations table does not check them; the 1,432 that have one (281 to 1,842 MVA) are 100 MVA below the current limits of the PEGASE data (the header's remark 1). After a power flow at the defaults the Violations table reads 29 violations and 60 warnings: 10 lines over their rating (up to 109.3%, line 1758-1923), 19 generators above their maximum reactive power (up to 368.7 MVAr against 37.1, the generator PV 3346), and, as warnings, 16 buses near the 1.1 pu maximum and 44 lines near their rating; a power flow does not enforce reactive limits unless asked to. With the limits enforced it reads 10 violations (the same lines) and 82 warnings, 25 of them generators at their maximum.
- The file stores a state, RTE's snapshot, and it is not a solution of the file's equations: at 21 buses the stored voltages and angles leave more than 0.1 MW unaccounted for (up to 1,300 MW at bus 58), 117 stored voltages are more than 1e-4 pu from pandapower's solution (up to 0.004 pu), 561 stored angles are more than 0.1 degrees from it (up to 5.5 degrees), and the stored power of the slack is 30 MW above what a power flow gives. The cause was not found. No check rests on the stored state.
- The case has no dynamic data: no machine, exciter or governor models, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis. The file also holds the cost data of the optimal power flow, which TENSA does not use.
- The diagram is not drawn when the case opens, because it has more than 400 buses, and there is no button to draw it, because the page would be busy for longer than the server keeps the session of a page that does not answer. The picture of a diagram is made again whenever something on it changes, and for this case one picture (3,369 nodes and 4,006 lines) takes 146 seconds in a measurement, where the 300-bus case takes under a second; in a headless browser on a fast desktop the nodes appeared 795 seconds after the diagram was asked for, and the page then showed that its session had expired (the server closes one after three minutes without a sign from the page, which a page that is busy cannot give) and began again. The case itself opens in seconds, with its tables, power flow and violations and their exports.

**Verification.** The power flow agrees with the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved, for the network as ANDES reads it (six phase shifts left out, see the caveats): bus voltages to 4.3e-7 pu, angles to 1.3e-4 degrees, and the losses (1663.6 MW) and the slack's power (2611.6 MW) to 0.02 MW. That is the independent reference there is: the state the file stores is not a solution of its equations (see the caveats), so no check rests on it, and no published solution of the file was found. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case1354pegase.m, read by matpowercaseframes, with the phase shift of 6 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 6e-05 pu in a bus voltage and 0.087 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 4.26e-07 pu (bus 747) over 1354 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case1354pegase.m, read by matpowercaseframes, with the phase shift of 6 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 6e-05 pu in a bus voltage and 0.087 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 0.000133 deg (bus 8748) over 1354 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case1354pegase.m, read by matpowercaseframes, with the phase shift of 6 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 6e-05 pu in a bus voltage and 0.087 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 1663.61, expected 1663.6, difference 0.0187 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case1354pegase.m, read by matpowercaseframes, with the phase shift of 6 branches that have a ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies them, and the solution with them differs from this one by at most 6e-05 pu in a bus voltage and 0.087 degrees in a bus angle); written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 2611.58, expected 2611.57, difference 0.0187 MW | yes |

### ACTIVSg2000 synthetic 2000-bus test case (Texas) { #activsg2000 }

A synthetic 2,000-bus power system built to look like a transmission system on the footprint of Texas, from the ARPA-E GRID DATA project of Texas A&M University, as MATPOWER 8.1 holds it (case_ACTIVSg2000): 2,000 buses at 500, 230, 161 and 115 kV and at generator voltages, 544 generators and 3,206 branches, with a load of 67,109 MW. The largest case of the gallery: a case for the power flow, and for how the tables and exports handle two thousand buses; its diagram is not drawn, which the caveats say why. It has no machine models, so there is no time-domain run; a version with dynamic models is Texas A&M's, and is not bundled.

- **Id:** `activsg2000`
- **Kind:** Steady state
- **Size:** 2000 buses, 544 generators
- **Analyses:** Power flow
- **First run:** no
- **File:** `case_ACTIVSg2000.m`

**Source.** Bundled with TENSA as `case_ACTIVSg2000.m` from <https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg2000.m>, retrieved 2026-11-18. SHA-256 `8d00618de8fd10bf35a599f59d2deebfecd0d86e28fcff73219ad7c4ebab860b`.

**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, whose copyright the file's header states ("MATPOWER Copyright (c) 2017-2018 by A.B. Birchfield, T. Xu, K.M. Gegner, K.S. Shetye, and T.J. Overbye Licensed under the Creative Commons Attribution 4.0 International license"), whose paper publications that use the data are asked to cite (above), and MATPOWER, which distributes the file (release 8.1, case_ACTIVSg2000.m). The licence is at the link above. TENSA made no change: the file is bundled byte for byte, with its header. Anyone who passes the file on gives this credit, the licence link and the same statement. The page of Texas A&M University for this case names no licence; the licence is the one the file's header states.

**Citations**

- **System:** A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, "Grid Structural Characteristics as Validation Criteria for Synthetic Networks," IEEE Transactions on Power Systems, vol. 32, no. 4, pp. 3258-3265, July 2017, doi:10.1109/TPWRS.2016.2616385. The paper the file's header asks that publications based on the data cite, which describes how the synthetic networks are made. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; its text was not read. [DOI](https://doi.org/10.1109/TPWRS.2016.2616385)
- **Data source:** ACTIVSg2000: 2000-bus synthetic grid on footprint of Texas, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/ (accessed 2026-11-18). The page says the case is entirely synthetic, built from public information and a statistical analysis of real power systems, that it bears no relation to the actual grid in its location except that generation and load profiles are similar, and that Texas A&M University researchers provide it free for commercial or non-commercial use (it names no licence). It offers the case in PowerWorld, MATPOWER, PSS/E RAW and PSLF formats, with parameters for transient stability and geomagnetic disturbance studies, and asks users to cite the appropriate papers, which the repository's references page (https://electricgrids.engr.tamu.edu/references/) lists, naming Birchfield et al. 2017 for the algorithms that created the case. [Link](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/)
- **Data source:** MATPOWER, data/case_ACTIVSg2000.m, release 8.1 (commit 1a828c7af590), https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg2000.m (accessed 2026-11-18). Its header says it was created from ACTIVSg2000_AUG-09-2018.pwb, saved by PowerWorld Simulator version 21 (build date August 30, 2018), then by MATPOWER 6, dated August 9, 2018, and states the authors' copyright of 2017 to 2018 under the Creative Commons Attribution 4.0 International licence. The git blob of the file at the commit is 26c5add5b09e3d24d16cef254932ac385a37ebcc, the one of the file TENSA bundles. [Link](https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg2000.m)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, whose case format the file is written in. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
% System
@article{birchfield2017grid,
  author  = {Birchfield, Adam B. and Xu, Ti and Gegner, Kathleen M. and Shetye, Komal S. and Overbye, Thomas J.},
  title   = {Grid Structural Characteristics as Validation Criteria for Synthetic Networks},
  journal = {IEEE Transactions on Power Systems},
  volume  = {32},
  number  = {4},
  pages   = {3258--3265},
  year    = {2017},
  month   = jul,
  doi     = {10.1109/TPWRS.2016.2616385}
}
```

```bibtex
% Data source
@misc{tamu_activsg2000,
  title        = {{ACTIVSg2000}: 2000-bus synthetic grid on footprint of Texas},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{matpower_case_activsg2000,
  title        = {{MATPOWER} data/case\_ACTIVSg2000.m},
  howpublished = {MATPOWER release 8.1},
  url          = {https://github.com/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg2000.m},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  month   = mar,
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

**Changes to the data.** TENSA changed nothing: the file is the one of MATPOWER 8.1, byte for byte and with its header comments

**Caveats**

- The system is synthetic. The header calls it an entirely synthetic 2000-bus case, geographically situated in the US state of Texas, designed with a 500, 230, 161 and 115 kV transmission network by algorithms to be statistically similar to actual transmission system models without modelling any actual lines, and says it contains no critical energy infrastructure information; the Texas A&M page says it bears no relation to the actual grid except that generation and load profiles are similar. It has 2,000 buses (120 at 500 kV, 152 at 230 kV, 453 at 161 kV, 826 at 115 kV and 449 at generator voltages of 13.2 to 24 kV), 544 generators (432 in service, 68,724.7 MW of output, all with a set-point of 0.99 to 1.04 pu), 3,206 branches (847 between buses of different base voltages, which TENSA draws as transformers) rated from 19 to 4,352 MVA, shunts at 149 buses, a load of 67,109.2 MW and 19,014.3 MVAr, and 8 areas.
- The file stores a state, and it is a solution of the file's equations: PowerWorld's, at which no bus is left more than 0.06 MW unaccounted for, and 153 of the 392 generator buses are at a reactive limit. A power flow that does not hold the limits, which is TENSA's default, differs from it by up to 0.035 pu (bus 4195) and 0.64 degrees (bus 3137), and the slack's power by 16.2 MW (1,252.3 MW against the 1,236.1 the file stores); one that enforces them differs by up to 0.031 pu (bus 1070) and 0.89 degrees (bus 2059), and by 3.5 MW, because the set of generators it holds at a limit is not PowerWorld's. Unlike the 200-bus case, no power flow of TENSA lands on the stored state. The checks against it are held to those gaps rounded up (0.04 pu, 0.7 degrees and 17 MW at the defaults; 0.035 pu, 1 degree and 4 MW with the limits enforced), so they catch only a gross error; the check that means something is the solver's.
- After a power flow at the defaults the Violations table reads 197 violations and 26 warnings: 103 generators above their maximum reactive power and 94 below their minimum (up to 848 MVAr against a maximum of 51.3, the generator PV 3048), and 26 lines near their rating; no line is over its rating and no bus is outside its voltage limits. A power flow does not enforce reactive limits unless asked to, and these generators are far past theirs (the case sets one voltage for each of its generator buses and the generators take up whatever the network needs). With the limits enforced it reads no violation and 235 warnings: 111 generators at their maximum, 101 at their minimum and 23 lines near their rating.
- The file is MATPOWER's, made from a PowerWorld case: it also holds the generators' cost data, the type and fuel of each generator and bus names, none of which TENSA uses except the names. It has no DC line. The case has no dynamic data, so TENSA offers a power flow and nothing in the time domain or the eigenvalue analysis; Texas A&M offers the case with dynamic models, which TENSA does not bundle.
- The Texas A&M page for the case names no licence: it says the data is free for commercial or non-commercial use and asks users to cite the appropriate papers. The licence stated is the one in the header of the file as MATPOWER distributes it, CC BY 4.0.
- The diagram is not drawn when the case opens, and there is no button to draw it, as for the 1,354-bus case: one picture of it (3,818 nodes and 5,024 lines) takes 48 seconds in a measurement, and in a headless browser on a fast desktop the nodes appeared 303 seconds after the diagram was asked for, after which the page showed that its session had expired and began again. The case itself opens, and its tables, power flow, violations and their exports work without it.

**Verification.** The power flow agrees with the solution pandapower 3.5.6 finds for the same file, which it reads from the .m with no ANDES involved: bus voltages to 3.5e-7 pu, angles to 6.2e-4 degrees, and the losses (1631.7 MW) and the slack's power (1252.2 MW) to 0.02 MW. The file also stores PowerWorld's solution, which is a solution of the file's equations with 153 of its 392 generator buses at a reactive limit, a set that TENSA's own enforcement of the limits does not reach: TENSA's power flow is up to 0.035 pu and 0.64 degrees from it at the defaults, and up to 0.031 pu and 0.89 degrees with the limits enforced. The checks against the stored state are held to those gaps, rounded up, so they catch only a gross error, and nothing in the entry rests on them. The case has no time-domain run, so nothing in it is a regression baseline and nothing rests on TENSA's own earlier output.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against the solution stored in the case file, reactive limits enforced | a solution stored with the source | the solved state stored in case_ACTIVSg2000.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIVSg2000 case, which this file was created from; a state solved with 153 of the 392 generator buses at a reactive limit, where a power flow of TENSA with the limits enforced ends with another set, so it differs from it by up to 0.031 pu and 0.89 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored --enforce-q-limits; the power flow compared with it is run with the reactive limits enforced | 0.035 pu | largest difference 0.0308 pu (bus 1070) over 2000 buses | yes |
| Bus voltage angles against the solution stored in the case file, reactive limits enforced | a solution stored with the source | the solved state stored in case_ACTIVSg2000.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIVSg2000 case, which this file was created from; a state solved with 153 of the 392 generator buses at a reactive limit, where a power flow of TENSA with the limits enforced ends with another set, so it differs from it by up to 0.031 pu and 0.89 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored --enforce-q-limits; the power flow compared with it is run with the reactive limits enforced | 1 deg | largest difference 0.885 deg (bus 2059) over 2000 buses | yes |
| Slack active power against the solution stored in the case file, reactive limits enforced | a solution stored with the source | the solved state stored in case_ACTIVSg2000.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIVSg2000 case, which this file was created from; a state solved with 153 of the 392 generator buses at a reactive limit, where a power flow of TENSA with the limits enforced ends with another set, so it differs from it by up to 0.031 pu and 0.89 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored --enforce-q-limits; the power flow compared with it is run with the reactive limits enforced | 4 MW | measured 1232.61, expected 1236.1, difference 3.49 MW | yes |
| Bus voltage magnitudes against the solution stored in the case file | a solution stored with the source | the solved state stored in case_ACTIVSg2000.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIVSg2000 case, which this file was created from; a state solved with 153 of the 392 generator buses at a reactive limit, not the set a power flow of TENSA holds there, so it differs from a power flow without the limits by up to 0.035 pu and 0.64 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.04 pu | largest difference 0.0352 pu (bus 4195) over 2000 buses | yes |
| Bus voltage angles against the solution stored in the case file | a solution stored with the source | the solved state stored in case_ACTIVSg2000.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIVSg2000 case, which this file was created from; a state solved with 153 of the 392 generator buses at a reactive limit, not the set a power flow of TENSA holds there, so it differs from a power flow without the limits by up to 0.035 pu and 0.64 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 0.7 deg | largest difference 0.639 deg (bus 3137) over 2000 buses | yes |
| Slack active power against the solution stored in the case file | a solution stored with the source | the solved state stored in case_ACTIVSg2000.m (the final voltages and angles of PowerWorld Simulator's solution of the original ACTIVSg2000 case, which this file was created from; a state solved with 153 of the 392 generator buses at a reactive limit, not the set a power flow of TENSA holds there, so it differs from a power flow without the limits by up to 0.035 pu and 0.64 degrees; TENSA did not compute it); written by scripts/crosscheck_pf.py stored | 17 MW | measured 1252.25, expected 1236.1, difference 16.2 MW | yes |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg2000.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.0001 pu | largest difference 3.46e-07 pu (bus 5184) over 2000 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg2000.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 deg | largest difference 0.000617 deg (bus 5139) over 2000 buses | yes |
| Network losses against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg2000.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 1631.68, expected 1631.66, difference 0.02 MW | yes |
| Slack active power against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on case_ACTIVSg2000.m, read by matpowercaseframes; written by scripts/crosscheck_pf.py | 0.01 + 0.001 of the value MW | measured 1252.25, expected 1252.23, difference 0.02 MW | yes |

### ACTIVSg200 with dynamic data (Texas A&M), 200 buses { #activsg200_dyn }

The 200-bus synthetic Illinois grid of the Electric Grid Test Case Repository of Texas A&M University, with the PSS/E data of its transient stability models (a RAW and a DYR file). TENSA holds no file of it, and its dynamic data was not tried: the repository gives the files only after a form that asks for an email address, which TENSA does not fill in. The network alone is in this catalog as ACTIVSg200, from MATPOWER.

- **Id:** `activsg200_dyn`
- **Kind:** Dynamic
- **Size:** 200 buses, 49 generators
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [Texas A&M University: free for commercial or non-commercial use (no licence named)](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/). The page says the dataset is provided free for commercial or non-commercial use and encourages users to fill in its feedback form and to cite the appropriate papers: its references page asks for the paper of the algorithms (Birchfield et al. 2017) and, for the dynamic models, the two papers of Xu et al. above. It does not say whether the files may be passed on, so TENSA bundles none.

**Citations**

- **Data source:** ACTIVSg200: 200-bus synthetic grid, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/ (accessed 2026-11-18). The page says the case is entirely synthetic, built from public information and a statistical analysis of real power systems, that it bears no relation to the actual grid in its location, and that it is free for commercial or non-commercial use (it names no licence); it offers the case in the PowerWorld, MATPOWER, PSS/E RAW and PSLF formats with the files for its transient stability models, and asks users to cite the appropriate papers. [Link](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/)
- **System:** A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, "Grid Structural Characteristics as Validation Criteria for Synthetic Networks," IEEE Transactions on Power Systems, vol. 32, no. 4, pp. 3258-3265, July 2017, doi:10.1109/TPWRS.2016.2616385. The paper the file's header asks that publications based on the data cite, which describes how the synthetic networks are made. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; its text was not read. [DOI](https://doi.org/10.1109/TPWRS.2016.2616385)
- **System:** T. Xu, A. B. Birchfield and T. J. Overbye, "Modeling, Tuning, and Validating System Dynamics in Synthetic Electric Grids," IEEE Transactions on Power Systems, vol. 33, no. 6, pp. 6501-6509, November 2018, doi:10.1109/TPWRS.2018.2823702. Reference [10] of the repository's page, which asks that users of the dynamic models cite it. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; the copy on the authors' group site was opened and its abstract read, which says the paper assigns and tunes generator models and builds the dynamics of a 2000-bus synthetic case as its example. [DOI](https://doi.org/10.1109/TPWRS.2018.2823702)
- **System:** T. Xu, A. B. Birchfield, K. S. Shetye and T. J. Overbye, "Creation of Synthetic Electric Grid Models for Transient Stability Studies," 2017 IREP Symposium on Bulk Power System Dynamics and Control, Espinho, Portugal, 2017. Reference [5] of the repository's page, which asks that users of the dynamic models cite it. The copy on the authors' group site (https://overbye.engr.tamu.edu/wp-content/uploads/sites/146/2022/01/IREP_Ti_WithFooter.pdf) was opened and its abstract read: it extends the synthetic base models with generator models and a tuning process, and builds the dynamic cases of two synthetic networks. [Link](https://overbye.engr.tamu.edu/wp-content/uploads/sites/146/2022/01/IREP_Ti_WithFooter.pdf)
- **Data source:** References, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/references/ (accessed 2026-11-18). The page lists the papers of the synthetic cases and says which to cite: [1], Birchfield et al. 2017, for the algorithms that create the cases, and [5] and [10], Xu et al., for the generator dynamic models. [Link](https://electricgrids.engr.tamu.edu/references/)

BibTeX:

```bibtex
% Data source
@misc{tamu_activsg200,
  title        = {{ACTIVSg200}: 200-bus synthetic grid},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/},
  urldate      = {2026-11-18}
}
```

```bibtex
% System
@article{birchfield2017grid,
  author  = {Birchfield, Adam B. and Xu, Ti and Gegner, Kathleen M. and Shetye, Komal S. and Overbye, Thomas J.},
  title   = {Grid Structural Characteristics as Validation Criteria for Synthetic Networks},
  journal = {IEEE Transactions on Power Systems},
  volume  = {32},
  number  = {4},
  pages   = {3258--3265},
  year    = {2017},
  month   = jul,
  doi     = {10.1109/TPWRS.2016.2616385}
}
```

```bibtex
% System
@article{xu2018modeling,
  author  = {Xu, Ti and Birchfield, Adam B. and Overbye, Thomas J.},
  title   = {Modeling, Tuning, and Validating System Dynamics in Synthetic Electric Grids},
  journal = {IEEE Transactions on Power Systems},
  volume  = {33},
  number  = {6},
  pages   = {6501--6509},
  year    = {2018},
  month   = nov,
  doi     = {10.1109/TPWRS.2018.2823702}
}
```

```bibtex
% System
@inproceedings{xu2017creation,
  author    = {Xu, Ti and Birchfield, Adam B. and Shetye, Komal S. and Overbye, Thomas J.},
  title     = {Creation of Synthetic Electric Grid Models for Transient Stability Studies},
  booktitle = {2017 IREP Symposium on Bulk Power System Dynamics and Control},
  address   = {Espinho, Portugal},
  year      = {2017},
  url       = {https://overbye.engr.tamu.edu/wp-content/uploads/sites/146/2022/01/IREP_Ti_WithFooter.pdf}
}
```

```bibtex
% Data source
@misc{tamu_references,
  title        = {References},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/references/},
  urldate      = {2026-11-18}
}
```

**Links**

- [ACTIVSg200 on the Texas A&M repository](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg200/): The download is at the foot of the page, behind a form that asks for an email address.
- [References of the repository](https://electricgrids.engr.tamu.edu/references/): Says which papers to cite for the cases and for their dynamic models.

**Changes to the data.** None.

**Caveats**

- Nothing of this dataset was downloaded or run. The page of the repository gives the files after a form with an email address, a name and an organisation, which TENSA's checks do not submit; so what its DYR file holds, and what ANDES does with it, are not known here. The ACTIVSg2000 dynamic data of the same authors was tried (see that entry) and is the nearest evidence.
- What ANDES does with a PSS/E dynamic file, from the table of the installed ANDES 2.0.0: it reads GENROU, GENCLS, the exciters, governors and stabilisers it has as the models of the same name, reads GENSAL as GENROU and GGOV1 as TGOV1 and ESAC6A, SCRX and EXPIC1 as SEXS (approximations: the data of one model is given to another with fewer parts), and when a machine model is missing (GENROE and GENSAE are) it refuses the whole dynamic file.
- The system is synthetic. The page says it bears no relation to the actual grid in its location, except that generation and load profiles are similar.
- The size is that of the MATPOWER file of the same network in this catalog (ACTIVSg200: 200 buses, 49 generators).

**Verification.** Nothing was run: the dynamic files are behind a form (see the caveats), so there is no result to report and nothing is marked verified.

### ACTIVSg2000 with dynamic data (Texas A&M), 2000 buses { #activsg2000_dyn }

The 2000-bus synthetic grid on the footprint of Texas of the Texas A&M repository, with the PSS/E data of its transient stability models: 544 generators with 435 machine models, and their exciters, governors and stabilisers. TENSA holds no file of it. Tried on copies from another repository: ANDES reads all 16 models of the dynamic data (5 of them as other models), the power flow agrees with pandapower to 3.5e-7 pu, and the 10 s run does not start. The network alone is in this catalog as ACTIVSg2000, from MATPOWER.

- **Id:** `activsg2000_dyn`
- **Kind:** Dynamic
- **Size:** 2000 buses, 544 generators
- **Analyses:** Power flow

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [Texas A&M University: free for commercial or non-commercial use (no licence named)](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/). The page says the dataset is provided free for commercial or non-commercial use and encourages users to fill in its feedback form and to cite the appropriate papers: its references page asks for the paper of the algorithms (Birchfield et al. 2017) and, for the dynamic models, the two papers of Xu et al. above. It does not say whether the files may be passed on, so TENSA bundles none. The copies tested are in a repository that states no licence at all.

**Citations**

- **Data source:** ACTIVSg2000: 2000-bus synthetic grid on footprint of Texas, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/ (accessed 2026-11-18). The page says the case is entirely synthetic, built from public information and a statistical analysis of real power systems, that it bears no relation to the actual grid in its location except that generation and load profiles are similar, and that Texas A&M University researchers provide it free for commercial or non-commercial use (it names no licence). It offers the case in PowerWorld, MATPOWER, PSS/E RAW and PSLF formats, with parameters for transient stability and geomagnetic disturbance studies, and asks users to cite the appropriate papers, which the repository's references page (https://electricgrids.engr.tamu.edu/references/) lists, naming Birchfield et al. 2017 for the algorithms that created the case. [Link](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/)
- **System:** A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, "Grid Structural Characteristics as Validation Criteria for Synthetic Networks," IEEE Transactions on Power Systems, vol. 32, no. 4, pp. 3258-3265, July 2017, doi:10.1109/TPWRS.2016.2616385. The paper the file's header asks that publications based on the data cite, which describes how the synthetic networks are made. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; its text was not read. [DOI](https://doi.org/10.1109/TPWRS.2016.2616385)
- **System:** T. Xu, A. B. Birchfield and T. J. Overbye, "Modeling, Tuning, and Validating System Dynamics in Synthetic Electric Grids," IEEE Transactions on Power Systems, vol. 33, no. 6, pp. 6501-6509, November 2018, doi:10.1109/TPWRS.2018.2823702. Reference [10] of the repository's page, which asks that users of the dynamic models cite it. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; the copy on the authors' group site was opened and its abstract read, which says the paper assigns and tunes generator models and builds the dynamics of a 2000-bus synthetic case as its example. [DOI](https://doi.org/10.1109/TPWRS.2018.2823702)
- **System:** T. Xu, A. B. Birchfield, K. S. Shetye and T. J. Overbye, "Creation of Synthetic Electric Grid Models for Transient Stability Studies," 2017 IREP Symposium on Bulk Power System Dynamics and Control, Espinho, Portugal, 2017. Reference [5] of the repository's page, which asks that users of the dynamic models cite it. The copy on the authors' group site (https://overbye.engr.tamu.edu/wp-content/uploads/sites/146/2022/01/IREP_Ti_WithFooter.pdf) was opened and its abstract read: it extends the synthetic base models with generator models and a tuning process, and builds the dynamic cases of two synthetic networks. [Link](https://overbye.engr.tamu.edu/wp-content/uploads/sites/146/2022/01/IREP_Ti_WithFooter.pdf)
- **Data source:** References, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/references/ (accessed 2026-11-18). The page lists the papers of the synthetic cases and says which to cite: [1], Birchfield et al. 2017, for the algorithms that create the cases, and [5] and [10], Xu et al., for the generator dynamic models. [Link](https://electricgrids.engr.tamu.edu/references/)
- **Data source:** PowerSystemsTestData, Sienna platform, https://github.com/Sienna-Platform/PowerSystemsTestData (commit a2ecae9ff3cf, accessed 2026-11-18; the repository was NREL-Sienna/PowerSystemsTestData, which now redirects). A data repository of the Sienna software that holds copies of the reduced WECC and ACTIVSg2000 files; its README names no source for them and the repository states no licence. [Link](https://github.com/Sienna-Platform/PowerSystemsTestData)

BibTeX:

```bibtex
% Data source
@misc{tamu_activsg2000,
  title        = {{ACTIVSg2000}: 2000-bus synthetic grid on footprint of Texas},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/},
  urldate      = {2026-11-18}
}
```

```bibtex
% System
@article{birchfield2017grid,
  author  = {Birchfield, Adam B. and Xu, Ti and Gegner, Kathleen M. and Shetye, Komal S. and Overbye, Thomas J.},
  title   = {Grid Structural Characteristics as Validation Criteria for Synthetic Networks},
  journal = {IEEE Transactions on Power Systems},
  volume  = {32},
  number  = {4},
  pages   = {3258--3265},
  year    = {2017},
  month   = jul,
  doi     = {10.1109/TPWRS.2016.2616385}
}
```

```bibtex
% System
@article{xu2018modeling,
  author  = {Xu, Ti and Birchfield, Adam B. and Overbye, Thomas J.},
  title   = {Modeling, Tuning, and Validating System Dynamics in Synthetic Electric Grids},
  journal = {IEEE Transactions on Power Systems},
  volume  = {33},
  number  = {6},
  pages   = {6501--6509},
  year    = {2018},
  month   = nov,
  doi     = {10.1109/TPWRS.2018.2823702}
}
```

```bibtex
% System
@inproceedings{xu2017creation,
  author    = {Xu, Ti and Birchfield, Adam B. and Shetye, Komal S. and Overbye, Thomas J.},
  title     = {Creation of Synthetic Electric Grid Models for Transient Stability Studies},
  booktitle = {2017 IREP Symposium on Bulk Power System Dynamics and Control},
  address   = {Espinho, Portugal},
  year      = {2017},
  url       = {https://overbye.engr.tamu.edu/wp-content/uploads/sites/146/2022/01/IREP_Ti_WithFooter.pdf}
}
```

```bibtex
% Data source
@misc{tamu_references,
  title        = {References},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/references/},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{sienna_powersystemstestdata,
  title        = {{PowerSystemsTestData}},
  author       = {{Sienna platform}},
  howpublished = {GitHub repository},
  url          = {https://github.com/Sienna-Platform/PowerSystemsTestData},
  note         = {commit a2ecae9ff3cf},
  urldate      = {2026-11-18}
}
```

**Links**

- [ACTIVSg2000 on the Texas A&M repository](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/): The download is at the foot of the page, behind a form that asks for an email address.
- [References of the repository](https://electricgrids.engr.tamu.edu/references/): Says which papers to cite for the cases and for their dynamic models.
- [ACTIVSg2000.RAW in the Sienna test data repository](https://github.com/Sienna-Platform/PowerSystemsTestData/blob/a2ecae9ff3cfe6d219744f1b10e4edd4eeecabc9/ACTIVSg2000/ACTIVSg2000.RAW): A copy, pinned to a commit; no licence is stated there.
- [ACTIVSg2000_dynamics.dyr in the Sienna test data repository](https://github.com/Sienna-Platform/PowerSystemsTestData/blob/a2ecae9ff3cfe6d219744f1b10e4edd4eeecabc9/psse_dyr/ACTIVSg2000_dynamics.dyr): A copy, pinned to a commit; no licence is stated there.

**Changes to the data.** None.

**Caveats**

- Where the files come from. The page of the repository gives them only after a form that asks for an email address, a name and an organisation, which TENSA's checks do not submit. The files tried are the copies in the Sienna test data repository (commit a2ecae9ff3cf, whose README calls the folder the TAMU power flow dataset for ERCOT; it names no source and states no licence): ACTIVSg2000/ACTIVSg2000.RAW (SHA-256 d7191f8d9ba1bc7ce8247a060fc6e12bcb0dc5b7ba4f7e6cf68c7233f7a13cea) and psse_dyr/ACTIVSg2000_dynamics.dyr (05a6c833eac0b2a2c8f7925c0a022a28733ab43ec40a7dd80107d20c291c550d). They may differ from what the repository gives today.
- The RAW file is not the data of the MATPOWER file of the gallery: its header is dated 14 February 2018, and the losses of its power flow are 1628.7 MW where the MATPOWER file's are 1631.7 MW (both by pandapower).
- What loads. The dynamic data has 1,739 records of 16 PSS/E models: IEEEST 434, GENROU 410, GGOV1 367, ESST4B 278, EXPIC1 61, IEEEG1 43, EXAC2 38, GENSAL 25, HYGOV 25, IEEET1 23, ESDC1A 12, ESAC6A 7, EXAC1 6, SCRX 5, ESAC1A 4 and ESDC2A 1. ANDES reads every model: 1,274 records as the model of the same name, and 465 as another model, an approximation: GGOV1 (367) as TGOV1, EXPIC1 (61), ESAC6A (7) and SCRX (5) as SEXS, and GENSAL (25) as GENROU. Nothing is dropped. ANDES corrects a parameter of four ESAC1A exciters (TA to 0.04 and TF to 1) and warns of it.
- The 10 s run does not start. With the dynamic data the power flow converges (3 iterations), and the run then stops in ANDES's initialisation with an IndexError ("boolean index did not match indexed array") in andes/core/discrete.py, in the code that reports the limits it adjusted: it is raised for the anti-windup limiter LA_lim of the 12 ESDC1A exciters. TENSA answers the request with a 422. It was reproduced with ANDES alone (TDS.run) and not worked round here, so no time-domain or eigenvalue result exists for this data.
- The power flow starts from a state the file stores that it does not reproduce: 0.040 pu and 0.51 degrees from it (0.017 pu and 0.68 degrees with reactive limits enforced). The MATPOWER version of this system shows the same kind of gap (0.035 pu and 0.64 degrees), which its entry explains by the 153 generator buses held at a reactive limit in the stored solution; that this file has the same cause was not checked. pandapower agrees with TENSA to 3.5e-7 pu, so the gap is not a fault of TENSA's solver.
- The system is synthetic. The page says it bears no relation to the actual grid in its location, except that generation and load profiles are similar, based on public data.

**Verification.** Tried on 2026-11-18 with scripts/check_external_datasets.py (trial activsg2000-dyn), through the HTTP API of a real server. Compared with an independent solver: the power flow (bus voltages, angles, losses and the slack's power) agrees with pandapower's solution of the network ANDES reads from the RAW file. Not matched: the file's stored state, which no power flow of ANDES reproduces (see the caveats), so that check is recorded as failed. Not verified: the time-domain run and the eigenvalues, which do not exist because ANDES cannot initialise the case.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES reads from ACTIVSg2000.RAW of the Sienna copy, written out by scripts/crosscheck_pf.py, which refuses a network ANDES solves differently; run by scripts/check_external_datasets.py | 0.0001 pu | largest difference 3.48e-07 pu (bus 5184) over 2000 buses | yes |
| Bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, as above | 0.01 deg | largest difference 0.00062 deg (bus 5139) over 2000 buses | yes |
| Network losses and the slack's power against pandapower | an independent solver | pandapower 3.5.6, as above | 0.01 + 0.001 of the value MW | losses differ by 0.0200 MW and the slack's power by 0.0200 MW | yes |
| Bus voltage magnitudes against the solution stored in the file | a solution stored with the source | the voltages in the bus records of ACTIVSg2000.RAW (the Sienna copy), as ANDES reads them, before any power flow | 0.01 pu (a sanity bound: the state is another program's solution, to the digits it kept) | largest difference 0.0397 pu (bus 6085) over 2000 buses; outside the bound | no |
| Bus voltage angles against the solution stored in the file | a solution stored with the source | the angles in the bus records of ACTIVSg2000.RAW (the Sienna copy), as ANDES reads them, before any power flow | 0.5 deg | largest difference 0.509 deg (bus 3137) over 2000 buses; outside the bound | no |

### Reduced 240-bus WECC with renewables (NLR), 243 buses { #wecc240 }

The reduced Western Interconnection model of the National Laboratory of the Rockies (NLR, formerly NREL): a 2018 summer peak with 243 buses, 146 generating units at 56 plants (109 synchronous machines and 37 renewable plants) and dynamic models, as PSS/E files. TENSA holds no file of it. Tried on its download: the network and its dynamic data open, all nine models of the data are read as themselves, and the power flow converges, but ANDES's initialisation test fails on the renewable controls, and the 10 s run, which ANDES carries on to its end, is reported failed.

- **Id:** `wecc240`
- **Kind:** Dynamic
- **Size:** 243 buses, 146 generators
- **Analyses:** Power flow

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [NREL disclaimer (as in the NLR download)](https://www.nlr.gov/grid/test-case-repository.html). The disclaimer in the download (NREL Disclaimer.txt, SHA-256 90fa4bd727bf945a5d72543f4e1b646d90543325015fe8942a4b40594e2c69a7) grants the right, without any fee, to use or copy the data provided that its entire notice appears in all copies, and asks users to credit DOE/NREL/ALLIANCE in any publication that results from its use; the names DOE, NREL and ALLIANCE may not be used to endorse or promote any product or commercial entity without written permission. It does not say that the data may be distributed, so TENSA bundles none. The copies in the Sienna test data repository state no licence at all.

**Citations**

- **System:** H. Yuan, R. S. Biswas, J. Tan and Y. Zhang, "Developing a Reduced 240-Bus WECC Dynamic Model for Frequency Response Study of High Renewable Integration," 2020 IEEE/PES Transmission and Distribution Conference and Exposition (T&D), October 2020, pp. 1-5, doi:10.1109/TD39804.2020.9299666. The paper the files' headers and the NLR readme name as the reference of the system. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title, volume and pages; its text was not read. [DOI](https://doi.org/10.1109/TD39804.2020.9299666)
- **System:** J. Price and J. Goodin, "Reduced network modeling of WECC as a market design prototype," 2011 IEEE Power and Energy Society General Meeting, July 2011, pp. 1-6, doi:10.1109/PES.2011.6039476. The 240-bus model the NLR page says the repository's system starts from. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title, volume and pages; its text was not read. [DOI](https://doi.org/10.1109/PES.2011.6039476)
- **Data source:** Test Case Repository for High Energy Study, 240-Bus Western Electricity Coordinating Council Test System, National Laboratory of the Rockies (NLR, formerly the National Renewable Energy Laboratory), https://www.nlr.gov/grid/test-case-repository.html (accessed 2026-11-18). The page describes the reduced WECC model, its 2018 base case and its dynamic models, offers the download used here (wecc-osl.zip, the cases of the 2021 IEEE-NASPI Oscillation Source Location contest) and asks users to cite the original author. [Link](https://www.nlr.gov/grid/test-case-repository.html)
- **Data source:** PowerSystemsTestData, Sienna platform, https://github.com/Sienna-Platform/PowerSystemsTestData (commit a2ecae9ff3cf, accessed 2026-11-18; the repository was NREL-Sienna/PowerSystemsTestData, which now redirects). A data repository of the Sienna software that holds copies of the reduced WECC and ACTIVSg2000 files; its README names no source for them and the repository states no licence. [Link](https://github.com/Sienna-Platform/PowerSystemsTestData)

BibTeX:

```bibtex
% System
@inproceedings{yuan2020developing,
  author    = {Yuan, Haoyu and Biswas, Rajarshi Sen and Tan, Jin and Zhang, Yingchen},
  title     = {Developing a Reduced 240-Bus {WECC} Dynamic Model for Frequency Response Study of High Renewable Integration},
  booktitle = {2020 IEEE/PES Transmission and Distribution Conference and Exposition (T\&D)},
  pages     = {1--5},
  year      = {2020},
  month     = oct,
  doi       = {10.1109/TD39804.2020.9299666}
}
```

```bibtex
% System
@inproceedings{price2011reduced,
  author    = {Price, James and Goodin, John},
  title     = {Reduced network modeling of {WECC} as a market design prototype},
  booktitle = {2011 IEEE Power and Energy Society General Meeting},
  pages     = {1--6},
  year      = {2011},
  month     = jul,
  doi       = {10.1109/PES.2011.6039476}
}
```

```bibtex
% Data source
@misc{nlr_test_case_repository,
  title        = {Test Case Repository for High Energy Study: 240-Bus Western Electricity Coordinating Council Test System},
  author       = {{National Laboratory of the Rockies}},
  howpublished = {NLR Grid Modernization},
  url          = {https://www.nlr.gov/grid/test-case-repository.html},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{sienna_powersystemstestdata,
  title        = {{PowerSystemsTestData}},
  author       = {{Sienna platform}},
  howpublished = {GitHub repository},
  url          = {https://github.com/Sienna-Platform/PowerSystemsTestData},
  note         = {commit a2ecae9ff3cf},
  urldate      = {2026-11-18}
}
```

**Links**

- [240-bus WECC test system on the NLR test case repository](https://www.nlr.gov/grid/test-case-repository.html): The page of the system, with its references and the download below.
- [wecc-osl.zip: the cases of the 2021 IEEE-NASPI OSL contest (RAW, DYR, disclaimer and readme)](https://www.nlr.gov/media/docs/libraries/grid/wecc-osl.zip?sfvrsn=f85a054e_1): 2.1 MB. The disclaimer inside is the licence.
- [The 2018 RAW file in the Sienna test data repository](https://github.com/Sienna-Platform/PowerSystemsTestData/blob/a2ecae9ff3cfe6d219744f1b10e4edd4eeecabc9/psse_raw/240busWECC_2018_PSS33.raw): A copy of an earlier version, pinned to a commit; no licence is stated there.
- [The 2018 DYR file in the Sienna test data repository](https://github.com/Sienna-Platform/PowerSystemsTestData/blob/a2ecae9ff3cfe6d219744f1b10e4edd4eeecabc9/psse_dyr/240busWECC_2018_PSS.dyr): A copy of an earlier version, pinned to a commit; no licence is stated there.

**Changes to the data.** None.

**Caveats**

- Which files. The NLR download (wecc-osl.zip, 2,121,896 bytes, SHA-256 dfb91ad14e42fbc8515eafa637a3f0c85996e5508736edbef2886a40fc0e6e87) is the version prepared for the 2021 IEEE-NASPI Oscillation Source Location contest: a PSS/E revision 34 RAW file (243 buses, 329 lines, 122 transformers, 7 switched shunts, 139 loads) and a DYR file, with 10 IEEEST stabilisers added by the contest's committee. Its readme says the contest cases themselves used another dispatch and topology and two HVDC models, which are not in the download. The Sienna test data repository holds an earlier version: a revision 32 RAW file and a DYR file without the stabilisers (SHA-256 217c4f4a... and ce0b8bf9...).
- What loads. The dynamic data has 448 records of nine PSS/E models: GENROU 109, SEXS 109, GAST 47, REGCA1 37, REECB1 37, REPCA1 37, TGOV1 37, HYGOV 25 and IEEEST 10. ANDES reads every one as the model of the same name: nothing is approximated and nothing is dropped. The case opens with 243 buses and the power flow converges in 3 iterations; ANDES warns that six slack generators are enabled on bus 3933.
- The 10 s run is reported failed. ANDES's initialisation test fails ("Initialization FAILED"): in each of the 37 REECB1 renewable electrical controls the lower limit VMIN of its PI controller, 0.9, clamps the variable PIQ_ys where the unconstrained value is 0, which leaves a residual of 0.018 in the equation of PIQ_xi. ANDES does not stop there: it adds 1 to its exit code and integrates the 10 s from that state, in which the largest change of a recorded variable is 0.163 (a PIQ_xi of a REECB1; 1,000 of the 1,956 states are recorded). TENSA reports the run as failed (converged false, ended at 10 s of 10 s) because of that exit code, so no result of the run is offered. The earlier version in the Sienna repository fails the same way. Whether the fault is in ANDES's initialisation of REECB1 or in how this data is read was not investigated, so no time-domain result exists for this data. The script does not run the eigenvalue analysis, so there is no eigenvalue result either.
- A second pair of files in the Sienna repository (240_bus_new_2.raw with 240_bus_remap2_dera2.dyr: 379 buses, with 90 renewable plants and three DERA1 distributed energy models) does not open with its dynamic data: ANDES has no DERA1 model, and a machine model that is missing makes it refuse the whole dynamic file. Its network alone opens, its power flow converges and it agrees with pandapower to 1.4e-6 pu and 0.0012 degrees.
- The power flow is 0.0064 pu and 0.445 degrees from the state the file stores (0.0064 pu and 0.433 degrees for the Sienna copy), and enforcing reactive limits does not change it (0.0064 pu). The cause was not found.
- No independent solver was run on this network: the step that hands ANDES's network to pandapower stops at it (the slack generator is out of service), and the PSS/E reader of scripts/crosscheck_pf.py reads revision 33 only.

**Verification.** Tried on 2026-11-18 with scripts/check_external_datasets.py (trials wecc240, wecc240-mirror, wecc240-dera), through the HTTP API of a real server. Compared with a reference that is not TENSA's: the power flow, with the state the file stores, within 0.0064 pu and 0.445 degrees (a loose bound, not a match). Not verified: no independent solver could be run on this network, and there is no time-domain result (the 10 s run ends at 10 s but is reported failed, because ANDES's initialisation test fails) and no eigenvalue result (the script does not run that analysis).

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Bus voltage magnitudes against the solution stored in the file | a solution stored with the source | the voltages in the bus records of the NLR RAW file, as ANDES reads them, before any power flow | 0.01 pu (a sanity bound: the state is the file's own, to the digits it kept) | largest difference 0.00642 pu (bus 6304) over 243 buses | yes |
| Bus voltage angles against the solution stored in the file | a solution stored with the source | the angles in the bus records of the NLR RAW file, as ANDES reads them, before any power flow | 0.5 deg | largest difference 0.445 deg (bus 7001) over 243 buses | yes |

### IEEE PES small-signal stability benchmark systems { #pes_benchmarks }

The benchmark systems of the IEEE PES Task Force on Benchmark Systems for Stability Controls, made to compare small-signal stability methods and the tuning of stabilisers: the three-machine infinite-bus system, the Brazilian 7-bus equivalent, the two-area four-generator system, the simplified 14-generator Australian system and the NETS-NYPS 68-bus system (the page also lists the IEEE 39-bus system, which this catalog has from ANDES), in the files of several programs. TENSA holds no file. Tried on the PSS/E files of the page: none opens with its dynamic data, because ANDES lacks models they need; only the network of the two-area system opens and solves.

- **Id:** `pes_benchmarks`
- **Kind:** Dynamic
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [None stated (the page calls the material working papers and gives no support)](https://cmte.ieee.org/pes-psdp/benchmark-systems-2/). The page names no licence. It says the reports and implementations were developed by the contributors to the Task Force, are not peer-reviewed documents, come with no commitment of support, and that any citation of the reports should mention them as working papers; the consistent documentation is Technical Report PES-TR18, free to PES members only. Since nothing says the files may be passed on, TENSA bundles none.

**Citations**

- **Data source:** Benchmark Systems for Small-Signal Stability Analysis and Control, IEEE PES Task Force on Benchmark Systems for Stability Controls, https://cmte.ieee.org/pes-psdp/benchmark-systems-2/ (accessed 2026-11-18). The page lists the benchmark systems with, for each, the reports and the files of the programs they were prepared for. It says the reports and implementations are not peer-reviewed documents, that the authors give no support, and that any citation of the reports should mention them as working papers. [Link](https://cmte.ieee.org/pes-psdp/benchmark-systems-2/)
- **System:** IEEE PES Task Force on Benchmark Systems for Stability Controls, "Benchmark Systems for Small-Signal Stability Analysis and Control," Technical Report PES-TR18, IEEE Power & Energy Society, 1 August 2015, 390 pages, https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr18 (accessed 2026-11-18). The report that documents the benchmark systems consistently, which the benchmark page points to. Its page was opened; the report is free for PES members and costs $70 for others, and was not read. [Link](https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr18)
- **System:** C. Canizares, T. Fernandes, E. Geraldi, L. Gerin-Lajoie, M. Gibbard, I. Hiskens, J. Kersulis, R. Kuiava, L. Lima, F. DeMarco, N. Martins, B. C. Pal, A. Piardi, R. Ramos, J. dos Santos, D. Silva, A. K. Singh, B. Tamimi and D. Vowles, "Benchmark Models for the Analysis and Control of Small-Signal Oscillatory Dynamics in Power Systems," IEEE Transactions on Power Systems, vol. 32, no. 1, pp. 715-722, January 2017, doi:10.1109/TPWRS.2016.2561263. The paper of the Task Force on its benchmark systems, with the authors as Crossref lists them. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title, volume and pages; its text was not read. [DOI](https://doi.org/10.1109/TPWRS.2016.2561263)
- **Data source:** Simplified 14-generator model of the South East Australian power system, version 04, The University of Adelaide, http://www.eleceng.adelaide.edu.au/groups/PCON/PowerSystems/IEEE/AU14G/Ver04/ (accessed 2026-11-18). The developers' server, which the benchmark page names for this system; its listing shows the model data (85 KB), the small-signal and state-space results, a 1.5 GB archive of transient stability results and the report of the model. Only the listing was opened. [Link](http://www.eleceng.adelaide.edu.au/groups/PCON/PowerSystems/IEEE/AU14G/Ver04/)
- **Data source:** PowerSystemsTestData, Sienna platform, https://github.com/Sienna-Platform/PowerSystemsTestData (commit a2ecae9ff3cf, accessed 2026-11-18; the repository was NREL-Sienna/PowerSystemsTestData, which now redirects). A data repository of the Sienna software that holds copies of data files for these and other systems, among them the NETS-NYPS 68-bus dynamic data (a .dyr file) that this entry's trial used; its README names no source for them and the repository states no licence. [Link](https://github.com/Sienna-Platform/PowerSystemsTestData)

BibTeX:

```bibtex
% Data source
@misc{pes_benchmark_page,
  title        = {Benchmark Systems for Small-Signal Stability Analysis and Control},
  author       = {{IEEE PES Task Force on Benchmark Systems for Stability Controls}},
  howpublished = {IEEE PES Power System Dynamic Performance Committee},
  url          = {https://cmte.ieee.org/pes-psdp/benchmark-systems-2/},
  urldate      = {2026-11-18}
}
```

```bibtex
% System
@techreport{pestr18,
  author      = {{IEEE PES Task Force on Benchmark Systems for Stability Controls}},
  title       = {Benchmark Systems for Small-Signal Stability Analysis and Control},
  institution = {IEEE Power \& Energy Society},
  type        = {Technical Report},
  number      = {PES-TR18},
  year        = {2015},
  month       = aug,
  url         = {https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr18}
}
```

```bibtex
% System
@article{canizares2017benchmark,
  author  = {Canizares, C. and Fernandes, T. and Geraldi, E. and Gerin-Lajoie, L. and Gibbard, M. and Hiskens, I. and Kersulis, J. and Kuiava, R. and Lima, L. and DeMarco, F. and Martins, N. and Pal, B. C. and Piardi, A. and Ramos, R. and dos Santos, J. and Silva, D. and Singh, A. K. and Tamimi, B. and Vowles, D.},
  title   = {Benchmark Models for the Analysis and Control of Small-Signal Oscillatory Dynamics in Power Systems},
  journal = {IEEE Transactions on Power Systems},
  volume  = {32},
  number  = {1},
  pages   = {715--722},
  year    = {2017},
  month   = jan,
  doi     = {10.1109/TPWRS.2016.2561263}
}
```

```bibtex
% Data source
@misc{au14_adelaide,
  title        = {Simplified 14-generator model of the {South East Australian} power system, version 04},
  howpublished = {The University of Adelaide, Power Systems Control group},
  url          = {http://www.eleceng.adelaide.edu.au/groups/PCON/PowerSystems/IEEE/AU14G/Ver04/},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{sienna_powersystemstestdata,
  title        = {{PowerSystemsTestData}},
  author       = {{Sienna platform}},
  howpublished = {GitHub repository},
  url          = {https://github.com/Sienna-Platform/PowerSystemsTestData},
  note         = {commit a2ecae9ff3cf},
  urldate      = {2026-11-18}
}
```

**Links**

- [Benchmark systems page of the IEEE PES Task Force](https://cmte.ieee.org/pes-psdp/benchmark-systems-2/): Links the files of every system; the downloads are on Google Drive and need the resource key in the link.
- [Technical Report PES-TR18 at the PES Resource Center](https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr18): Free for PES members, $70 for others.
- [Australian 14-generator model on the University of Adelaide server](http://www.eleceng.adelaide.edu.au/groups/PCON/PowerSystems/IEEE/AU14G/Ver04/): One archive in the listing is 1.5 GB.
- [NETS-NYPS 68-bus DYR file in the Sienna test data repository](https://github.com/Sienna-Platform/PowerSystemsTestData/blob/a2ecae9ff3cfe6d219744f1b10e4edd4eeecabc9/psse_dyr/NETS-NYPS%2068%20Bus%20System.dyr): A copy, pinned to a commit; no licence is stated there and no RAW file comes with it.

**Changes to the data.** None.

**Caveats**

- What the page gives for PSS/E, system by system. Three-machine infinite-bus: PSS/E saved cases (a .sav, a snapshot .snp and a .sld) and Python run scripts, no RAW or DYR file. Brazilian 7-bus: a revision 32 RAW and a DYR file. Two-area four-generator: a RAW file (revision 32, though it is named 33) and three DYR files. Australian 14-generator: revision 29 RAW files and DYR files, in an 86 KB archive the page links (the model data of its MudPack-PSS/E files). NETS-NYPS 68-bus: no PSS/E file, only MATLAB and ANAREDE/PacDyn/ANATEM files. The files are on a Google Drive link of the page; it needs the resource key the page's link carries, and without it Google asks for a sign-in.
- Three-machine infinite-bus: the PSS/E saved case is binary, and ANDES cannot read it ("Unable to determine case format"). So nothing opens.
- Brazilian 7-bus: the dynamic data uses GENSAE (5 machines), which ANDES does not have, and ANDES then refuses the whole dynamic file ("No SynGen device found"); its other models, SEXS (5) and IEEEST (4), are supported. The network alone opens, but its power flow does not converge in ANDES (26 iterations, mismatch 6.3) and pandapower does not solve the network ANDES reads either; the cause was not investigated.
- Two-area four-generator: the dynamic data uses GENROE (4 machines), which ANDES does not have, so the dynamic file is refused; its ESST1A (4) is supported. The network alone opens and its power flow converges in 1 iteration; it agrees with pandapower to 2.4e-7 pu and 2.6e-5 degrees and with the state the file stores to 5.4e-6 pu and 0.0002 degrees. That is a power flow of a network with no machines.
- Australian 14-generator: ANDES cannot read the RAW file, which is revision 29: its reader warns that the version is not explicitly supported, reads it as version 33 and raises an IndexError in its generator data. Its dynamic data has GENROE (12), CSVGN1 (5, a static var compensator) and IEELAL (1), which ANDES does not have, ESST1A (11), IEEEST (14), ESAC1A (3), GENCLS (1) and GENSAL (2, read as GENROU).
- NETS-NYPS 68-bus: the DYR file of the Sienna test data repository (no RAW file comes with it) has GENROU (16), IEEEST (12), SEXS (1) and DC4B (11), which ANDES does not have.
- The IEEE 39-bus system the page lists is not this entry's concern: the catalog has an IEEE 39-bus case from ANDES with machines.

**Verification.** Tried on 2026-11-18 with scripts/check_external_datasets.py (trials pes-twoarea, pes-brazil7, pes-au14, pes-3machine, pes-nyps68), through the HTTP API of a real server, on the files of the page (and the Sienna copy for the 68-bus system). Compared with independent references: the power flow of the two-area network alone, with pandapower and with the state its file stores. Not verified: every other result of the entry is a refusal or a failure, which is recorded in the caveats, and there is no time-domain or eigenvalue result for any of the systems.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Two-area network, bus voltage magnitudes against pandapower | an independent solver | pandapower 3.5.6, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive limits not enforced) on the network ANDES reads from Benchmark_4ger_33_2015.raw (the archive of the page's two-area link), written out by scripts/crosscheck_pf.py; run by scripts/check_external_datasets.py | 0.0001 pu | largest difference 2.39e-07 pu (bus 9) over 11 buses | yes |
| Two-area network, bus voltage angles against pandapower | an independent solver | pandapower 3.5.6, as above | 0.01 deg | largest difference 2.58e-05 deg (bus 9) over 11 buses | yes |
| Two-area network, losses and the slack's power against pandapower | an independent solver | pandapower 3.5.6, as above | 0.01 + 0.001 of the value MW | losses differ by 0.000435 MW and the slack's power by 0.000435 MW | yes |
| Two-area network, bus voltage magnitudes against the solution stored in the file | a solution stored with the source | the voltages in the bus records of Benchmark_4ger_33_2015.raw, as ANDES reads them, before any power flow | 0.01 pu | largest difference 5.42e-06 pu (bus 10) over 11 buses | yes |
| Two-area network, bus voltage angles against the solution stored in the file | a solution stored with the source | the angles in the bus records of Benchmark_4ger_33_2015.raw, as ANDES reads them, before any power flow | 0.5 deg | largest difference 0.00022 deg (bus 9) over 11 buses | yes |

### Nordic test system for voltage stability (IEEE PES), 74 buses { #nordic }

The Nordic test system of the IEEE PES Task Force on Test Systems for Voltage Stability Analysis and Security Assessment, a variant of the Nordic32 system for long-term voltage stability, with 74 buses and 20 generators as its page states, whose behaviour rests on overexcitation limiters and load tap changers. TENSA holds no file. The PSS/E files of the page are binary saved cases, which ANDES cannot read, and ANDES has no model of either of those two controls.

- **Id:** `nordic`
- **Kind:** Dynamic
- **Size:** 74 buses, 20 generators
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [None stated by the IEEE PES page; Apache License 2.0 for the SPS-L repository](https://github.com/SPS-L/stepss-IEEE-Nordic-Test-system/blob/main/LICENSE). The page of the Task Force states no licence and says the material was developed by the Task Force's contributors with an internal peer review and no commitment of support. The SPS-L repository, whose files are in RAMSES format and not the PSS/E ones, is under the Apache License 2.0, which allows copying and redistribution with the licence text and the notices kept; its README asks users to cite Technical Report PES-TR19 (above). TENSA bundles nothing of either.

**Citations**

- **System:** IEEE PES Task Force on Test Systems for Voltage Stability Analysis and Security Assessment, "Test Systems for Voltage Stability Analysis and Security Assessment," Technical Report PES-TR19, IEEE Power & Energy Society, 25 August 2015, 161 pages, https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr19 (accessed 2026-11-18). The report that defines the Nordic and RVS test systems, which the repository's README asks to cite. Its page was opened; the report is free for PES members and costs $70 for others, and was not read. [Link](https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr19)
- **Data source:** Test Systems for Voltage Stability Analysis and Security Assessment, IEEE PES Task Force on Test Systems for Voltage Stability Analysis and Security Assessment, https://cmte.ieee.org/pes-psdp/489-2/ (accessed 2026-11-18). The page describes the Nordic test system (a variant of the Nordic32 system, 50 Hz, 74 buses, 102 branches, 20 generators with step-up transformers and overexcitation limiters, 22 loads controlled by load tap changers) and gives its input data for RAMSES, PSS/E, ANATEM and DigSilent PowerFactory, and sample outputs. [Link](https://cmte.ieee.org/pes-psdp/489-2/)
- **Data source:** IEEE Nordic Test System in RAMSES format, SPS-L, https://github.com/SPS-L/stepss-IEEE-Nordic-Test-system (accessed 2026-11-18). A repository of the data for the STEPSS platform (RAMSES and HELIOS), under the Apache License 2.0, whose README asks that users of the system cite Technical Report PES-TR19. [Link](https://github.com/SPS-L/stepss-IEEE-Nordic-Test-system)

BibTeX:

```bibtex
% System
@techreport{pestr19,
  author      = {{IEEE PES Task Force on Test Systems for Voltage Stability Analysis and Security Assessment}},
  title       = {Test Systems for Voltage Stability Analysis and Security Assessment},
  institution = {IEEE Power \& Energy Society},
  type        = {Technical Report},
  number      = {PES-TR19},
  year        = {2015},
  month       = aug,
  url         = {https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr19}
}
```

```bibtex
% Data source
@misc{pes_nordic_page,
  title        = {Test Systems for Voltage Stability Analysis and Security Assessment},
  author       = {{IEEE PES Task Force on Test Systems for Voltage Stability Analysis and Security Assessment}},
  howpublished = {IEEE PES Power System Dynamic Performance Committee},
  url          = {https://cmte.ieee.org/pes-psdp/489-2/},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{spsl_nordic,
  title        = {{IEEE} Nordic Test System in {RAMSES} format},
  author       = {{SPS-L}},
  howpublished = {GitHub repository},
  url          = {https://github.com/SPS-L/stepss-IEEE-Nordic-Test-system},
  urldate      = {2026-11-18}
}
```

**Links**

- [Test systems for voltage stability analysis, page of the IEEE PES Task Force](https://cmte.ieee.org/pes-psdp/489-2/): Links the input data for RAMSES, PSS/E, ANATEM and DigSilent PowerFactory (Google Drive) and sample outputs.
- [Technical Report PES-TR19 at the PES Resource Center](https://resourcecenter.ieee-pes.org/publications/technical-reports/pestr19): Free for PES members, $70 for others.
- [IEEE Nordic test system in RAMSES format, SPS-L repository](https://github.com/SPS-L/stepss-IEEE-Nordic-Test-system): Apache License 2.0; for the STEPSS platform, not for ANDES.

**Changes to the data.** None.

**Caveats**

- Which files. The page's input data for PSS/E (a Google Drive link, 26,699 bytes, SHA-256 cdfeae242e3c2710107061a23563e9c2307d03e3e96def5e5c71b8a03c12f23e) is an archive of a PSS/E saved case (Nordic_voltage_collapse_0.sav and its converted copy), a snapshot (Nordic_voltage_collapse_new.snp) and a Python script: binary PSS/E files, no RAW or DYR file. Given to TENSA, the saved case is refused (ANDES: "Unable to determine case format"). The SPS-L repository holds the same system as RAMSES data files (lf_A.dat, dyn_A.dat and so on), which ANDES does not read either.
- What ANDES lacks. The system's voltage collapse is the behaviour of the generators' overexcitation limiters and of the load tap changers of its 22 distribution loads, and ANDES 2.0.0 has no model of an overexcitation limiter or of a load tap changer (none of its 100 models is one). A case that ANDES could read would therefore not be this system.
- ANDES's own cases include a case called nordic44, a different system (the 44-bus Nordic model of ALSETLab); its README says most of its dynamic models are not supported. It is not in this catalog.
- The page also gives the RVS test system (75 buses, 32 generators) as PSS/E files; it is not part of this entry.
- The size is as the page states it (74 buses, 20 generators); no file of it could be read here.

**Verification.** Tried on 2026-11-18 with scripts/check_external_datasets.py (trial nordic): the PSS/E archive of the page was downloaded and its saved case offered to TENSA through the HTTP API, which refused it. Nothing was run, so nothing is verified.

### IEEE 145-bus 50-generator and 162-bus 17-generator dynamic cases (University of Washington) { #uw_dynamic }

Two dynamic stability test cases of the University of Washington Power Systems Test Case Archive, provided by Iowa State University: a 50-generator system with a 145-bus power flow (classical machine data and exciter data) and a 17-generator system with a 162-bus power flow (classical data), the subject of an IEEE committee report. TENSA holds no file. Both are text files in the IEEE Common Data Format and an EPRI dynamic format, which ANDES does not read, so TENSA cannot open them.

- **Id:** `uw_dynamic`
- **Kind:** Dynamic
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [None stated (the archive's disclaimer and content policy)](https://labs.ece.uw.edu/pstca/pg_tcaintro.htm). The archive names no licence. Its disclaimer says it is operated voluntarily as a public service with no guarantee of any kind, that the material is for research and education and not for commercial gain, and that material found to be copyrighted or proprietary is removed once it is called to the maintainer's attention. The two cases were provided by Professor Vijay Vittal and Roger Treinen of Iowa State University, whom the pages thank. Since nothing says the files may be passed on, TENSA bundles none.

**Citations**

- **Data source:** 50 Generator Dynamic Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/dyn50/pg_tcadd50.htm (accessed 2026-11-18). The page says the case, with a 145-bus power flow, was provided courtesy of Professor Vijay Vittal and Roger Treinen of Iowa State University, was previously distributed by Iowa State on diskette and was the subject of an IEEE Committee report; the power flow is in the IEEE Common Data Format and the dynamic and exciter data seem to be in the EPRI format of the manual EPRI EL-2001-CCM. [Link](https://labs.ece.uw.edu/pstca/dyn50/pg_tcadd50.htm)
- **Data source:** 17 Generator Dynamic Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/dyn17/pg_tcadd17.htm (accessed 2026-11-18). The page says the case, with a 162-bus power flow, was provided courtesy of Professor Vijay Vittal and Roger Treinen of Iowa State University and was the subject of an IEEE Committee report; the power flow is in the IEEE Common Data Format and the classical dynamic data seems to be in the EPRI format. [Link](https://labs.ece.uw.edu/pstca/dyn17/pg_tcadd17.htm)
- **System:** V. Vittal, D. Martin, R. Chu, J. Fish, J. C. Giri, C. K. Tang, F. Eugenio Villaseca and R. G. Farmer, "Transient stability test systems for direct stability methods," IEEE Transactions on Power Systems, vol. 7, no. 1, pp. 37-43, February 1992, doi:10.1109/59.141684. Probably the IEEE committee report that the archive's pages say the two cases were the subject of: the pages do not name it, and the identification rests on a search result that describes the report's test systems as a 17-generator, 162-bus system and a 50-generator, 145-bus system. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; the repository record of Cleveland State University (https://engagedscholarship.csuohio.edu/enece_facpub/82) was opened and its abstract read, which says the report presents a standard set of test system data with benchmark results. Its text could not be opened, so the identification was not confirmed from it. [DOI](https://doi.org/10.1109/59.141684)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca_dyn50,
  title        = {50 Generator Dynamic Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/dyn50/pg_tcadd50.htm},
  urldate      = {2026-11-18}
}
```

```bibtex
% Data source
@misc{uw_pstca_dyn17,
  title        = {17 Generator Dynamic Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/dyn17/pg_tcadd17.htm},
  urldate      = {2026-11-18}
}
```

```bibtex
% System
@article{vittal1992transient,
  author  = {Vittal, V. and Martin, D. and Chu, R. and Fish, J. and Giri, J. C. and Tang, C. K. and Villaseca, F. Eugenio and Farmer, R. G.},
  title   = {Transient stability test systems for direct stability methods},
  journal = {IEEE Transactions on Power Systems},
  volume  = {7},
  number  = {1},
  pages   = {37--43},
  year    = {1992},
  month   = feb,
  doi     = {10.1109/59.141684}
}
```

**Links**

- [50-generator dynamic test case (145-bus power flow), UW archive](https://labs.ece.uw.edu/pstca/dyn50/pg_tcadd50.htm): Three text files.
- [17-generator dynamic test case (162-bus power flow), UW archive](https://labs.ece.uw.edu/pstca/dyn17/pg_tcadd17.htm): Two text files.
- [IEEE Common Data Format, as the archive describes it](https://labs.ece.uw.edu/pstca/formats/cdf.txt): The format of the power flow files.

**Changes to the data.** None.

**Caveats**

- The files. 50-generator: dd50cdf.txt (the power flow, 145 buses, 87,615 bytes, SHA-256 2fb27dcc222f61382fccfb408dc825d1cd80b52eea9176bac84fb215d7c1775e), dd50cldat.txt (classical data) and dd50exdat.txt (exciter data). 17-generator: dd17cdf.txt (the power flow, 162 buses, 61,281 bytes, SHA-256 1caa0c2af1b74c4772906fabb0978722649b8454573fab36e7c6b6f2dd4b27f3) and dd17cldat.txt (classical data only). The archive says the dynamic data seems to be in the EPRI format of the manual EPRI EL-2001-CCM.
- TENSA cannot open them. ANDES reads no IEEE Common Data Format file and no EPRI dynamic format, and the workspace lists .xlsx, .raw, .dyr, .json and .m files only. Given the power flow file as it is, TENSA's session refuses it (ANDES: "Unable to determine case format"). A conversion of the network to another format was not tried, and the dynamic data would need models written for ANDES from the EPRI data.
- The size is not stated because the two systems differ: 145 buses and 50 generators, and 162 buses and 17 generators, as the files' headers and titles say.

**Verification.** Tried on 2026-11-18 with scripts/check_external_datasets.py (trials uw145 and uw162): the power flow file of each was downloaded and offered to TENSA through the HTTP API, which refused both. Nothing was run, so nothing is verified.

### MATPOWER case library { #matpower_library }

The case files that come with MATPOWER, the power flow and optimal power flow package of PSERC: 78 case files in the MATPOWER case format (one .m file each), from 4 buses to 70,000, among them the IEEE cases, PEGASE and ACTIVSg. TENSA bundles four of them (the PEGASE 89 and 1354-bus and ACTIVSg200 and ACTIVSg2000 cases) and ANDES carries copies of the IEEE 14, 118, 300 and PJM 5-bus ones. Any other can be downloaded, put in the workspace folder and opened for a power flow.

- **Id:** `matpower_library`
- **Kind:** Steady state
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [3-clause BSD for MATPOWER's code; the case files are not covered by it](https://github.com/MATPOWER/matpower/blob/master/LICENSE). The licence file says the case files distributed with MATPOWER are not covered by the BSD license and that in most cases the data has either been included with permission or converted from data available from a public source: each case file carries its own terms and credits in its header (the ACTIVSg and PEGASE cases are CC BY 4.0, for example). The README asks that publications derived from the use of MATPOWER or its data files cite the 2011 paper and the software, and that the version be named; some case files ask for more citations, which their headers give.

**Citations**

- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, which every publication derived from its use or its data files is asked to cite. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)
- **Software:** R. D. Zimmerman and C. E. Murillo-Sanchez, MATPOWER (Version 8.1), 2025 [Software], https://matpower.org, doi:10.5281/zenodo.15871662. The citation the MATPOWER README gives for version 8.1 of the software; the general, version-independent DOI is 10.5281/zenodo.3236535. Both DOIs resolve to Zenodo. [DOI](https://doi.org/10.5281/zenodo.15871662)

BibTeX:

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

```bibtex
% Software
@misc{zimmerman2025matpower,
  author       = {Zimmerman, R. D. and Murillo-S{\'a}nchez, C. E.},
  title        = {{MATPOWER} (Version 8.1)},
  year         = {2025},
  howpublished = {Software},
  url          = {https://matpower.org},
  doi          = {10.5281/zenodo.15871662}
}
```

**Links**

- [MATPOWER](https://matpower.org): The project page, with the manual.
- [The data folder of release 8.1](https://github.com/MATPOWER/matpower/tree/8.1/data): The case files, each with its header.
- [MATPOWER licence](https://github.com/MATPOWER/matpower/blob/master/LICENSE): The BSD licence of the code and the note on the case files.

**Changes to the data.** None.

**Caveats**

- Read the header of a case file before using it: it names the source, the terms and the papers to cite. TENSA's entries for the four files it bundles quote them.
- ANDES 2.0.0's MATPOWER reader drops the phase shift of a branch whose tap ratio is 0, where MATPOWER applies it (found with the PEGASE cases; their entries give the size of the effect). Only a power flow is possible: the files hold no machine models.
- Release 8.1 is the one the bundled files were taken from. The library changes between releases, so name the release when citing a case.

**Verification.** Nothing was run: this entry is a pointer to a collection, not a case, so there is nothing to verify. Each case of it that TENSA bundles has an entry of its own with its checks.

### PGLib-OPF benchmark library { #pglib_opf_library }

The Power Grid Lib of the IEEE PES Task Force on Benchmarks for Validation of Emerging Power System Algorithms: 66 networks from 3 to 78,484 buses in the MATPOWER case format, each in a base, a heavily loaded (api) and a small angle difference (sad) variant, curated for benchmarking AC optimal power flow. TENSA bundles three of the base cases (the IEEE 30-bus and 57-bus and the RTS-24). Any other can be downloaded, put in the workspace folder and opened for a power flow.

- **Id:** `pglib_opf_library`
- **Kind:** Steady state
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [CC BY 4.0 (the case files); MIT (the software)](https://creativecommons.org/licenses/by/4.0/). The README says all case files are provided under the Creative Commons Attribution License, which allows anyone to share or adapt them as long as they give appropriate credit to the original author, provide a link to the licence and indicate if changes were made; the LICENSE file says to see the data files for their specific copyright holders and attribution. The README encourages users to cite the original sources named in the file headers and the library's report, and to name the version.

**Citations**

- **Data source:** S. Babaeinejadsarookolaee, A. Birchfield, R. D. Christie, C. Coffrin, C. DeMarco, R. Diao, M. Ferris, S. Fliscounakis, S. Greene, R. Huang, C. Josz, R. Korab, B. Lesieutre, J. Maeght, T. W. K. Mak, D. K. Molzahn, T. J. Overbye, P. Panciatici, B. Park, J. Snodgrass, A. Tbaileh, P. Van Hentenryck and R. Zimmerman, "The Power Grid Library for Benchmarking AC Optimal Power Flow Algorithms," arXiv:1908.02788, August 2019. The report of the library the file comes from (IEEE PES Power Grid Library, pglib-opf), which its README names as its detailed report and which asks that the version be given when it is cited: this is v23.07. [Link](https://arxiv.org/abs/1908.02788)
- **Data source:** IEEE PES Power Grid Library, pglib-opf, https://github.com/power-grid-lib/pglib-opf (accessed 2026-11-18). The repository of the benchmark library, curated by the IEEE PES Task Force on Benchmarks for Validation of Emerging Power System Algorithms; its README asks that the version number be named when it is referenced. [Link](https://github.com/power-grid-lib/pglib-opf)
- **Software:** R. D. Zimmerman, C. E. Murillo-Sanchez and R. J. Thomas, "MATPOWER: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education," IEEE Transactions on Power Systems, vol. 26, no. 1, pp. 12-19, February 2011, doi:10.1109/TPWRS.2010.2051168. The paper for MATPOWER, which every publication derived from its use or its data files is asked to cite. [DOI](https://doi.org/10.1109/TPWRS.2010.2051168)

BibTeX:

```bibtex
% Data source
@misc{babaeinejadsarookolaee2019pglib,
  author        = {Babaeinejadsarookolaee, Sogol and Birchfield, Adam and Christie, Richard D. and Coffrin, Carleton and DeMarco, Christopher and Diao, Ruisheng and Ferris, Michael and Fliscounakis, Stephane and Greene, Scott and Huang, Renke and Josz, Cedric and Korab, Roman and Lesieutre, Bernard and Maeght, Jean and Mak, Terrence W. K. and Molzahn, Daniel K. and Overbye, Thomas J. and Panciatici, Patrick and Park, Byungkwon and Snodgrass, Jonathan and Tbaileh, Ahmad and Van Hentenryck, Pascal and Zimmerman, Ray},
  title         = {The Power Grid Library for Benchmarking {AC} Optimal Power Flow Algorithms},
  year          = {2019},
  eprint        = {1908.02788},
  archivePrefix = {arXiv},
  note          = {library version v23.07}
}
```

```bibtex
% Data source
@misc{pglib_opf,
  title        = {{PGLib-OPF}: {IEEE PES} Power Grid Library, Optimal Power Flow},
  author       = {{IEEE PES Task Force on Benchmarks for Validation of Emerging Power System Algorithms}},
  howpublished = {GitHub repository},
  url          = {https://github.com/power-grid-lib/pglib-opf},
  urldate      = {2026-11-18}
}
```

```bibtex
% Software
@article{zimmerman2011matpower,
  author  = {Zimmerman, Ray D. and Murillo-S{\'a}nchez, Carlos E. and Thomas, Robert J.},
  title   = {{MATPOWER}: Steady-State Operations, Planning, and Analysis Tools for Power Systems Research and Education},
  journal = {IEEE Transactions on Power Systems},
  volume  = {26},
  number  = {1},
  pages   = {12--19},
  year    = {2011},
  month   = feb,
  doi     = {10.1109/TPWRS.2010.2051168}
}
```

**Links**

- [pglib-opf on GitHub](https://github.com/power-grid-lib/pglib-opf): The cases, with the README and the licence.
- [The library's report on arXiv](https://arxiv.org/abs/1908.02788): Motivation, goals and the sources of the cases.
- [Power Grid Lib site of the Task Force](https://power-grid-lib.github.io/): The Task Force's page.

**Changes to the data.** None.

**Caveats**

- The cases are set up for optimal power flow, not as operating points of the systems they come from: their dispatch, generator limits and line ratings are the library's, and the loaded (api) and angle-limited (sad) variants are stress cases. A power flow on a file is a power flow of that setup (the entries of the three bundled files say what it means for each).
- TENSA does no optimal power flow, so the cost data of a file is not used.
- The library is not static: the bundled files are from release v23.07.

**Verification.** Nothing was run: this entry is a pointer to a collection, not a case, so there is nothing to verify. Each case of it that TENSA bundles has an entry of its own with its checks.

### University of Washington Power Systems Test Case Archive { #uw_archive }

The archive that made the IEEE 14, 30, 57, 118 and 300-bus power flow cases, the 17 and 50-generator dynamic cases and the IEEE Reliability Test System (1979 and 1996) available on the web, kept by Richard D. Christie. Its files are text in the IEEE Common Data Format, which ANDES does not read; the catalog's IEEE 30, 57, 118 and 300-bus cases are copies of the same data in MATPOWER's format.

- **Id:** `uw_archive`
- **Kind:** Steady state
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [None stated (the archive's disclaimer and content policy)](https://labs.ece.uw.edu/pstca/pg_tcaintro.htm). The archive names no licence. Its disclaimer says it is operated voluntarily as a public service with no guarantee of any kind, that the material is for research and education and not for commercial gain, and that material found to be copyrighted or proprietary is removed once it is called to the maintainer's attention. Its dynamic cases were provided by Professor Vijay Vittal and Roger Treinen of Iowa State University. Since nothing says the files may be passed on, TENSA bundles none.

**Citations**

- **Data source:** Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, maintained by R. D. Christie, https://labs.ece.uw.edu/pstca/ (accessed 2026-11-18). The archive's front page lists the power flow cases of 14, 30, 57, 118 and 300 buses, the dynamic cases, the Reliability Test System (1979 and 1996) and other material; its introduction (last updated August 1999) holds the disclaimer and content policy. [Link](https://labs.ece.uw.edu/pstca/)

BibTeX:

```bibtex
% Data source
@misc{uw_pstca,
  title        = {Power Systems Test Case Archive},
  author       = {Christie, Richard D.},
  howpublished = {University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/},
  urldate      = {2026-11-18}
}
```

**Links**

- [Power Systems Test Case Archive](https://labs.ece.uw.edu/pstca/): The front page, with every case.
- [Introduction, disclaimer and content policy](https://labs.ece.uw.edu/pstca/pg_tcaintro.htm): The terms the archive states.
- [IEEE Common Data Format](https://labs.ece.uw.edu/pstca/formats/cdf.txt): The format of the power flow files.

**Changes to the data.** None.

**Caveats**

- The files are IEEE Common Data Format text files (and the dynamic ones an EPRI format), which TENSA cannot open: a file of the archive that is wanted in TENSA is used through a copy in MATPOWER's format, as the catalog's IEEE 30, 57, 118 and 300-bus cases are, whose entries say what the copy changed.
- The archive was last updated in August 1999, and says it makes no guarantee of the correctness of its material.

**Verification.** Nothing was run: this entry is a pointer to a collection, not a case, so there is nothing to verify. TENSA bundles no file from this archive: the IEEE cases of the catalog come to TENSA through ANDES (the user's own copy of the files), MATPOWER or PGLib-OPF, and each has an entry of its own with its checks.

### Texas A&M Electric Grid Test Case Repository { #tamu_repository }

The repository of synthetic grids of Texas A&M University: ACTIVSg200, 500, 2000, 10k, 25k and 70k, the UIUC 150-bus system, power flow cases of the literature (WSCC 9, IEEE 14, 24, 30, 39, 57, 118, 300 and the RTS-96), the small-signal stability benchmark systems and more, in PowerWorld, MATPOWER, PSS/E RAW and PSLF formats, several with the files of their dynamic models. The download of a case is behind a form that asks for an email address. This catalog has ACTIVSg200 and ACTIVSg2000 (networks only, from MATPOWER) and entries for their dynamic data.

- **Id:** `tamu_repository`
- **Kind:** Steady state
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [Texas A&M University: free for commercial or non-commercial use (no licence named)](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/). The pages of the cases say the datasets are synthetic and provided by Texas A&M University researchers free for commercial or non-commercial use, and encourage users to fill in the feedback form and to cite the appropriate papers, which the references page lists (the paper of the algorithms for any synthetic case, and the others it names for costs, dynamics and time series). They do not say whether the files may be passed on.

**Citations**

- **Data source:** References, Electric Grid Test Case Repository, Texas A&M University, https://electricgrids.engr.tamu.edu/references/ (accessed 2026-11-18). The page lists the papers of the synthetic cases and says which to cite: [1], Birchfield et al. 2017, for the algorithms that create the cases, and [5] and [10], Xu et al., for the generator dynamic models. [Link](https://electricgrids.engr.tamu.edu/references/)
- **System:** A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye, "Grid Structural Characteristics as Validation Criteria for Synthetic Networks," IEEE Transactions on Power Systems, vol. 32, no. 4, pp. 3258-3265, July 2017, doi:10.1109/TPWRS.2016.2616385. The paper the file's header asks that publications based on the data cite, which describes how the synthetic networks are made. The DOI resolves to the paper's IEEE Xplore page and Crossref gives its title and pages; its text was not read. [DOI](https://doi.org/10.1109/TPWRS.2016.2616385)

BibTeX:

```bibtex
% Data source
@misc{tamu_references,
  title        = {References},
  howpublished = {Electric Grid Test Case Repository, Texas A\&M University},
  url          = {https://electricgrids.engr.tamu.edu/references/},
  urldate      = {2026-11-18}
}
```

```bibtex
% System
@article{birchfield2017grid,
  author  = {Birchfield, Adam B. and Xu, Ti and Gegner, Kathleen M. and Shetye, Komal S. and Overbye, Thomas J.},
  title   = {Grid Structural Characteristics as Validation Criteria for Synthetic Networks},
  journal = {IEEE Transactions on Power Systems},
  volume  = {32},
  number  = {4},
  pages   = {3258--3265},
  year    = {2017},
  month   = jul,
  doi     = {10.1109/TPWRS.2016.2616385}
}
```

**Links**

- [Electric Grid Test Case Repository](https://electricgrids.engr.tamu.edu/): The home page, with the list of cases.
- [The cases](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/): One page per case; the download is behind a form.
- [References](https://electricgrids.engr.tamu.edu/references/): The papers to cite.

**Changes to the data.** None.

**Caveats**

- The download of a case is behind a form with an email address, a name and an organisation, which TENSA's checks do not submit; the files of this repository were therefore not downloaded from it (the ACTIVSg2000 test used a copy in another repository, see its entry).
- The synthetic cases bear no relation to the actual grid in their location. The MATPOWER copies of ACTIVSg200 and ACTIVSg2000 in this catalog carry a CC BY 4.0 licence in their headers, which the repository's own pages do not state.

**Verification.** Nothing was run: this entry is a pointer to a collection, not a case, so there is nothing to verify. TENSA bundles no file from this repository: the ACTIVSg cases of the catalog come to TENSA through MATPOWER, and each has an entry of its own with its checks.

### Edinburgh GB network and test case archive { #edinburgh_gb }

The Power Systems Test Case Archive of the School of Mathematics of the University of Edinburgh, which offers the transmission network of Great Britain (2224 nodes, 3207 branches, 394 generators, from public data of National Grid) as a MATPOWER file, with a reduced GB network, the Iceland network, a European network and others. ANDES carries a copy of the GB network (andes/cases/GBnetwork) with dynamic data its README says is randomly generated; it is not in this catalog.

- **Id:** `edinburgh_gb`
- **Kind:** Steady state
- **Size:** -
- **Analyses:** -

**Source.** TENSA holds no file of this case; the links below say where to get it.

**Licence.** [None stated (the archive's disclaimer: research and educational purposes, no guarantees)](https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/introduction.html). The archive names no licence. Its introduction says the data comes from open material on the web, that the source of each dataset is given on its page and in its file headers, and that the contents are for research and educational purposes with no guarantee of correctness, quality or fitness for an application; it asks users to cite the report named in the citation above. Since nothing says the files may be passed on, TENSA bundles none.

**Citations**

- **Data source:** Power Systems Test Case Archive, GB Network, School of Mathematics, University of Edinburgh, maintained by W. Bukhsh, https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/fullGB/ (accessed 2026-11-18; the archive's older address, www.maths.ed.ac.uk/optenergy/NetworkData/, redirects there). The page says the data is a detailed model of the transmission network of Great Britain with 2224 nodes, 3207 branches and 394 generators, obtained from public data on the website of National Grid, and offers it as GBnetwork.m. The archive asks that users cite W. A. Bukhsh and K. McKinnon, "Network data of real transmission networks," April 2013; that report was not found and is not cited here. [Link](https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/fullGB/)

BibTeX:

```bibtex
% Data source
@misc{edinburgh_gb,
  title        = {Power Systems Test Case Archive: {GB} Network},
  author       = {Bukhsh, Waqquas A.},
  howpublished = {School of Mathematics, University of Edinburgh},
  url          = {https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/fullGB/},
  urldate      = {2026-11-18}
}
```

**Links**

- [GB network page](https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/fullGB/): The case file GBnetwork.m and a diagram.
- [The archive](https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/): The list of every case.
- [Introduction and disclaimer](https://webhomes.maths.ed.ac.uk/OptEnergy/NetworkData/introduction.html): The terms the archive states.

**Changes to the data.** None.

**Caveats**

- The archive was last updated in March 2013. The GB network is described there as obtained from public data on National Grid's website.
- The files are MATPOWER cases: only a power flow is possible, and ANDES 2.0.0's MATPOWER reader drops the phase shift of a branch whose tap ratio is 0 (see the MATPOWER library entry). TENSA has not been run on the GB network.

**Verification.** Nothing was run: this entry is a pointer to a collection, not a case, so there is nothing to verify. TENSA bundles no file from this archive.
