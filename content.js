// ============================================================
// content.js — DataGrapher Content Script
// ============================================================
// INJECTION:  Injected programmatically via chrome.scripting
//             .executeScript() from popup.js on user action.
//             NOT declared in manifest as a persistent listener,
//             so it only runs when the user explicitly triggers it.
//
// WHAT IT DOES:
//   1. Reads text from either:
//        a. The user's current selection (if any), OR
//        b. All <p> tags on the page.
//   2. Runs a regex walk to extract (number, context-word) pairs.
//   3. Returns a structured array to popup.js via the return value
//      of executeScript().
//
// RETURN FORMAT — Array of PairObjects:
//   [
//     { value: 4,     context: "months",  raw: "4 months"   },
//     { value: 1200,  context: "sales",   raw: "1200 sales" },
//     ...
//   ]
//
// HOW TO TWEAK THE REGEX (for bug bounty / researchers):
//   The main pattern is defined as PAIR_REGEX below.
//   Key capture groups:
//     Group 1 → numeric value  (integers, decimals, comma-separated)
//     Group 2 → context word   (the nearest alphanumeric word)
//   You can extend Group 2 to match multi-word contexts like
//   "monthly sales" by changing \w+ to (\w+(?:\s+\w+)?).
// ============================================================

(function () {
  "use strict";

  // ── STEP 1: Gather raw text from the page ─────────────────────
  //
  // Priority order:
  //   A) User text selection — precise, user-chosen data source.
  //   B) All <p> elements   — full-page fallback.
  //
  // We join paragraphs with a newline so the regex won't run
  // a value at the end of one paragraph into a word at the start
  // of the next.

  let rawText = "";

  const selection = window.getSelection();
  if (selection && selection.toString().trim().length > 0) {
    // User has highlighted text — use only that
    rawText = selection.toString();
  } else {
    // No selection: scrape all paragraph elements
    const paragraphs = document.querySelectorAll("p");
    if (paragraphs.length === 0) {
      // Fallback: use the full body text (e.g. for pages without <p> tags)
      rawText = document.body.innerText || "";
    } else {
      rawText = Array.from(paragraphs)
        .map((el) => el.innerText || el.textContent || "")
        .join("\n");
    }
  }

  // ── STEP 2: Normalise whitespace ──────────────────────────────
  //
  // Collapse runs of spaces/tabs to a single space so the regex
  // doesn't have to handle variable-length gaps.

  rawText = rawText.replace(/[ \t]+/g, " ").trim();

  // ── STEP 3: Regex — extract (number → context word) pairs ─────
  //
  // PAIR_REGEX breakdown:
  //
  //   (\d[\d,]*\.?\d*)   — Group 1 (VALUE)
  //                         Matches integers like 42, 1,000
  //                         and decimals like 3.14, 1,200.50
  //                         Requires the first character to be a digit
  //                         so it won't accidentally match ".5" alone.
  //
  //   \s*                — Optional whitespace between number and word.
  //
  //   ([A-Za-z]\w{1,30}) — Group 2 (CONTEXT / LABEL)
  //                         Matches a word starting with a letter
  //                         followed by 1–30 word characters.
  //                         The minimum length of 2 chars filters
  //                         single-letter noise like "a" or "I".
  //                         Upper cap of 30 chars avoids ridiculously
  //                         long tokens (URLs, encoded strings, etc.)
  //
  // FLAG  g  → find ALL matches in the text, not just the first.
  //
  // To also capture WORD → NUMBER pairs (e.g. "sales: 1200"),
  // add a second pass with the groups swapped (see EXTENSION NOTE below).

  const PAIR_REGEX = /(\d[\d,]*\.?\d*)\s*([A-Za-z]\w{1,30})/g;

  // ── STEP 4: Walk all matches, build pair list ─────────────────

  const pairs = [];           // Final output array
  const seen  = new Set();    // Dedup identical raw strings

  let match;
  while ((match = PAIR_REGEX.exec(rawText)) !== null) {
    const rawMatch  = match[0].trim();
    const rawNumber = match[1];           // e.g. "1,200"
    const context   = match[2].toLowerCase(); // normalise case

    // Skip duplicate (value + context) combinations
    const key = `${rawNumber}::${context}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Convert number string → float
    // Remove commas first so "1,200" → 1200, not NaN
    const numericValue = parseFloat(rawNumber.replace(/,/g, ""));

    // Safety guard: skip NaN or negative values
    // (NaN guard covers edge cases where regex lets through unexpected text)
    if (isNaN(numericValue) || numericValue < 0) continue;

    pairs.push({
      value:   numericValue, // Number  — the extracted numeric value
      context: context,      // String  — the adjacent label/word
      raw:     rawMatch,     // String  — original substring for debugging
    });
  }

  // ── EXTENSION NOTE ────────────────────────────────────────────
  //
  // To capture reverse-order pairs like "revenue: 5000" add:
  //
  //   const REVERSE_REGEX = /([A-Za-z]\w{1,30})[:\s]+(\d[\d,]*\.?\d*)/g;
  //
  // Then run the same while-loop with groups flipped:
  //   context = match[1].toLowerCase()
  //   rawNumber = match[2]
  //
  // Merge both pair arrays before returning.
  // ─────────────────────────────────────────────────────────────

  // Return the pairs array.
  // chrome.scripting.executeScript() captures the last expression value,
  // so a bare return works here (the IIFE returns its value).
  return pairs;
})();
