import { act } from './act'
import { diff } from './diff'
import { download } from './download'
import { evaluate } from './evaluate'
import type { ToolDefinition } from './framework'
import { grep } from './grep'
import { history } from './history'
import { navigate } from './navigate'
import { pdf } from './pdf'
import { read } from './read'
import { run } from './run'
import { screenshot } from './screenshot'
import { snapshot } from './snapshot'
import { tab_groups } from './tab-groups'
import { tabs } from './tabs'
import { upload } from './upload'
import { wait } from './wait'
import { windows } from './windows'
import { SPACE_TOOLS as SPACE_TOOLS_REGISTRY } from './space-tools'
import { PAGE_INFO_TOOLS as PAGE_INFO_TOOLS_LIST } from './page-info'
import { OBSERVATION_TOOLS as OBSERVATION_TOOLS_LIST } from './observation-tools'
import { DISCOVERY_TOOLS as DISCOVERY_TOOLS_LIST } from './discovery-tools'
import { PROBE_TOOLS as PROBE_TOOLS_LIST } from './inspect'

export const BROWSER_TOOLS: readonly ToolDefinition[] = [
  tabs,
  tab_groups,
  history,
  navigate,
  snapshot,
  diff,
  act,
  download,
  upload,
  read,
  grep,
  screenshot,
  pdf,
  wait,
  windows,
  evaluate,
  run,
]

/**
 * Phase 3 — `space.*` tools (additive fork surface). Kept separate from
 * BROWSER_TOOLS so the 17-tool contract list stays pinned; both lists are
 * registered by registerBrowserTools (space tools are plain wrappers over the
 * shared TaskSpaceManager).
 */
/**
 * P2-6 (batch 1) — page-info tools (frames / extract): capabilities the CLI
 * had as direct implementations, now single-sourced as tool definitions so
 * both faces share one implementation (and the CLI commands run through the
 * executeTool gate: guard + audit). Kept out of BROWSER_TOOLS to keep the
 * 17-tool contract list pinned, mirroring the SPACE_TOOLS precedent.
 */
export const PAGE_INFO_TOOLS: readonly ToolDefinition[] = PAGE_INFO_TOOLS_LIST

/**
 * P2-6 (batch 2) — observation tools (network / console): the network capture
 * (shape previews + keyed detail bodies) and console snapshot pipelines,
 * shared with the CLI commands through browser/observation-query.js.
 */
export const OBSERVATION_TOOLS: readonly ToolDefinition[] = OBSERVATION_TOOLS_LIST

/**
 * P2-6 (batch 3) — discovery tools (find / analyze): the structured element
 * query (CSS or semantic locator) and the site-recon pipeline, shared with
 * the CLI commands through browser/{find,analyze}.js + observation-query.js.
 */
export const DISCOVERY_TOOLS: readonly ToolDefinition[] = DISCOVERY_TOOLS_LIST

/**
 * P3-5 — probe tools (inspect): deep-dive one snapshot ref into full DOM
 * detail (classes/attributes/ancestor path/verified candidate selectors),
 * powered by the vendored browser-core Observer's inspectRef channel.
 * Companion to the inline snapshot DOM units (`→ tag#id [sel=...]`).
 */
export const PROBE_TOOLS: readonly ToolDefinition[] = PROBE_TOOLS_LIST

export const SPACE_TOOLS: readonly ToolDefinition[] = SPACE_TOOLS_REGISTRY

