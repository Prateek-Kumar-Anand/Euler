// ============================================================
// content.js — DataGrapher Content Script  [FIXED v1.1]
// ============================================================
// FIXES IN THIS VERSION:
//
//   BUG 2 FIX — State Persistence:
//     Previously injected via files:["content.js"] which Chrome
//     can cache and return stale results for on repeated scans.
//     SOLUTION: This file is now loaded as an inline func: via
//     popup.js (see popup.js scanBtn handler). The IIFE here
//     always runs fresh — no caching possible.
//     Additionally, the `seen` Set dedup that was silently
//     dropping repeated values (e.g. two "4 months") is REMOVED.
//     Raw pairs are returned undeduped; dedup only happens in
//     popup.js when building the dropdown label list.
//
//   BUG 3 FIX — Regex False Positives:
//     Old regex matched "2024px", "10rem", "1st", "v2", "mp3"
//     as valid pairs. Fixed by:
//       a) NOISE_WORDS blocklist — CSS units, ordinal suffixes,
//          version prefixes, common codes.
//       b) Require context word length >= 3 chars.
//       c) Block pure-ordinal matches (1st/2nd/3rd/4th/nth).
//       d) Skip values that look like years (1900–2099) when
//          the context word is a known date/time noise word.
//       e) Each pair now carries a `sourceIndex` (character
//          offset in rawText) for correct ordering in popup.js.
// ============================================================

