# StoreIt: 30-minute project talk

## Format

Plan for 25 minutes of presentation and 5 minutes of Q&A. The talk tells the project story through its design decisions: keeping file operations coherent across storage backends, making large uploads resilient, and making security-sensitive actions explicit.

| Time | Section |
|---|---|
| 0:00–2:00 | Problem and opening |
| 2:00–5:00 | Product journey |
| 5:00–8:00 | Architecture |
| 8:00–13:00 | Upload pipeline and reliability |
| 13:00–17:00 | Data model, versions, and sharing |
| 17:00–21:00 | Encryption and authentication |
| 21:00–24:00 | Tradeoffs and next steps |
| 24:00–25:00 | Close |
| 25:00–30:00 | Questions |

## Speaker notes

### 0:00–2:00 — Problem and opening

> Hi, I’m going to walk through StoreIt, a cloud file-management application I built. I’ll focus on the decisions behind the system rather than just listing features.
>
> The user sees a place to upload, organize, find, and share files. Underneath, each action crosses boundaries between the browser, application server, metadata database, external storage, and—in the encrypted mode—keys that the server should not learn.
>
> I’ll use two concrete examples: making large uploads more resilient when the storage path is slow, and fixing an authentication design where background state could trigger a credential change without clear user intent.

### 2:00–5:00 — Product journey

> StoreIt supports file upload, folders, search, version history, and sharing. A user selects a file, uploads it, finds it in their file list, and can organize, search, update, or share it later.
>
> The design goal is to hide storage mechanics from the normal user flow. A file stays one logical file even when its bytes are split into chunks or the storage backend changes. Metadata such as owner, folder, size, hash, backend, and current version is tracked separately from the bytes.
>
> That separation lets the same file list and access checks work across backends. The application routes downloads based on the backend recorded for that file.

**Show:** the dashboard, one upload, then a folder or version/share view. Keep the demo short.

### 5:00–8:00 — Architecture

> The application uses Next.js, React, and TypeScript. API routes coordinate authenticated operations, MongoDB stores users and file metadata, and storage adapters handle file bytes. The current project supports Telegram-backed chunk storage and S3.
>
> On upload, the browser initializes an upload, sends content, and asks the server to finalize it. The server records status and storage metadata. On download, the server checks access and routes to the backend-specific implementation. MongoDB is the source of truth for ownership, status, version pointers, and the selected backend.
>
> I kept this as a modular application rather than splitting it into microservices. The domain is evolving, and service and adapter boundaries provide separation without adding deployment and distributed-transaction complexity prematurely.

**Board sketch:** `Browser → Next.js UI/API → MongoDB (metadata)` and `Next.js API → Telegram | S3 (bytes)`. Add `Web Crypto / IndexedDB` for the encryption section.

### 8:00–13:00 — Large-file upload design

> In the Telegram storage path, large files are split into 4 MB chunks. The browser sends them through a bounded queue with six workers per upload. Each successful chunk is recorded with its index and storage identifiers, so the application can resume missing pieces and reconstruct the original order.
>
> I measured the request before optimizing it. Sending a 4 MB body took tens of milliseconds, while waiting for a response took roughly 23 to 24 seconds. That pointed to the remote storage path, rather than local encryption or request transfer, as the dominant cost. The useful lever was overlapping independent requests, not micro-optimizing code that wasn’t consuming the time.
>
> I chose bounded concurrency instead of starting every chunk at once. Six is a per-file client limit; it is not a system-wide limit. Transient failures get retries with backoff. Progress advances after a successful response. On resume, the client asks which chunk indexes are missing rather than restarting the whole upload.
>
> Upload is a state machine, not one boolean. A Telegram upload can be pending, uploading, paused, or uploaded. If it cannot complete, it can pass through cleanup into an S3-pending state. The same file record is reused, partial Telegram chunks are cleaned up where possible, and late Telegram chunks are rejected after the backend changes. This avoids mixing backends or counting quota twice.
>
> The tradeoff is lifecycle complexity. Retries, cancellation, fallback, and concurrent requests create race conditions, so transitions need guards and completion needs to be idempotent. That complexity is justified when it prevents losing a long upload to one transient failure.

