export { Tokenistt, TokenisttOptions, ClientEvents } from './client';
export { ChatCompletionStream } from './resources/chatStream';
export { Stream } from './core/stream';
export { VERSION } from './version';

export {
  TokenisttError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  RateLimitError,
  BadRequestError,
  AuthenticationError,
  InternalServerError,
  BudgetExceededError,
  makeErrorFromResponse,
} from './core/errors';

export { CostTracker, computeCost, getDefaultPricing } from './core/cost';
export type {
  ModelPrice,
  PricingTable,
  UsageEvent,
  BudgetEvent,
  BudgetConfig,
  UsageLike,
} from './core/cost';

export type { RequestOptions } from './core/fetch';
export type { ResourceOptions } from './resources/chat';

// OpenAI-compatible domain types.
export * from './types';

import { Tokenistt } from './client';
export default Tokenistt;
