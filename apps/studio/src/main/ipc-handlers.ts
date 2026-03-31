/**
 * IPC Handlers — registers all Electron IPC channels between main and renderer.
 *
 * All pane-specific commands now accept paneId as the first argument so that
 * each pane's agent process, bridge, and orchestrator are addressed separately.
 *
 * Commands: renderer → main (ipcMain.handle, invoked via ipcRenderer.invoke)
 * Events:   main → renderer (webContents.send, received via ipcRenderer.on)
 */

import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { PaneManager } from './pane-manager.js'
import type { SettingsService } from './settings-service.js'
import type { TerminalManager } from './terminal-manager.js'
import type { AuthService } from './auth-service.js'
import { getDisabledVoiceStatus, VOICE_SERVICE_DISABLED_REASON, type VoiceService } from './voice-service.js'
import type { FileService } from './file-service.js'
import type { GitService } from './git-service.js'
import type { FileWatchService } from './file-watch-service.js'
import { sanitizeSettingsForRenderer, validateSettingsPatch } from './settings-contract.js'
import type { ClassifierService } from './classifier-service.js'

type BrowserWindow = import('electron').BrowserWindow
type ElectronApi = Pick<typeof import('electron'), 'ipcMain' | 'shell' | 'dialog'>

const require = createRequire(import.meta.url)

function loadElectron(): ElectronApi {
  try {
    const electron = require('electron') as Partial<ElectronApi>
    if (electron && typeof electron === 'object' && electron.ipcMain && electron.shell && electron.dialog) {
      return electron as ElectronApi
    }
  } catch {
    // Fall through to the Node test mock.
  }

  return require('../../test/__mocks__/electron.cjs') as ElectronApi
}

const electron = loadElectron()
const { ipcMain } = electron

// Re-export SessionFile for consumers that imported it from here
export type { SessionInfo as SessionFile } from './session-service.js'

// ============================================================================
// IPC registration
// ============================================================================

