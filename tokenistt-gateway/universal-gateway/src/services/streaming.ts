import { Response } from 'express';
import axios from 'axios';
import { 
  OpenAIChatCompletionRequest, 
  OpenAIMessage, 
  ProviderType 
} from '../types/index.js';
import { AuthContext } from '../db/auth.js';
import { logTransaction } from '../db/transactionLogger.js';
import { calculateCost, calculateCostWithStatus } from './pricing.js';
import { estimateRequestTokens } from '../providers/base.js';

export async function handleStreamingCompletion(
  request: OpenAIChatCompletionRequest,
  res: Response,
  auth: AuthContext,
  providerOverride?: ProviderType,
  requestId?: string
): Promise<void> {
  const startTime = Date.now();
  const id = requestId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. Detect provider
  const normalizedModel = request.model.toLowerCase();
  let providerType: ProviderType = providerOverride || (process.env.DEFAULT_PROVIDER as ProviderType) || 'anthropic';
  
  if (normalizedModel.startsWith('openai:')) {
    providerType = 'openai';
  } else if (normalizedModel.includes('claude')) {
    providerType = 'anthropic';
  } else if (
    normalizedModel.includes('bedrock') || 
    normalizedModel.includes('llama') || 
    normalizedModel.includes('mistral') ||
    normalizedModel.includes('ai21') ||
    normalizedModel.includes('titan')
  ) {
    providerType = 'bedrock';
  } else if (normalizedModel.includes('azure')) {
    providerType = 'azure';
  } else if (
    normalizedModel.includes('openai') ||
    normalizedModel.includes('gpt-') ||
    normalizedModel.startsWith('o1') ||
    normalizedModel.startsWith('o3')
  ) {
    providerType = 'openai';
  }

  // 2. Resolve API key & endpoint
  let url = '';
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any = {};

  let inputTokens = estimateRequestTokens(request.messages);
  let outputTokens = 0;
  let accumulatedText = '';
  let modelUsed = request.model;

  if (providerType === 'openai') {
    const apiKey = auth.realApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI credentials not configured');
    }
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = {
      model: request.model.replace(/^openai:/, ''),
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      tools: request.tools,
      tool_choice: request.tool_choice,
      stream: true,
      stream_options: { include_usage: true }, // request usage metadata in the last chunk
      stop: request.stop,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
    };
  } else if (providerType === 'azure') {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '') || '';
    const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
    const deploymentName = process.env.AZURE_DEPLOYMENT_NAME || 'gpt-4';
    const apiVersion = process.env.AZURE_API_VERSION || '2024-02-01';

    if (!endpoint || !apiKey) {
      throw new Error('Azure OpenAI credentials not configured');
    }
    url = `${endpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;
    headers['api-key'] = apiKey;
    body = {
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      tools: request.tools,
      tool_choice: request.tool_choice,
      stream: true,
      stream_options: { include_usage: true },
      stop: request.stop,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
    };
  } else {
    // Default to anthropic
    const apiKey = auth.realApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic credentials not configured');
    }
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';

    // Translate messages to Anthropic format
    let systemMessage = '';
    const conversationMessages: OpenAIMessage[] = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemMessage += (systemMessage ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      } else {
        conversationMessages.push(msg);
      }
    }

    body = {
      model: 'claude-3-5-sonnet-20241022',
      messages: conversationMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: typeof msg.content === 'string' ? msg.content : '',
      })),
      max_tokens: request.max_tokens || 4096,
      temperature: request.temperature,
      system: systemMessage || undefined,
      stream: true
    };
  }

  // 3. Make HTTP request with stream response type
  const response = await axios.post(url, body, {
    headers,
    responseType: 'stream'
  });

  // Set SSE response headers on the express response object
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let buffer = '';

  return new Promise<void>((resolve, reject) => {
    response.data.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const eventData = JSON.parse(dataStr);

            if (providerType === 'openai' || providerType === 'azure') {
              // Capture usage if returned by OpenAI/Azure stream_options
              if (eventData.usage) {
                inputTokens = eventData.usage.prompt_tokens || inputTokens;
                outputTokens = eventData.usage.completion_tokens || outputTokens;
              }
              const deltaContent = eventData.choices?.[0]?.delta?.content || '';
              accumulatedText += deltaContent;
              if (eventData.model) {
                modelUsed = eventData.model;
              }
              // Forward standard OpenAI chunk
              res.write(`data: ${JSON.stringify(eventData)}\n\n`);
            } else {
              // Translate Anthropic streaming events to OpenAI format
              if (eventData.type === 'message_start') {
                inputTokens = eventData.message?.usage?.input_tokens || inputTokens;
                if (eventData.message?.model) {
                  modelUsed = eventData.message.model;
                }
              } else if (eventData.type === 'content_block_delta') {
                const textDelta = eventData.delta?.text || '';
                accumulatedText += textDelta;

                const openaiChunk = {
                  id: `chatcmpl-${id}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: request.model,
                  choices: [{
                    index: 0,
                    delta: { content: textDelta },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
              } else if (eventData.type === 'message_delta') {
                outputTokens = eventData.usage?.output_tokens || outputTokens;
              } else if (eventData.type === 'message_stop') {
                const finalChunk = {
                  id: `chatcmpl-${id}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: request.model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                  }]
                };
                res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
              }
            }
          } catch (e) {
            // Incomplete/malformed JSON, write line as-is
            res.write(`${line}\n`);
          }
        } else {
          // Keep other lines like "event: ..." as-is
          res.write(`${line}\n`);
        }
      }
    });

    response.data.on('end', () => {
      // Process remaining buffer if any
      if (buffer.trim() && buffer.trim().startsWith('data:')) {
        const trimmed = buffer.trim();
        const dataStr = trimmed.slice(5).trim();
        if (dataStr !== '[DONE]') {
          try {
            const eventData = JSON.parse(dataStr);
            if (providerType === 'openai' || providerType === 'azure') {
              if (eventData.usage) {
                inputTokens = eventData.usage.prompt_tokens || inputTokens;
                outputTokens = eventData.usage.completion_tokens || outputTokens;
              }
            }
          } catch (e) {}
        }
        res.write(`${buffer}\n`);
      }

      res.end();

      // Stream completed successfully! Log the transaction
      const durationMs = Date.now() - startTime;
      if (outputTokens === 0) {
        outputTokens = Math.ceil(accumulatedText.length / 4);
      }

      // Use calculateCostWithStatus to correctly account for cache read/write and reasoning tokens.
      // This matches the non-streaming path in server.ts and prevents systematic undercounting
      // for Anthropic cached-prompt requests and o1/o3 reasoning requests.
      const costBreakdown = calculateCostWithStatus(
        providerType,
        request.model,
        inputTokens,
        outputTokens,
      );
      const inputCostUsd  = costBreakdown.inputCost;
      const outputCostUsd = costBreakdown.outputCost;
      const totalCostUsd  = costBreakdown.cost;

      logTransaction({
        auth,
        provider: providerType,
        model: request.model,
        endpoint: '/v1/chat/completions',
        requestId: id,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCostUsd,
        outputCostUsd,
        costUsd: totalCostUsd,
        durationMs,
        status: 'success',
        projectTag: request.project_tag,
        metadata: {
          finish_reason: 'stop',
          model_used: modelUsed,
          user_agent: 'tokenistt-streaming-client',
        },
      }).catch(err => {
        console.error('Failed to log streaming transaction:', err);
      });

      resolve();
    });

    response.data.on('error', (err: any) => {
      res.end();
      // Log failed streaming transaction so the ledger records the attempt
      const durationMs = Date.now() - startTime;
      if (outputTokens > 0 || inputTokens > 0) {
        const costBreakdown = calculateCostWithStatus(providerType, request.model, inputTokens, outputTokens);
        logTransaction({
          auth,
          provider: providerType,
          model: request.model,
          endpoint: '/v1/chat/completions',
          requestId: id,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
          inputCostUsd: costBreakdown.inputCost,
          outputCostUsd: costBreakdown.outputCost,
          costUsd: costBreakdown.cost,
          durationMs,
          status: 'error',
          errorCode: 'STREAM_ERROR',
          projectTag: request.project_tag,
          metadata: { error: err.message, model_used: modelUsed },
        }).catch(() => {});
      }
      reject(err);
    });
  });
}
