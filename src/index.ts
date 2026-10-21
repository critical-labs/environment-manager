export type {
  SecretStore, DatabaseProvider, IdpDatabaseWriter, CISecretStore,
  Adapters, Manifest,
  DatabaseRotationConfig, SecretRotationConfig, RotationConfig, GitHubMapping,
  RotationOutcome, RotateResult, RotateOptions,
  RotationStalenessWarning,
  ClaudeCodeMapping,
} from './types.js'

export { loadManifest, loadRotationConfig } from './manifest.js'
export { computeRender, renderDotenv, writeEnvFile, type RenderResult, type RenderOptions } from './render.js'
export { rotateDatabase, rotateSecret } from './rotate.js'
export { reconcileOidcClients, type OidcReconcileResult } from './reconcile-oidc.js'
export { validateRotationConfig } from './config-validation.js'
export { checkStaleness, recordRotation, loadRotationState, saveRotationState, rotationKey } from './rotation-state.js'
export { reconcileClaudeCode, type ClaudeCodeReconcileResult } from './reconcile-claude-code.js'

export { OnePasswordSecretStore } from './adapters/onepassword.js'
export { NeonDatabaseProvider } from './adapters/neon.js'
export { PostgresIdpDatabaseWriter } from './adapters/idp-postgres.js'
export { GitHubCISecretStore } from './adapters/github.js'
