/**
 * useVoice — core voice integration hook.
 *
 * Manages:
 *  - Microphone capture via ScriptProcessorNode (resampled to 16 kHz Int16LE)
 *  - WebSocket connection to the local audio service
 *  - TTS audio playback via AudioPlaybackQueue
 *  - Sentence accumulation: feeds agent text chunks to tts_synthesize messages
 *  - Half-duplex: mic is muted while TTS is playing
 */

import { useEffect, useRef, useCallback } from 'react'
import { useVoiceStore } from '../store/voice-store'
import { getBridge } from './bridge'

// ============================================================================
// Constants
// ============================================================================

/** Split on sentence boundaries — matches server-side Python SENTENCE_RE. */
const SENTENCE_RE = /(?<=[.!?\n])\s+/

/** Flush to TTS when buffer exceeds this many chars (regardless of sentence boundary). */
const MAX_SENTENCE_CHARS = 150

// ============================================================================
// resampleTo16k — linear interpolation downsample
// ============================================================================

function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return input
  const ratio = fromRate / 16000
  const outputLen = Math.round(input.length / ratio)
  const output = new Float32Array(outputLen)
  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio
    const idx = Math.floor(srcIdx)
    const frac = srcIdx - idx
    output[i] =
      idx + 1 < input.length
        ? input[idx] * (1 - frac) + input[idx + 1] * frac
        : input[idx] ?? 0
  }
  return output
}

// ============================================================================
// prepareTtsText — strip markdown for TTS synthesis
// ============================================================================

/**
 * Strip markdown syntax that would sound wrong when read aloud.
 * Mirrors voice-bridge server.py lines 72–94.
 */
function prepareTtsText(text: string): string {
  if (!text?.trim()) return ''
  let cleaned = text
  // Fenced code blocks
  cleaned = cleaned.replace(/```[A-Za-z0-9_+-]*\n?[\s\S]*?```/g, ' ')
  // Markdown links → just the link text
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  // Inline code → just the text
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1')
  // Headers
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  // Unordered list markers
  cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, '')
  // Ordered list markers
  cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, '')
  // Table separators
  cleaned = cleaned.replace(/^\s*\|?[:\- ]+\|[:\-| ]*$/gm, ' ')
  // Bold and italic
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1')
  cleaned = cleaned.replace(/\*(.*?)\*/g, '$1')
  // Pipe characters (table cells)
  cleaned = cleaned.replace(/\|/g, ' ')
  // Emoji (surrogate pairs + BMP ranges)
  cleaned = cleaned.replace(
    /[\u{10000}-\u{10FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu,
    ''
  )
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ')
  return cleaned.trim()
}

// ============================================================================
// AudioPlaybackQueue
// ============================================================================

/**
 * Queue for streaming TTS audio buffers.
 * Converts Int16 PCM (24 kHz) to Web Audio API buffers and plays them
 * gaplessly via chained AudioBufferSourceNode callbacks.
 *
 * Calls onDrain() when the queue empties so the caller can resume mic.
 */
class AudioPlaybackQueue {
  private ctx: AudioContext
  private queue: AudioBuffer[] = []
  private playing = false
  private currentSource: AudioBufferSourceNode | null = null
  private readonly onDrain: () => void
  private destroyed = false

  constructor(onDrain: () => void) {
    this.ctx = new AudioContext({ sampleRate: 24000 })
    this.onDrain = onDrain
  }

  /** Enqueue a raw Int16 PCM chunk (24 kHz mono). */
  enqueue(int16Data: ArrayBuffer): void {
    if (this.destroyed) return
    // Resume AudioContext if the browser suspended it (gesture requirement)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    const int16 = new Int16Array(int16Data)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768
    }
    const buffer = this.ctx.createBuffer(1, float32.length, 24000)
    buffer.copyToChannel(float32, 0)
    this.queue.push(buffer)
    if (!this.playing) this.playNext()
  }

  private playNext(): void {
    if (this.queue.length === 0) {
      this.playing = false
      this.onDrain()
      return
    }
    this.playing = true
    const buffer = this.queue.shift()!
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    source.onended = () => this.playNext()
    this.currentSource = source
    source.start()
  }

  /** Stop all playback immediately and clear the queue. */
  stop(): void {
    this.queue = []
    const source = this.currentSource
    if (source) {
      source.onended = null
    }
    try {
      source?.stop()
    } catch {
      // may throw if already stopped
    }
    this.currentSource = null
    this.playing = false
  }

  /** Stop and close the AudioContext. */
  destroy(): void {
    this.destroyed = true
    this.stop()
    this.ctx.close().catch(() => {})
  }
}

