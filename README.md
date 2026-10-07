# ROXY — Futuristic 3D AI Assistant

A browser-native AI companion: a VRM anime character rendered in Three.js that
listens for a wake word, thinks via an LLM behind a Python backend, speaks back,
and animates its expression, gestures and lip movement in real time.

```
Browser ──speech──▶ FastAPI ──HTTPS──▶ AI provider
   ▲                   │
   └── WebSocket ◀─────┘  (text + emotion + animation, then TTS + 3D animation)
```

---

## Features

**3D character.** VRM 0.x/1.0 loading via `@pixiv/three-vrm`, idle breathing,
randomised blinking, look-at tracking, head rotation, wave/greeting/thinking/
talking gestures, viseme-based lip-sync, and emotion-mapped blendshapes. When no
VRM file is present, a procedural holographic avatar takes over so nothing breaks.

**Voice.** Always-listening wake-word pipeline (`Hey Roxy` by default, fully
configurable with homophone tolerance), Web Speech recognition with automatic
restart and loop protection, browser speech synthesis with voice/rate/pitch/volume
control, optional server-side TTS, and push-to-talk.

**Intelligence.** Pluggable provider layer (OpenAI, Gemini, any OpenAI-compatible
endpoint, plus an offline mock). Structured JSON responses carry `text`, `emotion`,
`animation` and an optional memory fact — with graceful degradation to plain text.

**Memory.** SQLite-backed conversation history plus long-term facts, with
"Remember that…", "Forget that…" and "What do you remember about me?" handled
deterministically, relevance-scored context injection, and a memory manager UI.

**Interface.** Cyberpunk glassmorphism, live audio visualiser, neon status
indicators, chat with timestamps, character control panel, full settings panel,
event log, and a responsive layout from ultrawide down to phones.

---

## Quick start

```bash
git clone <your-repo> roxy && cd roxy

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r backend/requirements.txt

cp backend/.env.example backend/.env
# for Gemini, set AI_PROVIDER=gemini and GEMINI_API_KEY=<your-key>

python run.py                       # or: uvicorn backend.main:app --reload
```

Open **http://localhost:8000** and allow microphone access when prompted.

> ROXY starts even with **no API key** — it runs in offline demo mode with a
> scripted local brain so you can verify the 3D, voice and UI layers first.

### Add a character

Place a VRM file at `frontend/assets/models/roxy.vrm`. Free models and export
tools are listed in `frontend/assets/models/README.md` (VRoid Studio is the usual
starting point). No file? The fallback avatar keeps everything functional.

---

## Configuration

All configuration lives in `backend/.env` — **never in the browser**.

| Variable | Purpose | Default |
| --- | --- | --- |
| `AI_PROVIDER` | `openai`, `gemini`, `custom`, `mock` | `openai` |
| `AI_API_KEY` | Credential for the active provider | — |
| `AI_API_URL` | Endpoint override | provider default |
| `AI_MODEL` | Model name | `gpt-4o-mini` / `gemini-2.5-flash` |
| `AI_TEMPERATURE` / `AI_MAX_TOKENS` / `AI_TIMEOUT` | Generation controls | `0.7` / `512` / `30` |
| `HISTORY_TURNS` | Conversation turns sent as context | `12` |
| `MAX_MESSAGE_LENGTH` | Inbound message cap | `2000` |
| `RATE_LIMIT_PER_MINUTE` | Per-connection token bucket | `40` |
| `MEMORY_ENABLED` / `DB_PATH` | SQLite memory | `true` / `backend/data/roxy.sqlite3` |
| `WAKE_WORD` | Server default wake phrase | `hey roxy` |
| `TTS_PROVIDER` / `STT_PROVIDER` | `none` or `openai` | `none` |
| `ALLOWED_ORIGINS` | CORS allow-list | `*` |
| `DEBUG` | Verbose logs + `/api/docs` | `false` |

Per-provider overrides (`OPENAI_API_KEY`, `GEMINI_MODEL`, `CUSTOM_API_URL`, …)
take precedence over the generic values, so several providers can be configured
simultaneously and swapped from the settings panel at runtime.

### Using a local model

```dotenv
AI_PROVIDER=custom
CUSTOM_API_URL=http://localhost:11434/v1/chat/completions   # Ollama
CUSTOM_MODEL=llama3
CUSTOM_RESPONSE_PATH=choices.0.message.content
```

`CUSTOM_RESPONSE_PATH` is a dotted path into the JSON response, so bespoke
gateways work without code changes.

---

## Architecture

