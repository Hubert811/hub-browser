import type { UnifiedPage } from '../../page.js'
import type { SnapshotDiff } from '@browseros/browser-core/core/snapshot/diff'
import { TIMEOUTS } from '@browseros/shared/constants/timeouts'
import { formatDiffResult } from './tools/diff-format'
import { pageUrl } from './tools/page-utils'
import { formatSnapshotResult } from './tools/snapshot-format'

export type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

type PostAction =
  | SnapshotPostAction
  | { type: 'screenshot'; page: number }
  | DiffPostAction
  | { type: 'pages' }

type SnapshotPostAction = {
  type: 'snapshot'
  page: number
}

type DiffPostAction = {
  type: 'diff'
  page: number
  includeStructured?: boolean
}

export interface ToolResultMetadata {
  tabId?: number
}

export interface ToolResult {
  content: ContentItem[]
  isError?: boolean
  metadata?: ToolResultMetadata
  structuredContent?: unknown
}

export interface ToolResponseOptions {
  postActionTimeoutMs?: number
}

/** Structural page context used for post-action readback (satisfied by ToolContext). */
export interface PageContext {
  page: UnifiedPage
  pageFor(pageId: number): Promise<UnifiedPage>
}

export class ToolResponse {
  private content: ContentItem[] = []
  private hasError = false
  private structured: unknown
  private postActions: PostAction[] = []
  private postActionTimeoutMs: number

  constructor(options: ToolResponseOptions = {}) {
    this.postActionTimeoutMs =
      options.postActionTimeoutMs ?? TIMEOUTS.TOOL_POST_ACTION
  }

  text(value: string): void {
    this.content.push({ type: 'text', text: value })
  }

  image(data: string, mimeType: string): void {
    this.content.push({ type: 'image', data, mimeType })
  }

  error(message: string): void {
    this.hasError = true
    this.content.push({ type: 'text', text: message })
  }

  data(key: string, value: unknown): void
  data(obj: Record<string, unknown>): void
  data(keyOrObj: string | Record<string, unknown>, value?: unknown): void {
    const current = isRecord(this.structured) ? this.structured : {}
    if (typeof keyOrObj === 'string') {
      current[keyOrObj] = value
      this.structured = current
      return
    }
    Object.assign(current, keyOrObj)
    this.structured = current
  }

  /** Merges a returned ToolResult into this response during incremental tool migration. */
  appendResult(result: ToolResult): void {
    this.content.push(...result.content)
    if (result.isError) this.hasError = true
    if ('structuredContent' in result) {
      if (isRecord(result.structuredContent)) {
        this.data(result.structuredContent)
      } else {
        this.structured = result.structuredContent
      }
    }
  }

  includeSnapshot(page: number): void {
    this.postActions.push({ type: 'snapshot', page })
  }

  includeScreenshot(page: number): void {
    this.postActions.push({ type: 'screenshot', page })
  }

  includeDiff(
    page: number,
    options: { includeStructured?: boolean } = {},
  ): void {
    this.postActions.push({
      type: 'diff',
      page,
      includeStructured: options.includeStructured,
    })
  }

  includePages(): void {
    this.postActions.push({ type: 'pages' })
  }

  private async runPagePostAction(
    action: PostAction,
    pageContext: PageContext,
  ): Promise<void> {
    switch (action.type) {
      case 'snapshot': {
        const page = await pageContext.pageFor(action.page)
        const text = (await page.snapshot()) as string
        const origin = await pageUrl(page, action.page)
        await this.appendSnapshotPostAction(action, text, origin)
        return
      }
      case 'screenshot': {
        const page = await pageContext.pageFor(action.page)
        const data = (await page.screenshot({ format: 'png' })) as string
        this.text(`[Page ${action.page} screenshot]`)
        this.image(data, 'image/png')
        return
      }
      case 'diff': {
        const page = await pageContext.pageFor(action.page)
        const d = (await page.diff()) as SnapshotDiff
        const origin = d.afterUrl ?? (await pageUrl(page, action.page))
        await this.appendDiffPostAction(action, d, origin)
        return
      }
      case 'pages': {
        const pages = (await pageContext.page.tabs()) as unknown as Array<{
          pageId: number
          title?: string
          url: string
          isActive?: boolean
        }>
        if (pages.length === 0) {
          this.text('[Open pages] None')
        } else {
          const lines = pages.map(
            (p) =>
              `  ${p.pageId}. ${p.title || '(untitled)'} — ${p.url}${p.isActive ? ' [ACTIVE]' : ''}`,
          )
          this.text(`[Open pages]\n${lines.join('\n')}`)
        }
        return
      }
    }
  }

  private async appendSnapshotPostAction(
    action: SnapshotPostAction,
    snapshot: string,
    origin: string,
  ): Promise<void> {
    const formatted = await formatSnapshotResult(snapshot, origin)
    this.text(`[Page ${action.page} snapshot]\n${formatted.text}`)
  }

  private async appendDiffPostAction(
    action: DiffPostAction,
    diff: SnapshotDiff,
    origin: string,
  ): Promise<void> {
    const formatted = await formatDiffResult(diff, origin)
    this.text(`[Page ${action.page} diff]\n${formatted.text}`)
    if (action.includeStructured) {
      this.data({
        changed: diff.changed,
        ...(diff.urlChanged && {
          urlChanged: true,
          beforeUrl: diff.beforeUrl,
          afterUrl: diff.afterUrl,
        }),
      })
    }
  }

  private async withTimeout<T>(task: Promise<T>): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        task,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('Post-action timed out'))
          }, this.postActionTimeoutMs)
        }),
      ])
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  /** Builds a compact browser-tool result after running UnifiedPage post-actions. */
  async buildForPage(pageContext: PageContext): Promise<ToolResult> {
    if (this.postActions.length > 0) {
      this.text('\n--- Additional context (auto-included) ---')
    }

    for (const action of this.postActions) {
      try {
        await this.withTimeout(this.runPagePostAction(action, pageContext))
      } catch {
        // Post-action failure doesn't fail the tool
      }
    }
    return this.toResult()
  }

  toResult(): ToolResult {
    return {
      content: this.content,
      ...(this.hasError && { isError: true }),
      ...(this.structured !== undefined && {
        structuredContent: this.structured,
      }),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
