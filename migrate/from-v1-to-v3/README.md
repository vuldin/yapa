# OCPA → YAPA Migration (v1 → v3)

Migrates memories and tasks from OCPA's per-folder SQLite databases (`claudeclaw.db`) into YAPA's ChromaDB backend with 384-dimension embeddings.

## Background

OCPA (formerly claudeclaw) was the predecessor to YAPA. It stored memories and tasks in individual SQLite databases within each customer/project subfolder. YAPA v3 replaces this with a centralized ChromaDB vector store using 384-dimension embeddings (ChromaDB's built-in all-MiniLM-L6-v2 model), enabling semantic search across all data without external API dependencies.

## Prerequisites

- ChromaDB running at `localhost:8000`
- Python 3.10+
- `chromadb` Python package (uses ChromaDB's built-in ONNX embedding model, 384 dimensions)

## Usage

From the projects directory:

```bash
uv run --with chromadb python3 .yapa/migrate/ocpa_to_yapa.py
```

Or with pip:

```bash
pip install chromadb
python3 .yapa/migrate/ocpa_to_yapa.py
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OCPA_BASE_DIR` | Parent of `.yapa/` | Directory containing customer subfolders |
| `CHROMA_HOST` | `localhost` | ChromaDB host |
| `CHROMA_PORT` | `8000` | ChromaDB port |
| `YAPA_USERNAME` | `user` | Username prefix for document IDs |

## Collection Mapping

| OCPA Source | YAPA Collection |
|-------------|-----------------|
| `{customer}/claudeclaw.db` | `customer-{customer}` |
| `global/claudeclaw.db` | `global` |
| `claudeclaw/store/global.db` | `global` (merged) |

## Field Mapping

### Memories

| OCPA (SQLite) | YAPA (ChromaDB) |
|---------------|-----------------|
| `content` | document content |
| `salience` | `metadata.salience` (preserved as-is) |
| `sector` | `metadata.sector` |
| `topic_key` | `metadata.tags` |
| `created_at` | `metadata.created_at` |
| `accessed_at` | `metadata.accessed_at` |

### Tasks

| OCPA (SQLite) | YAPA (ChromaDB) |
|---------------|-----------------|
| `title` | document content + `metadata.title` |
| `status` | `metadata.status` (pending/in_progress/blocked/complete) |
| `priority` | `metadata.priority` (critical/high/medium/low) |
| `description` + `notes` | `metadata.notes` (concatenated) |
| subfolder name | `metadata.customer` |

## Notes

- The script is idempotent — running it again will upsert (not duplicate) documents since IDs include timestamps and random suffixes.
- Embeddings are generated client-side by the `chromadb` Python package using ONNX MiniLM-L6-v2 (384 dimensions), matching YAPA v3's default embedding model.
- Task IDs are sequential (`{username}-{n}`) and start from 1. If YAPA already has tasks, you may get ID collisions — run against a clean ChromaDB instance.
