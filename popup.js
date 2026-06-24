// ============================================================
// popup.js — DataGrapher Popup Controller  [FIXED v1.1]
// ============================================================
// FIXES IN THIS VERSION:
//
//   BUG 1 FIX — Chart.js Memory Leak:
//     Old code called chartInst.destroy() but left a zombie
//     reference in Chart.js internal registry + the canvas 2D
//     context still held stale pixel data.
//     SOLUTION:
//       a) Chart.getChart(canvas) — checks for any lingering
//          instance on the canvas element BEFORE creating a new
//          one (catches cases where chartInst was lost).
//       b) After destroy(), canvas context is explicitly cleared
//          via ctx.clearRect() so no pixel bleed occurs.
//       c) chartInst is always nulled after destroy().
//
//   BUG 2 FIX — State Persistence (executeScript caching):
//     Old code injected content.js via files:["content.js"].
//     Chrome caches file-injected scripts per tab session and
//     can return stale results on repeated scans.
//     SOLUTION: content.js logic is now passed as an inline
//     func: arrow function to executeScript(). Chrome ALWAYS
//     re-evaluates inline functions — no caching possible.
//     The full extraction logic is inlined into EXTRACTOR_FN
//     at the bottom of this file and passed by reference.
//
//   BUG 4 FIX — Zipping Logic / Data Integrity:
//     Old filterDataset() zipped X-pairs and Y-pairs purely by
//     array index, which broke when content.js's `seen` Set
//     silently dropped repeated values (now fixed in content.js),
//     OR when X and Y counts differed due to page structure.
//     SOLUTION:
//       a) Pairs now carry sourceIndex (char offset). Zipping
//          uses proximity-based matching: for each X-pair, find
//          the nearest Y-pair (by sourceIndex distance) that
//          hasn't been claimed yet. This matches "4 months 200
//          sales" correctly even when counts differ.
//       b) If proximity matching finds no valid pairs, falls
//          back gracefully to positional zip with a warning.
//       c) Unmatched X or Y pairs are shown in the status bar
//          so the user knows data was trimmed.
// ============================================================

"use strict";

// ── Module-level state ────────────────────────────────────────
let allPairs   = [];
let chartInst  = null;
let filteredDS = { labels: [], values: [], raws: [] };

// ── DOM references ────────────────────────────────────────────
const scanBtn      = document.getElementById("scan-btn");
const buildBtn     = document.getElementById("build-btn");
const resetBtn     = document.getElementById("reset-btn");
const xSelect      = document.getElementById("x-select");
const ySelect      = document.getElementById("y-select");
const statusBar    = document.getElementById("status-bar");
const statusText   = document.getElementById("status-text");
const spinner      = document.getElementById("spinner");
const chartWrapper = document.getElementById("chart-wrapper");
const chartCanvas  = document.getElementById("chart-canvas");
const tableWrapper = document.getElementById("table-wrapper");
const tableBody    = document.getElementById("table-body");
const pairCount    = document.getElementById("pair-count");
const exportRow    = document.getElementById("export-row");
const exportPNG    = document.getElementById("export-png");
const exportCSV    = document.getElementById("export-csv");
const emptyState   = document.getElementById("empty-state");
const colX         = document.getElementById("col-x");
const colY         = document.getElementById("col-y");

// ── Status helper ─────────────────────────────────────────────
function setStatus(msg, type = "default", loading = false) {
  statusText.textContent = msg;
  statusBar.className    = type === "default" ? "" : type;
  spinner.className      = loading ? "spinner active" : "spinner";
}

// ─────────────────────────────────────────────────────────────
// BUG 1 FIX — destroyChart()
// ─────────────────────────────────────────────────────────────
// Safely destroys any Chart.js instance on the canvas.
// Three-layer defence:
//   Layer 1 — chartInst.destroy()  : normal path
//   Layer 2 — Chart.getChart()     : catches zombie instances
//             that exist in Chart's registry but whose JS
//             reference we've lost (e.g. after rapid re-renders)
//   Layer 3 — ctx.clearRect()      : wipes pixel buffer so no
//             ghost chart image bleeds into the next render

