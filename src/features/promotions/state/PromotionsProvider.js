// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogto } from '@logto/rn';
import {
  endConnection, fetchProducts, finishTransaction, getAvailablePurchases, initConnection, isUserCancelledError,
  purchaseErrorListener, purchaseUpdatedListener, requestPurchase,
} from 'expo-iap';
import { usePromotionsApi } from '../api/promotionsApi';
import { DEFAULT_PRICES } from '../model/promotionModel';

// The price list of promotions, the user's wallet of credits and buying credits in the
// stores (docs/PROMOTIONS.md, Payments). A purchase is always sent to the server,
// which checks it with the store and credits it once; only then is the transaction
// finished (consumed), so a purchase interrupted anywhere (the app closed, no network,
// a payment still pending) is sent again at the next start and never lost. Without a
// store (simulators, emulators without a Play account) a development server takes test
// top-ups instead.

const PromotionsContext = createContext(null);

const PLATFORM = process.env.EXPO_OS;

export function PromotionsProvider({ children }) {
  const { isAuthenticated } = useLogto();
  const api = usePromotionsApi();
  const [prices, setPrices] = useState(DEFAULT_PRICES);
  const [wallet, setWallet] = useState(null);
  // productId → the price the store shows (in the user's currency); null: no store
  const [storePrices, setStorePrices] = useState(null);
  // The purchase the user is waiting for: { productId, resolve, reject }
  const waiting = useRef(null);

  const refreshWallet = useCallback(async () => {
    const next = await api.getWallet();
    setWallet(next);
    return next;
  }, [api]);

  // A purchase the store finished: credited by the server, then consumed
  const settle = useCallback(async (purchase) => {
    if (purchase.purchaseState === 'pending' || !purchase.purchaseToken) return;
    const pending = waiting.current?.productId === purchase.productId ? waiting.current : null;
    try {
      const next = await api.sendPurchase({ platform: PLATFORM, productId: purchase.productId, purchaseToken: purchase.purchaseToken });
      await finishTransaction({ purchase, isConsumable: true });
      setWallet(next);
      if (pending) {
        waiting.current = null;
        pending.resolve(next);
      }
    } catch (error) {
      // Not finished: the store gives it back at the next start, to be sent again
      if (pending) {
        waiting.current = null;
        pending.reject(error);
      }
    }
  }, [api]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let alive = true;
    // One request for the price list: the screens' and the store's
    const priceList = api.getPrices();
    priceList.then((list) => alive && setPrices({ ...DEFAULT_PRICES, ...list })).catch(() => {});
    api.getWallet().then((next) => alive && setWallet(next)).catch(() => {});

    // A build without the store module (older than expo-iap): no store, no error
    let updated = null;
    let failed = null;
    try {
      updated = purchaseUpdatedListener((purchase) => {
        settle(purchase);
      });
      failed = purchaseErrorListener((error) => {
        const pending = waiting.current;
        waiting.current = null;
        pending?.reject(Object.assign(new Error(error?.message ?? 'Purchase failed'), { cancelled: isUserCancelledError(error), store: true }));
      });
    } catch {
      updated = null;
    }
    (async () => {
      if (!updated) return;
      try {
        await initConnection();
        const list = await priceList;
        const products = await fetchProducts({ skus: list.packs.map((pack) => pack.productId), type: 'in-app' });
        if (alive) setStorePrices(Object.fromEntries((products ?? []).map((product) => [product.id, product.displayPrice])));
        // Purchases left unfinished last time (consumables are listed until consumed)
        for (const purchase of await getAvailablePurchases()) {
          if (list.packs.some((pack) => pack.productId === purchase.productId)) await settle(purchase);
        }
      } catch {
        if (alive) setStorePrices(null);
      }
    })();
    return () => {
      alive = false;
      // Signed out: the next user never sees this one's credits
      setWallet(null);
      if (updated) {
        updated.remove();
        failed?.remove();
        endConnection().catch(() => {});
      }
    };
  }, [isAuthenticated, api, settle]);

  const storeHasPacks = !!storePrices && prices.packs.some((pack) => storePrices[pack.productId]);
  const canBuy = storeHasPacks || prices.devPurchases;

  // Buys a credit pack; resolves with the wallet once the server credited it. Rejects
  // with `cancelled` when the user closed the store's sheet.
  const buyPack = useCallback(async (pack) => {
    if (!storeHasPacks) {
      if (!prices.devPurchases) throw Object.assign(new Error('Purchases are not available'), { code: 'unavailable' });
      const next = await api.sendPurchase({ platform: 'dev', productId: pack.productId, purchaseToken: `dev-${Date.now()}-${Math.random().toString(36).slice(2)}` });
      setWallet(next);
      return next;
    }
    const { accountToken } = wallet ?? await refreshWallet();
    waiting.current?.reject(Object.assign(new Error('Replaced'), { cancelled: true }));
    let entry = null;
    const done = new Promise((resolve, reject) => {
      entry = { productId: pack.productId, resolve, reject };
      waiting.current = entry;
    });
    try {
      await requestPurchase({
        type: 'in-app',
        request: {
          // Given back in the receipt: the server credits only this account
          apple: { sku: pack.productId, appAccountToken: accountToken },
          google: { skus: [pack.productId], obfuscatedAccountId: accountToken },
        },
      });
    } catch (error) {
      // The store's sheet never opened: nothing to wait for
      if (waiting.current === entry) waiting.current = null;
      throw Object.assign(error ?? new Error('Purchase failed'), { store: true });
    }
    return done;
  }, [storeHasPacks, prices.devPurchases, api, wallet, refreshWallet]);

  // The price of a pack as the store shows it, else in euros
  const packPrice = useCallback((pack) => storePrices?.[pack.productId] ?? null, [storePrices]);

  const value = useMemo(() => ({
    prices, wallet, canBuy, testPurchases: !storeHasPacks && prices.devPurchases, refreshWallet, buyPack, packPrice, setWallet,
  }), [prices, wallet, canBuy, storeHasPacks, refreshWallet, buyPack, packPrice]);

  return <PromotionsContext.Provider value={value}>{children}</PromotionsContext.Provider>;
}

export function usePromotions() {
  const context = use(PromotionsContext);
  if (!context) throw new Error('usePromotions must be used inside <PromotionsProvider>');
  return context;
}
