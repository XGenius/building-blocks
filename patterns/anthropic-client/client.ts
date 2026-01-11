/**
 * Centralized Anthropic Client Configuration
 *
 * Provides a properly configured Anthropic client with:
 * - Increased timeout for reliable connections
 * - Automatic retries with exponential backoff
 * - Connection pooling friendly settings
 *
 * Usage:
 *   import { anthropic } from './config/anthropicClient';
 *
 *   const response = await anthropic.messages.create({
 *     model: 'claude-sonnet-4-20250514',
 *     max_tokens: 1024,
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *   });
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Anthropic client instance
 *
 * Configuration:
 * - timeout: 5 minutes (300000ms) - allows for slow API responses under load
 * - maxRetries: 3 - retries on transient failures (network issues, rate limits)
 *
 * The SDK automatically handles:
 * - Exponential backoff between retries
 * - Rate limit handling (429 responses)
 * - Transient network errors
 */
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 300000, // 5 minutes - generous timeout for API calls
  maxRetries: 3, // Retry up to 3 times on transient failures
});

// Export for backwards compatibility
export default anthropic;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Simple text completion helper
 *
 * @param prompt - The user message
 * @param systemPrompt - Optional system prompt
 * @param maxTokens - Maximum tokens to generate (default: 1024)
 * @returns The generated text
 */
export async function complete(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 1024
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    ...(systemPrompt && { system: systemPrompt }),
    messages: [{ role: "user", content: prompt }],
  });

  // Extract text from response
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.text || "";
}

/**
 * JSON completion helper with parsing
 *
 * @param prompt - The user message
 * @param systemPrompt - Optional system prompt (should instruct JSON output)
 * @param maxTokens - Maximum tokens to generate
 * @returns Parsed JSON object
 */
export async function completeJson<T>(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 2048
): Promise<T> {
  const response = await complete(prompt, systemPrompt, maxTokens);

  // Extract JSON from response (handles markdown code blocks)
  let jsonStr = response;

  // Remove markdown code blocks if present
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  return JSON.parse(jsonStr) as T;
}

/**
 * Streaming completion helper
 *
 * @param prompt - The user message
 * @param systemPrompt - Optional system prompt
 * @param onChunk - Callback for each text chunk
 * @param maxTokens - Maximum tokens to generate
 */
export async function streamComplete(
  prompt: string,
  systemPrompt: string | undefined,
  onChunk: (text: string) => void,
  maxTokens: number = 1024
): Promise<string> {
  const stream = await anthropic.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    ...(systemPrompt && { system: systemPrompt }),
    messages: [{ role: "user", content: prompt }],
  });

  let fullText = "";

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      const text = event.delta.text;
      fullText += text;
      onChunk(text);
    }
  }

  return fullText;
}
