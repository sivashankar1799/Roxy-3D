/* ROXY :: WebSocket client with bounded exponential backoff and heartbeats. */

const MAX_BACKOFF = 15000;
const HEARTBEAT_MS = 25000;

export class RoxySocket extends EventTarget {
  constructor({ path = '/ws', maxRetries = Infinity } = {}) {
    super();
    this.path = path;
    this.maxRetries = maxRetries;
    this.socket = null;
    this.attempts = 0;
    this.manualClose = false;
    this.connected = false;
    this._retryTimer = 0;
    this._heartbeat = 0;
    this._queue = [];
    this.sessionId = this._sessionId();
  }

  _sessionId() {
    let id = null;
    try { id = localStorage.getItem('roxy.session'); } catch { /* storage blocked */ }
    if (!id) {
      id = (crypto.randomUUID?.() || `s${Date.now()}${Math.random()}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
      try { localStorage.setItem('roxy.session', id); } catch { /* ignore */ }
    }
    return id;
  }

  get url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${this.path}`;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.manualClose = false;
    this._emit('connecting', { attempt: this.attempts });

    let socket;
    try { socket = new WebSocket(this.url); }
    catch (err) { this._scheduleRetry(); return; }
    this.socket = socket;

    socket.onopen = () => {
      this.connected = true;
      this.attempts = 0;
      this._emit('open', {});
      this.send({ type: 'hello', session_id: this.sessionId });
      this._queue.splice(0).forEach((payload) => this.send(payload));
      this._startHeartbeat();
    };

    socket.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); }
      catch { this._emit('protocol-error', { raw: String(event.data).slice(0, 120) }); return; }
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      if (data.type === 'pong') return;
      this._emit('message', data);
      this._emit(data.type, data);
    };

    socket.onerror = () => this._emit('socket-error', {});

    socket.onclose = (event) => {
      this.connected = false;
      this._stopHeartbeat();
      this.socket = null;
      this._emit('close', { code: event.code, clean: event.wasClean });
      if (!this.manualClose) this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    if (this.manualClose || this.attempts >= this.maxRetries) {
      this._emit('gave-up', { attempts: this.attempts });
      return;
    }
    clearTimeout(this._retryTimer);                       // never stack timers
    this.attempts += 1;
    const base = Math.min(MAX_BACKOFF, 800 * 2 ** (this.attempts - 1));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5)); // jitter
    this._emit('reconnecting', { attempt: this.attempts, delay });
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() { clearInterval(this._heartbeat); this._heartbeat = 0; }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify(payload)); return true; }
      catch { /* fall through to queue */ }
    }
    if (payload.type !== 'ping' && this._queue.length < 20) this._queue.push(payload);
    return false;
  }

  sendUserMessage(text) { return this.send({ type: 'user_message', message: text, session_id: this.sessionId }); }

  close() {
    this.manualClose = true;
    clearTimeout(this._retryTimer);
    this._stopHeartbeat();
    try { this.socket?.close(1000, 'client shutdown'); } catch { /* ignore */ }
    this.socket = null;
    this.connected = false;
    this._queue.length = 0;
  }
}
