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

## The cases

| Case | Size | Analyses | First run | Source |
| --- | --- | --- | --- | --- |
| [IEEE 14-bus, with machines and controls](#ieee14) | 14 buses, 5 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [Kundur two-area system, modified by ANDES](#kundur) | 10 buses, 4 generators | Power flow, Time domain, Eigenvalues | yes | Your ANDES install |
| [WSCC 9-bus, network only](#wscc9) | 9 buses, 3 generators | Power flow | yes | Your ANDES install |

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

- The dynamic data was written for ANDES (by H. Cui, according to the ANDES cases README) and is not published by the IEEE.
- The power flow data is a PSS/E version prepared by J. Conto and distributed with ANDES. It has not been compared with the data of the University of Washington archive.

**Verification.** No verification is recorded for this case yet.

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

- This is not the system of the book as printed. The file's own title is "Modified Kundur's two-area test system, distributed with ANDES", and it has 10 buses where the book's system has 11. Do not compare its results with the book's without checking the data.
- One event is built into the file: Line_8 is switched out at 2 s.

**Verification.** No verification is recorded for this case yet.

### WSCC 9-bus, network only { #wscc9 }

The WSCC 3-machine, 9-bus network with its loads and generator set-points, for power flow. The file has no machine models, so there is nothing to simulate in the time domain.

- **Id:** `wscc9`
- **Kind:** Steady state
- **Size:** 9 buses, 3 generators
- **Analyses:** Power flow
- **First run:** yes
- **File:** `wscc9.xlsx`

**Source.** Copied from your own ANDES installation (`andes/cases/wscc9/wscc9.xlsx`); TENSA does not redistribute it. The catalog recorded the file as of ANDES 2.0.0, with SHA-256 `1e994b2b4c67bdcccf52b9007cf03c5c010f6ff72bcfe055c4c3b776baf51de8`, and warns when the file on your machine is a different one. The recorded file is from <https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/wscc9/wscc9.xlsx>, retrieved 2026-11-17.

**Licence.** [GPL-3.0-or-later](https://github.com/CURENT/andes/blob/v2.0.0/LICENSE). ANDES asks that research or consulting that uses it cite its paper, which is among the citations of this case (ANDES README, section Citing ANDES).

**Citations**

- P. M. Anderson and A. A. Fouad, Power System Control and Stability. IEEE Press, 2002, doi:10.1109/9780470545577. [DOI](https://doi.org/10.1109/9780470545577)
- H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," IEEE Transactions on Power Systems, vol. 36, no. 2, pp. 1373-1384, March 2021, doi:10.1109/TPWRS.2020.3017019. [DOI](https://doi.org/10.1109/TPWRS.2020.3017019)

BibTeX:

```bibtex
@book{anderson2002power,
  author    = {Anderson, Paul M. and Fouad, A. A.},
  title     = {Power System Control and Stability},
  publisher = {IEEE Press},
  year      = {2002},
  doi       = {10.1109/9780470545577}
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

- ANDES does not say where the data of this file comes from. The first citation names the book the WSCC 9-bus system is taken from, not the file.

**Verification.** No verification is recorded for this case yet.
