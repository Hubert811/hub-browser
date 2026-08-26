import type { UnifiedPage } from '../../../page.js'
import { z } from 'zod'
import {
  defineTool,
  errorResult,
  type ToolResult,
  textResult,
} from './framework'

// Flat (not discriminated-union) schema: some providers reject nested anyOf JSON Schema. The kind
// is validated at runtime in the handler. All page mutation goes through this one tool.
export const act = defineTool({
  name: 'act',
  description:
    'Act on the page using refs from the last snapshot. kinds: click, type (into focused element), fill (one field via ref+value, or many via fields[]), press (a key/combo), hover, focus, check, uncheck, select (an option value), scroll, drag. Reads back a diff of what changed - re-snapshot if you need fresh refs.',
  input: z.object({
    page: z.number().int(),
    kind: z.enum([
      'click',
      'click_at',
      'type',
      'type_at',
      'fill',
      'press',
      'hover',
      'hover_at',
      'focus',
      'check',
      'uncheck',
      'select',
      'scroll',
      'drag',
      'drag_at',
    ]),
    ref: z.string().optional().describe('Target element ref, e.g. "e12".'),
    text: z.string().optional().describe('Text for kind=type.'),
    value: z.string().optional().describe('Value for kind=fill/select.'),
    fields: z
      .array(z.object({ ref: z.string(), value: z.string() }).strict())
      .optional()
      .describe('Multiple fields for kind=fill, filled in order.'),
    key: z
      .string()
      .optional()
      .describe('Key/combo for kind=press, e.g. "Enter", "Control+a".'),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z
      .number()
      .optional()
      .describe('Scroll amount (wheel notches), default 3.'),
    x: z.number().optional().describe('Viewport x coordinate for *_at kinds.'),
    y: z.number().optional().describe('Viewport y coordinate for *_at kinds.'),
    targetRef: z.string().optional().describe('Target ref for kind=drag.'),
    startX: z.number().optional().describe('Drag start x coordinate.'),
    startY: z.number().optional().describe('Drag start y coordinate.'),
    endX: z.number().optional().describe('Drag end x coordinate.'),
    endY: z.number().optional().describe('Drag end y coordinate.'),
    button: z.enum(['left', 'middle', 'right']).optional(),
    clickCount: z.number().int().optional(),
    clear: z.boolean().optional(),
  }).strict(),
  annotations: {
    title: 'Interact with page',
    destructiveHint: true,
  },
  handler: async (args, ctx, response) => {
    const page = await ctx.pageFor(args.page)

    const err = await runKind(args as ActArgs, page)
    if (err) return err

    response.data({ kind: args.kind })
    response.includeDiff(args.page, { includeStructured: true })
    return textResult(`ok (${args.kind})`)
  },
})

type ActArgs = {
  kind: string
  ref?: string
  text?: string
  value?: string
  fields?: { ref: string; value: string }[]
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  x?: number
  y?: number
  targetRef?: string
  startX?: number
  startY?: number
  endX?: number
  endY?: number
  button?: 'left' | 'middle' | 'right'
  clickCount?: number
  clear?: boolean
}

type ActHandler = (
  args: ActArgs,
  page: UnifiedPage,
) => Promise<ToolResult | undefined>

const ACT_HANDLERS: Record<string, ActHandler> = {
  click: clickRef,
  click_at: clickAt,
  type: typeFocused,
  type_at: typeAt,
  fill,
  press,
  hover,
  hover_at: hoverAt,
  focus,
  check,
  uncheck,
  select,
  scroll,
  drag,
  drag_at: dragAt,
}

async function runKind(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  // Real-browser quirk (2026-08-03): Chrome ignores Input.dispatchMouseEvent on
  // background/occluded tabs (the call never resolves). Foreground the target
  // tab before any action so raw-input kinds (scroll/hover_at/click_at/type_at)
  // work on space.open_tab'd background tabs too.
  await page.activateTab?.().catch(() => {})
  const handler = ACT_HANDLERS[args.kind]
  return handler
    ? handler(args, page)
    : errorResult(`act: unknown kind "${args.kind}".`)
}

async function clickRef(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref) return errorResult('act click: ref is required.')
  const button = mouseButton(args.button)
  const clickCount = args.clickCount ?? 1
  const needsRaw = button !== 'left' || clickCount !== 1
  if (needsRaw) {
    const point = await page.refCenter(args.ref)
    if (point) {
      await dispatchClickAt(page, point.x, point.y, button, clickCount)
      return undefined
    }
  }
  await page.click(args.ref)
  return undefined
}

async function clickAt(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  const point = pointFromArgs(args, 'click_at')
  if ('content' in point) return point
  await dispatchClickAt(page, point.x, point.y, mouseButton(args.button), args.clickCount ?? 1)
  return undefined
}

