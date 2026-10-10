// One-time generator for the release signing key (Ed25519).
//
//   node scripts/release-keygen.mjs                 create the key pair
//   node scripts/release-keygen.mjs --force         overwrite an existing key (breaks updates for builds embedding the old public key)
//   node scripts/release-keygen.mjs --print-public  print the public key of the existing key
//
// The private key lives outside the repo, in ~/.flowcode-release/. It is never
// printed; only the public half is, ready to paste into src-tauri/src/updater.rs.
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.flowcode-release')
const keyPath = join(dir, 'signing-key.pem')
const args = process.argv.slice(2)

// The last 32 bytes of an Ed25519 SPKI DER are the raw public key.
const rawPublic = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)

function printPublic(raw) {
  const hex = raw.toString('hex')
  console.log(`Public key (hex): ${hex}`)
  console.log(`Rust: const RELEASE_PUBLIC_KEY: [u8; 32] = [${[...raw].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}];`)
}

if (args.includes('--print-public')) {
  if (!existsSync(keyPath)) {
    console.error(`No key at ${keyPath}: run without --print-public first.`)
    process.exit(1)
  }
  printPublic(rawPublic(createPublicKey(createPrivateKey(readFileSync(keyPath)))))
  process.exit(0)
}

if (existsSync(keyPath) && !args.includes('--force')) {
  console.error(`${keyPath} already exists: refusing to overwrite it (--force to replace, --print-public to show its public key).`)
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
mkdirSync(dir, { recursive: true })
// mode only applies on POSIX; on Windows the profile folder's ACL already restricts it to the user.
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
console.log(`Private key written to ${keyPath} - BACK IT UP, and never commit it.`)
printPublic(rawPublic(publicKey))
