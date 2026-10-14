// Signs a release's SHA256SUMS with the release key and uploads SHA256SUMS.sig.
//
//   node scripts/sign-release.mjs <tag> [--publish] [--key <pem path>]
//   node scripts/sign-release.mjs --self-test       sign+verify a sample buffer, no network
//   node scripts/sign-release.mjs --help
//
// CI publishes releases as drafts (the updater reads /releases/latest, which
// never lists drafts); --publish makes the release public once it is signed.
// Needs the GitHub CLI (`gh`), logged in with write access to the repo.
import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'MaxMoffa/flowcode'
const args = process.argv.slice(2)

const USAGE = `Usage: node scripts/sign-release.mjs <tag> [--publish] [--key <path>]
       node scripts/sign-release.mjs --self-test

  <tag>        release tag, e.g. v0.9.0 (must already have a SHA256SUMS asset)
  --publish    after uploading the signature, turn the draft release public
  --key <path> private key (PKCS8 PEM); default ~/.flowcode-release/signing-key.pem
  --self-test  sign and verify a sample buffer locally (no network, no real key)`

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function signAndCheck(privateKey, data) {
  const signature = sign(null, data, privateKey)
  if (!verify(null, data, createPublicKey(privateKey), signature)) throw new Error('signature does not verify with the derived public key')
  return signature
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(USAGE)
  process.exit(args.length === 0 ? 1 : 0)
}

if (args.includes('--self-test')) {
  const { privateKey } = generateKeyPairSync('ed25519')
  const sample = Buffer.from('abc123  Flowcode-Setup-0.0.0.exe\n')
  const sig = signAndCheck(privateKey, sample)
  const tampered = Buffer.from('abc124  Flowcode-Setup-0.0.0.exe\n')
  if (verify(null, tampered, createPublicKey(privateKey), sig)) fail('self-test: tampered data was accepted')
  console.log(`self-test ok (signature is ${sig.toString('hex').length} hex chars)`)
  process.exit(0)
}

const publish = args.includes('--publish')
const keyIdx = args.indexOf('--key')
const keyPath = keyIdx >= 0 ? args[keyIdx + 1] : join(homedir(), '.flowcode-release', 'signing-key.pem')
if (!keyPath) fail('--key needs a path')
const tag = args.find((a, i) => !a.startsWith('--') && (keyIdx < 0 || i !== keyIdx + 1))
if (!tag) fail('missing release tag\n' + USAGE)

const gh = (...a) => execFileSync('gh', a, { stdio: ['ignore', 'inherit', 'inherit'] })
const work = mkdtempSync(join(tmpdir(), 'flowcode-sign-'))
try {
  let privateKey
  try {
    privateKey = createPrivateKey(readFileSync(keyPath))
  } catch (e) {
    fail(`can't read the signing key at ${keyPath} (${e.message}). Generate one with scripts/release-keygen.mjs.`)
  }

  console.log(`[1/4] Downloading SHA256SUMS of ${tag}...`)
  gh('release', 'download', tag, '--repo', REPO, '-p', 'SHA256SUMS', '-D', work, '--clobber')
  // Raw bytes: the app verifies the signature over exactly what GitHub serves.
  const sums = readFileSync(join(work, 'SHA256SUMS'))

  console.log('[2/4] Signing and self-verifying...')
  const sigFile = join(work, 'SHA256SUMS.sig')
  writeFileSync(sigFile, signAndCheck(privateKey, sums).toString('hex') + '\n')

  console.log('[3/4] Uploading SHA256SUMS.sig...')
  gh('release', 'upload', tag, sigFile, '--repo', REPO, '--clobber')

  if (publish) {
    console.log('[4/4] Publishing the release...')
    gh('release', 'edit', tag, '--repo', REPO, '--draft=false')
  } else {
    console.log('[4/4] Skipped publishing (no --publish): the release is still a draft.')
  }
  console.log('Done.')
} catch (e) {
  fail(e.message)
} finally {
  rmSync(work, { recursive: true, force: true })
}