#### Technical backup for the upload section — use selectively in Q&A

The talk itself should give the summary, then use these cases as a deep-dive menu. Don’t read the full matrix during the five-minute upload section.

“Race condition” means two valid operations overlap, and the final result can depend on which database write or external request finishes first. It does not mean every overlap causes data loss. The table distinguishes protections that exist from remaining gaps.

| Overlap / failure | What can go wrong | Safeguard present | Remaining exposure |
|---|---|---|---|
| Two workers retry the same chunk | Duplicate Telegram messages or two records for one chunk index | Mongo has a unique `{fileId, chunkIndex}` index. The losing insert deletes its extra Telegram message. Resume skips indexes already recorded. | If deleting the duplicate Telegram message fails, an orphan can remain in Telegram. |
| Pause then resume before old workers stop | Old and new worker pools both upload chunks; progress may be wrong and duplicate requests increase | The browser tracks the active run per upload, aborts in-flight requests on pause, waits for the old worker promise to drain, then fetches uploaded indexes before resuming. | Browser abort cannot guarantee that a remote Telegram request already accepted by Telegram is undone. Server-side idempotency by chunk identity is still needed to close that gap completely. |
| Cancel while a chunk request is in flight | A chunk may finish after the user cancelled; deleting DB state before the late request records its result can leave Telegram data without a matching File/Chunk row | The client aborts requests. The server checks request abort before sending to Telegram. Cancel refuses to delete a File already marked `uploaded`. | The cancellation endpoint does not first atomically fence the File into a terminal `cancelled` state. A chunk that passed its status check can continue through Telegram send while cancel deletes rows and the File. The late chunk can then create an orphan row/message. |
| Telegram failure triggers S3 fallback while sibling chunks are active | A late Telegram chunk may land after cleanup; a file might have data in both backends | The client waits for its chunk-worker pool to finish before invoking fallback. The fallback route atomically changes an eligible File to `fallback_cleanup`; later chunk requests reject a non-Telegram backend/status. The route deletes recorded Telegram chunks before switching to S3. | A server chunk request that passed its initial File/status check before the switch can still be in the Telegram network call. The fallback cleanup can miss it, then it can record after cleanup. The initial check and external side effect are not one atomic operation. This can orphan Telegram data even if the visible File ends up in S3. |
| Fallback runs twice, or races with completion | The same placeholder could be converted twice, or a Telegram completion could race a backend switch | Fallback uses a conditional `findOneAndUpdate` on backend and eligible statuses, so only a caller matching the current state gets the transition. Version creation runs in a Mongo transaction; version numbers have a unique index. | The fallback route allows `fallback_cleanup` as eligible, so the transition itself is not a one-time claim. More importantly, completion and fallback do not share one explicit compare-and-set transition protocol. Concurrent behavior should be treated as needing a targeted race test and stronger terminal-state guards. |
| Same file is completed twice | Duplicate versions or quota counted twice | Completion checks chunk count; version writes and quota increments are inside a Mongo transaction. A unique `(file_id, version)` index and transaction conflict handling protect version numbering. Already-uploaded requests return the completed file. | The check that all chunks exist happens before the transaction. Completion should also atomically claim a `completing` state (or use an idempotency key) so all completion side effects have a single winner. |
| User starts the same content twice / many uploads compete for quota | Duplicate logical files, two pending uploads both pass quota check, or final storage use exceeds quota | Hash checks reject duplicates that are already uploaded. Mongo `$inc` makes each completed quota update atomic. | The duplicate check is a read before create, with no unique active-upload constraint. Quota is checked against already-used storage, but pending upload sizes are not reserved atomically. Two concurrent inits can both pass; their eventual completions can push usage over the limit. |
| S3 part is retried or multipart upload is abandoned | Latest part may replace an earlier part; abandoned multipart data/upload state can remain; finalization can fail | The client retries each part and records its ETag; completion is explicit and S3 validates the multipart parts. | There is no app multipart-abort route in the upload paths inspected. A stalled/abandoned multipart upload needs an S3 lifecycle cleanup rule or explicit abort job; the repository alone does not show that such a bucket rule is configured. |

