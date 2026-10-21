// --- Port: SecretStore ---

export interface SecretStore {
  canResolve(value: string): boolean
  resolve(value: string): Promise<string>
  write(itemId: string, field: string, value: string): Promise<void>
}

// --- Port: DatabaseProvider ---

export interface DatabaseProvider {
  resetRolePassword(projectId: string, branchId: string, roleName: string): Promise<string>
  getConnectionUri(projectId: string, branchId: string, roleName: string): Promise<string>
}

// --- Port: IdpDatabaseWriter ---

export interface IdpDatabaseWriter {
  readOidcClientSecret(connectionUri: string, oidcClientId: string): Promise<string | null>
  updateOidcClientSecret(connectionUri: string, oidcClientId: string, newSecret: string): Promise<void>
  clearPreviousOidcClientSecret(connectionUri: string, oidcClientId: string): Promise<void>
}

// --- Port: CISecretStore ---

export interface CISecretStore {
  upsertSecret(owner: string, repo: string, secretName: string, value: string): Promise<void>
  upsertFingerprint(owner: string, repo: string, secretName: string, fingerprint: string): Promise<void>
  getFingerprint(owner: string, repo: string, secretName: string): Promise<string | null>
}

// --- Adapter bundle passed to core functions ---

export interface Adapters {
  secrets: SecretStore
  database?: DatabaseProvider
  idpDatabase?: IdpDatabaseWriter
  ciSecrets?: CISecretStore
}

// --- Manifest types ---

export interface Manifest {
  shared: Record<string, string>
  projects: Record<string, Record<string, string>>
  ignore?: string[]
}

// --- Annotated manifest types ---

export type ManifestValue = string | { value: string; from: string }

export interface RawManifest {
  shared: Record<string, ManifestValue>
  projects: Record<string, Record<string, ManifestValue>>
}

// --- Rotation config types ---

export interface DatabaseRotationConfig {
  name: string
  rotationIntervalDays?: number
  neon: {
    projectId: string
    productionBranchId: string
    previewBranchId: string
    roleName: string
  }
  onePassword: {
    itemId: string
    field: string
  }
}

export interface GitHubMapping {
  owner: string
  repo: string
  secretName: string
}

export interface ClaudeCodeMapping {
  mcpServer: string
  envVar?: string
  header?: string
  headerPrefix?: string
}


export interface SecretRotationConfig {
  name: string
  type: 'random' | 'idp-client' | 'external' | 'op-service-account' | 'github-pat'
  byteLength?: number
  format?: 'hex' | 'alphanumeric'
  skipRotation?: boolean
  rotationIntervalDays?: number
  oidcClientId?: string
  idpDatabase?: string
  opServiceAccount?: {
    accountName: string
    vault: string
    permissions: string
    expiresIn: string
    settingsLocalPath: string
    githubSecretName: string
    githubRepo: string
  }
  pat?: {
    name: string
    expirationDays: number
    permissions: { repository?: Record<string, string> }
    repositories: string[]
    owner: string
  }
  onePassword?: {
    itemId: string
    field: string
  }
  github?: GitHubMapping[]
  claudeCode?: ClaudeCodeMapping[]
  environments: string[]
}

export interface RotationConfig {
  /** 1Password vault holding the items below; OP_VAULT in the environment wins. */
  vault?: string
  toolEnv?: Record<string, string>
  databases: DatabaseRotationConfig[]
  secrets: SecretRotationConfig[]
}

// --- GitHub secret verification types ---

export interface GitHubSecretVerification {
  secretName: string
  repo: string
  status: 'ok' | 'mismatch' | 'unverified'
  opFingerprint?: string
  githubFingerprint?: string | null
}

// --- Rotate result types ---

export interface RotationOutcome {
  name: string
  env: string
  status: 'ok' | 'dry-run' | 'skipped' | 'error'
  error?: string
}

export interface RotationStalenessWarning {
  name: string
  daysSinceRotation: number
  rotationIntervalDays: number
}

export interface RotateResult {
  results: RotationOutcome[]
}

export interface RotateOptions {
  dryRun: boolean
  service?: string
  secret?: string
  mode: 'db' | 'secrets' | 'all'
}
