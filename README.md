# environment-manager

Keep your app's secrets in 1Password and let this tool put them where they are needed: `.env` files, GitHub Actions secrets, and a few other places. It can also rotate secrets on a schedule.

Everything is driven by YAML files in a `.environment-manager/` directory in your repository. Put `op://` references to secrets in those files, never the secrets themselves; the tool does not stop you.

## Install

```sh
npm install --save-dev @critical-labs/environment-manager
```

You need Node 22 or later and the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`). Locally, turn on the 1Password desktop app's CLI integration. In CI, set `OP_SERVICE_ACCOUNT_TOKEN`.

Run every command from the root of your repository.

## Render a .env file

The simplest use. Describe the variables in a manifest, using `op://` references for secrets:

```yaml
# .environment-manager/production.manifest.yaml
shared:
  NODE_ENV: production
  DATABASE_URL: "op://My Vault/Database/connection_string"
  SESSION_SECRET: "op://My Vault/App secrets/session_secret"

projects:
  worker:
    QUEUE_CONCURRENCY: "4"
```

Preview the result. Secret values are masked:

```sh
npx environment-manager render production --dry-run
```

```
[DRY RUN] 3 vars (2 secret, 1 literal):
  NODE_ENV=production
  DATABASE_URL=******
  SESSION_SECRET=******
```

Then write the file:

```sh
npx environment-manager render production --out .env
npx environment-manager render production --project worker --out worker.env
```

The file is written with mode `0600`. `--project` adds that project's variables on top of `shared`.

## Keep GitHub Actions secrets in sync

Secrets that GitHub Actions needs are listed in `.environment-manager/rotation.yaml`. Each entry names the 1Password item and field that hold the value, and the repositories that need it:

```yaml
# .environment-manager/rotation.yaml
vault: My Vault

databases: []

secrets:
  - name: deploy-key
    type: external
    onePassword: { itemId: "Deploy key", field: "credential" }
    github:
      - { owner: my-org, repo: my-app, secretName: DEPLOY_KEY }
    environments: [production]
```

Check whether GitHub matches 1Password, then fix any drift:

```sh
npx environment-manager verify production
npx environment-manager sync production          # preview
npx environment-manager sync production --apply  # write
```

GitHub does not let anyone read a secret back, so when `sync` writes a secret it also stores a short fingerprint of the value in a repository variable named `<SECRET>__FINGERPRINT`. `verify` compares those fingerprints. A fingerprint is a truncated SHA-256 hash: it does not reveal a long random secret, but anyone who can read the repository's variables could guess a short or predictable one. Only sync secrets that are long and random.

GitHub access uses `GITHUB_TOKEN` if it is set, and otherwise your `gh` CLI login.

## Rotate secrets

Change `type` to tell the tool how to make a new value:

