#!/usr/bin/env python3
"""Migrate OCPA (claudeclaw) SQLite data to YAPA/ChromaDB.

OCPA stored memories and tasks in per-folder SQLite databases (claudeclaw.db).
This script reads all of them and inserts into YAPA's ChromaDB backend, mapping
each subfolder to a customer-{name} collection.

Prerequisites:
  - ChromaDB running at localhost:8000
  - Run with: uv run --with chromadb python3 ocpa_to_yapa.py

Usage:
  Set BASE_DIR to the parent directory containing customer subfolders.
  Set GLOBAL_DB to the path of the global claudeclaw store DB (if any).
  Adjust USERNAME to match your YAPA_USERNAME.
"""

import os
import random
import sqlite3
import string
import time

import chromadb

# --- Configuration ---
BASE_DIR = os.environ.get("OCPA_BASE_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/..")
GLOBAL_DB = os.path.join(BASE_DIR, "claudeclaw", "store", "global.db")
CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))
USERNAME = os.environ.get("YAPA_USERNAME", "user")
SKIP_DIRS = {"claudeclaw", ".yapa", ".vs", ".git", "__pycache__", "node_modules"}

PRIORITY_SALIENCE = {"critical": 3.0, "high": 2.5, "medium": 2.0, "low": 1.5}

task_counter = 0


def rand6():
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=6))


def parse_date(s):
    if not s:
        return int(time.time())
    try:
        return int(time.mktime(time.strptime(s, "%Y-%m-%d")))
    except (ValueError, TypeError):
        return int(time.time())


def read_db(path):
    """Read memories and tasks from an OCPA claudeclaw.db file."""
    if not os.path.exists(path):
        return [], []
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    memories, tasks = [], []
    try:
        for row in conn.execute("SELECT * FROM memories"):
            memories.append(dict(row))
    except sqlite3.OperationalError:
        pass
    try:
        for row in conn.execute("SELECT * FROM tasks"):
            tasks.append(dict(row))
    except sqlite3.OperationalError:
        pass
    conn.close()
    return memories, tasks


def next_task_id():
    global task_counter
    task_counter += 1
    return f"{USERNAME}-{task_counter}"


def build_memory_doc(mem):
    """Convert an OCPA memory row to a ChromaDB document."""
    content = mem.get("content", "") or ""
    if not content.strip():
        return None

    salience = float(mem.get("salience", 1.0) or 1.0)
    sector = mem.get("sector", "semantic") or "semantic"
    created_at = int(mem.get("created_at", 0) or 0)
    accessed_at = int(mem.get("accessed_at", 0) or 0)
    topic_key = mem.get("topic_key", "") or ""

    now = int(time.time())
    if created_at == 0:
        created_at = now
    if accessed_at == 0:
        accessed_at = created_at

    doc_id = f"mem-{USERNAME}-{created_at}-{rand6()}"
    metadata = {
        "type": "memory",
        "username": USERNAME,
        "tags": topic_key,
        "salience": salience,
        "sector": sector,
        "created_at": created_at,
        "accessed_at": accessed_at,
    }

    return {"id": doc_id, "content": content, "metadata": metadata}


def build_task_doc(task, customer):
    """Convert an OCPA task row to a ChromaDB document."""
    title = task.get("title", "") or ""
    if not title.strip():
        return None

    status = task.get("status", "pending") or "pending"
    priority = task.get("priority", "medium") or "medium"
    description = task.get("description", "") or ""
    notes = task.get("notes", "") or ""
    combined_notes = "\n".join(filter(None, [description, notes]))

    now = int(time.time())
    created_at = parse_date(task.get("created_at", ""))
    updated_at = parse_date(task.get("updated_at", ""))

    task_id = next_task_id()
    salience = PRIORITY_SALIENCE.get(priority, 2.0)

    metadata = {
        "type": "task",
        "id": task_id,
        "username": USERNAME,
        "title": title,
        "notes": combined_notes,
        "tags": "",
        "status": status,
        "priority": priority,
        "depends_on": "",
        "blocks": "",
        "is_recurring": False,
        "created_at": created_at,
        "updated_at": updated_at,
        "accessed_at": now,
        "salience": salience,
        "sector": "semantic",
    }

    if customer and customer != "global":
        metadata["customer"] = customer

    return {"id": task_id, "content": title, "metadata": metadata}


def main():
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    print(f"Connected to ChromaDB at {CHROMA_HOST}:{CHROMA_PORT}")

    # Collect sources from subdirectories
    sources = {}
    for entry in sorted(os.listdir(BASE_DIR)):
        full = os.path.join(BASE_DIR, entry)
        if not os.path.isdir(full) or entry.startswith(".") or entry in SKIP_DIRS:
            continue
        db_path = os.path.join(full, "claudeclaw.db")
        memories, tasks = read_db(db_path)
        if not memories and not tasks:
            continue
        coll_name = "global" if entry == "global" else f"customer-{entry}"
        sources[coll_name] = {"memories": memories, "tasks": tasks, "customer": entry}

    # Add global DB memories (separate store used by OCPA)
    if os.path.exists(GLOBAL_DB):
        conn = sqlite3.connect(GLOBAL_DB)
        conn.row_factory = sqlite3.Row
        global_mems = []
        try:
            for row in conn.execute("SELECT * FROM memories"):
                global_mems.append(dict(row))
        except sqlite3.OperationalError:
            pass
        conn.close()
        if "global" not in sources:
            sources["global"] = {"memories": [], "tasks": [], "customer": "global"}
        sources["global"]["memories"].extend(global_mems)

    total_mem = 0
    total_task = 0

    for coll_name in sorted(sources.keys()):
        data = sources[coll_name]
        customer = data["customer"]

        print(f"\n--- {coll_name} ---")

        collection = client.get_or_create_collection(
            name=coll_name,
            metadata={"created": time.strftime("%Y-%m-%dT%H:%M:%SZ")},
        )

        # Migrate memories
        mem_docs = [d for m in data["memories"] if (d := build_memory_doc(m)) is not None]
        if mem_docs:
            batch_size = 50
            for i in range(0, len(mem_docs), batch_size):
                batch = mem_docs[i : i + batch_size]
                collection.upsert(
                    ids=[d["id"] for d in batch],
                    documents=[d["content"] for d in batch],
                    metadatas=[d["metadata"] for d in batch],
                )
            print(f"  {len(mem_docs)} memories")
            total_mem += len(mem_docs)

        # Migrate tasks
        task_docs = [d for t in data["tasks"] if (d := build_task_doc(t, customer)) is not None]
        if task_docs:
            batch_size = 50
            for i in range(0, len(task_docs), batch_size):
                batch = task_docs[i : i + batch_size]
                collection.upsert(
                    ids=[d["id"] for d in batch],
                    documents=[d["content"] for d in batch],
                    metadatas=[d["metadata"] for d in batch],
                )
            print(f"  {len(task_docs)} tasks")
            total_task += len(task_docs)

    print(f"\n=== Migration complete ===")
    print(f"Total: {total_mem} memories + {total_task} tasks = {total_mem + total_task} documents\n")

    # Verification
    print("--- Verification ---")
    for coll in sorted(client.list_collections(), key=lambda c: c.name):
        print(f"  {coll.name}: {coll.count()} documents")


if __name__ == "__main__":
    main()
