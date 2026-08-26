/**
 * P0-1 run sandbox — worker-side bridge source.
 *
 * The agent's script executes inside a `worker_threads` Worker started with
 * `{ eval: true }` from this string. The worker never touches CDP itself:
 * the `browser` SDK it exposes is a shape-compatible facade whose every
 * method forwards to the main thread over postMessage (the CDP connection
 * and the real SDK built by `createUnifiedBrowserSdk` stay in-process).
 *
 * Message protocol (see run.ts for the main-thread side):
 *   main -> worker: { type: 'start', code }
 *   main -> worker: { type: 'call-result', callId, ok, value | error }
 *   worker -> main: { type: 'log', line }                      (console bridge, FIFO)
 *   worker -> main: { type: 'call', callId, calls: BridgeCall[] }
 *   worker -> main: { type: 'done', ok, value | error }
 *
 * Why calls are sequences, not single invokes: the SDK is chained
 * (`browser.observe(pageId).snapshot()`), and intermediate objects cannot
 * cross the worker boundary. Each BridgeCall step is `{ name, args }` where
 * `args === null` means a plain property access; the main thread resolves
 * the chain sequentially against the real SDK.
 */

/** One step of a bridged SDK call: property access, optionally invoked. */
export interface BridgeCall {
  name: string
  args: unknown[] | null
}

/**
 * Error shape crossing the worker boundary. `code`/`hint` are the P1-4
 * (phase C) structured error contract — the main side attaches them when a
 * bridged call (e.g. browser.tool) fails with a contract error, and the
 * worker reattaches them to the reconstructed Error so scripts can branch on
 * platform codes.
 */
export interface WorkerErrorInfo {
  message: string
  name: string
  code?: string
  hint?: string
}

export type WorkerMessage =
  | { type: 'log'; line: string }
  | { type: 'call'; callId: number; calls: BridgeCall[] }
  | { type: 'done'; ok: true; value: unknown }
  | { type: 'done'; ok: false; error: WorkerErrorInfo }

export type MainToWorkerMessage =
  | { type: 'start'; code: string }
  | {
      type: 'call-result'
      callId: number
      ok: true
      value: unknown
    }
  | {
      type: 'call-result'
      callId: number
      ok: false
      error: WorkerErrorInfo
    }

export const WORKER_SRC = `
const { parentPort } = require('node:worker_threads')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

let nextCallId = 0
const pending = new Map()

function callRemote(calls) {
  return new Promise((resolve, reject) => {
    nextCallId += 1
    pending.set(nextCallId, { resolve, reject })
    parentPort.postMessage({ type: 'call', callId: nextCallId, calls })
  })
}

function fmt(part) {
  if (typeof part === 'string') return part
  try {
    return JSON.stringify(part) || String(part)
  } catch {
    return String(part)
  }
}

function makeConsole() {
  const sink = (level) => (...parts) => {
    parentPort.postMessage({ type: 'log', line: level + parts.map(fmt).join(' ') })
  }
  return {
    log: sink(''),
    info: sink(''),
    warn: sink('warn: '),
    error: sink('error: '),
    debug: sink(''),
  }
}

const P = (name, args) => ({ name, args })

function family(prefix, methods) {
  const out = {}
  for (const name of methods) {
    out[name] = (...args) => callRemote(prefix.concat([P(name, args)]))
  }
  return out
}

// Shape-compatible facade over the main-thread browser SDK (createUnifiedBrowserSdk).
// Keep in sync with the tool DESCRIPTION when the SDK surface changes.
const browserBridge = {
  pages: family([P('pages', null)], ['list', 'newPage', 'close', 'getInfo']),
  observe: (pageId) =>
    family([P('observe', [pageId])], ['snapshot', 'diff', 'resolveRef']),
  input: (pageId) =>
    family(
      [P('input', [pageId])],
      ['click', 'fill', 'type', 'press', 'hover', 'selectOption', 'scroll'],
    ),
  nav: (pageId) =>
    family([P('nav', [pageId])], ['goto', 'back', 'forward', 'reload']),
  // P1-8 tool: routing — whitelisted MCP tools (guard re-runs inside executeTool).
  tool: (name, args) => callRemote([P('tool', [name, args])]),
  cdp: (...args) => callRemote([P('cdp', args)]),
}

function postDone(msg) {
  try {
    parentPort.postMessage(msg)
  } catch (err) {
    // Non-cloneable script return value: degrade to its string form.
    parentPort.postMessage({
      type: 'done',
      ok: msg.ok,
      value: msg.ok ? String(msg.value) : undefined,
      error: msg.error,
    })
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'call-result') {
    const p = pending.get(msg.callId)
    if (!p) return
    pending.delete(msg.callId)
    if (msg.ok) {
      p.resolve(msg.value)
    } else {
      const e = new Error((msg.error && msg.error.message) || 'bridge call failed') as
        Error & { code?: string; hint?: string }
      e.name = (msg.error && msg.error.name) || 'Error'
      // P1-4 (phase C): keep the structured contract attached.
      if (msg.error && typeof msg.error.code === 'string') e.code = msg.error.code
      if (msg.error && typeof msg.error.hint === 'string') e.hint = msg.error.hint
      p.reject(e)
    }
    return
  }
  if (msg.type === 'start') {
    ;(async () => {
      try {
        const fn = new AsyncFunction(
          'browser',
          'console',
          '"use strict";\\n' + msg.code,
        )
        const value = await fn(browserBridge, makeConsole())
        postDone({ type: 'done', ok: true, value })
      } catch (err) {
        postDone({
          type: 'done',
          ok: false,
          error: {
            message: (err && err.message) || String(err),
            name: (err && err.name) || 'Error',
          },
        })
      }
    })()
  }
})
`
