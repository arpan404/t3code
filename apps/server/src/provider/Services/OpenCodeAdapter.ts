import type { ProviderAdapterError } from "../Errors.ts";
import { createProviderAdapterTag } from "./createProviderAdapterTag.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

export class OpenCodeAdapter extends createProviderAdapterTag<
  OpenCodeAdapter,
  OpenCodeAdapterShape
>("ace/provider/Services/OpenCodeAdapter") {}
