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
| [IEEE 39-bus New England system, with machines, controls and stabilisers](#ieee39) | 39 buses, 10 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [NPCC 140-bus, 48-machine system](#npcc) | 140 buses, 48 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [WECC 179-bus, 29-machine system](#wecc) | 179 buses, 29 generators | Power flow, Time domain, Eigenvalues | no | Your ANDES install |

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

- T. Athay, R. Podmore and S. Virmani, "A practical method for the direct analysis of transient stability," IEEE Transactions on Power Apparatus and Systems, vol. PAS-98, no. 2, pp. 573-584, March 1979, doi:10.1109/TPAS.1979.319407. The system's data are traced to this paper, and from it to G. W. Bills et al., On-Line Stability Analysis Study, EEI RP 90-1, 1970, by the header of MATPOWER's case39.m and by pandapower's documentation (neither work was opened for this entry). [DOI](https://doi.org/10.1109/TPAS.1979.319407)
- M. A. Pai, Energy Function Analysis for Power System Stability. Boston, MA: Kluwer Academic Publishers, 1989, doi:10.1007/978-1-4613-1635-0. The book MATPOWER's case39.m names as the source of its 39-bus data (the book itself was not opened). [DOI](https://doi.org/10.1007/978-1-4613-1635-0)
- MATPOWER, data/case39.m, release 8.0, https://github.com/MATPOWER/matpower/blob/8.0/data/case39.m (accessed 2026-11-17). Its header describes the 39-bus New England system as generally representative of the New England 345 kV system and gives the sources above. Used here only to compare the file with the system as MATPOWER holds it. [Link](https://github.com/MATPOWER/matpower/blob/8.0/data/case39.m)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
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
@misc{matpower_case39,
  title        = {{MATPOWER} case39: the 39-bus {New England} system},
  howpublished = {MATPOWER release 8.0, data/case39.m},
  url          = {https://github.com/MATPOWER/matpower/blob/8.0/data/case39.m},
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

- J. H. Chow and K. W. Cheung, "A toolbox for power system dynamics and control engineering education and research," IEEE Transactions on Power Systems, vol. 7, no. 4, pp. 1559-1564, 1992, doi:10.1109/59.207380. The paper on the Power System Toolbox, which distributes the 48-machine, 140-bus NPCC system: it is the work Qi, Sun and Kang cite for it (the next entry). The paper itself was not opened, so which of its pages describes the system is not stated here. [DOI](https://doi.org/10.1109/59.207380)
- J. Qi, K. Sun and W. Kang, "Adaptive optimal PMU placement based on empirical observability Gramian," arXiv:1411.7016 (section 5, case study). It tests on the NPCC 48-machine, 140-bus system, cites Chow and Cheung (1992) for it, calls it a model of the northeast region of the Eastern Interconnection and says that 27 of its 48 generators have a fourth-order transient model and the others the classical second-order one, which is what this file holds. [Link](https://arxiv.org/abs/1411.7016)
- H. Cui, ANDES documentation, Verification: CURENT NPCC verification notebook, ANDES release 2.0.0 (docs/source/verification/andes-npcc-verification.ipynb), https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-npcc-verification.ipynb (accessed 2026-11-17). It describes the system, its models and the line trip that ANDES was compared with DSATools TSAT on. [Link](https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-npcc-verification.ipynb)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
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
@misc{andes_npcc_verification,
  author       = {Cui, Hantao},
  title        = {{ANDES} documentation, Verification: NPCC verification notebook},
  howpublished = {ANDES release 2.0.0, docs/source/verification/andes-npcc-verification.ipynb},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-npcc-verification.ipynb},
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

- S. Maslennikov, B. Wang, Q. Zhang, F. Ma, X. Luo, K. Sun and E. Litvinov, "A test cases library for methods locating the sources of sustained oscillations," 2016 IEEE Power and Energy Society General Meeting (PESGM), Boston, MA, July 2016, doi:10.1109/PESGM.2016.7741772. The library is built on a modified WECC 179-bus, 29-machine system, and asks that publications that use its material cite this paper. This file is ANDES's, not the library's: it is cited because it describes the system, and whether the two files hold the same data was not checked. [DOI](https://doi.org/10.1109/PESGM.2016.7741772)
- Test Cases Library of Power System Sustained Oscillations, Department of Electrical Engineering and Computer Science, University of Tennessee, Knoxville, https://web.eecs.utk.edu/~kaisun/Oscillation/ (accessed 2026-11-17), and its model page, https://web.eecs.utk.edu/~kaisun/Oscillation/model.html, which says the system was first reported in an EPRI report (TR-104586, Projects 2675-04-05, Final Report, 1994; not opened) and that its inertia and damping data were created with reference to the WECC system and may not match the real one. [Link](https://web.eecs.utk.edu/~kaisun/Oscillation/)
- H. Cui, ANDES documentation, Verification: CURENT WECC verification notebook, ANDES release 2.0.0 (docs/source/verification/andes-wecc-verification.ipynb), https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-wecc-verification.ipynb (accessed 2026-11-17). It describes the system, its models and the line trip that ANDES was compared with DSATools TSAT on. [Link](https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-wecc-verification.ipynb)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
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
@misc{utk_oscillation_library,
  title        = {Test Cases Library of Power System Sustained Oscillations},
  howpublished = {University of Tennessee, Knoxville, Department of Electrical Engineering and Computer Science},
  url          = {https://web.eecs.utk.edu/~kaisun/Oscillation/},
  urldate      = {2026-11-17}
}
```

```bibtex
@misc{andes_wecc_verification,
  author       = {Cui, Hantao},
  title        = {{ANDES} documentation, Verification: WECC verification notebook},
  howpublished = {ANDES release 2.0.0, docs/source/verification/andes-wecc-verification.ipynb},
  url          = {https://github.com/CURENT/andes/blob/v2.0.0/docs/source/verification/andes-wecc-verification.ipynb},
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
