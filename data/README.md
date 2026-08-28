# Runtime data

The application creates local runtime files in this folder. They are intentionally git-ignored and excluded from distributable patches because they may contain candidate/company information.

- `candidate-knowledge.json` — active Candidate Knowledge Pack
- `qa-bank.json` — Prepared Q&A guidance
- `qa-history.json` — generated-answer audit/review history; never searched by Generate Answer unless an approved answer is explicitly promoted into `qa-bank.json`

`qa-bank.example.json` is a versioned schema/example file.
