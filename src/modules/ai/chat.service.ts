import { generateStructured } from '../../ai/ai.service.js';
import type { AIProvider } from '../../ai/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';

import { contextString, readQAContext } from './analysis.service.js';
import { QA_REPORT_TYPE } from './ai.types.js';
import { AI_DISCLAIMER, qaSystemPrompt, wrapContext, wrapQuestion } from './prompts.js';
import { qaOutputSchema, type QAOutput } from './reports.schema.js';

/**
 * Financial Q&A orchestration (Phase 12, ARCHITECTURE.md §7/§8). Mirrors reports.service but for a
 * free-text question: build the aggregate-only Q&A context (analysis.service, the sole Prisma
 * caller — R-I1), refuse with NO_DATA (422) when the user has nothing to answer from, then hand the
 * AI Service a fixed system prompt plus two clearly separated untrusted blocks — the aggregates in
 * <financial_data> and the length-capped question in <user_question> (R-I3). The validated answer is
 * persisted as an `AIReport` row of kind QA whose `content` is `{ question, answer }` (R-I7), so it
 * appears in history like any report. Quota, JSON-mode, validation and the single repair retry all
 * live in the AI Service; a reused report has no analogue here — every question costs one quota unit.
 * Unlike the four reports there is no 24h reuse: each question is distinct free text, so caching a
 * prior answer would answer the wrong question. Every response carries the disclaimer (R-I5).
 */

export interface ChatOptions {
  /** Injected clock, threaded to both the context window and the quota window (R-T6). */
  now?: Date;
  /** Overrides the env-selected provider; tests inject the mock here (R-T4). */
  provider?: AIProvider;
}

/** The chat endpoint's payload: the answer text, the persisted row's id, and the disclaimer (R-I5). */
export interface ChatAnswer {
  answer: string;
  reportId: string;
  disclaimer: string;
}

/** What a stored QA row's `content` column holds: the asked question paired with the model's answer. */
interface QAStoredContent {
  question: string;
  answer: string;
}

/**
 * Answer one already-validated (trimmed, ≤`AI_CHAT_QUESTION_MAX`) question about the user's finances:
 * build the aggregate-only context (NO_DATA when there is nothing to answer from), generate and
 * validate the answer through the AI Service, persist it as a QA report (R-I7), and return it with
 * its disclaimer. The question is passed through untouched — the prompt layer wraps it as data.
 */
export async function answerQuestion(
  userId: string,
  question: string,
  options: ChatOptions = {},
): Promise<ChatAnswer> {
  const now = options.now ?? new Date();

  const context = await readQAContext(userId, now);
  if (context === null) {
    throw new AppError(
      'NO_DATA',
      'There is not enough of your data yet to answer questions about your finances.',
    );
  }

  const { data } = await generateStructured<QAOutput>(
    userId,
    {
      system: qaSystemPrompt(),
      user: `${wrapContext(contextString(context))}\n\n${wrapQuestion(question)}`,
      schema: qaOutputSchema,
    },
    { now: now.getTime(), provider: options.provider },
  );

  const content: QAStoredContent = { question, answer: data.answer };
  const row = await prisma.aIReport.create({
    data: { userId, type: QA_REPORT_TYPE, content: content as unknown as Prisma.InputJsonValue },
  });

  return { answer: data.answer, reportId: row.id, disclaimer: AI_DISCLAIMER };
}
