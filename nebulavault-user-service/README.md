# Benzene user service

The service stores account profile and quota metadata in PostgreSQL. The
gateway exposes only `/user/bootstrap` and `/user/me`, each with the normal
session filter.

## Internal profile deletion

`DELETE /internal/account-deletion/{authSub}` transactionally records a durable
deletion tombstone and removes the profile whose `auth_sub` is the UUID subject
from the auth service. Bootstrap and deletion serialize on the same PostgreSQL
advisory lock, so a still-valid access token receives `410 Gone` instead of
recreating the profile. Repeating deletion is safe: the service returns `204 No
Content` whether it removed one profile or the profile was already absent. It
requires `X-Benzene-Internal-Secret` and rejects a missing or incorrect value
with `401`.

The shared `BENZENE_INTERNAL_SERVICE_SECRET` is required at startup and must
contain at least 32 UTF-8 bytes. Configure the same value as
`ACCOUNT_DELETION_USER_SERVICE_SECRET` in the auth service. Keep the user
service on a private service network. The gateway has explicit routes only for
`/user/bootstrap` and `/user/me`; it does not route the internal deletion path.

Configure the auth service with all of these values to opt in to the bounded,
non-overlapping profile cleanup scheduler:

```ini
ACCOUNT_DELETION_USER_SERVICE_URL=http://user-service:8082/internal/account-deletion
ACCOUNT_DELETION_USER_SERVICE_SECRET=<same value as BENZENE_INTERNAL_SERVICE_SECRET>
ACCOUNT_DELETION_WORKER_INTERVAL_SECONDS=30
```

If all three settings are absent, the worker remains disabled and deletion
requests stay pending at the existing operator phase. Partial configuration,
weak secrets, invalid intervals, or a non-HTTPS URL in production stop auth
service startup. The scheduler currently handles only `user_profile`; after
that succeeds the next `stored_objects` phase has no handler, so the request
becomes blocked and incomplete. Storage metadata, device bytes, and other
account data are not claimed to have been deleted by this phase.
The tombstone itself remains retained until a later, unimplemented terminal
cleanup can prove that stale access tokens and the auth credential are gone.

In production, terminate TLS on a trusted private service path or configure
the internal service with HTTPS. Do not send the shared secret through the
public gateway or an untrusted network.

## Local setup

Apply `src/main/resources/schema.sql`, copy `.env.example` to the service
environment, set `DB_URL`, and generate a
random 32-byte-or-longer `BENZENE_INTERNAL_SERVICE_SECRET`. Set the same value
and all three worker settings in the auth service only when exercising the
internal deletion phase locally.