async function typeFocused(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (args.text === undefined) return errorResult('act type: text is required.')
  await page.nativeType(args.text)
  return undefined
}

async function typeAt(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  const point = pointFromArgs(args, 'type_at')
  if ('content' in point) return point
  if (args.text === undefined)
    return errorResult('act type_at: text is required.')
  await dispatchClickAt(page, point.x, point.y, 'left', 1)
  if (args.clear) await clearFocused(page)
  await page.nativeType(args.text)
  return undefined
}

async function fill(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (args.fields) {
    for (const field of args.fields)
      await page.fillText(field.ref, field.value)
    return undefined
  }
  if (args.ref && args.value !== undefined) {
    await page.fillText(args.ref, args.value)
    return undefined
  }
  return errorResult('act fill: provide fields[] or both ref and value.')
}

async function press(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.key) return errorResult('act press: key is required.')
  await page.pressKey(args.key)
  return undefined
}

async function hover(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref) return errorResult('act hover: ref is required.')
  await page.hover(args.ref)
  return undefined
}

async function hoverAt(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  const point = pointFromArgs(args, 'hover_at')
  if ('content' in point) return point
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  })
  return undefined
}

async function focus(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref) return errorResult('act focus: ref is required.')
  await page.focus(args.ref)
  return undefined
}

async function check(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref) return errorResult('act check: ref is required.')
  await page.setChecked(args.ref, true)
  return undefined
}

async function uncheck(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref) return errorResult('act uncheck: ref is required.')
  await page.setChecked(args.ref, false)
  return undefined
}

async function select(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref || args.value === undefined) {
    return errorResult('act select: ref and value are required.')
  }
  const result = (await page.selectOption(args.ref, args.value)) as
    | string
    | { error?: string }
    | null
    | undefined
  if (typeof result === 'string') return undefined
  if (result && 'error' in result) {
    return errorResult(`act select: ${result.error}`)
  }
  return errorResult('act select: option not found or target is not a <select>.')
}

async function scroll(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  const direction = args.direction ?? 'down'
  // browser-core Input.scroll semantics: each wheel notch = 120px, dispatched
  // as a real mouseWheel event (fires page wheel listeners).
  const pixels = (args.amount ?? 3) * 120
  const deltaX =
    direction === 'left' ? -pixels : direction === 'right' ? pixels : 0
  const deltaY =
    direction === 'up' ? -pixels : direction === 'down' ? pixels : 0
  if (deltaX === 0 && deltaY === 0) return undefined

  let point: { x: number; y: number } | null = null
  if (args.ref) {
    point = await page.refCenter(args.ref)
    if (!point) {
      await page.scrollTo(args.ref)
      return undefined
    }
  } else {
    const metrics = (await page.cdp('Page.getLayoutMetrics')) as
      | { layoutViewport?: { clientWidth?: number; clientHeight?: number } }
      | null
      | undefined
    const viewport = metrics?.layoutViewport
    point = {
      x: Math.round((viewport?.clientWidth ?? 0) / 2),
      y: Math.round((viewport?.clientHeight ?? 0) / 2),
    }
  }
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  })
  return undefined
}

async function drag(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (!args.ref || !args.targetRef) {
    return errorResult('act drag: ref and targetRef are required.')
  }
  await page.drag(args.ref, args.targetRef)
  return undefined
}

async function dragAt(
  args: ActArgs,
  page: UnifiedPage,
): Promise<ToolResult | undefined> {
  if (
    args.startX === undefined ||
    args.startY === undefined ||
    args.endX === undefined ||
    args.endY === undefined
  ) {
    return errorResult(
      'act drag_at: startX, startY, endX, and endY are required.',
    )
  }
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: args.startX,
    y: args.startY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: args.endX,
    y: args.endY,
    button: 'left',
    buttons: 1,
  })
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: args.endX,
    y: args.endY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  return undefined
}

function pointFromArgs(
  args: ActArgs,
  kind: string,
): { x: number; y: number } | ToolResult {
  if (args.x === undefined || args.y === undefined) {
    return errorResult(`act ${kind}: x and y are required.`)
  }
  return { x: args.x, y: args.y }
}

function mouseButton(
  button?: 'left' | 'middle' | 'right',
): 'left' | 'middle' | 'right' {
  if (button === 'middle' || button === 'right') return button
  return 'left'
}

async function dispatchClickAt(
  page: UnifiedPage,
  x: number,
  y: number,
  button: 'left' | 'middle' | 'right',
  clickCount: number,
): Promise<void> {
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount,
  })
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount,
  })
}

/** Mirrors browser-core keyboard.clearField(): select-all + Backspace. */
async function clearFocused(page: UnifiedPage): Promise<void> {
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await page.cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers,
    windowsVirtualKeyCode: 65,
  })
  await page.cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers,
    windowsVirtualKeyCode: 65,
  })
  await page.cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  })
  await page.cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  })
}

