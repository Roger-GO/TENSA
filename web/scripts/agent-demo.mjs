/**
 * Agent showcase demo — records a video of an AI agent building the WSCC
 * IEEE 9-bus system from scratch through the real UI, then running power
 * flow, a fault + time-domain simulation, eigenvalue analysis, and CPF.
 *
 * Prereqs: a running server with the built SPA, e.g.
 *   andes-app serve --port 18800 --workspace /tmp/oss-ws
 *
 * Run:
 *   cd web && node scripts/agent-demo.mjs [baseUrl]
 *
 * Output: demo-video/ieee9-agent-demo.webm (plus .mp4 if ffmpeg is on PATH).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:18800';
const OUT_DIR = 'demo-video';
const SIZE = { width: 1600, height: 900 };

// ---------------------------------------------------------------------------
// WSCC 3-machine, 9-bus test system (Anderson & Fouad), pu on 100 MVA.
// ---------------------------------------------------------------------------

// `at` is the canvas drop position (client px) — buses are placed by
// dragging the Bus tile onto the canvas, so the agent lays out the diagram
// by hand the way a human would. Positions trace the canonical WSCC 9-bus
// one-line: generator buses 2/3 at the top corners, the 230 kV chain
// 7-8-9 across the middle, 5/6 below, and bus 4 → bus 1 (G1) down the
// centre. The panel sits on the right (~420px), so drops stay left of ~1130.
const BUSES = [
  { idx: '2', name: 'BUS2', Vn: 18, at: [440, 175] }, // G2, top-left
  { idx: '3', name: 'BUS3', Vn: 13.8, at: [1040, 175] }, // G3, top-right
  { idx: '7', name: 'BUS7', Vn: 230, at: [440, 305] },
  { idx: '8', name: 'BUS8', Vn: 230, at: [740, 305] }, // Load C
  { idx: '9', name: 'BUS9', Vn: 230, at: [1040, 305] },
  { idx: '5', name: 'BUS5', Vn: 230, at: [560, 425] }, // Load A
  { idx: '6', name: 'BUS6', Vn: 230, at: [920, 425] }, // Load B
  { idx: '4', name: 'BUS4', Vn: 230, at: [740, 470] },
  { idx: '1', name: 'BUS1', Vn: 16.5, at: [740, 560] }, // G1, bottom-centre
];

const TRANSFORMERS = [
  { idx: 'T1', name: 'T1 (G1)', bus1: '1', bus2: '4', r: 0, x: 0.0576, tap: 1 },
  { idx: 'T2', name: 'T2 (G2)', bus1: '2', bus2: '7', r: 0, x: 0.0625, tap: 1 },
  { idx: 'T3', name: 'T3 (G3)', bus1: '3', bus2: '9', r: 0, x: 0.0586, tap: 1 },
];

const LINES = [
  { idx: 'L45', name: 'Line 4-5', bus1: '4', bus2: '5', r: 0.01, x: 0.085, b: 0.176 },
  { idx: 'L46', name: 'Line 4-6', bus1: '4', bus2: '6', r: 0.017, x: 0.092, b: 0.158 },
  { idx: 'L57', name: 'Line 5-7', bus1: '5', bus2: '7', r: 0.032, x: 0.161, b: 0.306 },
  { idx: 'L69', name: 'Line 6-9', bus1: '6', bus2: '9', r: 0.039, x: 0.17, b: 0.358 },
  { idx: 'L78', name: 'Line 7-8', bus1: '7', bus2: '8', r: 0.0085, x: 0.072, b: 0.149 },
  { idx: 'L89', name: 'Line 8-9', bus1: '8', bus2: '9', r: 0.0119, x: 0.1008, b: 0.209 },
];

const LOADS = [
  { idx: 'PQ5', name: 'Load A', bus: '5', Vn: 230, p0: 1.25, q0: 0.5 },
  { idx: 'PQ6', name: 'Load B', bus: '6', Vn: 230, p0: 0.9, q0: 0.3 },
  { idx: 'PQ8', name: 'Load C', bus: '8', Vn: 230, p0: 1.0, q0: 0.35 },
];

const MACHINES = [
  // kind Slack/PV → static gen; GENROU rides on top via the gen link.
  { kind: 'Slack', idx: '1', name: 'G1', bus: '1', Sn: 100, Vn: 16.5, v0: 1.04 },
  { kind: 'PV', idx: '2', name: 'G2', bus: '2', Sn: 100, Vn: 18, p0: 1.63, v0: 1.025 },
  { kind: 'PV', idx: '3', name: 'G3', bus: '3', Sn: 100, Vn: 13.8, p0: 0.85, v0: 1.025 },
];

const GENROUS = [
  {
    idx: 'GENROU_1',
    name: 'G1 rotor',
    bus: '1',
    gen: '1',
    Sn: 100,
    Vn: 16.5,
    H: 23.64,
    adv: { D: 2 },
  },
  {
    idx: 'GENROU_2',
    name: 'G2 rotor',
    bus: '2',
    gen: '2',
    Sn: 100,
    Vn: 18,
    H: 6.4,
    adv: { D: 2 },
  },
  {
    idx: 'GENROU_3',
    name: 'G3 rotor',
    bus: '3',
    gen: '3',
    Sn: 100,
    Vn: 13.8,
    H: 3.01,
    adv: { D: 2 },
  },
];

const EXCITERS = [
  { kind: 'EXST1', idx: 'EXST1_1', name: 'AVR G1', syn: 'GENROU_1' },
  { kind: 'SEXS', idx: 'SEXS_2', name: 'AVR G2', syn: 'GENROU_2' },
  { kind: 'SEXS', idx: 'SEXS_3', name: 'AVR G3', syn: 'GENROU_3' },
];

const GOVERNORS = [
  { idx: 'TGOV1_1', name: 'GOV G1', syn: 'GENROU_1' },
  { idx: 'TGOV1_2', name: 'GOV G2', syn: 'GENROU_2' },
  { idx: 'TGOV1_3', name: 'GOV G3', syn: 'GENROU_3' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Update the on-screen caption banner (injected once via addInitScript).
 * ``pos`` is 'bottom' (default) or 'top' — use 'top' over the results view
 * so the banner never covers the plot / scrub / variable picker.
 */
