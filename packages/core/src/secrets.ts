import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where API keys live. Shells provide an OS-backed implementation (Electron safeStorage, VS Code SecretStorage). */
export interface SecretStore {
  readonly secure: boolean;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * JSON file store with optional encrypt/decrypt functions.
 * Without them (standalone/browser mode) values are only obfuscated, so the UI warns about it.
 */
export class FileSecretStore implements SecretStore {
  readonly secure: boolean;
  private file: string;

  constructor(
    dataDir: string,
    private codec?: { encrypt(plain: string): string; decrypt(cipher: string): string },
  ) {
    this.secure = !!codec;
    this.file = path.join(dataDir, codec ? 'secrets.enc.json' : 'secrets.json');
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  private enc(v: string) {
    return this.codec ? this.codec.encrypt(v) : Buffer.from(v, 'utf8').toString('base64');
  }

  private dec(v: string) {
    return this.codec ? this.codec.decrypt(v) : Buffer.from(v, 'base64').toString('utf8');
  }

  async get(key: string) {
    const v = this.read()[key];
    if (v === undefined) return undefined;
    try {
      return this.dec(v);
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string) {
    const data = this.read();
    data[key] = this.enc(value);
    this.write(data);
  }

  async delete(key: string) {
    const data = this.read();
    delete data[key];
    this.write(data);
  }

  async keys() {
    return Object.keys(this.read());
  }
}
