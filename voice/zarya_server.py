# © 2026 Mathew. All rights reserved.
"""Local Zarya voice server: Chatterbox TTS cloned from Hume reference audio,
plus Whisper speech-to-text for the Discord voice link.

Loads models once (GPU-resident), then serves:
  GET  /health        -> {"ok": true}
  POST /tts {"text"}  -> audio/wav bytes
  POST /stt <wav>     -> {"text": transcript}   (Whisper loads lazily on first call)

The Claude Code Stop hook tries this server first; if it's down it falls back
to Hume, then edge-tts. The ZaryaBot Discord bot uses /stt and /tts.
Run via start_server.bat (uses the local venv).
"""
import io
import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, os.environ.get("ZARYA_REF", "ref_neutral.wav"))
PORT = int(os.environ.get("ZARYA_PORT", "8765"))
EXAGGERATION = float(os.environ.get("ZARYA_EXAGGERATION", "0.5"))
CFG_WEIGHT = float(os.environ.get("ZARYA_CFG", "0.5"))
CHUNK_CHARS = 280  # chatterbox quality degrades on very long single generations
WHISPER_SIZE = os.environ.get("ZARYA_WHISPER", "small.en")

print("Loading Chatterbox model (first run downloads ~2 GB)...")
import torch
from chatterbox.tts import ChatterboxTTS

model = ChatterboxTTS.from_pretrained(device="cuda" if torch.cuda.is_available() else "cpu")
lock = threading.Lock()
print(f"Model ready on {'cuda' if torch.cuda.is_available() else 'cpu'}, sr={model.sr}, ref={os.path.basename(REF)}")

whisper_model = None
whisper_lock = threading.Lock()


def get_whisper():
    global whisper_model
    with whisper_lock:
        if whisper_model is None:
            import whisper
            print(f"Loading Whisper {WHISPER_SIZE}...")
            whisper_model = whisper.load_model(
                WHISPER_SIZE, device="cuda" if torch.cuda.is_available() else "cpu")
            print("Whisper ready")
        return whisper_model


def chunks(text):
    parts, buf = [], ""
    for sent in re.split(r"(?<=[.!?])\s+", text.strip()):
        if len(buf) + len(sent) + 1 > CHUNK_CHARS and buf:
            parts.append(buf)
            buf = sent
        else:
            buf = f"{buf} {sent}".strip()
    if buf:
        parts.append(buf)
    return parts or [text]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"ok": true}')
        else:
            self._send(404, b'{"error": "not found"}')

    def do_POST(self):
        if self.path == "/stt":
            self._stt()
            return
        if self.path != "/tts":
            self._send(404, b'{"error": "not found"}')
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
            text = payload.get("text", "").strip()
            if not text:
                self._send(400, b'{"error": "no text"}')
                return
            # Optional per-request overrides (used for voice auditioning/tuning).
            ref = REF
            if payload.get("ref"):
                cand = os.path.join(HERE, os.path.basename(payload["ref"]))
                if os.path.exists(cand):
                    ref = cand
            exaggeration = float(payload.get("exaggeration", EXAGGERATION))
            cfg = float(payload.get("cfg", CFG_WEIGHT))
            with lock:  # one generation at a time; the GPU is shared
                wavs = [
                    model.generate(c, audio_prompt_path=ref,
                                   exaggeration=exaggeration, cfg_weight=cfg)
                    for c in chunks(text)
                ]
            wav = torch.cat(wavs, dim=-1).cpu()
            # torchaudio 2.11 delegates save() to torchcodec; write PCM ourselves.
            pcm = (wav.squeeze(0).clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(model.sr)
                w.writeframes(pcm)
            self._send(200, buf.getvalue(), "audio/wav")
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}).encode())

    def _stt(self):
        import tempfile
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not length:
                self._send(400, b'{"error": "no audio"}')
                return
            audio = self.rfile.read(length)
            wm = get_whisper()
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            try:
                tmp.write(audio)
                tmp.close()
                with lock:  # share the GPU politely with TTS generations
                    result = wm.transcribe(tmp.name, fp16=torch.cuda.is_available())
            finally:
                os.unlink(tmp.name)
            text = (result.get("text") or "").strip()
            self._send(200, json.dumps({"text": text}).encode())
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}).encode())


if __name__ == "__main__":
    print(f"Zarya voice server listening on http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
