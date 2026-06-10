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

const BUSES = [
  { idx: '1', name: 'BUS1', Vn: 16.5 },
  { idx: '2', name: 'BUS2', Vn: 18 },
  { idx: '3', name: 'BUS3', Vn: 13.8 },
  { idx: '4', name: 'BUS4', Vn: 230 },
  { idx: '5', name: 'BUS5', Vn: 230 },
  { idx: '6', name: 'BUS6', Vn: 230 },
  { idx: '7', name: 'BUS7', Vn: 230 },
  { idx: '8', name: 'BUS8', Vn: 230 },
  { idx: '9', name: 'BUS9', Vn: 230 },
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
    idx: 'GENROU_1', name: 'G1 rotor', bus: '1', gen: '1', Sn: 100, Vn: 16.5, H: 23.64,
    adv: { D: 2 },
  },
  {
    idx: 'GENROU_2', name: 'G2 rotor', bus: '2', gen: '2', Sn: 100, Vn: 18, H: 6.4,
    adv: { D: 2 },
  },
  {
    idx: 'GENROU_3', name: 'G3 rotor', bus: '3', gen: '3', Sn: 100, Vn: 13.8, H: 3.01,
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

/** Update the on-screen caption banner (injected once via addInitScript). */
async function caption(page, title, sub = '') {
  await page.evaluate(
    ([t, s]) => window.__demoCaption?.(t, s),
    [title, sub],
  );
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
 * Add one element via the (already open) add panel: pick the kind, fill
 * required fields, optionally expand "Show advanced" for optional params,
 * submit, and wait for the server to accept it.
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
    window.__demoCaption = (title, sub) => {
      let el = document.getElementById('demo-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-caption';
        el.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
          'z-index:99999', 'max-width:880px', 'padding:14px 22px', 'border-radius:14px',
          'background:rgba(17,24,39,0.92)', 'color:#f9fafb', 'font:500 15px/1.45 system-ui,sans-serif',
          'box-shadow:0 8px 32px rgba(0,0,0,0.35)', 'pointer-events:none', 'text-align:center',
          'backdrop-filter:blur(6px)', 'transition:opacity 200ms',
        ].join(';');
        document.body.appendChild(el);
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
  await page.locator('[data-testid="first-run-coach-dismiss"]').click().catch(() => {});

  await caption(page, 'Building the IEEE 9-bus system from scratch',
    'Every step below uses the same HTTP API any script or LLM agent can call');
  await sleep(2800);

  // -- blank system via drag-and-drop ---------------------------------------
  await caption(page, 'Dragging a Bus onto the empty canvas',
    'This starts a blank system and opens the element builder');
  // Session creation is async on boot — the drop handler no-ops until the
  // session exists, so retry until the panel appears. The drop is dispatched
  // as a synthetic HTML5 DnD event carrying the app's component MIME type
  // (Playwright's mouse-based dragAndDrop fights the hover animation here).
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.locator('[data-testid="component-library-tile-Bus"]').hover().catch(() => {});
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('application/andes-component-type', 'Bus');
      const zone = document.querySelector('[data-testid="no-case-drop-zone"]');
      if (!zone) return;
      const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 420 };
      zone.dispatchEvent(new DragEvent('dragover', opts));
      zone.dispatchEvent(new DragEvent('drop', opts));
    });
    await sleep(1000);
    if (await page.locator('[data-testid="add-element-panel"]').isVisible().catch(() => false)) break;
  }
  await page.locator('[data-testid="add-element-panel"]').waitFor({ timeout: 5_000 });
  await sleep(800);

  // -- buses ----------------------------------------------------------------
  for (const [i, b] of BUSES.entries()) {
    await caption(page, `Adding buses — ${b.name} (${b.Vn} kV)`, `${i + 1} of 9`);
    await addElement(page, 'Bus', 'Bus', b);
  }

  // -- transformers ---------------------------------------------------------
  for (const t of TRANSFORMERS) {
    await caption(page, `Adding step-up transformer ${t.idx}`,
      `bus ${t.bus1} → ${t.bus2} · x = ${t.x} pu (Vn bases derived from the buses)`);
    const { tap, ...rest } = t;
    await addElement(page, 'Transformer2W', 'Line', rest, { tap });
  }

  // -- lines ----------------------------------------------------------------
  for (const l of LINES) {
    await caption(page, `Adding 230 kV line ${l.name}`, `r=${l.r} x=${l.x} b=${l.b} pu`);
    const { b, ...rest } = l;
    await addElement(page, 'Line', 'Line', rest, { b });
  }

  // -- loads ----------------------------------------------------------------
  for (const d of LOADS) {
    await caption(page, `Adding load at bus ${d.bus}`, `${d.p0 * 100} MW / ${d.q0 * 100} MVAr`);
    await addElement(page, 'PQ', 'PQ', d);
  }

  // -- static generators ----------------------------------------------------
  for (const g of MACHINES) {
    const { kind, ...rest } = g;
    await caption(page, `Adding ${kind === 'Slack' ? 'slack' : 'PV'} generator ${g.name} at bus ${g.bus}`,
      kind === 'Slack' ? 'V = 1.04 pu reference' : `P = ${rest.p0 * 100} MW, V = ${rest.v0} pu`);
    await addElement(page, kind, kind, rest);
  }

  // -- synchronous machines -------------------------------------------------
  for (const m of GENROUS) {
    const { adv, ...rest } = m;
    await caption(page, `Adding round-rotor model ${m.idx}`,
      `H = ${m.H} s, D = 2 (UI converts H → M = 2H for ANDES)`);
    await addElement(page, 'GENROU', 'GENROU', rest, adv);
  }

  // -- exciters + governors -------------------------------------------------
  for (const e of EXCITERS) {
    const { kind, ...rest } = e;
    await caption(page, `Attaching exciter ${kind} to ${e.syn}`, 'voltage regulation for the machine');
    await addElement(page, kind, kind, rest);
  }
  for (const g of GOVERNORS) {
    await caption(page, `Attaching governor TGOV1 to ${g.syn}`, 'speed / frequency regulation');
    await addElement(page, 'TGOV1', 'TGOV1', g);
  }

  // -- close panel, admire the diagram --------------------------------------
  await page.getByRole('button', { name: /^cancel$/i }).click().catch(() => {});
  await page.locator('button[aria-label="Fit View"]').click().catch(() => {});
  await caption(page, '30 elements added — the complete WSCC 9-bus system',
    '9 buses · 3 transformers · 6 lines · 3 loads · 3 machines · 3 exciters · 3 governors');
  await sleep(3500);

  // -- power flow -----------------------------------------------------------
  await caption(page, 'Running power flow', 'Newton-Raphson on the system we just built');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/pflow') && r.request().method() === 'POST'),
    page.locator('[data-testid="run-pflow-button"]').click(),
  ]);
  await sleep(2500);
  await caption(page, 'Power flow converged', 'Bus voltages and angles land on the diagram and in the results grid');
  await sleep(3000);

  // -- fault + TDS ----------------------------------------------------------
  await caption(page, 'Adding a disturbance', 'Three-phase fault at bus 7, applied t = 1.0 s, cleared t = 1.083 s');
  await page.locator('[data-testid="bus-node-7"]').click();
  await page.locator('[data-testid="right-inspector-section-trigger-disturbances"]').click();
  await page.locator('[data-testid="disturbances-accordion-add"]').click();
  await page.locator('[data-testid="add-event-dialog"]').waitFor();
  // Bus 7 is pre-selected from context; tweak the clearing time (5 cycles).
  await page.getByLabel(/tc — fault cleared/).fill('1.083').catch(() => {});
  await sleep(900);
  await page.locator('[data-testid="add-event-save"]').click();
  await sleep(1200);

  await caption(page, 'Running time-domain simulation', 'Live Arrow-IPC streaming over WebSocket — watch the run badge');
  await page.locator('[data-testid="run-tds-button"]').click();
  await page.waitForSelector('text=/Done at t=/', { timeout: 180_000 });
  await sleep(1500);

  // -- results view ---------------------------------------------------------
  await caption(page, 'Opening the full-screen results view', 'Bus voltages auto-selected — fault dip and recovery at a glance');
  await page.locator('button[aria-label*="Maximize results"]').click();
  await sleep(4500);

  // -- reset + PF + EIG -----------------------------------------------------
  await caption(page, 'Resetting the run for small-signal analysis', 'EIG needs a clean operating point');
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
  await caption(page, 'Running continuation power flow', 'Loadability margin of the system we built');
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
  await caption(page, 'Running eigenvalue analysis', 'Linearising the DAE — modes, damping, participation factors');
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
  await caption(page, 'Every mode is stable and well damped',
    '"All modes" widens the scatter filter to the full eigenvalue set');
  await page.locator('[data-testid="eig-scatter-filter-toggle"]').click().catch(() => {});
  await sleep(4500);

  // -- outro ----------------------------------------------------------------
  await caption(page, 'IEEE 9-bus: built, solved, faulted, simulated, analysed',
    'Everything you just watched is plain HTTP + WebSocket — see /docs, llms.txt, and the MCP server');
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
      execFileSync('ffmpeg', ['-y', '-i', finalWebm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', mp4], {
        stdio: 'ignore',
      });
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
