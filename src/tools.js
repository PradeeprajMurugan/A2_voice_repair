// Mock kitchen tools (SIMULATED actions: nothing real is called, played or bought).
//
// Each tool is a bounded capability with a schema, a risk profile and an undo (L12).
// The parser or an LLM only *proposes* a call; this module validates it with five checks
// before anything changes, and every spoken report is built from the return value,
// never from what the parser claimed (avoids "process hallucination", L12).

export const CONTACTS = ['mom', 'dad', 'alex', 'sam'];
export const GENRES = ['jazz', 'pop', 'classical', 'lofi'];

export const TOOLS = {
  call_contact: {
    label: 'Call',
    args: { name: { type: 'string', enum: CONTACTS, required: true } },
    // Once connected, a call cannot be un-rung: irreversible and visible -> confirm or grace window.
    risk: { cost: 'high', reversible: false, visible: true },
    commitDelayMs: 3000, // grace window: "Calling Mom..." can be cancelled before it connects
  },
  set_timer: {
    label: 'Timer',
    args: { minutes: { type: 'number', min: 1, max: 180, required: true } },
    risk: { cost: 'low', reversible: true, visible: true },
  },
  play_music: {
    label: 'Music',
    args: { genre: { type: 'string', enum: GENRES, required: false } },
    risk: { cost: 'low', reversible: true, visible: true },
  },
  add_to_list: {
    label: 'Shopping list',
    args: { item: { type: 'string', required: true } },
    risk: { cost: 'low', reversible: true, visible: true },
  },
};

const IDEMPOTENCY_WINDOW_MS = 3000;

export function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// --- Check 1: shape -------------------------------------------------------------------
export function checkShape(call) {
  const tool = TOOLS[call?.tool];
  if (!tool) return { ok: false, check: 'shape', reason: `unknown tool "${call?.tool}"` };
  const args = call.args || {};
  for (const [k, spec] of Object.entries(tool.args)) {
    const v = args[k];
    if (v === undefined || v === null || v === '') {
      if (spec.required) return { ok: false, check: 'shape', reason: `missing ${k}`, missing: k };
      continue;
    }
    if (spec.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v)))
      return { ok: false, check: 'shape', reason: `${k} must be a number` };
    if (spec.type === 'string' && typeof v !== 'string')
      return { ok: false, check: 'shape', reason: `${k} must be text` };
    if (spec.enum && !spec.enum.includes(v))
      return { ok: false, check: 'shape', reason: `${k} "${v}" is not one of ${spec.enum.join(', ')}` };
    if (spec.min !== undefined && v < spec.min) return { ok: false, check: 'shape', reason: `${k} below ${spec.min}` };
    if (spec.max !== undefined && v > spec.max) return { ok: false, check: 'shape', reason: `${k} above ${spec.max}` };
  }
  for (const k of Object.keys(args)) {
    if (!(k in tool.args)) return { ok: false, check: 'shape', reason: `unexpected argument ${k}` };
  }
  return { ok: true };
}

