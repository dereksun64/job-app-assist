import type { Posting, ResumeVariantPick, VariantOverride } from "../contract/index.ts";

/** The Resume Variant a Posting will use: the Candidate's own choice, or else Refresh's pick. */
export interface ChosenVariant {
  name: string;
  /** True when the Candidate chose it in the drawer. */
  byCandidate: boolean;
  /** What Refresh picked, and why. */
  pick: ResumeVariantPick;
}

/**
 * A Candidate's choice counts only while it names one of their current Resume Variants and
 * differs from Refresh's pick; otherwise the Posting uses Refresh's pick.
 */
export function chosenVariant(
  posting: Posting,
  override: VariantOverride | undefined,
  variants: readonly string[],
): ChosenVariant {
  const pick = posting.resumeVariant;
  const byCandidate =
    override !== undefined && override.variant !== pick.name && variants.includes(override.variant);
  return { name: byCandidate ? override.variant : pick.name, byCandidate, pick };
}
