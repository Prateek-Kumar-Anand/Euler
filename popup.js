// ============================================================
// popup.js — DataGrapher Popup Controller  [FIXED v1.2]
// ============================================================
// NEW FIXES IN THIS VERSION:
//
//   BUG A FIX — <p> Tag Limitation:
//     EXTRACTOR_FN updated with priority-tiered DOM scraping:
//     article → main → p/li/td/th/h1-h6/blockquote → body.
//     isVisible() guard strips hidden/offscreen elements.
//     sentenceIndex attached to every pair for Bug D.
//
//   BUG B FIX — Export PNG Animation Timing:
//     Chart.js animation duration set to 0 (no animation in a
//     520px popup — instant render, no timing race possible).
//     exportPNG wraps toDataURL() in requestAnimationFrame so
//     the browser has guaranteed one full paint cycle before
//     the canvas pixel buffer is read. This prevents capturing
//     a mid-paint or blank frame under any GPU/CPU load.
//
//   BUG C FIX — Popup Closing / State Loss:
//     chrome.storage.session persists allPairs, filteredDS,
//     axis selections, and chart type across popup close/reopen.
//     On DOMContentLoaded the popup checks for saved state and
//     silently restores dropdowns + chart + table so the user
//     never loses their work. Reset clears storage too.
//     Requires "storage" in manifest.json permissions.
//
//   BUG D FIX — Incorrect Data Matching:
//     filterDataset() now does sentence-aware two-pass matching:
//       Pass 1: for each X-pair, search only Y-pairs that share
//               the same sentenceIndex. Pick the nearest one.
//       Pass 2: any X-pair without a sentence match falls back
//               to global proximity across remaining Y-pairs.
//     This prevents cross-sentence pairing where a Y from one
//     paragraph incorrectly binds to an X from a different one.
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

// ── destroyChart() — three-layer safe canvas cleanup ─────────
function destroyChart() {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const zombie = Chart.getChart(chartCanvas);
  if (zombie) zombie.destroy();
  const ctx = chartCanvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
}

// ─────────────────────────────────────────────────────────────
// EXTRACTOR_FN — inline function injected into the active tab
// ─────────────────────────────────────────────────────────────
// Passed as func: to executeScript() — NEVER cached by Chrome.
// Fully self-contained (runs in page context, no popup vars).
// BUG A FIX: priority-tiered DOM scraping + isVisible() guard.
// BUG D FIX: sentenceIndex attached to every pair.

