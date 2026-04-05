import type { ProviderAdapterError } from "../Errors.ts";
import { createProviderAdapterTag } from "./createProviderAdapterTag.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GitHubCopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "githubCopilot";
}

export class GitHubCopilotAdapter extends createProviderAdapterTag<
  GitHubCopilotAdapter,
  GitHubCopilotAdapterShape
>("ace/provider/Services/GitHubCopilotAdapter") {}
