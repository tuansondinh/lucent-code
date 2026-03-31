import { contextBridge, ipcRenderer } from 'electron'

// Provider auth status shape — mirrored from auth-service.ts
interface ProviderAuthStatus {
  id: string
  label: string
  configured: boolean
  configuredVia: 'auth_file' | 'environment' | null
  removeAllowed: boolean
  recommended?: boolean
  supportsApiKey: boolean
  supportsOAuth: boolean
}

export type GitChangeStatus = 'M' | 'A' | 'D' | 'R' | '??' | 'U'

export interface GitChangedFile {
  path: string
  status: GitChangeStatus
  previousPath?: string
}

export interface GitFileDiff {
  path: string
  status: GitChangeStatus
  previousPath?: string
  isBinary: boolean
  diffText: string | null
}

export interface RendererSettings {
  defaultModel?: { provider: string; modelId: string }
  thinkingLevel?: 'low' | 'medium' | 'high'
  theme: 'dark'
  fontSize: number
  sidebarCollapsed: boolean
  windowBounds?: { x: number; y: number; width: number; height: number }
  onboardingComplete?: boolean
  voicePttShortcut?: 'space' | 'alt+space' | 'cmd+shift+space'
  voiceAudioEnabled?: boolean
  voiceServiceEnabled?: boolean
  voiceModelsDownloaded?: boolean
  voiceOptIn?: boolean
  textToSpeechMode?: boolean
  notificationSoundEnabled?: boolean
  hasTavilyKey: boolean
  /** Agent file-mutation permission mode. */
  permissionMode?: 'danger-full-access' | 'accept-on-edit' | 'auto'
  remoteAccessEnabled?: boolean
  remoteAccessPort?: number
  tailscaleServeEnabled?: boolean
}

export interface VoiceStatus {
  available: boolean
  state: string
  port: number | null
  token: string | null
  reason?: string
}

/**
 * Bridge API exposed to the renderer via contextBridge.
 * Commands are invoked via ipcRenderer.invoke (returns Promise).
 * Events are received via ipcRenderer.on listeners.
 *
 * Phase 4C: All pane-specific commands take paneId as the first argument.
 * All pane-specific events now include paneId in the payload.
 */
