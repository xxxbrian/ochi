# A single, standard Docker Engine image for Linux hosts (amd64 and arm64).
# XFCE and user applications run inside the workspace, with Chromium managed
# separately by the bridge and attached over loopback CDP.
FROM node:24-bookworm-slim AS node-runtime
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    XDG_RUNTIME_DIR=/tmp/runtime-assistant \
    XDG_CONFIG_HOME=/data/desktop/config \
    XDG_DATA_HOME=/data/desktop/share \
    XDG_CACHE_HOME=/data/cache/desktop \
    XDG_STATE_HOME=/data/desktop/state \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/runtime-assistant/bus \
    GTK_A11Y=1 \
    NO_AT_BRIDGE=0 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        adwaita-icon-theme \
        at-spi2-core \
        ca-certificates \
        chromium \
        dbus \
        dbus-x11 \
        evince \
        fontconfig \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-core \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-noto-mono \
        curl \
        git \
        gir1.2-atspi-2.0 \
        greybird-gtk-theme \
        gsettings-desktop-schemas \
        jq \
        iptables \
        libglib2.0-bin \
        libnotify-bin \
        libreoffice-calc \
        libreoffice-gtk3 \
        libreoffice-impress \
        libreoffice-writer \
        mousepad \
        procps \
        python3 \
        python3-gi \
        python3-pyatspi \
        python3-venv \
        ristretto \
        scrot \
        thunar \
        thunar-archive-plugin \
        tini \
        tumbler \
        unzip \
        util-linux \
        wmctrl \
        x11-utils \
        x11-xserver-utils \
        x11vnc \
        xarchiver \
        xclip \
        xdotool \
        xdg-user-dirs \
        xdg-utils \
        xfce4-appfinder \
        xfce4-notifyd \
        xfce4-panel \
        xfce4-session \
        xfce4-settings \
        xfce4-terminal \
        xfdesktop4 \
        xfwm4 \
        xvfb \
        xz-utils \
        zip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv --system-site-packages "$VIRTUAL_ENV" \
    && "$VIRTUAL_ENV/bin/pip" install --no-cache-dir "playwright==1.59.0" "mcp==2.3.0" "PyYAML==6.0.3" "pypdf==6.8.0" "Pillow==12.1.1" "websockify==0.13.0" \
    && useradd --create-home --uid 1000 --shell /bin/bash assistant \
    && mkdir -p /data/files /data/profile /opt/extensions /tmp/runtime-assistant \
    && chown -R assistant:assistant /data /opt/extensions /tmp/runtime-assistant /opt/venv

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY bridge.py /opt/workspace/bridge.py
COPY workspace_*.py /opt/workspace/
COPY memory_embeddings.py /opt/workspace/memory_embeddings.py
COPY tools.json /opt/workspace/tools.json
COPY desktop-defaults/ /opt/workspace/desktop-defaults/
COPY desktop-prepare.py /opt/workspace/desktop-prepare.py
COPY desktop-start.sh /usr/local/bin/workspace-desktop-start
COPY desktop-browser-launch.py /usr/local/bin/workspace-browser-launch
COPY entrypoint.sh /usr/local/bin/workspace-entrypoint
RUN chmod 0755 /usr/local/bin/workspace-entrypoint /usr/local/bin/workspace-desktop-start /usr/local/bin/workspace-browser-launch /opt/workspace/bridge.py \
    && install -D -m 0644 /opt/workspace/desktop-defaults/share/xfce4/helpers/ochi-browser.desktop /usr/share/xfce4/helpers/ochi-browser.desktop \
    && /opt/venv/bin/python -c 'import gi, pyatspi' \
    && test -x /usr/bin/wmctrl \
    && test -x /usr/bin/xfce4-session

RUN /opt/venv/bin/pip install --no-cache-dir "fastembed==0.9.0"

VOLUME ["/data"]
EXPOSE 8080 6080 6081
RUN mkdir -p /data/work /data/projects /data/published /data/browser-profiles /data/runs /data/logs \
    && chown assistant:assistant /data/work /data/projects /data/published /data/browser-profiles /data/runs /data/logs
WORKDIR /data/work

USER assistant
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/workspace-entrypoint"]
