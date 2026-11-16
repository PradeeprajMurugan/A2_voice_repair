// Scenario replay + unit tests. Runs in the browser (tests.html) with a FakeClock, so every
// run is deterministic and needs no microphone, speaker or API key.

import { FakeClock } from '../src/clock.js';
import { createKitchen, checkShape } from '../src/tools.js';
import { DialogueManager } from '../src/dialogue.js';
import { parse } from '../src/parser.js';
import { decide, classifyInterruption } from '../src/policy.js';

export const MS_PER_CHAR = 60; // simulated speaking rate (~16 chars/s)

export function makeFakeIO(clock) {
  let current = null;
  return {
    said: [],
    earcons: [],
    speak(text, onEnd) {
      this.said.push(text);
      current = clock.setTimeout(() => { current = null; onEnd(); }, text.length * MS_PER_CHAR);
    },
    stopSpeaking() { if (current !== null) clock.clearTimeout(current); current = null; },
    earcon(kind) { this.earcons.push({ t: clock.now(), kind }); },
    onUpdate() {},
  };
}

export function get(obj, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function runScenario(sc, { parseFn } = {}) {
  const clock = new FakeClock();
  const kitchen = createKitchen(clock);
  const io = makeFakeIO(clock);
  const dm = new DialogueManager({ clock, kitchen, io, ...(parseFn ? { parseFn } : {}) });
  for (const step of [...sc.steps].sort((a, b) => a.at - b.at)) {
    clock.advance(step.at - clock.now());
    if (step.heard !== undefined) {
      dm.hear({ text: step.heard, asrConfidence: step.asr ?? 1, loudness: step.loudness ?? 0.5, source: 'replay' });
    }
  }
  const world = kitchen.snapshot();
  const said = dm.events.filter((e) => e.type === 'say').map((e) => e.text);
  const checks = sc.expect.map((x) => checkExpectation(x, { dm, world, said }));
  return { id: sc.id, title: sc.title, passed: checks.every((c) => c.ok), checks, events: dm.events, said, world };
}

function checkExpectation(x, { dm, world, said }) {
  if (x.said !== undefined) {
    return { desc: `said "${x.said}"`, ok: said.includes(x.said), actual: said };
  }
  if (x.state !== undefined) {
    return { desc: `final state ${x.state}`, ok: dm.state === x.state, actual: dm.state };
  }
  if (x.world !== undefined) {
    const v = get(world, x.world);
    return { desc: `world.${x.world} = ${JSON.stringify(x.equals)}`, ok: same(v ?? null, x.equals), actual: v };
  }
  if (x.event !== undefined) {
    const evs = dm.events.filter((e) => e.type === x.event);
    if (x.count !== undefined) return { desc: `${x.count} × ${x.event}`, ok: evs.length === x.count, actual: evs.length };
    if (x.path === undefined && x.min !== undefined) return { desc: `≥${x.min} × ${x.event}`, ok: evs.length >= x.min, actual: evs.length };
    const pick = x.nth !== undefined ? [evs[x.nth]].filter(Boolean) : evs;
    const test = (e) => {
      const v = get(e, x.path);
      if (x.equals !== undefined) return same(v, x.equals);
      if (x.max !== undefined) return typeof v === 'number' && v <= x.max;
      if (x.min !== undefined) return typeof v === 'number' && v >= x.min;
      return v !== undefined;
    };
    const desc = `${x.event}${x.nth !== undefined ? `[${x.nth}]` : ''}.${x.path} ${x.equals !== undefined ? '= ' + JSON.stringify(x.equals) : x.max !== undefined ? '≤ ' + x.max : '≥ ' + x.min}`;
    return { desc, ok: pick.some(test), actual: pick.map((e) => get(e, x.path)) };
  }
  return { desc: 'unknown expectation ' + JSON.stringify(x), ok: false };
}

// ------------------------------------------------------------------------- unit tests
function eq(actual, expected, msg) {
  if (!same(actual, expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export const UNIT_TESTS = [
  ['parser: leading correction + new request in one breath', () => {
    const p = parse('No, wait, stop! Set a ten minute timer', 0.9);
    eq(p.repair.detected, true, 'repair');
    eq(p.repair.kind, 'correct', 'kind');
    eq(p.intent.tool, 'set_timer', 'tool');
    eq(p.intent.args.minutes, 10, 'minutes');
  }],
  ['parser: noise-clipped fragment becomes a candidate, not an intent', () => {
    const p = parse('no wait [crash] imer', 0.55);
    eq(p.intent, null, 'intent');
    eq(p.candidates[0]?.tool, 'set_timer', 'candidate');
    eq(p.masked, true, 'masked');
  }],
  ['parser: "stop the music" names the object, no new request', () => {
    const p = parse('stop the music', 0.95);
    eq(p.repair.kind, 'stop', 'kind');
    eq(p.cancelObject, 'music', 'object');
    eq(p.intent, null, 'intent');
  }],
  ['parser: mid-utterance self-correction keeps what follows', () => {
    const p = parse('set a timer, I meant play jazz');
    eq(p.repair.detected, true, 'repair');
    eq(p.intent.tool, 'play_music', 'tool');
    eq(p.intent.args.genre, 'jazz', 'genre');
  }],
  ['parser: compound numbers and list items', () => {
    eq(parse('set a timer for twenty five minutes').intent.args.minutes, 25, 'minutes');
    eq(parse('add eggs to the shopping list').intent.args.item, 'eggs', 'item');
    eq(parse('call mum').intent.args.name, 'mom', 'alias');
  }],
  ['policy: confidence x cost', () => {
    eq(decide(parse('call mom', 0.92)).decision, 'act_with_grace', 'high conf call');
    eq(decide(parse('call mom', 0.7)).decision, 'confirm', 'medium conf call');
    eq(decide(parse('set a timer for 5 minutes', 0.7)).decision, 'act', 'medium conf timer');
    eq(decide(parse('set a timer')).decision, 'ask_slot', 'missing minutes');
    eq(decide(parse('blah')).decision, 'decline', 'nothing');
  }],
  ['policy: same evidence, different criterion per action cost', () => {
    const p = parse('no', 0.5); // evidence 0.4
    eq(classifyInterruption(p, 'high').kind, 'barge_in', 'eager during call');
    eq(classifyInterruption(p, 'low').kind, 'below_criterion', 'cautious during music');
  }],
  ['tools: shape check rejects bad calls', () => {
    eq(checkShape({ tool: 'set_timer', args: { minutes: 0 } }).ok, false, 'min');
    eq(checkShape({ tool: 'launch_rocket', args: {} }).ok, false, 'unknown tool');
    eq(checkShape({ tool: 'set_timer', args: { minutes: 5, loud: true } }).ok, false, 'extra arg');
    eq(checkShape({ tool: 'call_contact', args: { name: 'boss' } }).ok, false, 'not a contact');
  }],
  ['tools: idempotency blocks a repeated request, undo reports the truth', () => {
    const clock = new FakeClock();
    const k = createKitchen(clock);
    const r1 = k.execute({ tool: 'set_timer', args: { minutes: 5 } });
    eq(k.execute({ tool: 'set_timer', args: { minutes: 5 } }).check, 'idempotency', 'duplicate');
    clock.advance(3500);
    const c = k.execute({ tool: 'call_contact', args: { name: 'sam' } });
    clock.advance(4000); // past the grace window: connected
    eq(k.undoAction(c).beforeConnect, false, 'hung up after connecting');
    eq(k.undoAction(r1).ok, true, 'timer undo');
    eq(k.undoAction(r1).ok, false, 'second undo is stale');
  }],
  ['dialogue: "cancel" with nothing running says so', () => {
    const clock = new FakeClock();
    const io = makeFakeIO(clock);
    const dm = new DialogueManager({ clock, kitchen: createKitchen(clock), io });
    dm.hear({ text: 'cancel' });
    eq(io.said, ["There's nothing to cancel right now."], 'said');
  }],
];

// ------------------------------------------------------------- model-path tests (fake model)
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function rig(llm) {
  const clock = new FakeClock();
  const io = makeFakeIO(clock);
  const dm = new DialogueManager({ clock, kitchen: createKitchen(clock), io, llm });
  return { clock, io, dm };
}

UNIT_TESTS.push(
  ['model: fills in a request the rules are unsure about', async () => {
    const { dm, io } = rig(async () => ({ tool: 'set_timer', args: { minutes: 12 }, confidence: 0.95, alternatives: [] }));
    dm.hear({ text: 'can you put something on for the bread, twelve minutes' });
    await flush();
    eq(io.said.at(-1), 'Timer set for 12 minutes.', 'said');
  }],
  ['model: undo happens before the model is even asked', async () => {
    const { dm, io, clock } = rig(async () => ({ tool: 'set_timer', args: {}, confidence: 0.9, alternatives: [] }));
    dm.hear({ text: 'call mom', asrConfidence: 0.92 });
    clock.advance(400);
    dm.hear({ text: 'no wait, the thing for the oven', asrConfidence: 0.9 });
    const types = dm.events.map((e) => e.type);
    eq(types.indexOf('undo') < types.lastIndexOf('llm_request'), true, 'undo before model call');
    await flush();
    eq(io.said.at(-1), 'Call to Mom cancelled before it connected. Timer for how many minutes?', 'said');
  }],
  ['model: invalid arguments are dropped, never executed', async () => {
    const { dm, io } = rig(async () => ({ tool: 'set_timer', args: { minutes: -5 }, confidence: 0.9, alternatives: [] }));
    dm.hear({ text: 'timer for a while' });
    await flush();
    eq(dm.events.find((e) => e.type === 'llm_result').rejectedArgs, ['minutes'], 'rejected');
    eq(io.said.at(-1), 'Timer for how many minutes?', 'asked instead');
  }],
  ['model: a model-only guess at a call is confirmed, not run', async () => {
    const { dm, io } = rig(async () => ({ tool: 'call_contact', args: { name: 'dad' }, confidence: 0.99, alternatives: [] }));
    dm.hear({ text: 'get my old man on the line', asrConfidence: 0.85 });
    await flush();
    eq(io.said.at(-1), 'Call Dad?', 'confirm');
    eq(dm.kitchen.snapshot().call, null, 'no call placed');
  }],
  ['model: failure falls back to the rules', async () => {
    const { dm, io } = rig(async () => { throw new Error('offline'); });
    dm.hear({ text: 'set a timer' });
    await flush();
    eq(dm.events.find((e) => e.type === 'llm_result').used, false, 'not used');
    eq(io.said.at(-1), 'Timer for how many minutes?', 'rules decided');
  }],
  ['model: an answer that arrives after the user spoke again is dropped', async () => {
    let release;
    const { dm, io } = rig(() => new Promise((r) => { release = r; }));
    dm.hear({ text: 'put on something nice' });
    await flush(); // the model call starts on a microtask
    dm.hear({ text: 'play jazz' });
    release({ tool: 'add_to_list', args: { item: 'nice' }, confidence: 0.9, alternatives: [] });
    await flush();
    eq(dm.events.some((e) => e.type === 'llm_dropped'), true, 'dropped');
    eq(dm.kitchen.snapshot().list.length, 0, 'stale proposal not executed');
    eq(io.said.at(-1), 'Playing jazz.', 'said');
  }],
);

export async function runUnitTests() {
  const out = [];
  for (const [name, fn] of UNIT_TESTS) {
    try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, error: e.message }); }
  }
  return out;
}

export async function loadScenarios(base = 'scenarios/') {
  const names = await (await fetch(base + 'index.json')).json();
  return Promise.all(names.map(async (n) => (await fetch(base + n)).json()));
}