| type | what `rotate` does |
| --- | --- |
| `random` | Generates a new random value (`byteLength`, `format: hex` or `alphanumeric`). |
| `idp-client` | Generates a new OIDC client secret; see [OIDC client secrets](#oidc-client-secrets). |
| `op-service-account` | Creates a new 1Password service account token. Needs a signed-in person. |
| `external` | Nothing. You rotate it by hand; the tool still syncs and verifies it. |
| `github-pat` | Nothing. GitHub has no API for creating fine-grained tokens. |

```yaml
secrets:
  - name: session-secret
    type: random
    byteLength: 32
    rotationIntervalDays: 90
    onePassword: { itemId: "App secrets", field: "session_secret" }
    github:
      - { owner: my-org, repo: my-app, secretName: SESSION_SECRET }
    environments: [production]
```

```sh
npx environment-manager rotate production                # preview
npx environment-manager rotate production --apply        # rotate everything rotatable
npx environment-manager rotate production --apply --secret session-secret
```

A rotation writes the new value to 1Password first, then pushes the secrets it rotated to GitHub and updates any OIDC databases, so they change in the same step. Claude Code settings are only updated by `sync --apply`. Anything else that reads the secret, such as a `.env` file on a server, picks up the new value the next time you render it.

`rotationIntervalDays` says how often a secret should change. `rotate --due` rotates only the secrets that are overdue. For secrets you rotate by hand, run `npx environment-manager record production deploy-key` afterwards to restart the clock; `sync` and `rotate` warn about any that are overdue.

The rotation history is kept on each machine, outside the repository: in `~/Library/Application Support/environment-manager/` on macOS and `~/.local/state/environment-manager/` elsewhere.

## Scheduled rotation on macOS

Some secrets can only be rotated by a signed-in person: creating a 1Password service account needs your 1Password account. `schedule` runs the rotation on your Mac:

```sh
npx environment-manager schedule install production
npx environment-manager schedule status production
npx environment-manager schedule uninstall production
```

`install` adds a LaunchAgent that runs `rotate production --due --apply --notify` when you log in and every day at 10:00 (change it with `--hour`). On a day with nothing due it exits without contacting 1Password. Otherwise it rotates what is due and shows a notification with the result. Logs are in `~/Library/Logs/environment-manager/`.

The agent does not run from your repository. `install` copies two things into `~/Library/Application Support/environment-manager/`:

- this release of the package, downloaded from the public npm registry and checked against the registry's integrity hash, with no install scripts;
- your `rotation.yaml` as it is now.

The agent uses only those copies, so pulling a commit or checking out a branch never changes what it does, and it works even when the repository is in a folder macOS keeps background jobs out of, such as `~/Documents`. After you change `rotation.yaml` or upgrade the package, run `schedule install` again. `schedule status` tells you when the repository's `rotation.yaml` no longer matches the copy.

A scheduled rotation of an `op-service-account` secret cannot update the settings file in your repository. Run `npx environment-manager sync production --apply` there afterwards; the notification reminds you.

On other systems, run `npx environment-manager rotate production --due --apply` from cron or a CI schedule.

## Treat the configuration as code

`rotation.yaml` decides where your secrets go, and the tool acts with your 1Password, GitHub, and Claude Code access. A malicious change to it could send secrets to someone else's repository. Review changes to `.environment-manager/` like code, and read the diff before re-running `schedule install`.

## Environments

The environment name, `production` above, picks the manifest file (`production.manifest.yaml`) and filters `rotation.yaml` entries by their `environments` list. For `rotation.yaml` entries, the `preview` environment reads and writes the 1Password field with `_preview` appended, so one item can hold both values.

## Credentials the tool itself needs

`toolEnv` in `rotation.yaml` loads credentials for the tool from 1Password before a command runs. Every value must be an `op://` reference:

```yaml
toolEnv:
  NEON_API_KEY: "op://My Vault/Neon/credential"
```

The `vault` setting is used when a command looks up an item by ID. The `OP_VAULT` environment variable overrides it.

## Neon databases

`rotate` can reset a [Neon](https://neon.tech) role's password and store the new connection string in 1Password. It needs `NEON_API_KEY`.

```yaml
databases:
  - name: main
    rotationIntervalDays: 90
    neon:
      projectId: "your-project-id"
      productionBranchId: "br-production-id"
      previewBranchId: "br-preview-id"
      roleName: app_user
    onePassword: { itemId: "Database", field: "connection_string" }
```

Restrict a run to databases with `--mode db`, or to secrets with `--mode secrets`.

## OIDC client secrets

If you run your own OIDC provider, the `idp-client` type keeps a client's secret in its database in step with 1Password. The database must have an `oidc_clients` table with `client_id`, `client_secret`, `previous_client_secret`, and `updated_at` columns, and must be one of your `databases`.

```yaml
  - name: web-client-secret
    type: idp-client
    oidcClientId: web-app
    idpDatabase: main
    onePassword: { itemId: "OIDC", field: "web_client_secret" }
    environments: [production]
```

When the secret changes, the old value moves to `previous_client_secret`, so a provider that checks both columns keeps accepting it while clients update. The tool does not clear that column; the old secret stays valid until the next rotation.

## Security notes

- **Fingerprints.** `verify` relies on truncated SHA-256 fingerprints stored as GitHub repository variables. They do not reveal long random secrets, but they would let someone with read access confirm a guess at a short or predictable one.
- **Writing to 1Password.** The tool writes new values with `op item edit`, which takes them as command-line arguments. While that command runs, other users on the same machine can see the value in the process list. Run rotations on a machine you do not share.
- **Old service accounts.** Rotating an `op-service-account` secret creates a new service account and leaves the old one valid until it expires. The 1Password CLI cannot delete service accounts; revoke old ones on 1Password.com.
- **OIDC clients.** The previous client secret stays valid until the next rotation.

## Commands

| command | does |
| --- | --- |
| `render <name>` | Writes a `.env` file from `<name>.manifest.yaml`. |
| `verify <env>` | Compares GitHub Actions secrets with 1Password. |
| `sync <env>` | Pushes 1Password values to GitHub, OIDC databases, and Claude Code MCP settings. Preview unless `--apply`. |
| `rotate <env>` | Rotates secrets and databases. Preview unless `--apply`. |
| `record <env> <name>` | Records a rotation you did by hand. |
| `schedule install\|status\|uninstall <env>` | Manages scheduled rotation on macOS. |

Run `npx environment-manager <command> --help` for every option.

## Releasing

Bump `version` in `package.json` on `main` and push a `v<version>` tag. The publish workflow stages the release on npm, and a maintainer approves it on npmjs.com.

## License

MIT
