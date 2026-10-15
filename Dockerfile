FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    WINEPREFIX=/workspace/.wine \
    RESOLUTION=1440x900

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates dbus-x11 fluxbox fonts-dejavu-core \
    procps python3 x11vnc xvfb xterm wine wine64 winbind \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash runner \
    && mkdir -p /workspace /home/runner/.vnc \
    && chown -R runner:runner /workspace /home/runner

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
USER runner
WORKDIR /workspace
EXPOSE 5900
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