```
backend/
  main.py              FastAPI app: REST, WebSocket router, static mount, lifespan
  config.py            Env parsing, provider resolution, placeholder detection
  ai/
    assistant.py       Orchestration: memory → prompt → provider → parse
    prompts.py         Personality + JSON output contract
    response_parser.py Robust JSON extraction, sanitisation, safe fallbacks
    providers/         base.py (contract + error taxonomy) + 4 implementations
  voice/               Wake-word config, optional server TTS/STT interfaces
  memory/              Async SQLite wrapper + fact extraction and retrieval
  websocket/manager.py Connection registry, Pydantic validation, rate limiting
  utils/logger.py      Structured logging with secret redaction

frontend/js/
  app.js                  State machine + module wiring
  three-scene.js          Renderer, camera, lights, orbit, disposal, FPS
  character.js            VRM loading, bones, expressions, procedural fallback
  animation-controller.js Priority-based animation arbitration and state mapping
  voice.js                Recognition, synthesis, mic analyser
  wake-word.js            Phrase matching with homophone expansion
  websocket.js            Reconnect with jittered backoff, heartbeat, queueing
  controls.js             Settings persistence, panels, modals, character panel
  ui.js                   DOM rendering, chat, toasts, visualiser, stats
```

### Message protocol

Frontend → backend:

```json
{ "type": "user_message", "message": "Hello Roxy" }
```

Backend → frontend:

```json
{ "type": "assistant_response", "message": "Hello! How are you?",
  "emotion": "happy", "animation": "happy" }
{ "type": "status",    "status": "processing" }
{ "type": "character", "animation": "wave" }
{ "type": "error",     "code": "timeout", "message": "…" }
```

Other client types: `hello`, `ping`, `get_memories`, `delete_memory`,
`clear_memories`, `get_history`, `clear_history`, `set_provider`, `tts`.

### Animation state mapping

| App state | Animation | Expression | Stage mood |
| --- | --- | --- | --- |
| IDLE | idle + breathing + blink | neutral | blue |
| LISTENING | attentive lean | neutral | cyan |
| ROXY AWAKE | attentive + greeting | happy | bright cyan |
| PROCESSING | thinking pose | thinking | violet |
| SPEAKING | talking + lip-sync | from AI response | green |
| ERROR | idle | sad | red |

The controller enforces priorities so a wave never fights an idle loop, manual
picks from the control panel hold for a couple of seconds before state-driven
animation resumes, and every transition is smoothed rather than snapped.

---

## Security

- API keys live only in `backend/.env`, are never sent to the browser, and are
  redacted from logs by a logging filter.
- Every WebSocket frame is size-capped and validated by a Pydantic model with a
  closed `type` enum; unknown or malformed frames are dropped, not executed.
- Per-connection token-bucket rate limiting and a single-in-flight guard.
- AI output is stripped of HTML tags, control characters and markdown before it
  reaches the DOM, and all message rendering uses `textContent` — AI responses can
  never execute script.
- Memory keys are slugified and values length-capped; the model is instructed not
  to store secrets.
- The VRM loader only parses glTF geometry and materials; no model-supplied code path exists.
- `localStorage` holds UI preferences only, and is re-validated against a known
  schema on read.

For deployment, set `ALLOWED_ORIGINS` to your real origin, serve over HTTPS
(browsers require a secure context for microphone access), and put the app behind
your own authentication if it's publicly reachable.

---

## Troubleshooting

**"Speech recognition is not supported in this browser."** The Web Speech API is
available in Chrome, Edge and Safari; Firefox does not ship it. Typing still works.

**Microphone blocked.** Voice requires `https://` or `http://localhost`. Re-grant
permission via the padlock icon, then toggle Listening off and on.

**Wake word never fires.** Speech engines often hear "Rocky" or "Roxie" — those
are already accepted. Speak the full phrase, check the mic level in the visualiser,
or disable wake-word detection in Settings to send every utterance directly.

**Avatar shows the holographic core.** The VRM file is missing, misnamed, or not a
valid VRM. Confirm `frontend/assets/models/roxy.vrm` exists and check the browser
console for the loader error.

**"Roxy is unable to connect to the AI service."** Check `AI_API_KEY`, network
access to the provider, and the server log — the error taxonomy distinguishes
auth failures, timeouts, rate limits and malformed responses.

**Roxy hears herself.** Recognition is paused during playback automatically; if
your speakers are loud, use headphones or lower the output volume in Settings.

**Low FPS.** Reduce animation intensity, disable background particles, or enable
reduced motion in Settings. The FPS counter lives in the right panel.

---

## Extending

**New AI provider** — subclass `AIProvider`, implement `complete()`, register it
in `backend/ai/providers/__init__.py`. Nothing in the frontend changes.

**Real wake-word engine** — implement `WakeWordDetector.detect()` in
`backend/voice/wake_word.py` (or the matching frontend class) with Porcupine or
openWakeWord. The interface and the UI stay identical.

**New animation** — add an entry to `ANIMATIONS` in `animation-controller.js` and
a case in `_applyVRMGesture()` / `_updateFallback()` in `character.js`, then add it
to the enum in `backend/ai/prompts.py` so the model can request it.

---

## Licence

MIT for this application code. VRM models, voices and AI services carry their own
licences — review them before distributing anything built on top of this.
