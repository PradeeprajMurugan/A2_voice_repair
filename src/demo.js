// Guided demo (the front page). Three short stories make Sous get something wrong on purpose,
// then walk a first-time user through fixing it. The buttons type the cook's words for them and
// feed the dialogue manager what a recogniser would plausibly have heard — so the mistake happens
// every time, with or without a microphone. A free-try tab uses the real microphone.
//
// The dialogue manager, policy and tools are exactly the ones the tests cover; only the
// presentation is new. Technical controls live on lab.html ("Behind the scenes").
import { realClock } from './clock.js';
import { createKitchen, cap } from './tools.js';
import { DialogueManager } from './dialogue.js';
import { createTts, createEarcons, createRecogniser } from './speech.js';
import { parse as ruleParse, stripEcho, normalize } from './parser.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GRACE_MS = 3000;
const OPTION_WORD = { set_timer: 'A timer', call_contact: 'A call', play_music: 'Music', add_to_list: 'Shopping list' };
const OPTION_SAY = { set_timer: 'a timer', call_contact: 'a call', play_music: 'music', add_to_list: 'shopping list' };

// ------------------------------------------------------------------ the stories
const STORIES = [
  {
    tab: '1 · It mishears you',
    steps: [
      {
        title: 'Ask for a timer',
        text: 'Your hands are covered in dough. Ask Sous for a ten-minute timer.',
        hint: 'Heads-up: Sous is going to mishear you. Be ready to interrupt it.',
        actions: [{ label: '🗣️ “Set a ten-minute timer”', you: 'Set a ten-minute timer', heard: 'call mom', asr: 0.92 }],
      },
      {
        title: 'Quick — interrupt it!',
        text: 'Sous heard “call Mom” and is dialling. A connected call can’t be undone, so Sous waits 3 seconds before connecting. Talk over it now.',
        actions: [{ label: '✋ “No, wait — a ten-minute timer!”', sub: 'Talk over Sous', you: 'No, wait — a ten-minute timer!', heard: 'no wait a ten minute timer', asr: 0.95, urgent: true }],
      },
    ],
    success: (w) => w.timers.some((t) => t.minutes === 10),
    why: 'A typical assistant keeps talking until it has finished. You would wait, say “cancel”, check the call really stopped, then ask for the timer again. Sous stops the moment you speak, undoes first, tells you what it undid, and takes your correction in the same breath.',
  },
  {
    tab: '2 · Noise eats your correction',
    steps: [
      {
        title: 'Ask for a timer',
        text: 'Same kitchen, same request: ask for a ten-minute timer.',
        hint: 'Sous will mishear you again. This time something goes wrong while you correct it.',
        actions: [{ label: '🗣️ “Set a ten-minute timer”', you: 'Set a ten-minute timer', heard: 'call mom', asr: 0.92 }],
      },
      {
        title: 'Interrupt — then a pan crashes',
        text: 'Talk over Sous again. Halfway through, you knock a pan off the counter.',
        actions: [{ label: '✋ “No, wait —” 💥 “…a timer!”', sub: 'The crash drowns out most of your words', you: 'No, wait — 💥 — a ten-minute timer!', heard: 'no wait [crash] imer', asr: 0.55, loudness: 0.9, crash: true, urgent: true }],
      },
      { answers: true },
    ],
    success: (w) => w.timers.length > 0,
    why: 'Most assistants answer a broken correction with “Sorry, I didn’t catch that” — and leave the wrong action running. Sous cancels first anyway, guesses from the fragment it did hear (“…imer”), and asks only for the piece it is missing, with buttons in case your hands are free.',
  },
  {
    tab: '3 · It asks before risky actions',
    steps: [
      {
        title: 'Ask through the noise',
        text: 'The extractor fan is roaring. Ask Sous for a five-minute timer.',
        hint: 'The fan muffles you, so Sous is unsure what it heard.',
        actions: [{ label: '🗣️ “Set a timer for five minutes”', you: 'Set a timer for five minutes', heard: 'call mom', asr: 0.7 }],
      },
      {
        title: 'Correct it in one go',
        text: 'Sous half-heard “call Mom”. A wrong call can’t be undone, so instead of dialling it asks first. Say what you really meant — no need to answer “no” separately.',
        actions: [{ label: '🗣️ “No — set a timer for five minutes”', you: 'No — set a timer for five minutes', heard: 'no set a timer for five minutes', asr: 0.95 }],
      },
    ],
    success: (w) => w.timers.some((t) => t.minutes === 5),
    why: 'Sous does not ask about everything — that would be tiring. It weighs how sure it is against how costly a mistake would be: a timer it would just set (easy to undo), but an uncertain phone call gets a quick question first.',
  },
  { tab: 'Try it yourself', free: true },
];

