import { Agent as HttpAgent, request as httpRequest } from 'http';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import { URL } from 'url';
import {
  APIError,
  RateLimitError,
  AuthenticationError,
  BudgetExceededError,
  NotFoundError,
  TokenistConfig,
} from '../types/index.js';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface RequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class HTTPClient {
  private apiKey: string;
  private baseURL: string;
  private timeout: number;
  private httpAgent?: HttpAgent;
  private httpsAgent?: HttpsAgent;
  
  constructor(config: TokenistConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || 'http://localhost:3000/v1';
    this.timeout = config.timeout || 120000;
    
    if (config.httpAgent) {
      this.httpAgent = config.httpAgent;
    }
    if (config.httpsAgent) {
      this.httpsAgent = config.httpsAgent;
    }
  }
  
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const url = new URL(options.path, this.baseURL);
    const isHttps = url.protocol === 'https:';
    const requester = isHttps ? httpsRequest : httpRequest;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...options.headers,
    };
    
    return new Promise((resolve, reject) => {
      const req = requester(
        url,
        {
          method: options.method,
          headers,
          timeout: options.timeout || this.timeout,
          agent: isHttps ? this.httpsAgent : this.httpAgent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            const responseHeaders: Record<string, string> = {};
            
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') {
                responseHeaders[key.toLowerCase()] = value;
              } else if (Array.isArray(value)) {
                responseHeaders[key.toLowerCase()] = value.join(', ');
              }
            }
            
            // Parse error responses
            if (res.statusCode && res.statusCode >= 400) {
              const error = this.parseError(body, res.statusCode, responseHeaders);
              reject(error);
              return;
            }
            
            // Parse success response
            try {
              const data = body ? JSON.parse(body) : {};
              resolve(data as T);
            } catch (parseError) {
              reject(new APIError(
                `Failed to parse response: ${body}`,
                res.statusCode
              ));
            }
          });
          
          res.on('error', (error) => {
            reject(new APIError(`Response error: ${error.message}`));
          });
        }
      );
      
      req.on('error', (error) => {
        reject(new APIError(`Request error: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new APIError('Request timeout'));
      });
      
      // Send body if present
      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
    });
  }
  
  private parseError(body: string, status: number, headers: Record<string, string>): APIError {
    let errorData: Record<string, unknown> = {};
    
    try {
      if (body) {
        errorData = JSON.parse(body);
      }
    } catch {
      // Ignore parse errors
    }
    
    const message = (errorData.error as string) || 
                   (errorData.message as string) || 
                   `Request failed with status ${status}`;
    
    const code = errorData.code as string | undefined;
    const type = errorData.type as string | undefined;
    const param = errorData.param as string | undefined;
    
    // Handle specific error types
    if (status === 401) {
      return new AuthenticationError(message, headers);
    }
    
    if (status === 404) {
      return new NotFoundError(message, headers);
    }
    
    if (status === 429) {
      // Check for budget exceeded specifically
      if (type === 'budget_exceeded' || code === 'BUDGET_EXCEEDED') {
        return new BudgetExceededError(
          (errorData.limit as number) || 0,
          (errorData.used as number) || 0,
          (errorData.estimatedCost as number) || 0,
          message
        );
      }
      return new RateLimitError(message, status, headers);
    }
    
    // Budget exceeded at 429
    if (type === 'budget_exceeded' || code === 'BUDGET_EXCEEDED') {
      return new BudgetExceededError(
        (errorData.limit as number) || 0,
        (errorData.used as number) || 0,
        (errorData.estimatedCost as number) || 0,
        message
      );
    }
    
    return new APIError(message, status, code, type, param, headers);
  }
  
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
  
  setBaseURL(baseURL: string): void {
    this.baseURL = baseURL;
  }
}
