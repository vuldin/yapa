# YAPA Install

**STOP. Read this entire file before running ANY commands.** This is a 3-phase install. You MUST complete each phase in order. Do NOT skip ahead. Do NOT run `npm install`, `npm run build`, `claude mcp add`, or any other commands until instructed. Phase 2 requires asking the user questions — do NOT assume defaults.

## Phase 1 — Diagnostics

Run this command now and read the output carefully:

```
node --version && npm --version && curl -sf http://localhost:8000/api/v2/heartbeat && whoami && ls dist/index.js 2>/dev/null; ls ~/.claude/ 2>/dev/null && ls ~/.cursor/ 2>/dev/null && ls .opencode/ 2>/dev/null
```

STOP. Do not run npm install, npm run build, or any other install command yet. Read the output and proceed to Phase 2.

## Phase 2 — Ask the user questions (REQUIRED)

You MUST use the AskUserQuestion tool here. Do NOT skip this phase. Do NOT ask questions as plain text. Combine all applicable questions into one AskUserQuestion call with selectable options:

- If `node --version` failed or printed < 18: question "How should Node.js be installed?" with options: "nvm", "System package manager"
- If `curl` to ChromaDB failed: question "How should ChromaDB be installed?" with options: "Docker (recommended)", "pip", "NixOS"
- If neither `~/.claude/`, `~/.cursor/`, nor `.opencode/` was found: question "Which editor are you using?" with options: "Claude Code", "Cursor", "OpenCode"
- Always ask: "Username for task IDs?" with options: the output of `whoami` (labeled with the actual username), "Custom username"
- Always ask: "Where should YAPA instructions be installed?" — first option MUST be "This project only", second option "Globally for all sessions". Do not reorder these options.
- Always ask: "Enable remote syncing?" with options: "No", "Yes — new database", "Yes — existing database". If the user selects "Yes — existing database", ask for their PostgreSQL connection URL (e.g., `postgres://user:pass@host:5432/yapa`). If the user selects "Yes — new database", ask a follow-up: "How would you like to host PostgreSQL?" with options: "Docker (local)", "Managed service (Neon, Supabase)", "Cloud provider (AWS, GCP, Azure)". If "Managed service": ask "Which service?" with options: "Neon (free serverless)", "Supabase (free hosted)". If "Cloud provider": ask "Which provider?" with options: "AWS (RDS)", "GCP (Cloud SQL)", "Azure (Flexible Server)". Do NOT ask for a connection URL yet — Phase 3 will handle setup.

STOP. Wait for the user's answers before proceeding. You need USERNAME, SCOPE, and either SYNC_DATABASE_URL (if "existing database") or SYNC_PROVIDER (if "new database" — one of: docker, neon, supabase, aws, gcp, azure) from these answers for Phase 3.

## Phase 3 — Install (only after Phase 2 answers are received)

Now execute these steps in order, without asking anything else:

1. Move this repo to the correct location based on the user's SCOPE from Phase 2:
   - If scope=global: `~/.local/share/yapa/`
   - If scope=project: `.yapa/` in the user's current working directory (the directory they were in when they asked to install, NOT the repo directory)

   If the repo is already in the correct location, skip this step. Otherwise:
   ```
   mkdir -p TARGET_LOCATION && mv THIS_REPO_DIR TARGET_LOCATION
   ```
   Then `cd TARGET_LOCATION` and continue from there. All subsequent steps use this as the repo directory.

2. If Node.js needed: install using the user's chosen method, then verify `node --version` >= 18.

3. Run: `cd THIS_REPO_DIR && npm install && npm run build`
   Verify: `ls dist/index.js` succeeds.

4. If ChromaDB needed, start it using the user's chosen method:
   - Docker: `docker run -d --name chromadb --restart unless-stopped -p 8000:8000 -v chromadb_data:/data chromadb/chroma`
   - pip: `pip install chromadb && chroma run --host 0.0.0.0 --port 8000 &`
   - NixOS: tell user to add `services.chromadb.enable = true;` and rebuild
   Verify: `curl -sf http://localhost:8000/api/v2/heartbeat` succeeds.