**How likely are these?** I can’t give honest percentages from this repository: there is no traffic distribution, provider error rate, race telemetry, or production concurrency test result here. The browser-only pause/resume overlap is specifically guarded and should be uncommon in normal use. Cancel/fallback races require a narrow timing window, so each individual event is less likely than ordinary upload errors, but risk rises with the number of requests in flight and retries. A 429 from Telegram is an expected overload response, not a rare edge case under enough concurrent traffic. Quota oversubscription requires two or more uploads for the same account to pass the check before either one completes; likelihood rises when the account is near its limit and uploads overlap. State it as “possible and currently not measured,” not as a made-up percentage.

#### What if a huge number of people upload simultaneously?

> The six-worker cap only applies inside one browser upload. With `N` users each uploading one large file, the app can receive roughly `6 × N` chunk requests at once; each user can start more than one file, so the actual count can be higher. There is no global upload semaphore or upload-specific rate limit in these routes. Therefore six workers is not protection against a traffic spike.
>
> Each chunk request authenticates the user, reads the multipart body, checks MongoDB file/permission state, checks for an existing chunk, calls Telegram, then writes a chunk record. At high concurrency, the first likely symptoms are provider 429 responses and latency, then a growing queue of server requests, memory pressure from multiple in-memory chunk buffers, MongoDB connection/operation pressure, and timeouts. Client and server retries can amplify load: the server makes up to three Telegram attempts, and the client can retry a failed chunk request up to three times, so a persistently failing chunk can cause up to nine Telegram-send attempts before the client gives up or falls back. Sibling workers can also finish work while one chunk is failing.
>
> The route honors Telegram’s retry-after when it is at most eight seconds, uses backoff, and signals S3 fallback when the provider remains unavailable or asks for a longer wait. That gives one upload a recovery path; it does not provide fleet-wide backpressure. If many users hit fallback together, S3, the app servers, or MongoDB can become the next bottleneck. S3 fallback also currently resets encryption mode to `none`; for a DEK-encrypted upload, that means the fallback upload is plaintext. That is a security-policy issue, not just a reliability detail, and must be resolved before presenting fallback as a transparent equivalent.

**Impact by layer:**

- **Browser:** Six workers per file can hold several chunks and encryption buffers in memory. Multiple simultaneous files multiply memory and network use; mobile or low-memory devices can stall or terminate the tab.
- **Application server:** Every chunk is parsed and buffered, then handled as a request. A burst can consume request slots, CPU for hashes/encryption, memory, and function execution time. The six-worker setting is client-controlled and can be bypassed by non-browser clients.
- **Telegram:** Shared bot/API limits can return 429 or time out. Backoff reduces immediate retry pressure for one request; repeated users can still produce a retry wave and trigger many S3 fallbacks.
- **MongoDB:** Each chunk performs multiple reads and a write. Pool saturation and slower queries lengthen request time; slow requests keep more buffers and execution capacity occupied. At completion, writes to a single user’s storage counter serialize as that user’s uploads finish.
- **S3:** Direct presigned part uploads move the bytes off the app server, but fallback initiation/finalization and app metadata still depend on the app and database. Sudden mass fallback can shift the bottleneck instead of removing it.
- **Product/data:** Pending uploads can accumulate, retries can leave orphan Telegram messages or incomplete S3 multipart uploads, same-hash uploads can race, and non-atomic quota reservation can allow a user to exceed quota.

#### Safety measures: what exists and what to add

**Already present in the code:**

- Six bounded workers per file in the browser, rather than an unbounded `Promise.all` over chunks.
- Per-chunk retry with backoff, Telegram `retry_after` handling capped at eight seconds, and a switch to S3 after persistent Telegram errors.
- Server-side auth and upload permission checks on each Telegram chunk, plus backend/status checks.
- Unique chunk index per file, duplicate-message cleanup after a uniqueness conflict, and server-confirmed progress.
- Pause/resume waits for the old worker pool to drain; resume fetches recorded indexes.
- Atomic conditional transition into fallback cleanup; transactional version creation and quota counter changes.
- Explicit upload states, logs for chunk timing and failure, and file hash checks in relevant upload paths.