const bridge = {
  // -------------------------------------------------------------------------
  // Commands (renderer → main) — pane-specific
  // -------------------------------------------------------------------------

  /** Submit a text prompt to a specific pane. Returns turn_id. */
  prompt: (paneId: string, text: string, imageDataUrl?: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<string> =>
    ipcRenderer.invoke('cmd:prompt', paneId, text, imageDataUrl, options),

  /** Abort the current generation in a specific pane. */
  abort: (paneId: string): Promise<void> =>
    ipcRenderer.invoke('cmd:abort', paneId),

  /** Switch the active model in a specific pane. */
  switchModel: (paneId: string, provider: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke('cmd:switch-model', paneId, provider, modelId),

  /** Start a new session in a specific pane. */
  newSession: (paneId: string): Promise<{ cancelled: boolean }> =>
    ipcRenderer.invoke('cmd:new-session', paneId),

  compact: (paneId: string, customInstructions?: string): Promise<void> =>
    ipcRenderer.invoke('cmd:compact', paneId, customInstructions),

  /** Switch to a saved session by file path in a specific pane. */
  switchSession: (paneId: string, sessionPath: string): Promise<{ cancelled: boolean }> =>
    ipcRenderer.invoke('cmd:switch-session', paneId, sessionPath),

  /** Rename the current session in a specific pane. */
  renameSession: (paneId: string, name: string): Promise<void> =>
    ipcRenderer.invoke('cmd:rename-session', paneId, name),

  /** List saved sessions for a specific pane. */
  getSessions: (paneId: string): Promise<Array<{ path: string; name: string; modified: number }>> =>
    ipcRenderer.invoke('cmd:get-sessions', paneId),

  /** Delete a saved session by file path for a specific pane. */
  deleteSession: (paneId: string, path: string): Promise<void> =>
    ipcRenderer.invoke('cmd:delete-session', paneId, path),

  /** Get formatted message history for the current session of a specific pane. */
  getMessages: (paneId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }>> =>
    ipcRenderer.invoke('cmd:get-messages', paneId),

  /** List available models for a specific pane. */
  getModels: (paneId: string): Promise<Array<{ provider: string; id: string }>> =>
    ipcRenderer.invoke('cmd:get-models', paneId),

  /** Get current agent session state for a specific pane. */
  getState: (paneId: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('cmd:get-state', paneId),

  /** Get process health states for a specific pane. */
  getHealth: (paneId: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('cmd:get-health', paneId),

  // -------------------------------------------------------------------------
  // Pane lifecycle
  // -------------------------------------------------------------------------

  /** Create a new pane (spawns a fresh agent process). Returns { paneId }. */
  paneCreate: (projectRoot?: string): Promise<{ paneId: string }> =>
    ipcRenderer.invoke('cmd:pane-create', projectRoot),

  /** Close and destroy a pane. */
  paneClose: (paneId: string): Promise<void> =>
    ipcRenderer.invoke('cmd:pane-close', paneId),

  /** List all active pane IDs. */
  paneList: (): Promise<string[]> =>
    ipcRenderer.invoke('cmd:pane-list'),

  // -------------------------------------------------------------------------
  // Commands — not pane-specific
  // -------------------------------------------------------------------------

  /** Get current app settings. */
  getSettings: (): Promise<RendererSettings> =>
    ipcRenderer.invoke('cmd:get-settings'),

  /** Persist a partial settings update. Returns the full updated settings. */
  setSettings: (settings: Record<string, unknown>): Promise<RendererSettings> =>
    ipcRenderer.invoke('cmd:set-settings', settings),

  /** Change the runtime thinking/reasoning level for a specific pane. */
  setThinkingLevel: (paneId: string, level: 'low' | 'medium' | 'high'): Promise<void> =>
    ipcRenderer.invoke('cmd:set-thinking-level', paneId, level),

  /** Open a URL in the system's default browser. Only http/https allowed. */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('cmd:open-external', url),

  /** Set the native window title bar text. */
  setWindowTitle: (title: string): Promise<void> =>
    ipcRenderer.invoke('cmd:set-window-title', title),

  /** Expand the native window width to at least minWidth (px). Animates if narrower. */
  setWindowWidth: (minWidth: number): Promise<void> =>
    ipcRenderer.invoke('cmd:set-window-width', minWidth),

  /** Validate an API key via HTTP and save it atomically. Returns ok, message, updated statuses. */
  validateAndSaveProviderKey: (
    providerId: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string; providerStatuses: ProviderAuthStatus[] }> =>
    ipcRenderer.invoke('cmd:validate-and-save-provider-key', providerId, apiKey),

  /** Remove all API key credentials for a provider. Returns updated statuses. */
  removeProviderKey: (providerId: string): Promise<ProviderAuthStatus[]> =>
    ipcRenderer.invoke('cmd:remove-provider-key', providerId),

  /** Get rich auth status for all providers. */
  getProviderAuthStatus: (): Promise<ProviderAuthStatus[]> =>
    ipcRenderer.invoke('cmd:get-provider-auth-status'),

  /** Get the static provider catalog (id, label, keyPlaceholder, recommended, supportsApiKey, supportsOAuth). */
  getProviderCatalog: (): Promise<Array<{ id: string; label: string; keyPlaceholder?: string; recommended?: boolean; supportsApiKey: boolean; supportsOAuth: boolean }>> =>
    ipcRenderer.invoke('cmd:get-provider-catalog'),

  /** Start an OAuth login flow. Long-running — resolves when complete. */
  oauthStart: (providerId: string): Promise<{ ok: boolean; message: string; providerStatuses: ProviderAuthStatus[] }> =>
    ipcRenderer.invoke('cmd:oauth-start', providerId),

  /** Submit a pasted code for an in-flight OAuth code-paste flow. */
  oauthSubmitCode: (providerId: string, code: string): Promise<void> =>
    ipcRenderer.invoke('cmd:oauth-submit-code', providerId, code),

  /** Cancel an in-flight OAuth flow. */
  oauthCancel: (providerId: string): Promise<void> =>
    ipcRenderer.invoke('cmd:oauth-cancel', providerId),

  /** Get globally configured MCP servers from ~/.lucent/mcp.json. */
  getMcpServers: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('cmd:get-mcp-servers'),

  /** Persist the full MCP servers config to ~/.lucent/mcp.json. */
  setMcpServers: (servers: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('cmd:set-mcp-servers', servers),

  /** OAuth progress event (browser open, device code, awaiting input, generic progress). */
  onOAuthProgress: (
    cb: (data: {
      providerId: string
      type: 'open_browser' | 'awaiting_input' | 'awaiting_code' | 'progress'
      url?: string
      instructions?: string
      message?: string
      placeholder?: string
      allowEmpty?: boolean
    }) => void
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:oauth-progress', handler)
    return () => ipcRenderer.removeListener('event:oauth-progress', handler)
  },

  // -------------------------------------------------------------------------
  // File system commands — pane-scoped
  // -------------------------------------------------------------------------

  /** List directory contents within the pane's project root. */
  fsListDir: (paneId: string, relativePath: string): Promise<{ entries: { name: string; type: 'file' | 'directory' }[]; truncated: boolean }> =>
    ipcRenderer.invoke('cmd:fs-list-dir', paneId, relativePath),

  /** Read a file within the pane's project root. */
  fsReadFile: (paneId: string, relativePath: string): Promise<{ content: string; size: number; truncated: boolean; isBinary: boolean }> =>
    ipcRenderer.invoke('cmd:fs-read-file', paneId, relativePath),

  /** Read full file content (no size cap) — used when entering edit mode. */
  fsReadFull: (paneId: string, relativePath: string): Promise<{ content: string; size: number; truncated: boolean; isBinary: boolean }> =>
    ipcRenderer.invoke('cmd:fs-read-full', paneId, relativePath),

  /** Write content to a file within the pane's project root (atomic write). */
  fsWriteFile: (paneId: string, relativePath: string, content: string): Promise<{ bytesWritten: number }> =>
    ipcRenderer.invoke('cmd:fs-write-file', paneId, relativePath, content),

  /** Delete a file within the pane's project root. Directories are not deletable. */
  fsDeleteFile: (paneId: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke('cmd:fs-delete-file', paneId, relativePath),

  /** Subscribe to filesystem changes under a pane's current project root. */
  onFileChanged: (
    cb: (data: {
      paneId: string
      changes: Array<{ relativePath: string | null; eventType: 'change' | 'rename' | 'root' }>
    }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:file-changed', handler)
    return () => ipcRenderer.removeListener('event:file-changed', handler)
  },

  /** Get the current git branch for a pane's project root. */
  gitBranch: (paneId: string): Promise<string | null> =>
    ipcRenderer.invoke('cmd:git-branch', paneId),

  /** List local git branches for a pane's project root. */
  gitListBranches: (paneId: string): Promise<{ current: string | null; branches: string[] }> =>
    ipcRenderer.invoke('cmd:git-list-branches', paneId),

  /** Switch the current pane's repository to another branch. */
  gitCheckoutBranch: (paneId: string, branch: string): Promise<string | null> =>
    ipcRenderer.invoke('cmd:git-checkout-branch', paneId, branch),

  /** Get the resolved project root path for a pane. */
  gitProjectRoot: (paneId: string): Promise<string> =>
    ipcRenderer.invoke('cmd:git-project-root', paneId),

  /** Get list of modified/untracked files for a pane's project root. */
  gitModifiedFiles: (paneId: string): Promise<string[]> =>
    ipcRenderer.invoke('cmd:git-modified-files', paneId),

  /** Get changed files with Git status metadata for a pane's project root. */
  gitChangedFiles: (paneId: string): Promise<GitChangedFile[]> =>
    ipcRenderer.invoke('cmd:git-changed-files', paneId),

  /** Get the unified diff for a specific file against HEAD. */
  gitFileDiff: (paneId: string, relativePath: string): Promise<GitFileDiff | null> =>
    ipcRenderer.invoke('cmd:git-file-diff', paneId, relativePath),

  /** Get pane info including project root. */
  getPaneInfo: (paneId: string): Promise<{ paneId: string; projectRoot: string }> =>
    ipcRenderer.invoke('cmd:get-pane-info', paneId),

  /** Set the project root for a pane's file browsing context. */
  setPaneRoot: (paneId: string, absolutePath: string): Promise<{ projectRoot: string }> =>
    ipcRenderer.invoke('cmd:set-pane-root', paneId, absolutePath),

  /** Open native folder picker dialog. Returns selected path or null if cancelled. */
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('cmd:pick-folder'),

  // -------------------------------------------------------------------------
  // Terminal commands — not pane-specific
  // -------------------------------------------------------------------------

  /** Spawn (or re-spawn) a terminal process for the given id. */
  terminalCreate: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke('cmd:terminal-create', { terminalId }),

  /** Send raw input data to the terminal. */
  terminalInput: (terminalId: string, data: string): Promise<void> =>
    ipcRenderer.invoke('cmd:terminal-input', { terminalId, data }),

  /** Notify the pty of a terminal resize. */
  terminalResize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('cmd:terminal-resize', { terminalId, cols, rows }),

  /** Kill the terminal process for the given id. */
  terminalDestroy: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke('cmd:terminal-destroy', { terminalId }),

  // -------------------------------------------------------------------------
  // Events (main → renderer) — all pane-specific events include paneId
  // -------------------------------------------------------------------------

  /** Streaming text chunk from the agent. Returns unsubscribe function. */
  onAgentChunk: (cb: (data: { paneId: string; turn_id: string; text: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:agent-chunk', handler)
    return () => ipcRenderer.removeListener('event:agent-chunk', handler)
  },

  /** Turn complete — full accumulated text. Returns unsubscribe function. */
  onAgentDone: (cb: (data: { paneId: string; turn_id: string; full_text: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:agent-done', handler)
    return () => ipcRenderer.removeListener('event:agent-done', handler)
  },

  /** Tool execution started. Returns unsubscribe function. */
  onToolStart: (cb: (data: { paneId: string; turn_id: string; toolCallId: string; tool: string; input: unknown }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:tool-start', handler)
    return () => ipcRenderer.removeListener('event:tool-start', handler)
  },

  /** Tool execution ended. Returns unsubscribe function. */
  onToolEnd: (
    cb: (data: { paneId: string; turn_id: string; toolCallId: string; tool: string; output: unknown; isError: boolean }) => void
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:tool-end', handler)
    return () => ipcRenderer.removeListener('event:tool-end', handler)
  },

  /** Tool sub-activity update (from subagent). Returns unsubscribe function. */
  onToolUpdate: (
    cb: (data: { paneId: string; turn_id: string; toolCallId: string; tool: string; subItems: Array<{ type: 'text' | 'toolCall'; text?: string; name?: string; args?: Record<string, any> }> }) => void
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:tool-update', handler)
    return () => ipcRenderer.removeListener('event:tool-update', handler)
  },

  /** Turn state changed. Returns unsubscribe function. */
  onTurnState: (cb: (data: { paneId: string; turn_id: string; state: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:turn-state', handler)
    return () => ipcRenderer.removeListener('event:turn-state', handler)
  },

  /** Process health update. Returns unsubscribe function. */
  onHealth: (cb: (data: { paneId: string; states: Record<string, string> }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:health', handler)
    return () => ipcRenderer.removeListener('event:health', handler)
  },

  /** Error from main process. Returns unsubscribe function. */
  onError: (cb: (data: { paneId: string; source: string; message: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:error', handler)
    return () => ipcRenderer.removeListener('event:error', handler)
  },

  /** Terminal output data from the pty. Returns unsubscribe function. */
  onTerminalData: (cb: (payload: { terminalId: string; data: string }) => void): (() => void) => {
    const handler = (_e: any, payload: { terminalId: string; data: string }) => cb(payload)
    ipcRenderer.on('event:terminal-data', handler)
    return () => ipcRenderer.removeListener('event:terminal-data', handler)
  },

  /** App-level keyboard shortcuts forwarded by the main process. */
  onAppShortcut: (cb: (data: { action: 'new-session' | 'toggle-file-viewer' | 'toggle-permission-mode' | 'close-pane' }) => void): (() => void) => {
    const handler = (_e: any, data: { action: 'new-session' | 'toggle-file-viewer' | 'toggle-permission-mode' | 'close-pane' }) => cb(data)
    ipcRenderer.on('event:app-shortcut', handler)
    return () => ipcRenderer.removeListener('event:app-shortcut', handler)
  },

  /** Thinking block started. Returns unsubscribe function. */
  onThinkingStart: (cb: (data: { paneId: string; turn_id: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:thinking-start', handler)
    return () => ipcRenderer.removeListener('event:thinking-start', handler)
  },

  /** Thinking text delta. Returns unsubscribe function. */
  onThinkingChunk: (cb: (data: { paneId: string; turn_id: string; text: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:thinking-chunk', handler)
    return () => ipcRenderer.removeListener('event:thinking-chunk', handler)
  },

  /** Thinking block finalized. Returns unsubscribe function. */
  onThinkingEnd: (cb: (data: { paneId: string; turn_id: string; text: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:thinking-end', handler)
    return () => ipcRenderer.removeListener('event:thinking-end', handler)
  },

  /** New text block started. Returns unsubscribe function. */
  onTextBlockStart: (cb: (data: { paneId: string; turn_id: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:text-block-start', handler)
    return () => ipcRenderer.removeListener('event:text-block-start', handler)
  },

  /** Text block finalized. Returns unsubscribe function. */
  onTextBlockEnd: (cb: (data: { paneId: string; turn_id: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:text-block-end', handler)
    return () => ipcRenderer.removeListener('event:text-block-end', handler)
  },

  /** Auto-compaction state changed (start/end). Returns unsubscribe function. */
  onCompactionState: (cb: (data: { paneId: string; isCompacting: boolean; autoCompactionEnabled: boolean }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:compaction-state', handler)
    return () => ipcRenderer.removeListener('event:compaction-state', handler)
  },


  // -------------------------------------------------------------------------
  // Skill commands — not pane-specific
  // -------------------------------------------------------------------------

  /** List all available skills (name, description, trigger, stepCount). */
  skillList: (): Promise<Array<{ name: string; description: string; trigger: string; stepCount: number }>> =>
    ipcRenderer.invoke('cmd:skill-list'),

  // -------------------------------------------------------------------------
  // Approval RPC — bidirectional file change approval for accept-on-edit mode
  // -------------------------------------------------------------------------

  /** Subscribe to file change approval requests from the agent. Returns unsubscribe function. */
  onApprovalRequest: (
    cb: (data: {
      paneId: string
      id: string
      action: 'write' | 'edit' | 'delete' | 'move'
      path: string
      message: string
    }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:approval-request', handler)
    return () => ipcRenderer.removeListener('event:approval-request', handler)
  },

  /** Send an approval decision (Allow/Deny) back to the agent. */
  approvalRespond: (paneId: string, id: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke('cmd:approval-respond', paneId, id, approved),

  /** Subscribe to extension UI select requests from the agent. Returns unsubscribe function. */
  onUiSelectRequest: (
    cb: (data: {
      paneId: string
      id: string
      method: 'select'
      title: string
      options: string[]
      allowMultiple?: boolean
      timeout?: number
    }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:ui-select-request', handler)
    return () => ipcRenderer.removeListener('event:ui-select-request', handler)
  },

  /** Send a UI select response back to the agent. */
  uiSelectRespond: (paneId: string, id: string, selected: string | string[]): Promise<void> =>
    ipcRenderer.invoke('cmd:ui-select-respond', paneId, id, selected),

  /** Subscribe to classifier decisions. Returns unsubscribe function. */
  onClassifierDecision: (
    cb: (data: {
      paneId: string
      toolName: string
      approved: boolean
      source: 'rule' | 'classifier' | 'cache' | 'fallback' | 'timeout'
    }) => void
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:classifier-decision', handler)
    return () => ipcRenderer.removeListener('event:classifier-decision', handler)
  },

  /** Subscribe to classifier debug logs. Returns unsubscribe function. */
  onClassifierDebug: (
    cb: (data: {
      kind: string
      toolName: string
      pattern?: string
      candidate?: string
      matched?: boolean
      approved?: boolean
      source?: 'rule' | 'classifier' | 'cache' | 'fallback' | 'timeout'
      reason?: string
      result?: string
    }) => void
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:classifier-debug', handler)
    return () => ipcRenderer.removeListener('event:classifier-debug', handler)
  },

  /** Get the current auto mode state for a pane. */
  getAutoModeState: (
    paneId: string
  ): Promise<{ consecutive: number; total: number; paused: boolean }> =>
    ipcRenderer.invoke('cmd:get-auto-mode-state', paneId),

  /** Resume auto mode for a pane (unpauses if it was paused). */
  resumeAutoMode: (
    paneId: string
  ): Promise<{ consecutive: number; total: number; paused: boolean }> =>
    ipcRenderer.invoke('cmd:resume-auto-mode', paneId),

  /** Subscribe to auto mode resumed events. Returns unsubscribe function. */
  onAutoModeResumed: (cb: (data: { paneId: string }) => void): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:auto-mode-resumed', handler)
    return () => ipcRenderer.removeListener('event:auto-mode-resumed', handler)
  },

  /** Toggle the permission mode for a specific pane. Returns the new mode. */
  togglePanePermissionMode: (paneId: string): Promise<'danger-full-access' | 'accept-on-edit' | 'auto'> =>
    ipcRenderer.invoke('cmd:toggle-pane-permission-mode', paneId),

  /** Subscribe to per-pane permission mode changes. Returns unsubscribe function. */
  onPanePermissionModeChanged: (
    cb: (data: { paneId: string; mode: 'danger-full-access' | 'accept-on-edit' | 'auto' }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:pane-permission-mode-changed', handler)
    return () => ipcRenderer.removeListener('event:pane-permission-mode-changed', handler)
  },

  // -------------------------------------------------------------------------
  // Voice — not pane-specific (sidecar is app-global)
  // Phase 2 wires the main-process IPC handlers; these are the renderer-side stubs.
  // -------------------------------------------------------------------------

  /** Check whether Python and voice_bridge are available on this machine. */
  voiceProbe: (): Promise<{ available: boolean; reason?: string }> =>
    ipcRenderer.invoke('cmd:voice-probe'),

  /** Start the audio service sidecar. Resolves with the port it bound to. */
  voiceStart: (): Promise<{ port: number; token: string }> =>
    ipcRenderer.invoke('cmd:voice-start'),

  /** Stop the audio service sidecar. */
  voiceStop: (): Promise<void> =>
    ipcRenderer.invoke('cmd:voice-stop'),

  /** Get the current voice service status snapshot. */
  voiceStatus: (): Promise<VoiceStatus> =>
    ipcRenderer.invoke('cmd:voice-status'),

  // -------------------------------------------------------------------------
  // Voice events (main → renderer)
  // -------------------------------------------------------------------------

  /** Subscribe to voice service status changes. Returns unsubscribe function. */
  onVoiceStatus: (
    cb: (data: VoiceStatus) => void,
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: VoiceStatus) => cb(data)
    ipcRenderer.on('event:voice-status', handler)
    return () => ipcRenderer.removeListener('event:voice-status', handler)
  },

  // -------------------------------------------------------------------------
  // Auto-updater
  // -------------------------------------------------------------------------

  /** Request immediate quit-and-install of a downloaded update. */
  updaterInstallNow: (): Promise<void> =>
    ipcRenderer.invoke('updater:install-now'),

  /** Subscribe to update-available events. Returns unsubscribe function. */
  onUpdateAvailable: (
    cb: (info: { version: string; releaseNotes?: string | null }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:update-available', handler)
    return () => ipcRenderer.removeListener('event:update-available', handler)
  },

  /** Subscribe to download-progress events. Returns unsubscribe function. */
  onUpdateProgress: (
    cb: (data: { percent: number }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:update-progress', handler)
    return () => ipcRenderer.removeListener('event:update-progress', handler)
  },

  /** Subscribe to update-downloaded events. Returns unsubscribe function. */
  onUpdateDownloaded: (
    cb: (info: { version: string; releaseNotes?: string | null }) => void,
  ): (() => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('event:update-downloaded', handler)
    return () => ipcRenderer.removeListener('event:update-downloaded', handler)
  },
}


console.log('[studio] preload loaded')
contextBridge.exposeInMainWorld('bridge', bridge)
// Signal to renderer that it is running inside Electron (not a PWA)
contextBridge.exposeInMainWorld('__ELECTRON__', true)

export type Bridge = typeof bridge
