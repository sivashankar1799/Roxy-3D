/* ROXY :: character — VRM avatar with a procedural holographic fallback.
   Exposes one API regardless of which body is active. */
   import * as THREE from 'three';
   import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
   import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
   import { RoxyScene } from './three-scene.js';
   
   const EXPRESSION_MAP = {
     neutral:   { neutral: 1 },
     happy:     { happy: 1 },
     sad:       { sad: 1 },
     surprised: { surprised: 1 },
     confused:  { sad: 0.35, surprised: 0.25 },
     thinking:  { neutral: 0.6, sad: 0.15 },
     excited:   { happy: 1, surprised: 0.35 },
     angry:     { angry: 1 },
     relaxed:   { relaxed: 1 },
   };
   
   const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];
   
   export class RoxyCharacter {
     constructor(scene) {
       this.scene = scene;
       this.vrm = null;
       this.fallback = null;
       this.root = new THREE.Group();
       // Keep the avatar anchored to the center of the stage. Animations only
       // affect bones; the model root itself never drifts.
       this.root.position.set(0, 0, 0);
       this.root.rotation.set(0, 0, 0);
       this.scene.scene.add(this.root);
   
       this.usingFallback = false;
       this.loaded = false;
       this.intensity = 1;
       this.reducedMotion = false;
   
       this.expression = 'neutral';
       this._expressionWeights = {};
       this._targetWeights = {};
   
       this.mouthOpen = 0;
       this._mouthTarget = 0;
       this.headYaw = 0;          // manual offset, radians
       this._headYawTarget = 0;
       this.lookAtUser = true;
       this._lookTarget = new THREE.Object3D();
       this.scene.scene.add(this._lookTarget);
   
       this._blinkTimer = 1.5 + Math.random() * 3;
       this._blinkValue = 0;
       this._gesture = null;      // { name, time, duration }
       this._poseBias = { spine: 0, head: 0, arms: 0 };
       this._targetBias = { spine: 0, head: 0, arms: 0 };
   
       this._bones = {};
       this._restQuats = new Map();
   
       this._unsubscribe = this.scene.addUpdater((dt, t) => this.update(dt, t));
     }
   
     /* ── loading ──────────────────────────────────────────────────── */
     async load(url, { onProgress } = {}) {
       const loader = new GLTFLoader();
       loader.crossOrigin = 'anonymous';
       loader.register((parser) => new VRMLoaderPlugin(parser));
   
       try {
         const gltf = await new Promise((resolve, reject) => {
           loader.load(
             url,
             resolve,
             (event) => {
               if (event.total) onProgress?.(Math.round((event.loaded / event.total) * 100));
             },
             reject,
           );
         });
   
         const vrm = gltf.userData?.vrm;
         if (!vrm) {
           throw new Error('The file loaded, but @pixiv/three-vrm did not detect a VRM extension.');
         }

         VRMUtils.removeUnnecessaryVertices(gltf.scene);
         VRMUtils.combineSkeletons(gltf.scene);
         VRMUtils.combineMorphs(vrm);

         // Safe for both VRM 0.0 and VRM 1.0. For VRM 0.0 this rotates
         // the avatar to the expected forward direction; for VRM 1.0 it does nothing.
         VRMUtils.rotateVRM0(vrm);

         vrm.scene.visible = true;
         vrm.scene.traverse((object) => {
           object.frustumCulled = false;
           if (object.isMesh) object.visible = true;
         });

         // Fit the avatar to the existing camera framing.
         const box = new THREE.Box3().setFromObject(vrm.scene);
         const size = new THREE.Vector3();
         box.getSize(size);
         if (Number.isFinite(size.y) && size.y > 0.01) {
           // Stable, predictable avatar size: feet on y=0 and body centered on x/z.
           vrm.scene.scale.setScalar(1.75 / size.y);
           const fittedBox = new THREE.Box3().setFromObject(vrm.scene);
           const fittedCenter = new THREE.Vector3();
           fittedBox.getCenter(fittedCenter);
           vrm.scene.position.x -= fittedCenter.x;
           vrm.scene.position.z -= fittedCenter.z;
           vrm.scene.position.y -= fittedBox.min.y;
         }

         // Re-anchor after fitting. The root is the only stage transform for the avatar.
         this.root.position.set(0, 0, 0);
         this.root.rotation.set(0, 0, 0);

         vrm.update(0);

         this.vrm = vrm;
         this.root.add(vrm.scene);
         this.scene.frameAvatar?.(vrm.scene, { targetHeight: 0.88, padding: 1.18 });
         this._cacheBones();
         if (vrm.lookAt) {
           vrm.lookAt.target = this._lookTarget;
           vrm.lookAt.autoUpdate = true;
         }
         this.usingFallback = false;
         this.loaded = true;

         const meta = vrm.meta || {};
         const name = meta.name || meta.title || meta.vrmName || 'Roxy VRM';
         const version = meta.metaVersion ? `VRM ${meta.metaVersion}` : 'VRM';
         console.info('[ROXY] Avatar loaded:', name, version);
         return { ok: true, source: 'vrm', name };
       } catch (error) {
         console.error('[ROXY] VRM LOAD FAILED:', error);
         console.error('[ROXY] URL:', url);
         this.buildFallback();
         return { ok: false, source: 'fallback', error: String(error?.message || error) };
       }
     }

     _cacheBones() {
       const humanoid = this.vrm?.humanoid;
       if (!humanoid) return;
       const names = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
         'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
         'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
       for (const name of names) {
         const node = humanoid.getNormalizedBoneNode(name);
         if (node) {
           this._bones[name] = node;
           this._restQuats.set(name, node.quaternion.clone());
         }
       }
       // Keep the avatar's authored/rest pose. Artificially rotating the arm bones
       // here can push hands above the head on some VRM rigs.
     }
   
     /** Procedural stand-in so the app is fully usable without a VRM file. */
     buildFallback() {
       if (this.fallback) return;
       const group = new THREE.Group();
   
       const skin = new THREE.MeshStandardMaterial({
         color: 0x18e0ff, emissive: 0x0a5f7a, emissiveIntensity: 0.55,
         metalness: 0.28, roughness: 0.3, transparent: true, opacity: 0.88,
       });
       const accent = new THREE.MeshStandardMaterial({
         color: 0xa855f7, emissive: 0x4a1f80, emissiveIntensity: 0.6,
         metalness: 0.4, roughness: 0.28, transparent: true, opacity: 0.9,
       });
       const wire = new THREE.MeshBasicMaterial({ color: 0x43f5ff, wireframe: true, transparent: true, opacity: 0.22 });
       this._fallbackMaterials = [skin, accent, wire];
   
       const hips = new THREE.Group(); hips.position.y = 0.94; group.add(hips);
   
       const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.32, 6, 18), accent);
       torso.position.y = 0.2; hips.add(torso);
   
       const halo = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 10, 44), skin);
       halo.rotation.x = Math.PI / 2; halo.position.y = 0.2; hips.add(halo);
   
       const neck = new THREE.Group(); neck.position.y = 0.44; hips.add(neck);
       const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 28, 22), skin);
       head.scale.set(1, 1.08, 0.95); neck.add(head);
       const headWire = new THREE.Mesh(new THREE.SphereGeometry(0.145, 14, 11), wire);
       neck.add(headWire);
   
       const eyeGeo = new THREE.SphereGeometry(0.022, 14, 12);
       const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
       const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.048, 0.015, 0.118);
       const eyeR = new THREE.Mesh(eyeGeo, eyeMat.clone()); eyeR.position.set(0.048, 0.015, 0.118);
       neck.add(eyeL, eyeR);
   
       const mouth = new THREE.Mesh(
         new THREE.SphereGeometry(0.026, 14, 10),
         new THREE.MeshBasicMaterial({ color: 0x0a1424 }),
       );
       mouth.position.set(0, -0.052, 0.118); mouth.scale.set(1, 0.24, 0.6);
       neck.add(mouth);
   
       const makeArm = (side) => {
         const shoulder = new THREE.Group();
         shoulder.position.set(0.17 * side, 0.36, 0);
         const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.19, 5, 12), skin);
         upper.position.y = -0.12; shoulder.add(upper);
         const elbow = new THREE.Group(); elbow.position.y = -0.24; shoulder.add(elbow);
         const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.17, 5, 12), skin);
         lower.position.y = -0.11; elbow.add(lower);
         const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 12), accent);
         hand.position.y = -0.23; hand.scale.set(1, 1.15, 0.6); elbow.add(hand);
         shoulder.rotation.z = -0.22 * side;
         hips.add(shoulder);
         return { shoulder, elbow, rest: shoulder.rotation.z };
       };
       const armL = makeArm(-1);
       const armR = makeArm(1);
   
       const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.3, 22, 1, true), accent);
       skirt.position.y = -0.1; skirt.rotation.x = Math.PI; hips.add(skirt);
   
       const legGeo = new THREE.CapsuleGeometry(0.048, 0.5, 5, 12);
       const legL = new THREE.Mesh(legGeo, skin); legL.position.set(-0.07, -0.42, 0);
       const legR = new THREE.Mesh(legGeo, skin); legR.position.set(0.07, -0.42, 0);
       hips.add(legL, legR);
   
       const aura = new THREE.Mesh(
         new THREE.SphereGeometry(0.72, 26, 20),
         new THREE.MeshBasicMaterial({
           color: 0x43f5ff, transparent: true, opacity: 0.045,
           side: THREE.BackSide, depthWrite: false,
         }),
       );
       aura.position.y = 0.16; hips.add(aura);
   
       this.fallback = { group, hips, neck, head, eyeL, eyeR, mouth, armL, armR, aura, torso };
       this.root.add(group);
       this.usingFallback = true;
       this.loaded = true;
     }
   
     /* ── expression / emotion ─────────────────────────────────────── */
     setExpression(name) {
       const key = EXPRESSION_MAP[name] ? name : 'neutral';
       this.expression = key;
       this._targetWeights = { ...EXPRESSION_MAP[key] };
       return key;
     }
   
     setMouthOpen(value) { this._mouthTarget = THREE.MathUtils.clamp(value, 0, 1); }
     setHeadYaw(degrees) { this._headYawTarget = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(degrees, -60, 60)); }
     setLookAtUser(enabled) { this.lookAtUser = Boolean(enabled); }
     setIntensity(value) { this.intensity = THREE.MathUtils.clamp(value, 0, 1.5); }
     setReducedMotion(value) { this.reducedMotion = Boolean(value); }
   
     /** Body posture bias per application state. */
     setPose({ spine = 0, head = 0, arms = 0 } = {}) {
       this._targetBias = { spine, head, arms };
     }
   
     playGesture(name, duration = 2.2) {
       this._gesture = { name, time: 0, duration };
     }
   
     clearGesture() { this._gesture = null; }
   
     /* ── per-frame update ─────────────────────────────────────────── */
     update(dt, elapsed) {
       if (!this.loaded) return;
       const amp = this.reducedMotion ? 0.25 : this.intensity;
   
       // Expression weight smoothing
       const keys = new Set([...Object.keys(this._expressionWeights), ...Object.keys(this._targetWeights)]);
       for (const key of keys) {
         const target = this._targetWeights[key] ?? 0;
         const current = this._expressionWeights[key] ?? 0;
         const next = current + (target - current) * Math.min(1, dt * 7);
         if (next < 0.002 && target === 0) delete this._expressionWeights[key];
         else this._expressionWeights[key] = next;
       }
   
       // Blink
       this._blinkTimer -= dt;
       if (this._blinkTimer <= 0) {
         this._blinkTimer = 2.2 + Math.random() * 3.4;
         this._blinkValue = 1;
       }
       this._blinkValue = Math.max(0, this._blinkValue - dt * 8.5);
       const blink = Math.sin(Math.min(1, this._blinkValue) * Math.PI) ;
   
       // Mouth
       this.mouthOpen += (this._mouthTarget - this.mouthOpen) * Math.min(1, dt * 16);
   
       // Pose bias smoothing
       for (const key of Object.keys(this._targetBias)) {
         this._poseBias[key] += (this._targetBias[key] - this._poseBias[key]) * Math.min(1, dt * 3.5);
       }
   
       // Head yaw smoothing
       this.headYaw += (this._headYawTarget - this.headYaw) * Math.min(1, dt * 5);
   
       // Gesture clock
       let gestureT = 0;
       if (this._gesture) {
         this._gesture.time += dt;
         gestureT = this._gesture.time / this._gesture.duration;
         if (gestureT >= 1) { this._gesture = null; gestureT = 0; }
       }
   
       // Look target follows the camera (i.e. the user) with a little drift
       if (this.lookAtUser) {
         const cam = this.scene.camera.position;
         const drift = this.reducedMotion ? 0 : 0.06;
         this._lookTarget.position.set(
           cam.x + Math.sin(elapsed * 0.6) * drift,
           cam.y + Math.sin(elapsed * 0.43) * drift * 0.6,
           cam.z,
         );
       } else {
         this._lookTarget.position.set(0, 1.3, 4);
       }
   
       if (this.vrm) this._updateVRM(dt, elapsed, amp, blink, gestureT);
       else this._updateFallback(dt, elapsed, amp, blink, gestureT);
     }
   
     _updateVRM(dt, elapsed, amp, blink, gestureT) {
       const vrm = this.vrm;
       const manager = vrm.expressionManager;
   
       if (manager) {
         const applied = new Set();
         for (const [name, weight] of Object.entries(this._expressionWeights)) {
           if (manager.getExpression(name)) { manager.setValue(name, weight); applied.add(name); }
         }
         for (const name of ['happy', 'sad', 'angry', 'relaxed', 'surprised', 'neutral']) {
           if (!applied.has(name) && manager.getExpression(name)) manager.setValue(name, 0);
         }
         if (manager.getExpression('blink')) manager.setValue('blink', blink);
   
         // Simple viseme-based lip sync driven by the current mouth amplitude.
         const phase = Math.floor(elapsed * 9) % VISEMES.length;
         for (let i = 0; i < VISEMES.length; i += 1) {
           const viseme = VISEMES[i];
           if (!manager.getExpression(viseme)) continue;
           manager.setValue(viseme, i === phase ? this.mouthOpen * 0.9 : this.mouthOpen * 0.08);
         }
       }
   
       const bone = (name) => this._bones[name];
       const rest = (name) => this._restQuats.get(name);
       const tmpEuler = new THREE.Euler();
       const tmpQuat = new THREE.Quaternion();
   
       const applyOffset = (name, x, y, z) => {
         const node = bone(name);
         const base = rest(name);
         if (!node || !base) return;
         tmpEuler.set(x, y, z);
         tmpQuat.setFromEuler(tmpEuler);
         node.quaternion.copy(base).multiply(tmpQuat);
       };
   
       // Breathing
       const breath = Math.sin(elapsed * 1.15) * 0.022 * amp;
       applyOffset('spine', breath + this._poseBias.spine * 0.5, 0, 0);
       applyOffset('chest', breath * 0.6, 0, 0);
       applyOffset('neck', this._poseBias.head * 0.4 + Math.sin(elapsed * 0.72) * 0.012 * amp, this.headYaw * 0.4, 0);
       applyOffset('head',
         this._poseBias.head + Math.sin(elapsed * 0.9) * 0.018 * amp + this.mouthOpen * 0.02,
         this.headYaw * 0.6 + Math.sin(elapsed * 0.47) * 0.03 * amp,
         Math.sin(elapsed * 0.6) * 0.02 * amp);
   
       const sway = Math.sin(elapsed * 1.05) * 0.035 * amp;
       applyOffset('leftUpperArm', 0, 0, sway + this._poseBias.arms);
       applyOffset('rightUpperArm', 0, 0, -sway - this._poseBias.arms);
   
       if (this._gesture) this._applyVRMGesture(this._gesture.name, gestureT, elapsed, applyOffset, amp);
   
       const hips = bone('hips');
       if (hips) hips.position.y = Math.sin(elapsed * 1.15) * 0.007 * amp;
   
       vrm.update(dt);
     }
   
     _applyVRMGesture(name, t, elapsed, applyOffset, amp) {
       const ease = Math.sin(Math.min(1, t) * Math.PI);            // 0→1→0
       switch (name) {
         case 'wave':
         case 'greeting': {
           const lift = ease * 2.0;
           const swing = Math.sin(elapsed * 9) * 0.45 * ease;
           applyOffset('rightUpperArm', 0, 0, -lift * 0.85);
           applyOffset('rightLowerArm', 0, swing, -lift * 0.35);
           applyOffset('head', ease * 0.06, -ease * 0.12, 0);
           break;
         }
         case 'thinking': {
           applyOffset('rightUpperArm', -ease * 0.55, 0, -ease * 0.95);
           applyOffset('rightLowerArm', -ease * 1.25, ease * 0.4, 0);
           applyOffset('head', ease * 0.12, -ease * 0.18, ease * 0.1);
           break;
         }
         case 'surprised': {
           applyOffset('leftUpperArm', 0, 0, ease * 0.4);
           applyOffset('rightUpperArm', 0, 0, -ease * 0.4);
           applyOffset('spine', -ease * 0.08, 0, 0);
           break;
         }
         case 'happy': {
           const bob = Math.sin(elapsed * 5) * 0.08 * ease;
           applyOffset('spine', bob * 0.4, 0, 0);
           applyOffset('leftUpperArm', 0, 0, ease * 0.3 + bob);
           applyOffset('rightUpperArm', 0, 0, -ease * 0.3 - bob);
           break;
         }
         case 'explaining':
         case 'talking': {
           const motion = Math.sin(elapsed * 3.1) * 0.22 * amp;
           applyOffset('leftUpperArm', 0, 0, 0.26 + motion);
           applyOffset('rightUpperArm', 0, 0, -0.26 + motion * 0.8);
           applyOffset('leftLowerArm', -0.45, 0, motion * 0.6);
           applyOffset('rightLowerArm', -0.45, 0, -motion * 0.6);
           break;
         }
         default: break;
       }
     }
   
     _updateFallback(dt, elapsed, amp, blink, gestureT) {
       const f = this.fallback;
       if (!f) return;
   
       const breath = Math.sin(elapsed * 1.2) * 0.012 * amp;
       f.hips.position.y = 0.94 + breath + this._poseBias.spine * 0.02;
       f.torso.scale.set(1 + breath * 0.6, 1 - breath * 0.3, 1 + breath * 0.6);
       f.hips.rotation.y = Math.sin(elapsed * 0.35) * 0.05 * amp;
   
       f.neck.rotation.y = this.headYaw * 0.9 + Math.sin(elapsed * 0.52) * 0.06 * amp;
       f.neck.rotation.x = this._poseBias.head + Math.sin(elapsed * 0.8) * 0.03 * amp;
   
       const eyeScale = Math.max(0.06, 1 - blink);
       f.eyeL.scale.y = eyeScale; f.eyeR.scale.y = eyeScale;
   
       // Emotion colouring on the eyes
       const emotionColor = {
         happy: 0x9dffd8, excited: 0xffe08a, sad: 0x8aa8ff, surprised: 0xfff2a8,
         confused: 0xd4a8ff, thinking: 0xa8d8ff, neutral: 0xffffff,
       }[this.expression] || 0xffffff;
       f.eyeL.material.color.setHex(emotionColor);
       f.eyeR.material.color.setHex(emotionColor);
   
       f.mouth.scale.set(1 + this.mouthOpen * 0.5, 0.24 + this.mouthOpen * 1.5, 0.6);
       f.aura.material.opacity = 0.04 + this.mouthOpen * 0.05 + Math.sin(elapsed * 1.6) * 0.012;
   
       const idleSwing = Math.sin(elapsed * 1.1) * 0.08 * amp;
       f.armL.shoulder.rotation.z = f.armL.rest + idleSwing + this._poseBias.arms;
       f.armR.shoulder.rotation.z = f.armR.rest - idleSwing - this._poseBias.arms;
       f.armL.elbow.rotation.x = -0.18 + idleSwing * 0.4;
       f.armR.elbow.rotation.x = -0.18 - idleSwing * 0.4;
   
       if (this._gesture) {
         const ease = Math.sin(Math.min(1, gestureT) * Math.PI);
         const name = this._gesture.name;
         if (name === 'wave' || name === 'greeting') {
           f.armR.shoulder.rotation.z = f.armR.rest - ease * 2.1;
           f.armR.elbow.rotation.z = Math.sin(elapsed * 10) * 0.6 * ease;
           f.neck.rotation.z = -ease * 0.1;
         } else if (name === 'thinking') {
           f.armR.shoulder.rotation.z = f.armR.rest - ease * 1.1;
           f.armR.elbow.rotation.x = -ease * 2.0;
           f.neck.rotation.z = ease * 0.16;
           f.neck.rotation.y += ease * 0.2;
         } else if (name === 'surprised') {
           f.armL.shoulder.rotation.z = f.armL.rest + ease * 0.7;
           f.armR.shoulder.rotation.z = f.armR.rest - ease * 0.7;
           f.hips.position.y += ease * 0.03;
         } else if (name === 'happy') {
           f.hips.position.y += Math.abs(Math.sin(elapsed * 6)) * 0.03 * ease;
         } else if (name === 'talking' || name === 'explaining') {
           const motion = Math.sin(elapsed * 3.4) * 0.3;
           f.armL.shoulder.rotation.z = f.armL.rest + 0.35 + motion;
           f.armR.shoulder.rotation.z = f.armR.rest - 0.35 + motion;
           f.armL.elbow.rotation.x = -0.9 - motion * 0.4;
           f.armR.elbow.rotation.x = -0.9 + motion * 0.4;
         }
       } else {
         f.neck.rotation.z *= 0.9;
       }
     }
   
     dispose() {
       this._unsubscribe?.();
       if (this.vrm) {
         this.root.remove(this.vrm.scene);
         RoxyScene.disposeObject(this.vrm.scene);
         this.vrm = null;
       }
       if (this.fallback) {
         this.root.remove(this.fallback.group);
         RoxyScene.disposeObject(this.fallback.group);
         this._fallbackMaterials?.forEach((m) => m.dispose());
         this.fallback = null;
       }
       this.scene.scene.remove(this.root, this._lookTarget);
       this._bones = {};
       this._restQuats.clear();
       this.loaded = false;
     }
   }
   