const ANSWER_TEXT = {
  choice: ['Answer its guess', 'The crash swallowed most of your words, but Sous still cancelled the call. Instead of “please repeat that”, it offers its best guess. Answer it.'],
  open: ['Tell it what you wanted', 'Sous stopped and undid the action. Tell it what you wanted instead.'],
  slot: ['One missing detail', 'Sous now knows you want a timer. It asks only for the part it didn’t catch.'],
  confirm: ['Answer the question', 'Sous wants a quick yes or no before doing something it can’t undo.'],
};

// ------------------------------------------------------------------ speech
const tts = createTts();
const earcons = createEarcons();
let soundOn = true;
let audioCtx = null;
function crashSound() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const len = audioCtx.sampleRate * 0.6;
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = audioCtx.createBufferSource();
    const g = audioCtx.createGain(); g.gain.value = 0.5;
    src.buffer = buf; src.connect(g).connect(audioCtx.destination); src.start();
  } catch { /* no audio */ }
}

// ------------------------------------------------------------------ session state
let dm, kitchen, story = 0, step = 0, finished = null, flashStop = -Infinity, fakeSpeech = null;
let lastYou = null; // { you, heard }
let lastActionAt = 0;
const done = new Set();
const params = new URLSearchParams(location.search);
const auto = params.has('auto');

function build() {
  if (dm) dm.stopSpeech('reset');
  tts.stop();
  clearTimeout(fakeSpeech);
  kitchen = createKitchen(realClock);
  dm = new DialogueManager({
    clock: realClock,
    kitchen,
    parseFn: ruleParse,
    io: {
      speak: (text, onEnd) => {
        if (soundOn) return tts.speak(text, onEnd);
        fakeSpeech = setTimeout(onEnd, text.length * 55); // same pacing, silently
      },
      stopSpeaking: () => { tts.stop(); clearTimeout(fakeSpeech); },
      earcon: (k) => { if (soundOn) earcons.play(k); if (k === 'stop') flashStop = performance.now(); },
      onUpdate: () => render(),
    },
  });
  step = 0; finished = null; lastYou = null;
  render();
}

function choose(i) {
  story = i;
  try { history.replaceState(null, '', `?story=${i + 1}`); } catch { /* file:// */ }
  if (micOn) toggleMic();
  build();
}

// The cook "says" something: show their words, then give the dialogue manager what was heard.
function speakAs(a) {
  lastYou = { you: a.you, heard: a.heard };
  lastActionAt = performance.now();
  if (a.crash) {
    crashSound();
    $('youBubble').classList.remove('shake'); void $('youBubble').offsetWidth; $('youBubble').classList.add('shake');
  }
  dm.hear({ text: a.heard, asrConfidence: a.asr ?? 0.95, loudness: a.loudness ?? 0.5, source: 'typed' });
}

// ------------------------------------------------------------------ rendering
function render() {
  if (!dm) return;
  const v = dm.view();
  const s = STORIES[story];
  renderTabs();
  renderScene(v);
  if (s.free) renderFree(v);
  else { checkEnd(v, s); renderGuide(v, s); }
  renderThinking(v.events);
}

function renderTabs() {
  const html = STORIES.map((s, i) => `<button class="tab" role="tab" aria-selected="${i === story}" data-i="${i}">${esc(s.tab)}${done.has(i) ? '<span class="done">✓</span>' : ''}</button>`).join('');
  const tabs = $('tabs');
  if (tabs.dataset.html !== html) {
    tabs.innerHTML = html; tabs.dataset.html = html;
    tabs.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => choose(Number(b.dataset.i))));
  }
}

function mood(v) {
  const call = v.world.call;
  if (performance.now() - flashStop < 900) return ['stopped', 'stopped', '✋ Stopped — and undone'];
  if (call && call.status === 'connected') return ['idle', 'bad', `📞 Connected to ${cap(call.name)} — too late to undo`];
  if (v.state === 'announcing' && call?.status === 'dialling') {
    const left = Math.max(0, (call.startedAt + GRACE_MS - performance.now()) / 1000);
    return ['announcing', 'announcing', `Calling ${cap(call.name)} in ${left.toFixed(1)} s — interrupt to cancel`];
  }
  if (v.speaking) return ['speaking', '', 'Sous is talking — you can talk over it'];
  if (v.state === 'confirming' || v.state === 'clarifying') return ['waiting', 'waiting', 'Your turn — Sous is waiting for your answer'];
  if (finished === 'good') return ['idle', 'good', '✓ Done'];
  return ['idle', '', micOn ? '🎙 Listening…' : 'Ready'];
}

