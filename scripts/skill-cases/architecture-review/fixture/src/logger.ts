// Deep on purpose: a small interface (log) over formatting, levels, redaction and buffering.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Level[] = ['debug', 'info', 'warn', 'error'];
const buffer: string[] = [];
let min: Level = 'info';
const redact = (s: string) => s.replace(/\b\d{12,19}\b/g, '[card]');
export function setLevel(l: Level) { min = l; }
export function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (ORDER.indexOf(level) < ORDER.indexOf(min)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(msg)}${data ? ' ' + redact(JSON.stringify(data)) : ''}`;
  buffer.push(line);
  if (buffer.length >= 20 || level === 'error') flush();
}
export function flush() { for (const l of buffer.splice(0)) process.stdout.write(l + '\n'); }
