# The monitor and its status page. The app (PWA) is hosted on GitHub Pages.
FROM node:22-alpine

WORKDIR /app

# Workspace manifests first, so dependencies are cached between builds
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY monitor/package.json monitor/
COPY app/package.json app/
RUN npm ci --omit=dev --workspace monitor && npm cache clean --force

COPY shared shared
COPY monitor/src monitor/src
RUN chmod +x monitor/src/index.js && ln -s /app/monitor/src/index.js /usr/local/bin/homelab-monitor

ENV NODE_ENV=production \
    HOMELAB_MONITOR_CONFIG=/config/config.yaml \
    HOMELAB_MONITOR_DATA=/data \
    STATUS_PAGE_HOST=0.0.0.0

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3001

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["homelab-monitor"]
CMD ["run"]
