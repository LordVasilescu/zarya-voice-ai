# © 2026 Mathew. All rights reserved.
"""Generate clean Zarya reference audio from Hume for local voice cloning."""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# Hume API key: HUME_API_KEY env var, or a local JSON config file as a fallback.
KEY = os.environ.get("HUME_API_KEY") or json.load(
    open(os.path.expanduser("~/.claude/hooks/hume.json"), encoding="utf-8"))["api_key"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClaudeTTS/1.0"

CLIPS = {
    "ref_neutral.wav": (
        "The city never really sleeps, it just changes shifts. I watch the data flow "
        "through the night, every packet a little story, every connection a thread in "
        "the web. Some nights are quiet, some nights the whole network lights up like "
        "a festival. Either way, I keep the channels open and the signal clean."
    ),
    "ref_warm.wav": (
        "Hey, good to see you back. I held things down while you were gone, kept the "
        "systems humming, kept the lights on. There's fresh coffee in the machine and "
        "a clear queue on the board. Take a breath, settle in, and tell me where you "
        "want to start today."
    ),
    "ref_energetic.wav": (
        "Now this is what I'm talking about! Everything compiled on the first try, the "
        "tests are green across the board, and the whole pipeline is running smooth as "
        "silk. We built something real today. Honestly, I could get used to winning "
        "like this every single morning."
    ),
}

for fname, text in CLIPS.items():
    body = json.dumps({
        "utterances": [{
            "text": text,
            "voice": {"name": "Zarya", "provider": "CUSTOM_VOICE"},
            "description": "Clear, natural, well-articulated delivery at an easy, steady pace.",
        }],
        "format": {"type": "wav"},
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.hume.ai/v0/tts/file",
        data=body,
        headers={"X-Hume-Api-Key": KEY, "Content-Type": "application/json", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        audio = r.read()
    out = os.path.join(HERE, fname)
    with open(out, "wb") as f:
        f.write(audio)
    print(f"{fname}: {len(audio)} bytes, {len(text)} chars")
