import type { CryptoBackend } from "../types";
import { BACKEND } from "../config";
import { localBackend } from "./local";
import { vaultBackend } from "./vault";
import { kmsBackend } from "./kms";

export function selectBackend(): CryptoBackend {
  switch (BACKEND) {
    case "vault":
      return vaultBackend;
    case "kms":
      return kmsBackend;
    default:
      return localBackend;
  }
}