5. If user chose "Yes — new database" for remote syncing, set up PostgreSQL+pgvector using the provider chosen in Phase 2:

   **Docker (local):**

   Check if port 5432 is available:
   ```
   ss -tln | grep :5432
   ```
   If port 5432 is in use, use 5433 instead. Set PG_PORT accordingly (default 5432).

   Generate a random password and start the container:
   ```
   YAPA_PG_PASS=$(openssl rand -hex 16)
   docker run -d --name yapa-postgres --restart unless-stopped \
     -p ${PG_PORT}:5432 \
     -e POSTGRES_DB=yapa \
     -e POSTGRES_USER=yapa \
     -e POSTGRES_PASSWORD=${YAPA_PG_PASS} \
     -v yapa_pgdata:/var/lib/postgresql/data \
     pgvector/pgvector:pg17
   ```

   Wait for PostgreSQL to be ready (up to 30 seconds):
   ```
   for i in $(seq 1 30); do docker exec yapa-postgres pg_isready -U yapa -d yapa >/dev/null 2>&1 && break || sleep 1; done
   ```

   Verify: `docker exec yapa-postgres psql -U yapa -d yapa -c "SELECT 1"`

   Set: `SYNC_DATABASE_URL="postgres://yapa:${YAPA_PG_PASS}@localhost:${PG_PORT}/yapa"`

   **Neon:**

   Tell the user:
   1. Go to https://console.neon.tech and sign up (free tier includes 0.5 GB storage)
   2. Create a new project (any name, e.g. "yapa")
   3. On the project dashboard, copy the connection string shown
   4. Neon includes pgvector by default — no extra setup needed

   Ask the user to paste the connection string. Set: `SYNC_DATABASE_URL=<pasted URL>`

   **Supabase:**

   Tell the user:
   1. Go to https://supabase.com/dashboard and sign up (free tier includes 500 MB)
   2. Create a new project (any name, e.g. "yapa") — choose a database password
   3. Go to Settings → Database → Connection string → URI, copy it (replace `[YOUR-PASSWORD]` with your database password)
   4. Supabase includes pgvector by default — no extra setup needed

   Ask the user to paste the connection string. Set: `SYNC_DATABASE_URL=<pasted URL>`

   **AWS (RDS):**

   Check if `aws` CLI is installed and authenticated:
   ```
   aws sts get-caller-identity 2>/dev/null
   ```

   If the CLI is available and authenticated, offer to provision automatically. If the user accepts:
   ```
   YAPA_PG_PASS=$(openssl rand -hex 16)
   aws rds create-db-instance \
     --db-instance-identifier yapa \
     --db-instance-class db.t3.micro \
     --engine postgres \
     --engine-version 17 \
     --master-username yapa \
     --master-user-password "${YAPA_PG_PASS}" \
     --allocated-storage 20 \
     --publicly-accessible \
     --no-multi-az
   ```

   Wait for the instance to become available (this can take several minutes):
   ```
   aws rds wait db-instance-available --db-instance-identifier yapa
   ```

   Get the endpoint:
   ```
   RDS_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier yapa --query 'DBInstances[0].Endpoint.Address' --output text)
   ```

   Create the yapa database and enable pgvector:
   ```
   PGPASSWORD="${YAPA_PG_PASS}" psql -h "${RDS_ENDPOINT}" -U yapa -d postgres -c "CREATE DATABASE yapa;"
   PGPASSWORD="${YAPA_PG_PASS}" psql -h "${RDS_ENDPOINT}" -U yapa -d yapa -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

   Set: `SYNC_DATABASE_URL="postgres://yapa:${YAPA_PG_PASS}@${RDS_ENDPOINT}:5432/yapa"`

   If the CLI is NOT available or the user declines automatic setup, tell the user:
   1. Go to the RDS console at https://console.aws.amazon.com/rds/
   2. Click "Create database" → choose PostgreSQL, version 15+
   3. Choose "Free tier" template if available, or the smallest instance (db.t3.micro)
   4. Set DB identifier: `yapa`, master username: `yapa`, choose a password
   5. Under Connectivity, ensure "Public access" is set to Yes (or configure VPC peering as needed)
   6. Create the database and wait for it to become "Available"
   7. Copy the endpoint from the database details page
   8. Connect and enable pgvector: `psql -h <endpoint> -U yapa -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"`
   9. Create the yapa database: `CREATE DATABASE yapa;`

   Ask the user to provide the connection string. Set: `SYNC_DATABASE_URL="postgres://yapa:<password>@<endpoint>:5432/yapa"`

   **GCP (Cloud SQL):**

   Check if `gcloud` CLI is installed and authenticated:
   ```
   gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null
   ```

   If the CLI is available and authenticated, offer to provision automatically. If the user accepts:
   ```
   YAPA_PG_PASS=$(openssl rand -hex 16)
   GCP_PROJECT=$(gcloud config get-value project)
   gcloud sql instances create yapa \
     --database-version=POSTGRES_17 \
     --tier=db-f1-micro \
     --region=us-central1 \
     --assign-ip \
     --project="${GCP_PROJECT}"
   ```

   Set the root password, create user and database:
   ```
   gcloud sql users set-password postgres --instance=yapa --password="${YAPA_PG_PASS}" --project="${GCP_PROJECT}"
   gcloud sql users create yapa --instance=yapa --password="${YAPA_PG_PASS}" --project="${GCP_PROJECT}"
   gcloud sql databases create yapa --instance=yapa --project="${GCP_PROJECT}"
   ```

   Authorize the current IP and get the instance IP:
   ```
   MY_IP=$(curl -sf ifconfig.me)
   gcloud sql instances patch yapa --authorized-networks="${MY_IP}/32" --project="${GCP_PROJECT}"
   CSQL_IP=$(gcloud sql instances describe yapa --format="value(ipAddresses[0].ipAddress)" --project="${GCP_PROJECT}")
   ```

   Enable pgvector:
   ```
   PGPASSWORD="${YAPA_PG_PASS}" psql -h "${CSQL_IP}" -U yapa -d yapa -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

   Set: `SYNC_DATABASE_URL="postgres://yapa:${YAPA_PG_PASS}@${CSQL_IP}:5432/yapa"`

   If the CLI is NOT available or the user declines automatic setup, tell the user:
   1. Go to https://console.cloud.google.com/sql
   2. Click "Create instance" → choose PostgreSQL, version 15+
   3. Set instance ID: `yapa`, choose a root password, pick a region
   4. Choose the smallest machine type (Shared core, 1 vCPU)
   5. Under Connections, enable "Public IP" and add your IP to authorized networks (or use Cloud SQL Auth Proxy)
   6. Once created, click the instance → "Databases" tab → "Create database" named `yapa`
   7. Create a user: "Users" tab → "Add user account" → username `yapa`, choose a password
   8. pgvector is supported on Cloud SQL — enable it by connecting and running: `CREATE EXTENSION IF NOT EXISTS vector;`

   Ask the user to provide the connection string. Set: `SYNC_DATABASE_URL="postgres://yapa:<password>@<public-ip>:5432/yapa"`

   **Azure (Flexible Server):**

   Check if `az` CLI is installed and authenticated:
   ```
   az account show 2>/dev/null
   ```

   If the CLI is available and authenticated, offer to provision automatically. If the user accepts:
   ```
   YAPA_PG_PASS=$(openssl rand -hex 16)
   AZ_RESOURCE_GROUP="yapa-rg"
   AZ_REGION="eastus"
   az group create --name "${AZ_RESOURCE_GROUP}" --location "${AZ_REGION}"
   az postgres flexible-server create \
     --resource-group "${AZ_RESOURCE_GROUP}" \
     --name yapa \
     --location "${AZ_REGION}" \
     --admin-user yapa \
     --admin-password "${YAPA_PG_PASS}" \
     --sku-name Standard_B1ms \
     --tier Burstable \
     --public-access 0.0.0.0 \
     --yes
   ```

   Create the database and enable pgvector:
   ```
   az postgres flexible-server db create --resource-group "${AZ_RESOURCE_GROUP}" --server-name yapa --database-name yapa
   az postgres flexible-server parameter set --resource-group "${AZ_RESOURCE_GROUP}" --server-name yapa --name azure.extensions --value VECTOR
   PGPASSWORD="${YAPA_PG_PASS}" psql -h yapa.postgres.database.azure.com -U yapa -d yapa -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

   Set: `SYNC_DATABASE_URL="postgres://yapa:${YAPA_PG_PASS}@yapa.postgres.database.azure.com:5432/yapa"`

   If the CLI is NOT available or the user declines automatic setup, tell the user:
   1. Go to https://portal.azure.com → search "Azure Database for PostgreSQL"
   2. Click "Create" → choose "Flexible Server"
   3. Set server name: `yapa`, choose admin username `yapa` and a password, pick a region
   4. Choose the Burstable tier (B1ms) for lowest cost
   5. Under Networking, enable "Allow public access" and add your client IP
   6. Once deployed, go to "Server parameters" → search `azure.extensions` → enable `VECTOR`
   7. Connect and create the database: `CREATE DATABASE yapa;` then `CREATE EXTENSION IF NOT EXISTS vector;`

   Ask the user to provide the connection string. Set: `SYNC_DATABASE_URL="postgres://yapa:<password>@<server-name>.postgres.database.azure.com:5432/yapa"`

   **For all providers**, after obtaining SYNC_DATABASE_URL, tell the user:
   > **Save this connection URL** — you'll need it if you reinstall YAPA or add another machine. Share it with teammates who want to sync with you.