function renderScene(v) {
  const [dev, cls, text] = mood(v);
  $('device').className = 'device ' + dev;
  $('status').className = 'status ' + cls;
  $('statusText').textContent = text;
  $('sousText').textContent = v.lastSaid || '…';
  $('sousText').className = v.lastSaid ? '' : 'quiet';

  if (lastYou) {
    $('youBubble').hidden = false;
    $('youText').textContent = lastYou.you;
    const differs = lastYou.heard !== null && normalize(lastYou.heard) !== normalize(lastYou.you);
    $('heardLine').hidden = !differs;
    $('heardLine').className = 'heard wrong';
    if (differs) $('heardText').innerHTML = esc(lastYou.heard).replace(/\[crash\]/g, '<span class="crash">crash</span>');
  } else $('youBubble').hidden = true;

  const w = v.world, now = performance.now();
  const call = w.call;
  const phone = $('phoneItem');
  phone.className = 'item';
  $('phoneBar').hidden = true;
  if (!call) $('phoneText').innerHTML = '<span class="muted">Idle</span>';
  else if (call.status === 'dialling') {
    phone.classList.add('hot');
    $('phoneText').innerHTML = `Dialling <b>${esc(cap(call.name))}</b>…`;
    $('phoneBar').hidden = false;
    $('phoneBar').firstElementChild.style.width = Math.min(100, ((now - call.startedAt) / GRACE_MS) * 100) + '%';
  } else if (call.status === 'connected') {
    phone.classList.add('bad');
    $('phoneText').innerHTML = `On a call with <b>${esc(cap(call.name))}</b>`;
  } else {
    if (!call.connectedAt) phone.classList.add('good');
    $('phoneText').innerHTML = call.connectedAt ? `Call to ${esc(cap(call.name))} ended` : `Call to ${esc(cap(call.name))} <b>cancelled</b> — never connected`;
  }
  $('timerItem').className = 'item' + (w.timers.length ? ' good' : '');
  $('timerText').innerHTML = w.timers.length
    ? w.timers.map((t) => {
      const left = Math.max(0, t.minutes * 60 - (now - t.startedAt) / 1000);
      return `<b>${t.minutes} min</b> · ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} left`;
    }).join('<br>')
    : '<span class="muted">None</span>';
  $('musicItem').className = 'item' + (w.music ? ' good' : '');
  $('musicText').innerHTML = w.music ? `Playing <b>${esc(w.music.genre)}</b>` : '<span class="muted">Off</span>';
  $('listText').innerHTML = w.list.length ? w.list.map((x) => esc(x.item)).join(', ') : '<span class="muted">Empty</span>';
}

function checkEnd(v, s) {
  if (finished) return;
  const call = v.world.call;
  if (call && call.status === 'connected') { finished = 'bad'; return; }
  if (s.success(v.world) && !v.speaking && v.state === 'idle') { finished = 'good'; done.add(story); return; }
  // Ran out of steps and Sous is no longer waiting for anything: it went another way.
  // (Checked only once the turn has settled: mid-turn updates can look idle for a moment.)
  if (performance.now() - lastActionAt > 600 && step >= s.steps.length && v.state === 'idle' && !v.speaking && !s.success(v.world)) finished = 'bad';
}

function setHtml(el, html, bind) {
  if (el.dataset.html === html) return;
  el.innerHTML = html; el.dataset.html = html;
  bind && bind(el);
}

function answerButtons(v) {
  const p = v.pending;
  if (v.state === 'confirming') return [{ label: 'Yes', you: 'Yes', heard: 'yes' }, { label: 'No', you: 'No', heard: 'no' }];
  if (v.state !== 'clarifying' || !p) return [];
  if (p.kind === 'slot' && p.slot === 'minutes') return [5, 10, 15, 20].map((m) => ({ label: `${m} min`, you: `${m} minutes`, heard: `${m} minutes`, auto: m === 10 }));
  if (p.options?.length === 1) {
    return [{ label: 'Yes', you: 'Yes', heard: 'yes', auto: true }, { label: 'No', you: 'No', heard: 'no' }];
  }
  return (p.options || []).map((o) => ({ label: OPTION_WORD[o], you: OPTION_WORD[o], heard: OPTION_SAY[o], auto: o === 'set_timer' }));
}

