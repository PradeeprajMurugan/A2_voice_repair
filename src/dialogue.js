// Dialogue manager (IMPLEMENTED): the planning/feedback layers of the spine (L02).
//
// States
//   idle        - nothing pending; a barge-in can still target the last action (repair window)
//   announcing  - a high-cost action is in its grace window ("Calling Mom..." before it connects)
//   confirming  - waiting for yes/no before an irreversible action
//   clarifying  - waiting for a missing slot, a choice between options, or an open answer
// `speaking` is orthogonal: the user may talk over the system in any state (barge-in).
//
// Design commitments (see docs/design_notes.md):
//   - Yield the floor at once when the user speaks over the system (turn-taking, L07).
//   - Undo first, then speak; say what was undone in words built from the tool result (L12).
//   - Never fall silent after a partial repair: ask a narrow question, keep listening,
//     and say so if the wait times out (Lab 3 revision).

import { parse as ruleParse } from './parser.js';
import { decide, classifyInterruption, costOf, THRESHOLDS, LOUD, MAX_OPTIONS } from './policy.js';
import { TOOLS, CONTACTS, describeResult, cap, checkArg } from './tools.js';

export const CLARIFY_TIMEOUT_MS = 8000;
export const CONFIRM_TIMEOUT_MS = 6000;
export const REPAIR_WINDOW_MS = 10000; // timers / list items can be undone by "no, wait" for 10 s

const OPTION_PHRASE = { set_timer: 'a timer', call_contact: 'a call', play_music: 'music', add_to_list: 'the shopping list' };
const ALL_OPTIONS = ['set_timer', 'play_music', 'add_to_list', 'call_contact'];

function joinOr(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}

function slotQuestion(tool) {
  switch (tool) {
    case 'set_timer': return 'Timer for how many minutes?';
    case 'call_contact': return `Who should I call: ${joinOr(CONTACTS.map(cap))}?`;
    case 'add_to_list': return 'What should I add to the list?';
  }
  return 'Could you say that again?';
}

function confirmPrompt(intent) {
  if (intent.tool === 'call_contact') return `Call ${cap(intent.args.name)}?`;
  return `${TOOLS[intent.tool].label}?`;
}

export class DialogueManager {
  /**
   * @param clock    realClock or FakeClock
   * @param kitchen  createKitchen(clock)
   * @param io       { speak(text, onEnd), stopSpeaking(), earcon(kind), onUpdate(view) }
   * @param parseFn  (text, asrConfidence) => parsed   (rule parser, synchronous)
   * @param llm      optional async (text, context) => proposal|null. Consulted only when the rules
   *                 are unsure what the user wants next; never on the undo path.
   */
  constructor({ clock, kitchen, io, parseFn = ruleParse, llm = null, llmTimeoutMs = 2500 }) {
    Object.assign(this, { clock, kitchen, io, parseFn, llm, llmTimeoutMs });
    this.interpretId = 0;
    this.thinking = false;
    this.state = 'idle';
    this.speaking = false;
    this.lastSaid = '';
    this.target = null; // { result, at } — the action a barge-in would undo
    this.pending = null; // confirming / clarifying context
    this.timer = null;
    this.speechId = 0;
    this.events = [];
    kitchen.subscribe(() => this.update());
  }

  // ---------------------------------------------------------------- logging / view
  log(type, data = {}) {
    const e = { t: Math.round(this.clock.now()), type, ...data };
    this.events.push(e);
    return e;
  }

  view() {
    return {
      state: this.state,
      speaking: this.speaking,
      thinking: this.thinking,
      lastSaid: this.lastSaid,
      target: this.target?.result ?? null,
      pending: this.pending,
      options: this.pending?.options ?? null,
      world: this.kitchen.snapshot(),
      events: this.events,
    };
  }

  update() { this.io.onUpdate && this.io.onUpdate(this.view()); }

  setState(s) {
    if (this.state !== s) this.log('state', { from: this.state, to: s });
    this.state = s;
  }

  // ---------------------------------------------------------------- speech
  say(text, { then } = {}) {
    if (this.speaking) this.io.stopSpeaking();
    const id = ++this.speechId;
    this.speaking = true;
    this.lastSaid = text;
    this.log('say', { text });
    this.update();
    this.io.speak(text, () => {
      if (id !== this.speechId) return; // superseded or interrupted
      this.speaking = false;
      this.update();
      then && then();
    });
  }

  stopSpeech(reason) {
    if (!this.speaking) return;
    this.speechId++; // invalidate the pending onEnd
    this.speaking = false;
    this.io.stopSpeaking();
    this.log('speech_stopped', { reason });
  }

  startWait(ms, onTimeout) {
    this.clearWait();
    this.timer = this.clock.setTimeout(() => { this.timer = null; onTimeout(); }, ms);
  }

