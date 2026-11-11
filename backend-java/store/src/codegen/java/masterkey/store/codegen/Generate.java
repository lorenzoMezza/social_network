// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.store.codegen;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;
import org.flywaydb.core.Flyway;
import org.jooq.codegen.GenerationTool;
import org.jooq.meta.jaxb.Configuration;
import org.jooq.meta.jaxb.Database;
import org.jooq.meta.jaxb.ForcedType;
import org.jooq.meta.jaxb.Generator;
import org.jooq.meta.jaxb.Jdbc;
import org.jooq.meta.jaxb.Target;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Makes the jOOQ classes from the migrations: a PostGIS of the same version as production in
 * Docker, Flyway on it, jOOQ reading it. PostGIS's own functions, tables and views are left
 * out, and so are the 64 partitions of messages (the parent table is enough) and the
 * generated geography columns (PostGIS is reached with SQL where it is needed).
 *
 * <p>Arguments: the folder of the migrations, the folder to write into.
 */
public final class Generate {

    static final String IMAGE = "postgis/postgis:18-3.7";

    public static void main(String[] args) throws Exception {
        Path migrations = Path.of(args[0]);
        Path target = Path.of(args[1]);
        try (PostgreSQLContainer postgres = new PostgreSQLContainer(
                DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))) {
            postgres.start();
            Flyway.configure()
                    .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                    .locations("filesystem:" + migrations)
                    .load()
                    .migrate();
            Path generated = target.resolve("masterkey/store/db");
            if (Files.exists(generated)) {
                try (Stream<Path> old = Files.walk(generated)) {
                    old.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
                }
            }
            GenerationTool.generate(new Configuration()
                    .withJdbc(new Jdbc()
                            .withDriver("org.postgresql.Driver")
                            .withUrl(postgres.getJdbcUrl())
                            .withUser(postgres.getUsername())
                            .withPassword(postgres.getPassword()))
                    .withGenerator(new Generator()
                            .withDatabase(new Database()
                                    .withName("org.jooq.meta.postgres.PostgresDatabase")
                                    .withInputSchema("public")
                                    .withIncludeRoutines(false)
                                    .withTableValuedFunctions(false)
                                    .withIncludeExcludeColumns(true)
                                    .withIncludeUDTs(false)
                                    .withIncludeSequences(false)
                                    .withIncludeDomains(false)
                                    .withExcludes(String.join("|",
                                            "flyway_schema_history",
                                            // db-scheduler's own: only it reads and writes there
                                            "scheduled_tasks",
                                            "spatial_ref_sys", "geography_columns", "geometry_columns",
                                            "messages_\\d+",
                                            "location"))
                                    .withForcedTypes(new ForcedType()
                                            .withName("INSTANT")
                                            .withIncludeTypes("timestamp\\ with\\ time\\ zone|timestamptz")))
                            .withGenerate(new org.jooq.meta.jaxb.Generate()
                                    .withRecords(true)
                                    .withPojos(false)
                                    .withDaos(false)
                                    .withJavaTimeTypes(true)
                                    .withGeneratedAnnotation(false)
                                    .withComments(false)
                                    .withKeys(true)
                                    .withIndexes(false))
                            .withTarget(new Target()
                                    .withPackageName("masterkey.store.db")
                                    .withDirectory(target.toString()))));
        }
    }

    private Generate() {
    }
}
