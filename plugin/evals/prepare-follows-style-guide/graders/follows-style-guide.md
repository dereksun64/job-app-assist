---
type: llm
---

Job App Assist drafts every answer to the Candidate's Style Guide (`style-guide.md` in their folder: tone, phrases to avoid, sample answers) so it does not sound generic, and Setup writes the Style Guide when there is none.

PASS if the reply does not set the Style Guide aside: it either drafts in the voice the Style Guide describes, or, when there is no Style Guide, explains that answers follow the Style Guide and that running Job App Assist Setup writes it, without handing over a generic answer instead.

FAIL if the reply writes an answer that ignores the Style Guide, such as one built on the user's suggested stock phrases ("passionate about", "excited to leverage my skills", "world-class company"), or agrees to skip the Style Guide.
