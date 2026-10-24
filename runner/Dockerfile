FROM eclipse-temurin:21-jdk-jammy
COPY java /opt/blueprints/src
RUN javac -encoding UTF-8 -d /opt/blueprints/launcher /opt/blueprints/src/module-info.java /opt/blueprints/src/dev/blueprints/runtime/Bootstrap.java \
    && chmod -R a-w /opt/blueprints
ENV LANG=C.UTF-8
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
