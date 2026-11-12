# Encryption Strategy — StoreIt

## Chosen: AES-256-GCM (Authenticated Encryption)

Every encrypt/decrypt call uses AES-256-GCM — on the client side via Web Crypto (`crypto.subtle` in `hooks/useFileEncryption.ts`) and on the server side via Node's `crypto.createCipheriv` (`server/services/encryptionService.ts`).

- **Authenticated (AEAD):** GCM produces a 16-byte authentication tag alongside the ciphertext. `crypto.subtle.decrypt` and `decipher.final()` throw if the tag doesn't verify — tampered or corrupted chunks fail loudly at decrypt time instead of silently producing garbage bytes.
- **Per-chunk 12-byte random nonces:** Generated fresh via `crypto.getRandomValues` for each chunk. 96 bits of entropy makes accidental (key, nonce) reuse negligible before ~2^40 chunks — avoiding GCM's only catastrophic failure mode (leaks XOR of two plaintexts + breaks authentication).
- **Key wrapping:** The per-account DEK is wrapped via PBKDF2-HMAC-SHA256 with 600,000 iterations deriving a key from the 160-bit recovery code, then encrypted with AES-GCM for storage server-side.

---

## Tradeoffs vs. Other Strategies

### AES-256-CBC + HMAC

Separates confidentiality (CBC) from integrity (HMAC). Requires encrypt-then-MAC in the correct order, constant-time HMAC comparison, and managing two keys instead of one. Padding-oracle attacks are a real risk if the MAC check order is wrong. While widely used (TLS 1.2), the implementation surface is larger and easier to get wrong than GCM.

### AES-256-GCM-SIV (Nonce-Misuse Resistant)

GCM's catastrophic (key, nonce) reuse drops to a mild privacy leak only. But ~40% slower than plain GCM and `crypto.subtle` doesn't expose it — would need a WASM polyfill. Unnecessary here because random 12-byte nonces make collision negligible.

### ChaCha20-Poly1305

Same AEAD properties as GCM but faster on mobile CPUs without AES hardware acceleration. However, `crypto.subtle` support is narrower (Safari 16+, Firefox 122+). The performance benefit is irrelevant here — the bottleneck is Telegram API latency (24s per chunk), not cipher speed (~8ms per 4MB chunk).

### XChaCha20-Poly1305

192-bit nonce eliminates collision concern entirely (can use a simple counter). Even less browser support than ChaCha20. Would need a WASM fallback for broad compatibility.

### Per-File Keys Instead of Per-Account DEK

Limits blast radius — one compromised key exposes only one file. But every file needs its own salt and PBKDF2 derivation, making resume and cross-device access painfully slow. The account-wide DEK is a deliberate tradeoff: convenience vs. total exposure on key compromise, same model as a password manager.

---

## What Is a Salt?

A **salt** is a random value combined with a password or key before hashing to prevent precomputation attacks.

Without a salt, if two users have the same password, they get the same hash — an attacker can compute hashes for common passwords once (rainbow table) and match them against every user simultaneously.

With a unique random salt per user, the same password produces a completely different hash each time. An attacker must brute-force each user's password independently, multiplied by the salt length.

The salt is **not secret** — it's stored in plaintext alongside the hash. Its purpose is uniqueness, not secrecy.

In this codebase, PBKDF2-HMAC-SHA256 takes a random salt (generated once and stored as `encryptionRecoverySalt` on the `User` document) so two accounts with the same recovery code produce different wrapped DEK blobs. The salt forces per-target brute-forcing instead of a single computation matching all users at once.

---

## Summary

GCM was the correct choice for this codebase: authenticated by default, supported natively in both browser and Node, fast enough to be irrelevant next to Telegram's 24s API latency, and the single-key concern is mitigated by PBKDF2 wrapping with unique salts and device-local storage in IndexedDB.