**Needed before claiming protection against very high concurrent load or every race:**

1. Add **server-side global and per-user admission control** (queue/semaphore plus rate limits). Bound active uploads, active chunks, and total in-flight bytes; return `429`/`503` with `Retry-After` before accepting more body work. Client limits alone do not protect the service.
2. Make chunk writes **idempotent and state-fenced**. Atomically claim `(fileId, chunkIndex)` before or immediately after upload, use an upload generation/token, and re-check the generation/state before committing the Telegram message. A fallback/cancel state change must make all earlier-generation chunk requests unable to commit. Use a durable cleanup queue for remote messages created but not committed.
3. Make cancel/fallback/complete **one compare-and-set state machine**: `uploading → cancelling|fallback_cleanup|completing → terminal`. Only the operation that wins the conditional update performs side effects. Reject/ignore late requests based on that state and generation. Make completion retry-safe via an idempotency key and unique finalization record.
4. Reserve quota atomically at init (or atomically check `used + reserved + size <= limit`), release the reservation on cancel/failure, and convert reservation to used quota once on completion. Add a unique rule or idempotent init key for simultaneous same-hash uploads.
5. Add S3 multipart abort/expiry cleanup and a scheduled reconciler for stale pending files, orphan Telegram messages, DB chunk records, and quota reservations. Configure and verify an S3 lifecycle rule for abandoned multipart uploads.
6. Set upload body-size limits, request timeouts, per-user file/byte limits, and queue depth. Monitor active chunks, queue wait, bytes in flight, provider 429s, retry attempts, fallback rate, Mongo pool wait, memory, stale pending age, orphan cleanup, and quota discrepancies. Alert and shed load before the database or provider is saturated.
7. Make fallback preserve the encryption guarantee: either support client-side encrypted bytes in S3 with the needed manifest/download/decrypt path, or stop and ask the user before a plaintext fallback. Never silently downgrade a DEK-encrypted file.
8. Load-test mixed workloads: many users × multiple files, provider 429/timeouts, process restart, cancel/fallback/complete racing, duplicated requests, and DB/S3 outages. Measure the safe operating limit and tune worker counts from those results. No capacity number can be inferred from a per-browser worker count.

**Use this wording in the talk:** “We bound concurrency per file and have retries, resume, and backend fallback. Those measures make an individual upload more resilient. They do not yet cap aggregate server load, and code review shows narrow cancel/fallback races plus a quota-reservation gap. The next step is server-side admission control and an idempotent, generation-fenced upload state machine. We also need to preserve client-side encryption during fallback; today that fallback resets the mode to plaintext, so it is not transparent for encrypted files.”

**Transition:** “Once bytes can arrive in pieces and be retried, the data model has to make those pieces unambiguous.”

**Diagram:** `pending → uploading → uploaded`, with failure path `paused → cleanup → S3 pending → uploaded`.

### 13:00–17:00 — Data model, versions, and sharing

> A File is the stable logical object. FileVersion stores a content snapshot and version number. TelegramChunk records one stored piece and associates it with a file and version. The file has a current-version pointer.
>
> Restoring a version can update that pointer instead of copying all the bytes again. The user gets a restore operation while the content remains addressable through its version record.
>
> Sharing is checked at access time. A link token maps to a permission record with an expiry and revocation state. The server validates the token, checks that the requested file still belongs to the shared folder, then routes the download. This allows revocation and folder membership changes to take effect without depending on a long-lived storage URL embedded in the link.
>
> The main modeling choice is to separate identity and authorization from storage location. Permissions can apply whether bytes live in S3 or Telegram, and storage mechanics can change without rewriting folder and sharing behavior.

**Show/draw:** `File → FileVersion → TelegramChunk`, and `ShareLink → Folder → Files`.

