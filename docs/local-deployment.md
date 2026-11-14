# Local sandbox deployment

Run `bash scripts/local-deploy.sh` (`scripts/dev-up.sh` is a compatibility alias). Requires Node.js, Docker, and the current Docker Compose plugin (`docker compose`). The legacy Python `docker-compose` client is unsupported. Open http://localhost:3100. API readiness is http://localhost:3101/ready.

This uses project `freehold-local`, separate persistent PostgreSQL/Redis volumes, locally built images `freehold-api:local-release` and `freehold-web:local-release`, localhost-only ports, and generated random credentials. It does not change the existing `freehold` project. Application services run development settings for local HTTP and demo funding. This is a local sandbox, not production acceptance.

After the first successful seed, `tmp/local-deployment/accounts.json` contains the demo users, password, and operator authenticator secret. Both it and the environment file are private and gitignored. Keep these files while using the volumes; regenerating passwords does not change passwords already provisioned in PostgreSQL. Seeding goes through authenticated application endpoints. It is skipped on later successful starts.

To inspect or stop services, use the same project and files:

```sh
docker compose -p freehold-local --env-file tmp/local-deployment/deployment.env -f compose.yaml -f deploy/compose.local.yaml ps
docker compose -p freehold-local --env-file tmp/local-deployment/deployment.env -f compose.yaml -f deploy/compose.local.yaml logs --tail=50 api worker scheduler
docker compose -p freehold-local --env-file tmp/local-deployment/deployment.env -f compose.yaml -f deploy/compose.local.yaml stop
```

Stopping preserves data. Restart with the deployment script. Do not remove volumes unless intentionally deleting this sandbox's data. The environment and credential files contain secrets; do not commit or share them.
