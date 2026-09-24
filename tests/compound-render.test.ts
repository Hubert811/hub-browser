/**
 * C2 — the compound suffix used to be rendered inside page.ts with zero test
 * coverage. It now reads `DomUnit.extras` (folded into browser-core's DOM-unit
 * probe) and shapes the text through this pure helper.
 */
import { describe, expect, it } from 'bun:test'
import { COMPOUND_EXTRAS_JS, renderCompoundDesc } from '../src/opencli/compound'

describe('renderCompoundDesc', () => {
  it('renders a single-select with its current value and a sample of options', () => {
    expect(
      renderCompoundDesc({
        control: 'select',
        multiple: false,
        current: '北京',
        options_total: 31,
        options: [{ label: '北京' }, { label: '上海' }],
      } as never),
    ).toBe('select, 31 options, current: 北京, e.g. 北京/上海')
  })

  it('marks a multi-select and caps the sample at five labels', () => {
    const options = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label }))
    const desc = renderCompoundDesc({
      control: 'select',
      multiple: true,
      current: 'a,b',
      options_total: 6,
      options,
    } as never)
    expect(desc).toBe('select, 6 options (multi), current: a,b, e.g. a/b/c/d/e')
  })

  it('renders a file input with its accept filter', () => {
    expect(
      renderCompoundDesc({
        control: 'file',
        multiple: true,
        accept: 'image/*',
      } as never),
    ).toBe('file (multi), accept: image/*')
  })

  it('renders a date-like control with its format and empty current', () => {
    expect(
      renderCompoundDesc({
        control: 'date',
        format: 'YYYY-MM-DD',
        current: '',
      } as never),
    ).toBe('date, format: YYYY-MM-DD, current: none')
  })
})

describe('COMPOUND_EXTRAS_JS', () => {
  it('defines the hook browser-core looks for, wrapping the probe', () => {
    expect(COMPOUND_EXTRAS_JS).toContain('function __domUnitExtras(el)')
    expect(COMPOUND_EXTRAS_JS).toContain('compoundInfoOf(el)')
    // The hook must compile as one unit with the probe source.
    expect(() => new Function(`${COMPOUND_EXTRAS_JS}\nreturn __domUnitExtras;`)).not.toThrow()
  })
})
