import express, { Request, Response, NextFunction } from 'express';
import { config } from 'dotenv';
import { 
  GatewayService, 
  validateChatCompletionRequest,
  extractProviderFromHeaders 
} from './services/gateway.js';
import { ProviderConfig } from './providers/registry.js';
import { ProviderType, GatewayError } from './types/index.js';
import { getAvailableModels } from './services/pricing.js';
import { existsSync } from 'fs';

// Load environment variables
if (existsSync('.env')) {
  config();
}

// Create Express app
const app = express();
app.use(express.json({ limit: '10mb' }));

// Build provider config from environment
const providerConfig: ProviderConfig = {};

// Anthropic
if (process.env.ANTHROPIC_API_KEY) {
  providerConfig.anthropic = {
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
}

// AWS Bedrock
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  providerConfig.bedrock = {
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
  };
}

// Azure OpenAI
if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
  providerConfig.azure = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    deploymentName: process.env.AZURE_DEPLOYMENT_NAME || 'gpt-4',
    apiVersion: process.env.AZURE_API_VERSION || '2024-02-01',
  };
}

// Initialize gateway
const gateway = new GatewayService(
  {
    defaultProvider: (process.env.DEFAULT_PROVIDER as ProviderType) || 'anthropic',
    enableMetrics: process.env.ENABLE_METRICS !== 'false',
  },
  providerConfig
);

// Logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    providers: gateway.getAvailableProviders(),
  });
});

// Models listing endpoint
app.get('/v1/models', (_req: Request, res: Response) => {
  const models = getAvailableModels();
  
  const openaiFormatModels = Object.entries(models).flatMap(([provider, modelList]) =>
    modelList.map(modelId => ({
      id: `${provider}:${modelId}`,
      object: 'model',
      created: Date.now(),
      owned_by: provider,
      provider,
    }))
  );
  
  res.json({
    object: 'list',
    data: openaiFormatModels,
  });
});

// Main chat completions endpoint
app.post('/v1/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate request
    if (!validateChatCompletionRequest(req.body)) {
      res.status(400).json({
        error: {
          message: 'Invalid request format. Expected OpenAI chat completions format.',
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      });
      return;
    }
    
    // Extract provider from headers
    const providerOverride = extractProviderFromHeaders(req.headers as Record<string, string | undefined>);
    
    // Handle streaming
    if (req.body.stream === true) {
      // For streaming, we need to handle it differently
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Note: Full streaming implementation would require
      // streaming support from each provider adapter
      res.write('data: {"error": "Streaming not yet implemented"}\n\n');
      res.end();
      return;
    }
    
    // Call gateway
    const response = await gateway.handleChatCompletion(
      req.body,
      providerOverride
    );
    
    // Send response
    res.json(response);
    
  } catch (error) {
    next(error);
  }
});

// Configuration endpoint (for updating provider configs at runtime)
app.post('/v1/config/providers', (req: Request, res: Response) => {
  try {
    const { provider, config: providerConfig } = req.body;
    
    if (!provider || !providerConfig) {
      res.status(400).json({
        error: {
          message: 'Missing provider or config',
          type: 'invalid_request_error',
        },
      });
      return;
    }
    
    gateway.updateProviderConfig({ [provider]: providerConfig });
    
    res.json({
      success: true,
      provider,
      message: `Provider ${provider} configuration updated`,
    });
  } catch (error: any) {
    res.status(400).json({
      error: {
        message: error.message,
        type: 'configuration_error',
      },
    });
  }
});

// Get provider status
app.get('/v1/providers', (_req: Request, res: Response) => {
  const providers = gateway.getAvailableProviders();
  
  res.json({
    providers: providers.map(p => ({
      name: p,
      available: gateway.hasProvider(p as ProviderType),
    })),
  });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  
  if (err instanceof GatewayError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        type: 'provider_error',
        code: err.code,
        provider: err.provider,
      },
    });
    return;
  }
  
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    },
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: {
      message: 'Not found',
      type: 'not_found_error',
    },
  });
});

// Start server
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Universal Gateway - Multi-Provider AI             ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                       ║
║                                                               ║
║  Endpoints:                                                   ║
║    POST /v1/chat/completions  - Main chat completion endpoint ║
║    GET  /v1/models            - List available models         ║
║    GET  /v1/providers         - Check provider status        ║
║    POST /v1/config/providers  - Update provider config        ║
║    GET  /health               - Health check                  ║
║                                                               ║
║  Header: x-provider to override provider                      ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  console.log('Configured providers:', gateway.getAvailableProviders());
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export { app, gateway };
