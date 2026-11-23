// Rule-based intent parser (IMPLEMENTED). Deterministic, so recorded runs replay identically.
//
// Output is a structured *proposal* (L12): the dialogue manager and tools.js decide what runs.
// The parser separates two things the user may say in one breath (A1 contribution):
//   1. a repair marker  ("no, wait", "stop", "I meant")  -> undo the current action
//   2. a new request     ("a ten-minute timer")           -> what to do instead
// Fuzzy matching lets a noise-clipped fragment ("...imer") still yield a *candidate* the
// system can offer back ("Did you want a timer?") instead of "Sorry, try again" (L07 clarify).

import { CONTACTS, GENRES } from './tools.js';

// [phrase, strength]. Strength is how reliably the phrase signals a correction.
const REPAIR_MARKERS = [
  ['no wait', 1.0], ['not that', 1.0], ['i meant', 1.0], ['never mind', 1.0], ['nevermind', 1.0],
  ['hang up', 1.0], ['cancel that', 1.0], ['undo', 1.0], ['hold on', 0.9], ['i mean', 0.9],
  ['cancel', 0.95], ['stop', 0.95], ['wait', 0.9], ['nope', 0.85], ['no', 0.8], ['wrong', 0.8],
  ['actually', 0.7],
];
// Markers that count even mid-utterance ("set a timer, not that, music").
const ANYWHERE_MARKERS = new Set(['not that', 'i meant', 'i mean', 'never mind', 'nevermind']);
// Pure "stop" markers end an action; every other marker signals that something else was wanted.
const STOP_MARKERS = new Set(['stop', 'cancel', 'cancel that', 'hang up', 'undo', 'never mind', 'nevermind']);

const FILLER = new Set(['the', 'a', 'an', 'that', 'this', 'it', 'please', 'um', 'uh', 'er', 'oh', 'okay', 'ok', 'so', 'just', 'and', 'instead', 'sorry']);
const CANCEL_OBJECTS = new Set(['call', 'timer', 'music', 'song', 'it', 'that', 'this', 'list', 'item']);

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right', 'go ahead', 'do it', 'please do', 'ok', 'okay']);
const NO = new Set(['no', 'nope', 'dont', 'do not', 'cancel', 'stop', 'wrong', 'not that']);

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
};
const CONTACT_ALIASES = { mum: 'mom', mother: 'mom', mommy: 'mom', father: 'dad', daddy: 'dad' };

// Keyword cues per tool: [word, weight].
const CUES = {
  set_timer: [['timer', 1.0], ['minutes', 0.6], ['minute', 0.6], ['alarm', 0.6], ['countdown', 0.8]],
  call_contact: [['call', 1.0], ['dial', 0.9], ['ring', 0.8], ['phone', 0.8]],
  play_music: [['music', 1.0], ['play', 0.8], ['song', 0.8], ['songs', 0.8]],
  add_to_list: [['list', 1.0], ['shopping', 0.7], ['add', 0.6], ['buy', 0.6]],
};

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/lo-fi|lo fi/g, 'lofi')
    .replace(/don't/g, 'dont')
    .replace(/[^a-z0-9\s\[\]]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ') // drop ASR markers such as [noise]
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// How well does one heard token match a cue word? 1 = exact; partial for fragments and typos.
function tokenMatch(tok, word) {
  if (tok === word) return 1;
  if (tok.length >= 3 && word.endsWith(tok)) return 0.45; // clipped start: "imer" -> "timer"
  if (tok.length >= 3 && word.startsWith(tok)) return 0.5; // clipped end: "tim" -> "timer"
  if (tok.length >= 4 && levenshtein(tok, word) === 1) return 0.6; // "timmer", "musik"
  return 0;
}

// Consume repair markers at the start of the token list. Returns { markers, rest }.
function stripLeadingMarkers(tokens) {
  const markers = [];
  let i = 0;
  for (;;) {
    while (i < tokens.length && FILLER.has(tokens[i])) i++;
    let hit = null;
    for (const [phrase, strength] of REPAIR_MARKERS) {
      const p = phrase.split(' ');
      if (p.every((w, k) => tokens[i + k] === w)) { hit = { phrase, strength, len: p.length }; break; }
    }
    if (!hit) break;
    markers.push({ phrase: hit.phrase, strength: hit.strength });
    i += hit.len;
  }
  return { markers, rest: tokens.slice(i) };
}

function findAnywhereMarker(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    for (const [phrase, strength] of REPAIR_MARKERS) {
      if (!ANYWHERE_MARKERS.has(phrase)) continue;
      const p = phrase.split(' ');
      if (p.every((w, k) => tokens[i + k] === w)) return { index: i, len: p.length, phrase, strength };
    }
  }
  return null;
}

function extractMinutes(tokens) {
  const s = tokens.join(' ');
  if (/half an hour|half hour/.test(s)) return 30;
  if (/\ban hour\b|\bone hour\b/.test(s)) return 60;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (t in NUMBER_WORDS) {
      let n = NUMBER_WORDS[t];
      const next = tokens[i + 1];
      if (n >= 20 && next in NUMBER_WORDS && NUMBER_WORDS[next] < 10) n += NUMBER_WORDS[next];
      return n;
    }
  }
  return undefined;
}

