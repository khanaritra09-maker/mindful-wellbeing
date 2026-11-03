# Mindful FastAPI backend

This backend now provides registration, session authentication, and the admin voice-dataset UI endpoints. The wellbeing check-in, journal, and activity screens still store their records in account-scoped browser storage and do not yet sync them to the API. Existing browser records and legacy IndexedDB voice samples are not silently imported or reassigned to an account.

## Database architecture and schema

FastAPI uses SQLAlchemy models and Alembic migrations. PostgreSQL with the `psycopg` driver is the recommended production database. SQLite remains available for local development. The schema contains:

| Table | Purpose |
| --- | --- |
| `users` | Login email, Argon2 password hash, role, active state, token version, timestamps |
| `user_profiles` | Minimal display name and timestamps, one-to-one with a user |
| `mood_checkins` | Owner-scoped mood, intensity, optional reflection, timestamps |
| `journal_entries` | Owner-scoped writing, tags, date, optional check-in link |
| `wellness_activity_records` | Owner-scoped completion history |
| `voice_samples` | Dataset label, consent metadata, private file key, digest and audit actor references |
| `dataset_metadata` | Dataset name/revision, class counts, consent policy version and creator |
| `model_versions`, `model_evaluations` | Recorded model registry and evaluation metadata |
| `audit_events` | Admin actions and actor, with no journal/check-in text in audit details |

Tables use UUID-format primary keys, foreign keys, timestamp columns, input checks, uniqueness constraints, and indexes for owner/date, dataset, label, and audit-history queries. Private user routes filter by the authenticated user ID; admin routes check the database role on the server. Profiles do not duplicate email or authentication data. Passwords are never stored in raw form.

Passwords use Argon2 hashes. Browser sessions use short-lived signed tokens in HttpOnly, SameSite=Lax cookies; the token is never returned to frontend JavaScript or stored in localStorage. State-changing requests require a CSRF token plus an allowed request origin. Logout increments the user's token version to revoke the session. Cookie `Secure` is automatic in staging/production (override with `COOKIE_SECURE` only when necessary). User-owned data queries always include the authenticated user ID. Admin routes check the database role on the server. Audio is stored under a private filesystem directory with generated names; the API has no public static audio mount. Dataset metadata is stored separately. Admin operations create audit events.

## Local setup