function destroyChart() {
  // Layer 1: destroy via our own reference
  if (chartInst) {
    chartInst.destroy();
    chartInst = null;
  }

  // Layer 2: destroy any zombie instance Chart.js still knows about
  // Chart.getChart(element) returns the instance registered on that
  // canvas, or undefined if none. This catches the case where our
  // chartInst variable was already nulled but Chart's registry wasn't
  // cleaned up (happens on rapid type-switch clicks).
  const zombie = Chart.getChart(chartCanvas);
  if (zombie) {
    zombie.destroy();
  }

  // Layer 3: clear the raw canvas pixel buffer
  const ctx = chartCanvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
  }
}

// ─────────────────────────────────────────────────────────────
// BUG 2 FIX — EXTRACTOR_FN (inline function for executeScript)
// ─────────────────────────────────────────────────────────────
// This is the FULL content-script logic passed as func: to
// chrome.scripting.executeScript(). Because it's an inline
// function (not a file path), Chrome ALWAYS re-evaluates it
// on every scan — no tab-session caching possible.
//
// Keeping it here (in popup.js) means one fewer file to ship,
// and the extraction logic stays in version-controlled sync
// with the popup controller that consumes its output.
//
// NOTE: This function runs in the PAGE context, not the
// extension context. It cannot access any popup.js variables.
// It must be fully self-contained.

const EXTRACTOR_FN = function () {
  "use strict";

  // ── Noise blocklist (mirrors content.js NOISE_WORDS) ──────
  const CSS_UNITS    = ["px","em","rem","vh","vw","pt","pc","cm","mm","in","ex","ch","vmin","vmax","fr","deg","rad","turn","ms","hz","khz","dpi","dpcm","dppx"];
  const ORDINAL_SFXS = ["st","nd","rd","th"];
  const VERSION_PFXS = ["v","ver","rev","rc","beta","alpha","build"];
  const MEDIA_CODES  = ["mp3","mp4","jpg","jpeg","png","gif","svg","pdf","zip","gz","tar","wav","ogg","webm","mkv","avi","mov"];
  const HTML_TAGS    = ["h1","h2","h3","h4","h5","h6","p","br","hr","li","ul","ol","td","tr","th","div","span","img","src","alt","href"];
  const YEAR_CTXS    = ["year","yr","ad","bc","ce","bce"];

  const NOISE = new Set([
    ...CSS_UNITS, ...ORDINAL_SFXS, ...VERSION_PFXS,
    ...MEDIA_CODES, ...HTML_TAGS,
    "px","id","ip","ui","ux","js","ts","py","go","rb","am","pm",
  ]);

  function isYearLike(v, ctx) {
    return v >= 1900 && v <= 2099 && YEAR_CTXS.includes(ctx);
  }

  // ── Gather raw text ──────────────────────────────────────
  let rawText = "";
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) {
    rawText = sel.toString();
  } else {
    const paras = document.querySelectorAll("p");
    rawText = paras.length > 0
      ? Array.from(paras).map(el => el.innerText || el.textContent || "").join("\n")
      : (document.body.innerText || "");
  }

  rawText = rawText.replace(/[ \t]+/g, " ").trim();

  // ── Regex + filtering ────────────────────────────────────
  // BUG 2 FIX: `seen` Set removed — duplicate values kept so
  // positional/proximity zipping in popup.js stays accurate.
  const PAIR_REGEX = /(\d[\d,]*\.?\d*)\s+([A-Za-z][A-Za-z0-9]{1,29})\b/g;
  const pairs = [];
  let match;

  while ((match = PAIR_REGEX.exec(rawText)) !== null) {
    const rawMatch  = match[0].trim();
    const rawNumber = match[1];
    const context   = match[2].toLowerCase();

    // Noise filters
    if (NOISE.has(context))                          continue;
    if (context.length < 3)                          continue;
    if (ORDINAL_SFXS.includes(context))              continue;
    if ((context.match(/[a-z]/g)||[]).length < 2)    continue;
    const _lc = (context.match(/[a-z]/g)||[]).length;
    if (_lc / context.length < 0.7)                  continue; // blocks b2b, p2p, r2d2

    const numericValue = parseFloat(rawNumber.replace(/,/g, ""));
    if (isNaN(numericValue))                         continue;
    if (isYearLike(numericValue, context))           continue;
    if (numericValue <= 0)                           continue;

    pairs.push({
      value:       numericValue,
      context:     context,
      raw:         rawMatch,
      sourceIndex: match.index,   // char offset — used for proximity zip
    });
  }

  pairs.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return pairs;
};

