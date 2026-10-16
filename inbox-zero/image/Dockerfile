FROM ghcr.io/elie222/inbox-zero:59cf6d2@sha256:fc4836d16cc78c84d56ef4063d24d13662747349d1ba74df6f070a8cb75ec582

COPY gmail-pacing.cjs patch-gmail-transport.cjs /app/
RUN node /app/patch-gmail-transport.cjs \
    && addgroup -S -g 1001 inboxzero \
    && adduser -S -u 1001 -G inboxzero -h /home/inboxzero inboxzero \
    && chown -R inboxzero:inboxzero /app/apps/web/.next /app/apps/web/public

ENV NODE_OPTIONS=--require=/app/gmail-pacing.cjs
ENV INBOXZERO_GMAIL_PACING=true
ENV NEXT_TELEMETRY_DISABLED=1
ENV TMPDIR=/tmp
USER 1001:1001
