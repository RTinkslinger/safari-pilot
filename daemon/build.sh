#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Building SafariPilotd..."
swift build -c release

# Copy binary to bin/
BINARY=".build/release/SafariPilotd"
if [ -f "$BINARY" ]; then
    mkdir -p ../bin
    cp "$BINARY" ../bin/SafariPilotd
    echo "Binary copied to bin/SafariPilotd"
    echo "Size: $(du -h ../bin/SafariPilotd | cut -f1)"
fi
