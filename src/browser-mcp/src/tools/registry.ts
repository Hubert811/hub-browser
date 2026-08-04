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
export const SPACE_TOOLS: readonly ToolDefinition[] = SPACE_TOOLS_REGISTRY