6. Register the YAPA MCP server, replacing ABSOLUTE_PATH with this repo's absolute path and USERNAME with the user's answer from Phase 2. If the user enabled remote syncing, also add the sync env vars shown below:

   Claude Code — run:
   ```
   claude mcp add -e YAPA_USERNAME=USERNAME -s user yapa -- node ABSOLUTE_PATH/dist/index.js
   ```
   If sync enabled, also add: `-e YAPA_SYNC_ENABLED=true -e YAPA_SYNC_DATABASE_URL=SYNC_DATABASE_URL`

   Cursor — merge into `mcpServers` in `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "yapa": {
         "command": "node",
         "args": ["ABSOLUTE_PATH/dist/index.js"],
         "env": {
           "YAPA_USERNAME": "USERNAME",
           "YAPA_SYNC_ENABLED": "true",
           "YAPA_SYNC_DATABASE_URL": "SYNC_DATABASE_URL"
         }
       }
     }
   }
   ```
   Omit the `YAPA_SYNC_*` keys if sync is not enabled.

   OpenCode — merge into `mcpServers` in `.opencode/config.json`:
   ```json
   {
     "mcpServers": {
       "yapa": {
         "command": "node",
         "args": ["ABSOLUTE_PATH/dist/index.js"],
         "env": {
           "YAPA_USERNAME": "USERNAME",
           "YAPA_SYNC_ENABLED": "true",
           "YAPA_SYNC_DATABASE_URL": "SYNC_DATABASE_URL"
         }
       }
     }
   }
   ```
   Omit the `YAPA_SYNC_*` keys if sync is not enabled.

