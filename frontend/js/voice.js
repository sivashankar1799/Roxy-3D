/* ROXY :: voice I/O — Web Speech recognition, synthesis, mic analyser. */

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const speechSupport = {
  recognition: Boolean(SpeechRecognitionImpl),
  synthesis: typeof window.speechSynthesis !== 'undefined',
  mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
};

/* ── Speech recognition ─────────────────────────────────────────── */
export class SpeechListener extends EventTarget {
  constructor({ lang = 'en-US' } = {}) {
    super();
    this.lang = lang;
    this.supported = speechSupport.recognition;
    this.recognition = null;
    this.running = false;
    this.wantRunning = false;
    this.permissionDenied = false;
    this._restartTimer = 0;
    this._restartCount = 0;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _build() {
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => { this.running = true; this._restartCount = 0; this._emit('start'); };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          this._emit('final', { transcript: transcript.trim(), confidence: result[0]?.confidence ?? 0 });
        } else {
          interim += transcript;
        }
      }
      if (interim.trim()) this._emit('interim', { transcript: interim.trim() });
    };

    recognition.onerror = (event) => {
      const error = event.error;
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        this.permissionDenied = true;
        this.wantRunning = false;
        this._emit('denied', { error });
      } else if (error !== 'no-speech' && error !== 'aborted') {
        this._emit('error', { error });
      }
    };

    recognition.onend = () => {
      this.running = false;
      this._emit('end');
      if (this.wantRunning && !this.permissionDenied) this._scheduleRestart();
    };

    return recognition;
  }

  _scheduleRestart() {
    clearTimeout(this._restartTimer);
    this._restartCount += 1;
    if (this._restartCount > 40) {                 // guard against a hot restart loop
      this.wantRunning = false;
      this._emit('error', { error: 'restart-loop' });
      return;
    }
    const delay = Math.min(3000, 250 * this._restartCount);
    this._restartTimer = setTimeout(() => {
      if (!this.wantRunning || this.running) return;
      try { this.recognition?.start(); } catch { /* already starting */ }
    }, delay);
  }

  start() {
    if (!this.supported) { this._emit('unsupported'); return false; }
    this.wantRunning = true;
    this.permissionDenied = false;
    if (!this.recognition) this.recognition = this._build();
    if (this.running) return true;
    try { this.recognition.start(); return true; }
    catch { return true; }                          // InvalidStateError ⇒ already running
  }

  stop() {
    this.wantRunning = false;
    clearTimeout(this._restartTimer);
    this._restartCount = 0;
    try { this.recognition?.stop(); } catch { /* ignore */ }
  }

  /** Briefly suspend recognition so Roxy's own voice isn't transcribed. */
  pause() { if (this.running) { try { this.recognition?.abort(); } catch { /* ignore */ } } }

  dispose() {
    this.stop();
    if (this.recognition) {
      this.recognition.onstart = this.recognition.onresult = null;
      this.recognition.onerror = this.recognition.onend = null;
      try { this.recognition.abort(); } catch { /* ignore */ }
      this.recognition = null;
    }
  }
}