  clearWait() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- repair target
  repairTarget() {
    const tg = this.target;
    if (!tg || !this.kitchen.isActive(tg.result)) return null;
    const tool = tg.result.tool;
    if (tool === 'call_contact' || tool === 'play_music') return tg; // while it lasts
    return this.clock.now() - tg.at <= REPAIR_WINDOW_MS ? tg : null;
  }

  // ---------------------------------------------------------------- input
  /**
   * One utterance from the recogniser (or typed / replayed).
   * @param {{text: string, asrConfidence?: number, loudness?: number, source?: string}} u
   */
  hear({ text, asrConfidence = 1, loudness = 0.5, source = 'typed' }) {
    const tHeard = this.clock.now();
    this.interpretId++; // a new turn supersedes any model call still in flight
    this.thinking = false;
    this.log('heard', { text, asrConfidence, loudness, source });
    const p = this.parseFn(text, asrConfidence);
    this.log('parsed', {
      repair: p.repair, intent: p.intent, candidates: p.candidates, yesNo: p.yesNo, parser: p.parser || 'rules',
    });

    // Turn-taking: the user started a turn, so the system gives up the floor.
    if (this.speaking && (!p.empty || loudness >= LOUD)) this.stopSpeech('user started speaking');

    if (this.state === 'confirming') return this.onConfirmAnswer(p);
    if (this.state === 'clarifying') return this.onClarifyAnswer(p);

    const target = this.repairTarget();
    const cls = classifyInterruption(p, target ? costOf(target.result.tool) : null, loudness);
    this.log('interruption', cls);

    switch (cls.kind) {
      case 'barge_in': return this.repair(target, p, tHeard);
      case 'safe_pause': return this.repair(target, p, tHeard, { safePause: true });
      case 'nothing_to_stop': return this.say("There's nothing to cancel right now.");
      case 'below_criterion': return this.update(); // evidence too weak: keep going quietly
      case 'new_command': return this.interpret(p, (q) => this.command(q));
      default:
        if (!p.empty && (!target || p.candidates.length)) return this.interpret(p, (q) => this.command(q));
        return this.update();
    }
  }

  // ---------------------------------------------------------------- optional model
  // The rules always answer first. The model is asked only when they are unsure about the
  // *request* (never about "stop"), and its proposal passes the same shape check as any call.
  needsModel(p) {
    if (!this.llm || p.empty || !p.normalized) return false;
    if (p.repair.kind === 'stop' && !p.intent && !p.candidates.length) return false;
    return !p.intent || p.intent.confidence < THRESHOLDS.act || p.intent.missing.length > 0;
  }

  interpret(p, cont) {
    if (!this.needsModel(p)) return cont(p);
    const id = ++this.interpretId;
    this.thinking = true;
    this.log('llm_request', { text: p.raw, rules: p.intent });
    this.update();
    const context = { state: this.state, lastAction: this.target?.result?.tool ?? null };
    let settled = false;
    const finish = (proposal, why) => {
      if (settled) return;
      settled = true;
      if (id !== this.interpretId) return this.log('llm_dropped', { reason: 'user spoke again' });
      this.thinking = false;
      cont(this.mergeProposal(p, proposal, why));
    };
    const timer = this.clock.setTimeout(() => finish(null, 'timeout'), this.llmTimeoutMs);
    Promise.resolve()
      .then(() => this.llm(p.raw, context))
      .then((r) => { this.clock.clearTimeout(timer); finish(r, 'ok'); })
      .catch((e) => { this.clock.clearTimeout(timer); finish(null, 'error: ' + (e?.message || e)); });
  }

  mergeProposal(p, proposal, why) {
    if (!proposal || why !== 'ok') {
      this.log('llm_result', { used: false, reason: why });
      return p;
    }
    const alternatives = (proposal.alternatives || []).filter((t) => TOOLS[t]);
    if (!proposal.tool || !TOOLS[proposal.tool]) {
      this.log('llm_result', { used: !!alternatives.length, reason: 'no single request', alternatives });
      return alternatives.length
        ? { ...p, intent: null, candidates: alternatives.map((tool) => ({ tool, score: 0.4 })), parser: 'llm (options only)' }
        : p;
    }
    // Shape-check the model's arguments; drop any it got wrong rather than trusting them.
    const args = {};
    for (const [k, v] of Object.entries(proposal.args || {})) {
      if (checkArg(proposal.tool, k, v)) args[k] = v;
    }
    const rejected = Object.keys(proposal.args || {}).filter((k) => !(k in args));
    const required = Object.entries(TOOLS[proposal.tool].args).filter(([, s]) => s.required).map(([k]) => k);
    // Self-reported model confidence is not calibrated: scale by recogniser confidence and cap it,
    // so a high-cost action from a model guess is still confirmed rather than run (L12, Horvitz).
    let confidence = Math.round(Math.min(0.9, (proposal.confidence ?? 0.7) * p.asrConfidence) * 100) / 100;
    // Two-signal rule: an irreversible action that only the model supports (the rules found no
    // cue for it) is always confirmed. Found in testing: "get my old man on the line" scored 0.84
    // and would have placed a call unasked. Agreeing evidence earns more weight (cf. cue
    // integration, L04); a single unverified source does not get to act on high-cost tools.
    const rulesAgree = p.candidates.some((c) => c.tool === proposal.tool);
    let capped = false;
    if (TOOLS[proposal.tool].risk.cost === 'high' && !rulesAgree && confidence >= THRESHOLDS.act) {
      confidence = Math.round((THRESHOLDS.act - 0.01) * 100) / 100;
      capped = true;
    }
    const intent = { tool: proposal.tool, args, confidence, missing: required.filter((k) => args[k] === undefined) };
    this.log('llm_result', { used: true, intent, rejectedArgs: rejected, rulesAgree, capped });
    return { ...p, intent, candidates: [{ tool: proposal.tool, score: confidence }], parser: 'llm' };
  }

