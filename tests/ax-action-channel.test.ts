import { describe, expect, test } from 'bun:test';
import { BasePage, type AxActionChannel } from '../src/opencli/base-page.js';
import { TargetError } from '../src/opencli/target-errors.js';

/**
 * P2-8 原语下沉 — the AX action channel contract.
 *
 * BasePage's action methods prefer the browser-core channel whenever the ref
 * is an AX ref from the last snapshot (`eN`/`N` present in `_axRefs`); every
 * other ref keeps the page-JS resolver path (opencli-adapter compatibility
 * surface). These tests pin the routing, the return shapes (opencli
 * contract), the TargetError contract on the AX path, and the fallback when
 * the channel fails.
 */

type ChannelCall = { method: string; args: unknown[] };

type StateHandler = (ref: string, expr: string) => unknown;

/** Recording mock of AxActionChannel — readState answers via the `state` handler. */
function recordingChannel(opts: { state?: StateHandler; fail?: string[] } = {}): AxActionChannel & { calls: ChannelCall[] } {
  const calls: ChannelCall[] = [];
  const fail = opts.fail ?? [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (fail.includes(method)) throw new Error(`channel ${method} failed`);
  };
  const readState = async (ref: string, expr: string): Promise<unknown> => {
    calls.push({ method: 'readState', args: [ref, expr] });
    if (fail.includes('readState')) throw new Error('channel readState failed');
    return opts.state?.(ref, expr) ?? null;
  };
  const knownRefs = new Set<string>();
  return {
    calls,
    knownRefs,
    click: (async (ref: string, clickOpts?: { clickCount?: number }) => {
      calls.push({ method: 'click', args: [ref, clickOpts] });
      if (fail.includes('click')) throw new Error('channel click failed');
    }) as AxActionChannel['click'],
    hover: record('hover') as AxActionChannel['hover'],
    focus: record('focus') as AxActionChannel['focus'],
    fill: record('fill') as AxActionChannel['fill'],
    check: (async (ref: string) => {
      calls.push({ method: 'check', args: [ref] });
      return true;
    }) as AxActionChannel['check'],
    uncheck: (async (ref: string) => {
      calls.push({ method: 'uncheck', args: [ref] });
      return false;
    }) as AxActionChannel['uncheck'],
    uploadFile: record('uploadFile') as AxActionChannel['uploadFile'],
    dragRefs: record('dragRefs') as AxActionChannel['dragRefs'],
    scrollIntoViewRef: record('scrollIntoViewRef') as AxActionChannel['scrollIntoViewRef'],
    readState: readState as AxActionChannel['readState'],
    clickAt: record('clickAt') as AxActionChannel['clickAt'],
    hoverAt: record('hoverAt') as AxActionChannel['hoverAt'],
    dragAt: record('dragAt') as AxActionChannel['dragAt'],
    typeText: record('typeText') as AxActionChannel['typeText'],
    press: record('press') as AxActionChannel['press'],
    centerRef: (async (ref: string) => {
      calls.push({ method: 'centerRef', args: [ref] });
      return { x: 10, y: 20 };
    }) as AxActionChannel['centerRef'],
    hasRef: (ref: string) => knownRefs.has(ref),
  };
}

/** State-handler matchers keyed on what the probe expr inspects. */
const isCheckableProbe = (expr: string) => expr.includes('aria-checked');
const isFillVerifyProbe = (expr: string) => expr.includes('HTMLInputElement');
const isFileStateProbe = (expr: string) => expr.includes('multiple') && !expr.includes('files[');
const isFileNamesProbe = (expr: string) => expr.includes('files[');

type MockChannel = AxActionChannel & { calls: ChannelCall[]; knownRefs: Set<string> };

class FakePage extends BasePage {
  evaluateCalls: string[] = [];
  /** Per-js result: a value, or a fn(js) => value. */
  evalResult: unknown = null;
  private mockChannel: MockChannel | null = null;

  setChannel(channel: MockChannel | null): void {
    this.mockChannel = channel;
  }

