// Decision policy (IMPLEMENTED). Two explicit, testable rules — the "who moves next" rule
// that L03 asks a human-centred design to document and defend.
//
// Rule 1  act / confirm / ask  — confidence x cost of being wrong (Horvitz, 1999; L03),
//         using L12's matrix: reversible actions run and report; irreversible ones get
//         confirmation or a grace window before they take effect.
// Rule 2  barge-in criterion   — when does speech during an action count as "stop"?
//         Signal detection (Green & Swets, 1966; L04): the criterion moves with the cost
//         of a miss. Eager while a call is about to connect (a miss = wrong person rung);
//         cautious while music or a timer runs (false alarms from kitchen noise would
//         cancel things the user wanted — the cry-wolf risk, Breznitz, 1984).

import { TOOLS } from './tools.js';

export const THRESHOLDS = { act: 0.8, ask: 0.5 };
export const BARGE_IN_CRITERION = { high: 0.35, low: 0.6 };
export const LOUD = 0.7; // simulated loudness above which unintelligible sound counts as a shout
export const MAX_OPTIONS = 3; // ~4-chunk working-memory limit (Cowan, 2001; L05), spoken

/**
 * Rule 1. Given a parsed intent, decide the system's next move.
 * @returns {{decision: string, reason: string}}
 *   decision: act | act_with_grace | confirm | ask_slot | ask_choice | decline
 */
export function decide(parsed) {
  const intent = parsed.intent;
  if (!intent) {
    if (parsed.candidates.length) return { decision: 'ask_choice', reason: 'no candidate above 0.3; offer the closest options' };
    return { decision: 'decline', reason: 'nothing recognisable; state capabilities' };
  }
  const tool = TOOLS[intent.tool];
  const c = intent.confidence;
  if (c < THRESHOLDS.ask) return { decision: 'ask_choice', reason: `confidence ${c} < ${THRESHOLDS.ask}` };
  if (intent.missing.length) return { decision: 'ask_slot', reason: `missing ${intent.missing.join(', ')}` };
  const high = tool.risk.cost === 'high';
  if (c >= THRESHOLDS.act) {
    return high
      ? { decision: 'act_with_grace', reason: `confidence ${c} high, but ${intent.tool} is irreversible once committed: announce, commit after ${tool.commitDelayMs} ms` }
      : { decision: 'act', reason: `confidence ${c} high and ${intent.tool} is reversible: do it and report` };
  }
  return high
    ? { decision: 'confirm', reason: `confidence ${c} medium and ${intent.tool} is irreversible: confirm first` }
    : { decision: 'act', reason: `confidence ${c} medium but ${intent.tool} is reversible: do it, report, keep undo open` };
}

/**
 * Rule 2. Classify speech heard while an earlier action is still a valid repair target.
 * @param parsed      parser output
 * @param activeCost  'high' | 'low' | null  (cost of the action that would be stopped)
 * @param loudness    0..1 simulated input level (live mic: 0.5)
 * @returns {{kind: string, criterion: number|null, evidence: number, reason: string}}
 *   kind: barge_in | safe_pause | new_command | below_criterion | nothing_to_stop | ignore
 */
export function classifyInterruption(parsed, activeCost, loudness = 0.5) {
  const evidence = parsed.repair.strength;
  if (!activeCost) {
    if (parsed.repair.detected && !parsed.intent) return { kind: 'nothing_to_stop', criterion: null, evidence, reason: 'repair marker but no active action' };
    return { kind: parsed.intent ? 'new_command' : 'ignore', criterion: null, evidence, reason: 'no active action' };
  }
  const criterion = BARGE_IN_CRITERION[activeCost];
  if (parsed.repair.detected) {
    return evidence >= criterion
      ? { kind: 'barge_in', criterion, evidence, reason: `repair evidence ${evidence} >= ${activeCost}-cost criterion ${criterion}` }
      : { kind: 'below_criterion', criterion, evidence, reason: `repair evidence ${evidence} < ${activeCost}-cost criterion ${criterion}` };
  }
  const unintelligible = !parsed.intent && parsed.candidates.length === 0;
  if (unintelligible && loudness >= LOUD && activeCost === 'high') {
    // Fallback: a shout we cannot parse during a high-stakes action -> stop it safely, then ask.
    return { kind: 'safe_pause', criterion, evidence: loudness, reason: `loud (${loudness}) unintelligible speech during a high-cost action` };
  }
  if (parsed.intent) return { kind: 'new_command', criterion, evidence, reason: 'new request without a repair marker' };
  return { kind: 'ignore', criterion, evidence, reason: activeCost === 'low' ? 'unclear sound during low-cost action: stay quiet (avoid false alarms)' : 'quiet unclear sound' };
}

export function costOf(tool) {
  return TOOLS[tool]?.risk.cost ?? null;
}
