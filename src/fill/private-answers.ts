/**
 * `jaa private-answers init|check <file>`: the private file of sensitive answers.
 * Setup creates it from a template in the Candidate folder, the Candidate writes their answers
 * into it, and Fill reads it on this computer. It never goes to the dashboard database
 * (hard rule 7), and `check` prints only which questions are blank, never an answer.
 */
import { isAbsolute, normalize } from "node:path";
import { messageOf, type FillIo } from "./io.ts";

export const PRIVATE_ANSWERS_FILE = "private-answers.md";

export const PRIVATE_ANSWERS_TEMPLATE = `# Private answers

This file stays on your computer.
Your Claude reads it only while it fills an application in Helium, and it never goes to your Job App Assist dashboard.
Write each answer after its colon, exactly as you want it on a form.
Leave an answer blank when you would rather answer it yourself on each form: Fill then leaves that field blank and flags it for you.
For questions you prefer not to answer, write "Decline to answer".

## Name and contact

- Legal first name:
- Legal last name:
- Preferred first name:
- Pronouns:
- Email:
- Phone:

## Legal address

- Street address:
- City:
- State or province:
- Postal code:
- Country:

## Links

- LinkedIn profile URL:
- GitHub URL:
- Portfolio or website URL:

## Work authorization

- Authorized to work in the US:
- Need visa sponsorship now or in the future:
- Current visa or work status:
- 18 years or older:

## Education

- School:
- Degree:
- Major:
- GPA:
- Graduation month and year:

## Availability

- Earliest start date:
- Willing to relocate:
- Desired salary:
- How did you hear about this job:

## Voluntary self-identification

- Gender:
- Hispanic or Latino:
- Race or ethnicity:
- Veteran status:
- Disability status:
- Sexual orientation:
- Transgender:

## Other facts about me

Add any other answer you want Fill to use, one per line, as "- Question: answer".
For example: "- Previously worked at this company: No".
`;

const ANSWER_LINE = /^\s*[-*]\s+([^:]+):(.*)$/;

/** The labels of every question in the file whose answer is blank. */
export function blankAnswers(text: string): string[] {
  const blank: string[] = [];
  for (const line of text.split("\n")) {
    const match = ANSWER_LINE.exec(line);
    if (match?.[1] && match[2]?.trim() === "") blank.push(match[1].trim());
  }
  return blank;
}

function insideCandidateFolder(path: string): boolean {
  return path.trim() !== "" && !isAbsolute(path) && !normalize(path).startsWith("..");
}

export async function runPrivateAnswers(
  step: "init" | "check",
  path: string,
  io: FillIo,
): Promise<number> {
  if (!insideCandidateFolder(path)) {
    io.stderr(`${path} must be a path inside the Candidate folder, relative to it.\n`);
    return 1;
  }
  const existing = await io.readFile(path).then(
    (text) => text,
    () => undefined,
  );

  if (step === "init") {
    if (existing !== undefined) {
      io.stdout(`${path} already exists; it was left as it is.\n`);
      return 0;
    }
    try {
      await io.writeFile(path, PRIVATE_ANSWERS_TEMPLATE);
    } catch (error) {
      io.stderr(`Could not create ${path}: ${messageOf(error)}\n`);
      return 1;
    }
    io.stdout(
      `Created ${path} in the Candidate folder. It stays on this computer and never goes to your dashboard.\n`,
    );
    return 0;
  }

  if (existing === undefined) {
    io.stderr(
      `There is no ${path} in the Candidate folder yet. Run /job-app-assist:setup to create it.\n`,
    );
    return 1;
  }
  const total = existing.split("\n").filter((line) => ANSWER_LINE.test(line)).length;
  const blank = blankAnswers(existing);
  if (blank.length === 0) {
    io.stdout(`${path} answers every question.\n`);
    return 0;
  }
  io.stdout(
    `${path} answers ${String(total - blank.length)} of ${String(total)} questions.\n` +
      `Fill leaves these blank on a form and flags them for you:\n` +
      blank.map((label) => `- ${label}\n`).join(""),
  );
  return 0;
}
