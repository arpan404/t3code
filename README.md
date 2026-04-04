# T3 Code

T3 Code is a minimal web GUI for coding agents: Codex, Claude, GitHub Copilot, and Cursor.

> **Note:** This project is a derivative of the original T3 Code to add the features I believe will make my coding workflow better and efficient.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, GitHub Copilot, and Cursor.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`
> - GitHub Copilot: install the [GitHub Copilot CLI](https://docs.github.com/copilot) and sign in (Copilot access required)
> - Cursor: install [Cursor](https://cursor.com) and ensure the Cursor Agent CLI (`cursor-agent`) is installed and you are signed in

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
