/** Exit codes, as documented in the README. */
export const EXIT = Object.freeze({
  OK: 0,
  CLEANUPS_FOUND: 1,
  SETUP_ERROR: 2,
});

/**
 * A problem with the user's setup or arguments (bad path, Ollama unreachable, conflicting flags...).
 * Always ends the run with exit code 2.
 */
export class SetupError extends Error {
  /**
   * @param {string} message
   * @param {{ hint?: string, warning?: boolean }} [details]  `warning` prints the message in yellow
   *   instead of red (e.g. "Ollama doesn't seem to be running": a state, not a mistake).
   */
  constructor(message, { hint, warning = false } = {}) {
    super(message);
    this.name = 'SetupError';
    this.hint = hint;
    this.warning = warning;
  }
}
