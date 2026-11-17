# Example cases

TENSA has a catalog of example cases: power systems you can add to your workspace and open
at once. Each entry says what the case is for, how large it is, what you can run on it, where
its data comes from, how to cite it, which licence it is under, what was changed in the
data, what to be careful about and how its results were checked.

This page is written from the catalog (`server/src/tensa/examples/catalog.json`) by
`scripts/gen_examples_page.py`, so it says what the program says. Do not edit it by hand.

## Adding a case

The cases marked as first run are copied into an empty workspace the first time the server
starts. Any case can be added later. In the app, **Example cases** lists them: it is the button
in the Workspace part of the Project tab, an item of the Workspace menu and a command in the
command palette. The cases are grouped by what they support. **Add to workspace** copies a
case's file in and **Open** loads it. **Cite** shows its references and copies them as text or
as BibTeX, and the links to its source and licence open in a new tab. A case that is only links
to data TENSA does not hold has an **Open source page** link instead. From the command line:

```bash
tensa examples list
tensa examples add ieee14
tensa examples cite ieee14
```

`tensa examples add` leaves a file that is already in the workspace alone, and `--force`
replaces it. `tensa examples cite` prints the plain-text citations of a case and `--bibtex`
prints them as BibTeX. The same is available from the API (`GET /api/examples` and
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

- IEEE 14 Bus Test Case, Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering, https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm (accessed 2026-11-17). [Link](https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm)
- ANDES, andes/cases/ieee14/README.md, release 2.0.0: the power flow data of ieee14.raw is by J. Conto and the dynamic data by H. Cui, both written for ANDES (https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md, accessed 2026-11-17). [Link](https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
@misc{uw_pstca_ieee14,
  title        = {{IEEE} 14 Bus Test Case},
  howpublished = {Power Systems Test Case Archive, University of Washington, Department of Electrical Engineering},
  url          = {https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm},
  urldate      = {2026-11-17}
}
```

```bibtex
@misc{andes_ieee14_readme,
  title        = {{ANDES} cases: {IEEE} 14-bus systems (README)},
  howpublished = {ANDES release 2.0.0, andes/cases/ieee14/README.md},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/README.md},
  urldate      = {2026-11-17}
}
```

```bibtex
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

- P. Kundur, Power System Stability and Control. New York: McGraw-Hill, 1994, ISBN 0-07-035958-X.
- M. Klein, G. J. Rogers and P. Kundur, "A fundamental study of inter-area oscillations in power systems," IEEE Transactions on Power Systems, vol. 6, no. 3, pp. 914-921, 1991, doi:10.1109/59.119229. [DOI](https://doi.org/10.1109/59.119229)
- CRESYM Colib, Kundur two-area system (test case page: the data of the book's system, with a load flow and the small-signal examples), https://colib.net/testCases/kundur_two_area_system/index.html (accessed 2026-11-17). Used here only to compare the file with the book's data. [Link](https://colib.net/testCases/kundur_two_area_system/index.html)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
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
@misc{colib_kundur_two_area,
  title        = {Kundur two-area system},
  howpublished = {CRESYM Colib, test cases},
  url          = {https://colib.net/testCases/kundur_two_area_system/index.html},
  urldate      = {2026-11-17}
}
```

```bibtex
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

**Source.** Bundled with TENSA as `wscc9.xlsx` from <https://github.com/Roger-GO/TENSA/blob/778a06d7396f1ccde31b48955fcb4072e731716d/scripts/build_wscc9.py>, retrieved 2026-11-17. SHA-256 `ce980cc07d6dfc133fe66473610fa6e3a3962c4ccd09734d2d6d951df525c758`.

**Licence.** [GPL-3.0-or-later](https://github.com/Roger-GO/TENSA/blob/main/LICENSE). The file is written by TENSA's scripts/build_wscc9.py and is distributed with TENSA under its licence. The numbers in it are those of the book in the first citation, which is the work to cite for the system.

**Citations**

- P. M. Anderson and A. A. Fouad, Power System Control and Stability, 2nd ed. Piscataway, NJ: IEEE Press; Hoboken, NJ: Wiley-Interscience, 2003, ISBN 0-471-23862-7, doi:10.1109/9780470545577. The system is the one of Chapter 2 and its Example 2.6. [DOI](https://doi.org/10.1109/9780470545577)
- B. Wang, Y. Liu and K. Sun, "Power System Differential-Algebraic Equations," arXiv:1512.05185, 2015. It prints the classical-model data of this system (H, x'd, the mechanical powers, the internal voltages and the reduced admittance matrix of Example 2.6) that the build of this case is checked against. [Link](https://arxiv.org/abs/1512.05185)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
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
- A workspace made by an earlier TENSA holds ANDES's steady-state wscc9.xlsx under this name. Adding this case does not replace that file unless you ask (the force option). The Example cases dialog marks it as a different file and offers to replace it, and tensa examples list says added, differs.

**Verification.** The data was checked against the book: the power flow solution (bus voltages, the generator angles and the slack's power) agrees with the one the book prints, to its printed precision, and the reduced admittance matrix and the initial state of the machines computed from the file agree with those of Example 2.6 as printed by Wang, Liu and Sun, to four decimals (server/tests/unit/test_wscc9_build.py). The power flow agrees with pandapower's solution of the same network to 2e-8 pu. The modes and the book's fault (a three-phase fault at bus 7, cleared after 5 cycles by opening line 5-7) were also computed independently of TENSA and ANDES (Kron reduction, the linearised swing equations, scipy's DOP853 integration), and TENSA agrees: the modes (1.383 and 2.126 Hz, undamped) to 5e-7 Hz, the largest rotor angle spread (85.8 degrees) to 0.004 degrees, the lowest bus voltage to 4e-6 pu and the lowest machine frequency to 1.1e-4 Hz. The undisturbed 10 s run does not move, and the ring-down of a load step has the frequencies of the eigenvalues within 0.034 Hz, which is what the trapezoidal rule's error at TENSA's default step comes to. Not compared: the swing curves of the book's figures, which no source opened gives as numbers, and no published value of the two modes was found. The run is stable and its swings do not die out, as those of an undamped model do not.

| Check | Compared with | Reference | Tolerance | Result | Passed |
| --- | --- | --- | --- | --- | --- |
| Ring-down of a small disturbance has the frequency and damping of eigenvalues | the ring-down of a time-domain run | matrix pencil poles of the machines' speeds in a time-domain run, against the eigenvalues of the same case at the same operating point; step of load PQ_0, run to 20 s | 0.05 Hz and 0.05 in damping ratio | 1.374 Hz, damping 0.000 is eigenvalue 1.383 Hz, 0.000 (0.009 Hz and 0.000 apart); 2.093 Hz, damping -0.000 is eigenvalue 2.126 Hz, 0.000 (0.034 Hz and 0.000 apart) | yes |
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
