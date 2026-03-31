"""audio_service.py — Standalone voice audio service for Studio.

WebSocket server that exposes VAD, Whisper STT, and Kokoro TTS to the Electron
main process. Bound to 127.0.0.1 on an OS-assigned port; the actual port is
announced on stdout so the caller can connect.

Startup protocol
----------------
On success:  VOICE_SERVICE_READY port=<port>\n  (to stdout)
On failure:  VOICE_SERVICE_ERROR <message>\n    (to stdout) then sys.exit(1)

All other logging goes to stderr only.

WebSocket endpoint: ws://127.0.0.1:<port>/ws
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

# ---------------------------------------------------------------------------
# Optional VOICE_BRIDGE_PATH injection for local debugging — must happen
# before any voice_bridge imports
# ---------------------------------------------------------------------------

vb_path = os.environ.get("VOICE_BRIDGE_PATH")
if vb_path:
    sys.path.insert(0, vb_path)

# ---------------------------------------------------------------------------
# Imports (defer heavy ML imports until after path is set)
# ---------------------------------------------------------------------------

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

# ---------------------------------------------------------------------------
# Logging helpers (all to stderr — stdout is reserved for protocol)
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    print(f"[audio-service] {msg}", file=sys.stderr, flush=True)


def _announce(msg: str) -> None:
    """Write a single protocol line to stdout."""
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Globals — populated during startup
# ---------------------------------------------------------------------------

_vad_model: Any = None       # SileroVAD instance
_whisper_model: Any = None   # pywhispercpp Model instance
_tts_engine: Any = None      # BufferedTTSEngine instance
_tts_error: str | None = None
_auth_token = os.environ.get("VOICE_SERVICE_TOKEN", "").strip()

# Thread pool for blocking CPU work (Whisper + TTS)
_executor = ThreadPoolExecutor(max_workers=2)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI()

# ---------------------------------------------------------------------------
# Per-connection session state
# ---------------------------------------------------------------------------


class AudioSession:
    """All mutable state for a single WebSocket connection."""

    def __init__(self) -> None:
        from voice_bridge.vad import RemoteVADProcessor

        self.vad = RemoteVADProcessor(_vad_model)

        # --- STT accumulation ---
        self.pending_segments: list[str] = []
        self.continuation_deadline: float | None = None
        self._continuation_task: asyncio.Task | None = None

        # --- TTS ---
        # Queue of (text, turn_id, gen) tuples
        self.tts_queue: asyncio.Queue[tuple[str, str, int]] = asyncio.Queue()
        self.tts_stop_event: asyncio.Event = asyncio.Event()
        # Minimum gen to play — items with gen < this value are discarded
        self.tts_min_gen: int = 0

        # --- Background tasks (cancelled on disconnect) ---
        self._tts_worker_task: asyncio.Task | None = None

        # Last reported VAD speaking state (used to detect state changes)
        self._last_speaking: bool = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, ws: WebSocket) -> None:
        """Start background tasks that need the websocket handle."""
        self._tts_worker_task = asyncio.create_task(
            self._tts_worker(ws), name="tts-worker"
        )

    async def stop(self) -> None:
        """Cancel all background tasks and clean up."""
        if self._continuation_task and not self._continuation_task.done():
            self._continuation_task.cancel()
        if self._tts_worker_task and not self._tts_worker_task.done():
            self._tts_worker_task.cancel()
        # Interrupt any in-progress TTS synthesis
        if _tts_engine is not None:
            _tts_engine.stop()

    # ------------------------------------------------------------------
    # Audio / VAD / STT
    # ------------------------------------------------------------------

    async def handle_audio(self, data: bytes, ws: WebSocket) -> None:
        """Process raw Int16LE PCM bytes from the client."""
        # Convert Int16LE → float32
        pcm_int16 = np.frombuffer(data, dtype=np.int16)
        pcm_float = pcm_int16.astype(np.float32) / 32768.0

        # Feed to VAD (runs synchronously — ONNX inference is fast)
        utterance, is_speaking = self.vad.feed(pcm_float)

        # Notify client of speaking state changes
        if is_speaking != self._last_speaking:
            self._last_speaking = is_speaking
            await _send_json(ws, {"type": "vad_state", "speaking": is_speaking})

        # If VAD produced a complete utterance, transcribe it
        if utterance is not None:
            asyncio.create_task(
                self._transcribe_and_accumulate(utterance, ws),
                name="transcribe",
            )

    async def _transcribe_and_accumulate(
        self, audio: np.ndarray, ws: WebSocket
    ) -> None:
        """Transcribe utterance and append to pending_segments."""
        from voice_bridge.stt import transcribe

        loop = asyncio.get_event_loop()

        try:
            result = await loop.run_in_executor(
                _executor,
                lambda: transcribe(audio, model=_whisper_model),
            )
        except Exception as exc:
            _log(f"Transcription error: {exc}")
            return

        # Discard non-speech frames
        if not result.text or result.no_speech_prob > 0.6:
            _log(
                f"Discarding noise segment "
                f"(no_speech_prob={result.no_speech_prob:.2f})"
            )
            return

        text = result.text
        _log(f"Segment: {text!r} (no_speech_prob={result.no_speech_prob:.2f})")

        self.pending_segments.append(text)

        # Send partial transcript for this individual segment
        await _send_json(ws, {"type": "partial_transcript", "text": text})

        # (Re)start the continuation deadline
        await self._reset_continuation_timer(ws)

    async def _reset_continuation_timer(self, ws: WebSocket) -> None:
        """Cancel any existing deadline task and start a fresh 1.5-second one."""
        if self._continuation_task and not self._continuation_task.done():
            self._continuation_task.cancel()
        self._continuation_task = asyncio.create_task(
            self._continuation_deadline_task(ws), name="continuation-deadline"
        )

    async def _continuation_deadline_task(self, ws: WebSocket) -> None:
        """Wait 1.5 seconds then flush accumulated segments as a final transcript."""
        try:
            await asyncio.sleep(1.5)
            await self._flush_pending_segments(ws)
        except asyncio.CancelledError:
            pass

    async def _flush_pending_segments(self, ws: WebSocket) -> None:
        """Join pending segments and send a final transcript message."""
        if not self.pending_segments:
            return

        text = " ".join(self.pending_segments).strip()
        self.pending_segments = []
        self._continuation_task = None

        if not text:
            return

        _log(f"Final transcript: {text!r}")
        await _send_json(
            ws,
            {"type": "transcript", "text": text, "no_speech_prob": 0.0},
        )

    async def finalize_stt(self, ws: WebSocket) -> None:
        """Force-finish any in-progress utterance and emit the final transcript."""
        if self._continuation_task and not self._continuation_task.done():
            self._continuation_task.cancel()
        self._continuation_task = None

        utterance = self.vad.finalize()
        if utterance is not None:
            await self._transcribe_and_accumulate(utterance, ws)

        await self._flush_pending_segments(ws)

    def reset_vad(self) -> None:
        """Reset VAD and clear pending segments; cancel continuation timer."""
        self.vad.reset()
        self.pending_segments = []
        if self._continuation_task and not self._continuation_task.done():
            self._continuation_task.cancel()
        self._continuation_task = None
        self._last_speaking = False
        _log("VAD reset")

    # ------------------------------------------------------------------
    # TTS
    # ------------------------------------------------------------------

    def enqueue_tts(self, text: str, turn_id: str, gen: int) -> None:
        """Add a TTS synthesis request to the queue."""
        self.tts_queue.put_nowait((text, turn_id, gen))

    def stop_tts(self) -> None:
        """Interrupt active synthesis and drain the queue."""
        if _tts_engine is not None:
            _tts_engine.stop()
        self.tts_stop_event.set()
        # Drain the queue
        while not self.tts_queue.empty():
            try:
                self.tts_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        _log("TTS stopped and queue flushed")

    def flush_tts(self, min_gen: int) -> None:
        """Discard queued TTS requests with gen < min_gen."""
        self.tts_min_gen = max(self.tts_min_gen, min_gen)
        _log(f"TTS flush: min_gen={self.tts_min_gen}")

    async def _tts_worker(self, ws: WebSocket) -> None:
        """Drain tts_queue and stream synthesized audio to the client."""
        while True:
            try:
                text, turn_id, gen = await self.tts_queue.get()
            except asyncio.CancelledError:
                break

            # Discard stale generations
            if gen < self.tts_min_gen:
                _log(f"TTS gen {gen} discarded (min_gen={self.tts_min_gen})")
                continue

            try:
                _ensure_tts_engine()
            except Exception as exc:
                msg = f"TTS unavailable: {exc}"
                _log(msg)
                await _send_json(ws, {"type": "error", "message": msg})
                continue

            # Clear stop event for this new synthesis run
            self.tts_stop_event.clear()
            if _tts_engine is not None:
                _tts_engine.stop()  # clear any lingering stop from previous

            await self._synthesize_and_stream(ws, text, turn_id, gen)

    async def _synthesize_and_stream(
        self, ws: WebSocket, text: str, turn_id: str, gen: int
    ) -> None:
        """Synthesize text and stream Int16LE audio frames to the client."""
        _log(f"TTS synthesize: turn_id={turn_id} gen={gen} text={text[:60]!r}")

        try:
            _ensure_tts_engine()
        except Exception as exc:
            msg = f"TTS unavailable: {exc}"
            _log(msg)
            await _send_json(ws, {"type": "error", "message": msg})
            return

        loop = asyncio.get_event_loop()
        first_chunk = True

        def _run_synthesis():
            """Generate all TTS chunks in the thread pool."""
            chunks = []
            for chunk in _tts_engine.synthesize(text):
                if self.tts_stop_event.is_set() or gen < self.tts_min_gen:
                    break
                chunks.append(chunk)
            return chunks

        try:
            chunks = await loop.run_in_executor(_executor, _run_synthesis)
        except Exception as exc:
            _log(f"TTS synthesis error: {exc}")
            await _send_json(ws, {"type": "error", "message": f"TTS error: {exc}"})
            return

        if not chunks:
            _log(f"TTS gen {gen} produced no audio (stopped or empty)")
            return

        # Check if we were stopped or flushed before sending
        if self.tts_stop_event.is_set() or gen < self.tts_min_gen:
            _log(f"TTS gen {gen} discarded after synthesis")
            return

        # Send tts_start
        await _send_json(ws, {"type": "tts_start", "turn_id": turn_id, "gen": gen})

        # Stream each chunk as binary: [4-byte LE uint32 gen][int16LE PCM]
        gen_prefix = struct.pack("<I", gen)
        for chunk in chunks:
            if self.tts_stop_event.is_set() or gen < self.tts_min_gen:
                _log(f"TTS gen {gen} stream interrupted")
                break

            # Convert float32 → int16LE
            pcm_int16 = (np.clip(chunk, -1.0, 1.0) * 32767).astype(np.int16)
            frame_bytes = gen_prefix + pcm_int16.tobytes()

            try:
                await ws.send_bytes(frame_bytes)
            except Exception as exc:
                _log(f"TTS send error: {exc}")
                return

        # Send tts_end (only if not interrupted)
        if not self.tts_stop_event.is_set() and gen >= self.tts_min_gen:
            await _send_json(ws, {"type": "tts_end", "turn_id": turn_id, "gen": gen})
            _log(f"TTS gen {gen} complete")


# ---------------------------------------------------------------------------
# WebSocket helpers
# ---------------------------------------------------------------------------


async def _send_json(ws: WebSocket, payload: dict) -> None:
    """Send a JSON message; silently drop errors on disconnected sockets."""
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    token = ws.query_params.get("token", "")
    if not _auth_token or not hmac.compare_digest(token, _auth_token):
        _log("Rejected websocket connection with invalid token")
        await ws.close(code=1008)
        return

    await ws.accept()
    _log("Client connected")

    session = AudioSession()
    session.start(ws)

    # Send initial ready message
    await _send_json(ws, {"type": "ready", "version": 1})

    try:
        while True:
            # Receive either binary audio frames or JSON control messages
            try:
                message = await ws.receive()
            except WebSocketDisconnect:
                break

            msg_type = message.get("type")

            if msg_type == "websocket.disconnect":
                break

            if msg_type == "websocket.receive":
                data = message.get("bytes")
                text_data = message.get("text")

                if data is not None:
                    # Binary: raw PCM audio from microphone
                    await session.handle_audio(data, ws)

                elif text_data is not None:
                    # JSON control message
                    try:
                        msg = json.loads(text_data)
                    except json.JSONDecodeError as exc:
                        _log(f"JSON decode error: {exc}")
                        await _send_json(
                            ws, {"type": "error", "message": f"Invalid JSON: {exc}"}
                        )
                        continue

                    await _handle_control(session, msg, ws)

    except Exception as exc:
        _log(f"WebSocket error: {exc}")
    finally:
        await session.stop()
        _log("Client disconnected")


async def _handle_control(
    session: AudioSession, msg: dict, ws: WebSocket
) -> None:
    """Dispatch JSON control messages from the client."""
    msg_type = msg.get("type")

    if msg_type == "tts_synthesize":
        text = msg.get("text", "")
        turn_id = msg.get("turn_id", "")
        gen = int(msg.get("gen", 0))
        if text.strip():
            session.enqueue_tts(text, turn_id, gen)
        else:
            _log(f"tts_synthesize: empty text for gen={gen}, skipping")

    elif msg_type == "tts_stop":
        session.stop_tts()

    elif msg_type == "tts_flush":
        gen = int(msg.get("gen", 0))
        session.flush_tts(gen)

    elif msg_type == "vad_reset":
        session.reset_vad()

    elif msg_type == "stt_finalize":
        await session.finalize_stt(ws)

    else:
        _log(f"Unknown message type: {msg_type!r}")


# ---------------------------------------------------------------------------
# Startup — load models, bind socket, announce port
# ---------------------------------------------------------------------------


def _load_models() -> None:
    """Load all ML models. Raises on failure (caller handles exit)."""
    global _vad_model, _whisper_model

    from voice_bridge.audio import load_vad_model
    from voice_bridge.stt import load_model as load_whisper_model

    _log("Loading VAD model...")
    _vad_model = load_vad_model()
    _log("VAD model loaded.")

    _log("Loading Whisper model (large-v3-turbo)...")
    _whisper_model = load_whisper_model("large-v3-turbo")
    _log("Whisper model loaded.")

    _log("TTS engine will load lazily on first synthesis request.")


def _ensure_tts_engine() -> None:
    """Load the TTS engine on demand so STT can still work if TTS init fails."""
    global _tts_engine, _tts_error

    if _tts_engine is not None:
        return
    if _tts_error is not None:
        raise RuntimeError(_tts_error)

    from voice_bridge.tts import BufferedTTSEngine

    _log("Loading TTS engine...")
    try:
        _tts_engine = BufferedTTSEngine()
    except Exception as exc:
        _tts_error = str(exc)
        raise
    _log("TTS engine loaded.")


def main() -> None:
    """Entry point: load models, start server, announce port."""
    try:
        _load_models()
    except Exception as exc:
        _announce(f"VOICE_SERVICE_ERROR {exc}")
        sys.exit(1)

    # Configure uvicorn to bind to an OS-assigned port on loopback
    config = uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=0,           # OS picks the port
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)

    async def _run() -> None:
        if not config.loaded:
            config.load()
        server.lifespan = config.lifespan_class(config)

        # Start the server (sets up socket but does not block yet)
        await server.startup()

        # Retrieve actual bound port from the listening socket
        if not server.servers:
            _announce("VOICE_SERVICE_ERROR Failed to bind server socket")
            sys.exit(1)

        port = server.servers[0].sockets[0].getsockname()[1]

        # Announce readiness to stdout so the parent process can connect
        _announce(f"VOICE_SERVICE_READY port={port}")
        _log(f"Listening on ws://127.0.0.1:{port}/ws")

        # Run the server loop until shutdown
        await server.main_loop()
        await server.shutdown()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        _log("Shutting down (KeyboardInterrupt)")


if __name__ == "__main__":
    main()
