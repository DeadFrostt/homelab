import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Run inside the web container with configuration supplied privately on stdin.
// Uses only synthetic content; does not read or modify mailbox data.
const require = createRequire('/app/apps/web/package.json');
const { generateObject, generateText, tool } = require('ai');
const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
const { z } = require('zod');
const { apiKey, modelId } = JSON.parse(readFileSync(0, 'utf8'));
const model = createOpenAICompatible({
  name: 'openai-compatible',
  baseURL: 'https://api.lithosai.cloud/v1',
  apiKey,
  supportsStructuredOutputs: true,
})(modelId);
const schema = z.object({ category: z.enum(['invoice', 'newsletter', 'personal']) });
const prompt = 'Classify this synthetic email: Subject: Example service invoice. Body: This is an invoice for a fictional subscription. No real customer data.';
let started = Date.now();
const classification = await generateObject({
  model, schema, prompt, maxRetries: 0, maxOutputTokens: 1024,
  abortSignal: AbortSignal.timeout(60000),
});
assert.equal(classification.object.category, 'invoice');
console.log(JSON.stringify({ test: 'structured_classification', status: 'PASS', elapsedMs: Date.now() - started, model: modelId }));
started = Date.now();
const chat = await generateText({
  model, prompt: prompt + ' Call classify_email with the category.',
  tools: { classify_email: tool({ description: 'Record a synthetic category.', inputSchema: schema }) },
  toolChoice: { type: 'tool', toolName: 'classify_email' },
  maxRetries: 0, maxOutputTokens: 1024,
  abortSignal: AbortSignal.timeout(60000),
});
assert.equal(chat.toolCalls[0]?.toolName, 'classify_email');
assert.equal(chat.toolCalls[0]?.input.category, 'invoice');
console.log(JSON.stringify({ test: 'tool_calling', status: 'PASS', elapsedMs: Date.now() - started, model: modelId }));