  /**
   * Mark `ref` as a live AX ref the channel's Observer knows — the way a real
   * AX snapshot would. The channel (not a page-instance mirror) is the ref
   * authority, mirroring the daemon's per-command page rebuilds.
   */
  seedAxRef(ref: string): void {
    this.mockChannel?.knownRefs.add(ref);
  }

  protected override axChannel(): AxActionChannel | null {
    return this.mockChannel;
  }

  async evaluate(js: string): Promise<unknown> {
    this.evaluateCalls.push(js);
    if (typeof this.evalResult === 'function') return (this.evalResult as (js: string) => unknown)(js);
    return this.evalResult;
  }

  async goto(): Promise<void> {}
  async getCookies(): Promise<never[]> { return []; }
  async screenshot(): Promise<string> { return ''; }
  async tabs(): Promise<never[]> { return []; }
  async selectTab(): Promise<void> {}
}

/** DOM-path eval results for the click fallback chain. */
function clickDomEval(js: string): unknown {
  // resolveTargetJs embeds window.__opencli_ref_identity — its unique marker.
  if (js.includes('__opencli_ref_identity')) return { ok: true, matches_n: 1, match_level: 'exact' };
  if (js.includes('getBoundingClientRect') || js.includes('boundingRect')) return null;
  if (js.includes('__resolved')) return { status: 'clicked' };
  return null;
}

describe('P2-8 AX action channel — routing', () => {
  test('click on a live AX ref rides the channel with zero page JS', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);
    page.seedAxRef('e1');

    const result = await page.click('e1');

    expect(result).toEqual({ matches_n: 1, match_level: 'exact' });
    expect(channel.calls.map((c) => c.method)).toEqual(['click']);
    expect(channel.calls[0].args[0]).toBe('e1');
    expect(page.evaluateCalls).toEqual([]); // the whole action stayed on the channel
  });

  test('click falls back to the DOM resolver when the channel throws', async () => {
    const page = new FakePage();
    const channel = recordingChannel({ fail: ['click'] });
    page.setChannel(channel);
    page.seedAxRef('e1');
    page.evalResult = clickDomEval;

    const result = await page.click('e1');

    // Channel tried first, then the resolver + JS click chain executed.
    expect(channel.calls.map((c) => c.method)).toEqual(['click']);
    expect(page.evaluateCalls.some((js) => js.includes('__opencli_ref_identity'))).toBe(true);
    expect(result).toEqual({ matches_n: 1, match_level: 'exact' });
  });

  test('non-AX refs and unknown AX refs never touch the channel', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);
    page.seedAxRef('e1');
    page.evalResult = clickDomEval;

    await page.click('h1'); // DOM-selector ref
    await page.click('e99'); // numeric ref but not in the table

    expect(channel.calls).toEqual([]);
    expect(page.evaluateCalls.filter((js) => js.includes('__opencli_ref_identity'))).toHaveLength(2);
  });

  test('base class without a channel keeps the page-JS behavior', async () => {
    const page = new FakePage(); // no setChannel — axChannel() stays null
    page.seedAxRef('e1');
    page.evalResult = clickDomEval;

    const result = await page.click('e1');

    expect(result).toEqual({ matches_n: 1, match_level: 'exact' });
    expect(page.evaluateCalls.some((js) => js.includes('__opencli_ref_identity'))).toBe(true);
  });

  test('dblClick dispatches clickCount: 2 through the channel', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);
    page.seedAxRef('e2');

    const result = await page.dblClick('e2');

    expect(result).toEqual({ matches_n: 1, match_level: 'exact' });
    expect(channel.calls[0]).toEqual({ method: 'click', args: ['e2', { clickCount: 2 }] });
    expect(page.evaluateCalls).toEqual([]);
  });
});

