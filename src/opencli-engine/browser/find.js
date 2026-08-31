/**
 * `browser find --css <sel>` — structured CSS query.
 *
 * Returns every match of a selector as a JSON envelope agents can read
 * without parsing free-text snapshot output. Each entry carries two
 * identifiers — a numeric `ref` (matching the snapshot contract) and a
 * stable 0-based `nth` — so the agent can act on a specific result via
 * either path:
 *
 *   browser click <ref>              // when ref is numeric
 *   browser click "<sel>" --nth <n>  // always works
 *
 * Refs are *allocated on the spot* for matched elements that were not
 * tagged by a prior snapshot: `data-opencli-ref` is set on the element
 * and a fingerprint is written into `window.__opencli_ref_identity`
 * (same shape the snapshot uses). That makes `find` a first-class entry
 * point to the ref system — agents can skip running `browser state`
 * when they already know the selector.
 *
 * Attributes are whitelisted to keep output small and high-signal.
 * Invisible elements are still returned so agents can reason about
 * offscreen vs truly-missing targets.
 *
 * When a matched element is a compound form control (date-like input,
 * select, file input), the entry gains a `compound` field with the
 * rich view from `compound.ts`. This is what kills the three biggest
 * agent-fail modes on form pages (wrong date format, guessed options,
 * re-uploaded files) without forcing agents to probe further.
 */
import { COMPOUND_INFO_JS } from './compound.js';
/** Whitelist of attributes surfaced per entry. Keep small; agents do not need full DOM dumps. */
export const FIND_ATTR_WHITELIST = [
    'id',
    'class',
    'name',
    'type',
    'placeholder',
    'aria-label',
    'title',
    'href',
    'value',
    'role',
    'data-testid',
];
/**
 * Build the browser-side JS that performs the CSS query and emits the
 * FindResult (or FindError) envelope. Evaluated inside `page.evaluate`.
 */