function extractContact(tokens) {
  for (const t of tokens) {
    const c = CONTACT_ALIASES[t] || t;
    if (CONTACTS.includes(c)) return c;
  }
  return undefined;
}

function extractGenre(tokens) {
  return tokens.find((t) => GENRES.includes(t));
}

function extractItem(tokens) {
  const s = tokens.join(' ');
  let m = s.match(/\b(?:add|buy|get)\s+(?:some\s+|more\s+)?(.+?)(?:\s+to\s+(?:the\s+|my\s+)?(?:shopping\s+)?list)?$/);
  if (!m) m = s.match(/^(.+?)\s+(?:to|on)\s+(?:the\s+|my\s+)?(?:shopping\s+)?list$/);
  if (!m) return undefined;
  const item = m[1].split(' ').filter((w) => !FILLER.has(w)).join(' ').trim();
  return item && item !== 'list' ? item : undefined;
}

function scoreTools(tokens) {
  const scores = {};
  for (const [tool, cues] of Object.entries(CUES)) {
    let best = 0, extra = 0;
    for (const tok of tokens) {
      for (const [word, weight] of cues) {
        const m = tokenMatch(tok, word) * weight;
        if (m > best) { extra += best > 0 ? 0.15 : 0; best = m; }
        else if (m > 0.3) extra += 0.15;
      }
    }
    // Arguments are cues too ("jazz" alone means music, "mom" alone hints a call).
    if (tool === 'play_music' && extractGenre(tokens)) best = Math.max(best, 0.8), (extra += 0.15);
    if (tool === 'call_contact' && extractContact(tokens)) best = Math.max(best, 0.5), (extra += 0.2);
    if (tool === 'set_timer' && extractMinutes(tokens) !== undefined && best > 0) extra += 0.15;
    scores[tool] = Math.min(1, best + Math.min(extra, 0.3));
  }
  return scores;
}

function buildIntent(tool, tokens, confidence) {
  const args = {};
  const missing = [];
  if (tool === 'set_timer') {
    const m = extractMinutes(tokens);
    if (m !== undefined) args.minutes = m; else missing.push('minutes');
  } else if (tool === 'call_contact') {
    const n = extractContact(tokens);
    if (n) args.name = n; else missing.push('name');
  } else if (tool === 'play_music') {
    const g = extractGenre(tokens);
    if (g) args.genre = g;
  } else if (tool === 'add_to_list') {
    const it = extractItem(tokens);
    if (it) args.item = it; else missing.push('item');
  }
  return { tool, args, confidence: round(confidence), missing };
}

function round(x) { return Math.round(x * 100) / 100; }

function detectYesNo(norm) {
  if (!norm) return null;
  const words = norm.split(' ');
  const first2 = words.slice(0, 2).join(' ');
  if (YES.has(norm) || YES.has(first2) || YES.has(words[0])) return 'yes';
  if (NO.has(norm) || NO.has(first2) || NO.has(words[0])) return 'no';
  return null;
}

/**
 * Parse one heard utterance.
 * @param {string} text            ASR transcript (may contain [noise] markers)
 * @param {number} asrConfidence   0..1 from the recogniser (1 for typed input)
 */
