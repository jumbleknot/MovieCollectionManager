# MovieCollectionManager

Browse and manage your movie collection from a web browser or mobile app

## Purpose

- Manage information about your movie collection
- Add movies to your collection and specify details about the movie such as media formats, movie metadata, personal rating, and links to movie databases such as IMDB and TMDB for additional information
- View and search your collection
- Maintain a wishlist of movies you would like to upgrade or add to your collection

## Future Roadmap

- Web search for where to buy movies on wish list
- Update NFO files
- Scrape media format metadata from digital movie files (via ffprobe or ffmpeg)
- Scrape movie metadata from TMDB to create NFO files

## Built With

GitHub Spec Kit, GitHub Copilot, Visual Studio Code, Rust, Axum, React Native, Expo, Nx

## Getting Started

Instructions on setting up and running your project.

### Prerequisites

List any prerequisites, libraries, or operating system requirements needed for installation.

- git
- Visual Studio Code
- Claude Code for VS Code extension (preferred) or GitHub Copilot Chat VSCode extension
- UV
- Specify CLI
- Docker Desktop
- Rust
- React Native & Expo:
  - Node.js 24
  - Open JDK 17
  - Android Studio
  - pnpm
  - EAS CLI
- Nx
- Keycloak

### Installation

Step-by-step instructions on how to get your project running locally on your development machine.

1. Install [git](https://git-scm.com/install/)
2. Install GitHub.cli

      ```bash
      winget install --id GitHub.cli --source winget
      gh auth login
      ```

3. Install [Visual Studio Code](https://code.visualstudio.com/download)
4. Install the [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) and/or [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extension(s) in VSCode
5. Install [UV](https://docs.astral.sh/uv/getting-started/installation/) package manager for Python
6. Install Specify CLI by running `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git` from a new terminal session - [additional details can be found here](https://github.com/github/spec-kit/blob/main/README.md#1-install-specify-cli)
7. Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/)
8. Install Rust components
   1. Install [Rust](https://rust-lang.org/tools/install/)
   2. Install Visual Studio Build Tools
      1. Download Build Tools for Visual Studio from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
      2. Run the installer and select "Desktop development with C++" workload
      3. Complete the install (~5–8 GB), then restart your terminal
   3. Install the Rust Language Server and essential Cargo extensions by running the following from the command prompt

         ```bash
         rustup default stable
         rustup component add rust-analyzer
         cargo install cargo-audit cargo-deny cargo-outdated cargo-machete cargo-semver-checks cargo-geiger cargo-expand cargo-bloat cargo-mutants
         ```

   4. Install the Rust Analyzer and Rust Skills Claude Plugins by running the following from within a Claude Code session

         ```bash
         /plugin install rust-analyzer-lsp@claude-plugins-official
         /plugin marketplace add actionbook/rust-skills
         /plugin install rust-skills@rust-skills
         /reload-plugins
         ```

   5. Install the [rust-analyzer](https://code.visualstudio.com/docs/languages/rust) extension in VSCode
9. Install dependencies for React Native and Expo
   1. Follow [instructions for setting up your environment for React Native](https://reactnative.dev/docs/set-up-your-environment)
      1. This project is using Node.js 24.14.1
      2. This project is using Open JDK 17
      3. This project is using Android Studio with Android SDK Platform 35, SDK Build Tools, and Android Emulator
   2. Install pnpm using Corepack included with Node.js
      1. Enable Corepack by running `corepack enable` from your terminal.
      2. Install pnpm by running `corepack prepare pnpm@latest --activate` from your terminal.
      3. Validate pmpm was correctly installed by running `pnpm --version` from a new terminal session.  It should return a version number.
      4. Run `pnpm setup` from your terminal to set the global bin directory.
   3. Setup Expo Application Services (EAS)
      1. Install EAS CLI by running `pnpm add -g eas-cli` from a new terminal session.
      2. Follow [instructions to create an Expo account and login](https://docs.expo.dev/get-started/set-up-your-environment/?mode=development-build#create-an-expo-account-and-login)
   4. Install react-native-best-practices agent skills
      1. General: `pnpm dlx add-skill callstackincubator/agent-skills`
      2. Claude Code:

         ```bash
         /plugin marketplace add callstackincubator/agent-skills
         /plugin install react-native-best-practices@callstack-agent-skills
         /plugin install upgrading-react-native@callstack-agent-skills
         /reload-plugins
         ```

   5. Install expo agent skills (for Claude Code) by running `/plugin install expo/skills` followed by `/reload-plugins` from within a Claude Code session
10. Other Claude Code Plugins to help with Dev
    1. Frontend Design
    2. Superpowers
    3. Context7
    4. Code Review
    5. Security Guidance
11. Clone the repo

      ```bash
      git clone https://github.com/jumbleknot/MovieCollectionManager.git
      ```

12. Setup Nx
    1. Install [Nx](https://nx.dev/docs/getting-started/installation)
    2. Open a new terminal and navigate to the root directory of this repository
    3. Run `pnpm nx add @nx/expo` to install the Expo plugin for Nx
    4. Run `pnpm nx add @monodon/rust` to install the Rust plugin for Nx
    5. Run `pnpm nx add @nx/playwright` to install the Playwright plugin for Nx
    6. Run `pnpm dlx skills add nrwl/nx-ai-agents-config` to configure this Nx monorepo to work with AI assistants
    7. Install the [Nx Console](https://marketplace.visualstudio.com/items?itemName=nrwl.angular-console) extension in VSCode
13. Create Shared Networks to be used by Docker Compose

      ```bash
      docker network create backend-network
      docker network create frontend-network
      ```

14. Deploy local instance of Keycloak by following instructions in [Keycloak README](infrastructure-as-code/docker/keycloak/README.md)
15. Run TBD script to create necessary realm, client, roles, and users in Keycloak

## Usage

Provide examples of how to use your project, ideally with code snippets or screenshots.

## Contributing

TBD

## License

[View the project license](LICENSE.md)

## Acknowledgement and Credits

TBD
