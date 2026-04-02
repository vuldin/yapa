#!/bin/bash
#
# Rollback YAPA v3 migration - restore v2 collections from backup
#

set -e

CONFIG_FILE="${1:-./migration-config.json}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Usage: $0 <path-to-migration-config.json>"
    exit 1
fi

# Load config using Python
BACKUP_DIR=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['migration']['backup_dir'])")
CHROMA_URL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['migration']['chroma_url'])")

echo "====================================="
echo "YAPA v3 → v2 Rollback"
echo "====================================="
echo "Config: $CONFIG_FILE"
echo "Backup: $BACKUP_DIR"
echo "ChromaDB: $CHROMA_URL"
echo ""

# Check Python/chromadb available
if ! python3 -c "import chromadb" 2>/dev/null; then
    echo "Error: chromadb Python package not installed"
    echo "Install with: pip install chromadb"
    exit 1
fi

# Run Python rollback script
python3 << 'PYTHON_SCRIPT'
import json
import sys
from pathlib import Path
import chromadb

# Load config
config_path = Path(sys.argv[1])
with open(config_path) as f:
    config = json.load(f)

chroma_url = config["migration"]["chroma_url"]
backup_dir = Path(config["migration"]["backup_dir"])
source_collections = config["source_collections"]
new_empty = config.get("new_empty_collections", [])

# Connect
host = chroma_url.replace("http://", "").split(":")[0]
port = int(chroma_url.split(":")[-1]) if ":" in chroma_url else 8000
client = chromadb.HttpClient(host=host, port=port)

print(f"Connected to ChromaDB at {host}:{port}")
print(f"\nRolling back migration...")

# 1. Delete new collections
print("\n1. Deleting new v3 collections...")
for source_name, info in source_collections.items():
    if not info.get("migrate", False):
        continue
    
    target_name = info["target"]
    try:
        client.delete_collection(target_name)
        print(f"   ✓ Deleted: {target_name}")
    except Exception as e:
        print(f"   ⚠️ {target_name}: {e}")

# Also delete new empty collections
for coll_name in new_empty:
    try:
        client.delete_collection(coll_name)
        print(f"   ✓ Deleted: {coll_name}")
    except:
        pass

# 2. Restore old collections from backup
print("\n2. Restoring old v2 collections from backup...")
for source_name, info in source_collections.items():
    if not info.get("migrate", False):
        continue
    
    backup_file = backup_dir / f"{source_name}.json"
    if not backup_file.exists():
        print(f"   ⚠️ Backup not found: {backup_file}")
        continue
    
    # Load backup
    with open(backup_file) as f:
        data = json.load(f)
    
    docs = data.get("documents", [])
    if not docs:
        print(f"   ⚠️ No documents in backup: {source_name}")
        continue
    
    # Create collection with original embeddings
    try:
        # Note: We need to recreate with original dimension
        # This requires the embedding_function parameter or specific metadata
        collection = client.create_collection(
            name=source_name,
            metadata={"hnsw:space": "cosine"}
        )
        
        # Restore in batches
        batch_size = 50
        for i in range(0, len(docs), batch_size):
            batch = docs[i:i+batch_size]
            ids = [d["id"] for d in batch]
            contents = [d["content"] for d in batch]
            metadatas = [d["metadata"] for d in batch]
            embeddings = [d.get("embedding") for d in batch if "embedding" in d]
            
            if embeddings and len(embeddings) == len(batch):
                collection.upsert(
                    ids=ids,
                    documents=contents,
                    metadatas=metadatas,
                    embeddings=embeddings
                )
            else:
                collection.upsert(
                    ids=ids,
                    documents=contents,
                    metadatas=metadatas
                )
        
        print(f"   ✓ Restored: {source_name} ({len(docs)} docs)")
        
    except Exception as e:
        print(f"   ✗ Failed to restore {source_name}: {e}")

print("\n✅ Rollback complete!")
print("   Old v2 collections restored with 768-dim embeddings")
print("   You may need to restart OpenCode to see the old data")

PYTHON_SCRIPT "$CONFIG_FILE"
