import type { UnifiedPage } from '../../../page.js'

export interface PageInfo {
  pageId: number
  url: string
  title?: string
  targetId?: string
  tabId?: number
  isActive?: boolean
}

/** Lists tabs through UnifiedPage and finds the requested page id. */
export async function pageInfo(
  page: UnifiedPage,
  pageId?: number,
): Promise<PageInfo | undefined> {
  const tabs = (await page.tabs()) as unknown as PageInfo[]
  if (pageId === undefined) return tabs.find((t) => t.isActive) ?? tabs[0]
  return tabs.find((t) => t.pageId === pageId)
}

/** Best-effort origin URL for a page id; 'unknown' when it cannot be listed. */
export async function pageUrl(
  page: UnifiedPage,
  pageId: number,
): Promise<string> {
  try {
    return (await pageInfo(page, pageId))?.url ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