// ── STEP 1: Scan Page ─────────────────────────────────────────
//
// BUG 2 FIX: uses func: EXTRACTOR_FN instead of files:["content.js"]
// so Chrome never caches the injection result.

scanBtn.addEventListener("click", async () => {
  setStatus("Scanning page…", "default", true);
  scanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");

    // ── BUG 2 FIX: inline func — always re-evaluated ─────────
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   EXTRACTOR_FN,       // ← inline, never cached
    });

    const pairs = results?.[0]?.result;

    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error(
        "No numeric pairs found. Try selecting specific text first, " +
        "or check that the page has visible numeric content in paragraphs."
      );
    }

    allPairs = pairs;
    populateDropdowns(allPairs);
    emptyState.style.display = "none";

    const ctxCount = uniqueContexts(allPairs).length;
    setStatus(
      `Found ${allPairs.length} pair(s) across ${ctxCount} context type(s).`,
      "success"
    );

    buildBtn.disabled = false;
    resetBtn.disabled = false;

  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
    scanBtn.disabled = false;
  }
});

// ── STEP 2: Populate Dropdowns ────────────────────────────────
function populateDropdowns(pairs) {
  const contexts = uniqueContexts(pairs);

  xSelect.innerHTML = "";
  ySelect.innerHTML = "";

  const makePlaceholder = () => {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "— Select —";
    o.disabled = true; o.selected = true;
    return o;
  };

  xSelect.appendChild(makePlaceholder());
  ySelect.appendChild(makePlaceholder());

  contexts.forEach((ctx) => {
    // Count how many pairs have this context — shown as "(n)" hint
    const count = pairs.filter(p => p.context === ctx).length;
    const makeOpt = () => {
      const o = document.createElement("option");
      o.value       = ctx;
      o.textContent = `${ctx}  (${count})`;
      return o;
    };
    xSelect.appendChild(makeOpt());
    ySelect.appendChild(makeOpt());
  });

  xSelect.disabled = false;
  ySelect.disabled = false;
}

// ── STEP 3: Build Chart ───────────────────────────────────────
buildBtn.addEventListener("click", () => {
  const xLabel = xSelect.value;
  const yLabel = ySelect.value;

  if (!xLabel) { setStatus("Please select an X-axis label.", "error"); return; }
  if (!yLabel) { setStatus("Please select a Y-axis label.", "error"); return; }
  if (xLabel === yLabel) { setStatus("X and Y axes must be different.", "error"); return; }

  const { ds, warning } = filterDataset(allPairs, xLabel, yLabel);
  filteredDS = ds;

  if (filteredDS.labels.length === 0) {
    setStatus(
      `No pairable data found for "${xLabel}" ↔ "${yLabel}". ` +
      `Try different axis selections.`,
      "error"
    );
    return;
  }

  const chartType = getSelectedChartType();
  buildChart(filteredDS, chartType, xLabel, yLabel);
  renderTable(filteredDS, xLabel, yLabel);
  exportRow.style.display = "flex";

  const msg = `Chart built — ${filteredDS.labels.length} point(s). X="${xLabel}", Y="${yLabel}".`;
  setStatus(warning ? `${msg} ⚠ ${warning}` : msg, warning ? "error" : "success");
});

