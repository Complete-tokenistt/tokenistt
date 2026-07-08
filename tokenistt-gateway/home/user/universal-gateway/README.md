# Universal Gateway - Multi-Provider AI API Adapter

A TypeScript service that accepts OpenAI-format requests and translates them to Anthropic, AWS Bedrock, and Azure OpenAI formats, then normalizes responses back to OpenAI format with unified cost tracking.

## Features

- **Multi-Provider Support**: Seamlessly switch between Anthropic, AWS Bedrock, and Azure OpenAI
- **OpenAI-Compatible API**: Use the standard OpenAI `/v1/chat/completions` format
- **Automatic Translation**: Requests are automatically translated to provider-specific formats
- **Unified Response**: All responses normalized to OpenAI `chat.completion` schema
- **Cost Tracking**: Exact cost calculation using provider-specific pricing
- **Unified Metadata**: Returns provider, actual_cost, latency_ms, and model_used

## Quick Start

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit the `.env` file with your API keys:

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
AWS_ACCESS_KEY_ID=AKIAxxxxx
AWS_SECRET_ACCESS_KEY=xxxxx
AWS_REGION=us-east-1
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=xxxxx
AZURE_DEPLOYMENT_NAME=gpt-4
```

### Run the Server

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build
npm start
```

The server will start on `http://localhost:3000`.

## API Endpoints

### Chat Completions

**POST** `/v1/chat/completions`

Standard OpenAI format request:

```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**Provider Override Header**: `x-provider: anthropic`

Switch providers using the header:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-provider: anthropic" \
  -d '{
    "model": "claude-3-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Response Format

All responses are normalized to OpenAI format with additional metadata:

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1709980000,
  "model": "claude-3-sonnet",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  },
  "provider": "anthropic",
  "actual_cost": 0.00006,
  "latency_ms": 1250,
  "model_used": "claude-3-5-sonnet-20241022"
}
```

### List Models

**GET** `/v1/models`

Returns all available models across providers in OpenAI format.

### Provider Status

**GET** `/v1/providers`

Check which providers are configured:

```json
{
  "providers": [
    {"name": "anthropic", "available": true},
    {"name": "bedrock", "available": true},
    {"name": "azure", "available": false}
  ]
}
```

### Update Provider Config

**POST** `/v1/config/providers`

Update provider configuration at runtime:

```bash
curl -X POST http://localhost:3000/v1/config/providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "config": {
      "apiKey": "sk-ant-xxxxx"
    }
  }'
```

### Health Check

**GET** `/health`

## Pricing

The gateway calculates exact costs based on provider-specific pricing (per 1M tokens):

| Provider | Model | Input Cost | Output Cost |
|----------|-------|------------|-------------|
| Anthropic | claude-3-opus | $15.00 | $75.00 |
| Anthropic | claude-3-sonnet | $3.00 | $15.00 |
| Anthropic | claude-3-haiku | $0.25 | $1.25 |
| AWS Bedrock | claude-3-sonnet | $3.00 + AWS fees | $15.00 + AWS fees |
| Azure | gpt-4 | $30.00 | $60.00 |
| Azure | gpt-35-turbo | $0.50 | $1.50 |

AWS Bedrock includes additional EC2/Bedrock API costs per token.

## Client Examples

### JavaScript/Node.js

```javascript
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-provider': 'anthropic' // Optional: override provider
  },
  body: JSON.stringify({
    model: 'claude-3-sonnet',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France?' }
    ],
    temperature: 0.7,
    max_tokens: 500
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
console.log(`Cost: $${data.actual_cost}`);
console.log(`Latency: ${data.latency_ms}ms`);
console.log(`Provider: ${data.provider}`);
```

### Python

```python
import requests
import json

response = requests.post(
    'http://localhost:3000/v1/chat/completions',
    headers={
        'Content-Type': 'application/json',
        'x-provider': 'anthropic'
    },
    json={
        'model': 'claude-3-sonnet',
        'messages': [
            {'role': 'user', 'content': 'Hello!'}
        ]
    }
)

data = response.json()
print(data['choices'][0]['message']['content'])
print(f"Cost: ${data['actual_cost']}")
```

### OpenAI SDK Compatible

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'unused' // Required by OpenAI SDK
});

// Works with OpenAI SDK!
const chat = await client.chat.completions.create({
  model: 'claude-3-sonnet',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Universal Gateway                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│   │   Express    │───▶│   Gateway    │───▶│   Provider   │     │
│   │   Server     │    │   Service    │    │   Registry   │     │
│   └──────────────┘    └──────────────┘    └──────────────┘     │
│                              │                    │              │
│                              │          ┌─────────┴─────────┐   │
│                              │          │                   │   │
│                              ▼          ▼                   ▼   │
│                        ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│                        │  Pricing │ │Anthropic │ │ Bedrock  │  │
│                        │  Service │ │ Adapter  │ │ Adapter  │  │
│                        └──────────┘ └──────────┘ └──────────┘  │
│                                                     ┌──────────┐│
│                                                     │  Azure   ││
│                                                     │ Adapter  ││
│                                                     └──────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT
