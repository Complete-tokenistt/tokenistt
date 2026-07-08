import dotenv from "dotenv";
dotenv.config();

export const TRANSPORT = process.env.MCP_TRANSPORT || "stdio"; // stdio | sse
export const PORT = Number(process.env.PORT || 3001);
export const GATEWAY_URL = process.env.GATEWAY_URL || "";
export const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
