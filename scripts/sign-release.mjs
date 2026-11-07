// Binds SHA256SUMS to its release version, then uploads the manifest and signature.
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
const VERSION_HEADER = '# flowcode-version: '
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

function releaseVersion(tag) {
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag)
  if (!match) throw new Error('release tag must be a stable version such as v0.29.0')
  return match[1]
}

function versionedManifest(raw, version) {
  const lines = raw.toString('utf8').split(/\r?\n/)
  const headers = lines.filter((line) => line.startsWith('# flowcode-version'))
  if (headers.length > 0) {
    if (headers.length !== 1 || lines[0] !== VERSION_HEADER + version) {
      throw new Error('SHA256SUMS version header does not match the release tag')
    }
    return raw
  }
  // Keep every checksum byte unchanged for existing updater versions.
  return Buffer.concat([Buffer.from(VERSION_HEADER + version + '\n'), raw])
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(USAGE)
  process.exit(args.length === 0 ? 1 : 0)
}

if (args.includes('--self-test')) {
  const { privateKey } = generateKeyPairSync('ed25519')
  const version = releaseVersion('v0.0.1')
  const legacy = Buffer.from('abc123  Flowcode-Setup-0.0.1.exe\n')
  const sample = versionedManifest(legacy, version)
  if (!sample.subarray(Buffer.byteLength(VERSION_HEADER + version + '\n')).equals(legacy)) fail('self-test: checksum bytes changed')
  if (!versionedManifest(sample, version).equals(sample)) fail('self-test: version header is not idempotent')
  const sig = signAndCheck(privateKey, sample)
  const tampered = Buffer.from(sample.toString().replace('abc123', 'abc124'))
  if (verify(null, tampered, createPublicKey(privateKey), sig)) fail('self-test: tampered data was accepted')
  const changedVersion = Buffer.from(sample.toString().replace(VERSION_HEADER + version, VERSION_HEADER + '9.9.9'))
  if (verify(null, changedVersion, createPublicKey(privateKey), sig)) fail('self-test: tampered version was accepted')
  const invalidManifests = [
    [sample, '0.0.2'],
    [Buffer.concat([sample, Buffer.from(VERSION_HEADER + version + '\n')]), version],
  ]
  for (const [candidate, expectedVersion] of invalidManifests) {
    let refused = false
    try { versionedManifest(candidate, expectedVersion) } catch { refused = true }
    if (!refused) fail('self-test: mismatched or duplicate version header was accepted')
  }
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
  const version = releaseVersion(tag)
  let privateKey
  try {
    privateKey = createPrivateKey(readFileSync(keyPath))
  } catch (e) {
    fail(`can't read the signing key at ${keyPath} (${e.message}). Generate one with scripts/release-keygen.mjs.`)
  }

  console.log(`[1/4] Downloading SHA256SUMS of ${tag}...`)
  gh('release', 'download', tag, '--repo', REPO, '-p', 'SHA256SUMS', '-D', work, '--clobber')
  const sumsFile = join(work, 'SHA256SUMS')
  const sums = versionedManifest(readFileSync(sumsFile), version)
  // The app verifies exactly these bytes; the header is signed with the hashes.
  writeFileSync(sumsFile, sums)

  console.log('[2/4] Signing and self-verifying...')
  const sigFile = join(work, 'SHA256SUMS.sig')
  writeFileSync(sigFile, signAndCheck(privateKey, sums).toString('hex') + '\n')

  console.log('[3/4] Uploading versioned SHA256SUMS, then SHA256SUMS.sig...')
  gh('release', 'upload', tag, sumsFile, '--repo', REPO, '--clobber')
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