const EXTRACTOR_FN = function () {
  "use strict";

  // ── Noise blocklist ──────────────────────────────────────
  const CSS_UNITS    = ["px","em","rem","vh","vw","pt","pc","cm","mm","in","ex","ch","vmin","vmax","fr","deg","rad","turn","ms","hz","khz","dpi","dpcm","dppx"];
  const ORDINAL_SFXS = ["st","nd","rd","th"];
  const VERSION_PFXS = ["v","ver","rev","rc","beta","alpha","build"];
  const MEDIA_CODES  = ["mp3","mp4","jpg","jpeg","png","gif","svg","pdf","zip","gz","tar","wav","ogg","webm","mkv","avi","mov"];
  const HTML_TAGS    = ["h1","h2","h3","h4","h5","h6","p","br","hr","li","ul","ol","td","tr","th","div","span","img","src","alt","href"];
  const YEAR_CTXS    = ["year","yr","ad","bc","ce","bce"];
  const NOISE = new Set([
    ...CSS_UNITS, ...ORDINAL_SFXS, ...VERSION_PFXS, ...MEDIA_CODES, ...HTML_TAGS,
    "px","id","ip","ui","ux","js","ts","py","go","rb","am","pm",
  ]);

  function isYearLike(v, ctx) {
    return v >= 1900 && v <= 2099 && YEAR_CTXS.includes(ctx);
  }

  // ── BUG A FIX: isVisible guard ───────────────────────────
  function isVisible(el) {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    return st.display !== "none" &&
           st.visibility !== "hidden" &&
           parseFloat(st.opacity) !== 0;
  }

  // ── BUG A FIX: extract text from NodeList, filter hidden ─
  function extractText(nodeList) {
    return Array.from(nodeList)
      .filter(isVisible)
      .map(el => (el.innerText || el.textContent || "").trim())
      .filter(t => t.length > 0)
      .join("\n");
  }

  // ── BUG A FIX: priority-tiered DOM scraping ──────────────
  let rawText = "";

  // Tier 1: user selection
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) {
    rawText = sel.toString();
  }
  // Tier 2: <article> — blog/news/wiki
  if (!rawText) {
    const els = document.querySelectorAll("article");
    if (els.length > 0) rawText = extractText(els);
  }
  // Tier 3: <main> — ARIA landmark
  if (!rawText) {
    const els = document.querySelectorAll("main");
    if (els.length > 0) rawText = extractText(els);
  }
  // Tier 4: explicit multi-element set
  if (!rawText) {
    const els = document.querySelectorAll(
      "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,figcaption,caption,dt,dd"
    );
    if (els.length > 0) rawText = extractText(els);
  }
  // Tier 5: full body fallback
  if (!rawText) rawText = document.body.innerText || "";

  rawText = rawText.replace(/[ \t]+/g, " ").trim();

  // ── BUG D FIX: sentence splitting + charToSentence map ───
  const sentences = [];
  let cursor = 0;
  for (const chunk of rawText.split(/[.!?\n]+/)) {
    const trimmed = chunk.trim();
    const actualStart = rawText.indexOf(trimmed, cursor);
    if (trimmed.length > 0 && actualStart !== -1) {
      sentences.push({ startOffset: actualStart, length: trimmed.length });
      cursor = actualStart + trimmed.length;
    } else {
      cursor += chunk.length + 1;
    }
  }

  // charToSentence[i] = index of sentence containing char i, or -1
  const charToSentence = new Int16Array(rawText.length).fill(-1);
  sentences.forEach((s, idx) => {
    const end = Math.min(s.startOffset + s.length, rawText.length);
    for (let i = s.startOffset; i < end; i++) charToSentence[i] = idx;
  });

  // ── Regex extraction ──────────────────────────────────────
  const PAIR_REGEX = /(\d[\d,]*\.?\d*)\s+([A-Za-z][A-Za-z0-9]{1,29})\b/g;
  const pairs = [];
  let match;

  while ((match = PAIR_REGEX.exec(rawText)) !== null) {
    const rawNumber = match[1];
    const context   = match[2].toLowerCase();

    // Noise filters
    if (NOISE.has(context))                              continue;
    if (context.length < 3)                              continue;
    if (ORDINAL_SFXS.includes(context))                  continue;
    const lc = (context.match(/[a-z]/g) || []).length;
    if (lc < 2 || lc / context.length < 0.7)            continue;
    if (VERSION_PFXS.includes(context) &&
        /^\d/.test(match[2].slice(1)))                   continue;

    const numericValue = parseFloat(rawNumber.replace(/,/g, ""));
    if (isNaN(numericValue) || numericValue <= 0)        continue;
    if (isYearLike(numericValue, context))               continue;

    // sentenceIndex: fall back to last sentence before this position
    let sentIdx = charToSentence[match.index];
    if (sentIdx === -1) {
      for (let s = sentences.length - 1; s >= 0; s--) {
        if (sentences[s].startOffset <= match.index) { sentIdx = s; break; }
      }
    }

    pairs.push({
      value:         numericValue,
      context:       context,
      raw:           match[0].trim(),
      sourceIndex:   match.index,
      sentenceIndex: sentIdx,
    });
  }

  pairs.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return pairs;
};

// ─────────────────────────────────────────────────────────────
// BUG C FIX — Storage helpers
// ─────────────────────────────────────────────────────────────
// chrome.storage.session: survives popup close/reopen within
// the same browser session. Wiped when browser closes.
// All reads/writes are async — we await them carefully.

const STORAGE_KEY = "datagrapherState";

async function saveState(xLabel, yLabel, chartType) {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: {
        allPairs,
        filteredDS,
        xLabel,
        yLabel,
        chartType,
      }
    });
  } catch (e) {
    // Storage failure is non-fatal — user just loses restore on reopen
    console.warn("DataGrapher: state save failed", e);
  }
}

async function loadState() {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    return result[STORAGE_KEY] || null;
  } catch (e) {
    return null;
  }
}

