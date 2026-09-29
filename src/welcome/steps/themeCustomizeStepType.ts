import { z } from "zod";
import { baseStepFields, registerStepType } from "@flowkit-io/core";

/** A theme-customization step: colour palette + contrast, applied live (see
 * ThemeCustomizeStepView.tsx). flowkit ships nothing like it, so it's a
 * custom step type - same recipe as the installer's "directory" step. It
 * writes straight to the theme store instead of an answer, so it's never
 * blocking. */
const themeCustomizeStepSchema = z.object({
  ...baseStepFields,
  type: z.literal("themeCustomize"),
});

export type ThemeCustomizeStep = z.infer<typeof themeCustomizeStepSchema>;

declare module "@flowkit-io/core" {
  interface StepTypeMap {
    themeCustomize: ThemeCustomizeStep;
  }
}

registerStepType<ThemeCustomizeStep, string>({
  type: "themeCustomize",
  schema: themeCustomizeStepSchema,
  validate: () => true,
});