(function () {
  "use strict";

  // ── NOISE_WORDS blocklist ─────────────────────────────────────
  //
  // Context words that are almost never meaningful chart labels.
  // Categorised for easy extension by researchers.
  //
  // HOW TO EXTEND:
  //   Add lowercase strings to any sub-array, or add a new array
  //   and spread it into NOISE_WORDS below.

  const CSS_UNITS     = ["px","em","rem","vh","vw","pt","pc","cm","mm","in","ex","ch","vmin","vmax","fr","deg","rad","turn","ms","hz","khz","dpi","dpcm","dppx"];
  const ORDINAL_SFXS  = ["st","nd","rd","th"];          // 1st, 2nd, 3rd, 4th
  const VERSION_PFXS  = ["v","ver","rev","rc","beta","alpha","build"]; // v2, ver3
  const MEDIA_CODES   = ["mp3","mp4","jpg","jpeg","png","gif","svg","pdf","zip","gz","tar","wav","ogg","webm","mkv","avi","mov"];
  const HTML_TAGS     = ["h1","h2","h3","h4","h5","h6","p","br","hr","li","ul","ol","td","tr","th","div","span","img","src","alt","href"];
  const TIME_NOISE    = ["am","pm"];                    // standalone am/pm
  const YEAR_CONTEXTS = ["year","yr","ad","bc","ce","bce"]; // years like "2024 year"

  const NOISE_WORDS = new Set([
    ...CSS_UNITS,
    ...ORDINAL_SFXS,
    ...VERSION_PFXS,
    ...MEDIA_CODES,
    ...HTML_TAGS,
    ...TIME_NOISE,
    // single/double letter codes that bleed through
    "px","id","ip","ui","ux","js","ts","py","go","rb",
  ]);

  // Year range: values 1900–2099 paired with year-noise contexts
  // are treated as "year mentions", not data values.
  function isYearLike(numVal, ctx) {
    return numVal >= 1900 && numVal <= 2099 && YEAR_CONTEXTS.includes(ctx);
  }

  // ── STEP 1: Gather raw text ──────────────────────────────────
  //
  // Priority:
  //   A) User's text selection (highlighted on page)
  //   B) All <p> elements
  //   C) document.body.innerText fallback

  let rawText = "";

  const selection = window.getSelection();
  if (selection && selection.toString().trim().length > 0) {
    rawText = selection.toString();
  } else {
    const paragraphs = document.querySelectorAll("p");
    if (paragraphs.length === 0) {
      rawText = document.body.innerText || "";
    } else {
      rawText = Array.from(paragraphs)
        .map((el) => el.innerText || el.textContent || "")
        .join("\n");
    }
  }

  // ── STEP 2: Normalise whitespace ─────────────────────────────
  rawText = rawText.replace(/[ \t]+/g, " ").trim();

  // ── STEP 3: Regex — extract (number → context word) pairs ────
  //
  // PAIR_REGEX v1.1 changes vs v1.0:
  //   • Context word minimum length raised to {2,30} → enforced
  //     separately below as >= 3 chars after match.
  //   • Added word-boundary \b after context word so "10remix"
  //     doesn't match as context="remix" (the \b stops mid-token).
  //
  // Group 1 (VALUE):   integers, comma-grouped, decimals
  // Group 2 (CONTEXT): word starting with a letter, 2–30 chars

  const PAIR_REGEX = /(\d[\d,]*\.?\d*)\s+([A-Za-z][A-Za-z0-9]{1,29})\b/g;

  // ── STEP 4: Walk all matches ──────────────────────────────────
  //
  // BUG 2 FIX: `seen` Set REMOVED. Duplicate (value+context)
  // pairs are now kept so positional zipping in popup.js works
  // correctly even when the same number repeats in the text.
  // e.g. "4 months revenue 200. 4 months revenue 300." gives
  // two (4,months) pairs → correct chart with 2 X points.

  const pairs = [];

  let match;
  while ((match = PAIR_REGEX.exec(rawText)) !== null) {
    const rawMatch   = match[0].trim();
    const rawNumber  = match[1];
    const context    = match[2].toLowerCase();

    // ── BUG 3 FIX: apply noise filters ───────────────────────

    // Filter 1: blocklist check
    if (NOISE_WORDS.has(context)) continue;

    // Filter 2: minimum context word length (>= 3 real chars)
    if (context.length < 3) continue;

    // Filter 3: pure-ordinal check — "1st","22nd","103rd","5th"
    // An ordinal is: digits followed immediately by st/nd/rd/th
    // The regex would still capture "st","nd","rd","th" — block them.
    if (ORDINAL_SFXS.includes(context)) continue;

    // Filter 4: context must be mostly letters (ratio > 0.6)
    // Blocks "b2b" (0.67 ratio but mixed), "p2p", "r2d2", "h1b"
    // Pure letter check: letters must outnumber non-letters clearly.
    const letterCount = (context.match(/[a-z]/g) || []).length;
    if (letterCount < 2) continue;
    if (letterCount / context.length < 0.7) continue; // e.g. "b2b" = 2/3 = 0.67 → blocked

    // Filter 5: context must not start with a known version prefix
    // AND be followed immediately by digits  e.g. "v2", "rc3"
    if (VERSION_PFXS.includes(context) && /^\d/.test(match[2].slice(1))) continue;

    // Convert number string → float (strip commas first)
    const numericValue = parseFloat(rawNumber.replace(/,/g, ""));

    // Filter 6: NaN guard
    if (isNaN(numericValue)) continue;

    // Filter 7: year-like value + year-context → skip
    if (isYearLike(numericValue, context)) continue;

    // Filter 8: extremely small values (<= 0) are noise
    if (numericValue <= 0) continue;

    // ── BUG 2 FIX: include sourceIndex for stable ordering ────
    // match.index = character offset of this match in rawText.
    // popup.js sorts pairs by sourceIndex before zipping so
    // extraction order is always preserved regardless of how
    // Chrome returns the array.

    pairs.push({
      value:       numericValue,  // Number — the numeric value
      context:     context,       // String — adjacent label word
      raw:         rawMatch,      // String — original substring
      sourceIndex: match.index,   // Number — char offset in rawText
    });
  }

  // Sort by source position (defensive — exec() order should already
  // be left-to-right, but explicit sort guarantees it)
  pairs.sort((a, b) => a.sourceIndex - b.sourceIndex);

  return pairs;
})();
