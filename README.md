# Ohara

**English** | [Português](README.pt-BR.md)

Ohara is a Windows desktop assistant (Electron) that puts the Claude Code and Codex subscriptions you already pay for behind a single chat window for the whole PC. Both CLIs are strong on their own, but choosing the right model for each request and watching two separate usage quotas is tedious manual work. Ohara classifies every request locally, sends it to the provider, model and reasoning effort that fit the job, falls back to the other provider when a quota is running low, and carries the conversation context across when it switches. Around that core it turns meeting transcripts into a task board, runs instant local actions without spending tokens, and adds a few global hotkeys for working in any app.

## Technical highlights

- **Zero-token request router.** A keyword heuristic over normalized text sorts each prompt into one of nine categories (quick question, Windows command, code, complex code, web research, writing, planning, vision...) and maps it to a provider, model tier and effort level. Short follow-ups such as "go ahead" inherit the category of the conversation. → [`src/core/router.js`](src/core/router.js), [`test/router.test.js`](test/router.test.js)
- **Quota-aware fallback.** Claude usage (5-hour and 7-day windows) comes from the CLI's own reports; Codex usage is read from the `rate_limits` entries in `~/.codex/sessions`. Above 70% Claude usage, Opus is downgraded to Sonnet; above 90%, requests move to Codex, and code goes back to Claude when Codex passes 90%. All thresholds are configurable. → [`src/core/usage.js`](src/core/usage.js), [`src/core/config.js`](src/core/config.js)
- **Router that learns.** When you manually pick the same model for a category in 3 of your last 5 overrides, that choice becomes the new default for the category. → `learnPreferences` in [`src/core/router.js`](src/core/router.js)
- **Context handoff between providers.** Each conversation tracks how far every CLI session has read (`syncedUpTo`), so when Ohara switches from Claude to Codex (or back) it injects only the messages that provider has not seen. Expired sessions are retried from scratch with the transferred history, and a second request sent while an agent is working runs in parallel in its own session. → [`src/core/orchestrator.js`](src/core/orchestrator.js), [`test/orchestrator.test.js`](test/orchestrator.test.js)
- **CLI providers over streaming JSON.** Claude runs as `claude --output-format stream-json` with `--resume` for session continuity; Codex runs as `codex exec --json` inside a `workspace-write` sandbox. Tool calls are surfaced in the UI as they happen. → [`src/core/providers/claude.js`](src/core/providers/claude.js), [`src/core/providers/codex.js`](src/core/providers/codex.js), [`test/claude-args.test.js`](test/claude-args.test.js)
- **Structured output for background jobs.** One-shot calls pass a strict JSON Schema to either CLI (`--json-schema` / `--output-schema`). Background features run under their own budget: they use Claude up to 70%, then Codex up to 85%, and otherwise defer until the quota window resets, so the chat always has headroom. → [`src/core/ai.js`](src/core/ai.js)
- **Meeting pipeline.** Watches a folder for transcripts saved by a meeting bot, waits for the file to settle, merges reconnection parts, strips repeated speech-recognition lines, skips trivial calls, and extracts summary, decisions and action items into a Kanban board with deadlines, owners and "waiting on others" follow-ups. → [`src/core/meetings.js`](src/core/meetings.js), [`src/core/transcript.js`](src/core/transcript.js), [`test/meetings.test.js`](test/meetings.test.js)
- **Instant local actions.** Simple requests like "open Spotify" or "search Google for X" are resolved on the spot (apps are looked up in the Start menu) without calling any model. → [`src/core/quick-actions.js`](src/core/quick-actions.js)
- **Fix text anywhere.** `Ctrl+Shift+F8` copies the current selection in any app, corrects spelling, accents and punctuation with AI while keeping the writer's style (informal abbreviations such as "vc" → "você" are expanded, acronyms and technical terms are kept), and pastes it back, restoring the original clipboard afterwards. If you switch windows while it works, the fixed text stays on the clipboard. Electron and Windows are injected, so the logic is unit-tested. → [`src/core/text-fix.js`](src/core/text-fix.js), [`test/text-fix.test.js`](test/text-fix.test.js)
- **Local tools on Ollama.** A 🧰 Tools tab runs entirely on a local model, so nothing leaves the PC and no quota is spent: semantic search over chosen folders (PDF, .docx, text) with the source file of each passage, data extraction from contracts and petitions, triage of e-mails and court notices, reading ID documents from a photo, anonymization of what goes to Claude/Codex in background jobs, commit and PR messages from a diff, and a first look at error logs. Long meeting transcripts are condensed locally before reaching Claude. → [`src/core/local-tools.js`](src/core/local-tools.js), [`src/core/doc-index.js`](src/core/doc-index.js), [`src/core/local-llm.js`](src/core/local-llm.js)
- **Interview mode.** For English interviews over Teams or any call app (`Ctrl+Alt+E`): loopback audio and the microphone are transcribed by local Whisper, and when the interviewer pauses, Claude Haiku returns a glanceable card (the question translated in one line, one short English sentence ready to say, and 2-3 keywords), grounded only in a `contexto.md` with the résumé and job description. Repeated questions bring the earlier card back instead of a new one. → [`src/core/interview.js`](src/core/interview.js), [`src/integrations/whisper.js`](src/integrations/whisper.js)
- **Safety defaults.** Claude runs in `--permission-mode auto` and Codex in `workspace-write`; full access is an explicit toggle. The Slack token and calendar URL are encrypted with Electron `safeStorage` (Windows DPAPI) and never reach the renderer. → [`src/main.js`](src/main.js)

