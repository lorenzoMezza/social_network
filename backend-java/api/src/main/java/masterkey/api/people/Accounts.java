// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import static masterkey.store.db.Tables.USERS;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Duration;
import java.time.InstantSource;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import masterkey.api.web.Viewer;
import masterkey.auth.Claims;
import masterkey.auth.TokenVerifier;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.core.Text;
import masterkey.store.Database;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.jooq.Record3;
import org.jspecify.annotations.Nullable;

/**
 * Accounts are made by the user's first request (API.md, Conventions, Accounts; {@code
 * auth.ensure_account}). Their name, @handle and email come only from what Logto signed: the ID
 * token in {@code X-Id-Token}, verified, of the same {@code sub}; the unsigned
 * {@code X-Profile-Hint} only in development. Never the @handle from the email: a public handle
 * must not tell people an address. Two first requests at once make one account: {@code INSERT
 * … ON CONFLICT (sub) DO NOTHING}, then read again (§7.3).
 */
public final class Accounts {

    private static final int MAX_TRIES = 30;

    private final Database db;
    private final TokenVerifier tokens;
    private final InstantSource clock;
    /** sub → the account, once named: no query per request. Forgotten when the account goes. */
    private final Cache<String, Viewer> named = Caffeine.newBuilder().maximumSize(100_000).expireAfterWrite(Duration.ofMinutes(5)).build();
    /** The day each account was last seen active, so the row is written once a day. */
    private final ConcurrentHashMap<UUID, LocalDate> active = new ConcurrentHashMap<>();

    public Accounts(Database db, TokenVerifier tokens, InstantSource clock) {
        this.db = db;
        this.tokens = tokens;
        this.clock = clock;
    }

    /** The account of a verified token, made or named now when needed. */
    public Viewer viewer(Claims claims, @Nullable String idToken, @Nullable String hint) {
        String sub = claims.sub();
        Viewer known = named.getIfPresent(sub);
        if (known != null) {
            touch(known.id());
            return known;
        }
        Record3<UUID, Boolean, LocalDate> row = db.read(ctx -> ctx.select(USERS.ID, USERS.NAMED, USERS.LAST_ACTIVE_ON)
                .from(USERS).where(USERS.SUB.eq(sub)).fetchOne());
        if (row != null && row.value2()) {
            Viewer viewer = new Viewer(row.value1(), sub);
            named.put(sub, viewer);
            active.putIfAbsent(row.value1(), row.value3());
            touch(row.value1());
            return viewer;
        }
        // Asked only while it matters: an account already named needs nothing
        Claims signed = tokens.idToken(idToken, sub);
        Claims names = signed != null ? signed : tokens.hint(hint, sub);
        if (row != null) {
            UUID id = row.value1();
            if (names != null && names.named()) db.txRun(ctx -> rename(ctx, id, claims, names));
            touch(id);
            return new Viewer(id, sub);
        }
        Viewer made = create(claims, names);
        touch(made.id());
        return made;
    }

    public void forget(String sub) {
        named.invalidate(sub);
    }

    private Viewer create(Claims claims, @Nullable Claims names) {
        Naming naming = naming(claims, names);
        for (int attempt = 0; attempt < MAX_TRIES; attempt++) {
            int tries = attempt;
            try {
                return db.tx(ctx -> {
                    String username = freeUsername(ctx, naming.handle, tries);
                    UUID id = Ids.random();
                    int inserted = ctx.insertInto(USERS)
                            .set(USERS.ID, id)
                            .set(USERS.SUB, claims.sub())
                            .set(USERS.USERNAME, username)
                            .set(USERS.NAME, naming.name(username))
                            .set(USERS.EMAIL, naming.email)
                            .set(USERS.NAMED, naming.named)
                            .set(USERS.LAST_ACTIVE_ON, today())
                            .set(USERS.STYLE, JSONB.valueOf(Json.text(Profiles.defaultStyle())))
                            .set(USERS.SETTINGS, JSONB.valueOf(Json.text(Profiles.defaultSettings())))
                            .set(USERS.STORY, JSONB.valueOf(Json.text(Profiles.defaultStory())))
                            .set(USERS.STORY_AUDIENCE, "connections")
                            .set(USERS.CREATED_AT, clock.instant())
                            .onConflict(USERS.SUB).doNothing()
                            .execute();
                    UUID existing = ctx.select(USERS.ID).from(USERS).where(USERS.SUB.eq(claims.sub())).fetchOne(USERS.ID);
                    if (existing == null) throw new IllegalStateException("the account was not made");
                    if (inserted == 1) active.put(id, today());
                    return new Viewer(existing, claims.sub());
                });
            } catch (RuntimeException error) {
                // Another account took the handle meanwhile: the next number
                if (!"users_username_key".equals(Database.violated(error))) throw error;
            }
        }
        throw new IllegalStateException("no free handle");
    }

