import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_MAX_BYTES = 2 * 1024 * 1024;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectListTreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListTreeInput = typeof ProjectListTreeInput.Type;

export const ProjectListTreeResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListTreeResult = typeof ProjectListTreeResult.Type;

export class ProjectListTreeError extends Schema.TaggedErrorClass<ProjectListTreeError>()(
  "ProjectListTreeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectCreateEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  kind: ProjectEntryKind,
});
export type ProjectCreateEntryInput = typeof ProjectCreateEntryInput.Type;

export const ProjectCreateEntryResult = Schema.Struct({
  kind: ProjectEntryKind,
  relativePath: TrimmedNonEmptyString,
});
export type ProjectCreateEntryResult = typeof ProjectCreateEntryResult.Type;

export class ProjectCreateEntryError extends Schema.TaggedErrorClass<ProjectCreateEntryError>()(
  "ProjectCreateEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectRenameEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  nextRelativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
  ),
});
export type ProjectRenameEntryInput = typeof ProjectRenameEntryInput.Type;

export const ProjectRenameEntryResult = Schema.Struct({
  previousRelativePath: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
});
export type ProjectRenameEntryResult = typeof ProjectRenameEntryResult.Type;

export class ProjectRenameEntryError extends Schema.TaggedErrorClass<ProjectRenameEntryError>()(
  "ProjectRenameEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectDeleteEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

export const ProjectDeleteEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectDeleteEntryResult = typeof ProjectDeleteEntryResult.Type;

export class ProjectDeleteEntryError extends Schema.TaggedErrorClass<ProjectDeleteEntryError>()(
  "ProjectDeleteEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  sizeBytes: NonNegativeInt,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export { PROJECT_READ_FILE_MAX_BYTES };
