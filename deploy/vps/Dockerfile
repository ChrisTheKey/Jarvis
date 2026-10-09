# Jarvis Always-on Mail-Worker (VPS). Derselbe mail-worker.js wie unter Windows – keine zweite Mail-Engine.
# Build-Kontext ist das Repository-Wurzelverzeichnis (siehe docker-compose.yml). Keine Abhängigkeiten nötig.
# Secrets kommen nie ins Image: Gmail-Credentials/Token und Worker-Zustand liegen im Volume /data/secrets (nur auf dem VPS).
FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=Europe/Zurich JARVIS_SECRETS_DIR=/data/secrets JARVIS_WORKER_ROLE=vps JARVIS_POLL_MINUTES=2
WORKDIR /app
COPY deploy/vps/backup-public.pem ./backup-public.pem
COPY package.json mail-worker.js gmail.js mail-requests.js shared-state.js local-state.js human-contact.js lead-finder.js site-auditor.js sales.js swiss-repair.js email-permission.js cloud-core.js backup.js backup-api.js server-control.js server-agent.js cloud-leads.js persona-version.js persona.md mail-writer.md ./
USER node
# Deploy-Stand für Server Control (deploy.status) – zuletzt, damit der Cache der übrigen Schichten bleibt.
ARG JARVIS_COMMIT=unknown
ARG JARVIS_DEPLOYED_AT=
ENV JARVIS_COMMIT=$JARVIS_COMMIT JARVIS_DEPLOYED_AT=$JARVIS_DEPLOYED_AT
# Gesund, solange der Worker sein Lock in den letzten 5 Minuten erneuert hat (Herzschlag jede Minute).
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "mail-worker.js", "--healthcheck"]
CMD ["node", "mail-worker.js"]
