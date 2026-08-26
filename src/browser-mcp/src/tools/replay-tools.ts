/**
 * P2-3 (batch 3b) — replay read face over the BrowserClaw server (0.0.46-hub
 * harness patch).
 *
 * claw-app's content script records every eligible tab (rrweb, <all_urls>)
 * into claw-server, and claw-reporter.ts feeds hub's dispatches + tab claims
 * into the same audit trail — so hub sessions already appear in the cockpit
 * with attributed recordings. These tools are the read side for hub itself:
 * discover recorded streams (`replay.list`) and export one as a
 * self-contained HTML replay (`replay.export`) — rrweb-player vendored in
 * ../assets, events plus the session's dispatch timeline embedded, and
 * clicking a dispatch row seeks the player.
 *
 * Both tools are browserless (claw-server HTTP only, never a CDP connection),
 * like the space and audit families. The shared functions return the
 * observation-tools outcome shape so the CLI wrapper (cli.js `hub replay`)
 * and the MCP tools run one implementation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { clawServerBaseUrl, clawSessionIdOf } from './claw-reporter'
import { defineTool } from './framework'
import { hubUserRoot, ownerOf } from '../../../space/task-space-manager.js'

const REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

export interface ClawStreamEntry {
  documentId: string
  tabId: number
  targetId?: string
  firstEventAt: number
  lastEventAt: number
  sizeBytes: number
  eventCount: number
  hasGap: boolean
}

export interface ClawDispatchRow {
  dispatchId: number
  createdAt: number
  toolName: string
  label?: string
  tabId?: number
  url?: string
  title?: string
  resultMeta?: string
  durationMs?: number
}

export type QueryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; [extra: string]: unknown } }

function queryError(outcome: { ok: false; error: { code: string; message: string; [k: string]: unknown } }) {
  const { code, message, ...extra } = outcome.error
  return {
    content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
    isError: true,
    structuredContent: { code, message, ...extra },
  }
}

async function clawGet(path: string): Promise<Response> {
  return fetch(`${clawServerBaseUrl()}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

/** One claw-server GET mapped onto the outcome shape (network errors and
 * non-2xx responses both collapse to `claw_unreachable`). */
