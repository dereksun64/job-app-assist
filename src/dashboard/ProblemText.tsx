const COMMAND = /(\/job-app-assist:[a-z-]+)/;

/** A problem sentence for the Candidate, with any Toolkit command in it shown as code. */
export function ProblemText({ text }: { text: string }) {
  return (
    <>{text.split(COMMAND).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</>
  );
}
