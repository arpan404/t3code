import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { Equal } from "effect";

/**
 * Treat the default text-generation setting as "use the current chat model when available".
 * Once the user explicitly changes the dedicated text-generation model, that override wins.
 */
export function resolveTextGenerationModelSelection(input: {
  serverSettings: ServerSettings;
  fallbackModelSelection?: ModelSelection | null | undefined;
}): ModelSelection {
  const settingsSelection = input.serverSettings.textGenerationModelSelection;
  if (!Equal.equals(settingsSelection, DEFAULT_SERVER_SETTINGS.textGenerationModelSelection)) {
    return settingsSelection;
  }
  return input.fallbackModelSelection ?? settingsSelection;
}
