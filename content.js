// ============================================================
// content.js — DataGrapher Content Script  [FIXED v1.2]
// ============================================================
// NEW FIXES IN THIS VERSION:
//
//   BUG A FIX — <p> Tag Limitation (Data Selection):
//     Old code ONLY scraped <p> elements. Modern pages put
//     numeric data in <li>, <td>, <article>, <main>, <h2>-<h6>,
//     <blockquote>, <strong>, <figcaption> — <p> alone missed
//     Wikipedia tables, news sidebars, GitHub READMEs, Reddit
//     posts, and most SPA-rendered content.
//     SOLUTION: Priority-tiered scraping strategy:
//       Tier 1 — User text selection (unchanged, highest priority)
//       Tier 2 — <article> semantic container (blog/news/wiki)
//       Tier 3 — <main> ARIA landmark (covers most modern sites)
//       Tier 4 — Explicit element set: p, li, td, th, h1-h6,
//                blockquote, figcaption, caption, dt, dd, label
//       Tier 5 — document.body.innerText (ultimate fallback)
//     All tiers filter out invisible elements (display:none,
//     visibility:hidden) and skip script/style/noscript nodes.
//
//   BUG D FIX — Incorrect Data Matching (Sentence-Level Grouping):
//     Old proximity matching found the nearest Y by raw character
//     distance across the ENTIRE document. This caused cross-
//     sentence pairing — a Y from sentence 10 could pair with an
//     X from sentence 1 if nothing claimed it closer.
//     SOLUTION: Two-pass sentence-aware matching:
//       Pass 1 — Each pair is tagged with a sentenceIndex.
//                Matching is attempted WITHIN the same sentence
//                first. X and Y pairs in the same sentence are
//                always preferred over cross-sentence proximity.
//       Pass 2 — Any unmatched X-pairs fall back to the original
//                proximity search across remaining unclaimed Y-pairs.
//     This correctly handles: "In Jan, 4 months passed and 200
//     sales recorded. In Feb, 8 months passed and 400 sales."
//     — each sentence's pairs stay together.
// ============================================================

