import type { SnapshotDiff } from '@browseros/browser-core/core/snapshot/diff'
import { writeTempToolOutputFile } from './output-file'
import {
  estimateTextTokens,
  sliceTextByEstimatedTokens,
} from './token-estimate'
import { wrapUntrusted } from './trust-boundary'

const MAX_INLINE_DIFF_TOKENS = 10_000
const MAX_INLINE_EXCERPT_TOKENS = 5_000

export interface FormattedDiff {
  text: string
  structured?: Record<string, unknown>
}

/** P3-5 — DOM-dimension section (fingerprint set diff), independent of the
 * AX `changed` flag: a spinner div can appear while the interactive-role AX
 * tree stays identical, and that is exactly what this section surfaces. */
function renderDomSection(diff: SnapshotDiff): string {
  if (diff.dom === undefined) return ''
  const { added, removed, scanned } = diff.dom
  const lines = [`DOM changes (+${added.length} added / -${removed.length} removed, ${scanned} scanned):`]
  for (const entry of added) lines.push(`  + ${entry.desc}`)
  for (const entry of removed) lines.push(`  - ${entry.desc}`)
  return lines.join('\n')
}

/** Formats observer diffs for direct tools and automatic post-action readback. */
export async function formatDiffResult(
  diff: SnapshotDiff,
  origin: string,
): Promise<FormattedDiff> {
  const domSection = renderDomSection(diff)
  if (!diff.changed && domSection === '') {
    return {
      text: 'no change since last snapshot',
      structured: { changed: false },
    }
  }
  if (!diff.changed) {
    // AX tree is identical but the DOM moved — surface just the DOM section.
    return {
      text: domSection,
      structured: {
        changed: false,
        ...(diff.dom !== undefined && { dom: diff.dom }),
      },
    }
  }

  const structured = {
    changed: true,
    added: diff.added,
    removed: diff.removed,
    ...(diff.dom !== undefined && { dom: diff.dom }),
    ...(diff.lineDiffSkipped && { lineDiffSkipped: true }),
    ...(diff.urlChanged && {
      urlChanged: true,
      beforeUrl: diff.beforeUrl,
      afterUrl: diff.afterUrl,
    }),
  }
  const diffText = diff.text || '(empty page)'

  if (diff.lineDiffSkipped) {
    return {
      text: [
        `${diffText}\nTake a fresh snapshot for the current state.`,
        domSection,
      ].filter(Boolean).join('\n'),
      structured,
    }
  }

  const wrappedDiff = wrapUntrusted(diffText, origin)
  const tokenEstimate = estimateTextTokens(wrappedDiff)

  if (tokenEstimate > MAX_INLINE_DIFF_TOKENS) {
    const excerpt = sliceTextByEstimatedTokens(
      diffText,
      MAX_INLINE_EXCERPT_TOKENS,
    )
    try {
      const path = await writeTempToolOutputFile({
        toolName: 'diff',
        extension: 'md',
        content: wrappedDiff,
      })
      const summary = diff.urlChanged
        ? `URL changed; full current snapshot is ${tokenEstimate} estimated tokens, over the ${MAX_INLINE_DIFF_TOKENS}-token inline limit, saved to: ${path}\nRead the file for the full current snapshot.`
        : `Diff is ${tokenEstimate} estimated tokens, over the ${MAX_INLINE_DIFF_TOKENS}-token inline limit, saved to: ${path}\nRead the file for the full diff.`
      return {
        text: [
          summary,
          `Showing the first ${MAX_INLINE_EXCERPT_TOKENS} estimated tokens inline:`,
          wrapUntrusted(excerpt, origin),
          domSection,
        ].filter(Boolean).join('\n'),
        structured: {
          ...structured,
          truncated: true,
          tokenEstimate,
          path,
          contentLength: wrappedDiff.length,
          writtenToFile: true,
        },
      }
    } catch (error) {
      const saveError = error instanceof Error ? error.message : String(error)
      const text = diff.urlChanged
        ? `URL changed; full current snapshot is ${tokenEstimate} estimated tokens, over the ${MAX_INLINE_DIFF_TOKENS}-token inline limit, but saving it to a BrowserOS output file failed: ${saveError}`
        : `Diff is ${tokenEstimate} estimated tokens, over the ${MAX_INLINE_DIFF_TOKENS}-token inline limit, but saving it to a BrowserOS output file failed: ${saveError}`
      return {
        text: [
          text,
          `Showing the first ${MAX_INLINE_EXCERPT_TOKENS} estimated tokens instead:`,
          wrapUntrusted(excerpt, origin),
          domSection,
        ].filter(Boolean).join('\n'),
        structured: {
          ...structured,
          truncated: true,
          tokenEstimate,
          contentLength: wrappedDiff.length,
          writtenToFile: false,
          outputWriteFailed: true,
          error: saveError,
        },
      }
    }
  }

  if (diff.urlChanged) {
    return {
      text: [
        `URL changed; returning full current snapshot instead of a diff:\n${wrappedDiff}`,
        domSection,
      ].filter(Boolean).join('\n'),
      structured,
    }
  }

  return {
    text: [wrappedDiff, domSection].filter(Boolean).join('\n'),
    structured,
  }
}
