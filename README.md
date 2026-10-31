# QA Drive — Automated Web, Desktop & Performance Test Studio

**QA Drive** (`qa-drive-test-studio`) is an autonomous, prompt-driven End-to-End (E2E) and Load Testing Studio for **Web Applications**, **Windows Desktop Applications (`.exe`)**, **Hybrid Cross-Platform Flows (`Web ↔ Mobile ↔ Desktop`)**, **TestRail Integration**, and **JMeter-Style Performance & Stress Testing**.

---

## ✨ Key Capabilities

1. **Multi-Platform Execution (`1. Mode & Target`)**:
   - **Web Mode**: Runs natural-language test steps in Chromium, Firefox, or WebKit using Playwright + AI Agent.
   - **Desktop Mode (`.exe`)**: Automates native Windows Desktop applications via Windows UI Automation (UIA).
   - **Hybrid Flow (`Web + Desktop + Mobile`)**: Check *"Include Desktop Application (`.exe`) for Hybrid Web + Desktop flow"* under Web mode to switch seamlessly between `[WEB]`, `[MOBILE]`, and `[DESKTOP]` steps in a single test run with automatic **Generic Record Correlation** (captures created IDs, form values, and table row diffs across platforms).
   - **TestRail Mode**: Fetches test cases directly by Case ID (`C101`, etc.) and automatically syncs Pass/Fail status, execution logs, and the Word (`.docx`) report back to TestRail.
   - **Load Test Mode (JMeter Engine)**: Simulates concurrent Virtual Users (`10` to `500` VUs) with configurable Ramp-Up, Duration, Think Time, and `p95` Latency SLA verification.
2. **Zero-LLM Replay Cache (`$0` Repeat Runs)**:
   - Records resilient DOM selectors on the first run (`.e2e/action-cache.json`) and replays identical steps on subsequent runs with **0 LLM calls (`$0` cost)**, supporting multi-variant selectors across different user roles.
3. **Generic Website Auto-Scanner (`Scan Site`)**:
   - Crawls internal routes, links, buttons, and forms into `.e2e/site-map/` and incrementally learns role-specific DOM elements during live test runs.
4. **Standard AI & Organization AWS Mode**:
   - Supports **Standard AI Providers** (`OpenAI`, `Anthropic`, `Google Gemini`, `Ollama`) and **Organization Internal AWS Models** (AWS API Gateway OpenAI/Anthropic-compatible endpoints and direct AWS Bedrock Runtime with Bearer Token or IAM SigV4).
5. **Automated Evidence & Word (`.docx`) Reporting**:
   - Generates a standalone Microsoft Word (`.docx`) observation report (`reports/e2e-observation-report-latest.docx`) with visually highlighted verification screenshots, step-by-step observations, and optional `.webm` video recordings, plus exports a standalone zero-AI Playwright spec (`tests/exported/playwright-zero-llm.spec.ts`).

---

## 🚀 Running QA Drive on Another Machine

### 1. Prerequisites
Ensure the target machine has:
- **Windows 10 / 11** (required for Windows UIA Desktop `.exe` automation and `QADrive.exe` build)
- **Node.js v20+** (v20 or v22/v24 LTS recommended) — [Download Node.js](https://nodejs.org/)
- **Git** — [Download Git](https://git-scm.com/)

---

### 2. Clone & Install Dependencies

Open **PowerShell** or **Command Prompt** on the new machine and run:

```powershell
# 1. Clone the repository
git clone <YOUR_GITHUB_REPO_URL> qa-drive
cd qa-drive

# 2. Install Node.js packages
npm install

# 3. Install Playwright browser binaries (Chromium / Firefox / WebKit)
npx playwright install chromium
```

---

### 3. Configure Environment Variables (Optional)

You can configure your AI API keys, Organization AWS credentials, and TestRail settings directly inside the **QA Drive UI (`Settings` button in the top bar)**, or by copying `.env.example` to `.env`:

```powershell
copy .env.example .env
```

Edit `.env` if you want default environment keys:
```env
OPENAI_API_KEY=sk-...
# Or configure Anthropic / Gemini / Ollama / Org AWS directly in the UI Settings modal
```

---

### 4. Start QA Drive (Development / Studio Mode)

Run the following command to start both the Backend Server (`http://127.0.0.1:4002`) and the UI (`http://127.0.0.1:4001`), which automatically opens the QA Drive desktop window:

```powershell
npm run dev
```

- **Web UI URL**: `http://127.0.0.1:4001`
- **Backend API URL**: `http://127.0.0.1:4002`

---

### 5. Build & Run the Protected Standalone `QADrive.exe` (Anti-Reverse-Engineering Build)

To compile the hardened, single-file Windows executable (`release/QADrive.exe`) with V8 bytecode compilation, AES-256-CBC payload encryption, HMAC-SHA256 integrity verification, and Win32 anti-debugger guards:

```powershell
npm run build:exe
```

Then launch the executable directly:

```powershell
.\release\QADrive.exe
```

---

## 📁 Project Structure

```text
├── e2e.config.ts                 # Playwright & AI Agent runner configuration + DOM/API recorders
├── scripts/
│   └── build-protected-exe.mjs   # Compiler for hardened, AES-256 encrypted release/QADrive.exe
├── server/
│   ├── index.ts                  # Core HTTP/SSE server, E2E code generator & Hybrid coordinator
│   ├── desktop-runner.ts         # Windows UIA (.exe) engine, Desktop Auth & Record Correlation
│   ├── load-runner.ts            # JMeter-style concurrent Virtual User load & stress engine
│   ├── site-scanner.ts           # Generic website crawler & incremental DOM site-map builder
│   ├── cache-and-session.ts      # Zero-LLM replay cache, session persistence & Playwright exporter
│   ├── org-aws-llm.ts            # Organization Internal AWS Gateway & Bedrock SigV4 adapter
│   ├── docx-report.ts            # Standalone Microsoft Word (.docx) report generator
│   └── testrail.ts               # TestRail API client (Case fetch & Result/Attachment sync)
├── src/
│   ├── App.tsx                   # QA Drive Studio React UI
│   ├── types.ts                  # Shared TypeScript interfaces
│   └── styles.css                # Clean Light/Dark theme styling
└── tests/                        # Sample & fixture E2E specs
```

---

## 🛠️ Useful NPM Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts QA Drive Studio UI (`:4001`) + Backend (`:4002`) and opens the app window |
| `npm run build` | Builds the production frontend bundle into `dist/` |
| `npm run build:exe` | Compiles the protected Windows executable at `release/QADrive.exe` |
| `npm run typecheck` | Runs TypeScript type verification (`tsc --noEmit`) |
