/* ROXY :: UI — DOM rendering, status, chat, toasts, visualizer. */

const $ = (id) => document.getElementById(id);

/** Escape everything that could ever be interpreted as markup. */
export function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_TEXT = {
  offline: 'OFFLINE', idle: 'IDLE', listening: 'LISTENING', awake: 'ROXY AWAKE',
  processing: 'PROCESSING', speaking: 'SPEAKING', error: 'ERROR',
};

export class UI {
  constructor() {
    this.el = {
      app: $('app'),
      statusPill: $('status-pill'), statusLabel: $('status-label'),
      linkPill: $('link-pill'), linkLabel: $('link-label'),
      chatScroll: $('chat-scroll'), chatEmpty: $('chat-empty'), chatCount: $('chat-count'),
      caption: $('hud-caption'), toasts: $('toasts'), eventlog: $('eventlog'),
      loader: $('stage-loader'), loaderText: $('stage-loader-text'), loaderFill: $('stage-loader-fill'),
      modelError: $('model-error'), modelErrorText: $('model-error-text'),
      visualizer: $('visualizer'), visualizerWrap: $('visualizer-wrap'), visualizerIcon: $('visualizer-icon'),
      stats: {
        state: $('stat-state'), mic: $('stat-mic'), wake: $('stat-wake'),
        emotion: $('stat-emotion'), animation: $('stat-animation'), conn: $('stat-conn'),
        provider: $('stat-provider'), model: $('stat-model'), latency: $('stat-latency'),
        fps: $('stat-fps'), avatar: $('stat-avatar'), speech: $('stat-speech'),
      },
      emptyWake: $('empty-wake'),
    };

    this.messageCount = 0;
    this.typingNode = null;
    this.debug = false;
    this.reducedMotion = false;
    this._timers = new Set();
    this._vizRaf = 0;
    this._vizMode = null;
    this._vizSource = null;
    this._captionTimer = 0;

    this._initVisualizer();
  }

  /* ── status ─────────────────────────────────────────────────── */
  setStatus(status) {
    const key = STATUS_TEXT[status] ? status : 'idle';
    this.el.statusPill.dataset.status = key;
    this.el.statusLabel.textContent = STATUS_TEXT[key];
    this.el.app.dataset.state = key;
    this.setStat('state', STATUS_TEXT[key].toLowerCase(),
      key === 'error' ? 'bad' : key === 'offline' ? 'warn' : 'good');
  }

  setLink(state, text) {
    const pill = this.el.linkPill;
    pill.classList.toggle('is-online', state === 'online');
    pill.classList.toggle('is-connecting', state === 'connecting');
    this.el.linkLabel.textContent = text || state;
    this.setStat('conn', text || state,
      state === 'online' ? 'good' : state === 'connecting' ? 'warn' : 'bad');
  }

  setStat(key, value, tone) {
    const node = this.el.stats[key];
    if (!node) return;
    const next = String(value);
    if (node.textContent !== next) node.textContent = next;   // avoid pointless reflow
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
  }

  /* ── loader / model error ───────────────────────────────────── */
  setLoader(text, progress) {
    if (text) this.el.loaderText.textContent = text;
    if (typeof progress === 'number') {
      this.el.loaderFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }
  }

  hideLoader() {
    this.el.loader.classList.add('is-hidden');
    const t = setTimeout(() => { this.el.loader.hidden = true; this._timers.delete(t); }, 600);
    this._timers.add(t);
  }

  showModelError(message) {
    if (message) this.el.modelErrorText.textContent = message;
    this.el.modelError.hidden = false; this.el.modelError.classList.add('is-visible');
  }

  hideModelError() { this.el.modelError.hidden = true; this.el.modelError.classList.remove('is-visible'); }

  /* ── modals ─────────────────────────────────────────────────── */
  openModal(id) {
    const modal = $(id);
    if (!modal) return false;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const first = modal.querySelector('button, input, select, textarea');
    setTimeout(() => first?.focus(), 0);
    return true;
  }

  closeModal(id) {
    const modal = $(id);
    if (!modal) return false;
    modal.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
    return true;
  }

