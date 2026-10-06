export class Logger {
  constructor(private readonly scope: string) {}
  info(message: string) {
    process.stdout.write(`[${this.scope}] ${message}\n`);
  }
}