async function clearState() {
  try {
    await chrome.storage.session.remove(STORAGE_KEY);
  } catch (e) { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────
// BUG C FIX — Restore state on popup open
// ─────────────────────────────────────────────────────────────
// On every popup open, check storage. If previous session state
// exists, silently rebuild the UI without requiring a re-scan.

document.addEventListener("DOMContentLoaded", async () => {
  const saved = await loadState();
  if (!saved || !Array.isArray(saved.allPairs) || saved.allPairs.length === 0) {
    return; // nothing to restore — fresh start
  }

  // Restore in-memory state
  allPairs   = saved.allPairs;
  filteredDS = saved.filteredDS || { labels: [], values: [], raws: [] };

  // Rebuild dropdowns with saved pairs
  populateDropdowns(allPairs, saved.xLabel, saved.yLabel);
  emptyState.style.display = "none";

  // Restore chart type radio
  if (saved.chartType) {
    const radio = document.querySelector(`input[name="chart-type"][value="${saved.chartType}"]`);
    if (radio) radio.checked = true;
  }

  // Re-render chart + table if a chart was built
  if (filteredDS.labels.length > 0 && saved.xLabel && saved.yLabel) {
    buildChart(filteredDS, saved.chartType || "bar", saved.xLabel, saved.yLabel);
    renderTable(filteredDS, saved.xLabel, saved.yLabel);
    exportRow.style.display = "flex";
    setStatus(
      `Restored — ${allPairs.length} pair(s). Chart: X="${saved.xLabel}", Y="${saved.yLabel}".`,
      "success"
    );
  } else {
    setStatus(
      `Restored ${allPairs.length} pair(s). Pick axes and click Build Chart.`,
      "success"
    );
  }

  buildBtn.disabled = false;
  resetBtn.disabled = false;
});

// ── STEP 1: Scan Page ─────────────────────────────────────────
scanBtn.addEventListener("click", async () => {
  setStatus("Scanning page…", "default", true);
  scanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   EXTRACTOR_FN,
    });

    const pairs = results?.[0]?.result;

    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error(
        "No numeric pairs found. Try selecting specific text first, " +
        "or check that the page has visible numeric content."
      );
    }

    allPairs = pairs;
    filteredDS = { labels: [], values: [], raws: [] }; // clear old chart data
    await clearState(); // wipe old storage so stale chart doesn't restore

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
// BUG C FIX: accepts optional savedX/savedY to restore selections

function populateDropdowns(pairs, savedX = null, savedY = null) {
  const contexts = uniqueContexts(pairs);

  xSelect.innerHTML = "";
  ySelect.innerHTML = "";

  const makePlaceholder = () => {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "— Select —";
    o.disabled = true;
    return o;
  };

  xSelect.appendChild(makePlaceholder());
  ySelect.appendChild(makePlaceholder());

  contexts.forEach((ctx) => {
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

  // BUG C FIX: restore saved selections if they exist in the new options
  if (savedX && contexts.includes(savedX)) xSelect.value = savedX;
  if (savedY && contexts.includes(savedY)) ySelect.value = savedY;

  // If no saved value, ensure placeholder shows (no accidental selection)
  if (!xSelect.value) xSelect.options[0].selected = true;
  if (!ySelect.value) ySelect.options[0].selected = true;

  xSelect.disabled = false;
  ySelect.disabled = false;
}

// ── STEP 3: Build Chart ───────────────────────────────────────
buildBtn.addEventListener("click", async () => {
  const xLabel    = xSelect.value;
  const yLabel    = ySelect.value;
  const chartType = getSelectedChartType();

  if (!xLabel)           { setStatus("Please select an X-axis label.", "error"); return; }
  if (!yLabel)           { setStatus("Please select a Y-axis label.", "error"); return; }
  if (xLabel === yLabel) { setStatus("X and Y axes must be different.", "error"); return; }

  const { ds, warning } = filterDataset(allPairs, xLabel, yLabel);
  filteredDS = ds;

  if (filteredDS.labels.length === 0) {
    setStatus(`No pairable data for "${xLabel}" ↔ "${yLabel}". Try different axes.`, "error");
    return;
  }

  buildChart(filteredDS, chartType, xLabel, yLabel);
  renderTable(filteredDS, xLabel, yLabel);
  exportRow.style.display = "flex";

  // BUG C FIX: persist state immediately after chart builds
  await saveState(xLabel, yLabel, chartType);

  const msg = `Chart built — ${filteredDS.labels.length} point(s). X="${xLabel}", Y="${yLabel}".`;
  setStatus(warning ? `${msg} ⚠ ${warning}` : msg, warning ? "error" : "success");
});

// ─────────────────────────────────────────────────────────────
// BUG D FIX — filterDataset() with sentence-aware two-pass matching
// ─────────────────────────────────────────────────────────────
// Pass 1: match X and Y pairs that share the same sentenceIndex.
//         This is the primary pairing strategy — data in the same
//         sentence almost always belongs together.
// Pass 2: any X-pairs that found no same-sentence Y fall back to
//         global proximity search across remaining unclaimed Y-pairs.
//         This handles pages where data spans multiple sentences
//         but is still logically related (e.g. tables, bullet lists).

function filterDataset(pairs, xLabel, yLabel) {
  const xPairs = pairs
    .filter(p => p.context === xLabel)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);

  const yPairs = pairs
    .filter(p => p.context === yLabel)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);

  if (!xPairs.length || !yPairs.length) {
    return { ds: { labels: [], values: [], raws: [] }, warning: null };
  }

  const claimedY  = new Set();
  const labels    = [];
  const values    = [];
  const raws      = [];
  const unpairedX = []; // X-pairs that found no same-sentence Y

  // ── Pass 1: same-sentence matching ────────────────────────
  for (const xp of xPairs) {
    let bestIdx  = -1;
    let bestDist = Infinity;

    for (let j = 0; j < yPairs.length; j++) {
      if (claimedY.has(j)) continue;

      // BUG D FIX: only consider Y-pairs in the same sentence
      const sameSentence = xp.sentenceIndex !== -1 &&
                           yPairs[j].sentenceIndex !== -1 &&
                           xp.sentenceIndex === yPairs[j].sentenceIndex;
      if (!sameSentence) continue;

      const dist = Math.abs(xp.sourceIndex - yPairs[j].sourceIndex);
      if (dist < bestDist) { bestDist = dist; bestIdx = j; }
    }

    if (bestIdx !== -1) {
      claimedY.add(bestIdx);
      labels.push(xp.value);
      values.push(yPairs[bestIdx].value);
      raws.push(`${xp.raw}  ←→  ${yPairs[bestIdx].raw}`);
    } else {
      unpairedX.push(xp); // defer to Pass 2
    }
  }

  // ── Pass 2: global proximity fallback for unmatched X ─────
  for (const xp of unpairedX) {
    let bestIdx  = -1;
    let bestDist = Infinity;

    for (let j = 0; j < yPairs.length; j++) {
      if (claimedY.has(j)) continue;
      const dist = Math.abs(xp.sourceIndex - yPairs[j].sourceIndex);
      if (dist < bestDist) { bestDist = dist; bestIdx = j; }
    }

    if (bestIdx !== -1) {
      claimedY.add(bestIdx);
      labels.push(xp.value);
      values.push(yPairs[bestIdx].value);
      raws.push(`${xp.raw}  ←→  ${yPairs[bestIdx].raw}  [cross-sentence]`);
    }
    // If still no match: simply not included (already handled by continue)
  }

  // Sort final pairs by the original X sourceIndex so chart reads L→R
  const combined = labels.map((l, i) => ({ l, v: values[i], r: raws[i] }));
  combined.sort((a, b) => {
    const ax = xPairs.find(p => p.value === a.l)?.sourceIndex ?? 0;
    const bx = xPairs.find(p => p.value === b.l)?.sourceIndex ?? 0;
    return ax - bx;
  });

  const unmatched = xPairs.length - combined.length;
  return {
    ds: {
      labels: combined.map(c => c.l),
      values: combined.map(c => c.v),
      raws:   combined.map(c => c.r),
    },
    warning: unmatched > 0
      ? `${unmatched} X-value(s) had no Y match and were skipped.`
      : null,
  };
}

// ─────────────────────────────────────────────────────────────
// BUG B FIX — buildChart() with animation: 0 + rAF export
// ─────────────────────────────────────────────────────────────
// Animation duration set to 0: no partial-frame capture risk.
// toDataURL() is now wrapped in requestAnimationFrame (see
// exportPNG handler below) to guarantee a full browser paint
// cycle before pixel read.

function buildChart(ds, type, xLabel, yLabel) {
  destroyChart();
  chartWrapper.classList.add("visible");

  const PALETTE = [
    "#6c63ff","#34d399","#f87171","#fbbf24",
    "#60a5fa","#a78bfa","#fb923c","#4ade80",
    "#f472b6","#38bdf8","#e879f9","#facc15",
  ];

  const bgColors = ds.labels.map((_, i) => PALETTE[i % PALETTE.length]);

  const config = {
    type,
    data: {
      labels: ds.labels.map(String),
      datasets: [{
        label:               yLabel,
        data:                ds.values,
        backgroundColor:     type === "pie" ? bgColors : "rgba(108, 99, 255, 0.65)",
        borderColor:         type === "pie" ? bgColors : "#6c63ff",
        borderWidth:         2,
        tension:             0.35,
        pointBackgroundColor:"#6c63ff",
        pointRadius:         4,
        fill:                type === "line",
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      // BUG B FIX: animation off — no mid-frame toDataURL() race
      animation:           { duration: 0 },
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

  chartInst = new Chart(chartCanvas, config);
}

// ── renderTable ───────────────────────────────────────────────
function renderTable(ds, xLabel, yLabel) {
  colX.textContent    = xLabel;
  colY.textContent    = yLabel;
  tableBody.innerHTML = "";

  ds.labels.forEach((lbl, i) => {
    const tr  = document.createElement("tr");
    const tdX = document.createElement("td");
    const tdY = document.createElement("td");
    const tdR = document.createElement("td");
    tdX.textContent = lbl;
    tdY.textContent = ds.values[i];
    tdR.textContent = ds.raws[i];
    tr.appendChild(tdX);
    tr.appendChild(tdY);
    tr.appendChild(tdR);
    tableBody.appendChild(tr);
  });

  pairCount.textContent = `${ds.labels.length} pairs`;
  tableWrapper.classList.add("visible");
}

// ─────────────────────────────────────────────────────────────
// BUG B FIX — exportPNG with requestAnimationFrame guard
// ─────────────────────────────────────────────────────────────
// Even with animation:0, the canvas may not have flushed its
// GPU draw buffer to the CPU-readable pixel array within the
// same JS microtask. requestAnimationFrame defers the read to
// AFTER the browser has completed one full composite + paint
// cycle, guaranteeing a fully rendered frame in toDataURL().

exportPNG.addEventListener("click", () => {
  if (!chartInst) return;

  requestAnimationFrame(() => {
    // Second rAF: ensures we're past the composite step on all GPUs.
    // One rAF fires at the START of the next frame; two rAFs guarantees
    // the frame has been COMMITTED to the display pipeline.
    requestAnimationFrame(() => {
      const url = chartCanvas.toDataURL("image/png");
      triggerDownload(url, "datagraph-chart.png");
    });
  });
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
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Reset ─────────────────────────────────────────────────────
resetBtn.addEventListener("click", async () => {
  destroyChart();
  allPairs   = [];
  filteredDS = { labels: [], values: [], raws: [] };

  // BUG C FIX: clear persisted state on explicit reset
  await clearState();

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

// ── Chart type radio — instant redraw + state save ────────────
document.querySelectorAll('input[name="chart-type"]').forEach((radio) => {
  radio.addEventListener("change", async () => {
    if (filteredDS.labels.length > 0) {
      buildChart(filteredDS, radio.value, xSelect.value, ySelect.value);
      // BUG C FIX: save updated chart type preference
      await saveState(xSelect.value, ySelect.value, radio.value);
    }
  });
});

// ── Utilities ─────────────────────────────────────────────────
function uniqueContexts(pairs) {
  return [...new Set(pairs.map(p => p.context))].sort();
}

function getSelectedChartType() {
  return document.querySelector('input[name="chart-type"]:checked')?.value || "bar";
}