  /* ── chat ───────────────────────────────────────────────────── */
  addMessage({ role, text, emotion, error }) {
    if (this.el.chatEmpty) { this.el.chatEmpty.remove(); this.el.chatEmpty = null; }
    this.clearTyping();

    const wrap = document.createElement('div');
    wrap.className = `msg msg--${role}${error ? ' msg--error' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'msg__meta';
    const who = document.createElement('span');
    who.textContent = role === 'user' ? 'You' : role === 'roxy' ? 'Roxy' : 'System';
    const time = document.createElement('span');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(who, time);
    if (emotion && emotion !== 'neutral') {
      const tag = document.createElement('span');
      tag.className = 'msg__emotion';
      tag.textContent = emotion;
      meta.append(tag);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';
    bubble.textContent = String(text ?? '');   // textContent ⇒ no HTML/script injection

    wrap.append(meta, bubble);
    this.el.chatScroll.append(wrap);
    this._trimChat();
    this._scrollChat();

    this.messageCount += 1;
    this.el.chatCount.textContent = `${this.messageCount} message${this.messageCount === 1 ? '' : 's'}`;
    return wrap;
  }

  showTyping() {
    if (this.typingNode) return;
    const node = document.createElement('div');
    node.className = 'typing';
    node.innerHTML = '<span></span><span></span><span></span>';
    node.setAttribute('aria-label', 'Roxy is thinking');
    this.el.chatScroll.append(node);
    this.typingNode = node;
    this._scrollChat();
  }

  clearTyping() {
    if (this.typingNode) { this.typingNode.remove(); this.typingNode = null; }
  }

  clearChat() {
    this.clearTyping();
    this.el.chatScroll.replaceChildren();
    this.messageCount = 0;
    this.el.chatCount.textContent = '0 messages';
    const empty = document.createElement('div');
    empty.className = 'chat__empty';
    empty.innerHTML = '<p>Conversation cleared. Say the wake word or type to begin again.</p>';
    this.el.chatScroll.append(empty);
    this.el.chatEmpty = empty;
  }

  _trimChat(max = 120) {
    const nodes = this.el.chatScroll.querySelectorAll('.msg');
    for (let i = 0; i < nodes.length - max; i += 1) nodes[i].remove();
  }

  _scrollChat() {
    const box = this.el.chatScroll;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  /* ── caption ────────────────────────────────────────────────── */
  setCaption(text, holdMs = 0) {
    const node = this.el.caption;
    node.textContent = text || '';
    node.classList.toggle('is-visible', Boolean(text));
    clearTimeout(this._captionTimer);
    if (text && holdMs) {
      this._captionTimer = setTimeout(() => node.classList.remove('is-visible'), holdMs);
    }
  }

  /* ── toasts & log ───────────────────────────────────────────── */
  toast(message, type = 'info', duration = 4200) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.type = type;
    node.textContent = message;
    this.el.toasts.append(node);
    const t = setTimeout(() => {
      node.classList.add('is-leaving');
      const t2 = setTimeout(() => { node.remove(); this._timers.delete(t2); }, 260);
      this._timers.add(t2);
      this._timers.delete(t);
    }, duration);
    this._timers.add(t);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstElementChild.remove();
  }

  log(message, level = 'info') {
    const li = document.createElement('li');
    li.dataset.level = level;
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    li.textContent = `${stamp} ${message}`;
    this.el.eventlog.append(li);
    while (this.el.eventlog.children.length > 60) this.el.eventlog.firstElementChild.remove();
    this.el.eventlog.scrollTop = this.el.eventlog.scrollHeight;
    if (this.debug) console.debug('[roxy]', message);
  }

  /* ── audio visualizer ───────────────────────────────────────── */
  _initVisualizer() {
    const canvas = this.el.visualizer;
    this._vizCtx = canvas.getContext('2d');
    this._resizeViz();
    this._onResize = () => this._resizeViz();
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  _resizeViz() {
    const canvas = this.el.visualizer;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this._vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._vizW = rect.width; this._vizH = rect.height;
  }

  /** mode: 'listening' | 'speaking' | null. `source` supplies Uint8Array levels. */
  setVisualizer(mode, source = null) {
    this._vizMode = mode;
    this._vizSource = source;
    const wrap = this.el.visualizerWrap;
    wrap.classList.toggle('is-active', Boolean(mode));
    wrap.classList.toggle('is-speaking', mode === 'speaking');
    this.el.visualizerIcon.textContent = mode === 'speaking' ? '🔊' : '🎙';
    if (mode && !this._vizRaf) this._drawViz();
    if (!mode) {
      cancelAnimationFrame(this._vizRaf);
      this._vizRaf = 0;
      this._vizCtx.clearRect(0, 0, this._vizW, this._vizH);
    }
  }

  _drawViz() {
    this._vizRaf = requestAnimationFrame(() => this._drawViz());
    const ctx = this._vizCtx;
    const w = this._vizW, h = this._vizH;
    ctx.clearRect(0, 0, w, h);

    const bars = this.reducedMotion ? 14 : 30;
    const data = typeof this._vizSource === 'function' ? this._vizSource() : null;
    const accent = this._vizMode === 'speaking' ? '168,85,247' : '67,245,255';
    const gap = 2;
    const bw = Math.max(1.5, w / bars - gap);
    const t = performance.now() / 320;

    for (let i = 0; i < bars; i += 1) {
      let level;
      if (data && data.length) {
        level = (data[Math.floor((i / bars) * data.length)] || 0) / 255;
      } else {
        level = this.reducedMotion ? 0.24
          : 0.16 + 0.22 * Math.abs(Math.sin(t + i * 0.42)) + 0.1 * Math.abs(Math.sin(t * 1.7 + i));
      }
      const bh = Math.max(2, level * h * 0.94);
      const x = i * (bw + gap);
      const y = (h - bh) / 2;
      ctx.fillStyle = `rgba(${accent},${0.32 + level * 0.62})`;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, bw, bh, bw / 2); ctx.fill(); }
      else ctx.fillRect(x, y, bw, bh);
    }
  }

  /* ── misc ───────────────────────────────────────────────────── */
  setWakeWordLabel(phrase) {
    this.setStat('wake', phrase);
    if (this.el.emptyWake) this.el.emptyWake.textContent = `“${phrase}”`;
  }

  setReducedMotion(value) {
    this.reducedMotion = Boolean(value);
    document.documentElement.dataset.reducedMotion = String(this.reducedMotion);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    cancelAnimationFrame(this._vizRaf);
    this._timers.forEach(clearTimeout);
    this._timers.clear();
    clearTimeout(this._captionTimer);
  }
}