    /** Made by a request without the sign-in's names: named now, once. */
    private void rename(DSLContext ctx, UUID id, Claims claims, Claims names) {
        Naming naming = naming(claims, names);
        String current = ctx.select(USERS.USERNAME).from(USERS).where(USERS.ID.eq(id)).forUpdate().fetchOne(USERS.USERNAME);
        if (current == null) return;
        String username = naming.handle.equals(current) ? current : freeUsername(ctx, naming.handle, 0);
        ctx.update(USERS)
                .set(USERS.USERNAME, username)
                .set(USERS.NAME, naming.name(username))
                .set(USERS.EMAIL, naming.email)
                .set(USERS.NAMED, naming.named)
                .where(USERS.ID.eq(id))
                .execute();
        named.invalidate(claims.sub());
    }

    /** {@code auth._name_account}: what the names say, in the server's rules (Text). */
    record Naming(String handle, String given, @Nullable String email, boolean named) {
        String name(String username) {
            if (!given.isEmpty()) return given;
            return handle.startsWith("user") ? "New user" : nameFrom(handle);
        }
    }

    static Naming naming(Claims claims, @Nullable Claims names) {
        String email = first(names == null ? null : names.email(), claims.email());
        String given = first(names == null ? null : names.name(), claims.name());
        given = given == null ? "" : Text.strip(Text.cut(Text.words(Text.plain(given)), 30));
        // The @handle is public: from what the person chose to be called, never from their email
        String wanted = first(names == null ? null : names.username(), claims.username());
        String handle = Text.handle(wanted != null ? wanted : given.replace(' ', '.'));
        if (handle.isEmpty()) handle = randomHandle();
        boolean named = (names != null && names.named()) || claims.email() != null || claims.name() != null;
        return new Naming(handle, given, email, named);
    }

    /** {@code store.free_username}: the handle, else with a number, never a reserved one. */
    static String freeUsername(DSLContext ctx, String wanted, int skip) {
        String base = wanted.isEmpty() ? "user" : wanted;
        int found = 0;
        for (int n = 1; n < 100_000; n++) {
            String candidate = n == 1 ? base : base.substring(0, Math.min(base.length(), 27)) + n;
            if (Profiles.RESERVED_USERNAMES.contains(candidate) || candidate.length() < 3) continue;
            if (ctx.fetchExists(USERS, USERS.USERNAME.eq(candidate))) continue;
            if (found++ == skip) return candidate;
        }
        return randomHandle();
    }

    /** Nothing that says who someone is, or how many came before them. */
    static String randomHandle() {
        return String.format(Locale.ROOT, "user%08d", Ids.randomInt(100_000_000));
    }

    /** {@code auth._name_from}: "sara.m_88" → "Sara M". */
    static String nameFrom(String handle) {
        StringBuilder out = new StringBuilder();
        for (String word : handle.replace('_', '.').replace('-', '.').split("\\.", -1)) {
            if (word.isEmpty() || word.chars().allMatch(Character::isDigit)) continue;
            if (!out.isEmpty()) out.append(' ');
            out.append(word.substring(0, 1).toUpperCase(Locale.ROOT)).append(word.substring(1).toLowerCase(Locale.ROOT));
        }
        String name = Text.cut(out.toString(), 30);
        return name.isEmpty() ? "New user" : name;
    }

    private static @Nullable String first(@Nullable String a, @Nullable String b) {
        return a != null ? a : b;
    }

    /** Active today (C3-bis, inactive accounts): one write a day per account. */
    private void touch(UUID id) {
        LocalDate today = today();
        LocalDate last = active.get(id);
        if (today.equals(last)) return;
        active.put(id, today);
        db.txRun(ctx -> ctx.update(USERS).set(USERS.LAST_ACTIVE_ON, today)
                .where(USERS.ID.eq(id)).and(USERS.LAST_ACTIVE_ON.lt(today)).execute());
    }

    private LocalDate today() {
        return LocalDate.ofInstant(clock.instant(), ZoneOffset.UTC);
    }
}
