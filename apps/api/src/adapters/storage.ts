import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Private file storage plug point. Files are never public: the API checks who may see a file and
 * streams it. LocalDiskStorage is for development and single-server use; an EU object store
 * (S3-compatible / Azure Blob) implements the same interface for production.
 */
export interface FileStorage {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export class LocalDiskStorage implements FileStorage {
  readonly name = 'local';
  constructor(private root: string) {}
  private full(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('bad storage key');
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.full(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.full(key));
  }
}

/** In memory: tests only */
export class MemoryStorage implements FileStorage {
  readonly name = 'memory';
  private data = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.data.set(key, data);
  }
  async get(key: string) {
    const d = this.data.get(key);
    if (!d) throw new Error('not found');
    return d;
  }
}