// The simulated kitchen: the "environment" layer of the spine (L02).
export function createKitchen(clock) {
  const world = { call: null, timers: [], music: null, list: [] };
  let nextId = 1;
  let lastExec = null; // for idempotency
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn(snapshot()));

  function snapshot() {
    return JSON.parse(JSON.stringify({ ...world, now: clock.now() }));
  }

  // --- Checks 2-5 (check 4, confirmation, is the policy's job: see policy.js) ---------
  function validate(call, { allowedTools = Object.keys(TOOLS) } = {}) {
    const shape = checkShape(call);
    if (!shape.ok) return shape;
    // Check 2: permission (least privilege: only the tools this context allows).
    if (!allowedTools.includes(call.tool))
      return { ok: false, check: 'permission', reason: `${call.tool} not allowed here` };
    // Check 3: precondition (stale actions).
    if (call.tool === 'call_contact' && world.call && world.call.status !== 'ended')
      return { ok: false, check: 'precondition', reason: 'a call is already in progress' };
    // Check 5: idempotency (a repeated request inside the window is not run twice, L04 duplicate example).
    if (lastExec && lastExec.key === key(call) && clock.now() - lastExec.at < IDEMPOTENCY_WINDOW_MS)
      return { ok: false, check: 'idempotency', reason: 'same request just ran', duplicateOf: lastExec.result };
    return { ok: true };
  }

  function key(call) { return call.tool + JSON.stringify(call.args || {}); }

  // Execute a validated call. Returns a result object; `undo` is a token for undoAction().
  function execute(call, { onCommit } = {}) {
    const v = validate(call);
    if (!v.ok) return { ok: false, tool: call.tool, ...v };
    const id = nextId++;
    let result;
    switch (call.tool) {
      case 'call_contact': {
        const name = call.args.name;
        world.call = { id, name, status: 'dialling', startedAt: clock.now(), connectedAt: null };
        const delay = TOOLS.call_contact.commitDelayMs;
        world.call.timer = clock.setTimeout(() => {
          if (world.call && world.call.id === id && world.call.status === 'dialling') {
            world.call.status = 'connected';
            world.call.connectedAt = clock.now();
            delete world.call.timer;
            changed();
            onCommit && onCommit({ ok: true, tool: 'call_contact', id, name, status: 'connected' });
          }
        }, delay);
        result = { ok: true, tool: 'call_contact', id, name, status: 'dialling', commitInMs: delay };
        break;
      }
      case 'set_timer': {
        const t = { id, minutes: call.args.minutes, startedAt: clock.now() };
        world.timers.push(t);
        result = { ok: true, tool: 'set_timer', id, minutes: t.minutes };
        break;
      }
      case 'play_music': {
        const genre = call.args.genre || 'pop';
        const previous = world.music;
        world.music = { id, genre };
        result = { ok: true, tool: 'play_music', id, genre, previous };
        break;
      }
      case 'add_to_list': {
        world.list.push({ id, item: call.args.item });
        result = { ok: true, tool: 'add_to_list', id, item: call.args.item };
        break;
      }
    }
    lastExec = { key: key(call), at: clock.now(), result };
    changed();
    return result;
  }

  // Undo the action identified by a previous result. The return value says exactly what happened.
  function undoAction(prev) {
    if (!prev || !prev.ok) return { ok: false, check: 'precondition', reason: 'nothing to undo' };
    lastExec = null; // after a correction, the user may legitimately repeat a request
    switch (prev.tool) {
      case 'call_contact': {
        const c = world.call;
        if (!c || c.id !== prev.id || c.status === 'ended')
          return { ok: false, tool: 'call_contact', check: 'precondition', reason: 'call already ended' };
        const wasConnected = c.status === 'connected';
        if (c.timer) clock.clearTimeout(c.timer);
        c.status = 'ended';
        delete c.timer;
        changed();
        return {
          ok: true, tool: 'call_contact', undone: true, name: c.name,
          beforeConnect: !wasConnected,
          connectedForMs: wasConnected ? clock.now() - c.connectedAt : 0,
        };
      }
      case 'set_timer': {
        const i = world.timers.findIndex((t) => t.id === prev.id);
        if (i < 0) return { ok: false, tool: 'set_timer', check: 'precondition', reason: 'timer already gone' };
        const [t] = world.timers.splice(i, 1);
        changed();
        return { ok: true, tool: 'set_timer', undone: true, minutes: t.minutes };
      }
      case 'play_music': {
        if (!world.music || world.music.id !== prev.id)
          return { ok: false, tool: 'play_music', check: 'precondition', reason: 'music already changed' };
        world.music = prev.previous || null;
        changed();
        return { ok: true, tool: 'play_music', undone: true, genre: prev.genre };
      }
      case 'add_to_list': {
        const i = world.list.findIndex((x) => x.id === prev.id);
        if (i < 0) return { ok: false, tool: 'add_to_list', check: 'precondition', reason: 'item already removed' };
        const [x] = world.list.splice(i, 1);
        changed();
        return { ok: true, tool: 'add_to_list', undone: true, item: x.item };
      }
    }
    return { ok: false, check: 'shape', reason: 'unknown action' };
  }

  // Is this earlier action still something a barge-in can target?
  function isActive(prev) {
    if (!prev || !prev.ok) return false;
    switch (prev.tool) {
      case 'call_contact': return !!world.call && world.call.id === prev.id && world.call.status !== 'ended';
      case 'set_timer': return world.timers.some((t) => t.id === prev.id);
      case 'play_music': return !!world.music && world.music.id === prev.id;
      case 'add_to_list': return world.list.some((x) => x.id === prev.id);
    }
    return false;
  }

  return {
    validate, execute, undoAction, isActive, snapshot,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
}

// --- Reports built from return values (one short clause each; Grice's quantity, L07) ----
export function describeResult(r) {
  if (!r) return '';
  if (!r.ok) {
    if (r.check === 'precondition' && r.reason === 'nothing to undo') return "There's nothing to cancel right now";
    if (r.check === 'precondition' && r.reason === 'a call is already in progress') return 'A call is already in progress';
    if (r.check === 'idempotency') return 'Already done';
    return `I couldn't do that: ${r.reason}`;
  }
  if (r.undone) {
    switch (r.tool) {
      case 'call_contact':
        return r.beforeConnect ? `Call to ${cap(r.name)} cancelled before it connected` : `Hung up on ${cap(r.name)}`;
      case 'set_timer': return `${r.minutes}-minute timer removed`;
      case 'play_music': return 'Music stopped';
      case 'add_to_list': return `Took ${r.item} off the list`;
    }
  }
  switch (r.tool) {
    case 'call_contact': return r.status === 'connected' ? `Connected to ${cap(r.name)}` : `Calling ${cap(r.name)}`;
    case 'set_timer': return `Timer set for ${r.minutes} minute${r.minutes === 1 ? '' : 's'}`;
    case 'play_music': return `Playing ${r.genre}`;
    case 'add_to_list': return `Added ${r.item} to the list`;
  }
  return 'Done';
}
