import type { ProviderAdapterError } from "../Errors.ts";
import { createProviderAdapterTag } from "./createProviderAdapterTag.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "gemini";
}

export class GeminiAdapter extends createProviderAdapterTag<GeminiAdapter, GeminiAdapterShape>(
  "ace/provider/Services/GeminiAdapter",
) {}