  // ---------------------------------------------------------------- normal requests
  command(p, { prefix = '' } = {}) {
    const d = decide(p);
    this.log('decision', d);
    const pre = prefix ? prefix + ' ' : '';
    switch (d.decision) {
      case 'act':
      case 'act_with_grace':
        return this.run({ tool: p.intent.tool, args: p.intent.args }, pre);
      case 'confirm':
        this.pending = { kind: 'confirm', intent: p.intent, reasks: 0 };
        this.setState('confirming');
        return this.say(pre + confirmPrompt(p.intent), { then: () => this.startWait(CONFIRM_TIMEOUT_MS, () => this.confirmTimeout()) });
      case 'ask_slot':
        return this.askSlot(p.intent, pre);
      case 'ask_choice': {
        const options = p.candidates.slice(0, MAX_OPTIONS).map((c) => c.tool);
        return this.askChoice(options, pre);
      }
      case 'decline':
      default:
        this.setState('idle');
        return this.say(pre + 'I can set a timer, play music, add to your shopping list or call someone.');
    }
  }

  run(call, pre = '') {
    const r = this.kitchen.execute(call, {
      onCommit: (c) => {
        this.log('committed', c);
        if (this.state === 'announcing') this.setState('idle');
        this.io.earcon && this.io.earcon('connected');
        this.update();
      },
    });
    this.log('tool_result', { result: r });
    this.pending = null;
    if (!r.ok) {
      this.setState('idle');
      return this.say(pre + describeResult(r) + '.');
    }
    this.target = { result: r, at: this.clock.now() };
    this.setState(r.tool === 'call_contact' && r.status === 'dialling' ? 'announcing' : 'idle');
    // Announce the grace window explicitly so the user knows there is still time to stop it.
    const tail = r.tool === 'call_contact' ? '…' : '.';
    return this.say(pre + describeResult(r) + tail);
  }

  askSlot(intent, pre = '') {
    this.pending = { kind: 'slot', tool: intent.tool, args: { ...intent.args }, slot: intent.missing[0], reasks: 0 };
    this.setState('clarifying');
    this.say((pre ? pre + ' ' : '') + slotQuestion(intent.tool), { then: () => this.startWait(CLARIFY_TIMEOUT_MS, () => this.clarifyTimeout()) });
  }

  askChoice(options, pre = '', { open = false } = {}) {
    this.pending = { kind: open ? 'open' : 'choice', options, reasks: 0 };
    this.setState('clarifying');
    const q = open ? 'What did you want instead?' : `Did you want ${joinOr(options.map((o) => OPTION_PHRASE[o]))}?`;
    this.say((pre ? pre + ' ' : '') + q, { then: () => this.startWait(CLARIFY_TIMEOUT_MS, () => this.clarifyTimeout()) });
  }

  // ---------------------------------------------------------------- repair
  repair(target, p, tHeard, { safePause = false } = {}) {
    this.clearWait();
    this.stopSpeech('barge-in');
    // Undo before anything else: the action is what costs the user (measured: a cold audio
    // context made the earcon delay the undo by ~150 ms when it ran first).
    const u = this.kitchen.undoAction(target.result);
    const latencyMs = Math.round(this.clock.now() - tHeard);
    this.io.earcon && this.io.earcon('stop'); // non-speech cue: fast acknowledgement (L04)
    this.target = null;
    this.pending = null;
    this.log('undo', { result: u, latencyMs });
    const undone = describeResult(u) + '.';

    if (safePause) return this.askChoice(ALL_OPTIONS.slice(0, MAX_OPTIONS), undone, { open: true });
    // The undo is done and logged; only the follow-up may wait for the model.
    return this.interpret(p, (q) => this.followUp(q, undone));
  }