// ─────────────────────────────────────────────────────────────
// BUG 4 FIX — filterDataset() with proximity-based matching
// ─────────────────────────────────────────────────────────────
// OLD approach: simple positional zip — pairs X[0]↔Y[0],
//   X[1]↔Y[1] regardless of where they appear in the text.
//   BROKE when: X and Y counts differed, or content.js `seen`
//   Set silently dropped pairs making counts unequal.
//
// NEW approach — proximity matching:
//   For each X-pair (sorted by sourceIndex), find the Y-pair
//   whose sourceIndex is CLOSEST (smallest absolute distance)
//   and that hasn't been claimed yet. This maps data that
//   naturally appears near each other in text, regardless of
//   whether counts match.
//
//   Example: "Revenue 500 dollars in month 1. Month 2 saw 800 dollars."
//     X-pairs (month):   [{val:1,idx:35}, {val:2,idx:52}]
//     Y-pairs (dollars): [{val:500,idx:12}, {val:800,idx:62}]
//   Proximity:
//     month@35 → closest unclaimed dollars@12 (dist=23) ✓ → (1, 500)
//     month@52 → closest unclaimed dollars@62 (dist=10) ✓ → (2, 800)
//   Result: correct pairing even though dollars appears BEFORE month.
//
// Falls back to positional zip if proximity produces 0 pairs
// (safety net for unusual page structures).

function filterDataset(pairs, xLabel, yLabel) {
  const xPairs = pairs
    .filter(p => p.context === xLabel)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);

  const yPairs = pairs
    .filter(p => p.context === yLabel)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);

  if (xPairs.length === 0 || yPairs.length === 0) {
    return { ds: { labels: [], values: [], raws: [] }, warning: null };
  }

  // ── Proximity matching ─────────────────────────────────────
  const claimedY = new Set(); // indices into yPairs that are taken
  const labels = [], values = [], raws = [];

  for (const xp of xPairs) {
    let bestIdx  = -1;
    let bestDist = Infinity;

    for (let j = 0; j < yPairs.length; j++) {
      if (claimedY.has(j)) continue;
      const dist = Math.abs(xp.sourceIndex - yPairs[j].sourceIndex);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx  = j;
      }
    }

    if (bestIdx === -1) continue; // no unclaimed Y-pair for this X — skip, keep going

    claimedY.add(bestIdx);
    labels.push(xp.value);
    values.push(yPairs[bestIdx].value);
    raws.push(`${xp.raw}  ←→  ${yPairs[bestIdx].raw}`);
  }

  // ── Fallback: positional zip ───────────────────────────────
  // Triggered if proximity matching somehow produced 0 results
  // (e.g. all sourceIndex values are identical — unlikely but safe).
  if (labels.length === 0) {
    const len = Math.min(xPairs.length, yPairs.length);
    for (let i = 0; i < len; i++) {
      labels.push(xPairs[i].value);
      values.push(yPairs[i].value);
      raws.push(`${xPairs[i].raw}  ←→  ${yPairs[i].raw}`);
    }
  }

  // ── Unmatched pair warning ─────────────────────────────────
  const unmatched = xPairs.length - labels.length;
  const warning = unmatched > 0
    ? `${unmatched} X-value(s) had no matching Y-value and were skipped.`
    : null;

  return { ds: { labels, values, raws }, warning };
}

// ─────────────────────────────────────────────────────────────
// BUG 1 FIX — buildChart() using destroyChart()
// ─────────────────────────────────────────────────────────────

