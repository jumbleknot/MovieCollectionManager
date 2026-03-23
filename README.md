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

List any prerequisites, libraries, or operating system requirements needed before installation.

- Docker
- Rust

### Installation

Step-by-step instructions on how to get your project running locally.

1. [Configure GitHub Spec Kit](https://github.com/github/spec-kit/blob/main/README.md) on your machine
1. [Install Rust](https://rust-lang.org/tools/install/) on your machine and install the [rust-analyzer](https://code.visualstudio.com/docs/languages/rust) extension in VSCode
1. Clone the repo

   ```bash
   git clone https://github.com/jumbleknot/MovieCollectionManager.git
   ```

1. Install Docker
1. Create Shared Networks to be used by Docker Compose

   ```bash
   docker network create backend-network
   docker network create frontend-network
   ```

## Usage

Provide examples of how to use your project, ideally with code snippets or screenshots.

## Contributing

TBD

## License

[View the project license](LICENSE.md)

## Acknowledgement and Credits

TBD
