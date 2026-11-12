# StoreIt database ER diagram

This diagram documents the active Mongoose models in `adapters/database/models`.
Solid relationship labels describe the application's logical relationships;
some older schemas store IDs without Mongoose `ref` metadata.

```mermaid
erDiagram
    USER {
        ObjectId _id PK
        string email UK
        string provider
        number storageused
        number storagelimit
        date encryptionSetupAt
    }

    FOLDER {
        ObjectId _id PK
        string owner_id FK
        string parent_id FK
        ObjectId[] ancestors
        string createdBy FK
        boolean deleted
    }

    FILE {
        ObjectId _id PK
        ObjectId owner_id FK
        ObjectId folderId FK
        ObjectId currentVersionId FK
        string backend
        string encryptionMode
        string status
        boolean deleted
    }

    FILE_VERSION {
        ObjectId _id PK
        ObjectId file_id FK
        ObjectId createdBy FK
        number version
        string backend
        string status
    }

    TELEGRAM_CHUNK {
        ObjectId _id PK
        ObjectId fileId FK
        ObjectId versionId FK
        number chunkIndex
        string telegramFileId
    }

    ENCRYPTION_KEY {
        ObjectId _id PK
        ObjectId fileId FK
        string algorithm
    }

    FOLDER_PERMISSION {
        ObjectId _id PK
        ObjectId folderId FK
        ObjectId principalId FK
        ObjectId grantedBy FK
        string role
        string state
    }

    SHARE_LINK {
        ObjectId _id PK
        ObjectId folderId FK
        ObjectId createdBy FK
        string tokenHash UK
        string role
        date expiresAt
    }

    FILE_SHARE {
        ObjectId _id PK
        string fileId FK
        string owner_id FK
        string shareToken UK
        date expiresAt
    }

    PERMISSION {
        ObjectId _id PK
        ObjectId sharedwith FK
        ObjectId resource_id FK
        string resource_type
        string permission
    }

    REFRESH_TOKEN {
        ObjectId _id PK
        ObjectId userId FK
        string familyId
        string tokenHash
        date expiresAt
    }

    IDEMPOTENCY_KEY {
        ObjectId _id PK
        string scope
        string key
        string status
    }

    USER ||--o{ FILE : owns
    USER ||--o{ FOLDER : owns
    USER ||--o{ FILE_VERSION : creates
    USER ||--o{ REFRESH_TOKEN : has
    USER ||--o{ FOLDER_PERMISSION : receives
    USER ||--o{ FOLDER_PERMISSION : grants
    USER ||--o{ SHARE_LINK : creates
    USER ||--o{ FILE_SHARE : owns
    USER ||--o{ PERMISSION : receives

    FOLDER o|--o{ FOLDER : parent_of
    FOLDER o|--o{ FILE : contains
    FOLDER ||--o{ FOLDER_PERMISSION : has
    FOLDER ||--o{ SHARE_LINK : exposes

    FILE ||--o{ FILE_VERSION : versions
    FILE ||--o{ TELEGRAM_CHUNK : chunks
    FILE ||--o| ENCRYPTION_KEY : server_key
    FILE_VERSION o|--o{ TELEGRAM_CHUNK : groups
    FILE o|--o| FILE_VERSION : current_version

    FILE o|--o{ FILE_SHARE : public_link
    FILE o|--o{ PERMISSION : direct_grant
    FOLDER o|--o{ PERMISSION : legacy_direct_grant
```

Notes:

- `IdempotencyKey` is intentionally standalone; it protects retry-safe operations.
- `Permission.resource_id` is polymorphic (`file` or `folder`). Current folder sharing uses `FolderPermission` and `ShareLink`; `Permission` remains for direct file grants and legacy folder grants.
- `File.currentVersionId`, `Folder.owner_id`, `Folder.parent_id`, `FolderPermission.folderId`, and `ShareLink.folderId` are application-level references even where the schema does not declare `ref`.
