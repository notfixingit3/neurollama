<p align="center">
  <img src="static/img/logo.png" alt="NEUROLLAMA Logo" width="220" height="220" style="border-radius: 28px; box-shadow: 0 8px 30px rgba(0,0,0,0.35);" />
</p>

<p align="center">
  <strong>A cybertech-inspired web control center for managing local & remote Ollama nodes.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v0.2.0-bf616a?style=for-the-badge&logo=git&logoColor=white" alt="Version v0.2.0" />
  <a href="https://golang.org/"><img src="https://img.shields.io/badge/Go-1.26.3-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go Version" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS-4.3%2B-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://daisyui.com/"><img src="https://img.shields.io/badge/daisyUI-5.5%2B-5A0EF8?style=for-the-badge&logo=daisyui&logoColor=white" alt="DaisyUI" /></a>
  <a href="https://github.com/notfixingit3/neurollama/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-a3be8c?style=for-the-badge" alt="MIT License" /></a>
  <a href="https://buymeacoffee.com/notfixingit"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-notfixingit-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" /></a>
</p>

> [!WARNING]
> **Pre-release software.** NEUROLLAMA is under active development and has not reached a stable release. Features may be incomplete, broken, or change without notice. Running this software may trigger cascading failures in your local Ollama setup, spontaneous model downloads, existential dread, or other unforeseeable consequences. We are not responsible for lost models, corrupted databases, rogue AI agents, or the heat death of your GPU. Use at your own risk. You have been warned.

---

## 🌌 Overview

**NEUROLLAMA** is a lightweight, self-hosted web control panel that provides a beautiful, techy interface to connect, monitor, and query your Ollama instances. Styled using the **Nord Palette** and built with **Go (Gin)** and **Tailwind CSS/daisyUI**, it is designed to look like a futuristic command console.

With NEUROLLAMA, you can connect to multiple local or remote servers, inspect which models are currently loaded in memory, inspect model parameters/configs, build new models using custom Modelfiles, run diagnostics, and chat with models inside a premium Terminal Emulator Playground.

---

## 📸 Screenshots

<p align="center">
  <img src="static/img/screenshot.png" alt="NEUROLLAMA Dashboard Interface" width="100%" style="border-radius: 12px; border: 1px solid #4c566a; box-shadow: 0 10px 25px rgba(0,0,0,0.3);" />
</p>

---

## ⚡ Key Features

- **🌐 Multi-Node Registry**: Register, edit, test, and swap between multiple local or remote Ollama server nodes. Credential values are redacted from API responses, and real-time background telemetry shows active server latency, online status, and version.
- **📦 Inventory & Telemetry**:
  - View all installed models with parameters, size, and serialization details.
  - Inspect full Modelfiles, templates, parameters, system prompts, and sanitized external model cards with raw/source view controls.
  - Pull models directly from the official **Ollama Library** or Hugging Face (**HF GGUFs**) with real-time download speed and progress bars.
  - Batch select and delete multiple models.
- **💬 TTY0 Chat Playground**:
  - Custom terminal-style playground to interact with your models.
  - Save, load, and edit custom **System Prompt Presets** persisted to SQLite.
  - Real-time parameter controls: adjust Temperature, Context Limit, Top K, Top P, Seed, Repeat Penalty, hardware allocation, and generation limits.
  - Stop in-flight generations and restore the last failed prompt for quick retry.
  - **🧠 Render Thinking Toggle**: Instantly hide/show reasoning tracks (`<think>` blocks) from DeepSeek R1 and other reasoning models.
- **🛠️ Model Builder**:
  - Create new customized models using a simple graphical interface.
  - Automatically compiles a Modelfile from your base model, system prompt, temperature, and custom parameters.
  - Real-time build progress logs stream directly to the UI, with cancellation support.
