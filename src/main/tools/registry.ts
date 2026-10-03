import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import type { Settings, ToolInfo, ToolPermission } from '@shared/types'
import { customToolImpl } from './custom'
import { fsTools } from './fs'
import { imageTools } from './image'
import type { McpManager } from './mcp'
import { shellTools } from './shell'
import type { ToolImpl } from './types'
import { webTools } from './web'

export interface Entry {
  impl: ToolImpl
  info: ToolInfo
}

export class ToolRegistry {
  constructor(
    private getSettings: () => Settings,
    private mcp: McpManager
  ) {}

  permissionFor(settings: Settings, tool: Pick<ToolImpl, 'name' | 'defaultPermission'>): ToolPermission {
    return settings.agent.toolPermissions[tool.name] ?? tool.defaultPermission
  }

  /** Every tool known to the app with its availability — used by the Tools page. */
  entries(imageAvailable: boolean): Entry[] {
    const settings = this.getSettings()
    const seen = new Set<string>()
    const out: Entry[] = []
    const add = (impl: ToolImpl, available = true, reason?: string) => {
      if (seen.has(impl.name)) {
        out.push({ impl, info: this.info(settings, impl, false, `Name "${impl.name}" is already used by another tool`) })
        return
      }
      seen.add(impl.name)
      out.push({ impl, info: this.info(settings, impl, available, reason) })
    }

    for (const t of [...fsTools(), ...shellTools(), ...webTools()]) add(t)
    for (const t of imageTools()) add(t, imageAvailable, imageAvailable ? undefined : 'Set up an image model first (Models → Image models)')

    for (const cfg of settings.customTools) {
      if (!cfg.enabled) continue
      const r = customToolImpl(cfg)
      if (r.tool) add(r.tool)
      else {
        const stub: ToolImpl = {
          name: cfg.name || '(unnamed)',
          description: cfg.description,
          parameters: {},
          source: 'custom',
          group: 'Custom',
          defaultPermission: cfg.permission,
          execute: async () => ({ content: r.error ?? 'invalid tool', isError: true })
        }
        out.push({ impl: stub, info: this.info(settings, stub, false, r.error) })
      }
    }
    for (const t of this.mcp.tools()) add(t)
    return out
  }

  /** Tools to offer to the model in a run (available and not denied). */
  forRun(imageAvailable: boolean): ToolImpl[] {
    const settings = this.getSettings()
    return this.entries(imageAvailable)
      .filter((e) => e.info.available && this.permissionFor(settings, e.impl) !== 'deny')
      .map((e) => e.impl)
  }

  private info(settings: Settings, impl: ToolImpl, available: boolean, reason?: string): ToolInfo {
    return {
      name: impl.name,
      description: impl.description,
      source: impl.source,
      group: impl.group,
      permission: this.permissionFor(settings, impl),
      defaultPermission: impl.defaultPermission ?? BUILTIN_TOOL_DEFAULTS[impl.name] ?? 'ask',
      available,
      unavailableReason: reason
    }
  }
}
