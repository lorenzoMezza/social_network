# imaged: the Java program and libvips, nothing else. Build from backend-java:
#   ./gradlew :imaged:installDist && docker build -t masterkey-imaged imaged
# Runs as an unprivileged user; give it the network towards the storage only (§19).
FROM eclipse-temurin:25-jre-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips-tools libheif1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 imaged
COPY build/install/imaged /opt/imaged
USER imaged
ENV IMAGED_BIND=0.0.0.0 IMAGED_PORT=8094 STORAGE_DIR=/data
EXPOSE 8094
ENTRYPOINT ["/opt/imaged/bin/imaged"]
