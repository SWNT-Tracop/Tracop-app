#!/usr/bin/env bash
# Updates an existing AWS demo. Bootstrap and production use separate procedures.
set -Eeuo pipefail
umask 077

: "${DEPLOY_SHA:?Missing tested commit}"
: "${PUBLIC_URL:?Missing public HTTPS origin}"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$PUBLIC_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]
cd "${APP_DIR:-/opt/tracop}"
state="${STATE_DIR:-/opt/tracop-deployments}"
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/deploy.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
test -z "$(git status --porcelain)"
git fetch origin main
if [[ "$(git rev-parse origin/main)" != "$DEPLOY_SHA" ]]; then
  echo 'Skipped superseded main commit'
  exit 0
fi

release=$(mktemp -d "$state/release-${DEPLOY_SHA}.XXXXXX")
previous_sha=$(git rev-parse HEAD)
compose=(docker compose --project-name tracop-aws --env-file .env.demo -f docker-compose.aws.yml)
legacy="${LEGACY_OVERRIDE:-/opt/tracop-edge/runtime-image.yml}"
[[ ! -f "$legacy" ]] || compose+=(-f "$legacy")
[[ ! -f "$state/active.yml" ]] || compose+=(-f "$state/active.yml")
# Render privately before checkout: rollback retains the old environment and commands.
"${compose[@]}" config > "$release/previous.yml"
for service in api worker; do
  container=$("${compose[@]}" ps -q "$service")
  test -n "$container"
  image=$(docker inspect --format '{{.Image}}' "$container")
  printf '  %s:\n    image: %s\n' "$service" "$image" >> "$release/previous-images.part"
done
{ echo 'services:'; cat "$release/previous-images.part"; } > "$release/previous-images.yml"
rollback=(docker compose --project-name tracop-aws -f "$release/previous.yml" -f "$release/previous-images.yml")
activated=false
rollback_on_error() {
  result=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    echo 'Deployment failed; restoring previous API and worker images'
    "${rollback[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 api worker ||
      echo 'Rollback failed: operator intervention required' >&2
  fi
  git checkout --detach "$previous_sha" || echo 'Could not restore repository checkout' >&2
  echo "Deployment failed; private recovery files: $release" >&2
  exit "$result"
}
trap rollback_on_error ERR

git checkout --detach "$DEPLOY_SHA"
image="tracop-api:$DEPLOY_SHA"
docker build --build-arg "APP_VERSION=$DEPLOY_SHA" -t "$image" .
cat > "$release/candidate.yml" <<EOF
services:
  setup:
    image: $image
    command: ['node', 'dist/drizzle/migrate.js']
  api:
    image: $image
  worker:
    image: $image
EOF
candidate=("${compose[@]}" -f "$release/candidate.yml")
# Back up before migrations. Never wipe volumes or restore the DB automatically; the only data
# added on its own is the suspended showcase, and only when it is missing (see below).
"${compose[@]}" exec --interactive=false -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$release/database.dump.partial"
test -s "$release/database.dump.partial"
mv "$release/database.dump.partial" "$release/database.dump"
"${candidate[@]}" run --rm --no-deps --interactive=false setup node dist/drizzle/migrate.js
activated=true
"${candidate[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 api worker
# Readiness includes the database and worker heartbeat; allow the first heartbeat to arrive.
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS --connect-timeout 5 --max-time 10 "$PUBLIC_URL/ready" > "$release/readiness.json" &&
    docker run --rm --interactive=false --user 0 -v "$release:/check:ro" --entrypoint node "$image" -e \
      'const r=require("/check/readiness.json");process.exit(r.status === "ready" ? 0 : 1)'; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]]
curl -fsS --connect-timeout 5 --max-time 10 "$PUBLIC_URL/health" > "$release/health.json"
container=$("${candidate[@]}" ps -q api)
[[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == "$image" ]]

# Presentation data (apps/api/scripts/deploy-after-start.sh), no-ops when already done, never deleting:
# the suspended showcase when it is missing (an empty or rebuilt database gets it back) and admin
# for BOOTSTRAP_ADMIN_PHONE from the server .env.demo. A failure only warns and keeps the release.
# SHOWCASE_SEED=off skips it.
if [[ "${SHOWCASE_SEED:-on}" != off ]]; then
  "${candidate[@]}" exec --interactive=false -T api sh scripts/deploy-after-start.sh ||
    echo 'WARNING: presentation setup failed; showcase accounts stay suspended'
fi

# Keep the separately managed Caddy routes/assets; refresh only its exported API schema.
edge="${SWAGGER_DIR:-/opt/tracop-edge/swagger-demo}"
if [[ -d "$edge" ]]; then
  docker run --rm --interactive=false --user 0 -e "PUBLIC_URL=$PUBLIC_URL" \
    -v "$PWD/docs:/source:ro" -v "$release:/output" --entrypoint node "$image" -e \
    'const fs=require("fs");const s=JSON.parse(fs.readFileSync("/source/openapi.json"));s.servers=[{url:process.env.PUBLIC_URL,description:"Demo TRACOP"}];fs.writeFileSync("/output/openapi.json",JSON.stringify(s,null,2));'
  docker cp "$release/openapi.json" tracop-edge-caddy-1:/config/swagger-demo/openapi.next.json
  docker exec --interactive=false tracop-edge-caddy-1 mv /config/swagger-demo/openapi.next.json /config/swagger-demo/openapi.json
  install -m 644 "$release/openapi.json" "$edge/openapi.json"
fi
cp "$release/candidate.yml" "$state/active.next.yml"
mv "$state/active.next.yml" "$state/active.yml"
activated=false
trap - ERR
echo "Deployed main commit $DEPLOY_SHA"
