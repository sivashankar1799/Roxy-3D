/* ROXY :: animation controller — single source of truth for what the
   character is doing. Prevents conflicting animations and blends states. */

   export const APP_STATES = ['offline', 'idle', 'listening', 'awake', 'processing', 'speaking', 'error'];

   const ANIMATIONS = {
     idle:      { gesture: null,        pose: { spine: 0,     head: 0,     arms: 0 },    loop: true,  priority: 0 },
     listening: { gesture: null,        pose: { spine: -0.04, head: 0.05,  arms: -0.05 }, loop: true,  priority: 1 },
     thinking:  { gesture: 'thinking',  pose: { spine: 0.04,  head: 0.1,   arms: 0.02 },  loop: true,  priority: 2, duration: 2.6 },
     talking:   { gesture: 'talking',   pose: { spine: -0.02, head: -0.02, arms: 0.04 },  loop: true,  priority: 2, duration: 2.2 },
     explaining:{ gesture: 'explaining',pose: { spine: -0.02, head: -0.03, arms: 0.08 },  loop: true,  priority: 2, duration: 2.4 },
     happy:     { gesture: 'happy',     pose: { spine: -0.05, head: -0.05, arms: 0.05 },  loop: false, priority: 3, duration: 1.8 },
     surprised: { gesture: 'surprised', pose: { spine: -0.08, head: -0.08, arms: 0.1 },   loop: false, priority: 3, duration: 1.2 },
     wave:      { gesture: 'wave',      pose: { spine: -0.03, head: -0.04, arms: 0 },     loop: false, priority: 4, duration: 2.2 },
     greeting:  { gesture: 'greeting',  pose: { spine: -0.03, head: -0.04, arms: 0 },     loop: false, priority: 4, duration: 2.4 },
   };
   
   const STATE_MAP = {
     offline:    { animation: 'idle',      expression: 'neutral',  mood: 0x2a3b55, moodIntensity: 0.8 },
     idle:       { animation: 'idle',      expression: 'neutral',  mood: 0x2f6f9e, moodIntensity: 1.5 },
     listening:  { animation: 'listening', expression: 'neutral',  mood: 0x43f5ff, moodIntensity: 2.4 },
     awake:      { animation: 'listening', expression: 'happy',    mood: 0x6ffcff, moodIntensity: 3.0 },
     processing: { animation: 'thinking',  expression: 'thinking', mood: 0xa855f7, moodIntensity: 2.6 },
     speaking:   { animation: 'talking',   expression: null,       mood: 0x3ee08f, moodIntensity: 2.2 },
     error:      { animation: 'idle',      expression: 'sad',      mood: 0xff5f6d, moodIntensity: 2.0 },
   };
   
   const EMOTION_TO_ANIMATION = {
     happy: 'happy', excited: 'happy', surprised: 'surprised',
     confused: 'thinking', thinking: 'thinking', sad: 'talking', neutral: 'talking',
   };
   
   export class AnimationController extends EventTarget {
     constructor(character, scene) {
       super();
       this.character = character;
       this.scene = scene;
       this.state = 'offline';
       this.current = 'idle';
       this.emotion = 'neutral';
       this.manualHold = 0;          // seconds of user-forced animation remaining
       this._loopTimer = 0;
       this._queue = null;
       this._mouthDriver = null;
       this.manualAnimation = false;
       this.manualExpression = false;
       this._unsubscribe = scene.addUpdater((dt) => this._tick(dt));
     }
   
     _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
   
     /** Play a named animation. Higher-priority clips interrupt lower ones. */
     play(name, { force = false, manual = false } = {}) {
       const clip = ANIMATIONS[name] || ANIMATIONS.idle;
       const currentClip = ANIMATIONS[this.current] || ANIMATIONS.idle;
   
       if (!force && this.manualHold > 0 && !manual) {
         this._queue = name;                       // respect the user's manual pick
         return this.current;
       }
       if (!force && !manual && clip.priority < currentClip.priority && this._loopTimer > 0) {
         return this.current;                      // don't interrupt a higher-priority clip
       }
   
       this.current = ANIMATIONS[name] ? name : 'idle';
       if (manual) this.manualAnimation = true;
       this.character.setPose(clip.pose);
       if (clip.gesture) this.character.playGesture(clip.gesture, clip.duration || 2);
       else this.character.clearGesture();
   
       this._loopTimer = clip.loop ? Infinity : (clip.duration || 1.6);
       if (manual) this.manualHold = Infinity;
   
       this._emit('animation', { animation: this.current });
       return this.current;
     }
   
     setExpression(emotion, { manual = false } = {}) {
       const applied = this.character.setExpression(emotion);
       this.emotion = applied;
       if (manual) this.manualExpression = true;
       this._emit('emotion', { emotion: applied });
       return applied;
     }
   
     /** Drive the whole rig from a high-level application state. */
     setState(state, { emotion = null } = {}) {
       const key = STATE_MAP[state] ? state : 'idle';
       this.state = key;
       const config = STATE_MAP[key];
   
       this.scene.setMood(config.mood, config.moodIntensity);
   
       const targetEmotion = emotion || config.expression;
       if (targetEmotion && !this.manualExpression) this.setExpression(targetEmotion);
   
       let animation = config.animation;
       if (key === 'speaking' && emotion) animation = EMOTION_TO_ANIMATION[emotion] || 'talking';
       if (!this.manualAnimation) this.play(animation, { force: key !== 'idle' });
   
       this._emit('state', { state: key });
     }
   
     /** Play a one-shot reaction then settle back into the current state. */
     react(animation, emotion) {
       if (emotion) this.setExpression(emotion);
       this.play(animation, { force: true });
     }
   
     /** Attach a function returning 0…1 mouth openness (from the audio analyser). */
     setMouthDriver(fn) { this._mouthDriver = fn; }
   
     _tick(dt) {
       if (this.manualHold > 0) this.manualHold = Math.max(0, this.manualHold - dt);
   
       if (this._loopTimer !== Infinity) {
         this._loopTimer -= dt;
         if (this._loopTimer <= 0) {
           const next = this._queue || (this.manualAnimation ? this.current : (STATE_MAP[this.state]?.animation ?? 'idle'));
           this._queue = null;
           if (this.manualAnimation) {
             this._loopTimer = 0;
             const clip = ANIMATIONS[this.current] || ANIMATIONS.idle;
             this.character.setPose(clip.pose);
             if (clip.gesture) this.character.playGesture(clip.gesture, clip.duration || 2);
             this._loopTimer = clip.loop ? Infinity : (clip.duration || 1.6);
           } else {
             this.play(next, { force: true });
           }
         }
       }
   
       if (this._mouthDriver) {
         const value = this._mouthDriver();
         this.character.setMouthOpen(typeof value === 'number' ? value : 0);
       } else if (this.state === 'speaking') {
         // Fallback pseudo lip-sync when no audio analysis is available.
         const t = performance.now() / 1000;
         const value = 0.32 + 0.3 * Math.abs(Math.sin(t * 11)) + 0.18 * Math.abs(Math.sin(t * 6.3));
         this.character.setMouthOpen(value);
       } else {
         this.character.setMouthOpen(0);
       }
     }
   
     dispose() { this._unsubscribe?.(); this._mouthDriver = null; }
   }
   
   export { ANIMATIONS, STATE_MAP };
   