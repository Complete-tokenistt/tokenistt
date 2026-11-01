import dotenv from "dotenv";
dotenv.config();

export const TRANSPORT = process.env.MCP_TRANSPORT || "stdio"; // stdio | sse
export const PORT = Number(process.env.PORT || 3002);

// Gateway = the OpenAI-compatible proxy. Dashboard = where spend/budget data is served from.
export const GATEWAY_URL =
  process.env.TOKENISTT_GATEWAY_URL || process.env.GATEWAY_URL || "http://localhost:3000";
export const DASHBOARD_URL =
  process.env.TOKENISTT_DASHBOARD_URL || process.env.DASHBOARD_URL || "http://localhost:3001";

// Virtual API key, only needed by route_prompt (it sends a real completion through the gateway).
export const GATEWAY_API_KEY = process.env.TOKENISTT_API_KEY || process.env.GATEWAY_API_KEY || "";

// Only needed when the dashboard runs with AUTH_MODE=jwt: a dashboard session JWT.
export const DASHBOARD_TOKEN = process.env.TOKENISTT_DASHBOARD_TOKEN || "";
