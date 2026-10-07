# AI Meeting Copilot

An assistant for interviews and meetings. It turns live audio into text and suggests answers or follow-up questions using your documents and prepared Q&A.

## What Is New

- **One local database:** sessions, transcripts, summaries, knowledge, Q&A, answers, prompts, chat and settings now use SQLite instead of separate JSON files.
- **Fast local search:** SQLite FTS5 finds relevant knowledge by words, phrases and technical terms. No Pinecone account or separate vector database is needed.
- **One saved resume:** Giving Interview automatically uses your resume from the default Candidate Knowledge base. You enter the job title, optional company, job description, seniority and additional context for that interview.
- **Candidate-specific setup:** Taking Interview asks for a fresh candidate profile and uses the candidate's responses together with your questions and both speakers' conversation. Shared audio and your microphone are required; your own resume and personal Q&A are excluded.
- **Per-session interview context:** job descriptions and candidate profiles are saved with the relevant session and included in answers, rolling memory and summaries, not reused as global preferences.
- **Separate reference bases:** additional knowledge bases remain available for meeting/reference material; interview setup no longer asks you to choose a resume.
- **Continuous saving:** finalized speech is saved during the call. When a session ends, one summary is generated afterwards without delaying transcript saving; if it fails, use **Retry summary** in Local Data.
- **Editable prompts:** each call type has its own prompt. Saving replaces that prompt, and **Reset to Default** restores the built-in text.
- **Safer history:** completed and interrupted answers are kept separate. Generated answers become prepared Q&A only after you approve and promote them.
- **Local data tools:** view old sessions, download backups and rebuild the search index from **Knowledge & Q&A > Local Data**.

The database is created automatically at `data/copilot.db`. You do not need to install SQLite separately.

**Local storage does not mean offline AI.** Audio transcription and AI responses still use online providers and may incur charges. API keys stay in your environment file, not the database. Raw audio and video are not saved.

## Setup On A New Device

The commands below are for **Windows PowerShell**. On macOS/Linux, use `npm` instead of `npm.cmd`, and `cp` instead of `Copy-Item`.

### 1. Install The Requirements