async function clawGetOutcome<T>(
  path: string,
  parse: (response: Response) => Promise<T>,
): Promise<QueryOutcome<T>> {
  let response: Response
  try {
    response = await clawGet(path)
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'claw_unreachable',
        message: `BrowserClaw server unreachable at ${clawServerBaseUrl()}: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'claw_unreachable',
        message: `BrowserClaw server ${path} -> HTTP ${response.status}`,
      },
    }
  }
  return { ok: true, value: await parse(response) }
}

export interface ClawStreamFilter {
  fromMs?: number
  toMs?: number
  tabId?: number
  limit?: number
}

/** List recorded streams (newest first) from the claw-server discovery index. */
export async function listClawStreams(
  filter: ClawStreamFilter = {},
): Promise<QueryOutcome<ClawStreamEntry[]>> {
  const params = new URLSearchParams()
  if (filter.fromMs !== undefined) params.set('fromMs', String(filter.fromMs))
  if (filter.toMs !== undefined) params.set('toMs', String(filter.toMs))
  if (filter.tabId !== undefined) params.set('tabId', String(filter.tabId))
  params.set('limit', String(filter.limit ?? DEFAULT_LIST_LIMIT))
  const qs = params.toString()
  return clawGetOutcome(`/api/v1/recordings/streams${qs ? `?${qs}` : ''}`, async (response) => {
    const body = (await response.json()) as { streams?: unknown }
    return Array.isArray(body.streams)
      ? (body.streams as ClawStreamEntry[]).filter(
          (entry) => typeof entry?.documentId === 'string',
        )
      : []
  })
}

/** Read one document's rrweb events (NDJSON) as parsed objects. */
export async function fetchStreamEvents(
  documentId: string,
  window?: { fromMs?: number; toMs?: number },
): Promise<QueryOutcome<unknown[]>> {
  const params = new URLSearchParams()
  if (window?.fromMs !== undefined) params.set('fromMs', String(window.fromMs))
  if (window?.toMs !== undefined) params.set('toMs', String(window.toMs))
  const qs = params.toString()
  return clawGetOutcome(
    `/api/v1/recordings/streams/${encodeURIComponent(documentId)}/events${qs ? `?${qs}` : ''}`,
    async (response) => {
      const ndjson = await response.text()
      const events: unknown[] = []
      for (const line of ndjson.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          events.push(JSON.parse(trimmed))
        } catch {
          // Torn tail line (a concurrent writer's partial flush): skip it.
        }
      }
      return events
    },
  )
}

/** Fetch a claw session's summary + ordered dispatches; unknown sessions read
 * as undefined so callers can embed a timeline opportunistically. */
export async function fetchSessionTimeline(
  sessionId: string,
): Promise<QueryOutcome<{ session: { sessionId?: string; slug?: string; status?: string }; dispatches: ClawDispatchRow[] } | undefined>> {
  let response: Response
  try {
    response = await clawGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'claw_unreachable',
        message: `BrowserClaw server unreachable at ${clawServerBaseUrl()}: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
  if (response.status === 404) return { ok: true, value: undefined }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'claw_unreachable',
        message: `BrowserClaw server /api/v1/sessions/{id} -> HTTP ${response.status}`,
      },
    }
  }
  const body = (await response.json()) as {
    session?: Record<string, unknown>
    dispatches?: unknown[]
  }
  return {
    ok: true,
    value: {
      session: (body.session ?? {}) as { sessionId?: string; slug?: string; status?: string },
      dispatches: (Array.isArray(body.dispatches) ? body.dispatches : []).map((row) => {
        const d = row as Record<string, unknown>
        return {
          dispatchId: typeof d.dispatchId === 'number' ? d.dispatchId : 0,
          createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
          toolName: typeof d.toolName === 'string' ? d.toolName : '?',
          ...(typeof d.label === 'string' && { label: d.label }),
          ...(typeof d.tabId === 'number' && { tabId: d.tabId }),
          ...(typeof d.url === 'string' && { url: d.url }),
          ...(typeof d.title === 'string' && { title: d.title }),
          ...(typeof d.resultMeta === 'string' && { resultMeta: d.resultMeta }),
          ...(typeof d.durationMs === 'number' && { durationMs: d.durationMs }),
        } satisfies ClawDispatchRow
      }),
    },
  }
}

// ── self-contained HTML export ────────────────────────────────────────

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets')

let playerAssets: { js: string; css: string } | undefined

function loadPlayerAssets(): { js: string; css: string } | undefined {
  if (playerAssets !== undefined) return playerAssets
  try {
    playerAssets = {
      js: readFileSync(join(ASSETS_DIR, 'rrweb-player.umd.min.js'), 'utf8'),
      css: readFileSync(join(ASSETS_DIR, 'rrweb-player.style.css'), 'utf8'),
    }
  } catch {
    playerAssets = undefined
  }
  return playerAssets
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** `</script>` inside embedded JSON would terminate the host script tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('</script', '<\\/script')
}

