// Browser wiring: speech I/O, simulated noise, rendering and live scenario replay.
import { realClock } from './clock.js';
import { createKitchen, cap } from './tools.js';
import { DialogueManager } from './dialogue.js';
import { simulateAsr } from './asr_sim.js';
import { createTts, createEarcons, createRecogniser, makeEchoFilter } from './speech.js';
import { parse as ruleParse } from './parser.js';
import { makeLlmParser } from './llm_parser.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const OPTION_LABEL = { set_timer: 'Timer', call_contact: 'Call', play_music: 'Music', add_to_list: 'Shopping list' };

const tts = createTts();
const earcons = createEarcons();
let dm, kitchen, view, flashStop = 0, replayTimers = [];
let parseFn = ruleParse;

// ------------------------------------------------------------------ setup / reset
function build() {
  replayTimers.forEach(clearTimeout); replayTimers = [];
  if (dm) dm.stopSpeech('reset');
  tts.stop();
  kitchen = createKitchen(realClock);
  dm = new DialogueManager({
    clock: realClock,
    kitchen,
    parseFn: (text, conf) => parseFn(text, conf),
    io: {
      speak: (text, onEnd) => tts.speak(text, onEnd),
      stopSpeaking: () => tts.stop(),
      earcon: (k) => { earcons.play(k); if (k === 'stop') flashStop = performance.now(); },
      onUpdate: (v) => { view = v; render(); },
    },
  });
  view = dm.view();
  render();
}

// ------------------------------------------------------------------ input
function sayTyped(text) {
  if (!text.trim()) return;
  const noise = Number(document.querySelector('input[name="noise"]:checked').value);
  const pan = $('panDrop').checked;
  $('panDrop').checked = false;
  const heard = simulateAsr(text, { noise, panDrop: pan });
  if (heard.text !== text) dm.log('note', { kind: 'typed', text: `You typed “${text}” · recogniser got it through ${heard.simulated} noise` });
  dm.hear({ text: heard.text, asrConfidence: heard.asrConfidence, loudness: heard.loudness, source: 'typed' });
}

$('sayForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sayTyped($('sayInput').value);
  $('sayInput').value = '';
});
document.querySelectorAll('.q').forEach((b) => b.addEventListener('click', () => sayTyped(b.dataset.say)));

const rec = createRecogniser({
  isEcho: makeEchoFilter(() => (dm.speaking ? dm.lastSaid : '')),
  onStatus: (s) => { $('micBtn').title = 'Microphone: ' + s; },
  onInterim: (text) => {
    $('interim').textContent = 'hearing: ' + text + '…';
    // Yield the floor as soon as the user starts a turn, before the final transcript (L07).
    if (dm.speaking) dm.stopSpeech('user started speaking (interim result)');
  },
  onFinal: ({ text, asrConfidence }) => {
    $('interim').textContent = '';
    dm.hear({ text, asrConfidence, loudness: 0.5, source: 'mic' });
  },
});
let micOn = false;
$('micBtn').addEventListener('click', () => {
  if (!rec.available) { alert('Speech recognition needs Chrome or Edge. Typed input still works.'); return; }
  micOn = !micOn;
  micOn ? rec.start() : rec.stop();
  $('micBtn').setAttribute('aria-pressed', String(micOn));
  $('micBtn').textContent = micOn ? '🎙 Mic on' : '🎙 Mic off';
});

// ------------------------------------------------------------------ rendering
function turnInfo(v) {
  const call = v.world.call;
  if (performance.now() - flashStop < 700) return ['stopped', 'Stopped', 'Undone straight away'];
  if (v.speaking) return ['speaking', 'Speaking', 'Talk over me to interrupt'];
  if (v.state === 'announcing' && call?.status === 'dialling') {
    const left = Math.max(0, (call.startedAt + 3000 - performance.now()) / 1000);
    return ['announcing', `Calling ${cap(call.name)} in ${left.toFixed(1)} s`, 'Say “stop” or “no, wait” to cancel'];
  }
  if (v.state === 'confirming') return ['confirming', 'Waiting for you', 'Say yes or no'];
  if (v.state === 'clarifying') return ['clarifying', 'Waiting for you', 'Pick an option below or say it'];
  return ['idle', micOn ? 'Listening' : 'Ready', micOn ? 'Go ahead' : 'Say or type a request'];
}

function renderKitchen(w) {
  const now = performance.now();
  const card = $('callCard');
  if (!w.call || w.call.status === 'ended') {
    card.classList.remove('hot');
    $('callBody').innerHTML = w.call ? `<span class="muted">Call to ${esc(cap(w.call.name))} ended${w.call.connectedAt ? '' : ' — never connected'}</span>` : '<span class="muted">No call</span>';
  } else if (w.call.status === 'dialling') {
    card.classList.add('hot');
    const pct = Math.min(100, ((now - w.call.startedAt) / 3000) * 100);
    $('callBody').innerHTML = `Dialling <b>${esc(cap(w.call.name))}</b> — not connected yet<div class="bar"><span style="width:${pct}%"></span></div>`;
  } else {
    card.classList.add('hot');
    $('callBody').innerHTML = `On a call with <b>${esc(cap(w.call.name))}</b> · ${Math.round((now - w.call.connectedAt) / 1000)} s`;
  }
  $('timers').innerHTML = w.timers.length
    ? w.timers.map((t) => {
      const left = Math.max(0, t.minutes * 60 - (now - t.startedAt) / 1000);
      return `<li>${t.minutes} min — ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} left</li>`;
    }).join('')
    : '<li class="muted">None</li>';
  $('music').innerHTML = w.music ? `Playing <b>${esc(w.music.genre)}</b>` : '<span class="muted">Off</span>';
  $('shopping').innerHTML = w.list.length ? w.list.map((x) => `<li>${esc(x.item)}</li>`).join('') : '<li class="muted">Empty</li>';
}