From the repository root, copy `backend/.env.example` to `backend/.env`. Generate a unique secret and put it in `MINDFUL_SECRET_KEY` (for example, use Python's `secrets.token_urlsafe(48)`). Set `FRONTEND_ORIGINS` to the exact origin serving the frontend, including scheme and port. Do not commit `.env`.

For a production PostgreSQL deployment, provision a database and a least-privilege database user outside the application, then set `DATABASE_URL` to a secret-managed URL such as `postgresql+psycopg://mindful_app:<URL-ENCODED-PASSWORD>@db-host:5432/mindful`. Do not use a database superuser for the app.

```powershell
py -m venv backend/.venv
backend/.venv/Scripts/Activate.ps1
pip install -r backend/requirements.txt
$env:PYTHONPATH = "backend"
alembic -c backend/alembic.ini upgrade head
python -m app.cli create-admin --email admin@example.com
uvicorn app.main:app --app-dir backend --reload --port 8001
```

The migration command creates the schema. For local development, the example configuration uses `backend/data/mindful.db`; switch to the PostgreSQL URL above for production. Run `alembic -c backend/alembic.ini current` to inspect the applied migration and `alembic -c backend/alembic.ini upgrade head` after deploying each release. Create new revisions from the backend directory with `alembic revision --autogenerate -m "describe schema change"`, review the generated file, and commit it. Never edit a migration already applied in a shared environment.

The first administrator password is prompted interactively and is never stored in source or shell history. Public registration always creates a `user`; there is no client-controlled role field. Local API docs are available at `http://127.0.0.1:8001/docs`. Configure the `mindful-api-base` meta tag in `index.html` for the API origin. When it is blank, the frontend uses port 8001 and the page's hostname. Use the same host spelling for frontend and API in development (for example, `localhost` for both) so browser cookie policies permit the session cookie. The exact frontend origin must also be in `FRONTEND_ORIGINS`.

The optional terminal `jarvis.py` admin recording flow also authenticates against `/auth/login`; set `MINDFUL_API_BASE` if the API is not at its local default. It prompts for an administrator email and password using a hidden password prompt, checks the admin role on the server before each save, and attempts to revoke its session when exiting. It no longer has a built-in admin password.

If using a database created by the earlier pre-Alembic development server, back it up first. That schema corresponds to migration `0001_initial_schema`; record that baseline with `alembic -c backend/alembic.ini stamp 0001_initial_schema`, then run `alembic -c backend/alembic.ini upgrade head` to move profile data into `user_profiles` and add dataset metadata. Do not stamp a fresh database; run `upgrade head` directly.

## Routes

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET/PATCH /api/v1/users/me`
- `POST /api/v1/auth/logout` (authenticated and CSRF-protected; revokes the session)
- Authenticated owner-scoped `GET/POST/PATCH/DELETE /api/v1/check-ins`, `GET /api/v1/mood-history`
- Authenticated owner-scoped `GET/POST/PATCH/DELETE /api/v1/journal-entries`
- Authenticated owner-scoped `GET/POST /api/v1/wellness-activities`
- Owner-only check-in PDF: `GET /api/v1/check-ins/{id}/report.pdf`; reflections are excluded unless `include_reflection=true`
- Admin-only dataset revision listing/creation at `/api/v1/admin/datasets`; voice dataset listing, summary, multipart creation, private preview, confirmed soft-delete, and metadata CSV under `/api/v1/admin/voice-samples`
- Admin-only model registry/evaluations and audit records under `/api/v1/admin`

## Model and voice data notes

The existing Python `jarvis.py` is a terminal assistant and does not currently train, evaluate, or register a deployable model. Consequently the model routes return only actual `model_versions` and `model_evaluations` rows. Metrics remain null/absent when no evaluation record exists. No deployment operation is exposed until the ML architecture has a validated artifact registry and atomic rollback mechanism.

Legacy browser voice samples in IndexedDB are not automatically uploaded. New admin dataset uploads require explicit consent and save confirmation, an accepted audio format, bounded file size, content signature validation, and a unique digest. Consent metadata records the user who confirmed the documented consent, timestamp, and configured text version. Deletion records the actor and time, then removes the private file. Dataset upload is only suitable for samples whose contributor has provided documented authorization; admin privilege alone does not substitute for contributor consent.

## Privacy operations and production deployment

- User email/display name support account access. Mood, intensity and reflection are optional. Journal text/tags, linked check-ins and completed activities are stored in the signed-in user's browser unless the user chooses local save. The API currently stores only records explicitly sent to it (for example admin voice dataset samples). The application does not send journal data to an AI service.
- User voice recording starts only after an explicit recording-consent checkbox and click. Preview audio is local and is not uploaded. Downloading it requires another consent. Admin dataset recording separately requires recording permission before microphone access, then distinct consent to upload/retain and confirmation that the speaker authorized dataset use. Consent scope, policy version, actor and timestamp are stored with metadata.
- Voice files default to `~/.mindful/private_voice_samples`, outside the project tree. Set `VOICE_STORAGE_PATH` to a private mounted volume with OS permissions limited to the API service. Never map this directory to a static web server, CDN or public bucket. Audio is streamed only through an authenticated admin endpoint with no-store headers. Backups containing audio must have equivalent access controls and deletion handling.
- Export: `GET /api/v1/users/me/export` downloads server account records and contributed voice files as a private ZIP. The Settings page separately exports browser-only records to JSON. Delete: `DELETE /api/v1/users/me` requires the current password and confirmation, removes account-owned records and contributed voice files, revokes the session, and preserves de-identified audit events.
- Personal account records are retained until the user deletes the account. Voice dataset records remain until an authorized administrator deletes them or consent is withdrawn; account deletion removes samples contributed by that account. Audit events have a minimum 365-day retention; run `python -m app.cli purge-audit-events` on a scheduled job only after legal review of the applicable retention purpose. Backups need their own documented expiry schedule.
- Login, registration, export, account deletion and audio upload are rate-limited. Development uses in-process limits. Production configuration rejects in-memory rate-limit storage and requires Redis shared across API instances.

### Production HTTPS deployment

Copy `.env.example` into a deployment secret manager (do not commit `.env`). Generate `MINDFUL_SECRET_KEY` using a cryptographic random generator. Set `APP_ENV=production`, a PostgreSQL URL with `sslmode=verify-full`, exact HTTPS `FRONTEND_ORIGINS`, `ALLOWED_HOSTS`, `VOICE_STORAGE_PATH` outside the web root, and a `RATE_LIMIT_STORAGE_URI=rediss://...` with Redis authentication/TLS. The production settings validator rejects SQLite, unverified database TLS, insecure cookies, localhost CORS origins, non-TLS Redis, and memory rate limiting.

Terminate TLS at a maintained reverse proxy/load balancer with HTTP-to-HTTPS redirection and certificate renewal. Configure it to overwrite `X-Forwarded-Proto` and forward only to the API. Run Uvicorn with proxy headers enabled only for the known proxy address, for example `uvicorn app.main:app --proxy-headers --forwarded-allow-ips=127.0.0.1`; do not trust forwarded headers from arbitrary clients. The app enforces HTTPS redirects, Secure cookies, host allowlisting, HSTS on HTTPS responses and baseline content/referrer/frame headers. Keep `/docs` and `/openapi.json` private or disable them in public production if they are not needed.

### Required human review before launch

As of 31 October 2026, the official commencement notification phases DPDP Act section 6(9) and section 27(1)(d) one year after publication in mid-November 2025, and sections 3–5, 6(1)–(8), 6(10), 7–17 and related provisions eighteen months after publication (mid-May 2027). The Rules phase Rule 4 after one year and Rules 3, 5–16, 22 and 23 after eighteen months. Counsel should verify the Gazette publication date and any later amendments/corrigenda before launch; these dates are not a legal opinion.

Have Indian privacy counsel determine which provisions apply to Mindful and when, and review the standalone privacy notice, lawful basis and consent/withdrawal flow, grievance contact, breach response, child-user handling, processor/vendor contracts, cross-border processing, backup expiry, voice-dataset use, and how account deletion interacts with audit/security log retention. Rule 6 includes safeguards such as access controls, logs, backups and processor contract terms; Rule 7 addresses breach intimation; Rule 8 includes purpose-based erasure and a minimum one-year retention rule for specified processing/logs. The account deletion workflow therefore needs counsel to define any narrow legally required retention exceptions and deletion schedule before launch. Review whether legacy IT Act/SPDI requirements apply during transition. The Settings text is a product disclosure draft, not a legal notice; no privacy contact is configured in the app yet. Assign an accountable privacy/security owner and operationally exercise restoration, revocation, deletion propagation, and incident response.
