# Toolchain

The image stages and commands that check the repository's TypeScript and package a piece to run. It is not specific to any piece of the lab: it checks every TypeScript file, wherever it is. Its one reference to a piece is a test that compares its Node image digest with the one `model/` uses. How it is put together is in [docs/architecture/toolchain.md](../docs/architecture/toolchain.md).

Every command on this page is run from the root of the repository. The host needs a shell and Docker with Compose; Node is not needed on it.

## Check the code

```bash
toolchain/check.sh
```

It builds an image from the pinned Node image and the committed lockfile, copies the source in, and runs four steps in a container with no network and a read-only filesystem:

| Step | What it does | Covers |
|---|---|---|
| Typecheck | `tsc`, once with the settings in `tsconfig.json` and once with `client/web/tsconfig.json` | Every `*.ts` file outside `node_modules`, and the React app's `*.tsx` files |
| Lint | ESLint with the rules in `eslint.config.js`, warnings counted as errors | The same files |
| Test | Node's test runner | Every file matching `test/*.test.ts`, at any depth, outside `node_modules` |
| Build | Vite builds the React app, into a temporary folder | `client/web/` |

It exits 0 only if the image builds and all four steps pass. The steps run in that order and the first failure stops it. It writes nothing into the repository.

A new TypeScript file or a new `test/*.test.ts` file is covered without changing anything here.

## What is checked

- **Types:** `strict`, plus `noUncheckedIndexedAccess`: reading `list[0]` or a capture group of a match gives a value that may be `undefined`, and the code must handle that.
- **Syntax Node can run directly:** `erasableSyntaxOnly` and `verbatimModuleSyntax`. The TypeScript here runs on Node without a compile step, so imports name their file with its `.ts` extension, and constructs that need compiling (enums, parameter properties, namespaces) are refused.
- **The React app has its own compiler settings** in `client/web/tsconfig.json`, because it runs in a browser: the same strictness, with browser types and JSX. Its lint adds the two rules of React hooks.
- **Promises:** three lint rules, all errors.

  | Rule | Catches |
  |---|---|
  | `no-floating-promises` | A promise that is neither awaited nor handled, so its failure is lost |
  | `no-misused-promises` | A promise where a plain value is expected, such as in a condition or a callback that ignores its result |
  | `await-thenable` | `await` on something that is not a promise |

  Calls to `test`, `it` and `describe` from `node:test` are exempt from the first rule.

## Change a dependency

Every version in `package.json` is exact. To add or change one, edit `package.json`, then regenerate the lockfile:

```bash
toolchain/lock.sh
```

It runs npm inside the pinned Node image and writes `package-lock.json` at the root of the repository. Versions that are already locked do not move. No dependency's install script is run, here or in the check. On a failure it exits non-zero and leaves the existing lockfile as it was. Resolution has a time limit of 300 seconds, because npm does not exit on some inputs it cannot resolve.

Commit `package.json` and `package-lock.json` together. If they disagree, the check fails when it installs.

## The dev container

Open the repository in VS Code with the Dev Containers extension and choose "Reopen in Container". VS Code then works inside a container built from the same stage the check installs its dependencies in.

- The repository is mounted at `/repo`, and `npm run check` there runs the same four steps as `toolchain/check.sh`. `npm run typecheck`, `npm run lint` and `npm run test` run one step each.
- Dependencies are kept in a Docker volume, not in the repository. An empty `node_modules` folder appears at the root of the repository on the host: it is where the volume is attached, it stays empty, and git ignores it.
- The container has no `git`. Commit from a terminal on the host.
- VS Code downloads its own server and the ESLint extension into the container when it attaches. Those downloads are VS Code's, and the repository does not pin them.

`toolchain/check.sh` is the check that counts: it uses only the source that is in the repository, in a container nothing else has touched.

## What was measured

- `toolchain/check.sh` passed with 24 tests on an arm64 Mac with Docker Desktop and on an amd64 machine with Docker 29 on Ubuntu 24.04. With the case system, the client and both intake agents it runs 164 tests and builds the React app, and that passed on both machines.
- The `run` stage was built and run for `tools/case-system` on the arm64 Mac only.
- Each of these, added on purpose to a copy of the repository, made it exit non-zero: a type error, an unchecked index access, an un-awaited call to a library function, and a failing test.
- With `.env` files, a `.git` folder, a `secrets` folder and a gate report planted in a copy, none of them was in the image.
- `toolchain/lock.sh` run twice changed nothing the second time. With a version that does not exist in `package.json`, it exited non-zero at the time limit and left the lockfile unchanged. Both were run on macOS only.
- The dev container has not been opened in VS Code. What was run is its equivalent with plain Docker: the `deps` image, the repository mounted at `/repo`, a new volume at `/repo/node_modules`, user `node`, then `npm ci --ignore-scripts` and `npm run check`. It has not been run on a Linux host, where VS Code changes the container user's ID to match the host user's.

## Image stages

All in `toolchain/Dockerfile`, built with the root of the repository as the build context.

| Stage | Contents | Used by |
|---|---|---|
| `base` | The pinned Node image, user `node`, working directory `/repo` | Every other stage |
| `deps` | `base`, the root `package.json` and `package-lock.json`, and the dependencies installed from them | The check, the dev container |
| `check` | `deps` and the repository's source | `toolchain/check.sh` |
| `run-deps` | `base` and only the dependencies needed at run time, without the check's tools | The `run` stage |
| `run` | `run-deps`, a `/data` folder owned by `node`, the `shared/` folder, and one piece's `src/` folder. The piece is named by the build argument `PIECE`, such as `tools/case-system` | Each piece's own compose file, which also sets the command |
| `web-build` | `deps`, and one piece's React app in its `web/` folder, built by Vite to static files | The `run-web` stage |
| `run-web` | `run`, and the static files from `web-build` | The compose file of a piece that has a React app, which today is `client/` |
| `lock`, `lockfile` | npm resolving the lockfile, and the one file it produces | `toolchain/lock.sh` |

A piece's server runs its TypeScript directly on Node; nothing compiles it to JavaScript. Only the React app is built, because a browser cannot run it as written.

## What never enters an image

The root `.dockerignore` keeps these out of every build: `.git`, any `node_modules`, any `.env` or `.env.*` file other than `.env.example`, anything under a `secrets` folder, and `model/gate-report.json`.
