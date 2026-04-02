#!/usr/bin/env python3
"""
Migrate YAPA v2 collections (768-dim) to v3 (384-dim) using ChromaDB's built-in embeddings.

Usage:
    python3 02_migrate.py --config /path/to/migration-config.json [--dry-run] [--verify-first]

Important:
    - Old collections are NOT deleted (user must do this manually after verification)
    - Task IDs are preserved
    - Memory IDs are regenerated in YAPA format
    - Salience scores are preserved
"""

import argparse
import json
import os
import random
import string
import sys
import time
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


def rand6():
    """Generate 6-char random suffix."""
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=6))


def find_max_task_id(documents):
    """Find the highest task ID number from existing documents."""
    max_num = 0
    for doc in documents:
        meta = doc.get("metadata", {})
        if meta.get("type") == "task":
            task_id = meta.get("id", "")
            # Parse task ID format: {username}-{number}
            if "-" in task_id:
                try:
                    num = int(task_id.split("-")[-1])
                    max_num = max(max_num, num)
                except ValueError:
                    pass
    return max_num


def migrate_document(doc, username, task_counter):
    """
    Convert a v2 document to v3 format.
    Returns: (new_id, content, metadata) or None if should skip
    """
    old_id = doc["id"]
    content = doc.get("content", "")
    old_meta = doc.get("metadata", {})
    
    if not content.strip():
        return None
    
    doc_type = old_meta.get("type", "memory")
    now = int(time.time())
    
    if doc_type == "memory":
        # Generate new YAPA memory ID: mem-{username}-{timestamp}-{random6}
        created_at = int(old_meta.get("created_at", now))
        new_id = f"mem-{username}-{created_at}-{rand6()}"
        
        # Convert arrays to comma-separated strings for ChromaDB compatibility
        tags = old_meta.get("tags", [])
        if isinstance(tags, list):
            tags = ",".join(tags) if tags else ""
        
        metadata = {
            "type": "memory",
            "username": username,
            "tags": tags,
            "salience": old_meta.get("salience", 1.0),
            "sector": old_meta.get("sector", "semantic"),
            "created_at": created_at,
            "accessed_at": now,
            "is_synced": False,
        }
        
        # Preserve chunking info if present
        if "chunk_index" in old_meta:
            metadata["chunk_index"] = old_meta["chunk_index"]
            metadata["chunk_total"] = old_meta.get("chunk_total", 1)
            metadata["parent_id"] = old_meta.get("parent_id", new_id)
        
    elif doc_type == "task":
        # Preserve task ID format: {username}-{number}
        task_counter[0] += 1
        current_num = task_counter[0]
        new_id = f"{username}-{current_num}"
        
        # Calculate salience from priority if not preserved
        priority = old_meta.get("priority", "medium")
        priority_salience = {"critical": 3.0, "high": 2.5, "medium": 2.0, "low": 1.5}
        salience = old_meta.get("salience", priority_salience.get(priority, 2.0))
        
        # Convert arrays to comma-separated strings for ChromaDB compatibility
        tags = old_meta.get("tags", [])
        if isinstance(tags, list):
            tags = ",".join(tags) if tags else ""
        
        metadata = {
            "type": "task",
            "id": new_id,
            "username": username,
            "title": content,  # Title stored in content
            "notes": old_meta.get("notes", ""),
            "tags": tags,
            "status": old_meta.get("status", "pending"),
            "priority": priority,
            "created_at": int(old_meta.get("created_at", now)),
            "updated_at": now,
            "accessed_at": now,
            "salience": salience,
            "sector": "semantic",
            "is_synced": False,
        }
        
        # Preserve optional task fields
        for field in ["due_date", "customer", "project", "is_recurring", "recurrence_pattern"]:
            if field in old_meta:
                metadata[field] = old_meta[field]
        
        # Handle arrays - convert to comma-separated strings
        for field in ["depends_on", "blocks"]:
            if field in old_meta:
                val = old_meta[field]
                if isinstance(val, list):
                    metadata[field] = ",".join(val) if val else ""
                else:
                    metadata[field] = val
    
    else:
        # Unknown type, skip
        return None
    
    return (new_id, content, metadata)


def migrate_collection(client, source_name, target_name, backup_file, username, task_counter, batch_size, dry_run=False):
    """Migrate a single collection."""
    print(f"\n📦 Migrating: {source_name} → {target_name}")
    
    # Load backup
    with open(backup_file) as f:
        data = json.load(f)
    
    docs = data.get("documents", [])
    if not docs:
        print(f"  ⚠️ No documents to migrate")
        return 0
    
    print(f"  Loaded {len(docs)} documents from backup")
    
    if dry_run:
        # Count by type
        memories = sum(1 for d in docs if d.get("metadata", {}).get("type") == "memory")
        tasks = sum(1 for d in docs if d.get("metadata", {}).get("type") == "task")
        print(f"  [DRY-RUN] Would migrate {memories} memories, {tasks} tasks")
        return len(docs)
    
    # Create/get target collection (ChromaDB auto-assigns 384-dim)
    collection = client.get_or_create_collection(
        name=target_name,
        metadata={"created": datetime.utcnow().isoformat() + "Z"}
    )
    print(f"  ✓ Target collection ready: {target_name}")
    
    # Migrate in batches
    migrated = 0
    batch = []
    
    for doc in docs:
        result = migrate_document(doc, username, task_counter)
        if result:
            batch.append({
                "id": result[0],
                "content": result[1],
                "metadata": result[2]
            })
            migrated += 1
        
        # Insert when batch is full
        if len(batch) >= batch_size:
            try:
                collection.upsert(
                    ids=[d["id"] for d in batch],
                    documents=[d["content"] for d in batch],
                    metadatas=[d["metadata"] for d in batch]
                )
                print(f"  ✓ Inserted batch of {len(batch)} documents")
            except Exception as e:
                print(f"  ✗ Batch insert failed: {e}")
                raise
            batch = []
    
    # Insert remaining
    if batch:
        try:
            collection.upsert(
                ids=[d["id"] for d in batch],
                documents=[d["content"] for d in batch],
                metadatas=[d["metadata"] for d in batch]
            )
            print(f"  ✓ Inserted final batch of {len(batch)} documents")
        except Exception as e:
            print(f"  ✗ Final batch insert failed: {e}")
            raise
    
    print(f"  ✅ Migrated {migrated} documents")
    return migrated


