import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let monacoConfigured = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function updateLanguageDiagnosticsOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setDiagnosticsOptions = Reflect.get(defaults, "setDiagnosticsOptions");
  if (typeof setDiagnosticsOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "diagnosticsOptions");
  setDiagnosticsOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateLanguageOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setOptions = Reflect.get(defaults, "setOptions");
  if (typeof setOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "options");
  setOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateModeConfiguration(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setModeConfiguration = Reflect.get(defaults, "setModeConfiguration");
  if (typeof setModeConfiguration !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "modeConfiguration");
  setModeConfiguration.call(defaults, updater(isRecord(current) ? current : {}));
}

export function ensureMonacoConfigured(): void {
  if (monacoConfigured) {
    return;
  }

  const environment = {
    getWorker(_: string, label: string) {
      switch (label) {
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "json":
          return new jsonWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  Object.assign(globalThis as object, {
    MonacoEnvironment: environment,
  });
  loader.config({ monaco });
  const typescriptNamespace = Reflect.get(monaco.languages, "typescript");
  const jsonNamespace = Reflect.get(monaco.languages, "json");
  const cssNamespace = Reflect.get(monaco.languages, "css");
  const htmlNamespace = Reflect.get(monaco.languages, "html");

  updateLanguageDiagnosticsOptions(typescriptNamespace, "javascriptDefaults", (current) => ({
    ...current,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: true,
  }));
  updateLanguageDiagnosticsOptions(typescriptNamespace, "typescriptDefaults", (current) => ({
    ...current,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: true,
  }));
  updateLanguageDiagnosticsOptions(jsonNamespace, "jsonDefaults", (current) => ({
    ...current,
    schemaRequest: "ignore",
    schemaValidation: "ignore",
    validate: false,
  }));
  updateModeConfiguration(jsonNamespace, "jsonDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateLanguageOptions(cssNamespace, "cssDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateModeConfiguration(cssNamespace, "cssDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateLanguageOptions(cssNamespace, "scssDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateModeConfiguration(cssNamespace, "scssDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateLanguageOptions(cssNamespace, "lessDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateModeConfiguration(cssNamespace, "lessDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateModeConfiguration(htmlNamespace, "htmlDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateModeConfiguration(htmlNamespace, "handlebarDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateModeConfiguration(htmlNamespace, "razorDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  monaco.editor.defineTheme("ace-carbon", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5c7084" },
      { token: "keyword", foreground: "f7a267" },
      { token: "string", foreground: "8dc891" },
    ],
    colors: {},
  });
  monaco.editor.defineTheme("ace-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7b8793" },
      { token: "keyword", foreground: "9f4f1d" },
      { token: "string", foreground: "2a6b4b" },
    ],
    colors: {},
  });
  monacoConfigured = true;
}
