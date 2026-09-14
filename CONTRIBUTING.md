# Contributing to pi-discord-gateway

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/<your-username>/pi-discord-gateway.git
   cd pi-discord-gateway
   ```

2. **Install dependencies** (Node.js >= 22.19.0 required):

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
   npm run typecheck # Source and test type checking
   npm run test:compat # Real installed pi, using a local HTTP model fixture
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

## Releasing

Merging a PR into `main` runs CI but does **not** publish to npm. The [Release workflow](./.github/workflows/release.yml) runs when a `v*.*.*` tag is pushed.

For a release:

1. After the changes have merged and CI has passed, choose a new version that has not been published. Update `package.json` and `package-lock.json` together, move the `Unreleased` changelog entries under that version and date, and update the README version history.
2. Commit those release changes on `main` through the normal review process. Keep feature PRs under `Unreleased` until a release version is selected.
3. Tag the release commit with `v` followed by the exact package version, then push the tag. The workflow rejects a tag whose version differs from `package.json`.
4. Check the Release workflow result. It installs dependencies, builds and tests, publishes with npm provenance, and creates a GitHub Release. Publishing uses npm trusted publishing (OIDC), scoped to `Crokily/pi-discord-gateway` and `release.yml`; no `NPM_TOKEN` is required. The workflow installs npm >=11.5.1 on Node 24. Stable versions use npm's `latest` tag; versions containing a prerelease suffix use `next`.

If publication of an existing version tag failed, use the Release workflow’s **Run workflow** action on `main` and supply that tag. It checks out the existing tag, verifies the package version and publishes it without moving the tag. Confirm that the version is not already published before retrying.

A successful PR merge or CI run alone does not mean a new npm package is available. Confirm that the separate Release workflow completed successfully.

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
