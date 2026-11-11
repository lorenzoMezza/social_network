// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.store;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.SQLException;
import java.time.Duration;
import java.util.UUID;
import java.util.function.Function;
import javax.sql.DataSource;
import masterkey.core.ApiError;
import org.flywaydb.core.Flyway;
import org.jooq.DSLContext;
import org.jooq.SQLDialect;
import org.jooq.conf.RenderQuotedNames;
import org.jooq.conf.Settings;
import org.jooq.impl.DSL;
import org.jooq.impl.DataSourceConnectionProvider;
import org.jooq.impl.DefaultConfiguration;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.TransactionAwareDataSourceProxy;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The database of the application: one pool, jOOQ on it, and the transactions.
 *
 * <ul>
 *   <li>Transactions go through {@link #tx}: a {@code TransactionTemplate}, never
 *       {@code @Transactional}, which is skipped by a call inside the same class (§16).
 *       Everything is READ COMMITTED; the rules that need more take explicit locks (§7.3).
 *   <li>Never the network inside a transaction (R2, imaged, Logto, Apple): first the network,
 *       then the transaction. Frames and jobs leave after the commit.
 *   <li>jOOQ reaches the connection through a {@code TransactionAwareDataSourceProxy}: inside
 *       {@link #tx} every statement, and the jobs of db-scheduler, are in the same transaction.
 *   <li>A deadlock (40P01) runs the transaction once more; a pool that gives no connection in
 *       2 s answers 503 with {@code Retry-After}, never a thread waiting for ever.
 * </ul>
 */
public final class Database implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Database.class);

    private final DataSource dataSource;
    private final DSLContext dsl;
    private final TransactionTemplate writes;
    private final TransactionTemplate reads;
    private final @Nullable HikariDataSource pool;

    public Database(DataSource dataSource) {
        this(dataSource, null);
    }

    private Database(DataSource dataSource, @Nullable HikariDataSource pool) {
        this.dataSource = new TransactionAwareDataSourceProxy(dataSource);
        this.pool = pool;
        DataSourceTransactionManager manager = new DataSourceTransactionManager(dataSource);
        this.writes = new TransactionTemplate(manager);
        this.writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.reads = new TransactionTemplate(manager);
        this.reads.setReadOnly(true);
        this.dsl = DSL.using(new DefaultConfiguration()
                .set(SQLDialect.POSTGRES)
                .set(new DataSourceConnectionProvider(this.dataSource))
                .set(new Settings()
                        .withRenderQuotedNames(RenderQuotedNames.EXPLICIT_DEFAULT_UNQUOTED)
                        .withExecuteLogging(false)
                        .withRenderSchema(false)));
    }

    /** A pool for the URL, sized for virtual threads waiting on it, and the schema migrated. */
    public static Database open(String url, @Nullable String user, @Nullable String password, int size) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(url);
        if (user != null) config.setUsername(user);
        if (password != null) config.setPassword(password);
        config.setMaximumPoolSize(size);
        config.setMinimumIdle(Math.min(2, size));
        // A thread that cannot have a connection soon gives up: 503, not a queue for ever (§16)
        config.setConnectionTimeout(Duration.ofSeconds(2).toMillis());
        config.setMaxLifetime(Duration.ofMinutes(30).toMillis());
        config.setPoolName("db");
        // Never the parameters of a statement in an error: they can be positions or texts
        config.addDataSourceProperty("logUnclosedConnections", "false");
        config.addDataSourceProperty("ApplicationName", "masterkey");
        config.addDataSourceProperty("reWriteBatchedInserts", "true");
        HikariDataSource pool = new HikariDataSource(config);
        migrate(pool);
        return new Database(pool, pool);
    }

    /** Applies the migrations not applied yet; a migration changed after it ran stops the start. */
    public static void migrate(DataSource dataSource) {
        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/migration")
                .validateMigrationNaming(true)
                .cleanDisabled(true)
                .load()
                .migrate();
    }

    public DSLContext dsl() {
        return dsl;
    }

    /** The data source that joins the transaction of {@link #tx} (db-scheduler, plain JDBC). */
    public DataSource dataSource() {
        return dataSource;
    }

    /** A transaction: everything in {@code work} commits together or not at all. */
    public <T extends @Nullable Object> T tx(Function<DSLContext, T> work) {
        return run(writes, work);
    }

    public void txRun(java.util.function.Consumer<DSLContext> work) {
        run(writes, ctx -> {
            work.accept(ctx);
            return Boolean.TRUE;
        });
    }

    /** A read: one snapshot per statement, on a read-only transaction. */
    public <T extends @Nullable Object> T read(Function<DSLContext, T> work) {
        return run(reads, work);
    }

    // What work returns comes back as it is, null included: T says whether it may be
    @SuppressWarnings("NullAway")
    private <T extends @Nullable Object> T run(TransactionTemplate template, Function<DSLContext, T> work) {
        for (int attempt = 1; ; attempt++) {
            try {
                return template.execute(status -> work.apply(dsl));
            } catch (CannotCreateTransactionException | DataAccessResourceFailureException error) {
                // No connection in time from the pool, or the database away: 503, the app tries again
                throw ApiError.unavailable("the database is busy", 2);
            } catch (ApiError error) {
                throw error;
            } catch (RuntimeException error) {
                if (attempt == 1 && deadlock(error)) {
                    log.warn("database: a deadlock, the transaction runs again");
                    continue;
                }
                String state = sqlState(error);
                if (state != null && state.startsWith("08")) throw ApiError.unavailable("the database is busy", 2);
                throw error;
            }
        }
    }

    static boolean deadlock(Throwable error) {
        return "40P01".equals(sqlState(error));
    }

    /** The SQLSTATE of what went wrong, wherever it is in the causes. */
    public static @Nullable String sqlState(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SQLException sql && sql.getSQLState() != null) return sql.getSQLState();
        }
        return null;
    }

    /** The constraint a unique violation (23505) broke, or null. */
    public static @Nullable String violated(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof org.postgresql.util.PSQLException psql && "23505".equals(psql.getSQLState())
                    && psql.getServerErrorMessage() != null) {
                return psql.getServerErrorMessage().getConstraint();
            }
        }
        return null;
    }

    // --- locks (§7.3): first the person (namespace 1), then the zone (2), in this order ---

    /** Until the end of the transaction, one at a time per person: limits, idempotency keys. */
    public static void lockPerson(DSLContext ctx, UUID user) {
        ctx.fetch("SELECT pg_advisory_xact_lock(1, hashtext(?))", user.toString());
    }

    /** Two people: always in the order of their ids, so two transactions never wait on each other. */
    public static void lockPeople(DSLContext ctx, UUID a, UUID b) {
        if (masterkey.core.Ids.compare(a, b) <= 0) {
            lockPerson(ctx, a);
            if (!a.equals(b)) lockPerson(ctx, b);
        } else {
            lockPerson(ctx, b);
            lockPerson(ctx, a);
        }
    }

    public static void lockZone(DSLContext ctx, String square) {
        ctx.fetch("SELECT pg_advisory_xact_lock(2, hashtext(?))", square);
    }

    @Override
    public void close() {
        if (pool != null) pool.close();
    }
}