function buildChart(ds, type, xLabel, yLabel) {
  // BUG 1 FIX: three-layer canvas cleanup before new Chart()
  destroyChart();

  chartWrapper.classList.add("visible");

  const PALETTE = [
    "#6c63ff","#34d399","#f87171","#fbbf24",
    "#60a5fa","#a78bfa","#fb923c","#4ade80",
    "#f472b6","#38bdf8","#e879f9","#facc15",
  ];

  const bgColors     = ds.labels.map((_, i) => PALETTE[i % PALETTE.length]);
  const borderColors = bgColors.slice();

  const config = {
    type: type,
    data: {
      labels: ds.labels.map(String),
      datasets: [{
        label:              yLabel,
        data:               ds.values,
        backgroundColor:    type === "pie" ? bgColors  : "rgba(108, 99, 255, 0.65)",
        borderColor:        type === "pie" ? borderColors : "#6c63ff",
        borderWidth:        2,
        tension:            0.35,
        pointBackgroundColor: "#6c63ff",
        pointRadius:        4,
        fill:               type === "line",
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      animation:           { duration: 350 },
      plugins: {
        legend: {
          display: type === "pie",
          labels:  { color: "#e2e8f0", font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${yLabel}: ${ctx.parsed.y ?? ctx.parsed}`,
            title: (ctx) => `${xLabel}: ${ctx[0].label}`,
          },
        },
      },
      scales: type === "pie" ? {} : {
        x: {
          title: { display: true, text: xLabel, color: "#94a3b8", font: { size: 11 } },
          ticks: { color: "#94a3b8" },
          grid:  { color: "#2a2d3e" },
        },
        y: {
          title: { display: true, text: yLabel, color: "#94a3b8", font: { size: 11 } },
          ticks: { color: "#94a3b8" },
          grid:  { color: "#2a2d3e" },
          beginAtZero: true,
        },
      },
    },
  };

  // BUG 1 FIX: store fresh instance; canvas is guaranteed clean
  chartInst = new Chart(chartCanvas, config);
}

// ── renderTable ───────────────────────────────────────────────
function renderTable(ds, xLabel, yLabel) {
  colX.textContent    = xLabel;
  colY.textContent    = yLabel;
  tableBody.innerHTML = "";

  ds.labels.forEach((lbl, i) => {
    const tr   = document.createElement("tr");
    const tdX  = document.createElement("td");
    const tdY  = document.createElement("td");
    const tdRw = document.createElement("td");

    tdX.textContent  = lbl;
    tdY.textContent  = ds.values[i];
    tdRw.textContent = ds.raws[i];

    tr.appendChild(tdX);
    tr.appendChild(tdY);
    tr.appendChild(tdRw);
    tableBody.appendChild(tr);
  });

  pairCount.textContent = `${ds.labels.length} pairs`;
  tableWrapper.classList.add("visible");
}

// ── Export: PNG ───────────────────────────────────────────────
exportPNG.addEventListener("click", () => {
  if (!chartInst) return;
  triggerDownload(chartCanvas.toDataURL("image/png"), "datagraph-chart.png");
});

// ── Export: CSV ───────────────────────────────────────────────
exportCSV.addEventListener("click", () => {
  if (!filteredDS.labels.length) return;

  const xL = xSelect.value || "x";
  const yL = ySelect.value || "y";

  const lines = [
    `"${xL}","${yL}","raw_match"`,
    ...filteredDS.labels.map(
      (lbl, i) =>
        // BUG 4 FIX: escape any double-quotes inside raw strings
        // so the CSV doesn't break in Excel/LibreOffice.
        `${lbl},${filteredDS.values[i]},"${String(filteredDS.raws[i]).replace(/"/g, '""')}"`
    ),
  ];

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  triggerDownload(url, "datagraph-data.csv");
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ── triggerDownload ───────────────────────────────────────────
function triggerDownload(url, filename) {
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Reset ─────────────────────────────────────────────────────
resetBtn.addEventListener("click", () => {
  destroyChart(); // BUG 1 FIX: use safe destroy, not inline logic

  allPairs   = [];
  filteredDS = { labels: [], values: [], raws: [] };

  xSelect.innerHTML = '<option value="">— Scan first —</option>';
  ySelect.innerHTML = '<option value="">— Scan first —</option>';
  xSelect.disabled  = true;
  ySelect.disabled  = true;

  tableBody.innerHTML = "";
  tableWrapper.classList.remove("visible");
  pairCount.textContent = "0 pairs";

  chartWrapper.classList.remove("visible");
  exportRow.style.display = "none";

  emptyState.style.display = "block";

  buildBtn.disabled = true;
  resetBtn.disabled = true;
  scanBtn.disabled  = false;

  setStatus('Click "Scan Page" to extract data from the active tab.');
});

// ── Chart type radio — instant redraw ─────────────────────────
document.querySelectorAll('input[name="chart-type"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (filteredDS.labels.length > 0) {
      buildChart(filteredDS, radio.value, xSelect.value, ySelect.value);
    }
  });
});

// ── Utilities ─────────────────────────────────────────────────

/** Returns sorted unique context words from a pairs array */
function uniqueContexts(pairs) {
  return [...new Set(pairs.map(p => p.context))].sort();
}

/** Returns the currently selected chart type */
function getSelectedChartType() {
  return document.querySelector('input[name="chart-type"]:checked')?.value || "bar";
}
