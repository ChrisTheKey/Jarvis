# Jarvis Always-on Mail-Worker (VPS). Derselbe mail-worker.js wie unter Windows – keine zweite Mail-Engine.
# Build-Kontext ist das Repository-Wurzelverzeichnis (siehe docker-compose.yml). Einzige Laufzeit-Abhängigkeit des Workers: ssh2
# (SFTP/SSH-Reparaturadapter, TF-042) – reproduzierbar aus package-lock.json, ohne Install-Skripte und ohne optionale Native-Module.
# TF-047: Reparaturaufträge und das Browser-Gate (Chromium) laufen im separaten Repair-Service (deploy/vps/Dockerfile.repair) –
# dieses Image enthält kein Chromium mehr. Der Mail-Worker stellt nur noch die Service-Mails aus der Repair-Outbox zu.
# Secrets kommen nie ins Image: Gmail-Credentials/Token und Worker-Zustand liegen im Volume /data/secrets (nur auf dem VPS).
FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=Europe/Zurich JARVIS_SECRETS_DIR=/data/secrets JARVIS_WORKER_ROLE=vps JARVIS_POLL_MINUTES=2
WORKDIR /app
COPY deploy/vps/backup-public.pem ./backup-public.pem
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY mail-worker.js gmail.js mail-requests.js shared-state.js local-state.js human-contact.js lead-finder.js site-auditor.js sales.js payments.js access-intake.js access-intake-api.js swiss-repair.js site-findings.js repair-workflow.js check-150-workflow.js repair-render-test.js repair-browser-validator.js production-readiness.js repair-outbox.js repair-service.js email-permission.js cloud-core.js backup.js backup-api.js server-control.js server-agent.js cloud-leads.js lead-db.js lead-registry.js swiss-areas.js category-labels.js persona-version.js persona.md mail-writer.md ./
# Versionierter Schweiz-Gebietsindex (BFS-Gemeindeverzeichnis) – wird zur Laufzeit nur gelesen, nie heruntergeladen.
COPY repair-adapters ./repair-adapters
COPY data/swiss-municipalities.json ./data/swiss-municipalities.json
USER node
# Deploy-Stand für Server Control (deploy.status) – zuletzt, damit der Cache der übrigen Schichten bleibt.
ARG JARVIS_COMMIT=unknown
ARG JARVIS_DEPLOYED_AT=
ENV JARVIS_COMMIT=$JARVIS_COMMIT JARVIS_DEPLOYED_AT=$JARVIS_DEPLOYED_AT
# Gesund, solange der Worker sein Lock in den letzten 5 Minuten erneuert hat (Herzschlag jede Minute).
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "mail-worker.js", "--healthcheck"]
CMD ["node", "mail-worker.js"]
