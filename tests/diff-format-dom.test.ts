/**
 * P3-5 — DOM-dimension rendering in formatDiffResult. The `dom` field is
 * independent of the AX `changed` flag: a spinner div appearing while the
 * interactive-role AX tree stays identical is exactly the case it must
 * surface (otherwise the early `no change` return would swallow it).
 */
import { describe, expect, it } from 'bun:test'
import { formatDiffResult } from '../src/browser-mcp/src/tools/diff-format.ts'
import type { SnapshotDiff } from '@browseros/browser-core/core/snapshot/diff'

const DOM = {
  added: [{ key: 'div#spin', desc: 'div.spinner.loading' }],
  removed: [{ key: 'div#empty', desc: 'div.empty-state' }],
  scanned: 612,
}

describe('formatDiffResult DOM section (P3-5)', () => {
  it('surfaces DOM changes even when the AX tree is unchanged', async () => {
    const formatted = await formatDiffResult(
      { text: '', added: 0, removed: 0, changed: false, dom: DOM },
      'https://example.com',
    )
    expect(formatted.text).toContain('DOM changes (+1 added / -1 removed, 612 scanned)')
    expect(formatted.text).toContain('+ div.spinner.loading')
    expect(formatted.text).toContain('- div.empty-state')
    expect(formatted.structured).toMatchObject({ changed: false, dom: DOM })
  })

  it('appends the DOM section after the AX diff text', async () => {
    const diff: SnapshotDiff = {
      text: '- textbox "Search" [ref=e1]',
      added: 1,
      removed: 0,
      changed: true,
      dom: DOM,
    }
    const formatted = await formatDiffResult(diff, 'https://example.com')
    expect(formatted.text).toContain('- textbox "Search" [ref=e1]')
    expect(formatted.text).toContain('DOM changes (+1 added / -1 removed, 612 scanned)')
    expect(formatted.structured).toMatchObject({ changed: true, dom: DOM })
  })

  it('keeps the plain no-change path when no DOM dimension exists', async () => {
    const formatted = await formatDiffResult(
      { text: '', added: 0, removed: 0, changed: false },
      'https://example.com',
    )
    expect(formatted.text).toBe('no change since last snapshot')
    expect(formatted.structured).toEqual({ changed: false })
  })
})
