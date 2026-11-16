// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { useApi } from '../../api/useApi';

// Promotions and the wallet of promotion credits on the backend (docs/API.md,
// Promotions). Credits are euro cents.
function createPromotionsApi({ request }) {
  return {
    // GET /promotions/prices: reach limits, radii and prices a day, discounts, packs
    getPrices: () => request('/promotions/prices'),

    // GET /me/wallet → { balance, accountToken, entries }
    getWallet: () => request('/me/wallet'),

    // POST /me/wallet/purchases: a store purchase, checked with the store and credited
    // once (the same purchase sent again answers credited: false) → the wallet
    sendPurchase: ({ platform, productId, purchaseToken }) => request('/me/wallet/purchases', {
      method: 'POST',
      body: JSON.stringify({ platform, productId, purchaseToken }),
    }),
  };
}

export function usePromotionsApi() {
  const request = useApi();
  return useMemo(() => createPromotionsApi({ request }), [request]);
}
