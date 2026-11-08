import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { processedTokens } from "../shared/agent-settings.ts";
import { askPageModel } from "./artifacts/page-features.ts";
import { SCRIPT_MODEL } from "./dev-model.ts";
import { GeminiCompat } from "./gemini.ts";
import { catalogSource, gatewayAI, internalModel, loadCatalog, piModels } from "./models.ts";
import { Storage } from "./storage/index.ts";
import type { DreamAnswer } from "./memory/dream.ts";

/** How long a dream's answer may be: a few notes and a summary. */
const DREAM_TOKENS = 2_000;

/** pi-ai's models for dreams, made once per isolate (as pages' are). */
let made: Models | undefined;

/**
 * One dream's model call: the deployment's background model (DREAM_MODEL, read through internalModel: a small, cheap
 * one) when this deployment can run it, else the agent's own model, at low effort (askPageModel). Null when there is none.
 * Nothing it answers is followed: the dream reads its answer as JSON data (checkDreamOutput) and places every note itself.
 */
export async function completeDream(env: Env, ownModel: string | undefined, system: string, prompt: string): Promise<DreamAnswer | null> {
  const source = catalogSource(env, new Storage(env).models);
  if (!made) {
    const gemini = new GeminiCompat();
    made = piModels(gatewayAI(env, gemini).provider, gemini, { scripted: source.scripted });
  }
  const catalog = await loadCatalog(source);
  const background = catalog.model(internalModel(env.DREAM_MODEL));
  const named = background ? [background] : [];
  const own = ownModel ? catalog.model(ownModel) : undefined;
  const scripted = source.scripted ? catalog.model(SCRIPT_MODEL) : undefined;
  const candidates = [...named, ...(own ? [own] : []), ...(scripted ? [scripted] : [])] as Model<Api>[];
  if (!candidates.length) return null;
  const answer = await askPageModel(made, candidates, { system, messages: [{ role: "user", content: prompt }], maxTokens: DREAM_TOKENS, json: true });
  const spent = { tokens: processedTokens(answer.usage), costUsd: answer.usage.cost.total };
  // An answer that is not the JSON asked for is still read (jsonIn): checkDreamOutput refuses what does not check out.
  if (answer.ok) return { text: answer.text, ...spent };
  if (answer.error.code === "bad_output") return { text: "", ...spent };
  throw new Error(answer.error.message);
}
