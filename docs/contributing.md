# Contributing to the docs

This site is built with [MkDocs](https://www.mkdocs.org/) and the [Material](https://squidfunk.github.io/mkdocs-material/) theme. The pages are Markdown files in `docs/`, and [`mkdocs.yml`](https://github.com/Roger-GO/TENSA/blob/main/mkdocs.yml) in the repository root lists them in the navigation.

## What is where

| Path | What it is |
| --- | --- |
| `docs/*.md` | The pages written by hand |
| `docs/img/` | Images: the screenshots of the UI tour, the logo and favicon, and the hero image |
| `docs/requirements.txt` | The packages the build needs besides TENSA itself |
| `mkdocs.yml` | The site's configuration and navigation |
| `scripts/docs_reference.py` | A MkDocs hook that writes the **Reference** pages |
| `web/scripts/docs-screenshots.mjs` | Takes the screenshots of the UI tour and the hero image |
| `.github/workflows/docs.yml` | Builds the site in CI, and publishes it once Pages is on |

The three pages under **Reference** (the command line, the API routes and the API models) are not files in `docs/`. The hook renders them while the site builds, from `tensa --help` and from the OpenAPI schema of the server, so they cannot drift from the code. To change one, change the help text of an option, or the description of a route or a field, in the source of the server, and not the page.

## Build the site

You need Python 3.12 or newer. Install the build tools and TENSA itself in one environment. TENSA has to be there because the hook imports it to read its schema. The UI does not need to be built.

=== "Linux and macOS"

    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r docs/requirements.txt -e ./server
    ```

=== "Windows (PowerShell)"

    ```powershell
    python -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install -r docs/requirements.txt -e ./server
    ```

Then, from the repository root:

```bash
mkdocs serve
```

serves the site at `http://127.0.0.1:8000` and rebuilds it when you save a page. The command that CI runs is

```bash
mkdocs build --strict
```

which writes the site to `site/` and turns every warning into a failure. A link to a page or a heading that does not exist is a warning, so a broken link fails the build.

## Writing pages

- One level-1 heading per page, the title. Give a page its place in `nav` in `mkdocs.yml`: a page that is not listed fails the strict build.
- Link to other pages with relative paths to the `.md` file (`[Install](install.md)`), and to a heading with its anchor (`concepts.md#trust-model`). Links to the repository go to GitHub with a full address.
- Plain sentences, in the voice of the other pages. No em dashes and no emoji.
- Give every code block its language. When a command differs on Windows, use the tabs the install page uses, with the PowerShell version beside the POSIX one.
- Name the buttons and menus as the UI does, in bold: **Run PF**, **Reset run**.
- A flag, a route or a menu item that a page names has to exist. The tests in `server/tests/unit/test_docs_site.py` check the `tensa` commands and flags the pages use, the links between pages, and that every page is in the navigation.

## Screenshots

The images of the UI tour, and the hero image of the first page and of the README, come from a script, so that they can be taken again after a change moves the layout. Start a server on a fresh workspace and run it:

```bash
tensa serve --port 18800 --workspace "$(mktemp -d)" --max-sessions 16
cd web
node scripts/docs-screenshots.mjs http://127.0.0.1:18800
```

It needs the built UI and Playwright's Chromium (`pnpm exec playwright install chromium`, once). It writes `ui-overview.jpg`, `ui-tds.jpg`, `ui-eig.jpg`, `ui-cpf.jpg` and `hero.jpeg` into `docs/img/`. The browser it drives is headless, so no window opens. Keep the images JPEG and under about 200 KB each. CI refuses a change that adds a file over 1 MiB, which [CONTRIBUTING.md](https://github.com/Roger-GO/TENSA/blob/main/CONTRIBUTING.md#media-and-other-large-files) explains.

## Publish on GitHub Pages

CI builds the site on every pull request and on pushes to `main`, and keeps the result as a downloadable artifact of the run. It does not publish it, because that takes a setting only the owner of the repository can change. To turn publishing on:

1. In the repository on GitHub, open **Settings**, then **Pages**, and under **Build and deployment** set the **Source** to **GitHub Actions**.
2. Open **Settings**, then **Secrets and variables**, then **Actions**, then the **Variables** tab, and add a repository variable named `DOCS_DEPLOY` with the value `true`.
3. Push to `main`, or run the **docs** workflow by hand from the **Actions** tab. The `deploy` job of the workflow publishes the site at `https://roger-go.github.io/TENSA/`.
4. Once the site is up, point the package at it: set `Documentation` under `[project.urls]` in `server/pyproject.toml` to `https://roger-go.github.io/TENSA/`, and change the test that pins the link (`test_the_documentation_link_of_the_package_is_a_page_that_exists` in `server/tests/unit/test_docs_site.py`) to match.

The site's address is the `site_url` in `mkdocs.yml`. The `Documentation` link of the package, which PyPI and `pip show` display, is the `docs` folder on GitHub until step 4, because the site's address answers 404 before the first publish. To stop publishing, delete the variable or set it to anything else.