### 17:00–21:00 — Encryption and authentication

> StoreIt has a client-side encryption mode. The browser encrypts file content using Web Crypto before upload, so the server stores ciphertext rather than the plaintext data key. AES-GCM provides confidentiality and an integrity check; each chunk uses a fresh 12-byte nonce. A recovery code derives a wrapping key with PBKDF2 and protects the account data-encryption key. The usable key can be cached locally in IndexedDB.
>
> The central tradeoff is an account-wide data key. It simplifies use across files and device recovery, but compromise of that key can expose all files encrypted under it. Per-file keys could limit the blast radius, but make key management and recovery more complex. I describe this as a tradeoff rather than perfect security.
>
> A separate issue came from two identity layers: the OAuth/session library and the app’s own API tokens. A background effect used to exchange one for the other whenever the upstream session looked authenticated. That treated “a session exists” as the same as “the user just chose to sign in as this account.” Cookies are shared across tabs, so a stale identity could be bridged while opening an unrelated share page.
>
> The correction was to make session exchange a direct continuation of an explicit login action. Redirect-based login uses a one-time marker that is consumed on return, and public share pages don’t need authenticated bootstrap. The broader principle is that minting credentials needs clear provenance; observing background state is not enough.

### 21:00–24:00 — Tradeoffs and next steps

> Four decisions stand out. A storage adapter and stable file model contain backend differences. Bounded concurrency improves throughput without unbounded resource use. Explicit upload states make retry and fallback behavior understandable. Security-sensitive state changes follow user intent instead of ambient session state.
>
> Each has a cost. The adapter does not erase provider differences. The upload state machine is more involved than a one-shot request. An account-wide encryption key simplifies recovery but increases the impact of compromise. Separate public and authenticated layouts would provide a stronger structural boundary than a runtime check.
>
> If I continued, I’d measure provider latency separately from database work, exercise resume and fallback under failures, and bind file and chunk identity into authenticated encryption metadata. Those steps target known limits rather than adding architecture for its own sake.

### 24:00–25:00 — Close

> StoreIt taught me to treat file management as connected reliability and trust problems, not just upload UI. The strongest design decisions came from following data across boundaries: where bytes live, how metadata points to them, how failures recover, and what evidence is needed before changing identity or decrypting content. Thanks—I’m happy to go deeper on uploads, the data model, or security.

## Q&A preparation

**Why six upload workers?** It matches the existing resume worker count and overlaps independent requests. It is per-file, not a global cap. I’d tune it with throughput, failure rate, provider limits, and memory measurements, then add server-side admission control for aggregate load.

**What if the browser closes mid-upload?** Successfully recorded chunks remain associated with the pending upload. Resume asks the server for missing indexes and sends those. The flow depends on the pending file record and chunk metadata staying consistent.

**Why Telegram and S3?** The project supports distinct storage backends behind one application model, with S3 available as fallback. The adapter helps, but doesn’t make provider limits, cost, or operational ownership identical.

**Is it fully zero-knowledge?** In client-side encrypted mode, the server does not receive the plaintext data key through the normal application path. Metadata remains visible, the account key has a broad blast radius, and chunk identity should be bound as authenticated data. Qualify the claim accordingly.

**What would you redesign?** Separate public and authenticated route layouts so public sharing cannot mount authenticated bootstrap by construction. Continue tightening the encryption envelope and measuring storage latency separately from application latency.

**Hardest lesson?** Measure before optimizing, and trace security decisions to explicit user intent. One investigation located the upload bottleneck; another showed how a convenient background effect could turn stale state into a credential change.

## Delivery checklist

- Keep the architecture diagram to five boxes: browser, Next.js, MongoDB, Telegram, and S3. Add Web Crypto only for encryption.
- Have one UI path ready: upload → file list → version or share.
- Use the state diagram if a live upload demo is unreliable.
- Say “client-side encrypted mode”; don’t imply every file is encrypted.
- Present 23–24 seconds as a measured observation, not a provider guarantee.
- Reserve the last five minutes for questions. If behind schedule, skip secondary feature details.
