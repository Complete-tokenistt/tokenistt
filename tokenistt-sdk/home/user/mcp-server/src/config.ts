import dotenv from "dotenv";
dotenv.config();

export const TRANSPORT = process.env.MCP_TRANSPORT || "stdio"; // stdio | sse
export const PORT = Number(process.env.PORT || 3002);
export const GATEWAY_URL =
  process.env.TOKENISTT_GATEWAY_URL || process.env.GATEWAY_URL || "http://localhost:4000";
export const GATEWAY_API_KEY =
  process.env.TOKENISTT_API_KEY || process.env.GATEWAY_API_KEY || "";
export const DASHBOARD_URL =
  process.env.TOKENISTT_DASHBOARD_URL || process.env.DASHBOARD_URL || "http://localhost:3001";
