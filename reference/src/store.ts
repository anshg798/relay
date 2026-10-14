import fs from "node:fs";
import path from "node:path";

/**
 * Durable single-file snapshot store.
 * Every save writes a temp file, fsyncs it, atomically renames it over the
 * previous snapshot and fsyncs the directory, so a SIGKILL at any point leaves
 * either the old or the new snapshot on disk — never a torn one.
 */
export class SnapshotStore<T> {
  private readonly file: string;
  private readonly tmp: string;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.tmp = path.join(dir, "state.json.tmp");
  }

  load(): T | null {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
  }

  save(state: T): void {
    const data = JSON.stringify(state);
    const fd = fs.openSync(this.tmp, "w");
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmp, this.file);
    const dfd = fs.openSync(this.dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  }
}
