// ============================================================
// popup.js — DataGrapher Extension Popup Controller
// ============================================================
// PURPOSE:
//   All UI interaction logic for the popup window.
//   Communicates with the active tab via chrome.scripting.
//   Renders charts via Chart.js (loaded from vendor/).
//   Exports PNG (canvas) and CSV (Blob) without any server.
//
// STATE:
//   allPairs    — raw array of { value, context, raw } from content.js
//   chartInst   — the live Chart.js instance (null if no chart yet)
//   filteredDS  — the dataset currently displayed ({labels[], values[]})
//
// FLOW:
//   1. User clicks [Scan Page]
//      → executeScript injects content.js into active tab
//      → allPairs populated, dropdowns filled
//   2. User picks X-axis and Y-axis from dropdowns
//   3. User clicks [Build Chart]
//      → filterDataset() builds filteredDS
//      → buildChart() renders Chart.js chart
//      → renderTable() populates the data table
//   4. User exports PNG or CSV
//
// OFFLINE GUARANTEE:
//   No fetch() calls. No external URLs. All assets local.
// ============================================================

"use strict";

// ── Module-level state ──────────────────────────────────────────
let allPairs   = [];  // Full extraction result from content.js
let chartInst  = null; // Active Chart.js instance
let filteredDS = { labels: [], values: [], raws: [] }; // Current dataset

// ── DOM references ──────────────────────────────────────────────
const scanBtn       = document.getElementById("scan-btn");
const buildBtn      = document.getElementById("build-btn");
const resetBtn      = document.getElementById("reset-btn");
const xSelect       = document.getElementById("x-select");
const ySelect       = document.getElementById("y-select");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const spinner       = document.getElementById("spinner");
const chartWrapper  = document.getElementById("chart-wrapper");
const chartCanvas   = document.getElementById("chart-canvas");
const tableWrapper  = document.getElementById("table-wrapper");
const tableBody     = document.getElementById("table-body");
const pairCount     = document.getElementById("pair-count");
const exportRow     = document.getElementById("export-row");
const exportPNG     = document.getElementById("export-png");
const exportCSV     = document.getElementById("export-csv");
const emptyState    = document.getElementById("empty-state");
const colX          = document.getElementById("col-x");
const colY          = document.getElementById("col-y");

// ── Utility: Status bar helper ──────────────────────────────────
//
// @param {string} msg      — message to display
// @param {"default"|"error"|"success"} type — visual style
// @param {boolean} loading — show spinner

function setStatus(msg, type = "default", loading = false) {
  statusText.textContent = msg;
  statusBar.className    = type === "default" ? "" : type;
  spinner.className      = loading ? "spinner active" : "spinner";
}

// ── STEP 1: Scan Page ───────────────────────────────────────────
//
// Injects content.js into the currently active tab.
// chrome.scripting.executeScript() returns the IIFE return value
// of content.js as results[0].result.

scanBtn.addEventListener("click", async () => {
  setStatus("Scanning page…", "default", true);
  scanBtn.disabled = true;

  try {
    // Get the focused window's active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      throw new Error("No active tab found.");
    }

    // Inject and run content.js; capture its return value
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["content.js"],
    });

    // results is an array of InjectionResult objects (one per frame).
    // We only care about the main frame (index 0).
    const pairs = results?.[0]?.result;

    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error("No numeric pairs found on this page. Try selecting specific text first.");
    }

    // Store globally
    allPairs = pairs;

    // Populate dropdowns and enable mapping UI
    populateDropdowns(allPairs);
    emptyState.style.display = "none";

    setStatus(
      `Found ${allPairs.length} pairs across ${uniqueContexts(allPairs).length} context types.`,
      "success"
    );

    buildBtn.disabled  = false;
    resetBtn.disabled  = false;

  } catch (err) {
    // Common errors:
    //   "Cannot access a chrome:// URL" — user is on a browser page, not web content
    //   "No numeric pairs found"         — page has no detectable number-word combos
    setStatus(`Error: ${err.message}`, "error");
    scanBtn.disabled = false;
  }
});

