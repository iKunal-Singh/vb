/**
 * QuickRupee Voice Bot — Post-Call Claude Worker
 *
 * Generates structured callback notes for the sales team
 * using Claude after a call completes.
 *
 * CRITICAL: This module runs OUTSIDE the real-time path.
 * It is invoked asynchronously after the call ends.
 * Latency here is irrelevant — correctness and reliability matter.
 *
 * Features:
 *   - Structured JSON output (CallbackNote)
 *   - Retry with exponential backoff (max 3 attempts)
 *   - Rate limiting awareness
 *   - Full transcript + eligibility context passed to Claude
 *   - Logs results for downstream consumption
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CallbackNoteJob, CallbackNote } from '../types/index.js';
import { LLMError } from '../utils/errors.js';
import { logger, maskPhoneNumber } from '../utils/logger.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

/**
 * Process a post-call callback note generation job.
 *
 * This function is fire-and-forget — the caller does not await
 * the result. It logs everything for async retrieval.
 *
 * @param job - Call data including transcript and eligibility
 */
export async function processCallbackNote(job: CallbackNoteJob): Promise<void> {
    const log = logger.child({
        component: 'llm',
        callId: job.callId,
        phone: maskPhoneNumber(job.phoneNumber),
    });

    // Skip if Anthropic API key is not configured
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey || apiKey.startsWith('sk-ant-xxxx')) {
        log.warn('Skipping post-call LLM processing: ANTHROPIC_API_KEY not configured');
        return;
    }

    const claudeModel = process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514';

    log.info({
        event: 'llm_job_started',
        transcriptTurns: job.transcript.length,
        eligible: job.eligibilityResult.eligible,
    });

    const client = new Anthropic({ apiKey });

    // Build the prompt with full context
    const transcriptText = job.transcript
        .map((t) => `${t.speaker.toUpperCase()}: ${t.text}`)
        .join('\n');

    const prompt = `You are a sales assistant for QuickRupee, a digital lending company in India. Generate a concise callback note for the sales team based on this automated loan screening call.

TRANSCRIPT:
${transcriptText}

ELIGIBILITY RESULT:
- Eligible: ${job.eligibilityResult.eligible}
- Employment: ${job.eligibilityResult.isSalaried ? 'Salaried' : 'Not salaried'}
- Monthly Salary: ${job.eligibilityResult.salary !== null ? `₹${job.eligibilityResult.salary.toLocaleString('en-IN')}` : 'Not provided'}
- Location: ${job.eligibilityResult.location ?? 'Not provided'}

Respond ONLY with a JSON object (no markdown, no explanation):
{
  "summary": "2-3 sentence summary of the call for the sales team",
  "urgency": "high" | "medium" | "low",
  "recommendedAction": "specific next step for the sales team",
  "customerSentiment": "positive" | "neutral" | "negative",
  "notes": "any additional relevant context from the conversation"
}`;

    // Retry with exponential backoff
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.messages.create({
                model: claudeModel,
                max_tokens: 500,
                messages: [{ role: 'user', content: prompt }],
            });

            // Extract text content
            const textBlock = response.content.find((block) => block.type === 'text');
            if (!textBlock || textBlock.type !== 'text') {
                throw new LLMError('No text content in Claude response', 'LLM_EMPTY_RESPONSE');
            }

            // Parse the JSON response
            const rawText = textBlock.text.trim();
            // Strip markdown code fences if present
            const jsonText = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

            const note: CallbackNote = JSON.parse(jsonText) as CallbackNote;

            // Validate required fields
            if (!note.summary || !note.urgency || !note.recommendedAction) {
                throw new LLMError('Invalid callback note structure', 'LLM_INVALID_OUTPUT');
            }

            log.info({
                event: 'llm_callback_note_generated',
                callId: job.callId,
                summary: note.summary,
                urgency: note.urgency,
                sentiment: note.customerSentiment,
                recommendedAction: note.recommendedAction,
                attempt,
            });

            // In production, this would persist to the database.
            // For now, we log the structured result.
            log.info({
                event: 'callback_note_saved',
                callId: job.callId,
                note,
            });

            return; // Success — exit retry loop

        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            log.warn({
                event: 'llm_attempt_failed',
                attempt,
                maxRetries: MAX_RETRIES,
                error: lastError.message,
            });

            if (attempt < MAX_RETRIES) {
                const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
                log.info({ event: 'llm_retry_backoff', backoffMs });
                await sleep(backoffMs);
            }
        }
    }

    // All retries exhausted
    log.error({
        event: 'llm_job_failed',
        callId: job.callId,
        error: lastError?.message,
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