async function caption(page, title, sub = '', pos = 'bottom') {
  await page.evaluate(([t, s, p]) => window.__demoCaption?.(t, s, p), [title, sub, pos]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fill one form field inside the add-element panel. */
async function fillField(page, name, value) {
  const wrap = page.locator(`[data-testid="field-${name}"]`);
  const select = wrap.locator('select');
  if (await select.count()) {
    await select.selectOption(String(value));
  } else {
    const input = wrap.locator('input');
    await input.fill(String(value));
  }
}

/**
 * Drag a Component-Library tile onto the canvas at (clientX, clientY).
 * Dispatches the app's synthetic HTML5 DnD payload (Playwright's
 * mouse-drag fights React Flow's pane panning). The drop opens — or
 * switches — the Add Element panel to that tile's kind, seeding the bus
 * drop coordinate. Before any case exists the target is the no-case
 * drop zone; afterwards it's the live React Flow pane.
 */
async function dragTileToCanvas(page, tile, x, y) {
  await page
    .locator(`[data-testid="component-library-tile-${tile}"]`)
    .hover()
    .catch(() => {});
  await page.evaluate(
    ([t, cx, cy]) => {
      const dt = new DataTransfer();
      dt.setData('application/andes-component-type', t);
      const zone =
        document.querySelector('.react-flow__pane') ||
        document.querySelector('[data-testid="no-case-drop-zone"]');
      if (!zone) return;
      const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      zone.dispatchEvent(new DragEvent('dragover', opts));
      zone.dispatchEvent(new DragEvent('drop', opts));
    },
    [tile, x, y],
  );
}

/**
 * Fill the (already open) add panel: pick the kind, fill required
 * fields, optionally expand "Show advanced" for optional params, submit,
 * and wait for the server to accept it.
 */
async function addElement(page, kind, submitModel, fields, advFields = null) {
  await page.locator('[data-testid="add-element-kind"]').selectOption(kind);
  await page.locator(`[data-testid="element-form-${submitModel}"]`).waitFor();
  for (const [name, value] of Object.entries(fields)) {
    await fillField(page, name, value);
  }
  if (advFields) {
    await page.locator('[data-testid="form-advanced-disclosure"]').click();
    for (const [name, value] of Object.entries(advFields)) {
      await fillField(page, name, value);
    }
  }
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/elements') && r.request().method() === 'POST'),
    page.getByRole('button', { name: `Add ${submitModel}`, exact: true }).click(),
  ]);
  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`add ${kind} ${fields.idx ?? ''} failed: HTTP ${resp.status()} ${body}`);
  }
  // Form remounts with fresh defaults after a successful add.
  await sleep(120);
}

