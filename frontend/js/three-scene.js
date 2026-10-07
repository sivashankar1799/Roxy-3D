/* ROXY :: Three.js scene — renderer, camera, lighting, orbit, disposal. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class RoxyScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.disposed = false;
    this.clock = new THREE.Clock();
    this.updaters = new Set();
    this.frame = 0;
    this.fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._raf = 0;
    this._zoom = 0.22;
    this._targetZoom = 0.22;
    this._running = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.055);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    this.camera.position.set(0, 0.9, 3.85);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.88, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.enableZoom = true;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 1.35;
    this.controls.maxDistance = 6.0;
    this.controls.minPolarAngle = Math.PI * 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.86;
    this.controls.rotateSpeed = 0.75;
    this.controls.update();

    this.canvas.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const step = event.deltaY > 0 ? -0.035 : 0.035;
      this.setZoom(this._targetZoom + step);
    }, { passive: false });

    this._buildLights();
    this._buildEnvironment();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement || canvas);

    this._onVisibility = () => {
      if (document.hidden) this.pause(); else this.resume();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onContextLost = (event) => { event.preventDefault(); this.pause(); this.onContextLost?.(); };
    this._onContextRestored = () => { this.resume(); this.onContextRestored?.(); };
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    this.resize();
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x8fd8ff, 0x1a1030, 1.1));

    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(1.4, 2.4, 2.1);
    this.scene.add(key);

    const rimCyan = new THREE.DirectionalLight(0x43f5ff, 1.5);
    rimCyan.position.set(-2.4, 1.7, -1.5);
    this.scene.add(rimCyan);

    const rimViolet = new THREE.DirectionalLight(0xa855f7, 1.2);
    rimViolet.position.set(2.2, 0.9, -1.8);
    this.scene.add(rimViolet);

    this.moodLight = new THREE.PointLight(0x43f5ff, 2.2, 6, 2);
    this.moodLight.position.set(0, 1.1, 1.5);
    this.scene.add(this.moodLight);

    this.lights = [key, rimCyan, rimViolet, this.moodLight];
  }

  _buildEnvironment() {
    this.env = new THREE.Group();

    const grid = new THREE.GridHelper(14, 28, 0x43f5ff, 0x1d3a6b);
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    grid.material.depthWrite = false;
    grid.position.y = 0;
    this.env.add(grid);
    this._grid = grid;

    // Holographic floor disc
    const discGeo = new THREE.RingGeometry(0.42, 0.78, 72);
    const discMat = new THREE.MeshBasicMaterial({
      color: 0x43f5ff, transparent: true, opacity: 0.26,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.012;
    this.env.add(disc);
    this.disc = disc;

    const glowGeo = new THREE.CircleGeometry(1.15, 60);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x1b6fa8, transparent: true, opacity: 0.16, depthWrite: false,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.004;
    this.env.add(glow);

    // Ambient motes
    const count = 220;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 6;
      positions[i * 3 + 1] = Math.random() * 3.2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const moteMat = new THREE.PointsMaterial({
      color: 0x7fd9ff, size: 0.017, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.motes = new THREE.Points(moteGeo, moteMat);
    this.env.add(this.motes);

    this.scene.add(this.env);
  }

  setMood(color, intensity = 2.2) {
    this.moodLight.color.set(color);
    this.moodLight.intensity = intensity;
    this.disc.material.color.set(color);
  }

  /** zoom: 0 (far) … 1 (close) */
  setZoom(zoom) { this._targetZoom = THREE.MathUtils.clamp(zoom, 0, 1); }
  getZoom() { return this._zoom; }

  orbitBy(radians) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += radians;
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  resetView() {
    this.controls.target.set(0, 0.88, 0);
    this.camera.position.set(0, 0.9, 3.85);
    this.setZoom(0.22);
    this.controls.update();
  }

  setAutoRotate(enabled, speed = 0.9) {
    this.controls.autoRotate = Boolean(enabled);
    this.controls.autoRotateSpeed = speed;
  }

  frameAvatar(object, { targetHeight = 0.88, padding = 1.18 } = {}) {
    if (!object) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const desired = Math.max(1.0, targetHeight);
    this.controls.target.set(0, desired, 0);
    const height = Math.max(0.1, size.y);
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const fitDistance = (height / (2 * Math.tan(fovRad / 2))) * padding;
    const distance = THREE.MathUtils.clamp(fitDistance, 2.4, 5.4);
    this.camera.position.set(0, desired, distance);
    this._zoom = 1 - THREE.MathUtils.clamp((distance - 1.4) / (4.6 - 1.4), 0, 1);
    this._targetZoom = this._zoom;
    this.controls.update();
  }

  addUpdater(fn) { this.updaters.add(fn); return () => this.updaters.delete(fn); }

  resize() {
    if (this.disposed) return;
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent?.clientWidth || window.innerWidth);
    const height = Math.max(1, parent?.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Widen the FOV on narrow screens so the character still fits.
    this.camera.fov = width < 620 ? 38 : width < 980 ? 34 : 30;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this._running || this.disposed) return;
    this._running = true;
    this.clock.start();
    const loop = () => {
      if (!this._running || this.disposed) return;
      this._raf = requestAnimationFrame(loop);
      this._tick();
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() { this._running = false; cancelAnimationFrame(this._raf); this._raf = 0; }
  resume() { if (!this.disposed && !this._running) { this.clock.getDelta(); this.start(); } }

  _tick() {
    const delta = Math.min(this.clock.getDelta(), 0.1);   // clamp after tab switches
    const elapsed = this.clock.elapsedTime;
    this.frame += 1;

    // Smoothed dolly
    this._zoom += (this._targetZoom - this._zoom) * Math.min(1, delta * 6);
    const distance = THREE.MathUtils.lerp(4.6, 1.4, this._zoom);
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (direction.lengthSq() > 1e-6) {
      const current = direction.length();
      const next = THREE.MathUtils.lerp(current, distance, Math.min(1, delta * 4));
      this.camera.position.copy(this.controls.target).add(direction.multiplyScalar(next / current));
    }

    if (this.motes) {
      this.motes.rotation.y = elapsed * 0.022;
      this.motes.position.y = Math.sin(elapsed * 0.32) * 0.045;
    }
    if (this.disc) {
      this.disc.rotation.z = elapsed * 0.28;
      this.disc.material.opacity = 0.2 + Math.sin(elapsed * 1.25) * 0.06;
    }

    this.controls.update();
    this.updaters.forEach((fn) => { try { fn(delta, elapsed); } catch (err) { console.error(err); } });
    this.renderer.render(this.scene, this.camera);

    this._fpsAccum += delta; this._fpsFrames += 1;
    if (this._fpsAccum >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0; this._fpsFrames = 0;
    }
  }

  /** Recursively release GPU memory for anything under `root`. */
  static disposeObject(root) {
    root.traverse?.((child) => {
      child.geometry?.dispose?.();
      const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value && value.isTexture) value.dispose();
        }
        material.dispose?.();
      }
      child.skeleton?.dispose?.();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.updaters.clear();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this._resizeObserver?.disconnect();
    this.controls.dispose();
    RoxyScene.disposeObject(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
