import { ProcessState, StateTransition } from './types.js';

const VALID_TRANSITIONS: Record<ProcessState, ProcessState[]> = {
  created: ['queued', 'running', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'timed_out', 'failed'],
  running: ['completed', 'failed', 'cancelled', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: []
};

export class ProcessStateMachine {
  private currentState: ProcessState;
  private readonly history: StateTransition[] = [];

  constructor(initialState: ProcessState = 'created', reason?: string) {
    this.currentState = initialState;
    this.recordTransition(initialState, initialState, reason || 'Initial state');
  }

  getState(): ProcessState {
    return this.currentState;
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }

  isTerminal(): boolean {
    return ['completed', 'failed', 'cancelled', 'timed_out'].includes(this.currentState);
  }

  transition(targetState: ProcessState, reason?: string): boolean {
    if (this.currentState === targetState) {
      return true;
    }

    const allowed = VALID_TRANSITIONS[this.currentState];
    if (!allowed || !allowed.includes(targetState)) {
      throw new Error(`Illegal state transition from '${this.currentState}' to '${targetState}'. Allowed: [${(allowed || []).join(', ')}]`);
    }

    const previous = this.currentState;
    this.currentState = targetState;
    this.recordTransition(previous, targetState, reason);
    return true;
  }

  private recordTransition(from: ProcessState, to: ProcessState, reason?: string): void {
    this.history.push({
      from,
      to,
      timestamp: new Date().toISOString(),
      reason
    });
  }
}
