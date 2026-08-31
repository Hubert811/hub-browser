import { describe, expect, test } from 'bun:test';
import { buildSemanticFindJs } from '../src/opencli-engine/browser/find.js';

/**
 * Bug #24 (2026-08-31, QuickBI receivables report dogfooding):
 * `find --text` returned 0 matches for text living in non-interactive
 * elements (an <h1 title=…>, label divs, table cells) — the semantic
 * candidate set only ever considered interactive elements.
 *
 * The fix is injected page JS, so these tests assert the generated
 * expression's STRUCTURE (deterministic, no DOM needed): pure text/name/
 * label queries scan every element ('*'), role/testid-constrained queries
 * keep the interactive set, the deepest-holder filter is present, and every
 * referenced constant is defined before use. Live-browser behavior was
 * verified on the receivables report itself (h1/span hits in both frames).
 */

describe('find semantic expression — bug #24 structure', () => {
  test('pure text query scans every element (*)', () => {
    const js = buildSemanticFindJs({ text: '销售报表门户' });
    expect(js).toContain("const CANDIDATES = !CRITERIA.role && !CRITERIA.testid ? '*' : CANDIDATE_SEL");
  });

  test('role-constrained query keeps the interactive candidate set', () => {
    const js = buildSemanticFindJs({ role: 'button', text: 'Save' });
    // The ternary still guards the broad set; with a role present the
    // runtime takes the CANDIDATE_SEL branch.
    expect(js).toContain("const CANDIDATES = !CRITERIA.role && !CRITERIA.testid ? '*' : CANDIDATE_SEL");
    expect(js).toContain("const BROAD = CANDIDATES === '*';");
  });

  test('deepest-holder filter present for the broad set (wrapper-ancestor flood guard)', () => {
    const js = buildSemanticFindJs({ text: 'x' });
    expect(js).toContain('if (BROAD && CRITERIA.text && matchesList.length > 1)');
    expect(js).toContain('el.contains(other)');
  });

  test('no undefined constant in the evaluation order (BROAD defined before use)', () => {
    const js = buildSemanticFindJs({ text: 'x' });
    const defAt = js.indexOf('const BROAD =');
    const useAt = js.indexOf('if (BROAD &&');
    expect(defAt).toBeGreaterThan(-1);
    expect(useAt).toBeGreaterThan(defAt);
  });
});
