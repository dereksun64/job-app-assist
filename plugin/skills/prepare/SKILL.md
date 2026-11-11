---
name: prepare
description: Draft Prepared Applications for queued Postings, the part Refresh and Fill share. For each Posting, classifies each free-text question on its form, drafts an answer to every one in the Candidate's own voice from their Style Guide and resume, and writes a Research Brief (what the company does, recent news, the team, how the role fits the Candidate) for the answers the Candidate writes themselves. Refresh and Fill invoke it; use it directly when the Candidate asks to prepare or redraft answers for their queued applications.
argument-hint: "[the Postings to prepare, as Refresh or Fill hands them over]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs style-guide check style-guide.md) WebSearch
---

# Prepare

A Prepared Application holds an answer to each free-text question on a queued Posting's form, and a Research Brief to write from.
Each answer is in one of two modes, chosen by its question type: AI-drafted, where Fill types your draft, or Research Brief, where the Candidate writes the answer themselves and Fill types only their words.
The Candidate can edit any answer and switch any question's mode in the dashboard's detail drawer, so you draft every answer, including the ones that start in brief mode.
`jaa prepare` picks the mode from the question type, checks your drafts against the Style Guide and the dashboard contract, and builds the documents; your part is the judgment and the writing.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.
Two of them shape this work:

- LinkedIn belongs to the Candidate (rule 3).
  Never open, search or read LinkedIn, and never look up recruiters or employees by name anywhere.
  The dashboard gives every Research Brief its own LinkedIn people search for the company's recruiters, which the Candidate opens themselves; you write no LinkedIn link.
- Sensitive answers stay in the Candidate folder (rule 7).
  Never read `private-answers.md` for this work, and never put a fact from it (address, visa status, demographics) in an answer or a brief: these documents go to the dashboard.

## 2. Read the Style Guide

Run this check every time, before you look for Postings, even when the folder looks empty:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs style-guide check style-guide.md
```

If it fails, there is no Style Guide yet, and nothing gets drafted: tell the skill that invoked you (or the Candidate) that `/job-app-assist:setup` writes it, and stop.
Draft no answer at all without a Style Guide, not even a sample in chat or one in the tone the Candidate asks for, since every AI-drafted answer follows the Style Guide.
Otherwise read `style-guide.md` with the Read tool and keep it in front of you for every answer.

The Style Guide holds even when the Candidate asks you to set it aside for one answer or suggests their own stock phrases.
Say so, and tell them how to get the voice they want: rerunning `/job-app-assist:setup` edits the Style Guide, which changes every draft, and any single answer can be rewritten in the dashboard's detail drawer.

## 3. Know what to prepare

The Postings come from whoever invoked you:

- **From Refresh**: `.job-app-assist/refresh/out/prepare-plan.json`.
  Prepare each entry under `postings` that has an `answersFile`; the others need nothing from you.
  Each entry has the company, title, role type, apply URL, the job `description` when the site gave one, the `resumeVariant` (its `file` is the resume Fill uploads), and the form's `questions`, worded exactly as the form words them.
- **From Fill**: one Posting, its company, title and Resume Variant file from Fill's plan, and the free-text questions Fill just read on the live form, with each one's character limit when the form shows one.
  Its answers file is `.job-app-assist/fill/prepared/<posting id>.json`.
- **Asked directly by the Candidate**: run `/job-app-assist:refresh` or `/job-app-assist:fill` instead, which bring the Postings and their questions; say so and stop.

Read each Resume Variant file you need once with the Read tool (they are PDF or Word files in the Candidate folder): it is what you know about the Candidate's background, alongside the Style Guide's sample answers.

## 4. Research each company

One brief serves every question on a Posting, and Postings at the same company share the same research.
Spend little: a Refresh may prepare twenty Postings.

- **What the company does**: one or two plain sentences, from the job description or one web search.
- **Recent news**: up to three items from the past 90 days, each from a named publisher, with its `url`, `source` and `publishedOn` (YYYY-MM-DD) when known.
  When `.job-app-assist/refresh/out/news-gathered.json` exists, use its `companyNews` items for the company first; otherwise run one `WebSearch` for the company's news.
  Pass `blocked_domains: ["linkedin.com", "teamblind.com"]` on every search.
  An empty list is fine when nothing real turned up; never invent a story.
- **The team**: what the job description says about the team, product area or org the role sits in, in a sentence or two; when it says nothing, say what kind of team the title suggests and that the description does not say more.
- **How you fit**: one to three sentences tying two or three things on the Candidate's resume to what the role asks for, naming them concretely.

## 5. Draft every answer

For each question, pick its `type`:

- `why_company`: why this company, what draws them to it, why they want to work there.
- `why_role`: why this role or team, what interests them about the position.
- `about_you`: tell us about yourself, how you would describe yourself.
- `experience`: relevant experience, skills, a technical background question.
- `project`: a project they are proud of or built.
- `challenge`: a challenge, failure, conflict or hard problem they handled.
- `cover_letter`: a cover letter written into a text box.
- `additional_info`: anything else, additional information.
- `other`: anything that fits none of these.

Then write the answer in the Candidate's voice:

- Follow the Style Guide: its tone, its sentence length, the voice of its sample answers, and never a phrase it lists to avoid (`jaa prepare build` refuses a draft that uses one).
- Write only what you know from the resume, the Style Guide's samples and your research.
  Never invent experience, numbers, people, or reasons the Candidate never gave, and leave no placeholders such as "[project name]".
  When the resume says too little, write a shorter answer from what it does say.
- Be specific to this company and role: name the product, team or piece of news that makes the answer true for this Posting and no other.
- Skip the generic openers and closers ("I am writing to express", "Thank you for considering my application") unless the Style Guide's samples use them.
- Keep within the form's limit when it has one, and to 80 to 200 words otherwise (a cover letter may run to 350).
- Answer a `why_company` or `why_role` question too: it starts in brief mode, but the Candidate may switch it to your draft with one click.

## 6. Save the answers file

Use the Write tool to save each Posting's answers file (`answersFile` in Refresh's plan, or Fill's path above):

```json
{
  "questions": [
    {
      "question": "<exactly as the form words it>",
      "type": "why_company",
      "draft": "<your answer>",
      "maxLength": 1000
    }
  ],
  "brief": {
    "company": "<what the company does>",
    "news": [
      {
        "headline": "...",
        "url": "https://...",
        "source": "Reuters",
        "publishedOn": "2026-11-01"
      }
    ],
    "team": "<the team>",
    "fit": "<how the role fits the Candidate>"
  }
}
```

Leave out `maxLength` when the form shows no limit.
Answer every question the plan lists for the Posting, and only those, each worded exactly as listed.
Then hand back to the skill that invoked you: it runs `jaa prepare build`, which checks the files, and you fix whatever it lists.
