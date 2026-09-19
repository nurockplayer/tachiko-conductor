# Disposable worker image for the issue #74 container acceptance path.
#
# Production images follow the same contract: a digest-pinned image that
# provides Git plus the worker entrypoint, so the host worker path is never
# mounted and never executed. The adapter always addresses this image by
# digest -- tags are rejected.
FROM alpine:3.21

RUN apk add --no-cache git

# Commits happen inside the container; identity comes from the image, never
# from a mounted host `$HOME`.
RUN git config --system user.name "Tachiko Container Worker" \
 && git config --system user.email "container-worker@example.invalid"

COPY entrypoint.sh /usr/local/bin/worker-router-container
RUN chmod 0755 /usr/local/bin/worker-router-container

ENTRYPOINT []
CMD []