function iso(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '?'
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

function fmtOffset(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const m = Math.floor(clamped / 60)
  const s = Math.floor(clamped % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Official rows carry resultMeta as JSON ("{"isError":false,...}"); hub
 * harness rows match since P2-3 follow-up. Render a compact label from the
 * JSON shape, falling back to the raw string for older plain-text rows. */
function resultMetaLabel(meta: string): string {
  try {
    const parsed = JSON.parse(meta) as {
      isError?: boolean
      guard?: string
      error?: string
    }
    if (parsed !== null && typeof parsed === 'object') {
      if (parsed.isError === true) {
        const head = `error${parsed.guard !== undefined ? ` [${parsed.guard}]` : ''}`
        return parsed.error !== undefined ? `${head}: ${String(parsed.error).slice(0, 60)}` : head
      }
      return 'ok'
    }
  } catch {
    // plain-text row (legacy)
  }
  return meta.slice(0, 60)
}

export interface ReplayExportInput {
  stream: ClawStreamEntry
  events: unknown[]
  timeline?: { session: { sessionId?: string; slug?: string; status?: string }; dispatches: ClawDispatchRow[] }
}

/** Assemble the self-contained replay HTML (player + events + timeline). */
export function buildReplayHtml(input: ReplayExportInput): string {
  const assets = loadPlayerAssets()
  if (assets === undefined) {
    throw new Error(
      `replay assets missing under ${ASSETS_DIR} (rrweb-player.umd.min.js / rrweb-player.style.css)`,
    )
  }
  const { stream, events, timeline } = input
  const typedEvents = events as Array<{ type?: number; timestamp?: number; data?: { width?: number; height?: number } }>
  const base = typedEvents[0]?.timestamp ?? 0
  const end = typedEvents.length > 0 ? typedEvents[typedEvents.length - 1]?.timestamp ?? base : base
  const durationSec = Math.max(0, (end - base) / 1000)
  // rrweb sizes the player from the Meta event's viewport; fall back when the
  // window starts after the snapshot (fromMs filtering).
  const meta = typedEvents.find((event) => event.type === 4)
  const width = meta?.data?.width ?? 1280
  const height = meta?.data?.height ?? 800

  const dispatches =
    timeline?.dispatches.map((row) => {
      const offsetSec = base > 0 ? (row.createdAt - base) / 1000 : 0
      const clamped = Math.min(Math.max(offsetSec, 0), durationSec)
      return {
        t: clamped,
        tool: row.toolName,
        meta: resultMetaLabel(row.resultMeta ?? ''),
        duration: row.durationMs ?? 0,
        url: row.url ?? '',
      }
    }) ?? []

  const title = `hub replay ${stream.documentId.slice(0, 8)} (tab ${stream.tabId})`

  const timelineRows = dispatches
    .map(
      (d) =>
        `      <div class="dispatch" data-t="${d.t.toFixed(1)}"><span class="t">${fmtOffset(d.t)}</span><span class="tool">${escapeHtml(d.tool)}</span><span class="meta">${escapeHtml(d.meta)}${d.duration > 0 ? ` · ${d.duration}ms` : ''}</span>${d.url ? `<span class="url">${escapeHtml(d.url)}</span>` : ''}</div>`,
    )
    .join('\n')

  const header = [
    `doc ${escapeHtml(stream.documentId.slice(0, 12))}…`,
    `tab ${stream.tabId}`,
    `${stream.eventCount} events`,
    sizeLabel(stream.sizeBytes),
    `${iso(stream.firstEventAt)} → ${iso(stream.lastEventAt)}`,
    ...(stream.hasGap ? ['has gap'] : []),
    ...(timeline ? [`${dispatches.length} dispatches (${escapeHtml(timeline.session.slug ?? '?')})`] : []),
  ].join(' · ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${assets.css}
body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #101418; color: #d8dee6; }
header { padding: 10px 16px; border-bottom: 1px solid #2a3138; color: #8aa0b4; }
.layout { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; }
.stage { flex: 1 1 auto; min-width: 0; overflow: auto; }
.stage .replayer-wrapper { margin: 0 auto; }
aside { flex: 0 0 340px; max-height: calc(100vh - 70px); overflow: auto; border: 1px solid #2a3138; border-radius: 8px; background: #151a20; }
aside h2 { margin: 0; padding: 8px 12px; font-size: 12px; font-weight: 600; color: #8aa0b4; border-bottom: 1px solid #2a3138; position: sticky; top: 0; background: #151a20; }
.dispatch { padding: 6px 12px; border-bottom: 1px solid #1d232b; cursor: pointer; display: grid; grid-template-columns: 44px 1fr; gap: 2px 8px; }
.dispatch:hover { background: #1d242e; }
.dispatch .t { color: #5fa9e6; }
.dispatch .tool { font-weight: 600; }
.dispatch .meta { grid-column: 2; color: #8aa0b4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dispatch .url { grid-column: 2; color: #5d7a5d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 12px; color: #66727e; }
</style>
</head>
<body>
<header>${header}</header>
<div class="layout">
  <main class="stage"><div id="player"></div></main>
  <aside>
    <h2>hub dispatch timeline</h2>
${timelineRows.length > 0 ? timelineRows : '    <div class="empty">(no dispatches)</div>'}
  </aside>
</div>
<script>
${assets.js}
</script>
<script>
var EVENTS = ${embedJson(events)};
var player = new rrwebPlayer({
  target: document.getElementById('player'),
  props: {
    events: EVENTS,
    width: ${Math.round(width)},
    height: ${Math.round(height)},
    autoPlay: false,
    showController: true,
    speedOption: [1, 2, 4, 8],
  },
});
document.querySelectorAll('.dispatch').forEach(function (row) {
  row.addEventListener('click', function () {
    player.goto(parseFloat(row.getAttribute('data-t')), true);
  });
});
</script>
</body>
</html>
`
}

export interface ClawReplayExportResult {
  path: string
  documentId: string
  eventCount: number
  bytes: number
  dispatchCount: number
  durationSec: number
}

export interface ClawReplayExportOptions {
  documentId: string
  /** Claw session whose dispatch timeline to embed; omit for a bare replay. */
  sessionId?: string
  fromMs?: number
  toMs?: number
  /** Output path; defaults to ~/.hub/replays/<docId-prefix>.html. */
  out?: string
}

/** Export one recorded stream as a self-contained HTML replay. */
export async function exportClawReplay(
  options: ClawReplayExportOptions,
): Promise<QueryOutcome<ClawReplayExportResult>> {
  const eventsOutcome = await fetchStreamEvents(options.documentId, {
    fromMs: options.fromMs,
    toMs: options.toMs,
  })
  if (eventsOutcome.ok === false) return eventsOutcome
  const events = eventsOutcome.value
  if (events.length === 0) {
    return {
      ok: false,
      error: {
        code: 'replay_empty',
        message: `no recorded events for document ${options.documentId} (unknown documentId, or the fromMs/toMs window excludes the stream)`,
        documentId: options.documentId,
      },
    }
  }
  const stream = await findStreamEntry(options.documentId)
  if (stream.ok === false) return stream

  let timeline: ReplayExportInput['timeline']
  if (options.sessionId !== undefined) {
    const timelineOutcome = await fetchSessionTimeline(options.sessionId)
    // A missing timeline degrades to a bare replay; only transport errors fail.
    if (timelineOutcome.ok === false) return timelineOutcome
    timeline = timelineOutcome.value
  }

  let html: string
  try {
    html = buildReplayHtml({ stream: stream.value, events, timeline })
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'replay_assets_missing',
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
  const outPath =
    options.out ?? join(hubUserRoot(), 'replays', `${options.documentId.slice(0, 12)}.html`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, html)

  const typedEvents = events as Array<{ timestamp?: number }>
  const base = typedEvents[0]?.timestamp ?? 0
  const end = typedEvents[typedEvents.length - 1]?.timestamp ?? base
  return {
    ok: true,
    value: {
      path: outPath,
      documentId: options.documentId,
      eventCount: events.length,
      bytes: Buffer.byteLength(html, 'utf8'),
      dispatchCount: timeline?.dispatches.length ?? 0,
      durationSec: Math.max(0, (end - base) / 1000),
    },
  }
}

/** Resolve one stream's index entry (tab, size, window) for the export header. */
async function findStreamEntry(documentId: string): Promise<QueryOutcome<ClawStreamEntry>> {
  const listOutcome = await listClawStreams({ limit: MAX_LIST_LIMIT })
  if (listOutcome.ok === false) return listOutcome
  const entry = listOutcome.value.find((stream) => stream.documentId === documentId)
  if (entry === undefined) {
    return {
      ok: false,
      error: {
        code: 'replay_metadata_missing',
        message: `document ${documentId} has events but no index entry (recent ingest? retry shortly)`,
        documentId,
      },
    }
  }
  return { ok: true, value: entry }
}

// ── MCP tools ─────────────────────────────────────────────────────────

export const replay_list = defineTool({
  name: 'replay.list',
  description:
    "List recorded browser-replay streams from the BrowserClaw server (rrweb recordings captured by the browser's claw extension — every eligible tab, including hub's). Streams are newest-first with the documentId, tab, event count, size, and time window. Pass a documentId to replay.export to export a self-contained HTML replay. Filters: tabId, fromMs/toMs (epoch ms window), limit.",
  input: z
    .object({
      tabId: z.number().int().optional().describe('Only streams recorded on this Chrome tab id.'),
      fromMs: z
        .number()
        .int()
        .optional()
        .describe('Only streams whose last event is at/after this epoch-ms timestamp.'),
      toMs: z
        .number()
        .int()
        .optional()
        .describe('Only streams whose first event is at/before this epoch-ms timestamp.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max streams (default 50).'),
    })
    .strict(),
  annotations: { title: 'List replay recordings', readOnlyHint: true },
  handler: async (args) => {
    const outcome = await listClawStreams(args)
    if (outcome.ok === false) return queryError(outcome)
    const lines = outcome.value.map(
      (stream) =>
        `[${stream.documentId.slice(0, 8)}] tab=${stream.tabId} ${stream.eventCount} events ${sizeLabel(stream.sizeBytes)} ${iso(stream.firstEventAt)} → ${iso(stream.lastEventAt)}${stream.hasGap ? ' gap' : ''}`,
    )
    return {
      content: [
        {
          type: 'text' as const,
          text:
            lines.length > 0
              ? `${lines.length} recorded stream(s):\n${lines.join('\n')}`
              : '(no recorded streams; open pages in the browser first — recording is passive)',
        },
      ],
      structuredContent: { streams: outcome.value, count: outcome.value.length },
    }
  },
})

export const replay_export = defineTool({
  name: 'replay.export',
  description:
    'Export one recorded replay stream as a self-contained HTML file (open in any browser, no server needed): rrweb-player with the full event stream plus the session\'s hub dispatch timeline — click a dispatch row to jump the player to that moment. The timeline embeds this conversation\'s claw session automatically; pass sessionId to pick another session, or omit for none. Returns the file path.',
  input: z
    .object({
      documentId: z.string().min(1).describe('Recording document id (from replay.list).'),
      sessionId: z
        .string()
        .optional()
        .describe('Claw session id whose dispatch timeline to embed (defaults to this conversation\'s session).'),
      fromMs: z.number().int().optional().describe('Clip events before this epoch-ms timestamp.'),
      toMs: z.number().int().optional().describe('Clip events after this epoch-ms timestamp.'),
      out: z.string().optional().describe('Output file path (default ~/.hub/replays/<docId>.html).'),
    })
    .strict(),
  annotations: { title: 'Export replay as HTML' },
  handler: async (args, ctx) => {
    // Default timeline = the calling conversation's own claw session, so an
    // agent exporting its replay sees its own actions by default.
    let sessionId = args.sessionId
    if (sessionId === undefined && ctx.identity !== undefined) {
      sessionId = clawSessionIdOf(ownerOf(ctx.identity))
    }
    const outcome = await exportClawReplay({
      documentId: args.documentId,
      ...(sessionId !== undefined && { sessionId }),
      ...(args.fromMs !== undefined && { fromMs: args.fromMs }),
      ...(args.toMs !== undefined && { toMs: args.toMs }),
      ...(args.out !== undefined && { out: args.out }),
    })
    if (outcome.ok === false) return queryError(outcome)
    const result = outcome.value
    return {
      content: [
        {
          type: 'text' as const,
          text: `replay exported: ${result.path} (${result.eventCount} events, ${result.dispatchCount} dispatches, ${result.durationSec.toFixed(0)}s)`,
        },
      ],
      structuredContent: result,
    }
  },
})

export const REPLAY_TOOLS = [replay_list, replay_export] as const