function heardHtml(text) {
  return esc(text).replace(/\[(noise|crash|shout)\]/g, '<span class="mask" title="lost to $1">$1</span>');
}

let renderedEvents = -1;
function renderTranscript(events) {
  if (events.length === renderedEvents) return;
  renderedEvents = events.length;
  const out = [];
  for (const e of events) {
    if (e.type === 'heard') {
      out.push(`<div class="msg user">${heardHtml(e.text) || '<i>(unintelligible)</i>'}<span class="meta">${e.source} · confidence ${e.asrConfidence.toFixed(2)}${e.loudness >= 0.7 ? ' · loud' : ''}</span></div>`);
    } else if (e.type === 'say') {
      out.push(`<div class="msg bot">${esc(e.text)}</div>`);
    } else if (e.type === 'undo' && e.result.ok) {
      out.push(`<div class="note undo">⟲ undone in ${e.latencyMs} ms</div>`);
    } else if (e.type === 'interruption' && e.kind === 'below_criterion') {
      out.push(`<div class="note">heard a possible “stop” (evidence ${e.evidence}) below the ${e.criterion} threshold for this action — kept going</div>`);
    } else if (e.type === 'note') {
      out.push(`<div class="note ${e.kind === 'intended' ? 'intended' : ''}">${esc(e.text)}</div>`);
    }
  }
  const box = $('transcript');
  box.innerHTML = out.join('');
  box.scrollTop = box.scrollHeight;
}

function renderWhy(events) {
  const items = [];
  for (const e of events) {
    if (e.type === 'decision') {
      const cls = e.decision.startsWith('act') ? 'act' : e.decision.startsWith('ask') || e.decision === 'confirm' ? 'ask' : '';
      items.push(`<li><span class="k ${cls}">${e.decision}</span> — ${esc(e.reason)}</li>`);
    } else if (e.type === 'interruption' && e.kind !== 'new_command' && e.kind !== 'ignore') {
      const cls = e.kind === 'barge_in' || e.kind === 'safe_pause' ? 'stop' : '';
      items.push(`<li><span class="k ${cls}">${e.kind.replace('_', ' ')}</span> — ${esc(e.reason)}</li>`);
    } else if (e.type === 'tool_result' && !e.result.ok) {
      items.push(`<li><span class="k">check failed (${e.result.check})</span> — ${esc(e.result.reason)}</li>`);
    } else if (e.type === 'timeout') {
      items.push(`<li><span class="k">timeout</span> — no answer, ended out loud instead of silently</li>`);
    } else if (e.type === 'parsed' && e.parser && e.parser !== 'rules') {
      items.push(`<li><span class="k">parser</span> — ${esc(e.parser)}</li>`);
    }
  }
  $('why').innerHTML = items.slice(-14).join('') || '<li class="muted">Nothing yet</li>';
  $('why').scrollTop = $('why').scrollHeight;
}

function renderChips(v) {
  const box = $('chips');
  const opts = v.state === 'clarifying' ? (v.pending?.options || []) : [];
  let html = opts.map((o) => `<button class="chip" data-say="${esc(OPTION_LABEL[o].toLowerCase())}">${OPTION_LABEL[o]}</button>`).join('');
  if (v.state === 'confirming') html = '<button class="chip" data-say="yes">Yes</button><button class="chip" data-say="no">No</button>';
  if (v.state === 'clarifying' && v.pending?.kind === 'slot' && v.pending.slot === 'minutes')
    html = [5, 10, 15, 20].map((m) => `<button class="chip" data-say="${m} minutes">${m} min</button>`).join('');
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
    box.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => sayTyped(b.dataset.say)));
  }
}

function render() {
  if (!view) return;
  const [cls, label, hint] = turnInfo(view);
  $('turn').className = 'turn ' + cls;
  $('turnLabel').textContent = label;
  $('turnHint').textContent = hint;
  $('lastSaid').textContent = view.lastSaid ? `“${view.lastSaid}”` : '';
  renderKitchen(view.world);
  renderTranscript(view.events);
  renderWhy(view.events);
  renderChips(view);
}
setInterval(() => { if (dm) { view = dm.view(); render(); } }, 150); // countdowns

// ------------------------------------------------------------------ replay
let scenarios = [];
async function loadScenarios() {
  const names = await (await fetch('scenarios/index.json')).json();
  scenarios = await Promise.all(names.map(async (n) => (await fetch('scenarios/' + n)).json()));
  $('scenario').innerHTML = scenarios.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join('');
  showStory();
}
function showStory() { const s = scenarios[$('scenario').value]; $('story').textContent = s ? s.story : ''; }
$('scenario').addEventListener('change', showStory);
$('playBtn').addEventListener('click', () => {
  const s = scenarios[$('scenario').value];
  if (!s) return;
  build();
  dm.log('note', { kind: 'scenario', text: `Replay: ${s.title}` });
  for (const step of s.steps) {
    if (step.heard === undefined) continue;
    replayTimers.push(setTimeout(() => {
      if (step.intended) dm.log('note', { kind: 'intended', text: `(user actually said: “${step.intended}”)` });
      dm.hear({ text: step.heard, asrConfidence: step.asr ?? 1, loudness: step.loudness ?? 0.5, source: 'replay' });
    }, step.at));
  }
});
$('resetBtn').addEventListener('click', build);
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(dm.events, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `sous-log-${Date.now()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------------------ optional LLM parser
makeLlmParser().then((llm) => {
  if (llm) { parseFn = llm; $('parserBadge').textContent = 'Parser: LLM + rules fallback'; }
});

build();
loadScenarios();
