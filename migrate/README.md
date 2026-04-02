# YAPA Migration Tools

This directory contains migration tools for upgrading between YAPA versions.

## Available Migrations

### from-v1-to-v3: OCPA → YAPA v3

**Use when:** You have OCPA (SQLite-based predecessor) and want to migrate to YAPA v3.

**What it does:**
- Reads SQLite databases (`claudeclaw.db`) from project folders
- Creates ChromaDB collections with 384-dimension embeddings
- Maps each project folder to a `customer-{name}` collection

**Location:** `from-v1-to-v3/`

**Quick start:**
```bash
cd ~/projects/your-project
python3 ~/.local/share/yapa/migrate/from-v1-to-v3/ocpa_to_yapa.py
```

### from-v2-to-v3: Embedding Dimension Fix

**Use when:** You have YAPA v2 collections with 768-dimension embeddings (from Fireworks, OpenAI, etc.) and want to switch to ChromaDB's built-in 384-dimension embeddings.

**What it does:**
- Exports existing v2 collections (with 768-dim embeddings) to JSON backup
- Creates new v3 collections with 384-dim embeddings
- Migrates all documents with preserved metadata and task IDs
- Leaves old collections intact until manually deleted after verification

**Location:** `from-v2-to-v3/`

**Quick start:**
```bash
cd ~/projects/your-project
# 1. Create migration-config.json (see example)
# 2. Export existing data
python3 ~/.local/share/yapa/migrate/from-v2-to-v3/01_export.py --config ./migration-config.json
# 3. Dry-run
python3 ~/.local/share/yapa/migrate/from-v2-to-v3/02_migrate.py --config ./migration-config.json --dry-run
# 4. Execute
python3 ~/.local/share/yapa/migrate/from-v2-to-v3/02_migrate.py --config ./migration-config.json --verify-first
```

## Which Migration Do I Need?

| Current State | Migration |
|---------------|-----------|
| Using OCPA (SQLite databases) | `from-v1-to-v3` |
| Using YAPA v2 with 768-dim embeddings (Fireworks/OpenAI) | `from-v2-to-v3` |
| Using YAPA v3 with 384-dim embeddings (ChromaDB built-in) | No migration needed |

## Troubleshooting

**"Embedding dimension mismatch" error**
→ You're trying to use YAPA v3 tools on v2 collections. Run the `from-v2-to-v3` migration.

**"No module named chromadb"**
→ Install: `pip install chromadb requests`

**"Connection refused"**
→ Make sure ChromaDB is running: `curl http://localhost:8000/api/v2/heartbeat`