// ── STEP 2: Populate Dropdowns ──────────────────────────────────
//
// Extracts unique context words from allPairs and fills both
// X-axis and Y-axis selects with them.
//
// @param {Array} pairs — the full allPairs array

function populateDropdowns(pairs) {
  const contexts = uniqueContexts(pairs);

  // Clear existing options
  xSelect.innerHTML = "";
  ySelect.innerHTML = "";

  // Add a blank placeholder as the first option
  const placeholder = () => {
    const opt = document.createElement("option");
    opt.value       = "";
    opt.textContent = "— Select —";
    opt.disabled    = true;
    opt.selected    = true;
    return opt;
  };

  xSelect.appendChild(placeholder());
  ySelect.appendChild(placeholder());

  // Add one <option> per unique context word
  contexts.forEach((ctx) => {
    const makeOpt = () => {
      const o = document.createElement("option");
      o.value       = ctx;
      o.textContent = ctx;
      return o;
    };
    xSelect.appendChild(makeOpt());
    ySelect.appendChild(makeOpt());
  });

  // Enable both selects now that we have data
  xSelect.disabled = false;
  ySelect.disabled = false;
}

// ── STEP 3: Build Chart ─────────────────────────────────────────
//
// Triggered when [Build Chart] is clicked.
// Reads X and Y axis selections, filters the dataset,
// then renders chart + table.

buildBtn.addEventListener("click", () => {
  const xLabel = xSelect.value;
  const yLabel = ySelect.value;

  // ── Validation ────────────────────────────────────────────────
  if (!xLabel) {
    setStatus("Please select an X-axis label.", "error");
    return;
  }
  if (!yLabel) {
    setStatus("Please select a Y-axis label.", "error");
    return;
  }
  if (xLabel === yLabel) {
    setStatus("X and Y axes must be different context words.", "error");
    return;
  }

  // ── Filter the dataset ────────────────────────────────────────
  filteredDS = filterDataset(allPairs, xLabel, yLabel);

  if (filteredDS.labels.length === 0) {
    setStatus(
      `No pairable data found. "${xLabel}" and "${yLabel}" values don't appear in a mappable sequence.`,
      "error"
    );
    return;
  }

  // ── Render chart ──────────────────────────────────────────────
  const chartType = getSelectedChartType();
  buildChart(filteredDS, chartType, xLabel, yLabel);

  // ── Render table ──────────────────────────────────────────────
  renderTable(filteredDS, xLabel, yLabel);

  // ── Show export buttons ───────────────────────────────────────
  exportRow.style.display = "flex";

  setStatus(
    `Chart built with ${filteredDS.labels.length} data point(s). X="${xLabel}", Y="${yLabel}".`,
    "success"
  );
});

// ── filterDataset ───────────────────────────────────────────────
//
// STRATEGY:
//   The content.js extraction returns a flat list of pairs.
//   For example, given the text "In 4 months, sales reached 1200
//   units. After 8 months, sales hit 2400 units.", we get:
//     { value:4,    context:"months" }
//     { value:1200, context:"sales"  }
//     { value:8,    context:"months" }
//     { value:2400, context:"sales"  }
//
//   To build a chart, we need to match X-items to Y-items.
//   We use a POSITIONAL approach:
//     1. Group pairs by context (X-group and Y-group separately).
//     2. Zip them by index position: X[0]↔Y[0], X[1]↔Y[1] …
//     3. Trim to the shorter group's length.
//
// This works well for naturally parallel textual data
// (e.g. "4 months, 200 sales; 8 months, 400 sales").
//
// @param {Array}  pairs   — allPairs from content.js
// @param {string} xLabel  — selected X-axis context word
// @param {string} yLabel  — selected Y-axis context word
// @returns {{ labels: number[], values: number[], raws: string[] }}

function filterDataset(pairs, xLabel, yLabel) {
  // Separate X-type and Y-type pairs
  const xPairs = pairs.filter((p) => p.context === xLabel);
  const yPairs = pairs.filter((p) => p.context === yLabel);

  // Zip by index
  const len = Math.min(xPairs.length, yPairs.length);

  const labels = [];
  const values = [];
  const raws   = [];

  for (let i = 0; i < len; i++) {
    labels.push(xPairs[i].value);               // X axis label (numeric)
    values.push(yPairs[i].value);               // Y axis value
    raws.push(`${xPairs[i].raw} | ${yPairs[i].raw}`); // For table display
  }

  return { labels, values, raws };
}

