/* ROXY :: application orchestrator.
   Owns the state machine and wires every module together. */

   import { UI } from './ui.js';
   import { RoxySocket } from './websocket.js';
   import { RoxyScene } from './three-scene.js';
   import { RoxyCharacter } from './character.js';
   import { AnimationController } from './animation-controller.js';
   import { Settings, ControlPanel } from './controls.js';
   import { WakeWordDetector } from './wake-word.js';
   import { SpeechListener, Speaker, AudioAnalyser, speechSupport } from './voice.js';
   
   const MODEL_URL = '/assets/models/roxy.vrm';
   const COMMAND_TIMEOUT_MS = 9000;
   
   class RoxyApp {
     constructor() {
       this.ui = new UI();
       this.settings = new Settings();
       this.state = 'offline';
       this.listeningEnabled = false;
       this.awake = false;
       this.maxMessageLength = 2000;
       this.serverTTS = false;
       this.pendingAudio = null;
       this._commandTimer = 0;
       this._interimTimer = 0;
       this._destroyed = false;
       this._bgParticles = null;
     }
   
     async start() {
       this._installGlobalErrorHandlers();
       this._startBackgroundParticles();
   
       // 3D first so the stage never sits empty.
       const canvas = document.getElementById('roxy-canvas');
       this.scene = new RoxyScene(canvas);
       this.scene.onContextLost = () => {
         this.ui.toast('Graphics context lost. Attempting to recover…', 'warn');
         this.ui.setStat('avatar', 'context lost', 'bad');
       };
       this.scene.onContextRestored = () => this.ui.setStat('avatar', 'restored', 'good');
   
       this.character = new RoxyCharacter(this.scene);
       this.animation = new AnimationController(this.character, this.scene);
       this.scene.start();
   
       this.ui.setLoader('Booting render pipeline…', 15);
   
       this.controls = new ControlPanel({
         settings: this.settings,
         animationController: this.animation,
         character: this.character,
         scene: this.scene,
         ui: this.ui,
         onWakeWordChange: (phrase) => {
           this.wakeWord.setPhrase(phrase);
           this.ui.setWakeWordLabel(phrase);
           this.ui.toast(`Wake word set to “${phrase}”.`, 'ok');
         },
         onProviderChange: (provider) => this.socket.send({ type: 'set_provider', provider }),
         onTestVoice: () => this.speak('Voice check complete. I sound like this.', 'happy'),
       });
       this.controls.onMemoryOpen = () => this._refreshMemories();
       this._applySettingsFromStore();
       this.settings.addEventListener('change', ({ detail }) => this._onSettingChange(detail));
   
       this.animation.addEventListener('animation', (event) => {
         this.ui.setStat('animation', event.detail.animation);
         this.controls.syncIndicators({ animation: event.detail.animation });
       });
       this.animation.addEventListener('emotion', (event) => {
         this.ui.setStat('emotion', event.detail.emotion);
         this.controls.syncIndicators({ emotion: event.detail.emotion });
       });
   
       this._setupVoice();
       this._setupSocket();
       this._setupChrome();
   
       this.setState('idle');
       await this._loadCharacter();
       this._startStatsLoop();
     }
   
     /* ── character loading ──────────────────────────────────────── */
     async _loadCharacter() {
       this.ui.setLoader('Loading avatar…', 35);
       const result = await this.character.load(MODEL_URL, {
         onProgress: (percent) => this.ui.setLoader(`Loading avatar… ${percent}%`, 35 + percent * 0.6),
       });
   
       if (result.ok) {
         this.ui.setStat('avatar', result.name, 'good');
         this.ui.log(`VRM loaded: ${result.name}`, 'ok');
         this.ui.hideModelError();
         const zoom = document.getElementById('slider-zoom');
         if (zoom) {
           const value = Math.round(this.scene.getZoom() * 100);
           zoom.value = String(value);
           document.getElementById('slider-zoom-value').textContent = `${value}%`;
           try { localStorage.setItem('roxy.zoom', String(value)); } catch (_) {}
         }
       } else {
         this.ui.setStat('avatar', 'fallback core', 'warn');
         this.ui.showModelError(
           `VRM could not be rendered. ROXY switched to the holographic core. Error: ${result.error}`,
         );
         this.ui.log(`VRM load failed — using procedural avatar: ${result.error}`, 'warn');
       }
   
       this.ui.setLoader('Ready', 100);
       this.ui.hideLoader();
       this.animation.setState(this.state);
       // Keep the avatar in a stable, centered idle pose after loading.
       // Reactions can still be triggered by user actions/chat events.
     }
   
     /* ── voice ──────────────────────────────────────────────────── */
     _setupVoice() {
       this.wakeWord = new WakeWordDetector({
         phrase: this.settings.get('wakeWord'),
         enabled: this.settings.get('wakeWordEnabled'),
       });
       this.ui.setWakeWordLabel(this.settings.get('wakeWord'));
   
       this.speaker = new Speaker();
       this.analyser = new AudioAnalyser();
       this.listener = new SpeechListener();
   
       this.ui.setStat('speech', speechSupport.recognition ? 'available' : 'unsupported',
         speechSupport.recognition ? 'good' : 'warn');
   
       if (!speechSupport.recognition) {
         this.ui.toast('Speech recognition is not supported in this browser. You can still chat by typing.', 'warn', 7000);
         this.ui.log('Web Speech recognition unavailable', 'warn');
         document.getElementById('btn-mic-push').disabled = true;
       }
       if (!speechSupport.synthesis) {
         this.ui.log('Speech synthesis unavailable', 'warn');
       }
   
       const applyVoices = () => {
         this.controls.populateVoices(this.speaker.voices, this.settings.get('voiceURI'));
         const uri = this.settings.get('voiceURI') || this.speaker.pickDefaultVoice();
         this.speaker.voiceURI = uri;
         if (!this.settings.get('voiceURI') && uri) this.settings.set('voiceURI', uri);
       };
       this.speaker.addEventListener('voices', applyVoices);
       applyVoices();
   
       this.settings.addEventListener('change', ({ detail }) => {
         if (detail.key === 'voiceURI') this.speaker.voiceURI = detail.value;
         if (detail.key === 'rate') this.speaker.rate = detail.value;
         if (detail.key === 'pitch') this.speaker.pitch = detail.value;
         if (detail.key === 'volume') this.speaker.volume = detail.value;
         if (detail.key === 'wakeWordEnabled') this.wakeWord.enabled = detail.value;
       });
       this.speaker.rate = this.settings.get('rate');
       this.speaker.pitch = this.settings.get('pitch');
       this.speaker.volume = this.settings.get('volume');
   
       // Recognition events
       this.listener.addEventListener('start', () => {
         this.ui.setStat('mic', 'on', 'good');
         this.ui.setVisualizer('listening', () => this.analyser.levels());
         if (!this.awake) this.setState('listening');
       });
   
       this.listener.addEventListener('end', () => {
         if (!this.listener.wantRunning) {
           this.ui.setStat('mic', 'off', 'warn');
           this.ui.setVisualizer(null);
         }
       });
   
       this.listener.addEventListener('interim', (event) => {
         const text = event.detail.transcript;
         if (this.awake) this.ui.setCaption(text);
         else if (this.wakeWord.enabled) {
           const { detected, command } = this.wakeWord.detect(text);
           if (detected) this._wake(command);
         }
       });
   
       this.listener.addEventListener('final', (event) => {
         const transcript = event.detail.transcript;
         if (!transcript) return;
         this.ui.log(`heard: ${transcript.slice(0, 60)}`);
   
         if (!this.awake) {
           if (!this.wakeWord.enabled) { this._submit(transcript); return; }
           const { detected, command } = this.wakeWord.detect(transcript);
           if (detected) {
             if (command) this._submit(command);
             else this._wake('');
           }
           return;
         }
         this._submit(transcript);
       });
   
       this.listener.addEventListener('denied', () => {
         this.listeningEnabled = false;
         this._syncListenButton();
         this.ui.setStat('mic', 'blocked', 'bad');
         this.ui.setVisualizer(null);
         this.setState('idle');
         this.ui.toast('Microphone permission denied. Enable it in your browser settings to use voice.', 'error', 7000);
       });
   
       this.listener.addEventListener('error', (event) => {
         this.ui.log(`speech error: ${event.detail.error}`, 'warn');
         if (event.detail.error === 'restart-loop') {
           this.listeningEnabled = false;
           this._syncListenButton();
           this.ui.toast('Voice input stopped unexpectedly. Try turning listening back on.', 'warn');
         }
       });
   
       this.listener.addEventListener('unsupported', () => {
         this.ui.toast('Speech recognition is not supported in this browser.', 'error');
       });
   
       // Speaking drives the mouth from real audio when we can measure it.
       this.speaker.addEventListener('start', () => {
         this.ui.setVisualizer('speaking');
         this.setState('speaking');
       });
       this.speaker.addEventListener('end', () => this._afterSpeaking());
     }
   
     _wake(command = '') {
       this.awake = true;
       this.setState('awake');
       this.animation.react('greeting', 'happy');
       this.ui.setCaption('Listening…', 2500);
       this.ui.log('wake word detected', 'ok');
   
       clearTimeout(this._commandTimer);
       if (command) { this._submit(command); return; }
       this._commandTimer = setTimeout(() => {
         if (!this.awake) return;
         this.awake = false;
         this.ui.setCaption('');
         this.setState(this.listeningEnabled ? 'listening' : 'idle');
         this.ui.log('wake timeout — back to standby');
       }, COMMAND_TIMEOUT_MS);
     }
   
     async toggleListening(force) {
       const next = typeof force === 'boolean' ? force : !this.listeningEnabled;
   
       if (next) {
         if (!speechSupport.recognition) {
           this.ui.toast('Speech recognition is not supported in this browser.', 'error');
           return;
         }
         const gotAudio = await this.analyser.start();
         if (!gotAudio) this.ui.log('mic analyser unavailable (visualizer will simulate)', 'warn');
         const started = this.listener.start();
         if (!started) return;
         this.listeningEnabled = true;
         this.setState('listening');
         this.ui.toast('Listening. Say the wake word when you need me.', 'ok', 3000);
       } else {
         this.listeningEnabled = false;
         this.awake = false;
         clearTimeout(this._commandTimer);
         this.listener.stop();
         this.analyser.stop();
         this.ui.setVisualizer(null);
         this.ui.setStat('mic', 'off', 'warn');
         this.ui.setCaption('');
         this.setState('idle');
       }
       this._syncListenButton();
     }
   
     _syncListenButton() {
       const button = document.getElementById('btn-listen');
       const label = document.getElementById('btn-listen-label');
       button.setAttribute('aria-pressed', String(this.listeningEnabled));
       label.textContent = this.listeningEnabled ? 'Listening ON' : 'Listening OFF';
     }
   
     /* ── conversation ───────────────────────────────────────────── */
     _submit(text) {
       const clean = String(text || '').trim().slice(0, this.maxMessageLength);
       if (!clean) return;
   
       clearTimeout(this._commandTimer);
       this.awake = false;
       this.ui.setCaption('');
       this.ui.addMessage({ role: 'user', text: clean });
   
       if (!this.socket.connected) {
         this.ui.addMessage({ role: 'system', text: 'No connection to the ROXY server. Your message will send once the link is restored.' });
       }
       this.socket.sendUserMessage(clean);
       this.ui.showTyping();
       this.setState('processing');
     }
   
     async speak(text, emotion = 'neutral') {
       if (!this.settings.get('autoSpeak')) { this._afterSpeaking(); return; }
   
       // Don't transcribe our own voice.
       const wasListening = this.listener.wantRunning;
       if (wasListening) this.listener.pause();
       this._resumeListeningAfterSpeech = wasListening;
   
       this.animation.setState('speaking', { emotion });
   
       let ok = false;
       if (this.pendingAudio) {
         const { data, format } = this.pendingAudio;
         this.pendingAudio = null;
         ok = await this.speaker.playAudio(data, format);
       }
       if (!ok) ok = await this.speaker.speak(text);
       if (!ok && !this.speaker.supported) {
         this.ui.toast('Text-to-speech is unavailable in this browser.', 'warn');
         this._afterSpeaking();
       }
     }
   
     _afterSpeaking() {
       this.ui.setVisualizer(this.listeningEnabled ? 'listening' : null,
         this.listeningEnabled ? () => this.analyser.levels() : null);
   
       if (this._resumeListeningAfterSpeech && this.settings.get('continuousListening')) {
         this._resumeListeningAfterSpeech = false;
         setTimeout(() => { if (this.listeningEnabled) this.listener.start(); }, 320);
         this.setState('listening');
       } else {
         this.setState(this.listeningEnabled ? 'listening' : 'idle');
       }
     }
   
     setState(state) {
       if (this.state === state) return;
       this.state = state;
       this.ui.setStatus(state);
       this.animation.setState(state);
     }
   
     /* ── socket ─────────────────────────────────────────────────── */
     _setupSocket() {
       this.socket = new RoxySocket();
   
       this.socket.addEventListener('connecting', () => this.ui.setLink('connecting', 'linking…'));
       this.socket.addEventListener('reconnecting', (event) => {
         this.ui.setLink('connecting', `retry ${event.detail.attempt}`);
         this.ui.log(`reconnecting in ${Math.round(event.detail.delay / 100) / 10}s`, 'warn');
       });
   
       this.socket.addEventListener('open', () => {
         this.ui.setLink('online', 'online');
         this.ui.log('connected to ROXY server', 'ok');
         if (this.state === 'offline') this.setState('idle');
         this.socket.send({ type: 'get_memories' });
         this.socket.send({ type: 'get_history' });
       });
   
       this.socket.addEventListener('close', () => {
         this.ui.setLink('offline', 'offline');
         this.ui.clearTyping();
         this.ui.log('server link lost', 'warn');
       });
   
       this.socket.addEventListener('gave-up', () => {
         this.ui.setStatus('error');
         this.ui.toast('Roxy is unable to connect to the server. Refresh once the backend is running.', 'error', 9000);
       });
   
       this.socket.addEventListener('welcome', (event) => this._applyServerConfig(event.detail));
       this.socket.addEventListener('provider', (event) => {
         if (event.detail.ai) this._applyAIStatus(event.detail.ai);
       });
   
       this.socket.addEventListener('status', (event) => {
         const status = event.detail.status;
         if (status === 'processing') { this.setState('processing'); this.ui.showTyping(); }
       });
   
       this.socket.addEventListener('character', (event) => {
         this.animation.react(event.detail.animation, event.detail.emotion);
       });
   
       this.socket.addEventListener('audio', (event) => {
         this.pendingAudio = { data: event.detail.data, format: event.detail.format };
       });
   
       this.socket.addEventListener('assistant_response', (event) => {
         const { message, emotion = 'neutral', animation = 'talking', ok = true, meta } = event.detail;
         this.ui.clearTyping();
         this.ui.addMessage({ role: 'roxy', text: message, emotion, error: !ok });
         this.ui.setCaption(message, 9000);
         if (meta?.latency_ms) this.ui.setStat('latency', `${meta.latency_ms} ms`);
         this.animation.setState('speaking', { emotion });
         this.animation.play(animation, { force: true });
         this.speak(message, emotion);
       });
   
       this.socket.addEventListener('error', (event) => {
         const detail = event.detail || {};
         this.ui.clearTyping();
         this.ui.addMessage({ role: 'system', text: detail.message || 'Something went wrong.', error: true });
         this.ui.log(`server error: ${detail.code}`, 'error');
         if (detail.code !== 'rate_limited' && detail.code !== 'busy') {
           this.setState('error');
           setTimeout(() => this.setState(this.listeningEnabled ? 'listening' : 'idle'), 2600);
         } else {
           this.setState(this.listeningEnabled ? 'listening' : 'idle');
         }
       });
   
       this.socket.addEventListener('memories', (event) => {
         this.controls.renderMemories(event.detail.items || [], (key) => {
           this.socket.send({ type: 'delete_memory', key });
         });
       });
   
       this.socket.addEventListener('history', (event) => {
         const items = event.detail.items || [];
         if (!items.length) return;
         this.ui.clearChat();
         items.slice(-40).forEach((item) => {
           this.ui.addMessage({ role: item.role === 'user' ? 'user' : 'roxy', text: item.content });
         });
       });
   
       this.socket.addEventListener('protocol-error', () => this.ui.log('discarded malformed frame', 'warn'));
   
       this.socket.connect();
       this._loadPublicConfig();
     }
   
     _applySettingsFromStore() {
       this.character?.setIntensity(this.settings.get('intensity'));
       this.character?.setReducedMotion(this.settings.get('reducedMotion'));
       this.ui.setReducedMotion(this.settings.get('reducedMotion'));
       this.ui.debug = this.settings.get('debug');
       this._applyTheme(this.settings.get('theme'));
       const auto = document.getElementById('toggle-autorotate');
       const follow = document.getElementById('toggle-follow');
       if (auto) this.scene.setAutoRotate(auto.checked);
       if (follow) this.character.setLookAtUser(follow.checked);
     }

     _applyTheme(theme) {
       const value = ['dark','light','system'].includes(theme) ? theme : 'dark';
       const rootEl = document.documentElement;
       if (value === 'system') {
         rootEl.dataset.theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
         if (!this._themeMediaQuery) {
           this._themeMediaQuery = window.matchMedia('(prefers-color-scheme: light)');
           this._themeMediaQuery.addEventListener?.('change', () => {
             if (this.settings.get('theme') === 'system') this._applyTheme('system');
           });
         }
       } else {
         rootEl.dataset.theme = value;
       }
     }

     _onSettingChange(detail = {}) {
       const key = detail.key;
       const value = detail.value;
       if (key === 'wakeWord') {
         this.wakeWord?.setPhrase(value);
         this.ui.setWakeWordLabel(value);
       }
       if (key === 'wakeWordEnabled') this.wakeWord && (this.wakeWord.enabled = Boolean(value));
       if (key === 'continuousListening' || key === 'autoSpeak') {}
       if (key === 'intensity') this.character?.setIntensity(value);
       if (key === 'reducedMotion') { this.character?.setReducedMotion(value); this.ui.setReducedMotion(value); }
       if (key === 'debug') this.ui.debug = Boolean(value);
       if (key === 'theme') this._applyTheme(value);
       if (detail.reset) this._applySettingsFromStore();
     }

     async _refreshMemories() {
       try {
         if (this.socket?.connected) {
           this.socket.send({ type: 'get_memories' });
           return;
         }
         const response = await fetch('/api/memories', { cache: 'no-store' });
         if (!response.ok) throw new Error(`HTTP ${response.status}`);
         const data = await response.json();
         this.controls.renderMemories(data.items || [], (key) => this._deleteMemory(key));
       } catch (error) {
         this.ui.toast(`Memory unavailable: ${error.message}`, 'warn');
       }
     }

     async _deleteMemory(key) {
       if (this.socket?.connected) {
         this.socket.send({ type: 'delete_memory', key });
         return;
       }
     }

     async _loadPublicConfig() {
       try {
         const response = await fetch('/api/config', { cache: 'no-store' });
         if (!response.ok) return;
         this._applyServerConfig(await response.json());
       } catch { /* the WebSocket welcome will cover us */ }
     }
   
     _applyServerConfig(config = {}) {
       if (config.wake_word) {
         const stored = this.settings.get('wakeWord');
         const phrase = stored || config.wake_word.phrase;
         this.wakeWord.setPhrase(phrase, phrase === config.wake_word.phrase ? config.wake_word.variants : null);
         this.ui.setWakeWordLabel(phrase);
       }
       if (config.max_message_length) {
         this.maxMessageLength = config.max_message_length;
         document.getElementById('chat-input').maxLength = config.max_message_length;
       }
       if (typeof config.server_tts === 'boolean') this.serverTTS = config.server_tts;
       if (config.providers) {
         this.controls.populateProviders(config.providers, this.settings.get('provider') || config.active_provider);
       }
       this._applyAIStatus(config.ai || config);
       if (config.debug) { this.ui.debug = true; }
     }
   
     _applyAIStatus(ai = {}) {
       if (ai.provider) this.ui.setStat('provider', ai.provider, ai.offline_mode ? 'warn' : 'good');
       if (ai.model) this.ui.setStat('model', ai.model);
       if (ai.offline_mode) {
         document.getElementById('brand-sub').textContent = 'offline demo mode';
         this.ui.log('running in offline demo mode — no API key configured', 'warn');
       } else if (ai.provider) {
         document.getElementById('brand-sub').textContent = `${ai.provider} · ${ai.model || 'default'}`;
       }
     }
   
     /* ── chrome (buttons, form, shortcuts) ──────────────────────── */
     _setupChrome() {
       const form = document.getElementById('chat-form');
       const input = document.getElementById('chat-input');
       form.addEventListener('submit', (event) => {
         event.preventDefault();
         const text = input.value.trim();
         if (!text) return;
         input.value = '';
         this._submit(text);
       });
   
       document.getElementById('btn-listen').addEventListener('click', () => this.toggleListening());

       const openSettings = () => this.ui.openModal('settings-modal');
       const openMemory = () => { this.ui.openModal('memory-modal'); this._refreshMemories(); };
       document.getElementById('btn-settings').addEventListener('click', openSettings);
       document.getElementById('btn-memory').addEventListener('click', openMemory);
       document.querySelectorAll('[data-close-modal]').forEach((el) => {
         el.addEventListener('click', () => this.ui.closeModal(el.closest('.modal')?.id));
       });
       document.addEventListener('keydown', (event) => {
         if (event.key !== 'Escape') return;
         const open = document.querySelector('.modal:not([hidden])');
         if (open) { event.preventDefault(); this.ui.closeModal(open.id); }
       });
   
       // Push-to-talk: hold the mic button, release to send.
       const pushButton = document.getElementById('btn-mic-push');
       const beginPush = async (event) => {
         event.preventDefault();
         if (!speechSupport.recognition) {
           this.ui.toast('Speech recognition is not supported in this browser.', 'error');
           return;
         }
         pushButton.classList.add('is-recording');
         this._pushWasListening = this.listeningEnabled;
         if (!this.analyser.active) await this.analyser.start();
         this.awake = true;
         this.setState('awake');
         this.ui.setVisualizer('listening', () => this.analyser.levels());
         this.listener.start();
       };
       const endPush = () => {
         if (!pushButton.classList.contains('is-recording')) return;
         pushButton.classList.remove('is-recording');
         if (!this._pushWasListening) {
           setTimeout(() => { if (!this.listeningEnabled) { this.listener.stop(); this.analyser.stop(); this.ui.setVisualizer(null); } }, 1400);
         }
       };
       pushButton.addEventListener('pointerdown', beginPush);
       pushButton.addEventListener('pointerup', endPush);
       pushButton.addEventListener('pointerleave', endPush);
       pushButton.addEventListener('pointercancel', endPush);
   
       document.getElementById('btn-clear').addEventListener('click', () => {
         this.ui.clearChat();
         this.socket.send({ type: 'clear_history' });
         this.ui.toast('Conversation cleared.', 'ok');
       });
   
       document.getElementById('btn-memory-refresh').addEventListener('click', () => {
         this.socket.send({ type: 'get_memories' });
       });
       document.getElementById('btn-memory-clear').addEventListener('click', async () => {
         if (this.socket?.connected) {
           this.socket.send({ type: 'clear_memories' });
           this.ui.toast('Memory cleared.', 'ok');
           return;
         }
         try {
           const response = await fetch('/api/memories', { method: 'DELETE' });
           if (!response.ok) throw new Error(`HTTP ${response.status}`);
           this.controls.renderMemories([]);
           this.ui.toast('Memory cleared.', 'ok');
         } catch (error) {
           this.ui.toast(`Memory clear failed: ${error.message}`, 'error');
         }
       });
   
       // Keyboard shortcuts
       document.addEventListener('keydown', (event) => {
         const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
         if (event.key === '/' && !typing) { event.preventDefault(); input.focus(); }
         if (event.key.toLowerCase() === 'm' && !typing && !event.metaKey && !event.ctrlKey) this.toggleListening();
         if (event.key === 'Escape' && this.speaker.speaking) { this.speaker.cancel(); this._afterSpeaking(); }
       });
   
       window.addEventListener('beforeunload', () => this.dispose());
     }
   
     /* ── background particles (2D canvas, cheap) ────────────────── */
     _startBackgroundParticles() {
       const canvas = document.getElementById('bg-particles');
       const ctx = canvas.getContext('2d', { alpha: true });
       let particles = [];
       let raf = 0;
       let width = 0, height = 0;
   
       const resize = () => {
         const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
         width = window.innerWidth; height = window.innerHeight;
         canvas.width = Math.round(width * dpr);
         canvas.height = Math.round(height * dpr);
         ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
         const count = Math.min(70, Math.round((width * height) / 26000));
         particles = Array.from({ length: count }, () => ({
           x: Math.random() * width, y: Math.random() * height,
           vx: (Math.random() - 0.5) * 0.14, vy: -0.05 - Math.random() * 0.16,
           r: 0.6 + Math.random() * 1.5, a: 0.12 + Math.random() * 0.3,
         }));
       };
   
       const draw = () => {
         raf = requestAnimationFrame(draw);
         if (document.hidden || !this.settings.get('particles') || this.settings.effectiveReducedMotion) {
           ctx.clearRect(0, 0, width, height);
           return;
         }
         ctx.clearRect(0, 0, width, height);
         for (const p of particles) {
           p.x += p.vx; p.y += p.vy;
           if (p.y < -8) { p.y = height + 8; p.x = Math.random() * width; }
           if (p.x < -8) p.x = width + 8;
           if (p.x > width + 8) p.x = -8;
           ctx.beginPath();
           ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
           ctx.fillStyle = `rgba(120,215,255,${p.a})`;
           ctx.fill();
         }
       };
   
       resize();
       window.addEventListener('resize', resize, { passive: true });
       raf = requestAnimationFrame(draw);
       this._bgParticles = { stop: () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); } };
     }
   
     _startStatsLoop() {
       this._statsTimer = setInterval(() => {
         if (this._destroyed) return;
         this.ui.setStat('fps', this.scene.fps || '—',
           this.scene.fps >= 50 ? 'good' : this.scene.fps >= 28 ? 'warn' : 'bad');
       }, 1000);
     }
   
     _installGlobalErrorHandlers() {
       window.addEventListener('error', (event) => {
         this.ui?.log(`js error: ${event.message}`, 'error');
         if (this.ui?.debug) console.error(event.error || event.message);
       });
       window.addEventListener('unhandledrejection', (event) => {
         this.ui?.log(`promise rejection: ${event.reason?.message || event.reason}`, 'error');
         if (this.ui?.debug) console.error(event.reason);
         event.preventDefault();
       });
     }
   
     dispose() {
       if (this._destroyed) return;
       this._destroyed = true;
       clearInterval(this._statsTimer);
       clearTimeout(this._commandTimer);
       this._bgParticles?.stop();
       this.listener?.dispose();
       this.speaker?.dispose();
       this.analyser?.stop();
       this.socket?.close();
       this.controls?.dispose();
       this.settings?.dispose();
       this.animation?.dispose();
       this.character?.dispose();
       this.scene?.dispose();
       this.ui?.dispose();
     }
   }
   
   /* ── boot ─────────────────────────────────────────────────────── */
   const app = new RoxyApp();
   window.addEventListener('DOMContentLoaded', () => {
     app.start().catch((error) => {
       console.error(error);
       const loader = document.getElementById('stage-loader-text');
       if (loader) loader.textContent = 'ROXY failed to initialise. Please reload the page.';
       app.ui?.toast('ROXY failed to start. Check the console and reload.', 'error', 10000);
     });
   });
   if (import.meta.hot) import.meta.hot.dispose?.(() => app.dispose());
   