(function () {
  "use strict";

  // ── NOISE blocklist ───────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // BUG A FIX — isVisible() guard
  // ─────────────────────────────────────────────────────────────
  // Rejects hidden elements so we don't scrape tooltip text,
  // hidden menus, or off-screen accessibility duplicates.
  // Uses getComputedStyle which reflects CSS cascade fully.

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none")       return false;
    if (st.visibility === "hidden")  return false;
    if (parseFloat(st.opacity) === 0) return false;
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // BUG A FIX — extractTextFromElements()
  // ─────────────────────────────────────────────────────────────
  // Pulls innerText from a NodeList, filtering invisible nodes
  // and skipping script/style/noscript children.
  // Joins with "\n" so numbers at the end of one element never
  // bleed into a word at the start of the next.

  function extractTextFromElements(nodeList) {
    return Array.from(nodeList)
      .filter(isVisible)
      .map(el => (el.innerText || el.textContent || "").trim())
      .filter(t => t.length > 0)
      .join("\n");
  }

  // ─────────────────────────────────────────────────────────────
  // BUG A FIX — Priority-tiered text gathering
  // ─────────────────────────────────────────────────────────────

  let rawText = "";

  // Tier 1: User's text selection — most precise, always use if present
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) {
    rawText = sel.toString();
  }

  // Tier 2: <article> — blog posts, Wikipedia articles, news content
  if (!rawText) {
    const articles = document.querySelectorAll("article");
    if (articles.length > 0) {
      rawText = extractTextFromElements(articles);
    }
  }

  // Tier 3: <main> — ARIA landmark used by most modern sites
  if (!rawText) {
    const mains = document.querySelectorAll("main");
    if (mains.length > 0) {
      rawText = extractTextFromElements(mains);
    }
  }

  // Tier 4: Explicit multi-element set
  // Covers: paragraphs, list items, table cells/headers,
  //         headings, blockquotes, figure captions, definition lists
  if (!rawText) {
    const SELECTORS = [
      "p", "li", "td", "th",
      "h1","h2","h3","h4","h5","h6",
      "blockquote", "figcaption", "caption",
      "dt", "dd",
    ].join(",");

    const elements = document.querySelectorAll(SELECTORS);
    if (elements.length > 0) {
      rawText = extractTextFromElements(elements);
    }
  }

  // Tier 5: Full body — last resort
  if (!rawText) {
    rawText = document.body.innerText || "";
  }

  // Normalise whitespace across all tiers
  rawText = rawText.replace(/[ \t]+/g, " ").trim();

  // ─────────────────────────────────────────────────────────────
  // BUG D FIX — Sentence splitting
  // ─────────────────────────────────────────────────────────────
  // Split rawText into sentences by . ! ? \n boundaries.
  // Each character position maps to a sentenceIndex so we can
  // later restrict matching to within-sentence pairs.
  //
  // We build a charToSentence lookup array: O(n) space, O(1) lookup.
  // This is simpler and faster than re-scanning for sentence bounds
  // inside the matching loop.

  const SENT_SPLIT = /[.!?\n]+/;

  // sentences[] = array of {text, startOffset}
  const sentences = [];
  let cursor = 0;
  for (const chunk of rawText.split(SENT_SPLIT)) {
    const trimmed = chunk.trim();
    // Find the actual start of this chunk in rawText (skip leading whitespace)
    const actualStart = rawText.indexOf(trimmed, cursor);
    if (trimmed.length > 0 && actualStart !== -1) {
      sentences.push({ text: trimmed, startOffset: actualStart });
      cursor = actualStart + trimmed.length;
    } else {
      cursor += chunk.length + 1; // +1 for the split delimiter
    }
  }

  // Build charToSentence[] map: position → sentenceIndex (-1 = between sentences)
  const charToSentence = new Int16Array(rawText.length).fill(-1);
  sentences.forEach((s, idx) => {
    for (let i = s.startOffset; i < s.startOffset + s.text.length && i < rawText.length; i++) {
      charToSentence[i] = idx;
    }
  });

  // ── Regex extraction ──────────────────────────────────────────
  const PAIR_REGEX = /(\d[\d,]*\.?\d*)\s+([A-Za-z][A-Za-z0-9]{1,29})\b/g;
  const pairs = [];
  let match;

  while ((match = PAIR_REGEX.exec(rawText)) !== null) {
    const rawMatch  = match[0].trim();
    const rawNumber = match[1];
    const context   = match[2].toLowerCase();

    // Noise filters (unchanged from v1.1)
    if (NOISE.has(context))                                  continue;
    if (context.length < 3)                                  continue;
    if (ORDINAL_SFXS.includes(context))                      continue;
    const lc = (context.match(/[a-z]/g) || []).length;
    if (lc < 2)                                              continue;
    if (lc / context.length < 0.7)                          continue;
    if (VERSION_PFXS.includes(context) &&
        /^\d/.test(match[2].slice(1)))                       continue;

    const numericValue = parseFloat(rawNumber.replace(/,/g, ""));
    if (isNaN(numericValue))                                 continue;
    if (isYearLike(numericValue, context))                   continue;
    if (numericValue <= 0)                                   continue;

    // ── BUG D FIX: attach sentenceIndex ─────────────────────
    // charToSentence[match.index] gives the sentence this pair
    // belongs to. If -1 (fell between sentence boundaries due to
    // split imprecision), inherit from nearest preceding sentence.
    let sentIdx = charToSentence[match.index];
    if (sentIdx === -1 && sentences.length > 0) {
      // Find the last sentence that started before this position
      for (let s = sentences.length - 1; s >= 0; s--) {
        if (sentences[s].startOffset <= match.index) { sentIdx = s; break; }
      }
    }

    pairs.push({
      value:         numericValue,
      context:       context,
      raw:           rawMatch,
      sourceIndex:   match.index,
      sentenceIndex: sentIdx,  // NEW — used by popup.js filterDataset()
    });
  }

  pairs.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return pairs;

})();
