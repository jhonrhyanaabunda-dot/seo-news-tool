import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env } from "@/lib/env";
import { AiNarrativeSchema, type AiNarrative, type ReportFindings } from "./types";

/**
 * The only place the model is called. It receives verified findings and returns
 * wording and prioritisation in a fixed schema; groundNarrative() then discards
 * anything that does not match the findings. Scores, counts, statuses and issue
 * detection are never delegated to the model.
 */

const SYSTEM_PROMPT = `You write the narrative for an SEO report about a U.S. automotive dealership website, for dealership managers and marketing staff.

You receive the complete findings as JSON. They were produced by a website crawler and deterministic checks, and they are the only source of truth.

Rules:
- Use only facts present in the findings. Do not introduce issues, pages, numbers, causes, competitors or news that are not in the JSON.
- Every recommended action must use a checkKey that exists in findings.issues. Order actions by business impact, starting with CRITICAL and HIGH priority findings.
- Quote numbers only when they appear in the findings (scores, page counts, affected pages). Do not calculate new figures.
- Pages in findings.protectedPages could not be analysed because the website restricted automated access. They are not SEO problems; never describe them as errors on the site.
- If findings.scan.limitedHomepageCheckOnly is true, say that only a limited homepage check was possible.
- News highlights may only reference article ids from findings.news. Leave newsSummary null and newsHighlights empty when there are no articles.
- Write plainly for a non-technical reader. No markdown, no headings, no internal field names.`;

export interface AiCallResult {
  status: "succeeded" | "refused" | "invalid";
  narrative: AiNarrative | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  error: string | null;
}

export function aiReportsConfigured(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY);
}

export async function generateAiNarrative(findings: ReportFindings): Promise<AiCallResult> {
  const e = env();
  const client = new Anthropic({ apiKey: e.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 5 * 60_000 });
  const response = await client.beta.messages.parse({
    model: e.AI_REPORT_MODEL,
    max_tokens: 16000,
    // A policy decline is re-run server-side on Anthropic's recommended fallback model instead of failing the report.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: e.AI_REPORT_EFFORT, format: betaZodOutputFormat(AiNarrativeSchema) },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Findings:\n${JSON.stringify(findings)}` }],
  });

  const usage = {
    model: response.model,
    inputTokens: response.usage.input_tokens ?? null,
    outputTokens: response.usage.output_tokens ?? null,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
  };
  if (response.stop_reason === "refusal") {
    return { status: "refused", narrative: null, ...usage, error: "The model declined to write this report." };
  }
  if (!response.parsed_output) {
    return { status: "invalid", narrative: null, ...usage, error: `The model response did not match the report schema (stop reason: ${response.stop_reason}).` };
  }
  return { status: "succeeded", narrative: response.parsed_output, ...usage, error: null };
}