// ============================================================================
// Hook interface
// ============================================================================

interface UseVoiceOptions {
  /** Called when a final transcript is ready to submit as a prompt. */
  onTranscript: (text: string) => void
  /** The ID of the currently active pane (voice follows active pane). */
  activePaneId: string
  /** Whether assistant TTS playback is enabled. */
  ttsEnabled: boolean
  /** Whether the dedicated read-all-text mode is enabled. */
  textOnlyMode: boolean
}

interface UseVoiceReturn {
  toggleVoice: () => void
  beginVoiceCapture: () => void
  finishVoiceCapture: () => void
  stopTts: () => void
  /** Feed an agent text chunk to the TTS sentence accumulator. */
  feedAgentChunk: (text: string, turnId: string) => void
  /** Flush the remaining TTS buffer at the end of an agent turn. */
  flushTts: (turnId: string) => void
}

// ============================================================================
// useVoice
// ============================================================================

export function useVoice({ onTranscript, activePaneId: _activePaneId, ttsEnabled, textOnlyMode }: UseVoiceOptions): UseVoiceReturn {
  const voiceStore = useVoiceStore
  const bridge = getBridge()
  const isVoiceOwner = useVoiceStore((state) => state.active && state.activePaneId === _activePaneId)
  const sidecarState = useVoiceStore((state) => state.sidecarState)

  // Refs for mutable audio/WS state (not React state — avoids re-render churn)
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const playbackQueueRef = useRef<AudioPlaybackQueue | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ttsOnlyWsRequestedRef = useRef(false)
  const pendingReleaseRef = useRef(false)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoDeactivateAfterTurnRef = useRef(false)
  const ttsRequestedForTurnRef = useRef(false)
  const turnFinishedRef = useRef(false)
  const ttsEnabledRef = useRef(ttsEnabled)
  const textOnlyModeEnabledRef = useRef(textOnlyMode)
  const sidecarTokenRef = useRef<string | null>(null)
  const textOnlyModeRef = useRef(false) // Tracks active TTS-only sidecar/ws resources.
  const pendingTtsRequestsRef = useRef<Array<{ text: string; turnId: string; gen: number }>>([])
  const pendingTranscriptPartsRef = useRef<string[]>([])

  // TTS sentence accumulation
  const ttsSentenceBufferRef = useRef('')
  const ttsTurnIdRef = useRef<string | null>(null)
  const ttsTurnGenRef = useRef<number | null>(null)

  // =========================================================================
  // TTS helpers
  // =========================================================================

  /** Send a tts_synthesize request if the prepared text is non-empty. */
  const sendTtsSynthesize = useCallback((text: string) => {
    if (!ttsEnabledRef.current) return
    const prepared = prepareTtsText(text)
    if (!prepared) return
    const turnId = ttsTurnIdRef.current
    const gen = ttsTurnGenRef.current
    if (!turnId || gen === null) return

    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ttsRequestedForTurnRef.current = true
      ws.send(JSON.stringify({ type: 'tts_synthesize', text: prepared, turn_id: turnId, gen }))
      return
    }
    pendingTtsRequestsRef.current.push({ text: prepared, turnId, gen })
  }, [])

  const flushPendingTtsRequests = useCallback(() => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return
    const queued = pendingTtsRequestsRef.current
    if (queued.length === 0) return

    for (const request of queued) {
      ttsRequestedForTurnRef.current = true
      ws.send(JSON.stringify({
        type: 'tts_synthesize',
        text: request.text,
        turn_id: request.turnId,
        gen: request.gen,
      }))
    }

    pendingTtsRequestsRef.current = []
  }, [])

  /** Flush whatever remains in the TTS sentence buffer. */
  const flushTtsBuffer = useCallback(() => {
    const buf = ttsSentenceBufferRef.current
    if (buf.trim()) {
      sendTtsSynthesize(buf)
    }
    ttsSentenceBufferRef.current = ''
    ttsTurnIdRef.current = null
    ttsTurnGenRef.current = null
  }, [sendTtsSynthesize])

  const stopTts = useCallback(() => {
    const ws = wsRef.current
    playbackQueueRef.current?.stop()
    voiceStore.getState().setTtsPlaying(false)
    pendingTtsRequestsRef.current = []
    const nextGen = voiceStore.getState().nextTtsGen()
    ttsTurnGenRef.current = null
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tts_stop' }))
      ws.send(JSON.stringify({ type: 'tts_flush', gen: nextGen }))
    }
  }, [voiceStore])

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled
    textOnlyModeEnabledRef.current = textOnlyMode
    if (!ttsEnabled) {
      stopTts()
      ttsSentenceBufferRef.current = ''
      ttsTurnIdRef.current = null
      ttsTurnGenRef.current = null
      pendingTtsRequestsRef.current = []
    }
  }, [ttsEnabled, textOnlyMode, stopTts])

  // =========================================================================
  // TTS-only mode initialization (no microphone)
  // =========================================================================

  // Initialize voice service for TTS-only mode when enabled
  useEffect(() => {
    let cancelled = false

    const initTtsOnlyMode = async () => {
      if (cancelled) return
      
      const state = voiceStore.getState()
      
      // Only initialize for explicit text-only mode. Normal voice playback should
      // start the sidecar only when the user activates voice capture.
      if (!textOnlyMode || state.active || state.sidecarState === 'ready' || state.sidecarState === 'starting') {
        return
      }

      try {
        state.setSidecarState('starting')
        const started = await bridge.voiceStart()
        if (cancelled) return
        
        sidecarTokenRef.current = started.token
        state.setPort(started.port)
        state.setAvailable(true, null)
        state.setSidecarState('ready')
        textOnlyModeRef.current = true
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Voice service failed to start'
        state.setError(msg)
        state.setSidecarState('error')
      }
    }

    void initTtsOnlyMode()

    // Cleanup on unmount or when TTS is disabled
    return () => {
      cancelled = true
      if (textOnlyModeRef.current && !textOnlyModeEnabledRef.current) {
        // Clean up TTS-only mode resources when TTS is disabled
        playbackQueueRef.current?.destroy()
        playbackQueueRef.current = null
        if (wsRef.current) {
          wsRef.current.close()
          wsRef.current = null
        }
        pendingTtsRequestsRef.current = []
        textOnlyModeRef.current = false
      }
    }
  }, [textOnlyMode, bridge, voiceStore])

  // =========================================================================
  // Sidecar status sync
  // =========================================================================

  const applyVoiceStatus = useCallback((status: { available: boolean; state: string; port: number | null; token: string | null; reason?: string }) => {
    const store = voiceStore.getState()
    const nextState = status.state as ReturnType<typeof voiceStore.getState>['sidecarState']
    sidecarTokenRef.current = status.token
    store.setAvailable(status.available, status.reason ?? null)
    store.setSidecarState(nextState)
    store.setPort(status.port)
    if (nextState === 'error' && status.reason) {
      store.setError(status.reason)
    }
  }, [voiceStore])

  useEffect(() => {
    let cancelled = false

    const syncInitialStatus = async () => {
      try {
        const status = await bridge.voiceStatus()
        if (cancelled) return
        applyVoiceStatus(status)

        if (!status.available || status.state === 'unavailable') {
          const probe = await bridge.voiceProbe()
          if (cancelled) return
          voiceStore.getState().setAvailable(probe.available, probe.reason ?? null)
          voiceStore.getState().setSidecarState(probe.available ? 'stopped' : 'unavailable')
          if (!probe.available) {
            voiceStore.getState().setPort(null)
          }
        }
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'Voice initialization failed'
        voiceStore.getState().setAvailable(false, message)
        voiceStore.getState().setSidecarState('error')
        voiceStore.getState().setError(message)
      }
    }

    void syncInitialStatus()

    const unsubscribe = bridge.onVoiceStatus((status) => {
      if (cancelled) return
      applyVoiceStatus(status)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, voiceStore, applyVoiceStatus])

  // =========================================================================
  // Stop mic capture
  // =========================================================================

  const stopMic = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  const isMicRunning = useCallback(() => {
    return !!processorRef.current && !!audioCtxRef.current && !!streamRef.current
  }, [])

  const disconnectVoiceIo = useCallback(() => {
    ttsOnlyWsRequestedRef.current = false
    pendingReleaseRef.current = false
    autoDeactivateAfterTurnRef.current = false
    ttsRequestedForTurnRef.current = false
    turnFinishedRef.current = false
    pendingTranscriptPartsRef.current = []
    voiceStore.getState().setTtsPlaying(false)
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    stopMic()
    playbackQueueRef.current?.destroy()
    playbackQueueRef.current = null
    pendingTtsRequestsRef.current = []
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
  }, [stopMic])

  const completePushToTalkRelease = useCallback(() => {
    const state = voiceStore.getState()
    if (!state.active || state.activePaneId !== _activePaneId) return
    pendingReleaseRef.current = false
    pendingTranscriptPartsRef.current = []
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    state.setActive(false, null)
    disconnectVoiceIo()
  }, [voiceStore, _activePaneId, disconnectVoiceIo])

  useEffect(() => {
    if (sidecarState !== 'unavailable' || !isVoiceOwner) return
    voiceStore.getState().setActive(false, null)
    disconnectVoiceIo()
  }, [sidecarState, isVoiceOwner, voiceStore, disconnectVoiceIo])

  // =========================================================================
  // Playback queue drain — called when audio queue empties
  // =========================================================================

  const handlePlaybackDrain = useCallback(() => {
    // Resume mic: send vad_reset so the server knows TTS finished
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'vad_reset' }))
    }
    voiceStore.getState().setTtsPlaying(false)

    if (autoDeactivateAfterTurnRef.current && turnFinishedRef.current) {
      completePushToTalkRelease()
    }
  }, [voiceStore, completePushToTalkRelease])

  // =========================================================================
  // WebSocket connection
  // =========================================================================

  const connectWs = useCallback((port: number) => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    const token = sidecarTokenRef.current
    if (!token) {
      voiceStore.getState().setError('Voice authentication token missing')
      return
    }

    const isElectron = !!window.__ELECTRON__
    let ws: WebSocket

    if (isElectron) {
      // Electron: connect directly to the local Python sidecar
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)
    } else {
      // PWA: connect through the bridge server's voice proxy
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${wsProtocol}//${window.location.host}/voice-ws`)
    }

    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      ttsOnlyWsRequestedRef.current = false
      console.log('[voice] WebSocket connected')
      if (!isElectron) {
        // PWA: send auth message to the bridge server proxy
        const bridgeToken = localStorage.getItem('lc_bridge_token') ?? ''
        ws.send(JSON.stringify({ type: 'auth', token: bridgeToken }))
      }
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (!ttsEnabledRef.current) return
        // Binary frame: TTS audio. First 4 bytes = uint32 LE generation counter.
        const view = new DataView(event.data)
        if (event.data.byteLength < 4) return
        const gen = view.getUint32(0, true)
        const currentGen = voiceStore.getState().ttsGen
        if (gen < currentGen) return // stale frame, discard

        // Remaining bytes are Int16 PCM at 24 kHz
        const audioData = event.data.slice(4)
        if (!playbackQueueRef.current) {
          playbackQueueRef.current = new AudioPlaybackQueue(handlePlaybackDrain)
        }
        playbackQueueRef.current.enqueue(audioData)
      } else {
        // Text frame: JSON message
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(event.data as string)
        } catch {
          return
        }

        switch (msg.type) {
          case 'ready':
            voiceStore.getState().setWsConnected(true)
            flushPendingTtsRequests()
            break
          case 'vad_state':
            voiceStore.getState().setSpeaking(msg.speaking as boolean)
            break
          case 'partial_transcript':
            voiceStore.getState().setPartialTranscript(msg.text as string)
            break
          case 'transcript': {
            const finalPart = typeof msg.text === 'string' ? msg.text.trim() : ''
            voiceStore.getState().setPartialTranscript('')

            if (pendingReleaseRef.current) {
              if (finalPart) pendingTranscriptPartsRef.current.push(finalPart)
              const combined = pendingTranscriptPartsRef.current.join(' ').replace(/\s+/g, ' ').trim()
              pendingReleaseRef.current = false
              pendingTranscriptPartsRef.current = []
              if (releaseTimerRef.current) {
                clearTimeout(releaseTimerRef.current)
                releaseTimerRef.current = null
              }
              if (combined) onTranscript(combined)
              break
            }

            if (finalPart) {
              onTranscript(finalPart)
            }
            break
          }
          case 'tts_start':
            voiceStore.getState().setTtsPlaying(true)
            break
          case 'tts_end':
            // Don't clear ttsPlaying yet — wait for actual audio drain
            break
          case 'error':
            voiceStore.getState().setError(msg.message as string)
            break
        }
      }
    }

    ws.onclose = () => {
      ttsOnlyWsRequestedRef.current = false
      voiceStore.getState().setWsConnected(false)
      wsRef.current = null
      // Reconnect if live voice is still active or TTS-only mode is enabled.
      const state = voiceStore.getState()
      const shouldReconnect =
        (state.active && state.activePaneId === _activePaneId)
        || (!state.active && textOnlyModeEnabledRef.current)
      if (shouldReconnect) {
        reconnectTimerRef.current = setTimeout(() => {
          const latest = voiceStore.getState()
          const p = latest.port
          const reconnectAllowed =
            (latest.active && latest.activePaneId === _activePaneId)
            || (!latest.active && textOnlyModeEnabledRef.current)
          if (p && reconnectAllowed) {
            connectWs(p)
          }
        }, 2000)
      }
    }

    ws.onerror = (err) => {
      ttsOnlyWsRequestedRef.current = false
      console.error('[voice] WebSocket error', err)
      voiceStore.getState().setError('WebSocket connection failed')
    }
  }, [voiceStore, onTranscript, handlePlaybackDrain, _activePaneId, completePushToTalkRelease, flushPendingTtsRequests])

  useEffect(() => {
    const state = voiceStore.getState()
    const ws = wsRef.current
    if (!textOnlyMode) return
    if (state.active) return
    if (state.sidecarState !== 'ready' || !state.port) return
    if (!sidecarTokenRef.current) return
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
    if (ttsOnlyWsRequestedRef.current) return
    ttsOnlyWsRequestedRef.current = true
    connectWs(state.port)
  }, [textOnlyMode, sidecarState, connectWs, voiceStore])

  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: 16000 }, channelCount: 1 },
      })
      voiceStore.getState().setMicPermission('granted')
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx

      if (audioCtx.sampleRate !== 16000) {
        console.log(`[voice] mic sample rate ${audioCtx.sampleRate} Hz — will resample to 16 kHz`)
      }

      const source = audioCtx.createMediaStreamSource(stream)
      // ScriptProcessorNode: simpler than AudioWorklet for MVP
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)

      processor.onaudioprocess = (e) => {
        // Skip sending mic frames while TTS is playing (half-duplex)
        if (voiceStore.getState().ttsPlaying) return

        const input = e.inputBuffer.getChannelData(0) // Float32
        const resampled = resampleTo16k(input, audioCtx.sampleRate)

        // Convert Float32 [-1, 1] → Int16LE
        const int16 = new Int16Array(resampled.length)
        for (let i = 0; i < resampled.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, Math.round(resampled[i] * 32768)))
        }

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(int16.buffer)
        }
      }

      source.connect(processor)
      // ScriptProcessorNode requires connection to destination to fire onaudioprocess
      processor.connect(audioCtx.destination)
      processorRef.current = processor
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied'
      voiceStore.getState().setMicPermission('denied')
      voiceStore.getState().setError(msg)
      console.error('[voice] mic error:', err)
    }
  }, [voiceStore])

  // =========================================================================
  // Toggle voice on/off
  // =========================================================================

  const toggleVoice = useCallback(async () => {
    const state = voiceStore.getState()
    const thisPaneOwnsVoice = state.active && state.activePaneId === _activePaneId

    if (thisPaneOwnsVoice) {
      // --- Turn voice OFF ---
      state.setActive(false, null)
      autoDeactivateAfterTurnRef.current = false

      // Stop TTS
      stopTts()

      // Flush any pending TTS buffer
      flushTtsBuffer()

      // Close local resources cleanly
      disconnectVoiceIo()
    } else {
      // --- Turn voice ON ---
      let port = state.port
      if (!port) {
        try {
          state.setSidecarState('starting')
          const started = await bridge.voiceStart()
          port = started.port
          sidecarTokenRef.current = started.token
          state.setPort(port)
          state.setAvailable(true, null)
          state.setSidecarState('ready')
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Voice service failed to start'
          state.setError(msg)
          state.setSidecarState('error')
          return
        }
      }

      state.setActive(true, _activePaneId)
      autoDeactivateAfterTurnRef.current = false

      // Connect WebSocket first
      connectWs(port)

      // Start mic
      await startMic()
    }
  }, [voiceStore, bridge, _activePaneId, stopTts, flushTtsBuffer, connectWs, startMic, disconnectVoiceIo])

  const beginVoiceCapture = useCallback(async () => {
    const state = voiceStore.getState()
    const thisPaneOwnsVoice = state.active && state.activePaneId === _activePaneId

    if (!thisPaneOwnsVoice) {
      let port = state.port
      if (!port) {
        try {
          state.setSidecarState('starting')
          const started = await bridge.voiceStart()
          port = started.port
          sidecarTokenRef.current = started.token
          state.setPort(port)
          state.setAvailable(true, null)
          state.setSidecarState('ready')
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Voice service failed to start'
          state.setError(msg)
          state.setSidecarState('error')
          return
        }
      }

      state.setActive(true, _activePaneId)
      autoDeactivateAfterTurnRef.current = true
      connectWs(port)
    } else {
      autoDeactivateAfterTurnRef.current = false
    }

    if (!isMicRunning()) {
      await startMic()
    }
  }, [voiceStore, bridge, _activePaneId, connectWs, startMic, isMicRunning])

  const finishVoiceCapture = useCallback(() => {
    const state = voiceStore.getState()
    if (!state.active || state.activePaneId !== _activePaneId) return

    stopMic()
    state.setSpeaking(false)
    const partial = state.partialTranscript.trim()
    pendingTranscriptPartsRef.current = partial ? [partial] : []
    pendingReleaseRef.current = true
    turnFinishedRef.current = false
    ttsRequestedForTurnRef.current = false

    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stt_finalize' }))
    }
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
    }
    releaseTimerRef.current = setTimeout(() => {
      pendingTranscriptPartsRef.current = []
      completePushToTalkRelease()
    }, 1500)
  }, [voiceStore, _activePaneId, stopMic, completePushToTalkRelease])

  // =========================================================================
  // Feed agent chunk for TTS
  // =========================================================================

  const feedAgentChunk = useCallback((text: string, turnId: string) => {
    if (!ttsEnabledRef.current) return
    const state = voiceStore.getState()
    
    // In TTS-only mode, we process text even if voice is not "active" (no mic)
    const isTtsOnlyMode = !state.active && textOnlyModeEnabledRef.current
    if (!state.active && !isTtsOnlyMode) return
    if (!isTtsOnlyMode && state.activePaneId !== _activePaneId) return
    
    // Ensure WebSocket is connected for TTS
    const ws = wsRef.current
    const port = state.port
    if (state.sidecarState === 'ready' && (!ws || ws.readyState !== WebSocket.OPEN) && port) {
      connectWs(port)
    }

    // Reset buffer if this is a new turn
    if (turnId !== ttsTurnIdRef.current) {
      ttsSentenceBufferRef.current = ''
      ttsTurnIdRef.current = turnId
      ttsTurnGenRef.current = voiceStore.getState().nextTtsGen()
      pendingTtsRequestsRef.current = []
      ttsRequestedForTurnRef.current = false
      turnFinishedRef.current = false
    }

    ttsSentenceBufferRef.current += text

    // Check for sentence boundaries or buffer overflow
    const parts = ttsSentenceBufferRef.current.split(SENTENCE_RE)
    if (parts.length > 1) {
      // Send all but the last fragment (incomplete sentence)
      const toSend = parts.slice(0, -1).join(' ')
      ttsSentenceBufferRef.current = parts[parts.length - 1] ?? ''
      sendTtsSynthesize(toSend)
    } else if (ttsSentenceBufferRef.current.length > MAX_SENTENCE_CHARS) {
      // Buffer overflow — send it all
      sendTtsSynthesize(ttsSentenceBufferRef.current)
      ttsSentenceBufferRef.current = ''
    }
  }, [voiceStore, _activePaneId, sendTtsSynthesize, connectWs])

  // =========================================================================
  // Flush TTS at end of agent turn
  // =========================================================================

  const flushTts = useCallback((turnId: string) => {
    if (!ttsEnabledRef.current) return
    const state = voiceStore.getState()
    
    // In TTS-only mode, process even if voice is not "active"
    const isTtsOnlyMode = !state.active && textOnlyModeEnabledRef.current
    if (!state.active && !isTtsOnlyMode) return
    if (!isTtsOnlyMode && state.activePaneId !== _activePaneId) return
    if (turnId !== ttsTurnIdRef.current) return
    flushTtsBuffer()

    if (!autoDeactivateAfterTurnRef.current) return

    turnFinishedRef.current = true

    if (!ttsRequestedForTurnRef.current) {
      completePushToTalkRelease()
      return
    }

    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
    }
    releaseTimerRef.current = setTimeout(() => {
      completePushToTalkRelease()
    }, 180000)
  }, [voiceStore, _activePaneId, flushTtsBuffer, completePushToTalkRelease])

  useEffect(() => {
    if (!isVoiceOwner && !textOnlyModeEnabledRef.current) {
      disconnectVoiceIo()
    }
  }, [isVoiceOwner, disconnectVoiceIo, textOnlyMode])

  // =========================================================================
  // Cleanup on unmount
  // =========================================================================

  useEffect(() => {
    return () => {
      // Clean up all resources when hook unmounts
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      disconnectVoiceIo()
    }
  }, [disconnectVoiceIo])

  return {
    toggleVoice: () => { void toggleVoice() },
    beginVoiceCapture: () => { void beginVoiceCapture() },
    finishVoiceCapture,
    stopTts,
    feedAgentChunk,
    flushTts,
  }
}
