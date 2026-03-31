/**
 * App — top-level layout with sidebar + multi-pane chat area.
 *
 * Phase 4C+IDE: Supports up to 4 independent chat panes side by side.
 * Each pane has its own agent process, bridge, orchestrator, and session.
 *
 * Layout: sidebar | PanelGroup of ChatPane | FileViewer (opt)
 * Keyboard shortcuts:
 *   Cmd+D       → split pane horizontally (max 4)
 *   Cmd+Shift+D → split pane vertically
 *   Cmd+W       → close active pane (if > 1)
 *   Cmd+1-4     → focus pane 1-4
 *   Cmd+E       → toggle explorer in sidebar
 *   Cmd+Shift+F → toggle file viewer
 *   Cmd+T       → cycle thinking level
 *   Cmd+Shift+T → toggle active pane terminal mode
 *   Shift+T     → cycle thinking level
 *   Voice PTT   → configurable in Settings (default: hold Space)
 */

import { useEffect, useCallback, useState, useRef, lazy, Suspense, type ReactNode } from 'react'
import packageJson from '../../../package.json'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { toast, Toaster } from 'sonner'
import { Menu, X, RefreshCw, LogIn, AlertTriangle } from 'lucide-react'
import { usePanesStore, getPaneStore, deletePaneStore, collectLeafIds, countLeaves, type LayoutNode, type PaneMode, type PaneOrientation } from './store/pane-store'
import { getFileTreeStore, deleteFileTreeStore } from './store/file-tree-store'
import { findPaneInDirection, focusPane, registerPaneElement, registerPaneFocus, type Direction } from './lib/pane-refs'
import { getBridge } from './lib/bridge'
import { ChatPane } from './components/ChatPane'
import { Sidebar, type SidebarView } from './components/Sidebar'
import { useIsMobile } from './lib/useIsMobile'
import { VoiceDownloadBanner } from './components/VoiceDownloadBanner'
import { IOSInstallBanner } from './components/IOSInstallBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { ModelPicker } from './components/ModelPicker'
import { useVoiceStore } from './store/voice-store'
import { CommandPalette } from './components/CommandPalette'
import { Settings } from './components/Settings'
import { Onboarding } from './components/Onboarding'
import { formatModelDisplay, getModelRefFromState } from './lib/models'
import { chrome } from './lib/theme'
import { useSwipeGesture } from './lib/useSwipeGesture'
import { useIOSKeyboard } from './lib/useIOSKeyboard'
import { getCapabilities } from './lib/capabilities'
import type { ConnectionStatus } from './lib/web-bridge'
import type { Bridge } from '../../../preload/index'

// Lazy-load heavy desktop-only components — not needed on mobile
const Terminal = lazy(() => import('./components/Terminal').then((m) => ({ default: m.Terminal })))
const FileViewer = lazy(() => import('./components/FileViewer').then((m) => ({ default: m.FileViewer })))

// Import save-nonce utilities for self-save suppression.
// Using dynamic import to avoid circular deps; nonce module is module-level singleton.
import { consumeSaveNonce } from './components/FileViewer'

const MIN_FILE_VIEWER_WIDTH = 200
const MAX_FILE_VIEWER_WIDTH = 840

function clampFileViewerWidth(
  viewportWidth: number,
  requestedWidth: number,
  _paneCount: number,
  _sidebarCollapsed: boolean,
): number {
  return Math.min(Math.max(requestedWidth, MIN_FILE_VIEWER_WIDTH), Math.min(MAX_FILE_VIEWER_WIDTH, viewportWidth - 300))
}

// ============================================================================
// Layout tree renderer (module-level to avoid re-creation on each render)
// ============================================================================

function PaneTerminal({
  paneId,
  isActive,
  hasUnreadResponse,
  onFocus,
  onSwitchToChat,
  onClose,
}: {
  paneId: string
  isActive: boolean
  hasUnreadResponse: boolean
  onFocus: () => void
  onSwitchToChat: () => void
  onClose?: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    registerPaneElement(paneId, rootRef.current)
    return () => registerPaneElement(paneId, null)
  }, [paneId])

  useEffect(() => {
    registerPaneFocus(paneId, () => rootRef.current?.focus())
    return () => registerPaneFocus(paneId, null)
  }, [paneId])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onClick={!isActive ? onFocus : undefined}
      className={[
        'flex flex-1 flex-col h-full min-w-0 w-full overflow-hidden transition-all duration-200',
        !isActive && !hasUnreadResponse ? 'opacity-60 hover:opacity-80' : '',
        !isActive && hasUnreadResponse ? 'opacity-60 hover:opacity-80 outline outline-2 outline-orange-400/80' : '',
        isActive ? 'outline outline-1 outline-accent/30' : '',
      ].join(' ')}
    >
      <div className={`flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 ${chrome.bar} ${chrome.text}`}>
        <div className="text-xs font-medium uppercase tracking-[0.12em] text-text-secondary">Terminal</div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSwitchToChat()
            }}
            className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-primary/85 transition-opacity hover:opacity-100"
            title="Switch this pane back to chat"
          >
            Chat
          </button>
          {onClose && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-text-secondary transition-colors hover:bg-text-secondary/20 hover:text-text-primary"
              title="Close pane"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={null}>
          <Terminal terminalId={paneId} />
        </Suspense>
      </div>
    </div>
  )
}

