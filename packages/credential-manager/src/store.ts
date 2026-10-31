import fs from "fs";
import path from "path";
import type { CredentialRecord } from "./types";

// Pluggable metadata store. Default is a JSON file for dev; swap `jsonStore`
// for a Postgres/Prisma implementation in production (same interface).
const FILE = path.resolve(process.cwd(), "data", "credentials.json");

export interface Store {
  get(orgId: string, provider: string): CredentialRecord | undefined;
  put(record: CredentialRecord): void;
  delete(orgId: string, provider: string): void;
}

function load(): CredentialRecord[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as CredentialRecord[];
  } catch {
    return [];
  }
}

function save(all: CredentialRecord[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export const jsonStore: Store = {
  get(orgId, provider) {
    return load().find((r) => r.orgId === orgId && r.provider === provider);
  },
  put(record) {
    const all = load();
    const i = all.findIndex(
      (x) => x.orgId === record.orgId && x.provider === record.provider,
    );
    if (i >= 0) all[i] = record;
    else all.push(record);
    save(all);
  },
  delete(orgId, provider) {
    save(load().filter((r) => !(r.orgId === orgId && r.provider === provider)));
  },
};