- [Node.js](https://nodejs.org/) version **22 or newer**, including npm.
- [Git](https://git-scm.com/downloads), if you will clone the project.
- Chrome or Edge for system/tab audio capture.
- A Deepgram API key with **Member-or-higher** permission.
- A Gemini API key for the default AI model, document extraction and meeting memory.

Cerebras/Groq for alternative answers and Tavily for web search are optional. No Docker or database server is required.

### 2. Get The Project And Install Packages

Use the project version that contains this database update. Changes that exist only on your old device must be transferred or pushed before a new clone can include them.

```powershell
git clone https://github.com/abhishekj44/AI-Assistant.git
cd AI-Assistant
npm.cmd ci
Copy-Item .env.example .env.local
```

If you transfer the project folder instead, do not transfer `node_modules` or `.next`. Run `npm.cmd ci` on the new device. Move your data separately using the import or backup instructions below.

### 3. Add Your API Keys

Edit `.env.local` and replace the placeholder keys:

```env
DEEPGRAM_API_KEY="your-real-deepgram-key"
GEMINI_API_KEY="your-real-gemini-key"
LLM_PROVIDER="gemini"
```

Keep the other settings from [.env.example](.env.example) initially. Make sure the configured models are available to your account. Do not share or commit `.env.local`.

For one answer model, leave `GEMINI_FALLBACK_MODEL` and `LLM_FALLBACK_PROVIDER` empty. Configuring two targets can produce two answer cards and additional API usage.

### 4. Restore Old Data Before First Use

If you have old JSON files, follow **Import Previous JSON Data** below before starting. If you already have a database backup, follow **Move To Another Device** instead. Skip this step for a fresh start.

### 5. Check And Start

```powershell
npm.cmd run verify-setup
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
```

Open **http://127.0.0.1:3000**. The database and tables are created when the app first accesses its data. The setup check contacts your providers and may use API quota.

For everyday use without development mode, build once and start:

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

Stop the server with `Ctrl+C`. Restart after changing `.env.local`.

## Import Previous JSON Data

**Keep a backup of the original files.** Importing creates database records; the automatic file importer does not delete your JSON files.

### Option A: Automatic Import Of Old Files

This is the easiest option for an old application's exports on a new device.

1. Stop the app if it is running.
2. Place your files in the following folders inside the project. Keep these names for knowledge and Q&A files; session filenames can vary.
3. Start the app and open its page. It checks these files when it first opens the database.
4. Open **Knowledge & Q&A > Local Data** and check your sessions and any import warnings.

```text
AI-Assistant/
    data/
        candidate-knowledge.json   <- Resume/project knowledge pack
        qa-bank.json               <- Prepared questions and answers
        qa-history.json            <- Previously generated answers and feedback
    sessions/
        session-1.json             <- One session with transcript and summary
        session-2.json
```

Session files under `data/sessions/` are also supported. Each session file must contain one session object, not just a list of text lines.

Unchanged files are not imported again. Repeated snapshots of the same session merge matching turns. Changed files or conflicting data are reported rather than silently overwritten. Automatic knowledge/Q&A imports use the default **Candidate Knowledge** base and will not replace existing knowledge or prepared Q&A.

If a file fails, correct it and restart. For an already populated knowledge base, use Option B to choose where the data goes. Do not delete your database just to retry an import.

For the detailed import report, open **http://127.0.0.1:3000/api/database** and find `legacyImport.sources`: `COMPLETE` means imported, `SKIPPED` means already imported, and `ERROR` includes the reason.

### Option B: Import Through The App

| Your Data | Where To Import |
|---|---|
| Your resume or personal project document | Select the default **Candidate Knowledge** base, then use **Candidate Knowledge Pack > Add source**. Choose the document type first. PDF, TXT, MD and JSON are supported. |
| Job description for an interview | Paste it in **Session Details > Giving Interview > Job description**. It belongs to that session, not your permanent resume. |
| Candidate profile for an interview you conduct | Paste it in **Session Details > Taking Interview > Candidate profile**. Do not import another candidate's information into your personal knowledge base. |
| Meeting/reference document | Select or create a separate reference knowledge base, then use **Candidate Knowledge Pack > Add source**. Choose that base when starting a Meeting. |
| Existing structured resume/project pack | Select the knowledge base, then use **Candidate Knowledge Pack > Import pack**. This replaces that base's knowledge pack, not its prepared Q&A. |
| Prepared Q&A JSON | Select the knowledge base, then use **Prepared Q&A Guidance > Import JSON**. This merges entries; matching questions may be updated. |
| Session transcripts and generated-answer history | Use Option A. These are different formats from prepared Q&A. |

The on-screen pack and Q&A JSON imports accept files up to **2 MB**. A normal document upload accepts up to **12 MB**. Scanned PDFs without extractable text must be converted to text first.

### Small JSON Examples

Use your existing exports where possible. These examples show the expected shapes; keep real IDs and timestamps when importing your own data.

**Session file**, for example `sessions/session-1.json`:

```json
{
    "id": "session-1",
    "startedAt": "2026-10-06T09:00:00.000Z",
    "endedAt": "2026-10-06T09:30:00.000Z",
    "sessionInfo": { "company": "Example", "callType": "giving_interview", "details": "Technical interview" },
    "transcripts": [
        { "id": "turn-1", "sequenceId": 1, "speaker": "interviewer", "text": "What is SQLite?", "timestamp": "2026-10-06T09:01:00.000Z" },
        { "id": "turn-2", "sequenceId": 2, "speaker": "me", "text": "A local database stored in a file.", "timestamp": "2026-10-06T09:02:00.000Z" }
    ],
    "summary": "Discussed SQLite and local storage."
}
```

Call types are `giving_interview`, `taking_interview` or `meeting`. Speakers are `me` (local) and `interviewer` (remote); in Taking Interview, the remote speaker is the candidate despite this legacy field name. The example is a historical session and does not need the new interview setup fields to be imported or viewed. Old `interview`/`screen` modes and `external` speaker labels are also accepted. Older time-only transcript timestamps are reconstructed from the session date; check them after moving across time zones.

**Prepared Q&A**, for example `data/qa-bank.json`:

```json
{
    "version": 1,
    "updatedAt": "2026-10-06T09:00:00.000Z",
    "entries": [{
        "id": "qa-1",
        "questions": ["What is SQLite?", "Why use a local database?"],
        "answer": "SQLite stores data in one local file without a separate database server.",
        "keyPoints": ["Local file", "No database server"],
        "tags": ["sqlite"],
        "personal": false,
        "priority": 5,
        "enabled": true,
        "createdAt": "2026-10-06T09:00:00.000Z",
        "updatedAt": "2026-10-06T09:00:00.000Z"
    }]
}
```

**Resume/project knowledge pack**, for example `data/candidate-knowledge.json`:

```json
{
    "version": 2,
    "updatedAt": "2026-10-06T09:00:00.000Z",
    "profile": { "headline": "Software Engineer", "summary": "Experience building web applications.", "strengths": ["TypeScript"] },
    "experience": [],
    "projects": [],
    "skills": ["TypeScript", "React"],
    "achievements": [],
    "facts": ["Built an internal reporting application."],
    "sources": []
}
```

**Generated-answer history**, for example `data/qa-history.json`. Notice that this file is an array, not a prepared Q&A bank:

```json
[
    {
        "id": "history-1",
        "createdAt": "2026-10-06T09:01:00.000Z",
        "sessionId": "session-1",
        "question": "What is SQLite?",
        "answer": "SQLite is a database stored in a local file.",
        "tag": "Interview Answer",
        "callType": "giving_interview",
        "feedback": "good"
    }
]
```

Importing history does **not** automatically turn it into prepared Q&A. Use **Generated Answer Review** to mark a completed answer **Good**, then explicitly promote it.

### Data That Only Exists In An Old Browser

Open this updated app in the **same browser, browser profile and address** used previously. Old browser sessions, saved answers and supported preferences are moved to SQLite after the server acknowledges the import.

`localhost`, `127.0.0.1` and different ports have separate browser storage. If the old address was `http://localhost:3000`, use that address for this one-time migration. Afterwards, create a database backup to move the data to your new device. A fresh browser on a new device cannot read the old device's browser data.

Original PDFs cannot be recovered from old JSON that only contains extracted facts. Upload them again if you need the original-file download feature.

## Use The App

1. For Giving Interview, upload or import your resume once into the default **Candidate Knowledge** base under **Knowledge & Q&A**. Keep your prepared personal Q&A there too. Uploading a revised resume there replaces the previous resume document even if the filename changes, without clearing project notes or prepared Q&A.
2. Open **Prompt > Templates** to edit a call-type prompt (**Save Template**; **Reset to Default** restores the built-in text), or use **Style Preferences** for tone and answer format.
3. Click **Connect Audio** and choose the mode. For **Giving Interview**, enter the job title, optional company, job description, seniority and additional context; the saved resume is used automatically. For **Taking Interview**, enter this candidate's profile. **Meeting** still lets you choose reference knowledge bases.
4. Enable **Share audio** in the browser picker. **Taking Interview requires microphone permission** to include your questions alongside the candidate's responses; setup stops if either required stream cannot start. Microphone capture remains optional for other modes.
5. Click **Generate Response** or press `Ctrl+Enter` when the remote participant finishes.
6. Disconnect when finished. The session summary is generated once in the background. View the saved transcript and summary under **Local Data**, where the Summary column shows `pending`, `ready` or `failed`. If it failed (for example the AI provider was unavailable or the app stopped first), hover the status to see why and click **Retry summary**. The saved transcript remains intact either way. A session that gained turns after its summary shows **Update summary**.

### Giving Interview

- Save your resume in the default **Candidate Knowledge** base once. There is no resume selector in interview setup.
- Setup accepts **Job title** (up to 200 characters), **Company (optional)**, **Job description**, **Seniority**, and **Additional context** (up to 1,000 characters). Job title, seniority and additional context may be left blank; only the job description is required.
- Enter the **job description** for the current opportunity: role, responsibilities, required skills and experience. This field is required and accepts up to **12,000 characters**.
- The job description is a **soft relevance signal**, not a constraint. Questions related to it receive strongly tailored answers; unrelated questions are answered normally using relevant knowledge-base evidence and general knowledge, without forcing a connection to the target role. The assistant always answers the actual question asked.
- Answers use your saved resume, prepared personal Q&A, role context and captured conversation. Seniority calibrates answer depth. Job requirements are not treated as experience you already have.
- Your microphone is optional. Enable it before connecting to include your answers in follow-up context.

### Taking Interview

- Enter the **candidate profile** for this interview: the candidate's role, experience, projects and skills. Use information supplied by the candidate. This field is required and accepts up to **12,000 characters**.
- Share the candidate's audio and allow your microphone. Microphone capture is mandatory for this mode even if your normal microphone preference is off.
- Evaluation and follow-ups use the profile, the candidate's latest response, your interviewer questions and recent conversation from both participants. Your own resume and prepared personal Q&A are not used.
- The transcript labels the remote person **Candidate** and your microphone **Me (Interviewer)**. The latest contribution from each speaker is retained within the answer prompt's context budget, including after long candidate responses.
- If a required stream cannot start, setup stops and releases the captured streams. If a required stream ends during the interview, both-speaker capture stops; reconnect before continuing.

### Meeting

Select **1 to 20 knowledge bases** for reference material. The assistant suggests responses and tracks discussion and decisions. Shared audio is required; your microphone is optional. No job description or candidate profile is required.

### Session Context

Job descriptions and candidate profiles are stored with their sessions and included in rolling memory and summaries. They are not global settings and are not added to your personal resume knowledge. New setup starts with empty interview inputs; cancelling or switching modes clears them. Existing sessions without these fields can still be viewed; start a new interview with the required context before generating answers.

Job title, seniority and additional context also belong to the Giving Interview session and are included in its answers and prompt preview. Existing SQLite databases gain the new role fields through an additive migration; their sessions, transcripts and summaries are preserved.

For longer calls, answer generation uses recent turns and rolling memory rather than sending the entire transcript on every request. SQLite retains the full finalized transcript. Session context is included in database backups, so keep backups private.

In **Session Details**, `Ctrl+Enter` submits setup after the required fields are filled and `Esc` cancels. During a call, `Ctrl+Enter` generates a response.

**Diagnostics** shows the selected context, search time, whether the prompt is the default or customized, and response timing. Search uses local keyword matching, not semantic/vector search, so adding alternate question wording can improve matches.

## Back Up And Move To Another Device

If you already use the SQLite version, this is easier than exporting JSON files.

1. On the old device, open **Knowledge & Q&A > Local Data > Create Backup**.
2. Download the backup using the link that appears. It contains the database data, including stored documents, prompts and settings, but **not API keys**.
3. Set up the same application version on the new device and create its `.env.local`.
4. Before starting it, place the downloaded backup in `data/` and rename it to `copilot.db`.
5. Start the app and check **Local Data**. You do not need to import the old JSON files again.

When replacing an existing database, **stop the app and any database viewer first**. Keep a recovery copy of the old database and its `-wal`/`-shm` files together. Move those old sidecar files away before installing the standalone backup; never combine them with the restored database.

Do not copy only `copilot.db` while the app is running. Use **Create Backup**, which safely includes committed data still held in the write-ahead log. Restoration is currently a stopped-app file replacement, not an in-app button.

The database path is shown in **Local Data**. If `COPILOT_DB_PATH` is set, restore to that path instead. Update old device-specific paths in `.env.local`, or leave them unset to use the default. `COPILOT_LEGACY_ROOT` can point to an old project folder containing the JSON files.

Keep the database and backups private, on local disk rather than a network drive or actively synced folder. Ordinary SQLite files are not encrypted. Personal data is git-ignored and is not included in a clone of the project.

## Common Problems

| Problem | What To Do |
|---|---|
| PowerShell blocks `npm.ps1` | Use `npm.cmd`, as in the commands above. No execution-policy change is needed. |
| Packages or SQLite native module will not install | Confirm Node is 22 or newer, then run `npm.cmd ci`. Reinstall packages after changing Node version; do not copy `node_modules` from another device. |
| Deepgram reports insufficient permission | Use a key with Member-or-higher permission, update `.env.local` and restart. |
| Giving Interview shows **No saved resume** | Upload or import your resume into the default **Candidate Knowledge** base. A resume in a different base is not selected automatically. |
| **Start Session** is disabled | Select a mode and fill its required input: job description for Giving Interview, candidate profile for Taking Interview, or knowledge bases for Meeting. Interview text must fit within 12,000 characters. |
| Taking Interview cannot start the microphone | Allow microphone access in the browser and operating system, check the selected input device and retry. This mode cannot continue with remote audio alone. |
| No shared audio or a required stream ended | Enable **Share audio** for the selected tab/window in the browser picker. Reconnect if sharing or the required microphone stream ends. |
| Imported JSON is missing | Check filenames, JSON format and **Local Data** warnings. Restart after placing files; keep the originals. |
| Import says existing data or source changed | Automatic import will not overwrite it. Use the correct base's UI import for knowledge/Q&A; reconcile session/history conflicts without deleting the database. |
| Search results look stale | Use **Local Data > Rebuild Search Index**. |
| A session summary shows `failed` | Click **Retry summary** next to the session in **Local Data**. Hover the status to see the reason, such as a missing API key. |
| The app stops at startup saying a migration checksum does not match | The database was created by an earlier pre-release schema and cannot be upgraded in place. Stop the app, move `data/copilot.db`, `data/copilot.db-wal` and `data/copilot.db-shm` into another folder together, then restart to start fresh. Import old JSON files again if needed, or restore a backup made by this version. |
| Transcript saving reports an error | Use **Retry Save** in the audio panel and check disk space. Do not clear browser storage while saves are pending. |
| Port 3000 is busy | Use `--port 3001` in the start command and open the matching address. Existing SQLite data still loads, but legacy browser storage belongs to its original address. |

## Optional Development Checks

```powershell
npm.cmd run validate
```

This runs TypeScript, database/integration tests, smoke checks and a production build. Tests use temporary databases and mocked AI providers; they do not spend API credits or require these checks during normal use. Interview tests cover required inputs, per-session isolation, both-speaker prompt context and capture startup failures. Real screen/microphone capture and live cloud responses must be checked separately.