/* ── Speech synthesis ───────────────────────────────────────────── */
export class Speaker extends EventTarget {
  constructor() {
    super();
    this.supported = speechSupport.synthesis;
    this.voices = [];
    this.voiceURI = '';
    this.rate = 1;
    this.pitch = 1.05;
    this.volume = 1;
    this.speaking = false;
    this._utterance = null;
    this._keepAlive = 0;
    this._audio = null;
    this._audioUrl = '';
    if (this.supported) {
      this._loadVoices();
      this._onVoices = () => this._loadVoices();
      window.speechSynthesis.addEventListener('voiceschanged', this._onVoices);
    }
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _loadVoices() {
    this.voices = window.speechSynthesis.getVoices() || [];
    if (this.voices.length) this._emit('voices', { voices: this.voices });
  }

  /** Best-effort pick of a pleasant female English voice. */
  pickDefaultVoice() {
    if (!this.voices.length) return '';
    const preferred = [/samantha/i, /zira/i, /google uk english female/i, /google us english/i,
      /aria/i, /jenny/i, /female/i, /^en-/i];
    for (const pattern of preferred) {
      const hit = this.voices.find((v) => pattern.test(v.name) || pattern.test(v.lang));
      if (hit) return hit.voiceURI;
    }
    return this.voices[0].voiceURI;
  }

  /** Speak text with the browser engine. Resolves when playback finishes. */
  speak(text) {
    const clean = String(text || '').trim();
    if (!clean) return Promise.resolve(false);
    if (!this.supported) { this._emit('unsupported'); return Promise.resolve(false); }

    this.cancel();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this.speaking = false;
        clearInterval(this._keepAlive);
        this._utterance = null;
        this._emit('end', { ok });
        resolve(ok);
      };

      const utterance = new SpeechSynthesisUtterance(clean.slice(0, 4000));
      const voice = this.voices.find((v) => v.voiceURI === this.voiceURI);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
      utterance.rate = this.rate;
      utterance.pitch = this.pitch;
      utterance.volume = this.volume;

      utterance.onstart = () => { this.speaking = true; this._emit('start', { text: clean }); };
      utterance.onend = () => finish(true);
      utterance.onerror = (event) => {
        if (event.error === 'interrupted' || event.error === 'canceled') { finish(false); return; }
        this._emit('error', { error: event.error });
        finish(false);
      };
      utterance.onboundary = (event) => this._emit('boundary', { charIndex: event.charIndex });

      this._utterance = utterance;
      try { window.speechSynthesis.speak(utterance); }
      catch { finish(false); return; }

      // Chrome silently stops long utterances; nudge it every 8 s.
      clearInterval(this._keepAlive);
      this._keepAlive = setInterval(() => {
        if (!this.speaking) { clearInterval(this._keepAlive); return; }
        try { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } catch { /* ignore */ }
      }, 8000);

      // Absolute safety net so the app can never wedge in SPEAKING.
      setTimeout(() => finish(true), Math.min(90000, 2500 + clean.length * 90));
    });
  }

  /** Play server-generated audio (base64) instead of the browser voice. */
  playAudio(base64, mime = 'audio/mpeg') {
    return new Promise((resolve) => {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: mime });
        this._revokeAudio();
        this._audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(this._audioUrl);
        audio.volume = this.volume;
        audio.playbackRate = this.rate;
        this._audio = audio;
        this.speaking = true;
        this._emit('start', { text: '' });

        const done = (ok) => {
          this.speaking = false;
          this._revokeAudio();
          this._emit('end', { ok });
          resolve(ok);
        };
        audio.onended = () => done(true);
        audio.onerror = () => done(false);
        audio.play().catch(() => done(false));
      } catch { resolve(false); }
    });
  }

  _revokeAudio() {
    if (this._audio) { try { this._audio.pause(); } catch { /* ignore */ } this._audio = null; }
    if (this._audioUrl) { URL.revokeObjectURL(this._audioUrl); this._audioUrl = ''; }
  }

  cancel() {
    clearInterval(this._keepAlive);
    this._revokeAudio();
    if (this.supported) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
    this.speaking = false;
  }

  dispose() {
    this.cancel();
    if (this.supported && this._onVoices) {
      window.speechSynthesis.removeEventListener('voiceschanged', this._onVoices);
    }
  }
}

/* ── Microphone analyser (drives the visualizer + lip-sync) ─────── */
export class AudioAnalyser {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.data = null;
    this.active = false;
  }

  async start() {
    if (this.active) return true;
    if (!speechSupport.mediaDevices) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.context = new Ctx();
      if (this.context.state === 'suspended') await this.context.resume();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.72;
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      this.active = true;
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  levels() {
    if (!this.active || !this.analyser) return null;
    this.analyser.getByteFrequencyData(this.data);
    return this.data;
  }

  amplitude() {
    const data = this.levels();
    if (!data) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i];
    return sum / (data.length * 255);
  }

  stop() {
    try { this.source?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
    this.context = null; this.analyser = null; this.stream = null;
    this.source = null; this.data = null; this.active = false;
  }
}
