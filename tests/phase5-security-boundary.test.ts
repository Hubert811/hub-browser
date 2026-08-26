/**
 * Phase 5 — 安全边界（双写 Vue setter + Trust Boundary 接线）
 *
 * 5.2: typeResolvedJs / typeTextJs 生成的浏览器 JS 在原生 setter 双写之外
 *      补 el._value（Vue/React 受控组件内部缓存值）。
 * 5.3: read/grep/evaluate/snapshot 等把页面内容原样返回给 LLM 的输出必须带
 *      [UNTRUSTED_PAGE_CONTENT nonce=... origin=...] 包裹，且开始/结束标记
 *      nonce 一致。
 */
import { describe, expect, it } from 'bun:test'
import { typeTextJs } from '../src/opencli/dom-helpers.ts'
import { typeResolvedJs } from '../src/opencli/target-resolver.ts'
import { evaluate } from '../src/browser-mcp/src/tools/evaluate'
import { executeTool } from '../src/browser-mcp/src/tools/framework'
import { grep } from '../src/browser-mcp/src/tools/grep'
import { read } from '../src/browser-mcp/src/tools/read'
import { formatSnapshotResult } from '../src/browser-mcp/src/tools/snapshot-format'
import {
  makeContext,
  pageFromSession,
  textOf,
} from '../src/browser-mcp/src/tools/test-helpers'

const NONCE = /[0-9a-f]{16}/

function markerAssertions(text: string, origin: string): void {
  const start = text.match(
    new RegExp(
      `\\[UNTRUSTED_PAGE_CONTENT nonce=(${NONCE.source}) origin=${origin.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )}\\]`,
    ),
  )
  expect(start).not.toBeNull()
  const end = text.match(
    new RegExp(`\\[END_UNTRUSTED_PAGE_CONTENT nonce=(${NONCE.source})\\]`),
  )
  expect(end).not.toBeNull()
  // 开始/结束标记必须共用同一个 nonce，恶意页面无法伪造结束标记逃逸。
  expect(start?.[1]).toBe(end?.[1])
}

// ───────────────────────────── 5.2 双写 _value ─────────────────────────────

describe('5.2 双写 Vue setter 补 el._value', () => {
  it('typeResolvedJs 在原生 setter 后写 el._value（input/textarea 分支）', () => {
    const js = typeResolvedJs('hello world')
    expect(js).toContain('el._value = "hello world";')
    expect(js).toContain('nativeSetter.call(el, "hello world");')
    expect(js).toContain(
      "el.dispatchEvent(new Event('input', { bubbles: true }));",
    )
    expect(js).toContain(
      "el.dispatchEvent(new Event('change', { bubbles: true }));",
    )
    // _value 只出现在 input/textarea 分支，contenteditable 分支不写
    expect(js.match(/el\._value =/g)).toHaveLength(1)
    expect(js).toContain("document.execCommand('insertText', false,")
  })

  it('typeResolvedJs 对特殊字符做 JSON 转义且 setter 与 _value 一致', () => {
    const text = 'a"b\\c\nd\'e'
    const js = typeResolvedJs(text)
    const expected = JSON.stringify(text)
    expect(js).toContain(`el._value = ${expected};`)
    expect(js).toContain(`nativeSetter.call(el, ${expected});`)
  })

  it('typeTextJs（dom-helpers 路径）同样补 el._value', () => {
    const js = typeTextJs('e12', '你好 Vue')
    expect(js).toContain('el._value = "你好 Vue";')
    expect(js).toContain('nativeSetter.call(el, "你好 Vue");')
    expect(js).toContain(
      "el.dispatchEvent(new Event('input', { bubbles: true }));",
    )
    expect(js).toContain(
      "el.dispatchEvent(new Event('change', { bubbles: true }));",
    )
    expect(js.match(/el\._value =/g)).toHaveLength(1)
  })
})

// ───────────────────────────── 5.3 Trust Boundary ──────────────────────────

