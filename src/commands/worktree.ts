/**
 * `instar worktree ...` — operator tools for parallel-dev isolation.
 *
 * Currently exposes:
 *   - `register-keypair --private <path>` — move a Day-2 migration keypair
 *     into the configured keyvault backend (macOS keychain, Linux libsecret,
 *     or flat-file fallback). Generates hmac + machineId locally.
 *
 * See docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md §"Migration (iter 4)".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import { WorktreeKeyVault } from '../core/WorktreeKeyVault.js';

export interface RegisterKeypairOptions {
  /** Path to the Ed25519 private-key PEM (pkcs8). Usually the `.NEW` file
   *  produced by scripts/migrate-incident-2026-04-17.mjs. */
  privatePath: string;
  /** Force a specific backend for testing. */
  forceBackend?: 'keychain' | 'flatfile';
  /** Passphrase resolver for headless flat-file backend. */
  passphraseResolver?: () => Promise<string> | string;
  /** When true, the input file is NOT deleted after successful registration.
   *  Default is false — secure delete preserves least-copies-of-key invariants. */
  keepInputFile?: boolean;
}

export async function registerKeypair(opts: RegisterKeypairOptions): Promise<void> {
  // Resolve + read the private key PEM.
  const privAbs = path.resolve(opts.privatePath);
  if (!fs.existsSync(privAbs)) {
    throw new Error(`private key file not found: ${privAbs}`);
  }
  const privPem = fs.readFileSync(privAbs, 'utf-8');
  if (!privPem.includes('BEGIN PRIVATE KEY') && !privPem.includes('BEGIN EC PRIVATE KEY')) {
    throw new Error(`file does not look like a PEM private key: ${privAbs}`);
  }

  // Derive the public key from the private key (Node's crypto supports this
  // natively for Ed25519 keys stored as pkcs8 PEM).
  let publicPem: string;
  try {
    const privObj = crypto.createPrivateKey(privPem);
    const pubObj = crypto.createPublicKey(privObj);
    publicPem = pubObj.export({ type: 'spki', format: 'pem' }).toString();
  } catch (err) {
    throw new Error(`failed to derive public key from private key: ${(err as Error).message}`);
  }

  // Generate fresh hmac + machineId. These are per-install secrets and don't
  // need to be anchored in the migration — only the signing keypair does.
  const hmacKey = crypto.randomBytes(32);
  const machineId = crypto.randomUUID();
  const keyVersion = 1;

  // Persist via the vault. The vault decides which backend to use and
  // handles the platform-specific storage format (including the base64
  // wrap that keeps multi-line PEM survivable through macOS keychain).
  const config = loadConfig();
  ensureStateDir(config.stateDir);
  const vault = new WorktreeKeyVault({
    stateDir: config.stateDir,
    headlessAllowed: !!opts.passphraseResolver || !!opts.forceBackend,
    forceBackend: opts.forceBackend,
    passphraseResolver: opts.passphraseResolver,
  });
  await vault.importKeyMaterial({
    signing: { privateKeyPem: privPem, publicKeyPem: publicPem, keyVersion },
    hmacKey,
    machineId,
  });

  // Securely delete the input file. `fs.unlink` is good enough on modern
  // journaled filesystems; the migration script marked the file 0600 so
  // access was already restricted.
  if (!opts.keepInputFile) {
    try {
      // Overwrite with zero-length before unlink — best-effort scrub.
      fs.writeFileSync(privAbs, '');
      // safe-git-allow: incremental-migration
      fs.unlinkSync(privAbs);
    } catch (err) {
      console.error(pc.yellow(`  warning: could not delete input file ${privAbs}: ${(err as Error).message}`));
    }
  }

  console.log(pc.green(`✓ keypair registered under service 'instar.parallel-dev'`));
  console.log(pc.dim(`  machineId: ${machineId}`));
  console.log(pc.dim(`  keyVersion: ${keyVersion}`));
  if (!opts.keepInputFile) {
    console.log(pc.dim(`  input file scrubbed + deleted: ${privAbs}`));
  }
}
