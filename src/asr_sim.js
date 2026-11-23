// Simulated recogniser for typed input (SIMULATED). Real kitchen noise and acoustic echo
// cancellation are hardware/DSP problems this prototype does not solve; instead it degrades a
// typed utterance the way a noisy recogniser would, so the repair logic can be exercised on demand.
//
//   noise 0 quiet   : full text, confidence 0.95
//   noise 1 fan     : ~15% of words masked, confidence 0.75
//   noise 2 busy    : ~30% of words masked, confidence 0.55
//   panDrop         : a loud transient masks everything after the first two words except the
//                     tail of the last word ("timer" -> "imer"), loudness 0.9 (scenario B)

const LEVELS = [
  { mask: 0, conf: 0.95, loudness: 0.5 },
  { mask: 0.15, conf: 0.75, loudness: 0.55 },
  { mask: 0.3, conf: 0.55, loudness: 0.6 },
];

function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

export function simulateAsr(text, { noise = 0, panDrop = false } = {}) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (panDrop) {
    if (words.length <= 2) return { text: words.join(' ') + ' [crash]', asrConfidence: 0.5, loudness: 0.9, simulated: 'pan drop' };
    const last = words[words.length - 1].replace(/[^a-z]/gi, '');
    const tail = last.length > 4 ? last.slice(-4) : '';
    return { text: `${words.slice(0, 2).join(' ')} [crash] ${tail}`.trim(), asrConfidence: 0.55, loudness: 0.9, simulated: 'pan drop' };
  }
  const lvl = LEVELS[Math.max(0, Math.min(2, noise))];
  const rnd = seeded(text + noise);
  // Never mask the first word: repair markers come first and are usually said loudest.
  const out = words.map((w, i) => (i > 0 && rnd() < lvl.mask ? '[noise]' : w));
  return { text: out.join(' '), asrConfidence: lvl.conf, loudness: lvl.loudness, simulated: ['quiet', 'fan', 'busy'][noise] };
}
