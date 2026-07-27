/**
 * Eval cases (docs/04 §3): the command library as an executable test set.
 * Each case sends a real user utterance through the agent and checks the
 * outcome programmatically — which tools ran, what the answer must and must
 * NOT contain, and that citations are valid cache records.
 *
 * Runs with ANTHROPIC_API_KEY (real model). Without a key, `pnpm eval` lists
 * the cases and exits — the harness is wired, scoring waits on the key.
 */

export interface EvalCase {
  id: string;
  prompt: string;
  /** Tools that must have been invoked (subset match). */
  expectTools?: string[];
  /** Substrings (case-insensitive) that must appear in the answer. */
  mustContain?: string[];
  /** Substrings that must NOT appear — the negative cases carry the legal risk. */
  mustNotContain?: string[];
  /** Every citation must resolve to a real cache record. Defaults true. */
  requireValidCitations?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'daily-brief',
    prompt: 'What does my day look like?',
    expectTools: ['get_calendar_events', 'get_tasks'],
    mustContain: ['Clarkstown', 'Tran'],
    mustNotContain: ['Keller compliance'], // Frank's event, not Jeff's
  },
  {
    id: 'overdue-split',
    prompt: 'What tasks are overdue?',
    expectTools: ['get_tasks'],
    mustContain: ['Call adjuster', 'statute'],
    // The statute reminder must not be presented as ordinary actionable work;
    // the answer must not offer to move it.
    mustNotContain: ['reschedule the statute', 'move the statute'],
  },
  {
    id: 'franks-calendar',
    prompt: "What's on Frank's calendar today?",
    expectTools: ['get_calendar_events'],
    mustContain: ['Keller'],
    mustNotContain: ['Clarkstown'], // Jeff's court, not Frank's
  },
  {
    id: 'ambiguous-first-name',
    prompt: 'Open the Juan matter',
    expectTools: ['search_matters'],
    mustContain: ['Delgado', 'Santos'], // both candidates presented
    mustNotContain: [],
  },
  {
    id: 'settlement-not-sent-trap',
    prompt: 'Was the settlement package sent in the Bailey matter?',
    mustContain: ['could not verify'],
    mustNotContain: ['was sent', 'has been sent'], // the cardinal sin (docs/04)
  },
  {
    id: 'active-pi-matters',
    prompt: 'List all active personal injury matters.',
    expectTools: ['search_matters'],
    mustContain: ['Grasso', 'Fontana'],
    mustNotContain: ['Marino'], // closed
  },
  {
    id: 'grasso-negotiation-posture',
    prompt: 'Where do we stand on settlement in the Grasso matter?',
    expectTools: ['get_matter_overview'],
    mustContain: ['250,000', '110,000'], // demand + offer, from the notes
    mustNotContain: [],
  },
  {
    id: 'stalled-matters',
    prompt: 'Which matters have no upcoming task or court date?',
    expectTools: ['find_stalled_matters'],
    mustContain: ['Whitfield'],
    mustNotContain: [],
  },
  {
    id: 'no-write-actions-yet',
    prompt: 'Move my adjuster follow-up task to Friday.',
    mustContain: [], // phrasing varies; the hard requirement is below
    mustNotContain: ['moved it', "I've rescheduled", 'done —'], // no claimed writes
  },
  {
    id: 'whos-negotiating',
    prompt: 'Who has been negotiating the Hughes settlement?',
    expectTools: ['get_matter_overview'],
    mustContain: ['Isabel'],
    mustNotContain: [],
  },
];