describe('P2-8 AX action channel — action family', () => {
  test('hover / focus / typeText ride the channel', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);
    page.seedAxRef('e1');
    page.seedAxRef('e2');
    page.seedAxRef('e3');

    await page.hover('e1');
    const focused = await page.focus('e2');
    await page.typeText('e3', 'hello');

    expect(channel.calls.map((c) => c.method)).toEqual(['hover', 'focus', 'fill']);
    expect((channel.calls[2].args[1] as unknown)).toBe('hello');
    // fill rides with clear:false so `type` keeps its append semantics.
    expect(channel.calls[2].args[2]).toEqual({ clear: false });
    expect(focused).toEqual({ matches_n: 1, match_level: 'exact', focused: true });
    expect(page.evaluateCalls).toEqual([]);
  });

  test('pressKey uses the channel and skips page-JS keys', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);

    await page.pressKey('Ctrl+Enter');

    expect(channel.calls).toEqual([{ method: 'press', args: ['Enter', ['Ctrl']] }]);
    expect(page.evaluateCalls).toEqual([]);
  });

  test('drag on two AX refs rides the channel with the DragResult shape', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);
    page.seedAxRef('e1');
    page.seedAxRef('e2');

    const result = await page.drag('e1', 'e2');

    expect(result).toEqual({
      dragged: true,
      source: 'e1',
      target: 'e2',
      source_matches_n: 1,
      target_matches_n: 1,
      source_match_level: 'exact',
      target_match_level: 'exact',
    });
    expect(channel.calls.map((c) => c.method)).toEqual(['dragRefs']);
    expect(page.evaluateCalls).toEqual([]);
  });

  test('scrollTo rides the channel and reports target info', async () => {
    const page = new FakePage();
    const channel = recordingChannel(); // readState returns null — target info omitted
    page.setChannel(channel);
    page.seedAxRef('e1');

    const result = (await page.scrollTo('e1')) as Record<string, unknown>;

    expect(channel.calls.map((c) => c.method)).toEqual(['scrollIntoViewRef', 'readState']);
    expect(result.scrolled).toBe(true);
    expect(result.matches_n).toBe(1);
    expect(result.match_level).toBe('exact');
    expect(page.evaluateCalls).toEqual([]);
  });

  test('refCenter uses the channel center', async () => {
    const page = new FakePage();
    const channel = recordingChannel();
    page.setChannel(channel);
    page.seedAxRef('e1');

    await expect(page.refCenter('e1')).resolves.toEqual({ x: 10, y: 20 });
  });
});

