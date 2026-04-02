# v2 → v3 Migration: Embedding Dimension Fix

Fixes YAPA collections created with 768-dimension embeddings (v2, typically using Fireworks/nomic-embed-text-v1) to use ChromaDB's built-in 384-dimension embeddings (v3, all-MiniLM-L6-v2).

## When to Use This Migration

- You were using YAPA v2 with external embedding providers (Fireworks, OpenAI, Voyage)
- You want to switch to ChromaDB's built-in embeddings (zero-config, no API keys)
- You're getting "embedding dimension mismatch" errors (e.g., "expecting embedding with dimension of 768, got 384")
- You want to simplify your setup and remove external API dependencies

## Prerequisites

- ChromaDB running at localhost:8000
- Python 3.10+
- `chromadb` Python package: `pip install chromadb`
- `requests` package: `pip install requests`
- JSON migration configuration file

## Files

| File | Purpose |
|------|---------|
| `01_export.py` | Export all v2 collections with 768-dim embeddings to JSON backup |
| `02_migrate.py` | Create new v3 collections with 384-dim, migrate all documents |
| `03_verify.sh` | Verify migration succeeded |
| `rollback.sh` | Restore v2 collections from backup if something goes wrong |
| `migration-config.example.json` | Example configuration file |

## Usage

### 1. Create Migration Config

Copy `migration-config.example.json` to your project and customize:

```bash
cp migration-config.example.json ~/projects/your-project/.yapa/migration-config.json
# Edit the file to match your collection names
```

### 2. Export Existing Data

Preserves your 768-dim embeddings for rollback:

```bash
cd ~/projects/your-project
python3 ~/.local/share/yapa/migrate/from-v2-to-v3/01_export.py \
  --config .yapa/migration-config.json
```

Output goes to `./backup/YYYY-MM-DD-HHMMSS/`

### 3. Dry-Run Migration

See what would be migrated without making changes:

```bash
python3 ~/.local/share/yapa/migrate/from-v2-to-v3/02_migrate.py \
  --config .yapa/migration-config.json \
  --dry-run
```

### 4. Execute Migration

```bash
python3 ~/.local/share/yapa/migrate/from-v2-to-v3/02_migrate.py \
  --config .yapa/migration-config.json \
  --verify-first
```

This will:
- Create new collections with 384-dim embeddings
- Migrate all documents with preserved metadata
- Verify document counts match
- **NOT delete old collections** (user must do this after verification)

### 5. Verify

```bash
bash ~/.local/share/yapa/migrate/from-v2-to-v3/03_verify.sh
```

### 6. Test YAPA

Start OpenCode and verify:
- `yapa_collection_list` shows new collections
- `yapa_memory_recall` works without embedding errors
- You can create new memories/tasks

### 7. Delete Old Collections (After Verification)

**Only after you confirm everything works:**

```bash
# List old collections to delete
curl http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections

# Delete each old collection (use actual names from your setup)
curl -X DELETE http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/global
curl -X DELETE http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/cli
# ... etc for each old collection
```

## Rollback

If something goes wrong, restore from backup:

```bash
bash ~/.local/share/yapa/migrate/from-v2-to-v3/rollback.sh \
  .yapa/migration-config.json
```

This will:
- Delete new v3 collections
- Restore old v2 collections with original 768-dim embeddings

## Key Behaviors

| Aspect | Behavior |
|--------|----------|
| Memory IDs | Regenerated in YAPA format (`mem-{username}-{timestamp}-{random}`) |
| Task IDs | **Preserved exactly** (`{username}-{number}`) |
| Salience scores | **Preserved exactly** |
| Collection names | Configurable mapping (e.g., `global` → `drasil`) |
| Empty collections | Created as specified in config |
| Old collections | **Never deleted automatically** - manual step after verification |
| Task numbering | Continues from `max(existing task IDs) + 1` |

## Troubleshooting

**"ImportError: No module named chromadb"**
→ Install: `pip install chromadb requests`

**"Connection refused"**
→ Make sure ChromaDB is running: `curl http://localhost:8000/api/v2/heartbeat`

**"Embedding dimension mismatch" during verification**
→ Old collections still exist and ChromaDB is confused. Temporarily rename them or restart ChromaDB.

**Document count mismatch after migration**
→ Check `backup/manifest.json` for expected counts. If discrepancy is small, may be empty documents that were skipped.