export function buildFindJs(selector, opts = {}) {
    const safeSel = JSON.stringify(selector);
    const limit = opts.limit ?? 50;
    const textMax = opts.textMax ?? 120;
    const whitelist = JSON.stringify(FIND_ATTR_WHITELIST);
    return `
    (() => {
      const sel = ${safeSel};
      const LIMIT = ${limit};
      const TEXT_MAX = ${textMax};
      const ATTR_WHITELIST = ${whitelist};

      ${COMPOUND_INFO_JS}

      // O2 fix: same-origin frame traversal. Portal-shell + iframe is a common
      // enterprise shape (observed on QuickBI: every interactive control lives
      // in the dashboard iframe) — CSS and semantic queries must see into it
      // or find is blind to most of the page. Cross-origin frames throw on
      // contentDocument and are skipped (they live in separate CDP sessions;
      // AX frame stitching covers them there).
      function allDocs() {
        const docs = [document];
        const seen = new Set(docs);
        const walk = (doc, depth) => {
          if (depth > 5) return;
          let frames;
          try { frames = doc.querySelectorAll('iframe'); } catch (_) { return; }
          for (let i = 0; i < frames.length; i++) {
            let cd = null;
            try { cd = frames[i].contentDocument; } catch (_) {}
            if (cd && !seen.has(cd)) { seen.add(cd); docs.push(cd); walk(cd, depth + 1); }
          }
        };
        walk(document, 0);
        return docs;
      }
      const docs = allDocs();

      // Main document first — a bad selector throws here already, preserving
      // the invalid_selector contract — then same-origin child frames.
      let matches;
      try {
        matches = Array.from(document.querySelectorAll(sel));
      } catch (e) {
        return {
          error: {
            code: 'invalid_selector',
            message: 'Invalid CSS selector: ' + sel + ' (' + ((e && e.message) || String(e)) + ')',
            hint: 'Check the selector syntax.',
          },
        };
      }
      for (let d = 1; d < docs.length; d++) {
        try {
          matches = matches.concat(Array.from(docs[d].querySelectorAll(sel)));
        } catch (_) {}
      }

      if (matches.length === 0) {
        return {
          error: {
            code: 'selector_not_found',
            message: 'CSS selector ' + sel + ' matched 0 elements',
            hint: 'Use browser state to inspect the page, or try a less specific selector.',
          },
        };
      }

      function pickAttrs(el) {
        const out = {};
        for (const key of ATTR_WHITELIST) {
          const v = el.getAttribute(key);
          if (v != null && v !== '') out[key] = v;
        }
        return out;
      }

      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        try {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity || '1') === 0) return false;
        } catch (_) {}
        return true;
      }

      // Ref allocation: reuse \`window.__opencli_ref_identity\` (the same map
      // snapshot populates) as the source of truth. For matched elements that
      // don't already carry a \`data-opencli-ref\`, assign the next free numeric
      // ref and write the fingerprint so the target resolver can verify it on
      // downstream click/type/get calls.
      const identity = (window.__opencli_ref_identity = window.__opencli_ref_identity || {});
      let maxRef = 0;
      for (const k in identity) {
        const n = parseInt(k, 10);
        if (!isNaN(n) && n > maxRef) maxRef = n;
      }
      // Also walk any \`data-opencli-ref\` already in the DOM in case the identity
      // map was cleared but annotations remain (e.g. soft navigation without a
      // fresh snapshot). Guarantees allocated refs don't collide.
      try {
        for (let d = 0; d < docs.length; d++) {
          const tagged = docs[d].querySelectorAll('[data-opencli-ref]');
          for (let t = 0; t < tagged.length; t++) {
            const v = tagged[t].getAttribute('data-opencli-ref');
            const n = v != null && /^\\d+$/.test(v) ? parseInt(v, 10) : NaN;
            if (!isNaN(n) && n > maxRef) maxRef = n;
          }
        }
      } catch (_) {}

      function fingerprintOf(el) {
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: (el.textContent || '').trim().slice(0, 30),
          ariaLabel: el.getAttribute('aria-label') || '',
          id: el.id || '',
          testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        };
      }

      const take = Math.min(matches.length, LIMIT);
      const entries = [];
      for (let i = 0; i < take; i++) {
        const el = matches[i];
        const refAttr = el.getAttribute('data-opencli-ref');
        let refNum = refAttr != null && /^\\d+$/.test(refAttr) ? parseInt(refAttr, 10) : null;
        if (refNum === null) {
          refNum = ++maxRef;
          try { el.setAttribute('data-opencli-ref', '' + refNum); } catch (_) {}
          identity['' + refNum] = fingerprintOf(el);
        } else if (!identity['' + refNum]) {
          // Ref annotation survived but identity map was cleared — repopulate so the
          // target resolver's fingerprint check passes on downstream calls.
          identity['' + refNum] = fingerprintOf(el);
        }
        const text = (el.textContent || '').trim();
        const entry = {
          nth: i,
          ref: refNum,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text,
          attrs: pickAttrs(el),
          visible: isVisible(el),
        };
        const docIdx = docs.indexOf(el.ownerDocument);
        if (docIdx > 0) entry.frame = docIdx;
        const compound = compoundInfoOf(el);
        if (compound) entry.compound = compound;
        entries.push(entry);
      }

      return {
        matches_n: matches.length,
        entries,
      };
    })()
  `;
}
export function buildSemanticFindJs(opts) {
    const criteria = JSON.stringify({
        role: opts.role ?? '',
        name: opts.name ?? '',
        label: opts.label ?? '',
        text: opts.text ?? '',
        testid: opts.testid ?? '',
    });
    const limit = opts.limit ?? 50;
    const textMax = opts.textMax ?? 120;
    const whitelist = JSON.stringify(FIND_ATTR_WHITELIST);
    return `
    (() => {
      const CRITERIA = ${criteria};
      const LIMIT = ${limit};
      const TEXT_MAX = ${textMax};
      const ATTR_WHITELIST = ${whitelist};

      ${COMPOUND_INFO_JS}

      // O2 fix (same as the CSS branch above): query into same-origin child
      // frames so portal-shell + iframe pages are not invisible to semantic
      // locators. Cross-origin frames are skipped (separate CDP sessions).
      function allDocs() {
        const docs = [document];
        const seen = new Set(docs);
        const walk = (doc, depth) => {
          if (depth > 5) return;
          let frames;
          try { frames = doc.querySelectorAll('iframe'); } catch (_) { return; }
          for (let i = 0; i < frames.length; i++) {
            let cd = null;
            try { cd = frames[i].contentDocument; } catch (_) {}
            if (cd && !seen.has(cd)) { seen.add(cd); docs.push(cd); walk(cd, depth + 1); }
          }
        };
        walk(document, 0);
        return docs;
      }
      const docs = allDocs();

      function normalize(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      }

      function includesNeedle(value, needle) {
        const n = normalize(needle);
        if (!n) return true;
        return normalize(value).includes(n);
      }

      function nativeRole(el) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.getAttribute('href')) return 'link';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'option') return 'option';
        if (tag === 'input') {
          if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'range') return 'slider';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        return '';
      }

      function labelText(el) {
        const parts = [];
        function cssEscape(value) {
          try {
            if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
          } catch (_) {}
          return String(value).replace(/["\\\\]/g, '\\\\$&');
        }
        if (el.id) {
          try {
            const label = (el.ownerDocument || document).querySelector('label[for="' + cssEscape(el.id) + '"]');
            if (label) parts.push(label.textContent || '');
          } catch (_) {}
        }
        const parentLabel = el.closest?.('label');
        if (parentLabel) parts.push(parentLabel.textContent || '');
        return parts.join(' ');
      }

      function byIdText(ids, doc) {
        if (!ids) return '';
        const parts = [];
        for (const id of String(ids).split(/\\s+/)) {
          if (!id) continue;
          try {
            const el = (doc || document).getElementById(id);
            if (el) parts.push(el.textContent || '');
          } catch (_) {}
        }
        return parts.join(' ');
      }

      function accessibleName(el) {
        return [
          el.getAttribute('aria-label') || '',
          byIdText(el.getAttribute('aria-labelledby'), el.ownerDocument),
          labelText(el),
          el.getAttribute('alt') || '',
          el.getAttribute('title') || '',
          el.getAttribute('placeholder') || '',
          el.getAttribute('value') || '',
          el.textContent || '',
        ].filter(Boolean).join(' ');
      }

      function pickAttrs(el) {
        const out = {};
        for (const key of ATTR_WHITELIST) {
          const v = el.getAttribute(key);
          if (v != null && v !== '') out[key] = v;
        }
        return out;
      }

      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        try {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity || '1') === 0) return false;
        } catch (_) {}
        return true;
      }

      function fingerprintOf(el) {
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: (el.textContent || '').trim().slice(0, 30),
          ariaLabel: el.getAttribute('aria-label') || '',
          id: el.id || '',
          testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        };
      }

      function matches(el) {
        const role = nativeRole(el);
        const name = accessibleName(el);
        const label = labelText(el);
        const text = el.textContent || '';
        const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('test-id') || '';
        if (CRITERIA.role && normalize(role) !== normalize(CRITERIA.role)) return false;
        if (CRITERIA.name && !includesNeedle(name, CRITERIA.name)) return false;
        if (CRITERIA.label && !includesNeedle(label, CRITERIA.label)) return false;
        if (CRITERIA.text && !includesNeedle(text, CRITERIA.text)) return false;
        if (CRITERIA.testid && !includesNeedle(testid, CRITERIA.testid)) return false;
        return true;
      }

      const CANDIDATE_SEL = [
        'a[href]',
        'button',
        'input',
        'textarea',
        'select',
        'option',
        '[role]',
        '[aria-label]',
        '[aria-labelledby]',
        '[data-testid]',
        '[data-test]',
        '[test-id]',
        'label',
        '[contenteditable="true"]',
      ].join(',');
      // Bug #24 (2026-08-31, receivables report dogfooding): a text-only
      // query ("find --text 销售报表门户") matched 0 elements even though the
      // text lives in a visible <h1 title=…> — the interactive candidate set
      // never considers plain text carriers. When the criteria carry no
      // role/testid (a pure text/name/label search), scan every element so
      // headings, table cells, and label divs are findable; role- or
      // testid-constrained queries keep the interactive set (their targets
      // are interactive by definition, and '*' over a 16k-element DOM is
      // wasted work).
      const CANDIDATES = !CRITERIA.role && !CRITERIA.testid ? '*' : CANDIDATE_SEL;
      const BROAD = CANDIDATES === '*';
      // Main document first (stable ordering), then same-origin child frames
      // in traversal order — nth/entry order matches the CSS branch.
      let candidates = Array.from(document.querySelectorAll(CANDIDATES));
      for (let d = 1; d < docs.length; d++) {
        try {
          candidates = candidates.concat(Array.from(docs[d].querySelectorAll(CANDIDATES)));
        } catch (_) {}
      }
      let matchesList = candidates.filter(matches);
      // Bug #24 companion: textContent is subtree-inclusive, so with the
      // broad set every ancestor of a hit "contains" the needle too and the
      // result floods with wrapper divs. Keep only the deepest holders: drop
      // an element when some other match lies inside it.
      if (BROAD && CRITERIA.text && matchesList.length > 1) {
        const keep = matchesList.filter((el) =>
          !matchesList.some((other) => other !== el && el.contains(other)),
        );
        if (keep.length > 0) matchesList = keep;
      }

      if (matchesList.length === 0) {
        return {
          error: {
            code: 'semantic_not_found',
            message: 'Semantic locator matched 0 elements',
            hint: 'Try browser state, --source ax, or relax --role/--name/--label/--text/--testid.',
          },
        };
      }

      const identity = (window.__opencli_ref_identity = window.__opencli_ref_identity || {});
      let maxRef = 0;
      for (const k in identity) {
        const n = parseInt(k, 10);
        if (!isNaN(n) && n > maxRef) maxRef = n;
      }
      try {
        for (let d = 0; d < docs.length; d++) {
          const tagged = docs[d].querySelectorAll('[data-opencli-ref]');
          for (let t = 0; t < tagged.length; t++) {
            const v = tagged[t].getAttribute('data-opencli-ref');
            const n = v != null && /^\\d+$/.test(v) ? parseInt(v, 10) : NaN;
            if (!isNaN(n) && n > maxRef) maxRef = n;
          }
        }
      } catch (_) {}

      const take = Math.min(matchesList.length, LIMIT);
      const entries = [];
      for (let i = 0; i < take; i++) {
        const el = matchesList[i];
        const refAttr = el.getAttribute('data-opencli-ref');
        let refNum = refAttr != null && /^\\d+$/.test(refAttr) ? parseInt(refAttr, 10) : null;
        if (refNum === null) {
          refNum = ++maxRef;
          try { el.setAttribute('data-opencli-ref', '' + refNum); } catch (_) {}
          identity['' + refNum] = fingerprintOf(el);
        } else if (!identity['' + refNum]) {
          identity['' + refNum] = fingerprintOf(el);
        }
        const text = (el.textContent || '').trim();
        const entry = {
          nth: i,
          ref: refNum,
          tag: el.tagName.toLowerCase(),
          role: nativeRole(el),
          text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text,
          attrs: pickAttrs(el),
          visible: isVisible(el),
        };
        const docIdx = docs.indexOf(el.ownerDocument);
        if (docIdx > 0) entry.frame = docIdx;
        const compound = compoundInfoOf(el);
        if (compound) entry.compound = compound;
        entries.push(entry);
      }

      return {
        matches_n: matchesList.length,
        entries,
      };
    })()
  `;
}
export function isFindError(result) {
    return !!result && typeof result === 'object' && 'error' in result;
}