function renderLayoutNode(
  node: LayoutNode,
  activePaneId: string,
  paneModes: Record<string, PaneMode>,
  sidebarCollapsed: boolean,
  paneCount: number,
  voicePttShortcut: 'space' | 'alt+space' | 'cmd+shift+space',
  voiceAudioEnabled: boolean,
  textToSpeechMode: boolean,
  notificationSoundEnabled: boolean,
  paneAttention: Record<string, boolean>,
  setPaneMode: (paneId: string, mode: PaneMode) => void,
  focusPaneById: (id: string) => void,
  handleClosePane: (id: string) => Promise<void>,
  handlePaneNeedsAttention: (paneId: string) => void,
  handleOpenFile: (paneId: string, relativePath: string) => Promise<void>,
): ReactNode {
  if (node.type === 'leaf') {
    if ((paneModes[node.paneId] ?? 'chat') === 'terminal') {
      return (
        <PaneTerminal
          key={node.paneId}
          paneId={node.paneId}
          isActive={node.paneId === activePaneId}
          hasUnreadResponse={paneAttention[node.paneId] === true}
          onFocus={() => focusPaneById(node.paneId)}
          onSwitchToChat={() => setPaneMode(node.paneId, 'chat')}
          onClose={paneCount > 1 ? () => void handleClosePane(node.paneId) : undefined}
        />
      )
    }
    return (
      <ChatPane
        key={node.paneId}
        paneId={node.paneId}
        isActive={node.paneId === activePaneId}
        hasUnreadResponse={paneAttention[node.paneId] === true}
        sidebarCollapsed={sidebarCollapsed && paneCount === 1}
        voicePttShortcut={voicePttShortcut}
        voiceAudioEnabled={voiceAudioEnabled}
        textToSpeechMode={textToSpeechMode}
        notificationSoundEnabled={notificationSoundEnabled}
        onSwitchToTerminal={() => setPaneMode(node.paneId, 'terminal')}
        onFocus={() => focusPaneById(node.paneId)}
        onRequestAttention={handlePaneNeedsAttention}
        onClose={paneCount > 1 ? () => void handleClosePane(node.paneId) : undefined}
        onOpenFile={handleOpenFile}
      />
    )
  }

  const isHorizontal = node.orientation === 'horizontal'
  const minSize = isHorizontal ? 10 : 15
  const handleClass = isHorizontal
    ? 'w-0.5 bg-border hover:bg-border-active transition-colors cursor-col-resize flex-shrink-0'
    : 'h-0.5 bg-border hover:bg-border-active transition-colors cursor-row-resize flex-shrink-0'

  const panels: ReactNode[] = []
  node.children.forEach((child, idx) => {
    if (idx > 0) {
      panels.push(
        <PanelResizeHandle
          key={`handle-${node.id}-${idx}`}
          className={handleClass}
        />,
      )
    }
    const childKey = child.type === 'leaf' ? child.paneId : child.id
    panels.push(
      <Panel key={childKey} minSize={minSize} className="flex flex-col min-h-0 min-w-0">
        {renderLayoutNode(child, activePaneId, paneModes, sidebarCollapsed, paneCount, voicePttShortcut, voiceAudioEnabled, textToSpeechMode, notificationSoundEnabled, paneAttention, setPaneMode, focusPaneById, handleClosePane, handlePaneNeedsAttention, handleOpenFile)}
      </Panel>,
    )
  })

  return (
    <PanelGroup key={node.id} orientation={node.orientation} className="flex-1 min-h-0 min-w-0">
      {panels}
    </PanelGroup>
  )
}

// ============================================================================
// App
// ============================================================================

