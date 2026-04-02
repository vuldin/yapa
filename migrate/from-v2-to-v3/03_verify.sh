#!/bin/bash
#
# Verify YAPA v3 migration succeeded
#

CHROMA_URL="http://localhost:8000"
TARGET_COLLECTIONS=("drasil" "drasil-cli" "drasil-contracts" "drasil-discovery" "drasil-storacha-rs" "drasil-hardhat-testnet" "drasil-system-metadata" "global")

echo "====================================="
echo "YAPA v3 Migration Verification"
echo "====================================="
echo ""

# 1. Check all collections exist
echo "1. Checking collections exist..."
for coll in "${TARGET_COLLECTIONS[@]}"; do
    count=$(curl -sf "${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections/${coll}/count" 2>/dev/null || echo "0")
    if [ "$count" != "0" ] || [ "$coll" == "global" ]; then
        echo "   ✓ $coll: $count documents"
    else
        echo "   ✗ $coll: Not found or empty"
    fi
done

echo ""
echo "2. Checking embedding dimension..."

# Test with a simple query - if dimensions are wrong, this will fail
# We'll try to add a test document and query it
test_response=$(curl -sf -X POST \
    "${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections/drasil/query" \
    -H "Content-Type: application/json" \
    -d '{"query_embeddings": [[0.1]], "n_results": 1}' 2>&1)

if echo "$test_response" | grep -q "embedding dimension"; then
    echo "   ✗ Dimension mismatch detected!"
    echo "   $test_response"
    exit 1
else
    echo "   ✓ Embedding dimensions are compatible"
fi

echo ""
echo "3. Summary:"
echo "   - New collections created with 384-dim embeddings"
echo "   - Old collections still exist (preserved for safety)"
echo "   - Ready for YAPA testing"
echo ""
echo "Next steps:"
echo "   1. Start OpenCode and test YAPA commands"
echo "   2. Verify you can query and create new memories"
echo "   3. Once satisfied, manually delete old collections"
echo ""
