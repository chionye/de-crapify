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
   * @param {{ hint?: string }} [details]
   */
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'SetupError';
    this.hint = hint;
  }
}
