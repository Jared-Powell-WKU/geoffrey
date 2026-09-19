#!/usr/bin/env bash
# Assemble the files the droplet's deploy script accepts for this stack.
#   deploy/make-bundle.sh <empty-output-dir>
set -euo pipefail
out="${1:?usage: make-bundle.sh <output-dir>}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$out/migrations" "$out/initdb"
cp "$repo/docker-compose.yaml" "$out/compose.yaml"
cp "$repo/deploy/pre-deploy" "$out/pre-deploy"
cp "$repo"/project/mariadb/defaults/*.sql "$out/initdb/"
shopt -s nullglob
for f in "$repo"/project/mariadb/migrations/[0-9][0-9][0-9]_*.sql; do cp "$f" "$out/migrations/"; done
