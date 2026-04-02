#!/usr/bin/env python3
"""
Export YAPA v2 collections with 768-dim embeddings for migration to v3 (384-dim).

Usage:
    python3 01_export.py --config /path/to/migration-config.json
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import chromadb


def load_config(config_path):
    """Load and validate migration configuration."""
    with open(config_path) as f:
        config = json.load(f)
    
    # Resolve relative paths
    base_dir = Path(config_path).parent
    backup_dir = Path(config["migration"]["backup_dir"])
    if not backup_dir.is_absolute():
        backup_dir = base_dir / backup_dir
    
    config["migration"]["backup_dir"] = str(backup_dir.resolve())
    return config


def export_collection(client, collection_name, limit=1000):
    """Export all documents from a collection using ChromaDB client."""
    try:
        collection = client.get_collection(collection_name)
    except Exception as e:
        print(f"  ⚠️ Collection '{collection_name}' not found: {e}")
        return []
    
    # Get all documents using get() with no filters
    results = collection.get(
        limit=limit,
        include=["documents", "metadatas", "embeddings"]
    )
    
    documents = []
    ids = results.get("ids", [])
    docs = results.get("documents", [])
    metadatas = results.get("metadatas", [])
    embeddings = results.get("embeddings", [])
    
    for i in range(len(ids)):
        doc = {
            "id": ids[i],
            "content": docs[i] if i < len(docs) else "",
            "metadata": metadatas[i] if i < len(metadatas) else {},
        }
        # Include embedding for rollback capability
        if embeddings is not None and i < len(embeddings) and embeddings[i] is not None:
            doc["embedding"] = embeddings[i].tolist() if hasattr(embeddings[i], 'tolist') else embeddings[i]
            doc["embedding_dim"] = len(embeddings[i])
        
        documents.append(doc)
    
    return documents


def main():
    parser = argparse.ArgumentParser(description="Export YAPA v2 collections")
    parser.add_argument("--config", required=True, help="Path to migration-config.json")
    args = parser.parse_args()
    
    config = load_config(args.config)
    chroma_url = config["migration"]["chroma_url"]
    backup_dir = Path(config["migration"]["backup_dir"])
    source_collections = config["source_collections"]
    
    # Parse ChromaDB URL
    host = chroma_url.replace("http://", "").split(":")[0]
    port = int(chroma_url.split(":")[-1]) if ":" in chroma_url else 8000
    
    # Create backup directory
    backup_dir.mkdir(parents=True, exist_ok=True)
    print(f"Backup directory: {backup_dir}")
    
    # Connect to ChromaDB
    client = chromadb.HttpClient(host=host, port=port)
    print(f"Connected to ChromaDB at {host}:{port}")
    
    # Get all existing collections
    existing_collections = client.list_collections()
    existing_names = {c.name for c in existing_collections}
    print(f"Found {len(existing_collections)} collections in ChromaDB")
    
    # Export each collection in config
    manifest = {
        "exported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "chroma_url": chroma_url,
        "collections": {}
    }
    
    for source_name, info in source_collections.items():
        if not info.get("migrate", False):
            continue
        
        print(f"\n📦 Exporting: {source_name} → {info['target']}")
        
        if source_name not in existing_names:
            print(f"  ⚠️ Collection '{source_name}' not found in ChromaDB")
            manifest["collections"][source_name] = {"status": "not_found", "count": 0}
            continue
        
        try:
            docs = export_collection(client, source_name)
            print(f"  ✓ Exported {len(docs)} documents")
            
            # Check embedding dimension
            if docs and "embedding" in docs[0]:
                dim = docs[0]["embedding_dim"]
                print(f"  📊 Embedding dimension: {dim}")
            
            # Save to JSON
            output_file = backup_dir / f"{source_name}.json"
            with open(output_file, "w") as f:
                json.dump({
                    "source_collection": source_name,
                    "target_collection": info["target"],
                    "document_count": len(docs),
                    "exported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "documents": docs
                }, f, indent=2)
            
            manifest["collections"][source_name] = {
                "status": "exported",
                "count": len(docs),
                "target": info["target"],
                "file": str(output_file)
            }
            
        except Exception as e:
            print(f"  ✗ Error: {e}")
            import traceback
            traceback.print_exc()
            manifest["collections"][source_name] = {"status": "error", "error": str(e)}
    
    # Save manifest
    manifest_file = backup_dir / "manifest.json"
    with open(manifest_file, "w") as f:
        json.dump(manifest, f, indent=2)
    
    print(f"\n✅ Export complete!")
    print(f"Manifest saved to: {manifest_file}")
    exported_count = len([c for c in manifest["collections"].values() if c.get("status") == "exported"])
    print(f"\nTotal collections exported: {exported_count}")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
