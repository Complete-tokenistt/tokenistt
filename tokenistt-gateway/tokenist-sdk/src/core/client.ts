import { HTTPClient } from './http.js';
import { withRetry } from '../utils/retry.js';
import { calculateCost } from '../utils/pricing.js';
import {
  TokenistConfig,
  CompletionCreateParams,
  ChatCompletion,
  UsageCallback,
  CostCallback,
  BudgetWarning,
} from '../types/index.js';

// Interface matching OpenAI's chat namespace
export interface Chat {
  completions: {
    create(params: CompletionCreateParams): Promise<ChatCompletion>;
  };
}

export class Tokenist {
  public chat: Chat;
  
  private http: HTTPClient;
  private config: Required<Omit<TokenistConfig, 'onUsage' | 'onCost' | 'onBudgetWarning' | 'onError'>> & {
    onUsage?: (usage: UsageCallback) => void;
    onCost?: (cost: CostCallback) => void;
    onBudgetWarning?: (warning: BudgetWarning) => void;
    onError?: (error: Error) => void;
  };
  
  private onUsage?: (usage: UsageCallback) => void;
  private onCost?: (cost: CostCallback) => void;
  private onBudgetWarning?: (warning: BudgetWarning) => void;
  private onError?: (error: Error) => void;
  
  private budgetUsed: Map<string, number> = new Map();
  private budgetLimits: Map<string, number> = new Map();
  
  constructor(config: TokenistConfig) {
    if (!config.apiKey) {
      throw new Error('apiKey is required');
    }
    
    this.config = {
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'http://localhost:3000/v1',
      timeout: config.timeout || 120000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      httpAgent: config.httpAgent,
      httpsAgent: config.httpsAgent,
      defaultUser: config.defaultUser,
      defaultCostCenter: config.defaultCostCenter,
      onUsage: config.onUsage,
      onCost: config.onCost,
      onBudgetWarning: config.onBudgetWarning,
      onError: config.onError,
    };
    
    this.http = new HTTPClient(this.config);
    
    this.onUsage = config.onUsage;
    this.onCost = config.onCost;
    this.onBudgetWarning = config.onBudgetWarning;
    this.onError = config.onError;
    
    // Create chat namespace
    this.chat = {
      completions: {
        create: this.createCompletion.bind(this),
      },
    };
  }
  
  private async createCompletion(params: CompletionCreateParams): Promise<ChatCompletion> {
    const requestParams = this.prepareRequest(params);
    const requestBody = JSON.stringify(requestParams);
    
    const makeRequest = async (): Promise<ChatCompletion> => {
      const response = await this.http.request<ChatCompletion>({
        method: 'POST',
        path: '/chat/completions',
        body: requestBody,
      });
      
      return this.processResponse(response);
    };
    
    const result = await withRetry(makeRequest, {
      maxRetries: this.config.maxRetries,
    });
    
    return result;
  }
  
  private prepareRequest(params: CompletionCreateParams): Record<string, unknown> {
    const request: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      top_p: params.top_p,
      max_tokens: params.max_tokens,
      stream: params.stream,
      stop: params.stop,
      presence_penalty: params.presence_penalty,
      frequency_penalty: params.frequency_penalty,
      logit_bias: params.logit_bias,
      tools: params.tools,
      tool_choice: params.tool_choice,
    };
    
    if (params.user) {
      request.user = params.user;
    } else if (this.config.defaultUser) {
      request.user = this.config.defaultUser;
    }
    
    if (params.cost_center) {
      request.cost_center = params.cost_center;
    } else if (this.config.defaultCostCenter) {
      request.cost_center = this.config.defaultCostCenter;
    }
    
    if (params.cost_estimate !== undefined) {
      request.cost_estimate = params.cost_estimate;
    }
    
    return request;
  }
  
  private processResponse(response: ChatCompletion): ChatCompletion {
    const { usage } = response;
    
    if (this.onUsage && usage) {
      this.onUsage({
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        model: response.model,
      });
    }
    
    const cost = response.actual_cost ?? 
      calculateCost(response.model, usage?.prompt_tokens || 0, usage?.completion_tokens || 0);
    
    if (this.onCost) {
      this.onCost({
        cost,
        model: response.model,
        provider: response.provider,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
      });
    }
    
    if (response._attribution) {
      this.checkBudgetWarning(response._attribution);
    }
    
    return response;
  }
  
  private checkBudgetWarning(attribution: NonNullable<ChatCompletion['_attribution']>): void {
    if (!this.onBudgetWarning) return;
    
    const key = `${attribution.workspace}:${attribution.userId}`;
    const used = this.budgetUsed.get(key) || 0;
    const newUsed = used + (attribution.cost || 0);
    this.budgetUsed.set(key, newUsed);
    
    const limit = this.budgetLimits.get(key) || 100;
    const remaining = limit - newUsed;
    const percentageUsed = (newUsed / limit) * 100;
    
    if (percentageUsed >= 80) {
      this.onBudgetWarning({
        userId: attribution.userId,
        costCenter: attribution.costCenter,
        budgetUsed: newUsed,
        budgetLimit: limit,
        budgetRemaining: remaining,
        percentageUsed,
      });
    }
  }
  
  setBudgetLimit(userId: string, limit: number): void {
    this.budgetLimits.set(userId, limit);
  }
  
  setDefaultUser(userId: string): void {
    this.config.defaultUser = userId;
  }
  
  setDefaultCostCenter(costCenter: string): void {
    this.config.defaultCostCenter = costCenter;
  }
  
  setBaseURL(url: string): void {
    this.http.setBaseURL(url);
  }
  
  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
    this.http.setApiKey(apiKey);
  }
}

export function TokenistSDK(config: TokenistConfig): Tokenist {
  return new Tokenist(config);
}

export default Tokenist;
