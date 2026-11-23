# Citing TENSA

If TENSA is part of work you publish, please cite it, and cite ANDES, which does the computation.

## TENSA

GitHub's **Cite this repository** button, on the repository's front page, builds a citation from [`CITATION.cff`](https://github.com/Roger-GO/TENSA/blob/main/CITATION.cff), which names the author, the repository, the license and the version. As text:

> Gracia Otalvaro, R. TENSA: an interactive web workbench for power system simulation. https://doi.org/10.5281/zenodo.24451319

As BibTeX, with `version` set to the one you ran (`tensa --version` prints it) and `year` to the year of that release:

```bibtex
@software{gracia_otalvaro_tensa,
  author  = {Gracia Otalvaro, Rogelio},
  title   = {{TENSA}: an interactive web workbench for power system simulation},
  version = {X.Y.Z},
  year    = {2026},
  doi     = {10.5281/zenodo.24451319},
  url     = {https://github.com/Roger-GO/TENSA},
  license = {GPL-3.0-or-later}
}
```

TENSA's DOI is [10.5281/zenodo.24451319](https://doi.org/10.5281/zenodo.24451319). It covers every version and resolves to the newest release. Each release also has a DOI of its own on Zenodo. The DOI of version 0.7.0 is [10.5281/zenodo.24451320](https://doi.org/10.5281/zenodo.24451320).

## ANDES

TENSA runs on [ANDES](https://github.com/CURENT/andes), whose authors ask that work that uses it cite their paper:

> Cui, H., Li, F., and Tomsovic, K. (2021). Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis. IEEE Transactions on Power Systems, 36(2), 1373-1384. [doi:10.1109/TPWRS.2020.3017019](https://doi.org/10.1109/TPWRS.2020.3017019)

```bibtex
@article{cui2021andes,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

## An example case

Each example case has its own references: the paper that gives its system and, for some, the dataset its file comes from. The **Cite** button of a case in the **Example cases** dialog copies them as text or as BibTeX, and `tensa examples cite <id>` prints them (`--bibtex` for BibTeX). [Example cases](examples.md) lists them for every case, with the license each one is under.