// ── buildChart ──────────────────────────────────────────────────
//
// Creates or replaces the Chart.js instance.
// Destroys any existing instance first to prevent the
// "Canvas is already in use" runtime error.
//
// @param {{ labels: number[], values: number[] }} ds
// @param {string} type   — "bar" | "line" | "pie"
// @param {string} xLabel — for axis title
// @param {string} yLabel — for axis title

function buildChart(ds, type, xLabel, yLabel) {
  // Destroy old chart if one exists
  if (chartInst) {
    chartInst.destroy();
    chartInst = null;
  }

  // Show the canvas wrapper
  chartWrapper.classList.add("visible");

  // ── Colour palette for pie / doughnut ─────────────────────────
  // 12 distinct colours cycling for datasets with many segments.
  const PALETTE = [
    "#6c63ff", "#34d399", "#f87171", "#fbbf24",
    "#60a5fa", "#a78bfa", "#fb923c", "#4ade80",
    "#f472b6", "#38bdf8", "#e879f9", "#facc15",
  ];

  const bgColors = ds.labels.map((_, i) => PALETTE[i % PALETTE.length]);
  const borderColors = bgColors.map((c) => c); // Same hue, full opacity border

  // ── Chart.js config ───────────────────────────────────────────
  const config = {
    type: type,
    data: {
      labels: ds.labels.map(String), // Chart.js expects string labels
      datasets: [
        {
          label: yLabel,
          data: ds.values,
          backgroundColor: type === "pie"
            ? bgColors
            : "rgba(108, 99, 255, 0.65)",
          borderColor: type === "pie"
            ? borderColors
            : "#6c63ff",
          borderWidth: 2,
          // Line chart smoothing
          tension: 0.35,
          // Point styling for line chart
          pointBackgroundColor: "#6c63ff",
          pointRadius: 4,
          fill: type === "line",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 400 },
      plugins: {
        legend: {
          display: type === "pie",
          labels: { color: "#e2e8f0", font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            // Custom tooltip: "months: 4 → sales: 1200"
            label: (ctx) =>
              ` ${yLabel}: ${ctx.parsed.y ?? ctx.parsed}`,
            title: (ctx) =>
              `${xLabel}: ${ctx[0].label}`,
          },
        },
      },
      scales: type === "pie"
        ? {}   // Pie charts have no scales
        : {
            x: {
              title: {
                display: true,
                text: xLabel,
                color: "#94a3b8",
                font: { size: 11 },
              },
              ticks: { color: "#94a3b8" },
              grid:  { color: "#2a2d3e" },
            },
            y: {
              title: {
                display: true,
                text: yLabel,
                color: "#94a3b8",
                font: { size: 11 },
              },
              ticks: { color: "#94a3b8" },
              grid:  { color: "#2a2d3e" },
              beginAtZero: true,
            },
          },
    },
  };

  // Create the new Chart.js instance
  chartInst = new Chart(chartCanvas, config);
}

// ── renderTable ─────────────────────────────────────────────────
//
// Populates the filtered-data table below the chart.
// Clears any previous rows before inserting new ones.
//
// @param {{ labels: number[], values: number[], raws: string[] }} ds
// @param {string} xLabel
// @param {string} yLabel

function renderTable(ds, xLabel, yLabel) {
  // Update column header names
  colX.textContent = xLabel;
  colY.textContent = yLabel;

  // Clear old rows
  tableBody.innerHTML = "";

  // Insert one row per data point
  ds.labels.forEach((lbl, i) => {
    const tr = document.createElement("tr");

    const tdX   = document.createElement("td");
    const tdY   = document.createElement("td");
    const tdRaw = document.createElement("td");

    tdX.textContent   = lbl;
    tdY.textContent   = ds.values[i];
    tdRaw.textContent = ds.raws[i];

    tr.appendChild(tdX);
    tr.appendChild(tdY);
    tr.appendChild(tdRaw);
    tableBody.appendChild(tr);
  });

  // Show the table section
  pairCount.textContent = `${ds.labels.length} pairs`;
  tableWrapper.classList.add("visible");
}

// ── EXPORT: PNG ─────────────────────────────────────────────────
//
// Reads pixel data from the Chart.js canvas via toDataURL().
// Creates a temporary <a> and programmatically clicks it.
// Works 100% offline.

exportPNG.addEventListener("click", () => {
  if (!chartInst) return;

  const url = chartCanvas.toDataURL("image/png");
  triggerDownload(url, "datagraph-chart.png");
});

// ── EXPORT: CSV ─────────────────────────────────────────────────
//
// Builds a plain text CSV from filteredDS.
// First row = header. Subsequent rows = data.
// Uses Blob + Object URL for a clean, offline download.

exportCSV.addEventListener("click", () => {
  if (!filteredDS.labels.length) return;

  const xLabel = xSelect.value || "x";
  const yLabel = ySelect.value || "y";

  // Build CSV content
  const lines = [
    `"${xLabel}","${yLabel}","raw_match"`, // Header row
    ...filteredDS.labels.map(
      (lbl, i) =>
        `${lbl},${filteredDS.values[i]},"${filteredDS.raws[i]}"`
    ),
  ];
  const csvString = lines.join("\r\n");

  // Create downloadable Blob
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  triggerDownload(url, "datagraph-data.csv");

  // Revoke the object URL after a short delay to free memory
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ── triggerDownload ──────────────────────────────────────────────
//
// Generic helper: creates a hidden <a>, sets href + download,
// clicks it, then removes it.
//
// @param {string} url      — data: or blob: URL
// @param {string} filename — suggested filename for the download

function triggerDownload(url, filename) {
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Reset Session ───────────────────────────────────────────────
//
// Clears all state and returns the UI to its initial condition.
// Useful when the user wants to re-scan after navigating to a
// different page or correcting their text selection.

resetBtn.addEventListener("click", () => {
  // Destroy chart
  if (chartInst) {
    chartInst.destroy();
    chartInst = null;
  }

  // Clear state
  allPairs   = [];
  filteredDS = { labels: [], values: [], raws: [] };

  // Reset dropdowns
  xSelect.innerHTML = '<option value="">— Scan first —</option>';
  ySelect.innerHTML = '<option value="">— Scan first —</option>';
  xSelect.disabled  = true;
  ySelect.disabled  = true;

  // Reset table
  tableBody.innerHTML = "";
  tableWrapper.classList.remove("visible");
  pairCount.textContent = "0 pairs";

  // Hide chart
  chartWrapper.classList.remove("visible");
  exportRow.style.display = "none";

  // Show empty state
  emptyState.style.display = "block";

  // Disable action buttons
  buildBtn.disabled = true;
  resetBtn.disabled = true;
  scanBtn.disabled  = false;

  setStatus('Click "Scan Page" to extract data from the active tab.');
});

// ── Re-render on chart type change ──────────────────────────────
//
// If a chart is already rendered, switching the radio button
// immediately redraws with the new type — no need to re-click
// [Build Chart].

document.querySelectorAll('input[name="chart-type"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (filteredDS.labels.length > 0) {
      buildChart(filteredDS, radio.value, xSelect.value, ySelect.value);
    }
  });
});

// ── Utility helpers ──────────────────────────────────────────────

/**
 * Returns sorted unique context words from a pairs array.
 * @param {Array} pairs
 * @returns {string[]}
 */
function uniqueContexts(pairs) {
  return [...new Set(pairs.map((p) => p.context))].sort();
}

/**
 * Returns the currently selected chart type from radio buttons.
 * @returns {"bar"|"line"|"pie"}
 */
function getSelectedChartType() {
  return document.querySelector('input[name="chart-type"]:checked')?.value || "bar";
}

// ── Defensive: handle popup reopening with stale DOM ─────────────
// If the popup is closed and reopened, Chrome creates a fresh
// popup window so state is always clean. No extra guard needed.
