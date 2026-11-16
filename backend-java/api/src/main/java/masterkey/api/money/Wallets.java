// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.STORE_TRANSACTIONS;
import static masterkey.store.db.Tables.WALLETS;
import static masterkey.store.db.Tables.WALLET_ENTRIES;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import masterkey.store.db.tables.records.WalletEntriesRecord;
import masterkey.store.db.tables.records.WalletsRecord;
import org.jooq.DSLContext;
import org.jspecify.annotations.Nullable;

/**
 * The wallet of credits and its ledger ({@code promotions.py}, wallet): every change of the
 * balance is one line of {@code wallet_entries} in the same transaction, with the wallet row
 * locked. Credits are {@code int}, never a {@code double} (§16, Denaro).
 */
public final class Wallets {

    /** Credit packs sold in the stores, at the price of their credits: no bonus. */
    static final int[] PACKS = {99, 199, 499, 999, 1999, 4999, 9999};
    static final int SHOWN = 50;

    private Wallets() {
    }

    static String packId(int credits) {
        return "promo.credits." + (credits < 1000 ? String.format(java.util.Locale.ROOT, "%03d", credits) : Integer.toString(credits));
    }

    /** The credits of a product of the stores, or -1. */
    public static int packCredits(@Nullable String productId) {
        if (productId == null) return -1;
        for (int credits : PACKS) if (productId.equals(packId(credits))) return credits;
        return -1;
    }

    static List<Map<String, Object>> packs() {
        List<Map<String, Object>> packs = new ArrayList<>();
        for (int credits : PACKS) {
            Map<String, Object> pack = new LinkedHashMap<>();
            pack.put("productId", packId(credits));
            pack.put("credits", credits);
            packs.add(pack);
        }
        return packs;
    }

    /** The wallet of the user, made the first time, locked until the end of the transaction. */
    public static WalletsRecord locked(DSLContext ctx, UUID user) {
        ctx.insertInto(WALLETS).set(WALLETS.USER_ID, user).set(WALLETS.BALANCE, 0).set(WALLETS.ACCOUNT_TOKEN, Ids.random())
                .onConflictDoNothing().execute();
        WalletsRecord wallet = ctx.selectFrom(WALLETS).where(WALLETS.USER_ID.eq(user)).forUpdate().fetchOne();
        if (wallet == null) throw ApiError.unauthorized("this account was deleted");
        return wallet;
    }

    /** The account token the stores carry with a purchase (appAccountToken, obfuscatedExternalAccountId). */
    public static String accountToken(DSLContext ctx, UUID user) {
        WalletsRecord wallet = ctx.selectFrom(WALLETS).where(WALLETS.USER_ID.eq(user)).fetchOne();
        return (wallet == null ? locked(ctx, user) : wallet).getAccountToken().toString();
    }

    /** One line of the ledger and the balance with it, the wallet locked. */
    static void entry(DSLContext ctx, UUID user, int amount, String kind, @Nullable UUID event, @Nullable String productId,
                      @Nullable String storeKey, Instant now) {
        locked(ctx, user);
        ctx.update(WALLETS).set(WALLETS.BALANCE, WALLETS.BALANCE.plus(amount)).where(WALLETS.USER_ID.eq(user)).execute();
        ctx.insertInto(WALLET_ENTRIES)
                .set(WALLET_ENTRIES.ID, Ids.next())
                .set(WALLET_ENTRIES.USER_ID, user)
                .set(WALLET_ENTRIES.AT, now)
                .set(WALLET_ENTRIES.AMOUNT, amount)
                .set(WALLET_ENTRIES.KIND, kind)
                .set(WALLET_ENTRIES.EVENT_ID, event)
                .set(WALLET_ENTRIES.PRODUCT_ID, productId)
                .set(WALLET_ENTRIES.STORE_KEY, storeKey)
                .execute();
    }

    static String storeKey(String platform, String transaction) {
        return platform + ":" + transaction;
    }