/** Drag a React Flow node by its testid to a new client position. */
async function moveNode(page, testid, toX, toY) {
  const node = page.locator(`[data-testid="${testid}"]`);
  const box = await node.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 18 });
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, slowMo: 40 });
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: OUT_DIR, size: SIZE },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  // Caption overlay — survives React re-renders (lives on document.body).
  await page.addInitScript(() => {
    window.__demoCaption = (title, sub, pos) => {
      let el = document.getElementById('demo-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-caption';
        el.style.cssText = [
          'position:fixed',
          'left:50%',
          'transform:translateX(-50%)',
          'z-index:99999',
          'max-width:880px',
          'padding:14px 22px',
          'border-radius:14px',
          'background:rgba(17,24,39,0.92)',
          'color:#f9fafb',
          'font:500 15px/1.45 system-ui,sans-serif',
          'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
          'pointer-events:none',
          'text-align:center',
          'backdrop-filter:blur(6px)',
          'transition:opacity 200ms',
        ].join(';');
        document.body.appendChild(el);
      }
      // Place at the bottom by default, or just under the results header
      // ('top') so it never covers the plot / scrub / variable picker.
      if (pos === 'top') {
        el.style.top = '52px';
        el.style.bottom = '';
      } else {
        el.style.bottom = '28px';
        el.style.top = '';
      }
      el.innerHTML =
        `<div style="display:flex;align-items:center;gap:10px;justify-content:center">` +
        `<span style="background:#2563eb;border-radius:6px;padding:2px 8px;font-size:11px;letter-spacing:.06em">AI&nbsp;AGENT</span>` +
        `<span style="font-size:16px;font-weight:600">${title}</span></div>` +
        (sub ? `<div style="margin-top:4px;font-size:13px;color:#d1d5db">${sub}</div>` : '');
    };
  });

  console.log(`[demo] navigating to ${BASE_URL}`);
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.locator('[data-testid="no-case-drop-zone"]').waitFor();
  await page
    .locator('[data-testid="first-run-coach-dismiss"]')
    .click()
    .catch(() => {});

  await caption(
    page,
    'Building the IEEE 9-bus system from scratch',
    'Every step below uses the same HTTP API any script or LLM agent can call',
  );
  await sleep(2800);

  // -- first bus: drag onto the empty canvas to start the system ------------
  await caption(
    page,
    'Dragging the first Bus onto the empty canvas',
    'This starts a blank system and opens the element builder',
  );
  // Session creation is async on boot — the drop handler no-ops until the
  // session exists, so retry until the panel appears.
  for (let attempt = 0; attempt < 15; attempt++) {
    await dragTileToCanvas(page, 'Bus', BUSES[0].at[0], BUSES[0].at[1]);
    await sleep(1000);
    if (
      await page
        .locator('[data-testid="add-element-panel"]')
        .isVisible()
        .catch(() => false)
    )
      break;
  }
  await page.locator('[data-testid="add-element-panel"]').waitFor({ timeout: 5_000 });
  await sleep(700);

  // -- buses: each one dragged to its own spot on the canvas ----------------
  for (const [i, b] of BUSES.entries()) {
    await caption(page, `Placing ${b.name} (${b.Vn} kV) on the canvas`, `bus ${i + 1} of 9`);
    if (i > 0) {
      // Switch the open panel to a fresh Bus drop at this position.
      await dragTileToCanvas(page, 'Bus', b.at[0], b.at[1]);
      await sleep(500);
    }
    await addElement(page, 'Bus', 'Bus', { idx: b.idx, name: b.name, Vn: b.Vn });
  }

  // -- arrange the buses into the canonical WSCC 9-bus one-line shape -------
  // Auto-layout drops new buses in a grid; the agent drags each one into the
  // textbook arrangement (gen buses 2/3 at the top corners, the 230 kV chain
  // 7-8-9 across the middle, 5/6 below, 4 → 1 down the centre). Real node
  // drags persist via the same path a user's drag uses.
  // Short per-action timeouts so a missed control fails fast (default 30s).
  const tap = (sel) =>
    page
      .locator(sel)
      .click({ timeout: 2500 })
      .catch(() => {});
  // Close the builder so the canvas reflows to full width before arranging.
  await page
    .getByRole('button', { name: /^cancel$/i })
    .click()
    .catch(() => {});
  await sleep(600);
  await tap('button[aria-label="Fit View"]');
  await sleep(1000);
  await caption(
    page,
    'Arranging the buses into the IEEE-9 one-line shape',
    'Dragging each node into place — the layout is yours to lay out',
  );
  // Canonical target positions (client px, panel closed). Keyed by bus idx.
  const CANON = {
    2: [480, 175],
    3: [1075, 175],
    7: [480, 325],
    8: [780, 325],
    9: [1075, 325],
    5: [610, 445],
    6: [950, 445],
    4: [780, 495],
    1: [780, 575],
  };
  for (const idx of [1, 4, 5, 6, 8, 7, 9, 2, 3]) {
    const [x, y] = CANON[idx];
    await moveNode(page, `bus-node-${idx}`, x, y).catch(() => {});
    await sleep(280);
  }
  await sleep(600);
  await tap('button[aria-label="Fit View"]');
  await sleep(1100);

  // -- transformers (drag the Transformer tile) -----------------------------
  for (const t of TRANSFORMERS) {
    await caption(
      page,
      `Adding step-up transformer ${t.idx}`,
      `bus ${t.bus1} → ${t.bus2} · x = ${t.x} pu (Vn bases derived from the buses)`,
    );
    await dragTileToCanvas(page, 'Transformer', 360, 250);
    await sleep(450);
    const { tap, ...rest } = t;
    await addElement(page, 'Transformer2W', 'Line', rest, { tap });
  }

  // -- lines (drag the Line tile) -------------------------------------------
  for (const l of LINES) {
    await caption(page, `Adding 230 kV line ${l.name}`, `r=${l.r} x=${l.x} b=${l.b} pu`);
    await dragTileToCanvas(page, 'Line', 360, 250);
    await sleep(400);
    const { b, ...rest } = l;
    await addElement(page, 'Line', 'Line', rest, { b });
  }

  // -- loads (drag the Load tile) -------------------------------------------
  for (const d of LOADS) {
    await caption(page, `Adding load at bus ${d.bus}`, `${d.p0 * 100} MW / ${d.q0 * 100} MVAr`);
    await dragTileToCanvas(page, 'Load', 360, 250);
    await sleep(400);
    await addElement(page, 'PQ', 'PQ', d);
  }

  // -- generators + machines + controllers (drag the Generator tile) --------
  for (const g of MACHINES) {
    const { kind, ...rest } = g;
    await caption(
      page,
      `Adding ${kind === 'Slack' ? 'slack' : 'PV'} generator ${g.name} at bus ${g.bus}`,
      kind === 'Slack' ? 'V = 1.04 pu reference' : `P = ${rest.p0 * 100} MW, V = ${rest.v0} pu`,
    );
    await dragTileToCanvas(page, 'Generator', 360, 250);
    await sleep(400);
    await addElement(page, kind, kind, rest);
  }
  for (const m of GENROUS) {
    const { adv, ...rest } = m;
    await caption(
      page,
      `Adding round-rotor model ${m.idx}`,
      `H = ${m.H} s, D = 2 (UI converts H → M = 2H for ANDES)`,
    );
    await dragTileToCanvas(page, 'Generator', 360, 250);
    await sleep(400);
    await addElement(page, 'GENROU', 'GENROU', rest, adv);
  }
  for (const e of EXCITERS) {
    const { kind, ...rest } = e;
    await caption(page, `Attaching exciter ${kind} to ${e.syn}`, 'voltage regulation');
    await dragTileToCanvas(page, 'Generator', 360, 250);
    await sleep(400);
    await addElement(page, kind, kind, rest);
  }
  for (const g of GOVERNORS) {
    await caption(page, `Attaching governor TGOV1 to ${g.syn}`, 'speed / frequency regulation');
    await dragTileToCanvas(page, 'Generator', 360, 250);
    await sleep(400);
    await addElement(page, 'TGOV1', 'TGOV1', g);
  }

  // -- close panel, fit the whole diagram into view ------------------------
  // Close the builder FIRST so Fit View frames the full canvas width (with
  // the panel open it would fit only the left ~1130px and push the
  // generators off-screen). Fit twice with a beat between so the second
  // fit accounts for the reflow after the panel collapses.
  await page
    .getByRole('button', { name: /^cancel$/i })
    .click()
    .catch(() => {});
  await sleep(700);
  await page
    .locator('button[aria-label="Fit View"]')
    .click({ timeout: 2500 })
    .catch(() => {});
  await sleep(600);
  await page
    .locator('button[aria-label="Fit View"]')
    .click({ timeout: 2500 })
    .catch(() => {});
  await caption(
    page,
    '30 elements added — the complete WSCC 9-bus system',
    '9 buses · 3 transformers · 6 lines · 3 loads · 3 machines · 3 exciters · 3 governors',
  );
  await sleep(3000);

  // -- save the case to a file, then reload it from the workspace -----------
  await caption(page, 'Saving the system to a file', 'Workspace → Save system → wscc9-built.xlsx');
  await page.locator('[data-testid="topbar-menu-workspace-trigger"]').click();
  await sleep(500);
  await page.locator('[data-testid="save-system-button"]').click();
  await sleep(700);
  await page.locator('[data-testid="save-filename"]').fill('wscc9-built');
  await sleep(500);
  await Promise.all([
    page
      .waitForResponse((r) => r.url().includes('/save') && r.request().method() === 'POST', {
        timeout: 30_000,
      })
      .catch(() => {}),
    page.locator('[data-testid="save-confirm"]').click(),
  ]);
  await sleep(2000);

  await caption(
    page,
    'Reloading the saved case from the workspace',
    'Round-trips through ANDES — the same system, read back from disk',
  );
  await page
    .locator('[data-testid="saved-cases-row-wscc9-built.xlsx"]')
    .click()
    .catch(() => {});
  await sleep(3000);
  await page
    .locator('button[aria-label="Fit View"]')
    .click({ timeout: 2500 })
    .catch(() => {});
  await sleep(800);

  // -- power flow -----------------------------------------------------------
  await caption(page, 'Running power flow', 'Newton-Raphson on the system we just built');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/pflow') && r.request().method() === 'POST'),
    page.locator('[data-testid="run-pflow-button"]').click(),
  ]);
  await sleep(2500);
  await caption(
    page,
    'Power flow converged',
    'Bus voltages and angles land on the diagram and in the results grid',
  );
  await sleep(3000);

  // -- fault + TDS ----------------------------------------------------------
  await caption(
    page,
    'Adding a disturbance',
    'Three-phase fault at bus 7, applied t = 1.0 s, cleared t = 1.083 s',
  );
  await page.locator('[data-testid="bus-node-7"]').click();
  await page.locator('[data-testid="right-inspector-section-trigger-disturbances"]').click();
  await page.locator('[data-testid="disturbances-accordion-add"]').click();
  await page.locator('[data-testid="add-event-dialog"]').waitFor();
  // Bus 7 is pre-selected from context; tweak the clearing time (5 cycles).
  await page
    .getByLabel(/tc — fault cleared/)
    .fill('1.083')
    .catch(() => {});
  await sleep(900);
  await page.locator('[data-testid="add-event-save"]').click();
  await sleep(1200);

  await caption(
    page,
    'Running time-domain simulation',
    'Live Arrow-IPC streaming over WebSocket — watch the run badge',
  );
  await page.locator('[data-testid="run-tds-button"]').click();
  await page.waitForSelector('text=/Done at t=/', { timeout: 180_000 });
  await sleep(1500);

  // -- results view ---------------------------------------------------------
  await caption(
    page,
    'Opening the full-screen results view',
    'Bus voltages auto-selected — fault dip and recovery at a glance',
    'top',
  );
  await page.locator('button[aria-label*="Maximize results"]').click();
  await sleep(4500);

  // -- reset + PF + EIG -----------------------------------------------------
  await caption(
    page,
    'Resetting the run for small-signal analysis',
    'EIG needs a clean operating point',
    'top',
  );
  await page.getByRole('button', { name: /reset run/i }).click();
  await sleep(2500);
  // The run-mode toggle is still on TDS after the reset — flip back to PF.
  await page.locator('[data-testid="run-mode-pf"]').click();
  await page.locator('[data-testid="run-pflow-button"]').waitFor({ timeout: 30_000 });
  await sleep(1500); // let the case reload settle so the button is enabled
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/pflow') && r.request().method() === 'POST', {
      timeout: 60_000,
    }),
    page.locator('[data-testid="run-pflow-button"]').click(),
  ]);
  await sleep(1200);

  // -- CPF (before EIG — eigenanalysis mutates the dae) ----------------------
  await caption(
    page,
    'Running continuation power flow',
    'Loadability margin of the system we built',
    'top',
  );
  await page.getByRole('tab', { name: 'CPF' }).click();
  await sleep(800);
  const cpfRun = page.locator('[data-testid="analyze-run-cpf"]');
  if (await cpfRun.isEnabled().catch(() => false)) {
    await Promise.all([
      page
        .waitForResponse((r) => r.url().includes('/cpf') && r.request().method() === 'POST', {
          timeout: 120_000,
        })
        .catch(() => {}),
      cpfRun.click(),
    ]);
    await sleep(4500);
  }

  // -- EIG (last — it mutates the linearised dae) -----------------------------
  await caption(
    page,
    'Running eigenvalue analysis',
    'Linearising the DAE — modes, damping, participation factors',
    'top',
  );
  await page.getByRole('tab', { name: 'EIG' }).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/eig') && r.request().method() === 'POST', {
      timeout: 120_000,
    }),
    page.locator('[data-testid="analyze-run-eig"]').click(),
  ]);
  await sleep(2000);
  // Every mode of this well-damped system is hidden by the default
  // "poorly damped only" scatter filter — widen it to show all modes.
  await caption(
    page,
    'Every mode is stable and well damped',
    '"All modes" widens the scatter filter to the full eigenvalue set',
    'top',
  );
  await page
    .locator('[data-testid="eig-scatter-filter-toggle"]')
    .click()
    .catch(() => {});
  await sleep(4500);

  // -- outro ----------------------------------------------------------------
  await caption(
    page,
    'IEEE 9-bus: built, solved, faulted, simulated, analysed',
    'Everything you just watched is plain HTTP + WebSocket — see /docs, llms.txt, and the MCP server',
    'top',
  );
  await sleep(4000);

  await context.close(); // flushes the video
  await browser.close();

  // Rename the (random-named) video and convert to mp4 when ffmpeg exists.
  // Pick the NEWEST recording — earlier aborted runs may have left files.
  const webm = readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('page@') && f.endsWith('.webm'))
    .map((f) => ({ f, mtime: statSync(join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.f;
  if (webm) {
    const finalWebm = join(OUT_DIR, 'ieee9-agent-demo.webm');
    renameSync(join(OUT_DIR, webm), finalWebm);
    console.log(`[demo] video: ${finalWebm}`);
    try {
      const mp4 = join(OUT_DIR, 'ieee9-agent-demo.mp4');
      execFileSync(
        'ffmpeg',
        ['-y', '-i', finalWebm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', mp4],
        {
          stdio: 'ignore',
        },
      );
      console.log(`[demo] video: ${mp4}`);
    } catch {
      console.log('[demo] ffmpeg not available — webm only');
    }
  }
}

main().catch((err) => {
  console.error('[demo] FAILED:', err);
  process.exit(1);
});