def verify_migration(client, config):
    """Verify migrated collections have correct document counts."""
    print("\n🔍 Verifying migration...")
    
    source_collections = config["source_collections"]
    total_expected = 0
    total_actual = 0
    
    for source_name, info in source_collections.items():
        if not info.get("migrate", False):
            continue
        
        target_name = info["target"]
        expected_count = info.get("docs_count", 0)
        
        try:
            collection = client.get_collection(target_name)
            actual_count = collection.count()
            total_expected += expected_count
            total_actual += actual_count
            
            status = "✅" if actual_count == expected_count else "⚠️"
            print(f"  {status} {target_name}: {actual_count}/{expected_count} documents")
            
        except Exception as e:
            print(f"  ✗ {target_name}: Error - {e}")
    
    print(f"\n  Total: {total_actual}/{total_expected} documents")
    return total_actual == total_expected


def main():
    parser = argparse.ArgumentParser(description="Migrate YAPA v2→v3")
    parser.add_argument("--config", required=True, help="Path to migration-config.json")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without migrating")
    parser.add_argument("--verify-first", action="store_true", help="Run verification after migration")
    args = parser.parse_args()
    
    config = load_config(args.config)
    chroma_host = config["migration"].get("chroma_url", "http://localhost:8000").replace("http://", "").split(":")[0]
    chroma_port = int(config["migration"].get("chroma_url", "http://localhost:8000").split(":")[-1]) if ":" in config["migration"].get("chroma_url", "") else 8000
    username = config["migration"]["username"]
    backup_dir = Path(config["migration"]["backup_dir"])
    source_collections = config["source_collections"]
    new_empty = config.get("new_empty_collections", [])
    options = config.get("options", {})
    batch_size = options.get("batch_size", 50)
    
    print(f"YAPA v2 → v3 Migration")
    print(f"ChromaDB: {chroma_host}:{chroma_port}")
    print(f"Username: {username}")
    print(f"Backup: {backup_dir}")
    print(f"Dry-run: {args.dry_run}")
    print(f"Verify-first: {args.verify_first}")
    
    # Connect to ChromaDB
    client = chromadb.HttpClient(host=chroma_host, port=chroma_port)
    print(f"\n✓ Connected to ChromaDB")
    
    # Find max task ID from all backups
    task_counter = [0]
    if not args.dry_run:
        for source_name, info in source_collections.items():
            if not info.get("migrate", False):
                continue
            backup_file = backup_dir / f"{source_name}.json"
            if backup_file.exists():
                with open(backup_file) as f:
                    data = json.load(f)
                    docs = data.get("documents", [])
                    max_id = find_max_task_id(docs)
                    task_counter[0] = max(task_counter[0], max_id)
        
        print(f"\n📊 Highest existing task ID: {username}-{task_counter[0]}")
        print(f"   New tasks will start from: {username}-{task_counter[0] + 1}")
    
    # Migrate each collection
    total_migrated = 0
    
    for source_name, info in source_collections.items():
        if not info.get("migrate", False):
            continue
        
        target_name = info["target"]
        backup_file = backup_dir / f"{source_name}.json"
        
        if not backup_file.exists():
            print(f"\n⚠️ Backup file not found: {backup_file}")
            continue
        
        try:
            count = migrate_collection(
                client, source_name, target_name, backup_file,
                username, task_counter, batch_size, args.dry_run
            )
            total_migrated += count
        except Exception as e:
            print(f"\n✗ Migration failed for {source_name}: {e}")
            import traceback
            traceback.print_exc()
            return 1
    
    # Create new empty collections
    if not args.dry_run:
        print(f"\n📦 Creating new empty collections...")
        for coll_name in new_empty:
            try:
                collection = client.get_or_create_collection(
                    name=coll_name,
metadata={"created": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
                )
                print(f"  ✓ Created: {coll_name}")
            except Exception as e:
                print(f"  ✗ Error creating {coll_name}: {e}")
    
    # Verification
    if args.verify_first and not args.dry_run:
        success = verify_migration(client, config)
        if not success:
            print("\n⚠️ Verification found discrepancies!")
            print("   Old collections preserved. Check and retry.")
            return 1
    
    print(f"\n{'='*50}")
    if args.dry_run:
        print(f"[DRY-RUN] Would migrate {total_migrated} documents")
        print(f"Run without --dry-run to execute")
    else:
        print(f"✅ Migration complete!")
        print(f"Total documents migrated: {total_migrated}")
        print(f"New empty collections: {len(new_empty)}")
        print(f"\n⚠️  IMPORTANT: Old collections still exist!")
        print(f"   Verify the migration is working correctly,")
        print(f"   then manually delete old collections when ready.")
        print(f"\n   To delete old collections after verification:")
        print(f"   curl -X DELETE http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/{{name}}")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