let autoTimer = null;
function renderGuide(v, s) {
  $('free').hidden = true;
  const out = $('outcome');
  if (finished) {
    $('stepCount').textContent = finished === 'good' ? 'Story complete' : 'Not quite';
    $('stepTitle').textContent = finished === 'good' ? 'What just happened' : 'That went differently';
    $('stepText').textContent = '';
    setHtml($('actions'), '');
    out.hidden = false;
    out.className = 'outcome ' + finished;
    const next = story + 1 < STORIES.length ? `<button class="next" data-go="${story + 1}">Next: ${esc(STORIES[story + 1].tab.replace(/^\d · /, ''))} →</button>` : '';
    const html = finished === 'good'
      ? `<ul>${whatHappened(v.events).map((x) => `<li>${x}</li>`).join('')}</ul><p class="why"><b>Why it matters:</b> ${esc(s.why)}</p>${next}<button class="again">Play again</button>`
      : `<p>${badReason(v)}</p><button class="next again-primary">Try again</button>`;
    setHtml(out, html, (el) => {
      el.querySelector('[data-go]')?.addEventListener('click', (e) => choose(Number(e.target.dataset.go)));
      el.querySelector('.again')?.addEventListener('click', () => build());
      el.querySelector('.again-primary')?.addEventListener('click', () => build());
    });
    return;
  }
  out.hidden = true; out.dataset.html = '';
  const st = s.steps[Math.min(step, s.steps.length - 1)];
  const n = s.steps.length;
  $('stepCount').textContent = `Step ${Math.min(step + 1, n)} of ${n}`;
  let title = st.title, text = esc(st.text || ''), acts = st.actions || [];
  if (st.answers) {
    const kind = v.state === 'confirming' ? 'confirm' : v.pending?.kind || 'choice';
    [title, text] = ANSWER_TEXT[kind] || ANSWER_TEXT.choice;
    text = esc(text);
    acts = answerButtons(v);
    if (!acts.length) text += '<span class="hint">Listen to Sous…</span>';
  }
  if (st.hint) text += `<span class="hint">${esc(st.hint)}</span>`;
  $('stepTitle').textContent = title;
  $('stepText').innerHTML = text;
  const row = st.answers;
  const html = (row ? '<div class="answer-row">' : '') + acts.map((a, i) =>
    `<button class="act${a.urgent ? ' urgent' : ''}" data-i="${i}">${esc(a.label)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</button>`).join('') + (row ? '</div>' : '');
  setHtml($('actions'), html, (el) => el.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => {
    const a = acts[Number(b.dataset.i)];
    if (!st.answers) step++;
    speakAs(a);
  })));
  // ?auto: click through the story by itself (for screenshots and hands-free demos).
  if (auto && acts.length && !autoTimer) {
    const pick = acts.findIndex((a) => a.auto); const i = pick >= 0 ? pick : 0;
    autoTimer = setTimeout(() => { autoTimer = null; $('actions').querySelector(`.act[data-i="${i}"]`)?.click(); }, step === 0 ? 900 : 1300);
  }
}

function whatHappened(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'interruption' && (e.kind === 'barge_in' || e.kind === 'safe_pause')) out.push('You talked over Sous, and it <b>stopped speaking at once</b>.');
    if (e.type === 'undo' && e.result.ok) out.push(`It <b>undid the wrong action first</b> — in ${e.latencyMs} ms — and said what it undid${e.result.beforeConnect ? ' (the call never connected)' : ''}.`);
    if (e.type === 'decision' && e.decision === 'confirm') out.push('It was unsure, and a call can’t be undone, so it <b>asked before dialling</b>.');
    if ((e.type === 'decision' && e.decision === 'ask_choice') || (e.type === 'say' && /^.*Did you want/.test(e.text) && !/instead/.test(e.text))) out.push('Noise swallowed your correction, so it <b>offered its best guess</b> instead of “please repeat”.');
    if (e.type === 'decision' && e.decision === 'ask_slot') out.push('It <b>asked only for the missing detail</b>.');
    if (e.type === 'tool_result' && e.result.ok && e.result.tool === 'set_timer') out.push(`Your <b>${e.result.minutes}-minute timer</b> is running — you never had to start over.`);
  }
  return [...new Set(out)];
}

function badReason(v) {
  const call = v.world.call;
  if (call && call.status === 'connected') return `Too late — the call to ${esc(cap(call.name))} connected. Sous gives you 3 seconds before connecting a call because once it connects, “stop” can only hang up. Try again and interrupt sooner.`;
  return 'Sous ended up somewhere else this time. Try again.';
}