Integrations: Google Calendar via secret iCal URL ([`calendar.js`](src/integrations/calendar.js)), GitHub PRs through the logged-in `gh` CLI ([`github.js`](src/integrations/github.js)), Slack DMs and mentions ([`slack.js`](src/integrations/slack.js)), and spoken replies with Edge neural voices plus an offline Windows fallback ([`tts.js`](src/integrations/tts.js)).

## Architecture

```mermaid
flowchart LR
    UI["Renderer<br/>(plain HTML/CSS/JS)"] -- "IPC via preload.js" --> Main["main.js<br/>window, tray, hotkeys"]
    Main --> Orch["orchestrator.js<br/>chats, sessions, handoff"]
    Orch --> Router["router.js<br/>local classification"]
    Router --> Usage["usage.js<br/>Claude + Codex quotas"]
    Orch --> Claude["providers/claude.js<br/>claude CLI (stream-json)"]
    Orch --> Codex["providers/codex.js<br/>codex exec --json"]
    Main --> Meetings["meetings.js<br/>transcripts → task board"]
    Meetings --> AI["ai.js<br/>one-shot calls + JSON Schema"]
    AI --> Claude
    AI --> Codex
    Main --> Integrations["integrations/<br/>calendar, GitHub, Slack, TTS"]
```

```
src/
  main.js            Electron main process: window, tray, global hotkeys, screen capture, IPC
  preload.js         safe bridge between renderer and main
  core/              router, orchestrator, usage, providers, meetings, automations, insights
  integrations/      calendar, GitHub, Slack, TTS and other external services
  renderer/          UI (plain HTML/CSS/JS, no framework)
test/                node:test suites
```

## Running and testing

Requirements: Windows 10/11, Node.js, and the `claude` and `codex` CLIs installed and logged in (`claude`, `codex login`).

```powershell
npm install
npm start        # launch the app (it lives in the system tray)
npm run dev      # same, with DevTools
npm test         # node --test test/*.test.js
npm run dist     # build the NSIS installer and portable .exe into dist\
npm run start:guia   # run Ohara Guia (the edition for non-developers) from source
npm run dist:guia    # build Ohara Guia into dist-guia\
```

The test suite uses Node's built-in test runner (no extra framework): 317 tests across 37 files covering the router, orchestrator, providers, local tools, meetings, transcript cleanup, text fix, Ohara Guia, storage and configuration.

## Ohara Guia

A separate edition in the same repository, meant to be handed to someone who is not a developer. It shares the core (providers, router, quota tracking) but drops the personal integrations (meetings, WhatsApp, Slack, Orca, interview, voice) and any paths tied to this PC; it has its own name, data folder (`%APPDATA%\Ohara Guia`) and release channel ([`Gabs-X/ohara-guia`](https://github.com/Gabs-X/ohara-guia)), so it installs side by side with Ohara.

- **Several AIs, one picker.** Claude, Codex, Gemini (free tier via Gemini CLI) and a local model, each described in a registry. A multi-provider router scores every ready AI by cost, quality and quota already used (economy, balanced or quality mode) and hands the conversation over with its context when one fails on quota or login. → [`src/core/multi-router.js`](src/core/multi-router.js), [`src/core/providers/registry.js`](src/core/providers/registry.js)
- **Planner.** An idea becomes a plan (goal, steps, risks, open questions) written by a strong model; each step then runs on the cheapest model that handles that kind of step. → [`src/guia/planner.js`](src/guia/planner.js)
- **Safety net.** Before and after every request in a project, a snapshot of the folder is stored in a separate Git repository, so "Undo" restores only the files the AI touched. → [`src/core/checkpoints.js`](src/core/checkpoints.js)
- **Plain-language explanations and first-run checks.** Every task ends with "What I did" and "How to check", and a health screen checks internet, Node, Git and each AI, with buttons that open the right install or login command. → [`src/guia/main.js`](src/guia/main.js)

Prebuilt installers are available on the [Releases](https://github.com/Gabs-X/ohara/releases/latest) page. The executables are not code-signed, so SmartScreen may warn on first launch.

Ohara is a personal tool, so some defaults point to the author's folders (workspace root, meeting transcripts, its own repository). Any key in [`src/core/config.js`](src/core/config.js) can be overridden in `%APPDATA%\Ohara\config.json`.

## Status

Actively developed and used daily by the author. Since v0.6.10 the app ships as a slimmer, stability-focused build: WhatsApp messaging and voice input (local Whisper dictation and the wake word) are disabled in [`simplifyConfig`](src/core/config.js), while spoken replies keep working. The code for those features is still in `src/integrations/`.

The name comes from Ohara, the island of scholars and its great library in *One Piece*. The app was called "Central IA" up to v0.3.