export function registerIpcHandlers(
  paneManager: PaneManager,
  settingsService: SettingsService,
  terminalManager: TerminalManager,
  authService: AuthService,
  voiceService: VoiceService,
  fileService: FileService,
  gitService: GitService,
  fileWatchService: FileWatchService,
  restartAllAgents: () => Promise<void>,
  getMainWindow: () => BrowserWindow | null,
  classifierService: ClassifierService,
  broadcast?: (channel: string, data: unknown) => void,
): { registerApprovalForwardingForPane: (paneId: string) => void; registerClassifierForwardingForPane: (paneId: string) => void } {
  const approvedPaneRoots = new Set<string>()
  const isVoiceServiceEnabled = (): boolean => settingsService.get().voiceServiceEnabled !== false
  const broadcastVoiceStatus = (status: ReturnType<typeof getDisabledVoiceStatus> | Record<string, unknown>): void => {
    const win = getMainWindow()
    pushEvent(win, 'event:voice-status', status)
    broadcast?.('event:voice-status', status)
  }
  classifierService.setDebugSink((data) => {
    const win = getMainWindow()
    pushEvent(win, 'event:classifier-debug', data)
    broadcast?.('event:classifier-debug', data)
  })

  for (const paneId of paneManager.getPaneIds()) {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (root) approvedPaneRoots.add(root)
  }

  // --------------------------------------------------------------------------
  // Pane-specific commands — all accept paneId as first arg
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:prompt', async (_event, paneId: string, text: string, imageDataUrl?: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => {
    const pane = paneManager.getPane(paneId)
    if (!pane) throw new Error(`Unknown pane: ${paneId}`)

    const statuses = authService.getProviderStatuses()

    // Broad check: no provider configured at all
    if (!statuses.some((s) => s.configured)) {
      throw new Error('No AI provider configured — add an API key or sign in via Settings (⌘,).')
    }

    let agentState: any = null

    // Specific check: is the active model's provider configured?
    // Query agent state with a short timeout so we don't delay the prompt.
    try {
      agentState = await Promise.race([
        pane.agentBridge.getState(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
      ])
      if (agentState?.model) {
        const activeProvider = statuses.find((s) => s.id === agentState.model!.provider)
        if (activeProvider && !activeProvider.configured) {
          throw new Error(
            `${activeProvider.label} is not configured — add an API key or sign in via Settings (⌘,).`
          )
        }
      }
    } catch (err) {
      const msg = (err as Error).message
      // Re-throw credential errors; swallow timeout/fetch failures and let the
      // 30-second first-activity timeout in the orchestrator handle them.
      if (msg.includes('is not configured')) throw err
    }

    // Parse data URL into ImageContent if provided
    let images: Array<{ type: 'image'; data: string; mimeType: string }> | undefined
    if (imageDataUrl) {
      const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        images = [{ type: 'image', data: match[2], mimeType: match[1] }]
      }
    }

    return pane.orchestrator.submitTurn(text, 'text', options, images)
  })

  ipcMain.handle('cmd:abort', (_event, paneId: string) => {
    return paneManager.getPane(paneId)?.orchestrator.abortCurrentTurn()
  })

  ipcMain.handle('cmd:switch-model', (_event, paneId: string, provider: string, modelId: string) => {
    return paneManager.getPane(paneId)?.agentBridge.setModel(provider, modelId)
  })

  ipcMain.handle('cmd:new-session', async (_event, paneId: string) => {
    const pane = paneManager.getPane(paneId)
    if (!pane) throw new Error(`Unknown pane: ${paneId}`)
    const result = await pane.agentBridge.newSession()
    if (!result.cancelled) {
      // Await getState so the active session ID is tracked before the renderer
      // calls loadSessions() — the session file is written immediately by the
      // agent (header-only), so it will appear in the list right away.
      try {
        const state = await pane.agentBridge.getState()
        if (state.sessionFile) {
          pane.sessionService.setActiveSessionId(state.sessionFile)
          pane.sessionService.setProjectSession(pane.projectRoot, state.sessionFile, {
            sessionName: typeof state.sessionName === 'string' && state.sessionName.length > 0
              ? state.sessionName
              : null,
          })
        }
      } catch {
        // Non-fatal — active session tracking is best-effort
      }
    }
    return result
  })

  ipcMain.handle('cmd:switch-session', (_event, paneId: string, sessionPath: string) => {
    const pane = paneManager.getPane(paneId)
    if (!pane) throw new Error(`Unknown pane: ${paneId}`)
    return pane.sessionService.switchSession(sessionPath, pane.orchestrator)
  })

  ipcMain.handle('cmd:rename-session', (_event, paneId: string, name: string) => {
    return paneManager.getPane(paneId)?.sessionService.renameSession(name)
  })

  ipcMain.handle('cmd:compact', async (_event, paneId: string, customInstructions?: string) => {
    const pane = paneManager.getPane(paneId)
    if (!pane) throw new Error(`Unknown pane: ${paneId}`)
    return pane.agentBridge.compact(customInstructions)
  })

  ipcMain.handle('cmd:get-sessions', (_event, paneId: string) => {
    return paneManager.getPane(paneId)?.sessionService.listSessions()
  })

  ipcMain.handle('cmd:delete-session', (_event, paneId: string, path: string) => {
    return paneManager.getPane(paneId)?.sessionService.deleteSession(path)
  })

  ipcMain.handle('cmd:get-messages', (_event, paneId: string) => {
    return paneManager.getPane(paneId)?.sessionService.getMessages()
  })

  ipcMain.handle('cmd:get-models', (_event, paneId: string) => {
    return paneManager.getPane(paneId)?.agentBridge.getAvailableModels()
  })

  ipcMain.handle('cmd:get-state', (_event, paneId: string) => {
    return paneManager.getPane(paneId)?.agentBridge.getState()
  })

  ipcMain.handle('cmd:set-thinking-level', async (_event, paneId: string, level: 'low' | 'medium' | 'high') => {
    const pane = paneManager.getPane(paneId)
    if (!pane) throw new Error(`Unknown pane: ${paneId}`)
    await pane.agentBridge.setThinkingLevel(level)
  })

  ipcMain.handle('cmd:get-health', (_event, paneId: string) => {
    return paneManager.getPane(paneId)?.processManager.getStates()
  })

  // --------------------------------------------------------------------------
  // Pane lifecycle
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:pane-create', (_event, projectRoot?: string) => {
    // createPane is now synchronous — pane is registered immediately, agent
    // init (spawn → ready poll → new session) runs in the background.
    const pane = paneManager.createPane(settingsService, (channel, data) => {
      broadcast?.(channel, data)
    }, projectRoot)
    fileWatchService.watchPane(pane.id, pane.projectRoot)
    // Register forwarding for the new pane
    registerApprovalForwardingForPane(pane.id)
    registerClassifierForwardingForPane(pane.id)
    return { paneId: pane.id }
  })

  ipcMain.handle('cmd:pane-close', async (_event, paneId: string) => {
    fileWatchService.unwatchPane(paneId)
    await paneManager.destroyPane(paneId)
  })

  ipcMain.handle('cmd:pane-list', () => {
    return paneManager.getPaneIds()
  })

  // --------------------------------------------------------------------------
  // Settings — not pane-specific
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:get-settings', () => {
    return sanitizeSettingsForRenderer(settingsService.get())
  })

  ipcMain.handle('cmd:set-settings', async (_event, partial: Record<string, unknown>) => {
    const validated = validateSettingsPatch(partial)
    settingsService.save(validated)

    if ('voiceServiceEnabled' in validated) {
      if (validated.voiceServiceEnabled === false) {
        await voiceService.stop()
        broadcastVoiceStatus(getDisabledVoiceStatus())
      } else {
        await voiceService.probe()
      }
    }

    return sanitizeSettingsForRenderer(settingsService.get())
  })

  // --------------------------------------------------------------------------
  // MCP Servers config — not pane-specific
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:get-mcp-servers', () => {
    const dir = process.env.LUCENT_CONFIG_DIR ?? join(homedir(), '.lucent')
    const mcpPath = join(dir, 'mcp.json')
    try {
      const raw = readFileSync(mcpPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return (parsed.mcpServers ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  })

  ipcMain.handle('cmd:set-mcp-servers', (_event, servers: Record<string, unknown>) => {
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      throw new Error('Invalid MCP servers config: must be an object')
    }
    for (const [name, config] of Object.entries(servers)) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('Invalid MCP server name')
      }
      if (typeof config !== 'object' || config === null) {
        throw new Error(`Invalid MCP server config for "${name}"`)
      }
      const c = config as Record<string, unknown>
      const hasCommand = typeof c.command === 'string'
      const hasUrl = typeof c.url === 'string'
      if (!hasCommand && !hasUrl) {
        throw new Error(`MCP server "${name}" must have either "command" or "url"`)
      }
    }
    const dir = process.env.LUCENT_CONFIG_DIR ?? join(homedir(), '.lucent')
    const mcpPath = join(dir, 'mcp.json')
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }, null, 2), { encoding: 'utf8', mode: 0o600 })
    return servers
  })

  // --------------------------------------------------------------------------
  // Provider auth — not pane-specific
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:validate-and-save-provider-key', async (_event, providerId: string, apiKey: string) => {
    const result = await authService.validateAndSaveApiKey(providerId, apiKey)
    if (result.ok) {
      void restartAllAgents()
    }
    return result
  })

  ipcMain.handle('cmd:remove-provider-key', (_event, providerId: string) => {
    const statuses = authService.removeApiKey(providerId)
    void restartAllAgents()
    return statuses
  })

  ipcMain.handle('cmd:get-provider-auth-status', () => {
    return authService.getProviderStatuses()
  })

  ipcMain.handle('cmd:get-provider-catalog', () => {
    return authService.getProviderCatalog()
  })

  ipcMain.handle('cmd:oauth-start', async (_event, providerId: string) => {
    const win = getMainWindow()
    const { shell } = electron
    return authService.startOAuthLogin(
      providerId,
      (channel, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, data)
      },
      (url) => openExternalHttpUrl(shell.openExternal, url),
    )
  })

  ipcMain.handle('cmd:oauth-submit-code', (_event, providerId: string, code: string) => {
    authService.submitOAuthCode(providerId, code)
  })

  ipcMain.handle('cmd:oauth-cancel', (_event, providerId: string) => {
    authService.cancelOAuthFlow(providerId)
  })

  // --------------------------------------------------------------------------
  // Window / shell — not pane-specific
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:set-window-title', (_event, title: string) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.setTitle(title)
    }
  })

  ipcMain.handle('cmd:set-window-width', (_event, minWidth: number) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      const [currentWidth, currentHeight] = win.getSize()
      if (currentWidth < minWidth) {
        win.setSize(minWidth, currentHeight, true)
      }
    }
  })

  ipcMain.handle('cmd:open-external', async (_event, url: string) => {
    const { shell } = electron
    await openExternalHttpUrl(shell.openExternal, url)
  })

  // --------------------------------------------------------------------------
  // File system — pane-scoped (uses pane's projectRoot for path validation)
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:fs-list-dir', async (_e, paneId: string, relativePath: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) throw new Error(`Unknown pane: ${paneId}`)
    return fileService.listDirectory(root, relativePath)
  })

  ipcMain.handle('cmd:fs-read-file', async (_e, paneId: string, relativePath: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) throw new Error(`Unknown pane: ${paneId}`)
    return fileService.readFile(root, relativePath)
  })

  ipcMain.handle('cmd:fs-read-full', async (_e, paneId: string, relativePath: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) throw new Error(`Unknown pane: ${paneId}`)
    return fileService.readFileFull(root, relativePath)
  })

  ipcMain.handle('cmd:fs-write-file', async (_e, paneId: string, relativePath: string, content: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) throw new Error(`Unknown pane: ${paneId}`)
    return fileService.writeFile(root, relativePath, content)
  })

  // --------------------------------------------------------------------------
  // Git — pane-scoped
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:git-branch', async (_e, paneId: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) return null
    return gitService.getBranch(root)
  })

  ipcMain.handle('cmd:git-list-branches', async (_e, paneId: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) {
      return { current: null, branches: [] }
    }
    return gitService.listBranches(root)
  })

  ipcMain.handle('cmd:git-checkout-branch', async (_e, paneId: string, branch: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) return null

    const nextBranch = await gitService.checkoutBranch(root, branch)
    if (nextBranch) {
      fileWatchService.notifyRootChanged(paneId)
    }
    return nextBranch
  })

  ipcMain.handle('cmd:git-project-root', (_e, paneId: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot ?? process.cwd()
    return root
  })

  ipcMain.handle('cmd:git-modified-files', async (_e, paneId: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) return []
    return gitService.getModifiedFiles(root)
  })

  ipcMain.handle('cmd:git-changed-files', async (_e, paneId: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) return []
    return gitService.getChangedFiles(root)
  })

  ipcMain.handle('cmd:git-file-diff', async (_e, paneId: string, relativePath: string) => {
    const root = paneManager.getPane(paneId)?.projectRoot
    if (!root) return null
    return gitService.getFileDiff(root, relativePath)
  })

  ipcMain.handle('cmd:get-pane-info', (_e, paneId: string) => {
    const pane = paneManager.getPane(paneId)
    return { paneId, projectRoot: pane?.projectRoot ?? process.cwd() }
  })

  ipcMain.handle('cmd:set-pane-root', async (_e, paneId: string, absolutePath: string) => {
    const pane = paneManager.getPane(paneId)
    if (!pane) throw new Error(`Unknown pane: ${paneId}`)
    const resolvedPath = await fs.realpath(absolutePath)
    const stat = await fs.stat(resolvedPath)
    if (!stat.isDirectory()) throw new Error('Not a directory')
    const currentRoot = await fs.realpath(pane.projectRoot).catch(() => pane.projectRoot)
    if (!approvedPaneRoots.has(resolvedPath) && currentRoot !== resolvedPath) {
      throw new Error('Pane root must be selected through the folder picker first')
    }
    await paneManager.restartPaneAgent(paneId, resolvedPath, { updateAccessRoot: true })
    fileWatchService.watchPane(paneId, resolvedPath)
    fileWatchService.notifyRootChanged(paneId)
    return { projectRoot: resolvedPath }
  })

  ipcMain.handle('cmd:pick-folder', async () => {
    const win = getMainWindow()
    if (!win) return null
    const { dialog } = electron
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled) return null
    const selected = result.filePaths[0] ?? null
    if (!selected) return null
    const resolved = await fs.realpath(selected)
    approvedPaneRoots.add(resolved)
    return resolved
  })

  // --------------------------------------------------------------------------
  // Terminal — not pane-specific
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:terminal-create', (_event, data: { terminalId: string }) => {
    terminalManager.create(data.terminalId)
  })

  ipcMain.handle('cmd:terminal-input', (_event, data: { terminalId: string; data: string }) => {
    terminalManager.write(data.terminalId, data.data)
  })

  ipcMain.handle('cmd:terminal-resize', (_event, data: { terminalId: string; cols: number; rows: number }) => {
    terminalManager.resize(data.terminalId, data.cols, data.rows)
  })

  ipcMain.handle('cmd:terminal-destroy', (_event, data: { terminalId: string }) => {
    terminalManager.destroy(data.terminalId)
  })


  // --------------------------------------------------------------------------
  // Skill commands — not pane-specific
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:skill-list', async () => {
    // Scan skill directories: bundled (.gsd), user-level (.lc), project-level (.lc)
    const gsdSkillsDir = join(process.env.GSD_HOME || join(homedir(), '.gsd'), 'agent', 'skills')
    const userSkillsDir = join(homedir(), '.lc', 'agent', 'skills')
    const skills: Array<{ name: string; description: string; trigger: string; stepCount: number }> = []
    const seen = new Set<string>()

    for (const dir of [gsdSkillsDir, userSkillsDir]) {
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir)) {
        if (seen.has(entry)) continue
        const entryPath = join(dir, entry)
        let mdPath: string | null = null
        if (entry.endsWith('.md')) {
          mdPath = entryPath
        } else if (statSync(entryPath).isDirectory()) {
          const skillMd = join(entryPath, 'SKILL.md')
          if (existsSync(skillMd)) mdPath = skillMd
        }
        if (!mdPath) continue
        const content = readFileSync(mdPath, 'utf8')
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!fmMatch) continue
        const fm = fmMatch[1]
        const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.replace(/\.md$/, '')
        const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
        if (!description) continue
        seen.add(name)
        skills.push({ name, description, trigger: name, stepCount: 0 })
      }
    }
    return skills
  })

  // --------------------------------------------------------------------------
  // Approval RPC — bidirectional approval flow for accept-on-edit mode
  // --------------------------------------------------------------------------

  // Register approval-request listener for each existing pane, and for panes
  // created later via cmd:pane-create.
  const registerApprovalForwardingForPane = (paneId: string): void => {
    const pane = paneManager.getPane(paneId)
    if (!pane) return
    pane.agentBridge.on('approval-request', (req) => {
      const win = getMainWindow()
      pushEvent(win, 'event:approval-request', { paneId, ...req })
      broadcast?.('event:approval-request', { paneId, ...req })
    })
    pane.agentBridge.on('ui-select-request', (req) => {
      const win = getMainWindow()
      pushEvent(win, 'event:ui-select-request', { paneId, ...req })
      broadcast?.('event:ui-select-request', { paneId, ...req })
    })
  }

  const registerClassifierForwardingForPane = (paneId: string): void => {
    const pane = paneManager.getPane(paneId)
    if (!pane) return
    pane.agentBridge.on('classifier-request', async (req) => {
      const win = getMainWindow()
      const stats = classifierService.getPaneState(paneId)
      console.log(`[classifier] request: tool=${req.toolName} args=${JSON.stringify(req.args).slice(0, 200)}`)

      // 1. Evaluate static rules
      const rules = settingsService.get().autoModeRules ?? []
      const ruleDecision = classifierService.evaluateRules(req.toolName, req.args, rules)
      console.log(`[classifier] rule decision: ${ruleDecision ?? 'none'} (${rules.length} rules)`)
      if (ruleDecision === 'allow') {
        pane.agentBridge.respondToClassifier(req.id, true)
        broadcast?.('event:classifier-decision', { paneId, toolName: req.toolName, approved: true, source: 'rule' })
        return
      }
      if (ruleDecision === 'deny') {
        // Show approval card so user can override the deny
        broadcast?.('event:approval-request', {
          paneId,
          id: req.id,
          action: req.toolName,
          path: '',
          message: `Auto mode rule blocked ${req.toolName}: ${JSON.stringify(req.args).slice(0, 300)}`,
        })
        return
      }

      // 2. If paused, fallback to manual approval
      if (stats.paused) {
        broadcast?.('event:approval-request', {
          paneId,
          id: req.id,
          action: 'bash',
          path: '',
          message: `Auto mode paused (too many blocks). Manual approval for ${req.toolName}: ${JSON.stringify(req.args)}`,
        })
        return
      }

      // 3. LLM classifier
      const projectInstructions = await fs.readFile(join(pane.projectRoot, 'LUCENT.md'), 'utf8').catch(() => undefined)
      const context = {
        userMessages: pane.orchestrator.getUserMessages().slice(-10),
        projectInstructions,
      }

      const decision = await classifierService.classifyToolCall(paneId, req.toolName, req.args, context, settingsService.get().classifierProvider ?? 'anthropic')

      // Fallback to manual if no key or error
      if (decision.source === 'fallback') {
        broadcast?.('event:approval-request', {
          paneId,
          id: req.id,
          action: req.toolName,
          path: '',
          message: `Classifier error (${decision.reason}). Manual approval for ${req.toolName}: ${JSON.stringify(req.args)}`,
        })
        return
      }

      if (decision.approved) {
        pane.agentBridge.respondToClassifier(req.id, true)
        broadcast?.('event:classifier-decision', {
          paneId,
          toolName: req.toolName,
          approved: true,
          source: decision.source,
        })
      } else {
        // Classifier denied — show approval card so user can override
        broadcast?.('event:approval-request', {
          paneId,
          id: req.id,
          action: req.toolName,
          path: '',
          message: `Classifier denied ${req.toolName}: ${JSON.stringify(req.args).slice(0, 300)}`,
        })
      }
    })
  }

  for (const paneId of paneManager.getPaneIds()) {
    registerApprovalForwardingForPane(paneId)
    registerClassifierForwardingForPane(paneId)
  }

  // When new panes are created, auto-register the forwarding listener
  // (paneManager itself doesn't emit events, but pane-create goes through here)
  ipcMain.handle('cmd:approval-respond', (_event, paneId: string, id: string, approved: boolean) => {
    const bridge = paneManager.getPane(paneId)?.agentBridge
    if (!bridge) return
    if (id.startsWith('cls_')) {
      bridge.respondToClassifier(id, approved)
    } else {
      bridge.respondToApproval(id, approved)
    }
  })

  ipcMain.handle('cmd:ui-select-respond', (_event, paneId: string, id: string, selected: string | string[]) => {
    paneManager.getPane(paneId)?.agentBridge.respondToUiSelect(id, selected)
  })

  // IPC for Auto mode state
  ipcMain.handle('cmd:get-auto-mode-state', (_event, paneId: string) => {
    return classifierService.getPaneState(paneId)
  })

  ipcMain.handle('cmd:resume-auto-mode', (_event, paneId: string) => {
    classifierService.resume(paneId)
    pushEvent(getMainWindow(), 'event:auto-mode-resumed', { paneId })
    return classifierService.getPaneState(paneId)
  })

  // --------------------------------------------------------------------------
  // Per-pane permission mode toggle
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:toggle-pane-permission-mode', async (_event, paneId: string) => {
    const newMode = await paneManager.togglePanePermissionMode(paneId)
    pushEvent(getMainWindow(), 'event:pane-permission-mode-changed', { paneId, mode: newMode })
    return newMode
  })

  // --------------------------------------------------------------------------
  // Voice — not pane-specific (global sidecar)
  // --------------------------------------------------------------------------

  ipcMain.handle('cmd:voice-probe', async () => {
    if (!isVoiceServiceEnabled()) return getDisabledVoiceStatus()
    return voiceService.probe()
  })

  ipcMain.handle('cmd:voice-start', async () => {
    if (!isVoiceServiceEnabled()) throw new Error(VOICE_SERVICE_DISABLED_REASON)
    return voiceService.start()
  })

  ipcMain.handle('cmd:voice-stop', async () => {
    return voiceService.stop()
  })

  ipcMain.handle('cmd:voice-status', () => {
    if (!isVoiceServiceEnabled()) return getDisabledVoiceStatus()
    return voiceService.getStatus()
  })

  // Forward voice status events to renderer
  voiceService.on('status', (status) => {
    const win = getMainWindow()
    pushEvent(win, 'event:voice-status', status)
  })

  void getMainWindow // referenced by pushEvent callers in index.ts

  return { registerApprovalForwardingForPane, registerClassifierForwardingForPane }
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function openExternalHttpUrl(
  openExternal: (url: string) => Promise<void>,
  url: string,
): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    throw new Error('Only http:// and https:// URLs are allowed')
  }
  await openExternal(url)
}

// ============================================================================
// Event push helper
// ============================================================================

/** Push an event from main process to the renderer window. */
export function pushEvent(win: BrowserWindow | null, channel: string, data: unknown): void {
  if (!win) {
    return
  }

  const windowDestroyed = typeof win.isDestroyed === 'function' ? win.isDestroyed() : Boolean((win as BrowserWindow & { isDestroyed?: boolean }).isDestroyed)
  if (windowDestroyed) {
    return
  }

  const webContents = win.webContents as typeof win.webContents & {
    isDestroyed?: (() => boolean) | boolean
  }
  const webContentsDestroyed = typeof webContents.isDestroyed === 'function'
    ? webContents.isDestroyed()
    : Boolean(webContents.isDestroyed)

  if (webContentsDestroyed) {
    return
  }

  try {
    win.webContents.send(channel, data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Render frame was disposed before WebFrameMain could be accessed')) {
      return
    }
    throw error
  }
}
