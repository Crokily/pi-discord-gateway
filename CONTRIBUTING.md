# Contributing to pi-discord-gateway

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/<your-username>/pi-discord-gateway.git
   cd pi-discord-gateway
   ```

2. **Install dependencies** (Node.js >= 20 required):

   ```bash
   npm install
   ```

3. **Copy the environment file** and fill in your Discord bot token:

   ```bash
   cp .env.example .env
   ```

4. **Build and test**:

   ```bash
   npm run build
   npm test
   ```

## Development Workflow

1. Create a branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes. Run the dev server with:

   ```bash
   npm run dev
   ```

3. Ensure your code passes all checks:

   ```bash
   npm run lint      # ESLint
   npm run format    # Prettier (auto-fix)
   npm test          # Vitest
   npm run build     # TypeScript compilation
   ```

4. Commit your changes with a descriptive message following [Conventional Commits](https://www.conventionalcommits.org/):

   ```
   feat: add slash command for channel settings
   fix: prevent duplicate queue entries
   docs: update setup instructions
   chore: bump discord.js to v14.19
   ```

5. Push your branch and open a Pull Request against `main`.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR.
- Fill out the PR template completely.
- Ensure CI passes (build, lint, test) before requesting review.
- Add tests for new functionality when possible.
- Update the README if you're adding user-facing features.

## Code Style

This project uses **ESLint** and **Prettier** to enforce consistent code style:

- 2-space indentation
- Single quotes
- Semicolons
- ES modules (`import`/`export`)

Run `npm run format` to auto-format your code before committing.

## Reporting Issues

- Use the **Bug Report** template for bugs.
- Use the **Feature Request** template for suggestions.
- Check existing issues before opening a new one.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