function sessionWithReadText(text: string): unknown {
  return {
    pages: {
      list: async () => [
        {
          pageId: 5,
          targetId: 'target-5',
          url: 'https://example.com/read',
          title: 'Read',
          tabId: 7,
          isActive: true,
        },
      ],
      getSession: async () => ({
        session: {
          Runtime: { evaluate: async () => ({ result: { value: text } }) },
        },
        sessionId: 's1',
      }),
      getInfo: () => ({ url: 'https://example.com/read' }),
    },
    dispose: async () => {},
  }
}

function sessionWithSnapshotText(text: string): unknown {
  return {
    observe: () => ({
      snapshot: async () => ({ text, refs: { byRef: new Map() } }),
      lastRefs: { byRef: new Map(), get: () => undefined },
    }),
    pages: {
      list: async () => [
        {
          pageId: 4,
          targetId: 'target-4',
          url: 'https://example.com/grep',
          title: 'Grep',
          tabId: 8,
          isActive: true,
        },
      ],
      getSession: async () => ({
        session: {
          Runtime: { evaluate: async () => ({ result: { value: '' } }) },
          DOM: { resolveNode: async () => ({}) },
        },
        sessionId: 's1',
      }),
      getInfo: () => ({ url: 'https://example.com/grep' }),
    },
    dispose: async () => {},
  }
}

function sessionWithEvaluateValue(value: unknown): unknown {
  return {
    pages: {
      list: async () => [
        {
          pageId: 3,
          targetId: 'target-3',
          url: 'https://example.com/evaluate',
          title: 'Evaluate',
          tabId: 9,
          isActive: true,
        },
      ],
      getSession: async () => ({
        session: {
          Runtime: {
            evaluate: async () => ({ result: { value } }),
          },
        },
        sessionId: 's1',
      }),
      getInfo: () => ({ url: 'https://example.com/evaluate' }),
    },
    dispose: async () => {},
  }
}

describe('5.3 Trust Boundary 接线', () => {
  it('read 返回页面内容带 UNTRUSTED 标记且 origin 正确', async () => {
    const page = pageFromSession(
      sessionWithReadText('fake page text read tool'),
      5,
    )
    const result = await executeTool(
      read,
      { page: 5, format: 'text' },
      makeContext(page),
    )

    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('fake page text read tool')
    markerAssertions(text, 'https://example.com/read')
  })

  it('read 空内容也包裹（(empty) 而非裸空串）', async () => {
    const page = pageFromSession(sessionWithReadText(''), 5)
    const result = await executeTool(
      read,
      { page: 5, format: 'text' },
      makeContext(page),
    )

    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('(empty)')
    markerAssertions(text, 'https://example.com/read')
  })

  it('grep 匹配行带 UNTRUSTED 标记且 origin 正确', async () => {
    const page = pageFromSession(
      sessionWithSnapshotText(
        'button "Save" [ref=e1]\nlink "Home"\nbutton "Save draft" [ref=e2]',
      ),
      4,
    )
    const result = await executeTool(
      grep,
      { page: 4, pattern: 'save', over: 'ax' },
      makeContext(page),
    )

    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('button "Save" [ref=e1]')
    markerAssertions(text, 'https://example.com/grep')
  })

  it('grep 无匹配返回固定文案不包裹', async () => {
    const page = pageFromSession(
      sessionWithSnapshotText('link "Home"\nlink "About"'),
      4,
    )
    const result = await executeTool(
      grep,
      { page: 4, pattern: 'checkout', over: 'ax' },
      makeContext(page),
    )

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('no matches')
    expect(textOf(result)).not.toContain('UNTRUSTED_PAGE_CONTENT')
  })

  it('evaluate 返回值带 UNTRUSTED 标记且 origin 正确', async () => {
    const page = pageFromSession(
      sessionWithEvaluateValue('page-injected-value'),
      3,
    )
    const result = await executeTool(
      evaluate,
      { page: 3, code: 'return document.title' },
      makeContext(page),
    )

    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('page-injected-value')
    markerAssertions(text, 'https://example.com/evaluate')
  })

  it('snapshot 格式化输出带 UNTRUSTED 标记且 origin 正确', async () => {
    const formatted = await formatSnapshotResult(
      '- button "Save" [ref=e1]',
      'https://example.com/snapshot',
    )

    expect(formatted.text).toContain('- button "Save" [ref=e1]')
    markerAssertions(formatted.text, 'https://example.com/snapshot')
  })
})
