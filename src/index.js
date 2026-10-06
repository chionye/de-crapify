#!/usr/bin/env node
import chalk from 'chalk';
import { CommanderError } from 'commander';
import { createProgram } from './cli.js';
import { EXIT, SetupError } from './errors.js';
import { normalizeOptions } from './options.js';
import { runClean } from './run.js';

/**
 * Parse argv, run, and return the exit code. Never calls process.exit itself.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let exitCode = EXIT.OK;
  const program = createProgram({
    onClean: async (targetPath, rawOptions) => {
      const options = normalizeOptions(targetPath, rawOptions);
      exitCode = await runClean(options, {
        out: (text) => process.stdout.write(text + '\n'),
        err: (text) => process.stderr.write(text + '\n'),
        chalk,
        cwd: process.cwd(),
      });
    },
  });

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and --version exit 0; any usage error is a setup error.
      return error.exitCode === 0 ? EXIT.OK : EXIT.SETUP_ERROR;
    }
    if (error instanceof SetupError) {
      const color = error.warning ? chalk.yellow : chalk.red;
      process.stderr.write(color(`de-crapify: ${error.message}`) + '\n');
      if (error.hint) process.stderr.write(chalk.yellow(error.hint) + '\n');
      return EXIT.SETUP_ERROR;
    }
    // Exit 1 means "cleanups found" in --check mode, so a crash must not use it.
    process.stderr.write(chalk.red('de-crapify: unexpected error') + '\n');
    process.stderr.write(String(/** @type {Error} */ (error)?.stack ?? error) + '\n');
    return EXIT.SETUP_ERROR;
  }
}

process.exitCode = await main(process.argv);
