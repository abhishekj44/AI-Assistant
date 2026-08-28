# Prompt source of truth

Edit runtime prompt wording in this directory, not in API routes or UI components.

- `common.ts` — shared quality rules/style defaults
- `givingInterview.ts` — local user is candidate
- `takingInterview.ts` — local user is interviewer
- `meeting.ts` — neutral meeting participant
- `summarizer.ts` — mode-specific transcript summaries
- `memory.ts` — mode-specific rolling memory
- `knowledgeExtraction.ts` — Knowledge Pack extraction
- `index.ts` — prompt registry / call-type lookup
