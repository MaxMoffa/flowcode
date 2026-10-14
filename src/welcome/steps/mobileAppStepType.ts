import { z } from "zod";
import { baseStepFields, registerStepType } from "@flowkit-io/core";

/** An informative step about the Android companion app, with a button that
 * opens its download page (see MobileAppStepView.tsx). It collects no answer,
 * so it's never blocking. Same recipe as themeCustomize. */
const mobileAppStepSchema = z.object({
  ...baseStepFields,
  type: z.literal("mobileApp"),
});

export type MobileAppStep = z.infer<typeof mobileAppStepSchema>;

declare module "@flowkit-io/core" {
  interface StepTypeMap {
    mobileApp: MobileAppStep;
  }
}

registerStepType<MobileAppStep, string>({
  type: "mobileApp",
  schema: mobileAppStepSchema,
  validate: () => true,
});
