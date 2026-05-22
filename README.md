<p align="center">
  <img src="static/img/logo.png" alt="NEUROLLAMA Logo" width="220" height="220" style="border-radius: 28px; box-shadow: 0 8px 30px rgba(0,0,0,0.35);" />
</p>

<h1 align="center">NEUROLLAMA</h1>

<p align="center">
  <strong>A premium, cybertech-inspired web control center for managing local & remote Ollama nodes.</strong>
</p>

<p align="center">
  <a href="https://golang.org/"><img src="https://img.shields.io/badge/Go-1.21%2B-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go Version" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS-3.4%2B-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://daisyui.com/"><img src="https://img.shields.io/badge/daisyUI-4.7%2B-5A0EF8?style=for-the-badge&logo=daisyui&logoColor=white" alt="DaisyUI" /></a>
  <a href="https://github.com/notfixingit/ollama-manager/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-a3be8c?style=for-the-badge" alt="MIT License" /></a>
  <a href="https://buymeacoffee.com/notfixingit"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-notfixingit-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" /></a>
</p>

---

## 🌌 Overview

**NEUROLLAMA** is a lightweight, self-hosted web control panel that provides a beautiful, techy interface to connect, monitor, and query your Ollama instances. Styled using the **Nord Palette** and built with **Go (Gin)** and **Tailwind CSS/daisyUI**, it is designed to look like a futuristic command console from 2026.

With NEUROLLAMA, you can connect to multiple local or remote servers, monitor active VRAM usage, inspect model parameters/configs, build new models using custom Modelfiles, and chat with models inside a premium Terminal Emulator Playground.

---

## 📸 Screenshots

<p align="center">
  <img src="static/img/screenshot.png" alt="NEUROLLAMA Dashboard Interface" width="100%" style="border-radius: 12px; border: 1px solid #4c566a; box-shadow: 0 10px 25px rgba(0,0,0,0.3);" />
</p>

---

## ⚡ Key Features

- **🌐 Multi-Node Registry**: Register, edit, and swap between multiple local or remote Ollama server nodes. Real-time background telemetry shows active server latency, online status, and version.
- **📦 Inventory & Telemetry**:
  - View all installed models with parameters, size, and serialization details.
  - Inspect full Modelfiles, templates, parameter parameters, and system prompts.
  - Pull models directly from the official **Ollama Library** or Hugging Face (**HF GGUFs**) with real-time download speed and progress bars.
  - Batch select and delete multiple models.
- **💬 TTY0 Chat Playground**:
  - Custom terminal-style playground to interact with your models.
  - Save, load, and edit custom **System Prompt Presets** persisted to SQLite.
  - Real-time parameter controls: adjust Temperature, Context Limit, Top K, Top P, Seed, and Repeat Penalty.
  - **🧠 Render Thinking Toggle**: Instantly hide/show reasoning tracks (`<think>` blocks) from DeepSeek R1 and other reasoning models.
- **🛠️ Model Builder**:
  - Create new customized models using a simple graphical interface.
  - Automatically compiles a Modelfile from your base model, system prompt, temperature, and custom parameters.
  - Real-time build progress logs stream directly to the UI.
- **📼 Memory Telemetry**:
  - Direct VRAM inspection to view which models are currently active in memory, their sizes, and which processor (GPU vs CPU) they are running on.
- **📐 Fluid Collapsible Layout**:
  - Instantly toggle Node Registry, Chat History, and Config sidebars to optimize screen width for small screens or large terminals. Layout settings persist in local browser storage.

---

## 🛠️ Tech Stack

* **Backend**: Go 1.21+ (powered by [Gin Web Framework](https://github.com/gin-gonic/gin))
* **Database**: SQLite3 (via `modernc.org/sqlite` for CGO-free compilations)
* **Frontend**: Vanilla HTML5/JS (ES6), Tailwind CSS, daisyUI (Nord theme), FontAwesome icons
* **Client**: Fetch API, EventSource/Server-Sent Events (SSE) for model download and build streaming

---

## 🚀 Quick Start

### Prerequisites

* [Go](https://go.dev/doc/install) 1.21 or higher.
* [Node.js & npm](https://nodejs.org/en/download/) (only for rebuilding Tailwind CSS styles).
* A running [Ollama](https://ollama.com/) instance (ensure the server has origin permissions enabled if running remotely; typically start Ollama with `OLLAMA_ORIGINS="*" ollama serve`).

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/notfixingit/ollama-manager.git
   cd ollama-manager
   ```

2. **Compile Tailwind CSS**:
   ```bash
   cd tailwind
   npm install
   npm run build
   cd ..
   ```

3. **Compile the Go binary**:
   ```bash
   go build -o neurollama .
   ```

4. **Run the server**:
   ```bash
   ./neurollama
   ```
   The application will start on: **`http://localhost:8080`**

---

## ⚙️ Configuration & Data Storage

- **SQLite Database**: App configurations, servers registry, and prompt presets are stored in `data/db.sqlite` (created automatically on first launch).
- **Environment Variables**:
  - `PORT`: Set a custom port for the server (defaults to `8080`).
    ```bash
    PORT=9000 ./neurollama
    ```

---

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
