import { z } from 'zod'
import { defineTool, errorResult, textResult } from './framework'

/**
 * P3-5 — probe tools. `inspect` deep-probes one snapshot ref's backing
 * element through the vendored browser-core Observer (resolveRefEntry
 * channel): full class list, all attributes, ancestor path, candidate
 * selectors verified unique in the live document, and an outerHTML head.
 * The inline snapshot DOM unit (`→ input#q [sel="#q"]`) is the overview;
 * inspect is the drill-down when an adapter needs exact detail.
 */

interface InspectCandidate {
  strategy: string
  selector: string
}

interface InspectDetailShape {
  tag: string
  id?: string
  classes: string[]
  attributes: Record<string, string>
  text: string
  ancestors: Array<{ tag: string; id?: string; classes: string[] }>
  candidateSelectors: InspectCandidate[]
  outerHtml?: string
}

export const inspect = defineTool({
  name: 'inspect',
  description:
    "Deep-probe the element behind one snapshot ref: full classes, all attributes, ancestor path (6 levels), candidate stable selectors (each verified unique — strategies: id / data-testid / class / structural), text, and an outerHTML head. Use it while writing adapters when the snapshot's inline `→ tag#id [sel=...]` DOM unit is not enough detail.",
  input: z
    .object({
      page: z.number().int().describe('Page id from `tabs` or `navigate`.'),
      ref: z.string().describe('Element ref from the last snapshot, e.g. "e12".'),
    })
    .strict(),
  annotations: { title: 'Inspect element by ref', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)

    let detail: unknown
    try {
      detail = await page.inspectRef(args.ref)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResult(`inspect: ${message}`)
    }
    const d = detail as InspectDetailShape
    if (typeof d?.tag !== 'string') {
      return errorResult(`inspect: ref ${args.ref} returned no detail (stale?). Take a new snapshot.`)
    }

    return textResult(renderInspect(args.ref, d), {
      page: args.page,
      ref: args.ref,
      ...d,
    })
  },
})

function renderInspect(ref: string, d: InspectDetailShape): string {
  const lines: string[] = []
  const head =
    d.id !== undefined ? `<${d.tag} id="${d.id}">` : `<${d.tag}>`
  lines.push(`${head} (ref ${ref})`)
  if (d.classes.length > 0) lines.push(`classes: ${d.classes.join(' ')}`)
  const attrKeys = Object.keys(d.attributes).sort()
  if (attrKeys.length > 0) {
    lines.push('attributes:')
    for (const key of attrKeys) lines.push(`  ${key} = ${d.attributes[key]}`)
  }
  if (d.ancestors.length > 0) {
    lines.push(
      `path: ${d.ancestors
        .map((a) => {
          const idPart = a.id !== undefined ? `#${a.id}` : ''
          const clsPart = a.classes.length > 0 ? `.${a.classes.slice(0, 3).join('.')}` : ''
          return `${a.tag}${idPart}${clsPart}`
        })
        .join(' < ')}`,
    )
  }
  if (d.candidateSelectors.length > 0) {
    lines.push('candidate selectors (verified unique):')
    for (const c of d.candidateSelectors) lines.push(`  [${c.strategy}] ${c.selector}`)
  } else {
    lines.push('candidate selectors: (none unique — locate via ancestors)')
  }
  if (d.text) lines.push(`text: ${d.text}`)
  if (d.outerHtml !== undefined) lines.push(`html: ${d.outerHtml}`)
  return lines.join('\n')
}

export const PROBE_TOOLS: readonly ReturnType<typeof defineTool>[] = [inspect]