7. Write the YAPA behavioral instructions. Append the following block to the correct file based on the user's SCOPE and editor choice from Phase 2:
   - If scope=project and Claude Code: append to `CLAUDE.md` in the user's current working directory
   - If scope=project and OpenCode: append to `AGENTS.md` in the user's current working directory
   - If scope=global and Claude Code: append to `~/.claude/CLAUDE.md`
   - If scope=global and OpenCode: append to `~/.config/opencode/AGENTS.md`

   Append this exact block:

   ```
   ## YAPA — Memory & Task Assistant

   You have access to YAPA memory and task tools via MCP. Follow these rules:

   ### ChromaDB Prerequisite
   Before using any YAPA tool, verify ChromaDB is reachable:
   1. Run: `curl -sf http://localhost:8000/api/v2/heartbeat`
   2. If it succeeds, ChromaDB is running — proceed normally.
   3. If it fails, tell the user:
      > "YAPA needs ChromaDB to store memories and tasks, but it doesn't appear to be running locally. How would you like to install it?"
      Then offer these options (Docker is recommended):
      - **Docker (recommended):** `docker run -d --name chromadb --restart unless-stopped -p 8000:8000 -v chromadb_data:/data chromadb/chroma`
      - **pip:** `pip install chromadb && chroma run --host 0.0.0.0 --port 8000`
      - **NixOS service:** add `services.chromadb.enable = true;` to your NixOS config
   4. After the user installs and starts ChromaDB, re-check the heartbeat before continuing.
   5. Do NOT silently swallow connection errors from YAPA tools — if ChromaDB goes down mid-session, notify the user immediately.

   ### Auto-Query (every response)
   - Before responding to any question or starting any task, call `memory_recall`
     with a semantic query derived from the user's message
   - Check if existing memories contain solutions, context, or prior decisions relevant
     to the current work

   ### Selective Auto-Store
   Store memories automatically (salience >= 2.0) when you encounter:
   - Bug fixes and their root causes
   - User preferences and decisions
   - Configuration values and environment details
   - Key technical facts about the codebase
   - Solutions to problems that may recur
   Do NOT store: ephemeral conversation details, obvious code patterns,
   information already in git history

   ### Task Management
   - When new work is identified, call `task_create`
   - When work completes, call `task_complete`
   - When blocked, call `task_update` with status "blocked"
   - At session start, call `task_list` to review current state

   ### Collection Inference
   - Infer the appropriate collection from conversation context:
     - Customer name mentioned → `customer-{name}`
     - Project-specific work → `project-{name}` or `customer-{name}`
     - General/cross-cutting knowledge → `global`
     - Private/personal data → `private-{name}` or `local-{name}` (these do NOT sync to remote)
   - **Before creating a new collection**, ask the user to confirm the collection name. Suggest a name based on context. Remind the user that `private-` or `local-` prefixed collections won't sync to the shared remote database.
   - When unsure which collection to use, ask the user
   - Use `collection_list` to check what collections exist before creating new ones
   - Always pass the inferred collection explicitly on memory/task tool calls

   ### Uninstall
   If the user says "uninstall yapa":
   1. Use AskUserQuestion to ask "Do you want to keep your ChromaDB collections (memories and tasks)?" with exactly two options: "Yes" (first), "No". Do not ask this as plain text.
   2. Call the `uninstall` MCP tool with `delete_collections: true` if the user answered "No", or `delete_collections: false` if "Yes".
   3. Execute every step the tool returns without asking anything else.
   ```

8. Tell the user: "YAPA is installed. Restart your editor to activate it. To uninstall later, say 'uninstall yapa' in any session."