    /**
     * Credits of a verified purchase, once per transaction of the store (the primary key of
     * {@code store_transactions}): false when it was credited already (the app sends it again
     * after a lost answer, or it was a deleted account's), 409 when it is another account's.
     */
    public static boolean credit(DSLContext ctx, UUID user, String platform, String transaction, String productId, Instant now) {
        String key = storeKey(platform, transaction);
        int credits = packCredits(productId);
        if (credits < 0) throw ApiError.badRequest("productId: not a credit pack");
        int inserted = ctx.insertInto(STORE_TRANSACTIONS).set(STORE_TRANSACTIONS.KEY, key).set(STORE_TRANSACTIONS.USER_ID, user)
                .onConflictDoNothing().execute();
        if (inserted == 0) {
            UUID owner = ctx.select(STORE_TRANSACTIONS.USER_ID).from(STORE_TRANSACTIONS).where(STORE_TRANSACTIONS.KEY.eq(key))
                    .fetchOne(STORE_TRANSACTIONS.USER_ID);
            // A purchase of a deleted account (NULL) stays what it was: never credited again
            if (owner != null && !owner.equals(user)) throw ApiError.conflict("already", "this purchase belongs to another account");
            return false;
        }
        entry(ctx, user, credits, "purchase", null, productId, key, now);
        return true;
    }

    /**
     * A purchase the store refunded or revoked: its credits go back out, once. The balance may
     * go below zero; then nothing is paid until a top-up covers it.
     */
    public static boolean reverse(DSLContext ctx, String platform, String transaction, Instant now) {
        String key = storeKey(platform, transaction);
        UUID owner = ctx.select(STORE_TRANSACTIONS.USER_ID).from(STORE_TRANSACTIONS).where(STORE_TRANSACTIONS.KEY.eq(key))
                .fetchOne(STORE_TRANSACTIONS.USER_ID);
        if (owner == null) return false;
        // Under the wallet's lock: two notices of the same refund one after the other
        locked(ctx, owner);
        WalletEntriesRecord bought = ctx.selectFrom(WALLET_ENTRIES).where(WALLET_ENTRIES.STORE_KEY.eq(key))
                .and(WALLET_ENTRIES.KIND.eq("purchase")).fetchOne();
        if (bought == null || ctx.fetchExists(WALLET_ENTRIES, WALLET_ENTRIES.STORE_KEY.eq(key).and(WALLET_ENTRIES.KIND.eq("reversal")))) {
            return false;
        }
        entry(ctx, owner, -bought.getAmount(), "reversal", null, bought.getProductId(), key, now);
        return true;
    }

    /** The account goes (DELETE /me): its wallet with it; its purchases stay known, never credited again. */
    public static void forget(DSLContext ctx, UUID user) {
        ctx.update(STORE_TRANSACTIONS).setNull(STORE_TRANSACTIONS.USER_ID).where(STORE_TRANSACTIONS.USER_ID.eq(user)).execute();
    }

    /** Wallet of API.md: the balance, the account token, the newest 50 entries. */
    public static Map<String, Object> view(DSLContext ctx, UUID user) {
        WalletsRecord wallet = ctx.selectFrom(WALLETS).where(WALLETS.USER_ID.eq(user)).fetchOne();
        if (wallet == null) wallet = locked(ctx, user);
        List<WalletEntriesRecord> lines = ctx.selectFrom(WALLET_ENTRIES).where(WALLET_ENTRIES.USER_ID.eq(user))
                .orderBy(WALLET_ENTRIES.AT.desc(), WALLET_ENTRIES.ID.desc()).limit(SHOWN).fetch();
        Set<UUID> events = new HashSet<>();
        for (WalletEntriesRecord line : lines) if (line.getEventId() != null) events.add(line.getEventId());
        Map<UUID, String> titles = new HashMap<>();
        if (!events.isEmpty()) {
            ctx.select(EVENTS.ID, EVENTS.TITLE).from(EVENTS).where(EVENTS.ID.in(events)).fetch()
                    .forEach(row -> titles.put(row.value1(), row.value2()));
        }
        List<Map<String, Object>> entries = new ArrayList<>();
        for (WalletEntriesRecord line : lines) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", Ids.publicId("we", line.getId()));
            view.put("at", line.getAt());
            view.put("amount", line.getAmount());
            view.put("kind", line.getKind());
            if (line.getEventId() != null) {
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("id", Ids.publicId("ev", line.getEventId()));
                event.put("title", titles.get(line.getEventId()));
                view.put("event", event);
            }
            if (line.getProductId() != null) view.put("productId", line.getProductId());
            entries.add(view);
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("balance", wallet.getBalance());
        view.put("accountToken", wallet.getAccountToken().toString());
        view.put("entries", entries);
        return view;
    }
}