export default function App() {
  const bridge = getBridge()

  // Pane layout state
  const { layout, activePaneId, paneModes, setActivePane, setPaneMode } = usePanesStore()
  const paneIds = collectLeafIds(layout)
  const paneCount = paneIds.length

  // Active pane's store (for status bar + command palette model)
  const activePaneStore = getPaneStore(activePaneId)
  const {
    agentHealth: activePaneHealth,
    currentModel: activePaneModel,
    currentSessionPath: activePaneSessionPath,
    currentSessionName: activePaneSessionName,
    isGenerating: activePaneGenerating,
    isCompacting: activePaneCompacting,
    autoCompactionEnabled: activePaneAutoCompactionEnabled,
    contextUsagePct: activePaneContextUsagePct,
    availableThinkingLevels: activePaneAvailableThinkingLevels,
  } = activePaneStore()

  // Mobile detection
  const isMobile = useIsMobile()

  // Voice store (global, not per-pane) — select only needed state to avoid re-renders
  const voiceSidecarState = useVoiceStore((s) => s.sidecarState)
  const voiceError = useVoiceStore((s) => s.error)

  // -------------------------------------------------------------------------
  // UI state
  // -------------------------------------------------------------------------

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  // Restore mobile drawer open state from localStorage (Task 10: State persistence)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(() => {
    try { return localStorage.getItem('lc_sidebar_open') === 'true' } catch { return false }
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [fileViewerOpen, setFileViewerOpen] = useState(false)
  const [fileViewerWidth, setFileViewerWidth] = useState(440)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [sidebarView, setSidebarView] = useState<SidebarView>('sessions')
  const [voicePttShortcut, setVoicePttShortcut] = useState<'space' | 'alt+space' | 'cmd+shift+space'>('space')
  const [voiceAudioEnabled, setVoiceAudioEnabled] = useState(false)
  const [thinkingLevel, setThinkingLevel] = useState<'off' | 'auto' | 'low' | 'medium' | 'high'>('medium')
  const [textToSpeechMode, setTextToSpeechMode] = useState(false)
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(false)
  const [voiceModelsDownloaded, setVoiceModelsDownloaded] = useState(false)
  const [paneAttention, setPaneAttention] = useState<Record<string, boolean>>({})
  // Reconnect banner state (PWA only)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connected')

  // External file change conflict state — shown when a dirty tab is changed on disk
  const [fileConflict, setFileConflict] = useState<{
    paneId: string
    tabKey: string
    relativePath: string
    newDiskContent: string
  } | null>(null)

  // iOS keyboard state — used to pin input bar above keyboard
  const { isKeyboardOpen, keyboardHeight } = useIOSKeyboard()

  // Refs kept in sync with modal open state — used in keydown handler for gating
  const commandPaletteOpenRef = useRef(commandPaletteOpen)
  const settingsOpenRef = useRef(settingsOpen)
  const modelPickerOpenRef = useRef(modelPickerOpen)
  const newSessionInFlightRef = useRef(false)
  const sidebarCollapsedRef = useRef(sidebarCollapsed)
  const sidebarViewRef = useRef(sidebarView)
  useEffect(() => { commandPaletteOpenRef.current = commandPaletteOpen }, [commandPaletteOpen])
  useEffect(() => { settingsOpenRef.current = settingsOpen }, [settingsOpen])
  useEffect(() => { modelPickerOpenRef.current = modelPickerOpen }, [modelPickerOpen])
  useEffect(() => { sidebarCollapsedRef.current = sidebarCollapsed }, [sidebarCollapsed])
  useEffect(() => { sidebarViewRef.current = sidebarView }, [sidebarView])

  // -------------------------------------------------------------------------
  // Load persisted settings on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    bridge
      .getSettings()
      .then((s) => {
        // Default to collapsed — only expand if explicitly set to false
        if (s.sidebarCollapsed === false) {
          setSidebarCollapsed(false)
        }
        if (s.voicePttShortcut === 'space' || s.voicePttShortcut === 'alt+space' || s.voicePttShortcut === 'cmd+shift+space') {
          setVoicePttShortcut(s.voicePttShortcut)
        }
        if (s.voiceAudioEnabled === true) {
          setVoiceAudioEnabled(true)
        }
        if (s.thinkingLevel === 'off' || s.thinkingLevel === 'auto' || s.thinkingLevel === 'low' || s.thinkingLevel === 'medium' || s.thinkingLevel === 'high') {
          setThinkingLevel(s.thinkingLevel)
          // Apply default thinking level to the initial pane
          getPaneStore(usePanesStore.getState().activePaneId).getState().setThinkingLevel(s.thinkingLevel)
        }
        if (s.textToSpeechMode === true) {
          setTextToSpeechMode(true)
        }
        if (s.notificationSoundEnabled === false) {
          setNotificationSoundEnabled(false)
        }
        if (s.voiceModelsDownloaded === true) {
          setVoiceModelsDownloaded(true)
        }
        if (!s.onboardingComplete) {
          setShowOnboarding(true)
        }
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Swipe gesture: right-swipe from left edge opens drawer, left-swipe closes
  // -------------------------------------------------------------------------

  const handleSwipeOpen = useCallback(() => setMobileDrawerOpen(true), [])
  const handleSwipeClose = useCallback(() => setMobileDrawerOpen(false), [])

  useSwipeGesture({
    onSwipeRight: handleSwipeOpen,
    onSwipeLeft: handleSwipeClose,
    isOpen: mobileDrawerOpen,
    enabled: isMobile,
  })

  // -------------------------------------------------------------------------
  // State persistence — save mobile drawer open state to localStorage
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isMobile) return
    try {
      if (mobileDrawerOpen) {
        localStorage.setItem('lc_sidebar_open', 'true')
      } else {
        localStorage.removeItem('lc_sidebar_open')
      }
    } catch {
      // localStorage may be unavailable in some private browsing modes
    }
  }, [mobileDrawerOpen, isMobile])

  // -------------------------------------------------------------------------
  // State persistence — save active session path to localStorage on mobile
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isMobile) return
    try {
      if (activePaneSessionPath) {
        localStorage.setItem('lc_active_session', activePaneSessionPath)
      } else {
        localStorage.removeItem('lc_active_session')
      }
    } catch {
      // localStorage may be unavailable in some private browsing modes
    }
  }, [activePaneSessionPath, isMobile])

  // -------------------------------------------------------------------------
  // Reconnect resilience — subscribe to WebBridge connection status changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    const b = bridge as Bridge & { onConnectionStatusChange?: (cb: (s: ConnectionStatus) => void) => () => void }
    if (typeof b.onConnectionStatusChange !== 'function') return
    const unsubscribe = b.onConnectionStatusChange((status) => {
      setConnectionStatus(status)
    })
    return () => unsubscribe()
  }, [bridge]) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Persist sidebar collapsed state when it changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!settingsLoaded) return
    bridge.setSettings({ sidebarCollapsed }).catch(() => {})
  }, [sidebarCollapsed, settingsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Sync native window title with active pane's session name
  // -------------------------------------------------------------------------

  useEffect(() => {
    const title = activePaneSessionName ? activePaneSessionName : 'Lucent Code'
    bridge.setWindowTitle(title).catch(() => {})
  }, [activePaneSessionName]) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Mark voice models as downloaded once voice service reaches ready state
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!settingsLoaded) return
    if (voiceSidecarState === 'ready' && !voiceModelsDownloaded) {
      setVoiceModelsDownloaded(true)
      bridge.setSettings({ voiceModelsDownloaded: true }).catch(() => {})
    }
  }, [voiceSidecarState, voiceModelsDownloaded, settingsLoaded, bridge])

  useEffect(() => {
    const handleWindowResize = () => {
      setFileViewerWidth((currentWidth) => clampFileViewerWidth(window.innerWidth, currentWidth, paneCount, sidebarCollapsed))
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [paneCount, sidebarCollapsed])

  useEffect(() => {
    if (!fileViewerOpen) return
    setFileViewerWidth((currentWidth) =>
      Math.min(currentWidth, Math.min(MAX_FILE_VIEWER_WIDTH, window.innerWidth - 300))
    )
  }, [fileViewerOpen, paneCount, sidebarCollapsed])

  // -------------------------------------------------------------------------
  // Pane split / close actions
  // -------------------------------------------------------------------------

  const handleSplitPane = useCallback(async (orientation: PaneOrientation = 'horizontal') => {
    const state = usePanesStore.getState()
    if (countLeaves(state.layout) >= 4) {
      toast.error('Maximum 4 panes allowed')
      return
    }
    try {
      // Inherit the active pane's project root so the new pane opens in the same workspace
      const sourcePaneId = usePanesStore.getState().activePaneId
      const sourceProjectRoot = getPaneStore(sourcePaneId).getState().projectRoot || undefined
      // bridge.paneCreate now returns immediately — agent init runs in background
      const { paneId: newPaneId } = await bridge.paneCreate(sourceProjectRoot)
      // Initialize new pane with the current default thinking level
      getPaneStore(newPaneId).getState().setThinkingLevel(thinkingLevel)
      const inserted = usePanesStore.getState().splitPane(
        usePanesStore.getState().activePaneId,
        newPaneId,
        orientation,
      )
      if (!inserted) {
        await bridge.paneClose(newPaneId).catch(() => {})
        deletePaneStore(newPaneId)
      }
    } catch (err) {
      console.error('[pane] create failed:', err)
      toast.error('Failed to create pane')
    }
  }, [bridge])

  const handleClosePane = useCallback(async (paneIdToClose: string) => {
    if (countLeaves(usePanesStore.getState().layout) <= 1) return
    try {
      await bridge.paneClose(paneIdToClose)
      usePanesStore.getState().removePane(paneIdToClose)
      setPaneAttention((current) => {
        if (!(paneIdToClose in current)) return current
        const next = { ...current }
        delete next[paneIdToClose]
        return next
      })
      deletePaneStore(paneIdToClose)
      deleteFileTreeStore(paneIdToClose)
    } catch (err) {
      console.error('[pane] close failed:', err)
    }
  }, [bridge])

  const handleNavigatePane = useCallback((direction: Direction) => {
    const currentActive = usePanesStore.getState().activePaneId
    const targetId = findPaneInDirection(currentActive, direction)
    if (targetId) {
      setActivePane(targetId)
      setPaneAttention((current) => {
        if (!current[targetId]) return current
        return { ...current, [targetId]: false }
      })
      focusPane(targetId)
    }
  }, [setActivePane])

  const focusPaneById = useCallback((paneId: string) => {
    setActivePane(paneId)
    setPaneAttention((current) => {
      if (!current[paneId]) return current
      return { ...current, [paneId]: false }
    })
  }, [setActivePane])

  const handlePaneNeedsAttention = useCallback((paneId: string) => {
    setPaneAttention((current) => {
      if (current[paneId]) return current
      return { ...current, [paneId]: true }
    })
  }, [])

  useEffect(() => {
    setPaneAttention((current) => {
      if (!current[activePaneId]) return current
      return { ...current, [activePaneId]: false }
    })
  }, [activePaneId])

  // -------------------------------------------------------------------------
  // Sidebar / session actions (scoped to active pane)
  // -------------------------------------------------------------------------

  const syncPaneState = useCallback(async (paneId: string) => {
    const state = await bridge.getState(paneId)
    const paneStore = getPaneStore(paneId).getState()
    const modelRef = getModelRefFromState(state)
    if (modelRef) paneStore.setModel(modelRef)
    if (typeof state.sessionFile === 'string') paneStore.setSessionPath(state.sessionFile)
    if (typeof state.sessionName === 'string') paneStore.setSessionName(state.sessionName)
    return { state, modelRef }
  }, [bridge])

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => !c)
  }, [])

  const handleVoiceAudioEnabledChange = useCallback((enabled: boolean) => {
    setVoiceAudioEnabled(enabled)
    bridge.setSettings({ voiceAudioEnabled: enabled }).catch(() => {})
  }, [bridge])

  const handleTextToSpeechModeChange = useCallback((enabled: boolean) => {
    setTextToSpeechMode(enabled)
    bridge.setSettings({ textToSpeechMode: enabled }).catch(() => {})
  }, [bridge])

  const handleNotificationSoundEnabledChange = useCallback((enabled: boolean) => {
    setNotificationSoundEnabled(enabled)
    bridge.setSettings({ notificationSoundEnabled: enabled }).catch(() => {})
  }, [bridge])

  const handleThinkingLevelChange = useCallback((level: 'off' | 'auto' | 'low' | 'medium' | 'high') => {
    setThinkingLevel(level)
    bridge.setSettings({ thinkingLevel: level }).catch(() => {})
  }, [bridge])

  const handleAutoCompactThresholdChange = useCallback((percent: number) => {
    if (!bridge.setCompactionThreshold) return
    const paneIds = collectLeafIds(usePanesStore.getState().layout)
    for (const paneId of paneIds) {
      bridge.setCompactionThreshold(paneId, percent).catch(() => {})
    }
  }, [bridge])

  const cycleThinkingLevel = useCallback(() => {
    const paneId = usePanesStore.getState().activePaneId
    const paneStore = getPaneStore(paneId).getState()
    const available = paneStore.availableThinkingLevels.filter(
      (l) => l !== 'minimal' && l !== 'xhigh'
    ) as Array<'off' | 'auto' | 'low' | 'medium' | 'high'>
    const currentLevel = paneStore.thinkingLevel
    const idx = available.indexOf(currentLevel)
    const nextLevel = available[(idx + 1) % available.length]
    paneStore.setThinkingLevel(nextLevel)
    bridge.setThinkingLevel(paneId, nextLevel).catch(() => {})
  }, [bridge])

  const handleToggleExplorer = useCallback(() => {
    if (sidebarCollapsedRef.current) {
      setSidebarCollapsed(false)
      setSidebarView('explorer')
      return
    }
    setSidebarView((current) => (current === 'explorer' ? 'sessions' : 'explorer'))
  }, [])

  const handleNewSession = useCallback(async () => {
    if (newSessionInFlightRef.current) return
    newSessionInFlightRef.current = true

    const paneStore = getPaneStore(activePaneId).getState()
    paneStore.bumpSessionEpoch()

    try {
      const result = await bridge.newSession(activePaneId)
      if (!result.cancelled) {
        // Clear the pane store and sync state
        paneStore.clearSessionView()
        paneStore.setSessionName('')
        paneStore.setSessionPath(null)
        await syncPaneState(activePaneId)
      }
    } finally {
      window.setTimeout(() => {
        newSessionInFlightRef.current = false
      }, 150)
    }
  }, [bridge, activePaneId, syncPaneState])

  const handleSwitchSession = useCallback(async (path: string) => {
    const paneStore = getPaneStore(activePaneId).getState()
    paneStore.bumpSessionEpoch()
    const result = await bridge.switchSession(activePaneId, path)
    if (result.cancelled) return
    await syncPaneState(activePaneId).catch(() => {})
    const history = await bridge.getMessages(activePaneId).catch(() => [] as Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }>)
    paneStore.loadHistory(history)
    paneStore.setSessionPath(path)
    syncPaneState(activePaneId).catch(() => {})
  }, [bridge, activePaneId, syncPaneState])

  const handleRefresh = useCallback(() => {
    syncPaneState(activePaneId).catch(() => {})
  }, [activePaneId, syncPaneState])

  const openFileViewer = useCallback(() => {
    const viewportWidth = window.innerWidth
    const currentSidebarWidth = sidebarCollapsed ? 40 : sidebarWidth
    const desiredWidth = Math.round((viewportWidth - currentSidebarWidth) / 2)
    setFileViewerWidth(clampFileViewerWidth(viewportWidth, desiredWidth, paneCount, sidebarCollapsed))
    setFileViewerOpen(true)
  }, [paneCount, sidebarCollapsed, sidebarWidth])

  const toggleFileViewer = useCallback(() => {
    if (fileViewerOpen) {
      setFileViewerOpen(false)
      return
    }
    openFileViewer()
  }, [fileViewerOpen, openFileViewer])

  // -------------------------------------------------------------------------
  // File open action (used by CommandPalette recent files)
  // -------------------------------------------------------------------------

  const handleOpenFile = useCallback(async (paneId: string, relativePath: string) => {
    try {
      const result = await bridge.fsReadFile(paneId, relativePath)
      getPaneStore(paneId).getState().openFile({
        relativePath,
        content: result.content,
        source: 'user',
        truncated: result.truncated,
        isBinary: result.isBinary,
      })
      openFileViewer()
    } catch (err) {
      console.error('[openFile]', err)
    }
  }, [bridge, openFileViewer])

  const handleOpenDiff = useCallback(async (paneId: string, relativePath: string) => {
    try {
      const diff = await bridge.gitFileDiff(paneId, relativePath)
      if (!diff) {
        toast.error(`No diff available for ${relativePath}`)
        return
      }

      getPaneStore(paneId).getState().openDiff({
        relativePath: diff.path,
        diffText: diff.diffText,
        status: diff.status,
        previousPath: diff.previousPath,
        isBinary: diff.isBinary,
      })
      openFileViewer()
    } catch (err) {
      console.error('[openDiff]', err)
      toast.error(err instanceof Error ? err.message : 'Failed to load diff')
    }
  }, [bridge, openFileViewer])

  useEffect(() => {
    const pendingReloads = new Map<string, number>()

    const unsubscribe = bridge.onFileChanged(({ paneId, changes }) => {
      const existingTimeout = pendingReloads.get(paneId)
      if (existingTimeout) {
        window.clearTimeout(existingTimeout)
      }

      const timeoutId = window.setTimeout(() => {
        pendingReloads.delete(paneId)

        const treeStore = getFileTreeStore(paneId)
        void treeStore.getState().refreshVisibleDirs()
        void treeStore.getState().refreshModifiedFiles()

        const paneStore = getPaneStore(paneId)
        const openTabs = paneStore.getState().openFiles
        const changedPaths = changes
          .map((change) => change.relativePath)
          .filter((path): path is string => typeof path === 'string' && path.length > 0)

        const affectedOpenTabs = changedPaths.length === 0
          ? openTabs
          : openTabs.filter((openTab) =>
              changedPaths.some((changedPath) =>
                openTab.relativePath === changedPath || openTab.relativePath.startsWith(`${changedPath}/`),
              ),
            )

        void Promise.allSettled(
          affectedOpenTabs.map(async (openTab) => {
            try {
              if (openTab.kind === 'diff') {
                const diff = await bridge.gitFileDiff(paneId, openTab.relativePath)
                if (!diff) {
                  paneStore.getState().closeFile(openTab.tabKey)
                  return
                }
                paneStore.getState().openDiff({
                  relativePath: diff.path,
                  diffText: diff.diffText,
                  status: diff.status,
                  previousPath: diff.previousPath,
                  isBinary: diff.isBinary,
                })
                return
              }

              // Check if this change was caused by our own save — if so, skip reload
              if (consumeSaveNonce(openTab.relativePath)) return

              const result = await bridge.fsReadFile(paneId, openTab.relativePath)
              const outcome = paneStore.getState().externalReload(openTab.tabKey, result.content)

              if (outcome === 'conflict') {
                // Tab is dirty — show "Reload / Keep mine" dialog instead of silently reloading
                setFileConflict({
                  paneId,
                  tabKey: openTab.tabKey,
                  relativePath: openTab.relativePath,
                  newDiskContent: result.content,
                })
              }
              // outcome === 'reloaded' means already updated in store
            } catch {
              paneStore.getState().closeFile(openTab.tabKey)
            }
          }),
        )
      }, 140)

      pendingReloads.set(paneId, timeoutId)
    })

    return () => {
      for (const timeoutId of pendingReloads.values()) {
        window.clearTimeout(timeoutId)
      }
      unsubscribe()
    }
  }, [bridge])

  useEffect(() => {
    const unsubscribe = bridge.onAppShortcut(({ action }) => {
      if (action === 'new-session') {
        const isModalOpen = commandPaletteOpenRef.current || settingsOpenRef.current || modelPickerOpenRef.current
        if (isModalOpen) {
          return
        }
        void handleNewSession()
        return
      }
      if (action === 'toggle-file-viewer') {
        toggleFileViewer()
        return
      }
      if (action === 'toggle-permission-mode') {
        bridge.togglePanePermissionMode?.(activePaneId).catch(() => {})
        return
      }
      if (action === 'close-pane') {
        const isModalOpen = commandPaletteOpenRef.current || settingsOpenRef.current || modelPickerOpenRef.current
        if (!isModalOpen) {
          void handleClosePane(usePanesStore.getState().activePaneId)
        }
      }
    })
    return () => unsubscribe()
  }, [bridge, handleNewSession, toggleFileViewer, activePaneId])

  const handleFileViewerResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const nextWidth = clampFileViewerWidth(window.innerWidth, window.innerWidth - moveEvent.clientX, paneCount, sidebarCollapsed)
      setFileViewerWidth(nextWidth)
    }

    const handlePointerUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
  }, [paneCount, sidebarCollapsed])

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const next = Math.min(Math.max(startWidth + (moveEvent.clientX - startX), 260), 600)
      setSidebarWidth(next)
    }

    const handlePointerUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
  }, [sidebarWidth])

  // -------------------------------------------------------------------------
  // Model actions (scoped to active pane)
  // -------------------------------------------------------------------------

  const handleClearContext = useCallback(async () => {
    const paneId = usePanesStore.getState().activePaneId
    window.dispatchEvent(new CustomEvent('lucent:clear-context', { detail: { paneId } }))
  }, [])

  const handleSwitchModel = useCallback(async (provider: string, modelId: string) => {
    const requestedModel = `${provider}/${modelId}`
    try {
      await bridge.switchModel(activePaneId, provider, modelId)
      const { modelRef } = await syncPaneState(activePaneId)
      if (modelRef && modelRef !== requestedModel) {
        toast.error(`Model switch did not apply. Active model is ${formatModelDisplay(modelRef, { includeProvider: true })}.`)
        return
      }
      if (!modelRef) {
        toast.error('Model switch completed, but the active model could not be confirmed.')
        return
      }
    } catch (err) {
      console.error('[model] switchModel failed:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to switch model')
    }
  }, [bridge, activePaneId, syncPaneState])

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  // Keep isMobile accessible inside the keydown handler without stale closure
  const isMobileRef = useRef(isMobile)
  useEffect(() => { isMobileRef.current = isMobile }, [isMobile])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isModalOpen = commandPaletteOpenRef.current || settingsOpenRef.current || modelPickerOpenRef.current
      const mobile = isMobileRef.current

      // Cmd+Option+Arrow — spatial pane navigation (desktop only)
      if (!mobile && e.metaKey && e.altKey) {
        if (!isModalOpen) {
          if (e.key === 'ArrowLeft')  { e.preventDefault(); handleNavigatePane('left');  return }
          if (e.key === 'ArrowRight') { e.preventDefault(); handleNavigatePane('right'); return }
          if (e.key === 'ArrowUp')    { e.preventDefault(); handleNavigatePane('up');    return }
          if (e.key === 'ArrowDown')  { e.preventDefault(); handleNavigatePane('down');  return }
        }
      }

      // Cmd+1-4 — focus pane by index (desktop only)
      if (!mobile && e.metaKey && ['1', '2', '3', '4'].includes(e.key)) {
        const idx = parseInt(e.key, 10) - 1
        const ids = collectLeafIds(usePanesStore.getState().layout)
        if (idx < ids.length) {
          e.preventDefault()
          focusPaneById(ids[idx])
          focusPane(ids[idx])
          return
        }
      }

      // Suppress app-level shortcuts when focus is inside a CodeMirror editor.
      // CM6 handles Cmd+F (search), Cmd+H (replace), Cmd+G (go-to-line), etc.
      // internally without propagation, but we add this guard for safety.
      const targetEl = e.target instanceof HTMLElement ? e.target : null
      if (targetEl?.closest('[data-codemirror="true"]')) {
        // Only Cmd+K is allowed to pass through (command palette, always works)
        if (e.metaKey && e.key === 'k') {
          e.preventDefault()
          setCommandPaletteOpen((v) => !v)
        }
        return
      }

      // Cmd+K — open command palette (always works, even in inputs)
      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen((v) => !v)
        return
      }

      // Cmd+T — cycle thinking level (desktop only)
      if (!mobile && e.metaKey && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        cycleThinkingLevel()
        return
      }

      // Cmd+Shift+T — toggle active pane terminal mode (desktop only)
      if (!mobile && e.metaKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        const paneId = usePanesStore.getState().activePaneId
        const currentMode = usePanesStore.getState().paneModes[paneId] ?? 'chat'
        setPaneMode(paneId, currentMode === 'terminal' ? 'chat' : 'terminal')
        return
      }

      // Cmd+E — toggle explorer within the sidebar (desktop only)
      if (!mobile && e.metaKey && !e.shiftKey && e.key === 'e') {
        e.preventDefault()
        handleToggleExplorer()
        return
      }

      // Cmd+Shift+F — toggle file viewer panel (desktop only)
      if (!mobile && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyF') {
        e.preventDefault()
        toggleFileViewer()
        return
      }

      // Cmd+Shift+D — split pane vertically (desktop only; must come before Cmd+D check)
      if (!mobile && e.metaKey && e.shiftKey && e.code === 'KeyD') {
        if (!isModalOpen) {
          e.preventDefault()
          void handleSplitPane('vertical')
        }
        return
      }

      // Cmd+D — split pane horizontally (desktop only)
      if (!mobile && e.metaKey && !e.shiftKey && e.code === 'KeyD') {
        if (!isModalOpen) {
          e.preventDefault()
          void handleSplitPane('horizontal')
        }
        return
      }

      // Escape — close command palette first; otherwise stop the active pane
      if (e.key === 'Escape') {
        if (commandPaletteOpenRef.current) {
          e.preventDefault()
          setCommandPaletteOpen(false)
          return
        }
        if (!isModalOpen) {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('lucent:stop-active-pane', {
            detail: { paneId: usePanesStore.getState().activePaneId },
          }))
        }
        return
      }

      // Cmd+N — new session (always works, even in inputs)
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyN') {
        if (!isModalOpen) {
          e.preventDefault()
          void handleNewSession()
        }
        return
      }

      // /clear — start a fresh session and clear visible context
      if (!isModalOpen && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        const target = e.target as HTMLElement | null
        const textField = target?.closest('textarea, input, [contenteditable="true"]') as HTMLTextAreaElement | HTMLInputElement | null
        const value = typeof textField?.value === 'string' ? textField.value.trim() : ''
        if (value === '/clear') {
          e.preventDefault()
          void handleClearContext()
          return
        }
      }

      // Shift+T — cycle the app thinking level
      if (!isModalOpen && !e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        cycleThinkingLevel()
        return
      }

      // Don't capture remaining shortcuts when focus is in an input/textarea
      const tag = (e.target as HTMLElement).tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return

      if (e.metaKey && e.key === 'b') {
        e.preventDefault()
        handleToggleSidebar()
      }
      if (e.metaKey && e.key === 'p') {
        e.preventDefault()
        setModelPickerOpen((v) => !v)
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
      }
      // Cmd+W — handled in main process via before-input-event to work even when
      // terminals or iframes swallow keyboard events.
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const sidebarEl = (
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
        currentSessionPath={activePaneSessionPath}
        activePaneId={activePaneId}
        view={sidebarView}
        onViewChange={setSidebarView}
        onNewSession={handleNewSession}
        onSwitchSession={(path) => void handleSwitchSession(path)}
        onRefresh={handleRefresh}
        isCompacting={activePaneCompacting}
        autoCompactionEnabled={activePaneAutoCompactionEnabled}
      onOpenModelPicker={() => setModelPickerOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
      onExplorerFileOpen={openFileViewer}
      onOpenDiff={handleOpenDiff}
    />
  )

  // Recursive layout tree renderer
  const chatPaneGroup = renderLayoutNode(
    layout,
    activePaneId,
    paneModes,
    sidebarCollapsed,
    paneCount,
    voicePttShortcut,
    voiceAudioEnabled,
    textToSpeechMode,
    notificationSoundEnabled,
    paneAttention,
    setPaneMode,
    focusPaneById,
    handleClosePane,
    handlePaneNeedsAttention,
    handleOpenFile,
  )

  // -------------------------------------------------------------------------
  // Health dot color (reused in header on mobile)
  // -------------------------------------------------------------------------

  const healthDotColor =
    activePaneHealth === 'ready'
      ? 'bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]'
      : activePaneHealth === 'starting'
        ? 'bg-accent shadow-[0_0_4px_rgba(249,115,22,0.5)] animate-pulse'
        : activePaneHealth === 'crashed' || activePaneHealth === 'degraded'
          ? 'bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.5)]'
          : 'bg-bg-tertiary'
  const appVersionLabel = `v${packageJson.version}`

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Shared dialogs/overlays (used in both mobile and desktop renders)
  const sharedOverlays = (
    <>
      {/* Model picker dialog — full-screen overlay on mobile */}
      <div data-mobile-fullscreen={isMobile ? 'true' : undefined}>
        <ModelPicker open={modelPickerOpen} onOpenChange={setModelPickerOpen} isMobile={isMobile} />
      </div>

      {/* Command palette — Cmd+K; bottom sheet on mobile */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        activePaneId={activePaneId}
        onNewSession={() => void handleNewSession()}
        onSwitchSession={(path) => void handleSwitchSession(path)}
        onToggleSidebar={handleToggleSidebar}
        onSwitchModel={(provider, modelId) => void handleSwitchModel(provider, modelId)}
        onStopGeneration={() => bridge.abort(activePaneId).catch(() => {})}
        onSettings={() => setSettingsOpen(true)}
        onSplitPane={() => void handleSplitPane('horizontal')}
        onSplitPaneVertical={() => void handleSplitPane('vertical')}
        onNavigatePane={(dir) => handleNavigatePane(dir)}
        onClosePane={paneCount > 1 ? () => void handleClosePane(activePaneId) : undefined}
        onOpenFile={handleOpenFile}
        onRunSkill={(trigger) => {
          if (trigger === 'clear') {
            void handleClearContext()
            return
          }
          const text = `/${trigger}`
          bridge.prompt(activePaneId, text).then((turn_id) => {
            getPaneStore(activePaneId).getState().addUserMessage(text, turn_id)
          }).catch(() => {})
        }}
        isGenerating={activePaneGenerating}
        canSplit={paneCount < 4}
        isMobile={isMobile}
      />

      {/* Settings dialog — full-screen overlay on mobile */}
      <div data-mobile-fullscreen={isMobile ? 'true' : undefined}>
        <Settings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          voicePttShortcut={voicePttShortcut}
          onVoicePttShortcutChange={setVoicePttShortcut}
          voiceAudioEnabled={voiceAudioEnabled}
          onVoiceAudioEnabledChange={handleVoiceAudioEnabledChange}
          textToSpeechMode={textToSpeechMode}
          onTextToSpeechModeChange={handleTextToSpeechModeChange}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={handleThinkingLevelChange}
          showAdaptiveThinkingOption={activePaneAvailableThinkingLevels.includes('auto')}
          notificationSoundEnabled={notificationSoundEnabled}
          onNotificationSoundEnabledChange={handleNotificationSoundEnabledChange}
          onAutoCompactThresholdChange={handleAutoCompactThresholdChange}
          isMobile={isMobile}
        />
      </div>

      {/* First-run onboarding overlay */}
      {showOnboarding && (
        <Onboarding onComplete={() => setShowOnboarding(false)} />
      )}

      {/* Toast notifications — bottom-right, dark theme */}
      <Toaster position="bottom-right" theme="dark" richColors />

      {/* External file change conflict dialog */}
      {fileConflict && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="File changed on disk"
        >
          <div className="bg-bg-secondary border border-border rounded-lg shadow-2xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-shrink-0 size-8 rounded-full bg-amber-500/15 flex items-center justify-center">
                <AlertTriangle className="size-4 text-amber-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-text-primary">File changed on disk</h2>
                <p className="text-xs text-text-tertiary mt-0.5">{fileConflict.relativePath}</p>
              </div>
            </div>
            <p className="text-xs text-text-secondary mb-6">
              This file was modified on disk while you have unsaved changes in the editor.
              Would you like to reload from disk (discarding your edits) or keep your version?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  // Keep mine — dismiss dialog, leave dirty state intact
                  setFileConflict(null)
                }}
                className="px-3 py-1.5 text-xs text-text-secondary border border-border rounded hover:bg-bg-hover transition-colors"
              >
                Keep mine
              </button>
              <button
                onClick={() => {
                  // Reload from disk — discard draft
                  getPaneStore(fileConflict.paneId).getState().discardDraft(
                    fileConflict.tabKey,
                    fileConflict.newDiskContent,
                  )
                  setFileConflict(null)
                }}
                className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/80 transition-colors"
              >
                Reload from disk
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  // ── Mobile layout ──────────────────────────────────────────────────────────
  if (isMobile) {
    // When keyboard is open, pin input area above the keyboard using visualViewport height.
    // We do NOT add safe-area-inset-bottom on top of this (prevents double-offset).
    const mobileInputStyle = isKeyboardOpen
      ? { paddingBottom: `${keyboardHeight}px` }
      : undefined

    return (
      <div
        className="mobile-touch flex flex-col bg-bg-primary text-text-primary overflow-hidden"
        // Use dvh so the container always tracks the visible viewport (shrinks with keyboard on Android/iOS)
        style={{ height: '100dvh' }}
      >
        {/* Mobile header: no drag region, hamburger left, title center, health right */}
        {/* In Electron on macOS, add extra left padding to clear the overlaid traffic lights */}
        <header className="mobile-header" style={getCapabilities().terminal ? { paddingLeft: '80px' } : undefined}>
          <button
            aria-label="Open navigation menu"
            className="mobile-header__hamburger"
            onClick={() => setMobileDrawerOpen(true)}
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="mobile-header__title">Lucent Code</div>
          <div className="mobile-header__health">
            <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${healthDotColor}`} />
            <span className="text-xs text-text-tertiary">
              {appVersionLabel}
            </span>
          </div>
        </header>

        {/* iOS Safari "Add to Home Screen" install guidance */}
        <IOSInstallBanner />

        {/* Auto-update notifications — shows toast when update is ready */}
        <UpdateBanner />

        {/* Reconnecting banner — shown when WebSocket drops (PWA mode) */}
        {connectionStatus === 'reconnecting' && (
          <div className="reconnecting-banner" role="status" aria-live="polite">
            <RefreshCw className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
            <span>Reconnecting...</span>
          </div>
        )}

        {/* Re-auth prompt — shown when token is expired */}
        {connectionStatus === 'reauth' && (
          <div className="reauth-banner" role="alert">
            <LogIn className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Session expired — </span>
            <button
              className="underline font-medium ml-1"
              onClick={() => {
                localStorage.removeItem('lc_bridge_token')
                window.location.reload()
              }}
            >
              Sign in again
            </button>
          </div>
        )}

        {/* Voice download banner */}
        <VoiceDownloadBanner
          show={settingsLoaded && !voiceModelsDownloaded && (voiceSidecarState === 'starting' || voiceSidecarState === 'error')}
          state={voiceSidecarState as 'starting' | 'ready' | 'error'}
          error={voiceError ?? undefined}
        />

        {/* Single chat pane — full width, constrained above keyboard */}
        <div className="flex-1 min-h-0 flex flex-col mobile-input-area" style={mobileInputStyle}>
          {(paneModes[activePaneId] ?? 'chat') === 'terminal' ? (
            <PaneTerminal
              paneId={activePaneId}
              isActive
              hasUnreadResponse={false}
              onFocus={() => {}}
              onSwitchToChat={() => setPaneMode(activePaneId, 'chat')}
            />
          ) : (
            <ChatPane
              paneId={activePaneId}
              isActive
              hasUnreadResponse={false}
              sidebarCollapsed
              voicePttShortcut={voicePttShortcut}
              voiceAudioEnabled={voiceAudioEnabled}
              textToSpeechMode={textToSpeechMode}
              notificationSoundEnabled={notificationSoundEnabled}
              onSwitchToTerminal={() => setPaneMode(activePaneId, 'terminal')}
              onFocus={() => {}}
              onRequestAttention={handlePaneNeedsAttention}
              onOpenFile={handleOpenFile}
              isMobile
            />
          )}
        </div>

        {/* Slide-out drawer backdrop */}
        <div
          className={`mobile-sidebar-backdrop ${mobileDrawerOpen ? 'mobile-sidebar-backdrop--visible' : ''}`}
          onClick={() => setMobileDrawerOpen(false)}
          aria-hidden="true"
        />

        {/* Slide-out sidebar drawer */}
        <div className={`mobile-sidebar-drawer ${mobileDrawerOpen ? 'mobile-sidebar-drawer--open' : ''}`}>
          {/* Drawer close button */}
          <div className="flex items-center justify-end px-2 pt-2 flex-shrink-0">
            <button
              aria-label="Close navigation menu"
              onClick={() => setMobileDrawerOpen(false)}
              className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-bg-hover text-text-secondary"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* Sidebar content (reuse existing component, always expanded on mobile) */}
          <Sidebar
            collapsed={false}
            onToggleCollapse={() => setMobileDrawerOpen(false)}
            currentSessionPath={activePaneSessionPath}
            activePaneId={activePaneId}
            view={sidebarView}
            onViewChange={setSidebarView}
            onNewSession={async () => {
              await handleNewSession()
              setMobileDrawerOpen(false)
            }}
            onSwitchSession={(path) => {
              void handleSwitchSession(path)
              setMobileDrawerOpen(false)
            }}
            onRefresh={handleRefresh}
            isCompacting={activePaneCompacting}
            autoCompactionEnabled={activePaneAutoCompactionEnabled}
            onOpenModelPicker={() => { setModelPickerOpen(true); setMobileDrawerOpen(false) }}
            onOpenSettings={() => { setSettingsOpen(true); setMobileDrawerOpen(false) }}
            onExplorerFileOpen={() => { openFileViewer(); setMobileDrawerOpen(false) }}
            onOpenDiff={handleOpenDiff}
          />
        </div>

        {sharedOverlays}
      </div>
    )
  }

  // ── Desktop layout ─────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col bg-bg-primary text-text-primary overflow-hidden">
      {/* Fixed top bar — spans full width */}
      <header
        className={`relative flex h-9 flex-shrink-0 items-center border-b border-border ${chrome.bar} ${chrome.text}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Spacer for traffic lights (always) + collapsed sidebar (when collapsed) */}
        <div className={sidebarCollapsed ? 'pl-32 flex-shrink-0' : 'pl-20 flex-shrink-0'} />

        {/* App name — centered horizontally */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-semibold pointer-events-none">
          Lucent Code
        </div>

        {/* Spacer to push status to the right */}
        <div className="flex-1" />

        {/* Agent health / status */}
        <div
          className="pr-4 flex items-center gap-2 flex-shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${healthDotColor}`} />
          <span className="text-sm">
            v{packageJson.version}
          </span>
        </div>
      </header>

      {/* iOS Safari "Add to Home Screen" install guidance */}
      <IOSInstallBanner />

      {/* Auto-update notifications — shows toast when update is ready */}
      <UpdateBanner />

      {/* Voice download banner — only shows on first startup when models need downloading */}
      <VoiceDownloadBanner
        show={settingsLoaded && !voiceModelsDownloaded && (voiceSidecarState === 'starting' || voiceSidecarState === 'error')}
        state={voiceSidecarState as 'starting' | 'ready' | 'error'}
        error={voiceError ?? undefined}
      />

      {/* Vertical panel group: chat area on top, optional terminal at bottom */}
      <PanelGroup orientation="vertical" className="flex-1 min-h-0">
        {/* Top panel: sidebar | pane group | file viewer */}
        <Panel className="flex min-h-0 min-w-0">
          <div className="flex flex-1 min-h-0 min-w-0">
            {/* Sidebar — fixed width when collapsed, draggable when expanded */}
            <div
              className="flex-shrink-0"
              style={sidebarCollapsed ? { width: '40px' } : { width: `${sidebarWidth}px` }}
            >
              {sidebarEl}
            </div>

            {/* Sidebar drag handle — hidden when collapsed */}
            {!sidebarCollapsed && (
              <div
                role="separator"
                aria-label="Resize sidebar"
                aria-orientation="vertical"
                onMouseDown={handleSidebarResizeStart}
                className="group flex w-0.5 flex-shrink-0 cursor-col-resize items-stretch justify-center bg-transparent"
              />
            )}

            {/* Unified horizontal PanelGroup */}
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              <div className="flex min-h-0 min-w-0" style={{ flex: '1 1 0%' }}>
                {chatPaneGroup}
              </div>

              {fileViewerOpen && (
                <>
                  <div
                    role="separator"
                    aria-label="Resize file viewer"
                    aria-orientation="vertical"
                    onMouseDown={handleFileViewerResizeStart}
                    className="group flex w-2 flex-shrink-0 cursor-col-resize items-stretch justify-center bg-transparent"
                  >
                    <div className="w-px bg-border transition-colors group-hover:bg-accent-gray/50" />
                  </div>
                  <div
                    className="flex min-h-0 border-l border-border bg-bg-secondary"
                    style={{ width: `${fileViewerWidth}px`, minWidth: `${MIN_FILE_VIEWER_WIDTH}px`, maxWidth: '80%', flexShrink: 1 }}
                  >
                    <Suspense fallback={null}>
                      <FileViewer paneId={activePaneId} onClose={() => setFileViewerOpen(false)} />
                    </Suspense>
                  </div>
                </>
              )}
            </div>
          </div>
        </Panel>

        {/* Terminal panel — toggled with Cmd+T */}
        {terminalOpen && (
          <>
            <PanelResizeHandle className="h-0.5 bg-accent/70 hover:bg-accent transition-colors cursor-row-resize" />
            <Panel defaultSize={30} minSize={10} className="flex flex-col min-h-0">
              <Suspense fallback={null}>
                <Terminal terminalId={activePaneId} />
              </Suspense>
            </Panel>
          </>
        )}
      </PanelGroup>

      {sharedOverlays}

    </div>
  )
}
