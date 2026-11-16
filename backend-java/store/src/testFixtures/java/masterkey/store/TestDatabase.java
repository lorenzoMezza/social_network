// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.store;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.concurrent.atomic.AtomicInteger;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * A real PostGIS for tests, the same version as production, started once per JVM. The
 * migrations run once into a template; every {@link #fresh} database is a copy of it, so
 * each test class starts from an empty schema in a few milliseconds.
 */
public final class TestDatabase {

    public static final String IMAGE = "postgis/postgis:18-3.7";
    private static final AtomicInteger COUNT = new AtomicInteger();
    private static PostgreSQLContainer container;

    private TestDatabase() {
    }

    private static synchronized PostgreSQLContainer container() {
        if (container == null) {
            container = new PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
                    .withCommand("postgres", "-c", "max_connections=300", "-c", "fsync=off", "-c", "synchronous_commit=off");
            container.start();
            HikariDataSource template = pool(url("test"), 2);
            Database.migrate(template);
            template.close();
            execute("ALTER DATABASE test IS_TEMPLATE true");
        }
        return container;
    }

    /** A new database with the whole schema and no rows. */
    public static Database fresh() {
        return new Database(freshPool(10));
    }

    public static HikariDataSource freshPool(int size) {
        Address address = freshAddress();
        return pool(address.url(), size);
    }

    /** Where a new empty database is, for what opens its own pool (the whole server in a test). */
    public record Address(String url, String user, String password) {
    }

    public static Address freshAddress() {
        container();
        String name = "t" + COUNT.incrementAndGet();
        execute("CREATE DATABASE " + name + " TEMPLATE test");
        return new Address(url(name), container.getUsername(), container.getPassword());
    }

    private static String url(String database) {
        return "jdbc:postgresql://" + container.getHost() + ":" + container.getMappedPort(5432) + "/" + database;
    }

    private static HikariDataSource pool(String url, int size) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(url);
        config.setUsername(container.getUsername());
        config.setPassword(container.getPassword());
        config.setMaximumPoolSize(size);
        config.setMinimumIdle(0);
        config.setConnectionTimeout(10_000);
        return new HikariDataSource(config);
    }

    private static void execute(String sql) {
        try (Connection connection = DriverManager.getConnection(url("postgres"), container.getUsername(), container.getPassword());
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }
}