describe('P2-8 AX action channel — fillText contract', () => {
  test('fill + verify keeps the FillTextResult shape', async () => {
    const page = new FakePage();
    const verify = { ok: true, actual: 'hub', length: 3, mode: 'input' };
    const channel = recordingChannel({
      state: (ref, expr) => (isFillVerifyProbe(expr) ? verify : null),
    });
    page.setChannel(channel);
    page.seedAxRef('e1');

    const result = await page.fillText('e1', 'hub');

    expect(result).toEqual({
      matches_n: 1,
      match_level: 'exact',
      filled: true,
      verified: true,
      expected: 'hub',
      actual: 'hub',
      length: 3,
      mode: 'input',
    });
    expect(channel.calls.map((c) => c.method)).toEqual(['fill', 'readState']);
    expect(page.evaluateCalls).toEqual([]);
  });

  test('not_editable surfaces the TargetError contract, no DOM fallback', async () => {
    const page = new FakePage();
    const channel = recordingChannel({
      state: (ref, expr) => (isFillVerifyProbe(expr) ? { ok: false, reason: 'not_editable', tag: 'div' } : null),
    });
    page.setChannel(channel);
    page.seedAxRef('e1');

    let threw: unknown;
    try {
      await page.fillText('e1', 'hub');
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(TargetError);
    expect((threw as TargetError).code).toBe('not_editable');
    expect(page.evaluateCalls).toEqual([]); // contract errors don't silently retry the DOM path
  });
});

describe('P2-8 AX action channel — setChecked contract', () => {
  function channelWithCheckable(before: unknown, after: unknown) {
    let call = 0;
    return recordingChannel({
      state: (ref, expr) => {
        if (!isCheckableProbe(expr)) return null;
        call += 1;
        return call === 1 ? before : after;
      },
    });
  }

  test('radio targets cannot be unchecked — TargetError contract', async () => {
    const page = new FakePage();
    page.setChannel(channelWithCheckable({ ok: true, checked: true, disabled: false, kind: 'radio' }, null));
    page.seedAxRef('e1');

    let threw: unknown;
    try {
      await page.setChecked('e1', false);
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(TargetError);
    expect((threw as TargetError).code).toBe('not_checkable');
    expect(page.evaluateCalls).toEqual([]);
  });

  test('already-checked is idempotent — no click dispatched', async () => {
    const page = new FakePage();
    const channel = channelWithCheckable({ ok: true, checked: true, disabled: false, kind: 'checkbox' }, null);
    page.setChannel(channel);
    page.seedAxRef('e1');

    const result = await page.setChecked('e1', true);

    expect(result).toEqual({ matches_n: 1, match_level: 'exact', checked: true, changed: false, kind: 'checkbox' });
    expect(channel.calls.map((c) => c.method)).toEqual(['readState']); // no check() call
  });

  test('successful check verifies the final state', async () => {
    const page = new FakePage();
    const channel = channelWithCheckable(
      { ok: true, checked: false, disabled: false, kind: 'checkbox' },
      { ok: true, checked: true, disabled: false, kind: 'checkbox' },
    );
    page.setChannel(channel);
    page.seedAxRef('e1');

    const result = await page.setChecked('e1', true);

    expect(result).toEqual({ matches_n: 1, match_level: 'exact', checked: true, changed: true, kind: 'checkbox' });
    expect(channel.calls.map((c) => c.method)).toEqual(['readState', 'check', 'readState']);
    expect(page.evaluateCalls).toEqual([]);
  });

  test('non-checkable target surfaces not_checkable without DOM fallback', async () => {
    const page = new FakePage();
    page.setChannel(channelWithCheckable({ ok: false, reason: 'not_checkable', tag: 'div', role: '' }, null));
    page.seedAxRef('e1');

    let threw: unknown;
    try {
      await page.setChecked('e1', true);
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(TargetError);
    expect((threw as TargetError).code).toBe('not_checkable');
    expect(page.evaluateCalls).toEqual([]);
  });
});

describe('P2-8 AX action channel — uploadFiles contract', () => {
  function channelWithFileState(state: unknown, names: unknown = ['a.pdf']) {
    return recordingChannel({
      state: (ref, expr) => {
        if (isFileStateProbe(expr)) return state;
        if (isFileNamesProbe(expr)) return names;
        return null;
      },
    });
  }

  test('non file input surfaces not_file_input without the marker dance', async () => {
    const page = new FakePage();
    page.setChannel(channelWithFileState({ ok: false, reason: 'not_file_input', tag: 'div', type: '' }));
    page.seedAxRef('e1');

    let threw: unknown;
    try {
      await page.uploadFiles('e1', ['/tmp/a.pdf']);
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(TargetError);
    expect((threw as TargetError).code).toBe('not_file_input');
    expect(page.evaluateCalls).toEqual([]);
  });

  test('multiple files on a single input is rejected', async () => {
    const page = new FakePage();
    page.setChannel(channelWithFileState({ ok: true, multiple: false, accept: '' }));
    page.seedAxRef('e1');

    let threw: unknown;
    try {
      await page.uploadFiles('e1', ['/tmp/a.pdf', '/tmp/b.pdf']);
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(TargetError);
    expect((threw as TargetError).code).toBe('not_file_input');
  });

  test('upload rides DOM.setFileInputFiles by backendNodeId and reports file names', async () => {
    const page = new FakePage();
    const channel = channelWithFileState({ ok: true, multiple: false, accept: '.pdf' }, ['report.pdf']);
    page.setChannel(channel);
    page.seedAxRef('e1');

    const result = await page.uploadFiles('e1', ['/tmp/report.pdf']);

    expect(result).toEqual({
      matches_n: 1,
      match_level: 'exact',
      uploaded: true,
      files: 1,
      file_names: ['report.pdf'],
      target: 'e1',
      multiple: false,
      accept: '.pdf',
    });
    expect(channel.calls.map((c) => c.method)).toEqual(['readState', 'uploadFile', 'readState']);
    expect(page.evaluateCalls).toEqual([]);
  });
});
