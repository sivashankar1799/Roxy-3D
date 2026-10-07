/* ROXY :: wake-word matching.
   Transcript-based today; swap in a local engine by implementing the same
   detect(transcript) → { detected, command } contract. */

   const PUNCT = /[^a-z0-9 ]+/g;

   export function normalize(text) {
     return String(text || '').toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ').trim();
   }
   
   const HOMOPHONES = {
     roxy: ['roxy', 'roxie', 'roxi', 'rocksy', 'rocksie', 'rocky', 'roxxy'],
     hey: ['hey', 'hay', 'hi', 'a'],
     ok: ['ok', 'okay'],
   };
   
   export class WakeWordDetector {
     constructor({ phrase = 'hey roxy', enabled = true, variants = null } = {}) {
       this.enabled = enabled;
       this.setPhrase(phrase, variants);
       this.lastHit = 0;
     }
   
     setPhrase(phrase, variants = null) {
       this.phrase = normalize(phrase) || 'hey roxy';
       this.variants = (variants && variants.length ? variants.map(normalize) : this._expand(this.phrase))
         .filter(Boolean)
         .sort((a, b) => b.length - a.length);       // longest match first
     }
   
     _expand(phrase) {
       let combos = [[]];
       for (const word of phrase.split(' ')) {
         const options = HOMOPHONES[word] || [word];
         combos = combos.flatMap((prefix) => options.map((opt) => [...prefix, opt]));
         if (combos.length > 256) break;             // keep it bounded
       }
       return [...new Set(combos.map((c) => c.join(' ')))];
     }
   
     /** Returns { detected, command } — command is anything spoken after the phrase. */
     detect(transcript) {
       if (!this.enabled) return { detected: false, command: '' };
       const text = normalize(transcript);
       if (!text) return { detected: false, command: '' };
   
       for (const variant of this.variants) {
         const index = text.indexOf(variant);
         if (index === -1) continue;
         const now = performance.now();
         if (now - this.lastHit < 1200) return { detected: false, command: '' }; // debounce repeats
         this.lastHit = now;
         return { detected: true, command: text.slice(index + variant.length).trim() };
       }
       return { detected: false, command: '' };
     }
   }
   