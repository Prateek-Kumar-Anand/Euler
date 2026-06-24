# DataGrapher — Smart Data Extractor

> A lightweight, **100% offline** Manifest V3 Chrome extension that scans any webpage for numeric data, lets you map it to chart axes, and exports the result as PNG or CSV — no server, no API key, no tracking.

---

## File Structure

```
DataGrapher/
├── manifest.json          ← MV3 extension manifest
├── content.js             ← Injected into active tab; regex extraction logic
├── popup.html             ← Extension popup shell (CSS + markup)
├── popup.js               ← All UI interaction, chart rendering, export
├── vendor/
│   └── chart.min.js       ← Bundled Chart.js v4.4.3 (UMD, offline-safe)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `DataGrapher/` folder
5. The 🟣 DataGrapher icon appears in your toolbar

> **Firefox note:** MV3 is supported in Firefox 109+. Replace `chrome.*` with `browser.*` in `popup.js` and add `"browser_specific_settings"` to `manifest.json` for Firefox compatibility.

---

## How to Use

### Basic flow

1. Navigate to any page with numeric text (articles, reports, data tables in `<p>` tags)
2. *(Optional)* Highlight a specific passage to limit the scan to your selection
3. Click the toolbar icon → **⚡ Scan Page**
4. Use **Select X-Axis** and **Select Y-Axis** dropdowns to pick which context words map to which axis
5. Choose a chart type (Bar / Line / Pie)
6. Click **Build Chart**
7. Export as **PNG** or **CSV**

### Example

Given a page containing:

```
In January, revenue was 4200 dollars and customers numbered 340.
In February, revenue was 5100 dollars and customers reached 410.
In March, revenue hit 6300 dollars with 520 customers.
```

The scan will extract pairs like:

| value | context   |
|-------|-----------|
| 4200  | dollars   |
| 340   | customers |
| 5100  | dollars   |
| 410   | customers |
| 6300  | dollars   |
| 520   | customers |

Set **X = customers**, **Y = dollars** → instant revenue-per-customer chart.

---

## Architecture & How It Works

### `content.js` — Extraction Engine

Injected once per scan via `chrome.scripting.executeScript()`.

**Regex pattern:**
```
(\d[\d,]*\.?\d*)\s*([A-Za-z]\w{1,30})
```

| Group | Matches | Example |
|-------|---------|---------|
| 1 | Numeric value (int, decimal, comma-separated) | `1,200` → `1200` |
| 2 | Adjacent context word (2–31 chars, letter-first) | `sales` |

**Source priority:**
1. User's text selection (if any text is highlighted)
2. All `<p>` elements on the page
3. `document.body.innerText` as last resort

**Output:** array of `{ value: number, context: string, raw: string }` objects returned directly to `popup.js`.

---

### `popup.js` — Controller

| Function | Responsibility |
|---|---|
| `scanBtn` handler | Calls `executeScript`, stores `allPairs` |
| `populateDropdowns()` | Deduplicates context words → fills `<select>` |
| `filterDataset()` | Positional zip of X-pairs and Y-pairs |
| `buildChart()` | Creates/replaces Chart.js instance |
| `renderTable()` | Populates filtered data table |
| `exportPNG` handler | `canvas.toDataURL()` → download |
| `exportCSV` handler | Blob CSV → download |
| `resetBtn` handler | Clears all state, resets UI |

---

## Tweaking the Regex (Researcher Notes)

All parsing lives in `content.js`. Key constants:

```js
// Current pattern — NUMBER then WORD
const PAIR_REGEX = /(\d[\d,]*\.?\d*)\s*([A-Za-z]\w{1,30})/g;
```

**Common customisations:**

```js
// 1. Also capture WORD → NUMBER pairs ("revenue: 5000")
const REVERSE_REGEX = /([A-Za-z]\w{1,30})[:\s]+(\d[\d,]*\.?\d*)/g;

// 2. Allow multi-word context ("monthly sales")
const MULTI_WORD = /(\d[\d,]*\.?\d*)\s+([A-Za-z]\w+(?:\s+\w+)?)/g;

// 3. Capture negative values (losses, temperatures)
const WITH_NEGATIVE = /(-?\d[\d,]*\.?\d*)\s*([A-Za-z]\w{1,30})/g;

// 4. Require context word ≥ 3 chars (reduce noise further)
const LONGER_WORDS = /(\d[\d,]*\.?\d*)\s*([A-Za-z]\w{2,30})/g;
```

**To add currency symbol capture** (`$4,200`), add an optional prefix group:
```js
/(?:[$€£¥])?\s*(\d[\d,]*\.?\d*)\s*([A-Za-z]\w{1,30})/g
```

---

## Dataset Matching Strategy

`filterDataset()` uses **positional zipping**:

```
X-pairs (context = "months"): [4, 8, 12]
Y-pairs (context = "sales"):  [200, 400, 650]
→ Result: (4→200), (8→400), (12→650)
```

This works well for naturally parallel prose. For non-parallel or out-of-order data, consider switching to a **sentence-boundary matching** approach: parse by sentence first, then find one X and one Y per sentence window.

---

## Export Details

| Format | Method | Offline? |
|--------|--------|----------|
| PNG | `HTMLCanvasElement.toDataURL("image/png")` | ✅ Yes |
| CSV | `Blob` + `URL.createObjectURL()` | ✅ Yes |

CSV format:
```
"x_label","y_label","raw_match"
4,200,"4 months | 200 sales"
8,400,"8 months | 400 sales"
```

---

## Permissions Justification

| Permission | Why needed | Scope |
|---|---|---|
| `activeTab` | Read the current tab's DOM | Only while popup is open |
| `scripting` | Inject `content.js` via `executeScript` | Only on user action |

No `host_permissions`, no `tabs` (broad), no `storage`, no network access.

---

## Known Limitations

- **Positional matching** assumes X-values and Y-values appear in the same order in the text. Works great for structured articles; may produce mismatches in unstructured prose.
- **Year filtering** is not automatic. If "2024" and "2023" appear as a context word "year", they'll show up in the dropdown — simply don't select "year" as an axis.
- **Tables (`<table>`)** are not scraped by default. To add table support, append `Array.from(document.querySelectorAll("td"))` to the source list in `content.js`.
- **Shadow DOM** content (many SPAs) is not accessible from `document.querySelectorAll`. Use text selection on visible text instead.

---

## License

MIT — free to fork, modify, and redistribute.
