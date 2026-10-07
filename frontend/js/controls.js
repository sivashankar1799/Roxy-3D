/* ROXY :: settings + UI control panel */

const DEFAULTS = {
  wakeWord: 'Hey Roxy',
  wakeWordEnabled: true,
  continuousListening: false,
  voiceURI: '',
  rate: 1,
  pitch: 1.05,
  volume: 1,
  autoSpeak: true,
  provider: 'auto',
  intensity: 1,
  theme: 'dark',
  reducedMotion: false,
  particles: true,
  debug: false,
};

export class Settings extends EventTarget {
  constructor() {
    super();
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem('roxy.settings') || '{}');
      this.values = { ...this.values, ...saved };
    } catch (_) {}
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    try { localStorage.setItem('roxy.settings', JSON.stringify(this.values)); } catch (_) {}
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value } }));
  }

  reset() {
    this.values = { ...DEFAULTS };
    try { localStorage.setItem('roxy.settings', JSON.stringify(this.values)); } catch (_) {}
    this.dispatchEvent(new CustomEvent('change', { detail: { reset: true } }));
  }

  get effectiveReducedMotion() {
    return Boolean(this.values.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  dispose() {}
}

export class ControlPanel {
  constructor({ settings, animationController, character, scene, ui, onWakeWordChange, onProviderChange, onTestVoice }) {
    this.settings = settings;
    this.animationController = animationController;
    this.character = character;
    this.scene = scene;
    this.ui = ui;
    this.onWakeWordChange = onWakeWordChange;
    this.onProviderChange = onProviderChange;
    this.onTestVoice = onTestVoice;
    this.onMemoryOpen = null;
    this._listeners = [];
    this._bind();
  }

  _on(id, event, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(event, fn);
    this._listeners.push(() => el.removeEventListener(event, fn));
  }

  _bind() {
    const s = this.settings;
    const set = (key, value) => s.set(key, value);

    this._on('expression-buttons', 'click', e => {
      const b = e.target.closest('[data-expression],button[data-emotion]');
      if (!b) return;
      this.animationController?.setExpression(b.dataset.expression || b.dataset.emotion, { manual: true });
      this.syncIndicators({ emotion: this.animationController?.emotion });
    });
    this._on('animation-buttons', 'click', e => {
      const b = e.target.closest('[data-animation]');
      if (!b) return;
      this.animationController?.play(b.dataset.animation, { force: true, manual: true });
      this.syncIndicators({ animation: this.animationController?.current });
    });
    this._on('slider-head', 'input', e => {
      const value = Number(e.target.value);
      this.character?.setHeadYaw(value);
      this._text('slider-head-value', `${value}°`);
      try { localStorage.setItem('roxy.headYaw', String(value)); } catch (_) {}
    });
    this._on('slider-zoom', 'input', e => {
      const value = Number(e.target.value);
      this.scene?.setZoom(value / 100);
      this._text('slider-zoom-value', `${value}%`);
      try { localStorage.setItem('roxy.zoom', String(value)); } catch (_) {}
    });
    this._on('btn-rot-left', 'click', () => this.scene?.orbitBy(0.18));
    this._on('btn-rot-right', 'click', () => this.scene?.orbitBy(-0.18));
    this._on('btn-rot-reset', 'click', () => {
      this.scene?.resetView();
      const zoom = document.getElementById('slider-zoom');
      if (zoom) { zoom.value = '22'; zoom.dispatchEvent(new Event('input', { bubbles: true })); }
      const head = document.getElementById('slider-head');
      if (head) { head.value = '0'; head.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    this._on('toggle-follow', 'change', e => this.character?.setLookAtUser(e.target.checked));
    this._on('toggle-autorotate', 'change', e => this.scene?.setAutoRotate(e.target.checked));
    this._on('btn-zoom-reset', 'click', () => {
      const el = document.getElementById('slider-zoom');
      if (!el) return;
      el.value = '22';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    this._on('set-wakeword', 'input', e => set('wakeWord', e.target.value));
    this._on('set-wakeword', 'change', e => this.onWakeWordChange?.(e.target.value));
    this._on('set-wake-enabled', 'change', e => set('wakeWordEnabled', e.target.checked));
    this._on('set-continuous', 'change', e => set('continuousListening', e.target.checked));
    this._on('set-voice', 'change', e => set('voiceURI', e.target.value));
    this._on('set-rate', 'input', e => { set('rate', Number(e.target.value)); this._text('set-rate-val', e.target.value); });
    this._on('set-pitch', 'input', e => { set('pitch', Number(e.target.value)); this._text('set-pitch-val', e.target.value); });
    this._on('set-volume', 'input', e => { set('volume', Number(e.target.value)); this._text('set-volume-val', e.target.value); });
    this._on('set-autospeak', 'change', e => set('autoSpeak', e.target.checked));
    this._on('btn-test-voice', 'click', () => this.onTestVoice?.());
    this._on('set-provider', 'change', e => { set('provider', e.target.value); this.onProviderChange?.(e.target.value); });
    this._on('set-intensity', 'input', e => { const v = Number(e.target.value); set('intensity', v); this.character?.setIntensity(v); this._text('set-intensity-val', e.target.value); });
    this._on('set-theme', 'change', e => { set('theme', e.target.value); this._applyTheme(e.target.value); });
    this._on('set-reduced', 'change', e => { set('reducedMotion', e.target.checked); this.character?.setReducedMotion(e.target.checked); });
    this._on('set-particles', 'change', e => set('particles', e.target.checked));
    this._on('set-debug', 'change', e => set('debug', e.target.checked));
    this._on('btn-reset-settings', 'click', () => { s.reset(); this._sync(); });
    this._sync();
  }

  _text(id, value) { const e = document.getElementById(id); if (e) e.textContent = value; }
  _value(id, value) { const e = document.getElementById(id); if (e && value != null) e.value = value; }
  _checked(id, value) { const e = document.getElementById(id); if (e) e.checked = Boolean(value); }

  _sync() {
    const s = this.settings;
    this._value('set-wakeword', s.get('wakeWord')); this._checked('set-wake-enabled', s.get('wakeWordEnabled'));
    this._checked('set-continuous', s.get('continuousListening')); this._value('set-voice', s.get('voiceURI'));
    this._value('set-rate', s.get('rate')); this._text('set-rate-val', s.get('rate'));
    this._value('set-pitch', s.get('pitch')); this._text('set-pitch-val', s.get('pitch'));
    this._value('set-volume', s.get('volume')); this._text('set-volume-val', s.get('volume'));
    this._checked('set-autospeak', s.get('autoSpeak')); this._value('set-provider', s.get('provider'));
    this._value('set-intensity', s.get('intensity')); this._text('set-intensity-val', s.get('intensity'));
    this._value('set-theme', s.get('theme')); this._checked('set-reduced', s.get('reducedMotion'));
    this._checked('set-particles', s.get('particles')); this._checked('set-debug', s.get('debug'));
    this._applyTheme(s.get('theme'));
    const headEl = document.getElementById('slider-head');
    if (headEl) {
      let head = Number(headEl.value || 0);
      try { const saved = Number(localStorage.getItem('roxy.headYaw')); if (Number.isFinite(saved)) head = saved; } catch (_) {}
      head = Math.max(-45, Math.min(45, head));
      headEl.value = String(head);
      this.character?.setHeadYaw(head);
      this._text('slider-head-value', `${head}°`);
    }
    const zoomEl = document.getElementById('slider-zoom');
    if (zoomEl) {
      let zoom = Number(zoomEl.value || 22);
      try { const saved = Number(localStorage.getItem('roxy.zoom')); if (Number.isFinite(saved)) zoom = saved; } catch (_) {}
      zoom = Math.max(0, Math.min(100, zoom));
      zoomEl.value = String(zoom);
      this.scene?.setZoom(zoom / 100);
      this._text('slider-zoom-value', `${zoom}%`);
    }
  }

  _applyTheme(theme) {
    const value = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
    document.documentElement.dataset.theme = value;
  }

  syncIndicators({ animation, emotion } = {}) {
    if (animation != null) {
      document.querySelectorAll('[data-animation]').forEach(e => e.classList.toggle('is-active', e.dataset.animation === animation));
    }
    if (emotion != null) {
      document.querySelectorAll('[data-expression],[data-emotion]').forEach(e => e.classList.toggle('is-active', (e.dataset.expression || e.dataset.emotion) === emotion));
    }
  }

  populateVoices(voices = [], selected = '') {
    const el = document.getElementById('set-voice'); if (!el) return;
    el.innerHTML = '';
    for (const v of voices) {
      const o = document.createElement('option'); o.value = v.voiceURI || v.name; o.textContent = `${v.name}${v.lang ? ` (${v.lang})` : ''}`; o.selected = o.value === selected; el.appendChild(o);
    }
  }

  populateProviders(providers = [], selected = '') {
    const el = document.getElementById('set-provider'); if (!el) return;
    el.innerHTML = '';
    for (const p of providers) {
      const value = typeof p === 'string' ? p : (p.id || p.name || '');
      if (!value) continue;
      const o = document.createElement('option'); o.value = value; o.textContent = typeof p === 'string' ? p : (p.name || p.id); o.selected = value === selected; el.appendChild(o);
    }
  }

  renderMemories(items = [], onDelete) {
    const el = document.getElementById('memory-list');
    if (!el) return;
    el.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'memory-empty';
      empty.textContent = 'No memories yet. Ask Roxy to remember something.';
      el.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement('li');
      row.className = 'memory-item';
      const key = String(item.key || item.id || 'note');
      const value = String(item.value ?? item.text ?? item);
      const keyNode = document.createElement('span');
      keyNode.className = 'memory-item__key';
      keyNode.textContent = key.replace(/_/g, ' ');
      const valueNode = document.createElement('span');
      valueNode.className = 'memory-item__val';
      valueNode.textContent = value;
      row.append(keyNode, valueNode);
      if (onDelete) {
        const button = document.createElement('button');
        button.className = 'memory-item__del';
        button.type = 'button';
        button.title = `Delete ${key}`;
        button.setAttribute('aria-label', `Delete ${key}`);
        button.textContent = '×';
        button.addEventListener('click', () => onDelete(key));
        row.appendChild(button);
      }
      el.appendChild(row);
    });
  }

  dispose() { this._listeners.splice(0).forEach(fn => fn()); }
}