// Echo removal. Without hardware echo cancellation the microphone also hears the assistant, and
// the recogniser often glues that echo onto the user's words ("timer for how many minutes no no
// stop"). Strip any leading run of 2+ words that follows one of the assistant's recent sentences
// in order, repeatedly; return what is left ('' = it was all echo).
export function stripEcho(text, recentSaid = []) {
  let words = normalize(text).split(' ').filter(Boolean);
  const saids = recentSaid.map((s) => normalize(s).split(' ').filter(Boolean)).filter((w) => w.length);
  for (let changed = true; changed && words.length;) {
    changed = false;
    for (const sw of saids) {
      let j = 0, k = 0;
      while (k < words.length) {
        const from = k === 0 ? 0 : j;
        const limit = k === 0 ? sw.length : Math.min(sw.length, j + 3); // allow up to 2 dropped words
        let idx = -1;
        for (let x = from; x < limit; x++) if (sw[x] === words[k]) { idx = x; break; }
        if (idx < 0) break;
        j = idx + 1; k++;
      }
      if (k >= 2) { words = words.slice(k); changed = true; break; }
    }
  }
  return words.join(' ');
}

const STOP_WORDS = new Set(['stop', 'cancel', 'nevermind']);
const STOP_PHRASES = ['never mind', 'hang up', 'forget it'];
const GREETINGS = new Set(['hello', 'hi', 'hey', 'hiya', 'morning', 'evening', 'afternoon']);
const THANKS = ['thanks', 'thank you', 'cheers', 'ta'];
const CAPABILITY_QS = ['what can you do', 'help', 'what do you do'];

function detectSocial(norm) {
  const words = norm.split(' ');
  if (THANKS.some((t) => norm === t || norm.startsWith(t + ' '))) return 'thanks';
  if (CAPABILITY_QS.some((q) => norm.includes(q))) return 'help';
  if (GREETINGS.has(words[0]) || (words[0] === 'good' && GREETINGS.has(words[1]))) return 'greeting';
  return null;
}

export function parse(text, asrConfidence = 1) {
  const norm = normalize(text);
  const tokens = norm ? norm.split(' ') : [];
  let { markers, rest } = stripLeadingMarkers(tokens);

  // "Set a timer, I meant music": a mid-utterance self-correction keeps only what follows it.
  const mid = findAnywhereMarker(rest);
  if (mid) {
    markers.push({ phrase: mid.phrase, strength: mid.strength });
    rest = rest.slice(mid.index + mid.len);
  }

  const content = rest.filter((w) => !FILLER.has(w));
  // "Cancel the call" / "stop that": the words name the thing being cancelled, not a new request.
  let cancelObject = null;
  if (markers.length && content.length <= 1 && (content.length === 0 || CANCEL_OBJECTS.has(content[0]))) {
    cancelObject = content[0] || null;
  }

  const scores = cancelObject !== null || (markers.length && content.length === 0) ? {} : scoreTools(rest);
  const candidates = Object.entries(scores)
    .filter(([, s]) => s >= 0.2)
    .map(([tool, s]) => ({ tool, score: round(s * asrConfidence) }))
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const intent = top && top.score >= 0.3 ? buildIntent(top.tool, rest, top.score) : null;

  const strength = markers.length ? Math.max(...markers.map((m) => m.strength)) : 0;
  const kind = !markers.length ? null : markers.every((m) => STOP_MARKERS.has(m.phrase)) ? 'stop' : 'correct';
  return {
    raw: text,
    normalized: norm,
    empty: tokens.length === 0,
    // Part of the utterance was lost to noise: the user may have said more than we heard.
    masked: /\[[^\]]*\]/.test(String(text || '')) || asrConfidence < 0.7,
    repair: { detected: markers.length > 0, kind, markers: markers.map((m) => m.phrase), strength: round(strength * asrConfidence) },
    cancelObject,
    intent,
    candidates: candidates.slice(0, 3),
    yesNo: detectYesNo(norm),
    // "stop" anywhere in the utterance, not only at the start ("no timer stop").
    stopWord: tokens.some((t) => STOP_WORDS.has(t)) || STOP_PHRASES.some((ph) => (' ' + norm + ' ').includes(' ' + ph + ' ')),
    social: intent ? null : detectSocial(norm),
    minutes: extractMinutes(tokens),
    contact: extractContact(tokens),
    asrConfidence,
  };
}
