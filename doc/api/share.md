# Share Endpoints

Share endpoints allow sharing files with other users.

## POST `/share` (auth required)

### Description

The `/share` endpoint shares 1 or more filesystem items
with one or more recipients. The recipients will receive
some notification about the shared item, making this
different from calling `/grant-user-user` with a permission.

When users are **specified by email** they will receive
a [share link](./concepts/share-link.md).

### Example

```json
{
    "recipients": [
        "user_that_gets_shared_to",
        "another@example.com"
    ],
    "shares": [
        {
            "$": "app-share",
            "name": "some-app-name"
        },
        {
            "$": "app-share",
            "uid": "app-SOME-APP-UID"
        },
        {
            "$": "fs-share",
            "path": "/some/file/or/directory"
        },
        {
            "$": "fs-share",
            "path": "SOME-FILE-UUID"
        }
    ]
}
```

### Parameters

- **recipients** _- required_
  - **accepts:** `string | Array<string>`
  - **description:**
    recipients for the filesystem entries being shared.
  - **notes:**
    - validation on `string`: email or username
    - requirement of at least one value
- **shares:** _- required_
  - **accepts:** `object | Array<object>`
    - object is [type-tagged](./type-tagged.md)
    - type is either [file-share](./types/file-share.md)
      or [app-share](./types/app-share.md)
  - **notes:**
    - requirement that file/directory or app exists
    - requirement of at least one entry
- **dry_run:** _- optional_
  - **accepts:** `bool`
  - **description:**
    when true, only validation will occur
    
### Response

- **$:** `api:share`
- **$version:** `v0.0.0`
- **status:** one of: `"success"`, `"mixed"`, `"aborted"`
- **recipients:** array of: `api:status-report` or
  `heyputer:api/APIError`
- **paths:** array of: `api:status-report` or
  `heyputer:api/APIError`
- **dry_run:** `true` if present

### Request Example

```javascript
await fetch("http://puter.localhost:4100/share", {
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${puter.authToken}`,
  },
  body: JSON.stringify({
    recipients: [
        "user_that_gets_shared_to",
        "another@example.com"
    ],
    shares: [
        {
            $: "app-share",
            name: "some-app-name"
        },
        {
            $: "app-share",
            uid: "app-SOME-APP-UID"
        },
        {
            $: "fs-share",
            path: "/some/file/or/directory"
        },
        {
            $: "fs-share",
            path: "SOME-FILE-UUID"
        }
    ]
  }),
  method: "POST",
});
```

### Success Response

```json
{
    "$": "api:share",
    "$version": "v0.0.0",
    "status": "success",
    "recipients": [
        {
            "$": "api:status-report",
            "status": "success"
        }
    ],
    "paths": [
        {
            "$": "api:status-report",
            "status": "success"
        }
    ],
    "dry_run": true
}
```

### Error response (missing file)

```json
{
    "$": "api:share",
    "$version": "v0.0.0",
    "status": "mixed",
    "recipients": [
        {
            "$": "api:status-report",
            "status": "success"
        }
    ],
    "paths": [
        {
            "$": "heyputer:api/APIError",
            "code": "subject_does_not_exist",
            "message": "File or directory not found.",
            "status": 404
        }
    ],
    "dry_run": true
}
```

### Error response (missing user)

```json
{
    "$": "api:share",
    "$version": "v0.0.0",
    "status": "mixed",
    "recipients": [
        {
            "$": "heyputer:api/APIError",
            "code": "user_does_not_exist",
            "message": "The user `non_existing_user` does not exist.",
            "username": "non_existing_user",
            "status": 422
        }
    ],
    "paths": [
        {
            "$": "api:status-report",
            "status": "success"
        }
    ],
    "dry_run": true
}
```

## POST `/sharelink/check` (no auth)

### Description

The `/sharelink/check` endpoint verifies that a token provided
by a share link is valid.

### Example

```javascript
await fetch(`${config.api_origin}/sharelink/check`, {
  "headers": {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${puter.authToken}`,
  },
  "body": JSON.stringify({
      token: '...',
  }),
  "method": "POST",
});
```

### Parameters

- **token:** _- required_
  - **accepts:** `string`
    The token from the querystring parameter

### Response

A type-tagged object, either of type `api:share` or `api:error`

### Success Response

```json
{
    "$": "api:share",
    "uid": "836671d4-ac5d-4bd3-bc0a-ec357e0d8f02",
    "email": "asdf@example.com"
}
```

### Error Response

```json
{
    "$": "api:error",
    "message":"Field `token` is required.",
    "key":"token",
    "code":"field_missing"
}
```

## POST `/sharelink/apply` (no auth)

### Description

The `/sharelink/apply` endpoint applies a share to the current
user **if and only if** that user's email is confirmed and matches
the email associated with the share.

### Example

```javascript
await fetch(`${config.api_origin}/sharelink/apply`, {
  "headers": {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${puter.authToken}`,
  },
  "body": JSON.stringify({
      uid: '836671d4-ac5d-4bd3-bc0a-ec357e0d8f02',
  }),
  "method": "POST",
});
```

### Parameters

- **uid:** _- required_
  - **accepts:** `string`
    The uid of an existing share, received using `/sharelink/check`

### Response

A type-tagged object, either of type `api:status-report` or `api:error`

### Success Response

```json
{"$":"api:status-report","status":"success"}
```

### Error Response

```json
{
    "message": "This share can not be applied to this user.",
    "code": "can_not_apply_to_this_user"
}
```
