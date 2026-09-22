import { z } from "zod";
import { baseStepFields, registerStepType } from "@flowkit-io/core";

/** A folder-picker step (native OS dialog via `installer_pick_dir`, see
 * DirectoryStepView.tsx) - flowkit ships no built-in step type for this, so
 * it's registered here as a custom one. Reuses `baseStepFields` (id/title/
 * subtitle/image/required/...) so it gets the same title-icon/subtitle
 * rendering as every built-in step for free (see StepTitle in flowkit's own
 * step components) - only `placeholder` is added on top. */
const directoryStepSchema = z.object({
  ...baseStepFields,
  type: z.literal("directory"),
  placeholder: z.string().optional(),
});

export type DirectoryStep = z.infer<typeof directoryStepSchema>;

// Lets `DirectoryStep` satisfy flowkit's `Step` union (StepComponentProps<T
// extends Step>, etc.) without a cast at every use site - see the
// StepTypeMap doc comment in @flowkit-io/core for why this is opt-in.
declare module "@flowkit-io/core" {
  interface StepTypeMap {
    directory: DirectoryStep;
  }
}

registerStepType<DirectoryStep, string>({
  type: "directory",
  schema: directoryStepSchema,
  // `required` defaults to true (baseStepFields) - a blank path can't be
  // installed to, but the step ships with a default already filled in
  // (see InstallerFlow.tsx's `initialAnswers`), so this only ever fires if
  // the user clears the field by hand.
  validate: (step, value) => step.required === false || (typeof value === "string" && value.trim().length > 0),
});
