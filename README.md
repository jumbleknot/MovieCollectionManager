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

GitHub Spec Kit, GitHub Copilot, Visual Studio Code, Rust, Axum, Tokio

## Getting Started

Instructions on setting up and running your project.

### Prerequisites

List any prerequisites, libraries, or operating system requirements needed for installation.

- git
- Visual Studio Code
- GitHub Copilot Chat VSCode extension
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

Step-by-step instructions on how to get your project running locally.

1. Install [git](https://git-scm.com/install/) on your development machine
2. Install [Visual Studio Code](https://code.visualstudio.com/download) on your development machine
3. Install the [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extension in VSCode
4. Install [UV](https://docs.astral.sh/uv/getting-started/installation/) package manager for Python
5. Install Specify CLI by running `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git` from a new terminal session - [additional details can be found here](https://github.com/github/spec-kit/blob/main/README.md#1-install-specify-cli)
6. Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/) on your development machine
7. Install [Rust](https://rust-lang.org/tools/install/) on your machine and install the [rust-analyzer](https://code.visualstudio.com/docs/languages/rust) extension in VSCode
8. Install dependencies for React Native and Expo
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
9. Clone the repo

      ```bash
      git clone https://github.com/jumbleknot/MovieCollectionManager.git
      ```

10. Setup Nx
    1. Install [Nx](https://nx.dev/docs/getting-started/installation) on your development machine
    2. From a new terminal window change to project directory
    3. Run `nx add @nx/expo` to install the Expo plugin for Nx
    4. Run `nx add @monodon/rust` to install the Rust plugin for Nx
    5. Install the [Nx Console](https://marketplace.visualstudio.com/items?itemName=nrwl.angular-console) extension in VSCode
11. Create Shared Networks to be used by Docker Compose

      ```bash
      docker network create backend-network
      docker network create frontend-network
      ```

12. Deploy local instance of Keycloak by following instructions in [Keycloak README](infrastructure-as-code/docker/keycloak/README.md)

## Usage

Provide examples of how to use your project, ideally with code snippets or screenshots.

## Contributing

TBD

## License

[View the project license](LICENSE.md)

## Acknowledgement and Credits

TBD