- **📼 Memory Telemetry**:
  - View which models Ollama currently has loaded, their sizes, and whether they are mapped to GPU VRAM or system RAM — sourced from Ollama's `/api/ps` endpoint.
  - ⚠️ **Remote node limitation**: Ollama's API does not expose total VRAM capacity or GPU utilization. For remote servers, loaded model sizes are shown accurately but VRAM percentage bars are not meaningful. The "App Host" CPU/RAM panel always reflects the machine running NEUROLLAMA, not the remote Ollama host.
- **🩺 Preflight Diagnostics**:
  - Validate SQLite, data directory writability, static assets, active Ollama reachability, model inventory access, settings, and streaming route readiness.
- **📈 Benchmarks & Optimizer**:
  - Run cancellable benchmark and hyperparameter optimizer streams with browser-local failure diagnostics.
- **📐 Fluid Collapsible Layout**:
  - Instantly toggle Node Registry, Chat History, and Config sidebars to optimize screen width for small screens or large terminals. Layout settings persist in local browser storage.

---

## 🛠️ Tech Stack

* **Backend**: Go 1.26.3 (powered by [Gin Web Framework](https://github.com/gin-gonic/gin))
* **Database**: SQLite3 (via `modernc.org/sqlite` for CGO-free compilations)
* **Frontend**: Vanilla HTML5/JS (ES6), Tailwind CSS, daisyUI (Nord theme), FontAwesome icons
* **Client**: Fetch API, EventSource/Server-Sent Events (SSE) for model download and build streaming

---

## 🚀 Quick Start

### Prerequisites

* [Go](https://go.dev/doc/install) 1.26.3.
* A running [Ollama](https://ollama.com/) instance (ensure the server has origin permissions enabled if running remotely; typically start Ollama with `OLLAMA_ORIGINS="*" ollama serve`).
* **Node.js is not required.** CSS is pre-compiled and committed. See [Rebuilding CSS](#rebuilding-css) only if you modify styles.

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/notfixingit3/neurollama.git
   cd neurollama
   ```

2. **Compile the Go binary**:
   ```bash
   go build -o neurollama .
   ```

3. **Run the server**:
   ```bash
   ./neurollama
   ```
   The application will start on: **`http://localhost:8080`**

---

## 🎨 Rebuilding CSS

The compiled `static/css/output.css` is committed to the repo — you only need this if you modify `tailwind/input.css` or templates.

CSS is built using the [Tailwind CSS v4 standalone CLI](https://tailwindcss.com/blog/standalone-cli) — **no Node.js or npm required**.

**One-time binary download (macOS arm64):**
```bash
curl -sL https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.0/tailwindcss-macos-arm64 -o tailwindcss && chmod +x tailwindcss
```

For other platforms replace `macos-arm64` with `macos-x64`, `linux-x64`, `linux-arm64`, or `windows-x64.exe`.

**Build:**
```bash
./tailwindcss -i tailwind/input.css -o static/css/output.css --minify
```

**Watch mode (auto-rebuild on save):**
```bash
./tailwindcss -i tailwind/input.css -o static/css/output.css --watch
```

---

## ⚙️ Configuration & Data Storage

- **SQLite Database**: App configurations, servers registry, chat history, RAG index metadata, diagnostics settings, and prompt presets are stored in `data/neurollama.db` (created automatically on first launch).
- **Legacy Database Migration**: If `data/ollama-manager.db` exists and `data/neurollama.db` does not, NEUROLLAMA renames the old database file on startup.
- **Server Credentials**: Bearer tokens, Basic Auth passwords, and custom header values are stored locally for node access but are redacted from normal server-list API responses.
- **Environment Variables**:
  - `PORT`: Set a custom port for the server (defaults to `8080`).
    ```bash
    PORT=9000 ./neurollama
    ```

---

## 🤝 Contributing

All commit messages must end with a random Scooby-Doo quote. This is non-negotiable.

```
feat: add VRAM telemetry panel

"Zoinks!"
```

## 🤝 Support & Contributions

If you find this manager helpful, feel free to submit pull requests, open issues, or buy me a coffee!

<p align="left">
  <a href="https://buymeacoffee.com/notfixingit" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="180" style="border-radius: 8px;" />
  </a>
</p>

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) - see the LICENSE file for details.
