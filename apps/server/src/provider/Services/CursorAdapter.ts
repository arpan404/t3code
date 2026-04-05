import type { ProviderAdapterError } from "../Errors.ts";
import { createProviderAdapterTag } from "./createProviderAdapterTag.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CursorAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cursor";
}

export class CursorAdapter extends createProviderAdapterTag<CursorAdapter, CursorAdapterShape>(
  "ace/provider/Services/CursorAdapter",
) {}