  followUp(p, undone) {
    const ni = p.intent;
    if (ni && ni.confidence >= THRESHOLDS.ask) {
      if (ni.missing.length) return this.askSlot(ni, undone);
      return this.command(p, { prefix: undone });
    }
    if (p.candidates.length) {
      return this.askChoice(p.candidates.slice(0, MAX_OPTIONS).map((c) => c.tool), undone);
    }
    // A clean "stop the music": the user only wanted it stopped. Report and finish.
    if (p.repair.kind === 'stop' && !p.masked) {
      this.setState('idle');
      return this.say(undone);
    }
    // Lab 3 revision: the correction was lost, so say what was undone and ask — never go silent.
    return this.askChoice(ALL_OPTIONS.slice(0, MAX_OPTIONS), undone, { open: true });
  }

  // ---------------------------------------------------------------- answers
  onConfirmAnswer(p) {
    this.clearWait();
    const { intent } = this.pending;
    if (p.yesNo === 'yes') {
      this.log('confirmed', { intent });
      return this.run({ tool: intent.tool, args: intent.args });
    }
    if (p.yesNo === 'no' || p.repair.detected) {
      this.log('declined_by_user', { intent });
      this.pending = null;
      this.setState('idle');
      if (p.intent && p.intent.tool !== intent.tool) return this.command(p, { prefix: 'Okay.' });
      return this.say(intent.tool === 'call_contact' ? 'Okay, not calling.' : 'Okay, cancelled.');
    }
    return this.reask(() => this.say(`${confirmPrompt(intent)} Yes or no?`, {
      then: () => this.startWait(CONFIRM_TIMEOUT_MS, () => this.confirmTimeout()),
    }), () => this.confirmTimeout());
  }

  onClarifyAnswer(p) {
    this.clearWait();
    const pend = this.pending;
    // "No, never mind" while being asked: end cleanly, and say so.
    if ((p.repair.detected || p.yesNo === 'no') && !p.intent && p.minutes === undefined && !p.contact) {
      this.pending = null;
      this.setState('idle');
      return this.say('Okay, nothing else for now.');
    }
    if (pend.kind === 'slot') {
      const args = { ...pend.args };
      if (pend.slot === 'minutes' && p.minutes !== undefined) args.minutes = p.minutes;
      if (pend.slot === 'name' && p.contact) args.name = p.contact;
      if (pend.slot === 'item' && !p.intent && p.normalized) args.item = p.normalized.replace(/^(some|the|a|an)\s+/, '');
      if (args[pend.slot] !== undefined) {
        // The user answered the system's own question: treat as a direct, confident request.
        return this.command({ ...p, intent: { tool: pend.tool, args, confidence: 1, missing: [] } });
      }
      if (p.intent) return this.command(p);
      return this.reask(() => this.say(slotQuestion(pend.tool), {
        then: () => this.startWait(CLARIFY_TIMEOUT_MS, () => this.clarifyTimeout()),
      }), () => this.clarifyTimeout());
    }
    // choice / open
    let chosen = p.intent;
    if (!chosen && p.yesNo === 'yes' && pend.options.length === 1) {
      chosen = { tool: pend.options[0], args: {}, confidence: 1, missing: [] };
    }
    if (!chosen && p.candidates.length) {
      const c = p.candidates[0];
      chosen = { tool: c.tool, args: {}, confidence: c.score, missing: [] };
    }
    if (chosen) {
      // Re-parse the answer as a request for the chosen tool so its arguments are picked up.
      const full = { ...p, intent: { ...chosen, confidence: Math.max(chosen.confidence, THRESHOLDS.act) } };
      if (!p.intent || p.intent.tool !== chosen.tool) {
        const required = Object.entries(TOOLS[chosen.tool].args).filter(([, s]) => s.required).map(([k]) => k);
        full.intent.missing = required.filter((k) => full.intent.args[k] === undefined);
      }
      return this.command(full);
    }
    return this.reask(() => this.askChoice(pend.options, 'Sorry.', { open: pend.kind === 'open' }), () => this.clarifyTimeout());
  }

  // Ask again once, then give up explicitly.
  reask(again, giveUp) {
    if (this.pending && this.pending.reasks < 1) {
      const reasks = this.pending.reasks + 1;
      again();
      if (this.pending) this.pending.reasks = reasks;
      return;
    }
    giveUp();
  }

  clarifyTimeout() {
    this.log('timeout', { state: 'clarifying' });
    this.pending = null;
    this.setState('idle');
    this.say('Okay, nothing else for now.');
  }

  confirmTimeout() {
    this.log('timeout', { state: 'confirming' });
    const tool = this.pending?.intent?.tool;
    this.pending = null;
    this.setState('idle');
    this.say(tool === 'call_contact' ? 'Okay, not calling.' : 'Okay, cancelled.');
  }
}
