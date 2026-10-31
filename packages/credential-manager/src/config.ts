import dotenv from "dotenv";
dotenv.config();

export type BackendKind = "local" | "vault" | "kms";

export const BACKEND = (process.env.CRED_BACKEND || "local") as BackendKind;
export const PORT = Number(process.env.PORT || 4000);

export const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
export const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export const MASTER_KEY =
  process.env.MASTER_KEY || "dev-only-change-me-please-32+chars!!";

export const AWS_REGION = process.env.AWS_REGION || "us-east-1";
export const AWS_KMS_KEY_ARN_PREFIX = process.env.AWS_KMS_KEY_ARN_PREFIX || "";
