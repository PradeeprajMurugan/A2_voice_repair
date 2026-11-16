// Browser speech I/O (IMPLEMENTED with the Web Speech API; best in Chrome or Edge).
//
// Echo: a real smart speaker cancels its own voice in the microphone signal (AEC, PLANNED —
// hardware/DSP). Here a text-level echo filter (SIMULATED stand-in) ignores recognised text that
// matches what the assistant is currently saying. Use headphones for the cleanest demo.

import { normalize } from './parser.js';

export function createTts({ rate = 1.1 } = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let voice = null;
  const pickVoice = () => {
    const vs = synth?.getVoices() || [];
    voice = vs.find((v) => /en-GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  };
  if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }
  let fallbackTimer = null;
  return {
    available: !!synth,
    speak(text, onEnd) {
      if (!synth) { fallbackTimer = setTimeout(onEnd, text.length * 60); return; }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text.replace('…', '.'));
      if (voice) u.voice = voice;
      u.rate = rate;
      let done = false;
      const finish = () => { if (!done) { done = true; onEnd(); } };
      u.onend = finish;
      u.onerror = finish;
      // Safety net: some browsers never fire onend for very short utterances.
      setTimeout(finish, text.length * 90 + 1500);
      synth.speak(u);
    },
    stop() {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      synth?.cancel();
    },
  };
}

// Short non-speech cues: an acknowledgement that does not compete with the user's own speech (L04).
export function createEarcons() {
  let ctx = null;
  const tone = (freqs, dur = 0.07) => {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      let t = ctx.currentTime;
      for (const f of freqs) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.15, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + dur);
        t += dur;
      }
    } catch { /* audio unavailable: visual cue still shows */ }
  };
  // Create the audio context on the first user gesture, so the first earcon is not slow.
  const warm = () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); } catch { /* none */ } };
  window.addEventListener('pointerdown', warm, { once: true });
  window.addEventListener('keydown', warm, { once: true });
  return {
    play(kind) {
      if (kind === 'stop') tone([880, 587]);       // falling pair: "stopped"
      else if (kind === 'connected') tone([660]);  // single soft ping
    },
  };
}

/**
 * Continuous microphone recognition.
 * onInterim(text) fires as soon as words are recognised (used to yield the floor early);
 * onFinal({text, asrConfidence}) fires once per utterance.
 */
export function createRecogniser({ onInterim, onFinal, onStatus, isEcho }) {
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return { available: false, start() {}, stop() {} };
  let rec = null, wanted = false;
  const make = () => {
    const r = new SR();
    r.lang = 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0].transcript.trim();
        if (!text || isEcho(text)) continue;
        if (res.isFinal) onFinal({ text, asrConfidence: res[0].confidence || 0.8 });
        else onInterim(text);
      }
    };
    r.onstart = () => onStatus('listening');
    r.onerror = (e) => onStatus('error: ' + e.error);
    r.onend = () => { if (wanted) { try { r.start(); } catch { /* already started */ } } else onStatus('off'); };
    return r;
  };
  return {
    available: true,
    start() { wanted = true; rec = rec || make(); try { rec.start(); } catch { /* already running */ } },
    stop() { wanted = false; rec?.stop(); },
  };
}

// Text-level echo filter: is this recognised text just the assistant hearing itself?
export function makeEchoFilter(getSpeaking) {
  return (text) => {
    const s = getSpeaking();
    if (!s) return false;
    const heard = normalize(text), said = normalize(s);
    return heard.length > 0 && said.includes(heard);
  };
}