// ------------------------------------------------------------------ free try
const TRY = ['hello', 'call mom', 'no wait, a ten minute timer', 'play some jazz', 'stop the music', 'add eggs to the shopping list'];
function renderFree(v) {
  $('outcome').hidden = true;
  setHtml($('actions'), answerButtons(v).length
    ? '<div class="answer-row">' + answerButtons(v).map((a, i) => `<button class="act" data-i="${i}">${esc(a.label)}</button>`).join('') + '</div>' : '',
  (el) => el.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => speakAs(answerButtons(dm.view())[Number(b.dataset.i)]))));
  $('free').hidden = false;
  $('stepCount').textContent = 'Free play';
  $('stepTitle').textContent = 'Talk to Sous yourself';
  $('stepText').innerHTML = 'Press the button and speak, or type. Ask for something, then interrupt it with “no, wait…” or “stop” while it is talking.';
  setHtml($('tryList'), '<span class="small muted">Ideas:</span>' + TRY.map((t) => `<button data-say="${esc(t)}">${esc(t)}</button>`).join(''),
    (el) => el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => speakAs({ you: b.dataset.say, heard: b.dataset.say }))));
}

$('sayForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('sayInput').value.trim();
  if (t) speakAs({ you: t, heard: t });
  $('sayInput').value = '';
});

let micOn = false;
const rec = createRecogniser({
  cleanEcho: (text) => stripEcho(text, dm.recentSpeech()),
  onStatus: () => {},
  onInterim: (text) => {
    lastYou = { you: text + '…', heard: null };
    if (dm.speaking) dm.stopSpeech('user started speaking (interim result)');
    render();
  },
  onFinal: ({ text, asrConfidence }) => {
    lastYou = { you: text, heard: null };
    dm.hear({ text, asrConfidence, loudness: 0.5, source: 'mic' });
  },
});
function toggleMic() {
  if (!rec.available) { alert('Talking needs Chrome or Edge. You can still type.'); return; }
  micOn = !micOn;
  micOn ? rec.start() : rec.stop();
  $('micBtn').setAttribute('aria-pressed', String(micOn));
  $('micBtn').textContent = micOn ? '⏹ Stop listening' : '🎙 Start talking';
  render();
}
$('micBtn').addEventListener('click', toggleMic);

// ------------------------------------------------------------------ thinking panel
const PLAIN = {
  act: 'Sure, and easy to undo → just do it',
  act_with_grace: 'Sure, but a call can’t be undone → announce it and wait 3 s before connecting',
  confirm: 'Not sure, and a call can’t be undone → ask first',
  ask_slot: 'Missing one detail → ask for just that',
  ask_choice: 'Couldn’t make out the request → offer best guesses',
  decline: 'Not something I can do → say what I can do',
};
function renderThinking(events) {
  if (!$('thinkingBox').open) return;
  const items = [];
  for (const e of events) {
    if (e.type === 'heard') items.push(`<span class="k">Heard</span> “${esc(e.text)}” (sure: ${Math.round(e.asrConfidence * 100)}%)`);
    else if (e.type === 'echo_removed') items.push(`<span class="k">Ignored my own voice</span> in “${esc(e.heard)}”`);
    else if (e.type === 'interruption' && (e.kind === 'barge_in' || e.kind === 'safe_pause')) items.push('<span class="k">You interrupted</span> → stop talking and undo');
    else if (e.type === 'interruption' && e.kind === 'below_criterion') items.push('<span class="k">Maybe a “stop”?</span> Not sure enough to cut the music → kept going');
    else if (e.type === 'undo' && e.result.ok) items.push(`<span class="k">Undid it</span> in ${e.latencyMs} ms`);
    else if (e.type === 'decision') items.push(`<span class="k">Decided</span>: ${esc(PLAIN[e.decision] || e.decision)}`);
    else if (e.type === 'committed') items.push('<span class="k">Call connected</span> — can no longer be undone');
    else if (e.type === 'timeout') items.push('<span class="k">No answer</span> → said so out loud instead of going silent');
  }
  setHtml($('thinking'), items.map((x) => `<li>${x}</li>`).join('') || '<li class="muted">Nothing yet</li>');
}
$('thinkingBox').addEventListener('toggle', render);

$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  if (!soundOn) tts.stop();
  $('soundBtn').setAttribute('aria-pressed', String(soundOn));
  $('soundBtn').textContent = soundOn ? '🔊 Sound on' : '🔇 Sound off';
});

// Countdown bars and timers move between events.
setInterval(render, 100);

const startAt = Number(params.get('story')) - 1;
choose(startAt >= 0 && startAt < STORIES.length ? startAt : 0);
