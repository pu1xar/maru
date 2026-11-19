# Contributing

maru is a personal project, and I review pull requests when I have time, which can take a while.

1. Open an issue first and describe what you want to change. A change that does not fit the project's single-user scope may be declined
2. Keep a pull request small and about one thing
3. Run the checks before you push, they are the same ones CI runs
   ```sh
   pnpm install
   pnpm typecheck
   pnpm test

   cd apps/mobile
   npm ci
   npx tsc --noEmit -p .
   node --test 'src/**/*.test.ts' 'scripts/**/*.test.mts'
   ```
4. Add or update a test when you change behavior

Code conventions

- The server runs TypeScript directly with Node's type stripping, so only erasable syntax is allowed (no enums, no parameter properties, no namespaces)
- Files that are adapted from other projects keep their license header. Add new third-party code to `THIRD_PARTY_NOTICES.md`

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the MIT License of this repository.
