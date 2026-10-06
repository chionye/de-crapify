import { createRequire } from 'node:module';
import { Command, Option } from 'commander';
import { DEFAULTS } from './options.js';

const pkg = createRequire(import.meta.url)('../package.json');

/**
 * Build the commander program. `onClean` receives the path and raw option values; keeping the
 * action injectable lets tests check flag parsing without running anything.
 *
 * @param {{ onClean: (targetPath: string, rawOptions: Record<string, any>) => Promise<void> | void }} handlers
 */
export function createProgram({ onClean }) {
  const program = new Command();
  program
    .name('de-crapify')
    .description(pkg.description)
    .version(pkg.version)
    .showHelpAfterError()
    // Set before adding subcommands: commander copies these settings to a subcommand when it's created.
    .exitOverride();

  program
    .command('clean')
    .description('Clean up a file or directory. Dry run by default: shows a diff, writes nothing.')
    .argument('<path>', 'file or directory (recursive)')
    .option('--write', 'apply changes to disk (default is a dry run)')
    .option('--check', 'CI mode: print a summary, exit 1 if cleanups were found; never writes')
    .option('--force', 'allow --write with uncommitted changes or outside a git repo')
    .option('--no-ai', "run only the deterministic rules; don't contact Ollama")
    .option('--model <name>', 'Ollama model to use', DEFAULTS.model)
    .option('--ollama-url <url>', 'Ollama server address', DEFAULTS.ollamaUrl)
    .option('--num-ctx <n>', 'context window to request from Ollama', String(DEFAULTS.numCtx))
    .addOption(new Option('--typecheck', 'run tsc --noEmit as a validation step (default: auto)'))
    .addOption(new Option('--no-typecheck', 'never run the typecheck'))
    .option('--test-cmd <cmd>', 'command run after changing a file; on failure the file is reverted (with --write)')
    .option('--max-file-size <kb>', 'skip files larger than this', String(DEFAULTS.maxFileSize))
    .option('--keep-console <methods>', 'console methods never removed', DEFAULTS.keepConsole)
    .option('--verbose', 'log each step, including rejected AI suggestions and why')
    .action(async (targetPath, rawOptions) => {
      await onClean(targetPath, rawOptions);
    });

  return program;
}
